import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { captureScreen } from './screen.mjs';
import { scanUsage, totalsOf, blockStats, burnOf, heatOf } from './tokens.mjs';
import { fetchRealUsage } from './usage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Runtime state lives OUTSIDE the repo by default (%LOCALAPPDATA%\jarvis) so a `git clean -x`
// in the source tree can't wipe live sessions/worklist/transcript/bus/schedule/archive/attachments.
// Override with JARVIS_DATA; falls back to the repo dir only if LOCALAPPDATA is unset (non-Windows).
const DATA = process.env.JARVIS_DATA || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'jarvis') : HERE);
const USER_DATA = process.env.CHROME_USER_DATA || join(HERE, 'chrome-profile');
const TRANSCRIPT = join(DATA, 'transcript.jsonl');
const SAY = join(DATA, 'say.txt');
const CMD = join(DATA, 'commands.txt');
const WORKLIST = join(DATA, 'worklist.json');
const SESSIONS = join(DATA, 'sessions.json');
const BUS = join(DATA, 'bus.jsonl');
const BUSBASE = join(DATA, 'bus.base'); // persisted count of bus events dropped off the front
const REPOS = join(DATA, 'repos.json');
const SCHEDULE = join(DATA, 'schedule.json');
const ARCHIVE = join(DATA, 'archive');
const WORKER_DOC = join(HERE, 'WORKER.md');
const PORT = Number(process.env.JARVIS_PORT || 8124);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NO_UI = !!process.env.JARVIS_NO_UI;
const PROJECTS = process.env.JARVIS_PROJECTS || join(process.env.USERPROFILE || '', '.claude', 'projects');
const NATO = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
const WORK_VERSION = 3;
// Bound the in-memory event arrays AND their .jsonl files so a long-lived hub doesn't grow
// without limit. We keep at most CACHE_CAP entries and only compact once we drift CACHE_SLACK
// past it, so the (atomic) file rewrite happens every ~SLACK events, not on every append.
const CACHE_CAP = 5000;
const CACHE_SLACK = 1000;

mkdirSync(DATA, { recursive: true });
mkdirSync(ARCHIVE, { recursive: true });
writeFileSync(SAY, '');
writeFileSync(CMD, '');
if (!existsSync(TRANSCRIPT)) writeFileSync(TRANSCRIPT, '');
if (!existsSync(BUS)) writeFileSync(BUS, '');
if (!existsSync(REPOS)) writeFileSync(REPOS, '{}\n');
if (!existsSync(SESSIONS)) writeFileSync(SESSIONS, JSON.stringify({ callsigns: {}, sessions: {}, nextUid: 1 }, null, 1));
if (!existsSync(WORKLIST)) writeFileSync(WORKLIST, JSON.stringify({ version: WORK_VERSION, focus: 'jarvis', sessions: { jarvis: { working: [], queued: [], done: [] } } }, null, 1));
// Sweep stale spawn launch scripts (one was written per spawned callsign; each is only read
// once at terminal launch, so leftovers from past sessions are just clutter — REVIEW.md LOW).
try { for (const f of readdirSync(DATA)) if (/^spawn-.*\.cmd$/i.test(f)) { try { unlinkSync(join(DATA, f)); } catch { } } } catch { }
try { unlinkSync(join(DATA, 'STOP')); } catch { } // clear any wind-down stop sentinel left from a prior run

const CONSOLE_HTML = readFileSync(join(HERE, 'console.html'), 'utf8');
const CONSOLE_CSS = readFileSync(join(HERE, 'console.css'), 'utf8');
const CONSOLE_JS = readFileSync(join(HERE, 'console.js'), 'utf8');
// Serve console assets fresh from disk per request (fall back to the startup copy on a read
// error) so UI edits only need a browser refresh, not a hub restart.
function freshAsset(name, fallback) { try { return readFileSync(join(HERE, name), 'utf8'); } catch { return fallback; } }
const WINDDOWN_GRACE_MS = 10000; // grace for live workers to checkpoint + retire before the hub stops

const transcriptCache = loadJsonl(TRANSCRIPT);
// busBase = the absolute index of bus[0]. Persisted so the poll cursor (an absolute event
// count) stays valid across restarts and across front-trimming. logical total = busBase + bus.length.
let busBase = existsSync(BUSBASE) ? (Number(readFileSync(BUSBASE, 'utf8').trim()) || 0) : 0;
const bus = loadJsonl(BUS);
trimTranscript(); // compact on startup if a pre-cap run left the file/cache oversized
trimBus();
const roster = loadRoster();
const pollWaiters = [];
const sayQueue = [];
const pendingPerms = new Map();
let permSeq = 0;
const pendingTier = new Map();
const PERM_MULTIWORD = new Set(['git', 'npm', 'pnpm', 'yarn', 'dotnet', 'ng', 'npx', 'node', 'python', 'python3', 'pip', 'go', 'cargo', 'docker', 'kubectl', 'powershell']);
// A coarse signature so one "Always" covers a whole command family: Bash/PowerShell collapse to
// their leading verb ("git show abc" -> "Bash::git show"); other tools collapse to the tool name.
function permSig(tool, detail) {
    if (tool === 'Bash' || tool === 'PowerShell') {
        const toks = String(detail || '').trim().split(/\s+/);
        const n = PERM_MULTIWORD.has((toks[0] || '').toLowerCase()) ? 2 : 1;
        return tool + '::' + toks.slice(0, n).join(' ').toLowerCase();
    }
    return tool + '::*';
}
function permLabel(tool, detail) {
    if (tool === 'Bash' || tool === 'PowerShell') {
        const toks = String(detail || '').trim().split(/\s+/);
        const n = PERM_MULTIWORD.has((toks[0] || '').toLowerCase()) ? 2 : 1;
        return toks.slice(0, n).join(' ') + ' *';
    }
    return tool;
}
let discard = false, meetingMode = false, running = true;
let screenGrant = 0;
let muted = false, autoMutedBy = null, consolePageRef = null;
function setMute(on, by) {
    muted = !!on;
    autoMutedBy = muted ? (by || null) : null;
    record({ kind: 'sys', text: muted ? 'muted' + (by ? ' (auto: ' + by + ')' : '') : 'unmuted' });
    if (consolePageRef) consolePageRef.evaluate(m => window.__setMute(m), muted).catch(() => { });
}
const SESSION_BUDGET = Number(process.env.JARVIS_SESSION_BUDGET || 0);
let tokenStats = { totals: { output: 0, input: 0, cacheWrite: 0, cacheRead: 0, turns: 0 }, burn: 0, heat: heatOf(0), resetAt: null, sessionPct: null, source: 'estimate', weekPct: null, blockBurn: 0, budget: null, at: null };
let realUsage = null;
function refreshTokens() {
    try {
        const now = Date.now();
        const entries = scanUsage(PROJECTS, now - 7 * 24 * 3600000);
        const totals = totalsOf(entries, now - 3600000);
        const burn = burnOf(totals);
        const b = blockStats(entries, now);
        const budget = SESSION_BUDGET || b.maxBlockBurn || 0;
        const estPct = b.resetAt && budget ? Math.min(100, Math.round(b.blockBurn / budget * 100)) : null;
        const estReset = b.resetAt ? new Date(b.resetAt).toISOString() : null;
        tokenStats = {
            totals, burn, heat: heatOf(burn),
            resetAt: realUsage && realUsage.resetAt ? realUsage.resetAt : estReset,
            sessionPct: realUsage && realUsage.sessionPct !== null ? realUsage.sessionPct : estPct,
            source: realUsage && realUsage.sessionPct !== null ? 'api' : 'estimate',
            weekPct: realUsage ? realUsage.weekPct : null,
            blockBurn: b.blockBurn, budget,
            at: new Date().toISOString(),
        };
    } catch { }
}
async function refreshRealUsage() {
    realUsage = await fetchRealUsage();
    refreshTokens();
}
const REAL_USAGE = process.env.JARVIS_REAL_USAGE === '1';
refreshTokens();
if (REAL_USAGE) {
    refreshRealUsage();
    setInterval(refreshRealUsage, 600000).unref();
}
setInterval(refreshTokens, 30000).unref();
setInterval(() => {
    const s = loadSchedule();
    const now = Date.now();
    let dirty = false;
    // Reminders fire once at their due time, whether or not a meeting schedule is loaded today.
    if (Array.isArray(s.reminders) && s.reminders.length) {
        for (const r of s.reminders) {
            if (r && r.start && !r.firedAt && now >= Date.parse(r.start)) {
                r.firedAt = new Date().toISOString();
                dirty = true;
                enqueueSay('Reminder: ' + r.title + '.', 'jarvis');
            }
        }
        const n0 = s.reminders.length; pruneReminders(s); if (s.reminders.length !== n0) dirty = true;
    }
    // Meetings: only the schedule paste loaded for today.
    if (s.events && s.events.length && s.date === new Date().toDateString()) {
        for (const e of s.events) {
            const st = Date.parse(e.start), en = Date.parse(e.end);
            const k5 = e.title + ':5', k0 = e.title + ':0', kEnd = e.title + ':end';
            if (now >= st - 300000 && now < st && !s.announced[k5]) {
                s.announced[k5] = true;
                dirty = true;
                enqueueSay('Heads up: ' + e.title + ' in ' + Math.max(1, Math.round((st - now) / 60000)) + ' minutes.', 'jarvis');
            }
            if (now >= st && now < st + 60000 && !s.announced[k0]) {
                s.announced[k0] = true;
                dirty = true;
                enqueueSay(e.title + ' is starting now.', 'jarvis');
                if (!muted) setMute(true, e.title);
            }
            if (now >= en && !s.announced[kEnd]) {
                s.announced[kEnd] = true;
                dirty = true;
                if (muted && autoMutedBy === e.title) {
                    // Chris's rule: NEVER auto-unmute him. The meeting muted him; prompt him to
                    // unmute himself (force:true so it speaks through the mute) and drop our claim
                    // so the mute is now his to lift whenever he is ready.
                    autoMutedBy = null;
                    sayQueue.push({ text: e.title + ' is over. Say unmute whenever you are ready.', from: 'jarvis', force: true });
                }
            }
        }
    }
    if (dirty) saveSchedule(s);
}, 15000).unref();
let lastHist = null;

function loadJsonl(path) {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
}
function loadRoster() {
    if (existsSync(SESSIONS)) {
        try {
            const r = JSON.parse(readFileSync(SESSIONS, 'utf8'));
            if (r && r.sessions) return r;
        } catch { backupCorrupt(SESSIONS); }   // preserve + alert, don't silently reset
    }
    return { callsigns: {}, sessions: {}, nextUid: 1 };
}
// Crash-safe write: write a temp file then atomically rename over the target, so a crash
// mid-write can never leave a truncated/corrupt state file (REVIEW.md HIGH #1).
function atomicWrite(path, data) {
    const tmp = path + '.tmp';
    writeFileSync(tmp, data);
    renameSync(tmp, path);
}
// A state file existed but failed to parse: preserve it for recovery and alert LOUDLY rather
// than silently resetting to empty and then overwriting the only copy (REVIEW.md HIGH #2).
function backupCorrupt(path) {
    try {
        const bak = path + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
        renameSync(path, bak);
        const name = path.split(/[\\/]/).pop();
        record({ kind: 'sys', text: 'CORRUPT ' + name + ' -> ' + bak.split(/[\\/]/).pop() + '; state reset, recover manually' });
        try { enqueueSay('Warning: a state file was corrupt. I backed it up and reset it; recover it manually.', 'jarvis'); } catch { }
    } catch { }
}
function saveRoster() {
    atomicWrite(SESSIONS, JSON.stringify(roster, null, 1));
}
// Throttled persistence for the per-poll lastSeen churn: liveness uses the in-memory roster,
// so on-disk lastSeen only needs to be roughly current. Caps full sessions.json rewrites to
// once / ROSTER_FLUSH_MS instead of one per poll per session. Meaningful changes (register,
// retire, needsYou, ctx, describe) still call saveRoster() directly for an immediate flush.
const ROSTER_FLUSH_MS = 5000;
let lastRosterFlush = 0;
function saveRosterThrottled() {
    const now = Date.now();
    if (now - lastRosterFlush >= ROSTER_FLUSH_MS) { lastRosterFlush = now; saveRoster(); }
}
// Keep the display cache + its file bounded. The transcript is display-only (not index-
// referenced), so trimming the front is safe; we rewrite the file from the capped cache.
function trimTranscript() {
    if (transcriptCache.length <= CACHE_CAP + CACHE_SLACK) return;
    transcriptCache.splice(0, transcriptCache.length - CACHE_CAP);
    atomicWrite(TRANSCRIPT, transcriptCache.map(e => JSON.stringify(e)).join('\n') + (transcriptCache.length ? '\n' : ''));
}
// Cap the event bus. The poll cursor is an ABSOLUTE event index, so dropping k entries off the
// front means bumping busBase by k (and persisting it): busBase + bus.length stays constant as
// events are trimmed and only grows as events arrive, so every live cursor remains valid.
function trimBus() {
    if (bus.length <= CACHE_CAP + CACHE_SLACK) return;
    const drop = bus.length - CACHE_CAP;
    bus.splice(0, drop);
    busBase += drop;
    atomicWrite(BUS, bus.map(e => JSON.stringify(e)).join('\n') + (bus.length ? '\n' : ''));
    atomicWrite(BUSBASE, String(busBase));
}
function record(entry) {
    const e = { ...entry, ts: new Date().toISOString() };
    transcriptCache.push(e);
    appendFileSync(TRANSCRIPT, JSON.stringify(e) + '\n');
    trimTranscript();
}
function drainWholeFile(path) {
    if (!existsSync(path)) return '';
    const txt = readFileSync(path, 'utf8');
    if (!txt.trim()) return '';
    writeFileSync(path, '');
    return txt;
}
let taskSeq = 0;
function newTaskId() {
    return 't_' + Date.now().toString(36) + (taskSeq++).toString(36) + Math.random().toString(36).slice(2, 5);
}
// Canonical v3 task object. Only id/text/addedAt are populated now; notes/subtasks/
// startDate/dueDate/priority are optional placeholders the later board UI will use.
function makeTask(text, extra) {
    const t = { id: newTaskId(), text: String(text == null ? '' : text), addedAt: new Date().toISOString() };
    if (extra && typeof extra === 'object') {
        if (extra.notes != null) t.notes = String(extra.notes);
        if (Array.isArray(extra.subtasks)) t.subtasks = extra.subtasks.map(s => (s && typeof s === 'object') ? { text: String(s.text == null ? '' : s.text), done: !!s.done } : { text: String(s), done: false });
        if (extra.startDate != null) t.startDate = String(extra.startDate);
        if (extra.dueDate != null) t.dueDate = String(extra.dueDate);
        if (extra.priority != null) t.priority = extra.priority;
    }
    return t;
}
// Read the text out of a task that may still be a bare string (defensive during/after migration).
function textOf(t) {
    return (t && typeof t === 'object') ? (t.text == null ? '' : t.text) : (t == null ? '' : t);
}
// Bring any on-disk worklist up to the current shape. Idempotent: existing task objects
// keep their ids (so ids are stable across reloads); only missing fields are backfilled.
// Returns { w, changed } so the loader can persist a one-time upgrade.
function migrateWork(w) {
    let changed = false;
    // v1 (flat board, no sessions) -> v2 (sessions keyed by callsign)
    if (w && !w.sessions && (w.working || w.queued || w.done)) {
        w = { focus: 'jarvis', sessions: { jarvis: { working: w.working || [], queued: w.queued || [], done: w.done || [] } } };
        changed = true;
    }
    if (!w || !w.sessions || typeof w.sessions !== 'object') {
        return { w: { version: WORK_VERSION, focus: 'jarvis', sessions: { jarvis: { working: [], queued: [], done: [] } } }, changed: true };
    }
    // v2 (string tasks) -> v3 (task objects)
    for (const cs of Object.keys(w.sessions)) {
        const b = w.sessions[cs];
        if (!b || typeof b !== 'object') { w.sessions[cs] = { working: [], queued: [], done: [], review: [] }; changed = true; continue; }
        for (const list of ['working', 'queued', 'done', 'review']) {
            if (!Array.isArray(b[list])) { b[list] = []; changed = true; continue; }
            b[list] = b[list].map(t => {
                if (typeof t === 'string') { changed = true; return makeTask(t); }
                if (t && typeof t === 'object') {
                    if (!t.id) { t.id = newTaskId(); changed = true; }
                    if (!t.addedAt) { t.addedAt = new Date().toISOString(); changed = true; }
                    if (typeof t.text !== 'string') { t.text = String(t.text == null ? '' : t.text); changed = true; }
                    return t;
                }
                changed = true; return makeTask(t);
            });
        }
    }
    if (!w.focus) { w.focus = 'jarvis'; changed = true; }
    if (w.version !== WORK_VERSION) { w.version = WORK_VERSION; changed = true; }
    return { w, changed };
}
function loadWork() {
    let raw = null;
    if (existsSync(WORKLIST)) {
        try { raw = JSON.parse(readFileSync(WORKLIST, 'utf8')); }
        catch { backupCorrupt(WORKLIST); raw = null; }   // don't silently zero the only copy
    }
    const { w, changed } = migrateWork(raw);
    if (changed) { try { saveWork(w); } catch { } }
    return w;
}
function saveWork(w) {
    atomicWrite(WORKLIST, JSON.stringify(w, null, 1));
}
function ensureBoard(w, cs) {
    if (!w.sessions[cs]) w.sessions[cs] = { working: [], queued: [], done: [], review: [] };
    else if (!Array.isArray(w.sessions[cs].review)) w.sessions[cs].review = [];
    return w.sessions[cs];
}
function findTaskAll(w, needle, lists, prefer) {
    const n = needle.toLowerCase();
    const order = [prefer, ...Object.keys(w.sessions).filter(k => k !== prefer)];
    for (const cs of order) {
        const b = w.sessions[cs];
        if (!b) continue;
        for (const list of lists) {
            const i = (b[list] || []).findIndex(t => textOf(t).toLowerCase().includes(n));
            if (i >= 0) return { cs, list, i };
        }
    }
    return null;
}
function loadRepos() {
    try { return JSON.parse(readFileSync(REPOS, 'utf8')) || {}; } catch { return {}; }
}
// Stable key for a job's working directory (separator/case/trailing-slash insensitive).
// Handoff records are stored under this so a successor on the same cwd can find them.
function cwdKey(cwd) {
    return String(cwd || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}
// Resolve a registered repo by cwd, falling back to an ad-hoc repo (same logic /spawn used).
function resolveRepo(cwd) {
    const repos = loadRepos();
    const repo = Object.entries(repos).map(([k, v]) => ({ key: k, ...v }))
        .find(r => String(r.cwd).toLowerCase() === String(cwd).toLowerCase());
    return repo || { key: 'adhoc', cwd };
}
function loadSchedule() {
    try { return JSON.parse(readFileSync(SCHEDULE, 'utf8')) || { events: [], announced: {} }; } catch { return { events: [], announced: {} }; }
}
function saveSchedule(s) {
    atomicWrite(SCHEDULE, JSON.stringify(s, null, 1));
}
function parseScheduleText(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const events = [];
    let pendingTitle = null;
    const timeRe = /^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
    for (const l of lines) {
        if (/^past events$/i.test(l)) { pendingTitle = null; continue; }
        const m = l.match(timeRe);
        if (m && pendingTitle) {
            const mk = (h, mm, ap) => {
                let H = Number(h) % 12;
                if (String(ap || '').toUpperCase() === 'PM') H += 12;
                const d = new Date();
                d.setHours(H, Number(mm), 0, 0);
                return d;
            };
            const start = mk(m[1], m[2], m[3] || m[6]);
            const end = mk(m[4], m[5], m[6]);
            events.push({ title: pendingTitle, start: start.toISOString(), end: end.toISOString() });
            pendingTitle = null;
            continue;
        }
        if (/^(going\?|awaiting your response|yes$|no$|maybe$)/i.test(l)) continue;
        pendingTitle = l.replace(/\s*\([^)]*@[^)]*\)\s*$/, '');
    }
    events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return { date: new Date().toDateString(), events, announced: {} };
}
// —— Reminders: ad-hoc timed to-dos that live in the calendar next to meetings. Unlike the
// meeting list (volatile, re-pasted daily, date-gated), a reminder carries an absolute time,
// survives a schedule re-paste, and announces ONCE when due. Stored in schedule.reminders[]. ——
function clk(iso) {
    const d = new Date(iso); let h = d.getHours(); const m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return h + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap;
}
// Strip the command framing ("remind me", "set a timer for", the time clause, a leading "to")
// to recover just the thing to be reminded of. Heuristic, but good enough for spoken input.
function remTitle(t) {
    const base = String(t || '')
        .replace(/^\s*jarvis[\s,.!]+/i, '')
        .replace(/^\s*(please\s+)?(can you\s+|could you\s+)?(set\s+(a|an)\s+)?(remind(er)?(\s+me)?|timer(\s+for)?)\b/i, '')
        .replace(/\b(?:in|for)\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i, '')
        .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)\b/i, '')
        .replace(/^\s*(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i, '')   // leftover bare duration ("timer for 5 minutes")
        .replace(/^\s*(to|that|about|for)\s+/i, '')
        .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
        .trim();
    return base || (/\btimer\b/i.test(String(t || '')) ? 'Timer' : 'Reminder');
}
// Parse a relative ("in 10 minutes") or absolute ("at 3:30pm") reminder out of free text.
// Returns { title, start(ISO) } or null when no time is found.
function parseReminder(text) {
    const low = String(text || '').toLowerCase();
    const num = w => (w === 'a' || w === 'an') ? 1 : (NUMWORDS[w] != null ? NUMWORDS[w] : (/^\d+$/.test(w) ? Number(w) : null));
    let m;
    if ((m = low.match(/\b(?:in|for)\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/))) {
        const n = num(m[1]); if (n == null || n <= 0) return null;
        const unit = m[2][0] === 'h' ? 3600000 : 60000;
        return { title: remTitle(text), start: new Date(Date.now() + n * unit).toISOString() };
    }
    if ((m = low.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/))) {
        let H = Number(m[1]) % 12; if (m[3] === 'pm') H += 12;
        const d = new Date(); d.setHours(H, Number(m[2] || 0), 0, 0);
        if (d.getTime() < Date.now() - 60000) d.setDate(d.getDate() + 1);   // already past today -> tomorrow
        return { title: remTitle(text), start: d.toISOString() };
    }
    return null;
}
// Drop reminders whose time elapsed more than 6h ago (fired or not) so the list self-cleans.
function pruneReminders(s) {
    if (!Array.isArray(s.reminders)) { s.reminders = []; return; }
    const cutoff = Date.now() - 6 * 3600000;
    s.reminders = s.reminders.filter(r => r && r.start && Date.parse(r.start) > cutoff);
}
function createReminder(title, start) {
    const s = loadSchedule();
    if (!Array.isArray(s.reminders)) s.reminders = [];
    pruneReminders(s);
    const r = { id: newTaskId(), title: String(title || 'Reminder').slice(0, 120), start, kind: 'reminder' };
    s.reminders.push(r);
    s.reminders.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    saveSchedule(s);
    return r;
}

// Display-order task list for a session (matches the console card: review -> working -> queued
// -> done). The position in this array is the 1-based index the human sees and speaks.
function orderedTasks(board) {
    const out = [];
    for (const list of ['review', 'working', 'queued', 'done']) {
        (board[list] || []).forEach((item, i) => out.push({ item, list, i }));
    }
    return out;
}
function shortTitle(s) {
    const t = String(s).replace(/^[A-Z]{2,10}:\s*/, '').trim();
    return t.split(/\s+/).slice(0, 7).join(' ').slice(0, 50);
}
const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const IDX_FILLER = new Set(['item', 'number', 'no', 'task', 'the', 'on', 'to']);
function liveUidOf(cs) {
    const l = roster.callsigns[cs];
    if (!l || !l.length) return null;
    const s = roster.sessions[l[0]];
    return s && !s.ended ? l[0] : null;
}
// A project (e.g. 'jarvis') is a durable board card that can host ONE live worker. The worker
// is a normal session (own uid + NATO callsign for the perm-hook) but carries .project, which
// binds its board + routing to the project card instead of giving it its own separate card.
function projectWorkerUid(name) {
    if (!name) return null;
    for (const uid in roster.sessions) {
        const s = roster.sessions[uid];
        if (s && !s.ended && s.project === name) return uid;
    }
    return null;
}
function liveCallsigns() {
    return NATO.filter(cs => liveUidOf(cs));
}
function aliveNow(uid) {
    const s = roster.sessions[uid];
    return !!(s && s.lastSeen && Date.now() - Date.parse(s.lastSeen) < 120000);
}
function csFrom(word) {
    if (!word) return null;
    const n = word.toLowerCase().replace(/[^a-z]/g, '');
    if (n === 'jarvis') return 'jarvis';
    return liveUidOf(n) ? n : null;
}
function canon(s) {
    return s.replace(/\bx[\s-]ray\b/gi, 'xray').replace(/\bjuliette\b/gi, 'juliet');
}
const pendingPins = new Map();
function assignCallsign(pin) {
    for (const [cs, ts] of pendingPins) {
        if (Date.now() - ts > 300000) pendingPins.delete(cs);
    }
    if (pin) {
        const p = String(pin).toLowerCase().replace(/[^a-z]/g, '');
        if (NATO.includes(p) && !liveUidOf(p)) return p;
    }
    const free = NATO.filter(cs => !liveUidOf(cs) && !pendingPins.has(cs));
    if (!free.length) throw new Error('all 26 callsigns are live');
    const never = free.filter(cs => !(roster.callsigns[cs] || []).length);
    if (never.length) return never[0];
    free.sort((a, b) => Date.parse(roster.sessions[roster.callsigns[a][0]].ended || 0) - Date.parse(roster.sessions[roster.callsigns[b][0]].ended || 0));
    return free[0];
}
function enqueueSay(text, from) {
    const label = from || 'jarvis';
    const focus = loadWork().focus;
    const spoken = (label !== 'jarvis' && label !== focus) ? label + ' says: ' + text : text;
    sayQueue.push({ text, spoken, from: label });
    if (/^\s*need you\b/i.test(String(text || ''))) pushPhone('JARVIS - ' + label + ' needs you', text);
}
// --- phone push (ntfy) -------------------------------------------------------
// Best-effort push to the human's phone for interrupt-worthy lines ("Need you:").
// Point it at an ntfy topic URL (https://ntfy.sh/<topic>, or a self-hosted ntfy
// reachable over Tailscale) via POST /notify, the JARVIS_NTFY_URL env var, or
// DATA/notify.json. No URL configured -> silently does nothing. A short cooldown
// collapses rapid-fire bursts (e.g. back-to-back permission prompts).
let NOTIFY = { url: process.env.JARVIS_NTFY_URL || '' };
try { NOTIFY = JSON.parse(readFileSync(join(DATA, 'notify.json'), 'utf8')); } catch { }
function saveNotify() { try { writeFileSync(join(DATA, 'notify.json'), JSON.stringify(NOTIFY)); } catch { } }
let lastPushAt = 0;
function pushPhone(title, message) {
    const url = NOTIFY && NOTIFY.url;
    if (!url) return;
    const now = Date.now();
    if (now - lastPushAt < 5000) return;   // collapse bursts
    lastPushAt = now;
    const ascii = (t) => (String(t || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 100) || 'JARVIS');
    try {
        fetch(url, { method: 'POST', headers: { 'Title': ascii(title), 'Priority': 'high', 'Tags': 'bell' }, body: String(message || '').slice(0, 400) }).catch(() => { });
    } catch { }
}
// Per-session voice-mute: is this speaker's voice silenced? (still logged as tts, just not spoken)
function voiceMutedFrom(label) {
    if (!label || label === 'jarvis') return false;
    const uid = liveUidOf(label);
    return !!(uid && roster.sessions[uid] && roster.sessions[uid].voiceMuted);
}
function releaseWaiters() {
    for (let i = pollWaiters.length - 1; i >= 0; i--) {
        const wt = pollWaiters[i];
        const out = eventsFor(wt.uid, wt.cursor);
        if (out.events.length) {
            pollWaiters.splice(i, 1);
            clearTimeout(wt.timer);
            json(wt.res, 200, out);
        }
    }
}
let speechReleaseTimer = null;
function busAppend(ev, debounceMs) {
    const e = { ...ev, ts: new Date().toISOString() };
    bus.push(e);
    appendFileSync(BUS, JSON.stringify(e) + '\n');
    if (!debounceMs) {
        if (speechReleaseTimer) { clearTimeout(speechReleaseTimer); speechReleaseTimer = null; }
        releaseWaiters();
        return;
    }
    if (speechReleaseTimer) clearTimeout(speechReleaseTimer);
    speechReleaseTimer = setTimeout(() => { speechReleaseTimer = null; releaseWaiters(); }, debounceMs);
}
function eventsFor(uid, cursor) {
    const events = [];
    // cursor is an absolute event index; bus[0] is at absolute index busBase.
    for (let i = Math.max(0, cursor - busBase); i < bus.length; i++) {
        const e = bus[i];
        if (e.to === uid || e.to === 'all') events.push(e);
    }
    return { cursor: busBase + bus.length, events };
}
function registerSession(cwd, purpose, pin, project) {
    const cs = assignCallsign(pin);
    pendingPins.delete(cs);
    let tier = pendingTier.get(cs); pendingTier.delete(cs);
    if (!tier) { try { tier = resolveRepo(cwd).tier; } catch { } }
    tier = tier === 'trusted' ? 'trusted' : 'guarded';
    const uid = 's_' + String(roster.nextUid++).padStart(4, '0');
    const now = new Date().toISOString();
    const proj = project ? String(project).toLowerCase().trim() : null;
    roster.callsigns[cs] = [uid, ...(roster.callsigns[cs] || [])];
    roster.sessions[uid] = { callsign: cs, cwd: cwd || '', purpose: purpose || cs, started: now, ended: null, lastSeen: now, tier, ...(proj ? { project: proj } : {}) };
    saveRoster();
    const w = loadWork();
    // A project worker binds to the project's durable card/column and gets NO separate card.
    ensureBoard(w, proj || cs);
    let focusedNote = '';
    if (proj) { w.focus = proj; focusedNote = ' Focused on ' + proj + '.'; }
    else if (liveCallsigns().length === 1) { w.focus = cs; focusedNote = ' Focused on it.'; }
    saveWork(w);
    const reborn = roster.callsigns[cs].length > 1;
    if (proj) {
        record({ kind: 'sys', text: 'registered ' + uid + ' as ' + proj + ' worker (' + cs + '): ' + (purpose || '') });
        enqueueSay(proj + ' worker is up: ' + (purpose || 'the punchlist') + '.' + focusedNote, 'jarvis');
    } else {
        record({ kind: 'sys', text: 'registered ' + uid + ' as ' + cs + ': ' + (purpose || '') });
        enqueueSay((reborn ? cs + ' is now ' : 'New session. ' + cs + ' is ') + (purpose || 'unnamed work') + '.' + focusedNote, 'jarvis');
    }
    const out = { uid, callsign: cs };
    // Tell a fresh session if a predecessor on this cwd left a handoff — covers the manual
    // "kill the terminal and start over" path that never goes through spawnWorker.
    roster.handoffs = roster.handoffs || {};
    const h = cwd ? roster.handoffs[cwdKey(cwd)] : null;
    if (h) out.handoff = { summary: h.summary, from: h.from, ts: h.ts, hint: 'GET /handoff?cwd=<your cwd> for full notes, then resume.' };
    return out;
}
// opts.successor (bool): when true and the session has a cwd+purpose, spawn a fresh
// session on the same job, hand it the predecessor's summary + notes + unfinished board,
// and move focus to it. Default off (idle-sweep / forget close without a successor).
function retireSession(uid, summary, opts = {}) {
    const s = roster.sessions[uid];
    if (!s || s.ended) return false;
    s.ended = new Date().toISOString();
    if (summary) s.summary = summary;
    const cs = s.callsign;
    try { unlinkSync(join(DATA, 'spawn-' + cs + '.cmd')); } catch { } // its launch script is done with
    const w = loadWork();
    const board = w.sessions[cs] || { working: [], queued: [], done: [], review: [] };
    const unfinished = [...(board.working || []), ...(board.queued || [])];
    const total = unfinished.length + (board.review || []).length + (board.done || []).length;
    // The handoff record: one-line summary + detailed notes + the FULL board snapshot (all lanes).
    const rec = {
        summary: s.summary || null,
        notes: s.handoff || '',
        board: { working: board.working || [], queued: board.queued || [], review: board.review || [], done: board.done || [] },
        from: cs, fromUid: uid, cwd: s.cwd, purpose: s.purpose,
        ts: s.ended,
    };
    roster.handoffs = roster.handoffs || {};
    if (s.cwd) roster.handoffs[cwdKey(s.cwd)] = rec;
    writeFileSync(join(ARCHIVE, uid + '.json'), JSON.stringify({
        uid, callsign: cs, cwd: s.cwd, purpose: s.purpose,
        started: s.started, ended: s.ended, summary: s.summary || null,
        handoff: s.handoff || null, board,
    }, null, 1));

    if (s.project) {
        // Project worker: the durable project column stays put; just spawn the successor
        // (which re-attaches to the project on register). No NATO column to delete/transfer.
        let psucc = null;
        if (opts.successor && s.cwd && s.purpose) {
            try { psucc = spawnWorker(resolveRepo(s.cwd), s.purpose, opts.model, rec, undefined, s.project); } catch { psucc = null; }
        }
        saveWork(w);
        saveRoster();
        record({ kind: 'sys', text: cs + ' (' + s.project + ' worker) retired (' + uid + ')' + (psucc ? ' -> successor ' + psucc : '') });
        enqueueSay(psucc ? s.project + ' worker handed off.' : s.project + ' worker retired; the card is idle.', 'jarvis');
        busAppend({ from: 'jarvis', to: uid, kind: 'retired', text: 'retired' });
        return true;
    }

    let succCs = null;
    if (opts.successor && s.cwd && s.purpose) {
        try { succCs = spawnWorker(resolveRepo(s.cwd), s.purpose, opts.model, rec); }
        catch { succCs = null; }
    }
    if (succCs) {
        delete w.sessions[cs];
        const nb = ensureBoard(w, succCs);
        // The FULL board travels: working+queued become the successor's queue (front), and the
        // review + done lanes carry over intact so nothing the human still needs to see is lost.
        nb.queued = [...unfinished, ...nb.queued];
        nb.review = [...(board.review || []), ...nb.review];
        nb.done = [...(board.done || []), ...nb.done];
        if (w.focus === cs) w.focus = succCs;             // focus follows the work
        saveWork(w);
        saveRoster();
        const moved = nb.working.length + nb.queued.length + nb.review.length + nb.done.length;
        record({ kind: 'sys', text: cs + ' retired (' + uid + ') -> successor ' + succCs + '; board transferred (' + moved + '/' + total + ' tasks)' });
        if (moved < total) enqueueSay('Warning: handoff to ' + succCs + ' may have dropped tasks. Check the board.', 'jarvis');
        enqueueSay(cs + ' handed off to ' + succCs + '.' + (rec.summary ? ' ' + rec.summary : ''), 'jarvis');
        busAppend({ from: 'jarvis', to: uid, kind: 'retired', text: 'retired' });
        return true;
    }
    delete w.sessions[cs];
    if (w.focus === cs) w.focus = liveCallsigns().find(c => aliveNow(liveUidOf(c))) || 'jarvis';   // never strand focus on a dead board
    saveWork(w);
    saveRoster();
    record({ kind: 'sys', text: cs + ' retired (' + uid + ')' });
    enqueueSay(opts.spoken || (cs + ' retired.' + (summary ? ' ' + summary : '')), 'jarvis');
    busAppend({ from: 'jarvis', to: uid, kind: 'retired', text: 'retired' });
    return true;
}
const SPEECH_DEBOUNCE = Number(process.env.JARVIS_SPEECH_DEBOUNCE || 4000);
const nagAt = {};
function routeTo(cs, msg) {
    const uid = liveUidOf(cs) || projectWorkerUid(cs);
    if (!uid) return false;
    busAppend({ from: 'human', to: uid, kind: 'speech', text: msg }, SPEECH_DEBOUNCE);
    record({ kind: 'speech', text: msg, to: cs });
    if (roster.sessions[uid].needsYou) {
        roster.sessions[uid].needsYou = false;
        saveRoster();
    }
    if (!aliveNow(uid)) {
        if (Date.now() - (nagAt[cs] || 0) > 300000) {
            nagAt[cs] = Date.now();
            const mins = Math.max(1, Math.round((Date.now() - Date.parse(roster.sessions[uid].lastSeen)) / 60000));
            const other = liveCallsigns().find(c => c !== cs && aliveNow(liveUidOf(c)));
            const hint = other ? ' Say focus on ' + other + ' to switch.' : '';
            enqueueSay(cs + ' has not checked in for ' + mins + ' minute' + (mins === 1 ? '' : 's') + '. Queueing for it.' + hint, 'jarvis');
        }
    } else {
        delete nagAt[cs];
    }
    return true;
}
function findRepo(spoken) {
    const repos = loadRepos();
    const clean = spoken.toLowerCase().replace(/\b(the|a|an|repo|repository|project|folder|workspace)\b/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const keys = Object.keys(repos);
    const key = keys.find(x => x.toLowerCase() === clean)
        || keys.find(x => clean.includes(x.toLowerCase()))
        || keys.find(x => x.toLowerCase().includes(clean));
    return key ? { key, ...repos[key] } : null;
}
function chromeExe() {
    const cands = [
        join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return cands.find(p => existsSync(p)) || 'chrome';
}
function workProfileDir() {
    try {
        const ls = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Local State'), 'utf8'));
        const cache = (ls.profile && ls.profile.info_cache) || {};
        const email = String(process.env.JARVIS_LINK_EMAIL || '').toLowerCase();
        if (email) {
            for (const [dir, info] of Object.entries(cache)) {
                if (String(info.user_name || '').toLowerCase() === email) return dir;
            }
        }
    } catch { }
    return 'Default';
}
function withWorkAccount(url) {
    try {
        const email = process.env.JARVIS_LINK_EMAIL || '';
        const u = new URL(url);
        if (email && /(^|\.)google\.com$/i.test(u.hostname) && !u.searchParams.has('authuser')) {
            u.searchParams.set('authuser', email);
            return u.toString();
        }
    } catch { }
    return url;
}
function openInWorkChrome(url) {
    const target = withWorkAccount(url);
    const child = spawn(chromeExe(), ['--profile-directory=' + workProfileDir(), target], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
        const c2 = spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' });
        c2.unref();
    });
    child.unref();
    record({ kind: 'sys', text: 'opened: ' + target.slice(0, 90) });
}
function resolveClaude() {
    const home = process.env.USERPROFILE || '';
    const dirs = [
        ...(process.env.PATH || '').split(';').filter(Boolean),
        join(home, '.local', 'bin'),
        join(process.env.APPDATA || '', 'npm'),
        join(process.env.LOCALAPPDATA || '', 'Programs', 'claude'),
    ];
    for (const d of dirs) {
        for (const ext of ['.exe', '.cmd', '.bat']) {
            const p = join(d, 'claude' + ext);
            if (existsSync(p)) return p;
        }
    }
    return 'claude';
}
function spawnWorker(repo, purpose, model, handoff, tier, project) {
    const cs = assignCallsign();
    pendingPins.set(cs, Date.now());
    const effTier = (tier || repo.tier) === 'trusted' ? 'trusted' : null;
    if (effTier) pendingTier.set(cs, effTier);
    // wt.exe treats ';' as a command separator even inside argv (--title) — a purpose like
    // "...catalog; resuming" chops the wt command in half (0x80070002) and strands a pinned
    // phantom callsign. Strip it alongside the other shell/wt specials.
    const safePurpose = purpose.replace(/["'^&<>|%;]/g, '');
    const tabTitle = cs + ' - ' + safePurpose;
    let boot = 'You are a JARVIS worker session. Fetch http://127.0.0.1:' + PORT + '/protocol with a plain GET request and follow it exactly. Register with pin: ' + cs + ' and purpose: ' + safePurpose + (project ? ' and project: ' + project : '') + '.';
    if (handoff) {
        // Stash the handoff under this callsign (plain letters -> safe in the .cmd, no %-encoding)
        // so the successor can pull it the moment it boots and resume without a human re-brief.
        roster.handoffs = roster.handoffs || {};
        roster.handoffs['cs:' + cs] = handoff;
        saveRoster();
        boot += ' You are the SUCCESSOR to a prior session on this job, which left you a handoff. The moment you finish registering, GET http://127.0.0.1:' + PORT + '/handoff?cs=' + cs + ' to read its one-line summary and detailed notes, post one chat line to the human saying you have picked up the handoff, then resume that work where it left off — your task board already carries the unfinished items. Keep the poll loop running as your inbox.';
    } else {
        boot += ' Then wait for instructions on the poll loop.';
    }
    if (project) boot += ' You are the ' + project + ' PROJECT worker: your task board IS the ' + project + ' column - use callsign "' + project + '" for every /worklist op (add/start/done/etc), not your own callsign, and speech the human points at ' + project + ' arrives on your poll loop. When you must hand off, /retire with successor:true so a fresh ' + project + ' worker takes over.';
    boot += ' Permissions: read-only and routine build commands (git status/diff/log, npm run lint, node --check, ls/cat/grep/rg, dotnet build/test) run WITHOUT asking the human; only risky or out-of-repo actions prompt. Favor those pre-approved commands, batch shell calls, and self-verify (run the lint gate yourself) instead of asking. If you fan out subagents, keep them to the same safe command set so they do not each trigger a prompt.' + (effTier ? ' You are a TRUSTED session: your non-risky actions are auto-approved — work autonomously and only surface genuine decisions.' : '');
    const pm = repo.permissionMode ? ' --permission-mode ' + repo.permissionMode : '';
    const md = model || repo.model;
    const mm = md ? ' --model ' + md : '';
    const scriptPath = join(DATA, 'spawn-' + cs + '.cmd');
    const hookFlag = repo.permissionMode === 'bypassPermissions' ? '' : ' --settings "' + join(DATA, 'perm-settings.json') + '"';
    writeFileSync(scriptPath, [
        '@echo off',
        'title ' + tabTitle,
        'set JARVIS_CALLSIGN=' + cs,
        'set JARVIS_PORT=' + PORT,
        'cd /d "' + repo.cwd + '"',
        '"' + resolveClaude() + '"' + pm + mm + hookFlag + ' "' + boot + '"',
    ].join('\r\n') + '\r\n');
    const child = spawn('wt', ['new-tab', '--title', tabTitle, '--suppressApplicationTitle', 'cmd', '/k', scriptPath], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
        const c2 = spawn('cmd', ['/c', 'start', tabTitle, 'cmd', '/k', scriptPath], { detached: true, stdio: 'ignore' });
        c2.on('error', () => {
            enqueueSay('Could not launch a terminal for ' + repo.key + '.', 'jarvis');
            // The session will never register, so free the pinned callsign and remove the
            // leftover spawn script instead of letting both linger (phantom pin / .cmd clutter).
            pendingPins.delete(cs);
            try { unlinkSync(scriptPath); } catch { }
        });
        c2.unref();
    });
    child.unref();
    record({ kind: 'sys', text: 'spawned ' + cs + ' in ' + repo.cwd + ' (' + repo.key + ')' });
    return cs;
}
function speakBoard(cs, board) {
    const part = (label, items) => items && items.length ? label + ': ' + items.map(textOf).join('. ') + '. ' : '';
    return part('Working on', board.working) + part('Queued', board.queued);
}

function handleUtterance(rawText, typed) {
    let text = rawText;
    let lower = canon(text).toLowerCase();
    if (muted && !typed) {
        if (/\b(unmute|resume listening|start listening)\b/.test(lower)) {
            setMute(false);
            enqueueSay('Listening.', 'jarvis');
        }
        return;
    }
    if (/^(?:jarvis[\s,.!]+)?mute(?:\s+(?:yourself|listening|the mic))?[\s,.!]*$/.test(lower)) {
        setMute(true);
        return;
    }
    if (meetingMode) {
        if (/\bend meeting( mode)?\b|\bjarvis\b.*\b(i'?m )?back\b/.test(lower)) {
            meetingMode = false;
            record({ kind: 'sys', text: 'meeting mode off' });
            sayQueue.push({ text: 'Meeting mode off. I can hear you again.', from: 'jarvis' });
            return;
        }
        if (!/^jarvis\b/.test(lower) && !typed) return;
    } else if (/\bmeeting mode\b/.test(lower) && !/\bend\b/.test(lower)) {
        meetingMode = true;
        record({ kind: 'sys', text: 'meeting mode on' });
        sayQueue.push({ text: 'Meeting mode. Say jarvis to reach me, end meeting when you are done.', from: 'jarvis' });
        return;
    }
    if (/\bjarvis\b.*\b(shut ?down|shutdown)\b|\bend (the )?session\b/.test(lower)) {
        record({ kind: 'speech', text, command: 'shutdown' });
        enqueueSay('Shutting down.', 'jarvis');
        running = false;
        return;
    }
    if (/\b(pause|stop) listening\b/.test(lower)) {
        discard = true;
        record({ kind: 'sys', text: 'listening paused' });
        enqueueSay('Pausing. Say resume listening when you want me back.', 'jarvis');
        return;
    }
    if (/\b(resume|start) listening\b/.test(lower)) {
        discard = false;
        record({ kind: 'sys', text: 'listening resumed' });
        enqueueSay('Listening.', 'jarvis');
        return;
    }
    if (discard && !typed) return;
    if (meetingMode) {
        text = text.replace(/^jarvis[\s,.!]*/i, '').trim();
        if (!text) return;
        lower = canon(text).toLowerCase();
    }

    // —— Easter egg (for Big Chris): a spot of Guy Ritchie, served in the Queen's English.
    // Guns for show, knives for a pro; a clean handoff for the true professional. ——
    {
        const ritchie =
            /\bdo you know what (?:a )?nemesis means\b/.test(lower) ? "A righteous infliction of retribution, manifested by an appropriate agent. Personified, in this case, by a thoroughly horrible bug. Mind how you go." :
            /\bit'?s been emotional\b/.test(lower) ? "It has, Big Chris. It has." :
            /\bguns for show\b/.test(lower) ? "Knives for a pro. And a clean handoff for the true professional." :
            /\b(?:all bets are off|five minutes,? turkish)\b/.test(lower) ? "All bets are off. Five minutes, Turkish." :
            /\bguy ritchie\b/.test(lower) ? "There's mischief afoot, Big Chris. Guns for show, knives for a pro. Off to bed with you now; I've got the night shift." :
            null;
        if (ritchie) { record({ kind: 'sys', text: 'easter egg: a spot of Guy Ritchie' }); enqueueSay(ritchie, 'jarvis'); return; }
    }

    if (/\bscreen ?shot\b|\blook at (my|the|this) screen\b/.test(lower)) {
        screenGrant = Date.now() + 120000;
        const all = /\b(all|both|every) (monitors?|screens?)\b/.test(lower);
        captureScreen(DATA, all).then(shot => {
            record({ kind: 'sys', text: 'screenshot: ' + shot.path });
            enqueueSay('Snap.', 'jarvis');
            const w = loadWork();
            const uid = w.focus !== 'jarvis' ? liveUidOf(w.focus) : null;
            if (uid) busAppend({ from: 'jarvis', to: uid, kind: 'screenshot', text: shot.path });
        }).catch(() => enqueueSay('Screenshot failed.', 'jarvis'));
    }

    const P = /^(?:jarvis[\s,.!]+)?/;
    const after = (re) => lower.match(new RegExp(P.source + re.source));
    let m;

    // "remind me in 10 minutes to X" / "remind me at 3pm to X" / "set a timer for 5 min" ->
    // a calendar reminder that announces once when due.
    if (/^(?:jarvis[\s,.!]+)?(remind me|remind|set (a|an) timer|timer for)\b/.test(lower)) {
        const p = parseReminder(text);
        if (p) {
            const r = createReminder(p.title, p.start);
            const mins = Math.max(1, Math.round((Date.parse(r.start) - Date.now()) / 60000));
            record({ kind: 'sys', text: 'reminder set: ' + r.title + ' @ ' + r.start });
            enqueueSay('Okay, reminder set: ' + r.title + (mins < 60 ? ', in ' + mins + ' minute' + (mins === 1 ? '' : 's') : ', at ' + clk(r.start)) + '.', 'jarvis');
        } else {
            enqueueSay('I did not catch a time. Try, remind me in ten minutes to take a break.', 'jarvis');
        }
        return;
    }

    if ((m = after(/(?:focus(?: on)?|switch to|talk to)\s+([a-z-]+)\b/))) {
        const cs = csFrom(m[1]);
        if (cs) {
            const w = loadWork();
            w.focus = cs;
            if (cs !== 'jarvis') ensureBoard(w, cs);
            saveWork(w);
            record({ kind: 'sys', text: 'focus: ' + cs });
            if (cs === 'jarvis') enqueueSay('Focused on me.', 'jarvis');
            else enqueueSay('Focused on ' + cs + ', ' + roster.sessions[liveUidOf(cs)].purpose + '.', 'jarvis');
        } else enqueueSay('No live session called ' + m[1] + '.', 'jarvis');
        return;
    }
    if (after(/(?:who|what)(?:'s| is| else is)?\s+(?:running|up|alive|online)\b/)) {
        const lives = liveCallsigns();
        if (!lives.length) { enqueueSay('No sessions registered. Just me.', 'jarvis'); return; }
        const focus = loadWork().focus;
        enqueueSay(lives.map(cs => {
            const uid = liveUidOf(cs);
            return cs + ', ' + roster.sessions[uid].purpose + (aliveNow(uid) ? '' : ', quiet') + (cs === focus ? ', focused' : '');
        }).join('. ') + '.', 'jarvis');
        return;
    }
    if (after(/(?:what'?s?|read|when'?s?) (?:my |the )?next (?:meeting|event|thing)\b/) || after(/what'?s? next\b/)) {
        const s = loadSchedule();
        const now = Date.now();
        const evs = s.date === new Date().toDateString() ? (s.events || []) : [];
        const cur = evs.find(e => Date.parse(e.start) <= now && now < Date.parse(e.end));
        const next = evs.find(e => Date.parse(e.start) > now);
        const fmt = iso => { const d = new Date(iso); let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap; };
        const parts = [];
        if (cur) parts.push('Now: ' + cur.title + ' until ' + fmt(cur.end) + '.');
        if (next) parts.push('Next: ' + next.title + ' at ' + fmt(next.start) + '.');
        enqueueSay(parts.length ? parts.join(' ') : 'Nothing on the schedule.', 'jarvis');
        return;
    }
    if (after(/context (?:check|health|report)\b/) || after(/how(?:'s| is) (?:the |everyone'?s? )?context\b/)) {
        const lives = liveCallsigns();
        if (!lives.length) { enqueueSay('No sessions to report context for.', 'jarvis'); return; }
        enqueueSay(lives.map(cs => {
            const s = roster.sessions[liveUidOf(cs)];
            return cs + (typeof s.ctx === 'number' ? ' at ' + s.ctx + ' percent' : ', no report yet');
        }).join('. ') + '.', 'jarvis');
        return;
    }
    if ((m = after(/what did (?:the )?(?:old|previous|last)\s+([a-z-]+)\s+do\b/))) {
        const n = m[1].replace(/[^a-z]/g, '');
        const list = (roster.callsigns[n] || []).filter(u => roster.sessions[u].ended);
        if (!list.length) { enqueueSay('No retired ' + n + ' on record.', 'jarvis'); return; }
        lastHist = { cs: n, idx: 0 };
        const s = roster.sessions[list[0]];
        enqueueSay('The previous ' + n + ' was ' + s.purpose + '. ' + (s.summary || 'No summary was recorded.'), 'jarvis');
        return;
    }
    if (after(/(?:and )?(?:the )?one before that\b/) && lastHist) {
        const list = (roster.callsigns[lastHist.cs] || []).filter(u => roster.sessions[u].ended);
        if (lastHist.idx + 1 >= list.length) { enqueueSay('That is the oldest ' + lastHist.cs + ' on record.', 'jarvis'); return; }
        lastHist.idx++;
        const s = roster.sessions[list[lastHist.idx]];
        enqueueSay('Before that, ' + lastHist.cs + ' was ' + s.purpose + '. ' + (s.summary || 'No summary was recorded.'), 'jarvis');
        return;
    }
    if ((m = after(/who(?:'s| is)\s+([a-z-]+)\b/))) {
        const n = m[1].replace(/[^a-z]/g, '');
        const uid = liveUidOf(n);
        if (uid) {
            const s = roster.sessions[uid];
            enqueueSay(n + ' is ' + s.purpose + (aliveNow(uid) ? '.' : '. Quiet lately.'), 'jarvis');
        } else if ((roster.callsigns[n] || []).length) {
            const s = roster.sessions[roster.callsigns[n][0]];
            enqueueSay(n + ' is retired. Last time it was ' + s.purpose + '.', 'jarvis');
        } else enqueueSay('Nobody called ' + n + '.', 'jarvis');
        return;
    }
    if ((m = after(/call (?:this one|this session|it)\s+([a-z-]+)\b/))) {
        const target = m[1].replace(/[^a-z]/g, '');
        const w = loadWork();
        const cur = w.focus;
        if (cur === 'jarvis' || !liveUidOf(cur)) { enqueueSay('Nothing is focused to rename.', 'jarvis'); return; }
        if (!NATO.includes(target)) { enqueueSay(target + ' is not a callsign I use.', 'jarvis'); return; }
        if (liveUidOf(target)) { enqueueSay(target + ' is taken.', 'jarvis'); return; }
        const uid = liveUidOf(cur);
        roster.callsigns[cur] = roster.callsigns[cur].slice(1);
        if (!roster.callsigns[cur].length) delete roster.callsigns[cur];
        roster.callsigns[target] = [uid, ...(roster.callsigns[target] || [])];
        roster.sessions[uid].callsign = target;
        saveRoster();
        w.sessions[target] = w.sessions[cur] || { working: [], queued: [], done: [] };
        delete w.sessions[cur];
        w.focus = target;
        saveWork(w);
        record({ kind: 'sys', text: cur + ' renamed to ' + target });
        enqueueSay('Done. This one is ' + target + ' now.', 'jarvis');
        return;
    }
    if ((m = after(/describe\s+([a-z-]+)\s+as\s+(.+)$/))) {
        const cs = csFrom(m[1]);
        if (!cs || cs === 'jarvis') { enqueueSay('No live session called ' + m[1] + '.', 'jarvis'); return; }
        roster.sessions[liveUidOf(cs)].purpose = m[2].trim();
        saveRoster();
        record({ kind: 'sys', text: cs + ' described: ' + m[2].trim() });
        enqueueSay(cs + ' is now ' + m[2].trim() + '.', 'jarvis');
        return;
    }
    if ((m = after(/retire\s+([a-z-]+)(\s+anyway)?\b/))) {
        const cs = csFrom(m[1]);
        if (!cs || cs === 'jarvis') { enqueueSay('No live session called ' + m[1] + '.', 'jarvis'); return; }
        const uid = liveUidOf(cs);
        const board = loadWork().sessions[cs] || { working: [] };
        if (board.working.length && !m[2]) {
            enqueueSay(cs + ' still has ' + board.working.length + ' task' + (board.working.length === 1 ? '' : 's') + ' working. Say retire ' + cs + ' anyway to force it.', 'jarvis');
            return;
        }
        if (aliveNow(uid)) {
            busAppend({ from: 'jarvis', to: uid, kind: 'retire-request', text: 'Wrap up now: post your one-line summary to /retire, then stop polling.' });
            enqueueSay('Asked ' + cs + ' to wrap up and retire.', 'jarvis');
        } else {
            retireSession(uid, null);
        }
        return;
    }
    if ((m = after(/(?:start|spin up|launch)(?: a| a new| new)?((?:\s(?:cheap|haiku|fast|trusted|guarded|autonomous))*) session (?:in|on|at|for)\s+(.+)$/))) {
        const parts = m[2].split(/\s+for\s+/);
        const repo = findRepo(parts[0]);
        if (!repo) {
            const keys = Object.keys(loadRepos());
            enqueueSay('I do not know a repo matching ' + parts[0].trim() + '.' + (keys.length ? ' I know ' + keys.join(', ') + '.' : ' No repos are registered yet.'), 'jarvis');
            return;
        }
        const adj = (m[1] || '').toLowerCase();
        const model = /cheap|haiku|fast/.test(adj) ? 'haiku' : undefined;
        const tier = /trusted|autonomous/.test(adj) ? 'trusted' : undefined;
        const purpose = (parts[1] || repo.defaultPurpose || repo.key).trim();
        const cs = spawnWorker(repo, purpose, model, undefined, tier);
        enqueueSay('Launching ' + cs + ' in ' + repo.key + ' for ' + purpose + (model ? ', on ' + model : '') + (tier ? ', trusted' : '') + '. It will check in shortly.', 'jarvis');
        return;
    }
    if ((m = after(/(?:stop trusting|untrust|distrust|don'?t trust)\s+([a-z-]+)/))) {
        const cs = csFrom(m[1]); const uid = cs && cs !== 'jarvis' && liveUidOf(cs);
        if (!uid) { enqueueSay('No live session called ' + m[1] + '.', 'jarvis'); return; }
        roster.sessions[uid].trustUntil = 0; saveRoster();
        enqueueSay('Stopped trusting ' + cs + '. Back to asking on non-routine actions.', 'jarvis');
        return;
    }
    if ((m = after(/trust\s+([a-z-]+)(?:\s+for\s+(\d+)\s*(min|minute|minutes|hr|hrs|hour|hours|h)?)?/))) {
        const cs = csFrom(m[1]); const uid = cs && cs !== 'jarvis' && liveUidOf(cs);
        if (!uid) { enqueueSay('No live session called ' + m[1] + '.', 'jarvis'); return; }
        const n = m[2] ? parseInt(m[2], 10) : 30;
        const isHr = m[3] && /^h/.test(m[3]);
        const mins = isHr ? n * 60 : n;
        roster.sessions[uid].trustUntil = Date.now() + mins * 60000;
        saveRoster();
        enqueueSay('Trusting ' + cs + ' for ' + (isHr ? n + ' hour' + (n > 1 ? 's' : '') : mins + ' minutes') + '. I will auto-approve its non-risky actions.', 'jarvis');
        return;
    }
    if ((m = after(/(?:let'?s\s+)?(?:start(?:\s+working)?(?:\s+on)?|work(?:ing)?\s+on)\s+(?:([a-z-]+)\s+)?(?:item\s+|number\s+|no\.?\s*|#)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/))) {
        const w = loadWork();
        const word = m[1];
        let cs = w.focus;
        if (word && !IDX_FILLER.has(word)) { const c = csFrom(word); if (c) cs = c; }
        if (!cs || cs === 'jarvis' || !w.sessions[cs]) { enqueueSay(word ? ('No live session called ' + word + '.') : 'Nothing in focus to work on.', 'jarvis'); return; }
        const ord = orderedTasks(w.sessions[cs]);
        const n = NUMWORDS[m[2]] || parseInt(m[2], 10);
        const hit = ord[n - 1];
        if (!hit) { enqueueSay(cs + ' has no item ' + n + '.', 'jarvis'); return; }
        const board = w.sessions[cs];
        const title = shortTitle(textOf(hit.item));
        if (hit.list === 'review') {
            const [t] = board.review.splice(hit.i, 1);
            board.review.unshift(t);
            saveWork(w);
            record({ kind: 'task', op: 'top', board: cs, task: textOf(t) });
            enqueueSay('Flagged ' + title + '. Top of ' + cs + ' review, agent not pinged.', 'jarvis');
            return;
        }
        const [t] = board[hit.list].splice(hit.i, 1);
        board.working.unshift(t);
        saveWork(w);
        record({ kind: 'task', op: 'start', board: cs, task: textOf(t) });
        const uid = liveUidOf(cs);
        if (uid) busAppend({ from: 'human', to: uid, kind: 'speech', text: 'Start working on this now: ' + textOf(t) + '. I moved it to your working lane, so do not re-file it; do the work and report when done or blocked.' });
        enqueueSay('Told ' + cs + ' to start: ' + title + '.', 'jarvis');
        return;
    }
    if ((m = after(/(complete|finish|done|approve|drop|scratch|top|bump|prioriti[sz]e)\s+(?:([a-z-]+)\s+)?(?:item\s+|number\s+|no\.?\s*|#)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/))) {
        const verb = m[1].toLowerCase();
        const w = loadWork();
        const word = m[2];
        let cs = w.focus;
        if (word && !IDX_FILLER.has(word)) { const c = csFrom(word); if (c) cs = c; }
        if (!cs || cs === 'jarvis' || !w.sessions[cs]) { enqueueSay(word ? ('No live session called ' + word + '.') : 'Nothing in focus.', 'jarvis'); return; }
        const ord = orderedTasks(w.sessions[cs]);
        const n = NUMWORDS[m[3]] || parseInt(m[3], 10);
        const hit = ord[n - 1];
        if (!hit) { enqueueSay(cs + ' has no item ' + n + '.', 'jarvis'); return; }
        const board = w.sessions[cs];
        const title = shortTitle(textOf(hit.item));
        const [t] = board[hit.list].splice(hit.i, 1);
        let op, msg;
        if (/complete|finish|done|approve/.test(verb)) { board.done.push(t); op = 'done'; msg = (hit.list === 'review' ? 'Approved ' : 'Done with ') + title + '.'; }
        else if (/drop|scratch/.test(verb)) { op = 'drop'; msg = 'Scratched ' + title + '.'; }
        else { board[hit.list].unshift(t); op = 'top'; msg = 'Bumped ' + title + ' up.'; }
        saveWork(w);
        record({ kind: 'task', op, board: cs, task: textOf(t) });
        enqueueSay(msg, 'jarvis');
        return;
    }
    if ((m = after(/(?:give|move|send) (?:the )?(.+?) task to ([a-z-]+)\b/))) {
        const to = csFrom(m[2]);
        if (!to) { enqueueSay('No live session called ' + m[2] + '.', 'jarvis'); return; }
        const w = loadWork();
        const hit = findTaskAll(w, m[1].trim(), ['working', 'queued', 'done'], w.focus);
        if (!hit) { enqueueSay('Nothing matching ' + m[1].trim() + '.', 'jarvis'); return; }
        const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
        ensureBoard(w, to).queued.push(t);
        saveWork(w);
        record({ kind: 'task', op: 'move', task: textOf(t), from: hit.cs, board: to });
        enqueueSay('Moved to ' + to + '.', 'jarvis');
        return;
    }
    if (after(/read (?:everyone'?s'?|all)(?: the)? (?:list|lists|tasks)\b/)) {
        const w = loadWork();
        const parts = Object.entries(w.sessions)
            .map(([cs, b]) => { const s = speakBoard(cs, b); return s ? cs + '. ' + s : ''; })
            .filter(Boolean);
        enqueueSay(parts.length ? parts.join(' ') : 'Every list is empty.', 'jarvis');
        return;
    }
    if ((m = after(/(?:add|new) task[,:]?\s+(.+)/))) {
        const w = loadWork();
        let target = w.focus, body = m[1].trim();
        const fm = body.match(/^(.*\S)\s+for\s+([a-z-]+)$/);
        if (fm) {
            const cs = csFrom(fm[2]);
            if (cs) { target = cs; body = fm[1].trim(); }
        }
        ensureBoard(w, target).queued.push(makeTask(body));
        saveWork(w);
        record({ kind: 'task', op: 'add', board: target, task: body });
        enqueueSay(target === w.focus ? 'Added.' : 'Added to ' + target + '.', 'jarvis');
        return;
    }
    if ((m = after(/(?:start|begin) task[,:]?\s+(.+)/))) {
        const w = loadWork();
        const hit = findTaskAll(w, m[1].trim(), ['queued', 'done'], w.focus);
        if (hit) {
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            w.sessions[hit.cs].working.push(t);
            saveWork(w);
            record({ kind: 'task', op: 'start', board: hit.cs, task: textOf(t) });
            enqueueSay('Working on it.', 'jarvis');
        } else enqueueSay('No queued task matching ' + m[1].trim() + '.', 'jarvis');
        return;
    }
    if ((m = after(/(?:done with|finish task|complete task|finish|complete)[,:]?\s+(.+)/))) {
        const w = loadWork();
        const hit = findTaskAll(w, m[1].trim(), ['working', 'queued'], w.focus);
        if (hit) {
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            w.sessions[hit.cs].done.push(t);
            saveWork(w);
            record({ kind: 'task', op: 'done', board: hit.cs, task: textOf(t) });
            const b = w.sessions[hit.cs];
            enqueueSay('Done. ' + (b.working.length + b.queued.length) + ' to go.', 'jarvis');
        } else enqueueSay('No open task matching ' + m[1].trim() + '.', 'jarvis');
        return;
    }
    if ((m = after(/(?:scratch|drop) task[,:]?\s+(.+)/))) {
        const w = loadWork();
        const hit = findTaskAll(w, m[1].trim(), ['working', 'queued', 'done'], w.focus);
        if (hit) {
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            saveWork(w);
            record({ kind: 'task', op: 'drop', board: hit.cs, task: textOf(t) });
            enqueueSay('Scratched.', 'jarvis');
        } else enqueueSay('Nothing matching ' + m[1].trim() + '.', 'jarvis');
        return;
    }
    if (after(/clear done\b/)) {
        const w = loadWork();
        const board = ensureBoard(w, w.focus);
        const n = board.done.length;
        board.done = [];
        saveWork(w);
        record({ kind: 'task', op: 'clear-done', board: w.focus, count: n });
        enqueueSay('Cleared ' + n + '.', 'jarvis');
        return;
    }
    if (after(/(?:read|what is|what's) (?:the |on |my )?(?:list|worklist|tasks)\b/)) {
        const w = loadWork();
        const spoken = speakBoard(w.focus, ensureBoard(w, w.focus));
        const prefix = w.focus === 'jarvis' ? '' : 'On ' + w.focus + '. ';
        enqueueSay(spoken ? prefix + spoken : prefix + 'The list is empty.', 'jarvis');
        return;
    }
    if ((m = canon(text).match(/^on\s+(\S+)[\s,.!]+(.+)$/i))) {
        const cs = csFrom(m[1]);
        if (cs && cs !== 'jarvis') { routeTo(cs, m[2].trim()); return; }
        if (cs === 'jarvis') { if (!routeTo('jarvis', m[2].trim())) record({ kind: 'speech', text: m[2].trim() }); return; }
    }
    if (/^jarvis[\s,.!]+/i.test(text)) {
        const t = text.replace(/^jarvis[\s,.!]+/i, '').trim();
        if (t) { if (!routeTo('jarvis', t)) record({ kind: 'speech', text: t }); }
        return;
    }
    const focus = loadWork().focus;
    if (liveUidOf(focus) || projectWorkerUid(focus)) {
        routeTo(focus, text);
        return;
    }
    record({ kind: 'speech', text });
    console.log(`  HEARD "${text}"`);
}

function json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
}
function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', c => { data += c; if (data.length > 30e6) req.destroy(); });
        req.on('end', () => {
            try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
        });
    });
}

// CSRF / DNS-rebinding guard for mutating requests. Binding to 127.0.0.1 stops the network
// but NOT the browser: a web page you visit can fire fetch('http://127.0.0.1:8124/open',...)
// in no-cors mode (which still sends an Origin header), or rebind a hostname to 127.0.0.1.
// Worker/curl traffic sends no Origin and a 127.0.0.1/localhost Host, so it passes untouched;
// only a browser cross-site write (foreign Origin) or a rebound Host (foreign Host) is blocked.
function localRequestOk(req) {
    const host = String(req.headers.host || '');
    if (host !== '127.0.0.1:' + PORT && host !== 'localhost:' + PORT) return false;
    const origin = req.headers.origin;
    if (origin && origin !== 'http://127.0.0.1:' + PORT && origin !== 'http://localhost:' + PORT) return false;
    return true;
}

async function handleRequest(req, res) {
    const u = new URL(req.url, ORIGIN);
    const key = req.method + ' ' + u.pathname;
    // Only GET/HEAD are safe reads; every mutating method must come from the local console.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !localRequestOk(req)) {
        return json(res, 403, { error: 'forbidden: request must originate from the local console' });
    }
    if (key === 'GET /worklist') return json(res, 200, loadWork());
    if (key === 'GET /board') {
        const w = loadWork();
        const lives = liveCallsigns().filter(c => !(roster.sessions[liveUidOf(c)] || {}).project);
        const order = [w.focus, ...lives.filter(cs => cs !== w.focus), ...(w.focus === 'jarvis' ? [] : ['jarvis'])];
        const extras = Object.keys(w.sessions).filter(cs => !order.includes(cs));
        const boards = [...new Set([...order, ...extras])].map(cs => {
            const b = w.sessions[cs] || { working: [], queued: [], done: [], review: [] };
            const uid = liveUidOf(cs) || projectWorkerUid(cs);
            const pends = uid ? [...pendingPerms.values()].filter(p => p.uid === uid) : [];
            return {
                callsign: cs,
                uid: uid || null,
                // For a project card (e.g. 'jarvis') the bound worker keeps its own NATO callsign
                // — surface it so the human can see WHICH session is driving jarvis right now.
                worker: (uid && roster.sessions[uid] && roster.sessions[uid].callsign && roster.sessions[uid].callsign !== cs) ? roster.sessions[uid].callsign : null,
                cwd: uid ? (roster.sessions[uid].cwd || '') : '',
                purpose: uid ? roster.sessions[uid].purpose : '',
                alive: cs === 'jarvis' ? true : (uid ? aliveNow(uid) : false),
                context: uid && roster.sessions[uid].ctx !== undefined ? roster.sessions[uid].ctx : null,
                doing: uid ? roster.sessions[uid].doing || '' : '',
                needsYou: uid ? !!roster.sessions[uid].needsYou : false,
                voiceMuted: uid ? !!roster.sessions[uid].voiceMuted : false,
                pendingPerm: pends[0] ? { id: pends[0].id, tool: pends[0].tool, detail: pends[0].detail, klass: pends[0].klass || 'neutral', label: permLabel(pends[0].tool, pends[0].detail) } : null,
                pendingPermCount: pends.length,
                working: b.working, queued: b.queued, done: b.done, review: b.review || [],
            };
        });
        return json(res, 200, { focus: w.focus, muted, paused: discard, boards });
    }
    if (key === 'GET /roster') {
        const live = liveCallsigns().map(cs => {
            const uid = liveUidOf(cs);
            const s = roster.sessions[uid];
            return { callsign: cs, uid, purpose: s.purpose, cwd: s.cwd, started: s.started, lastSeen: s.lastSeen, alive: aliveNow(uid) };
        });
        const retired = Object.entries(roster.sessions)
            .filter(([, s]) => s.ended)
            .sort((a, b) => Date.parse(b[1].ended) - Date.parse(a[1].ended))
            .slice(0, 20)
            .map(([uid, s]) => ({ uid, callsign: s.callsign, purpose: s.purpose, summary: s.summary || null, ended: s.ended }));
        return json(res, 200, { focus: loadWork().focus, live, retired });
    }
    if (key === 'GET /archive') {
        // Retired-session history from archive/*.json. ?uid=<uid> returns one full entry
        // (incl. handoff notes + final board); bare returns a recent summary list.
        const want = String(u.searchParams.get('uid') || '').trim();
        let files;
        try { files = readdirSync(ARCHIVE).filter(f => f.endsWith('.json')); } catch { files = []; }
        if (want) {
            const f = files.find(x => x === want + '.json');
            if (!f) return json(res, 404, { error: 'no archived session ' + want });
            try { return json(res, 200, JSON.parse(readFileSync(join(ARCHIVE, f), 'utf8'))); }
            catch { return json(res, 500, { error: 'unreadable archive entry' }); }
        }
        // A parked project lives in On Hold, not Archive — hide its session history here while held.
        const heldKeys = new Set((roster.held || []).map(h => h.key));
        const items = files.map(f => {
            try {
                const a = JSON.parse(readFileSync(join(ARCHIVE, f), 'utf8'));
                const board = a.board || {};
                return {
                    uid: a.uid, callsign: a.callsign, purpose: a.purpose || '', cwd: a.cwd || '',
                    summary: a.summary || null, hasHandoff: !!(a.handoff && a.handoff.trim()),
                    started: a.started || null, ended: a.ended || null,
                    counts: { working: (board.working || []).length, queued: (board.queued || []).length, done: (board.done || []).length, review: (board.review || []).length },
                };
            } catch { return null; }
        }).filter(Boolean).filter(a => !heldKeys.has(cwdKey(a.cwd))).sort((x, y) => Date.parse(y.ended || 0) - Date.parse(x.ended || 0));
        return json(res, 200, { count: items.length, items });
    }
    if (key === 'GET /repos') {
        // Read-only repo list for the console's new-session composer (the + tab).
        const repos = loadRepos();
        const items = Object.entries(repos).map(([key, v]) => ({ key, cwd: v.cwd || '', defaultPurpose: v.defaultPurpose || '' }));
        return json(res, 200, { items });
    }
    if (key === 'GET /hold') {
        // Projects parked for later (distinct from Archive = finished). Newest first.
        const items = (roster.held || []).map(h => ({
            key: h.key, callsign: h.callsign || null, cwd: h.cwd || '', purpose: h.purpose || '',
            summary: h.summary || null, parkedAt: h.parkedAt || null,
            hasHandoff: !!(roster.handoffs && (roster.handoffs[cwdKey(h.cwd)] || (h.callsign && roster.handoffs['cs:' + h.callsign]))),
        }));
        return json(res, 200, { count: items.length, items });
    }
    if (key === 'POST /hold') {
        // Park a session/project on hold. A live session is stopped cleanly (no successor) and
        // filed under On Hold; a bare cwd+purpose parks a project that isn't live (e.g. from the
        // Archive). Pull it back later with /unhold, which re-spawns it (inheriting its handoff).
        const b = await readBody(req);
        const cs0 = String(b.callsign || '').toLowerCase();
        const uid = (b.uid && roster.sessions[b.uid] && !roster.sessions[b.uid].ended) ? b.uid : liveUidOf(cs0);
        let cwd, purpose, callsign, summary;
        if (uid && roster.sessions[uid]) {
            const s = roster.sessions[uid];
            cwd = s.cwd; purpose = s.purpose; callsign = s.callsign;
            summary = String(b.summary || '').trim() || s.summary || 'Parked - pull it back when ready.';
            retireSession(uid, summary, { successor: false, spoken: callsign + ' is on hold. Pull it back whenever you are ready.' });
        } else {
            cwd = String(b.cwd || '').trim();
            purpose = String(b.purpose || '').trim();
            callsign = cs0 || null;
            summary = String(b.summary || '').trim() || null;
            if (!cwd && !purpose) return json(res, 400, { error: 'need a live callsign/uid, or a cwd+purpose to park' });
            enqueueSay((callsign || 'That project') + ' is on hold. Pull it back whenever.', 'jarvis');
        }
        const k = cwd ? cwdKey(cwd) : ('p:' + String(callsign || purpose || '').toLowerCase());
        roster.held = (roster.held || []).filter(h => h.key !== k);   // de-dupe by project key
        roster.held.unshift({ key: k, callsign, cwd, purpose, summary, parkedAt: new Date().toISOString() });
        saveRoster();
        record({ kind: 'sys', text: (callsign || purpose || 'project') + ' parked on hold' });
        return json(res, 200, { ok: true, key: k });
    }
    if (key === 'POST /unhold') {
        // Pull a parked project back: drop it from On Hold and (unless {drop:true}) spawn a fresh
        // worker on it, which inherits the handoff via its cwd — same as the Archive "continue".
        const b = await readBody(req);
        roster.held = roster.held || [];
        const wantKey = b.key || (b.cwd ? cwdKey(b.cwd) : null);
        const wantCs = String(b.callsign || '').toLowerCase();
        const idx = roster.held.findIndex(h => (wantKey && h.key === wantKey) || (b.cwd && cwdKey(h.cwd) === cwdKey(b.cwd)) || (wantCs && h.callsign === wantCs));
        if (idx < 0) return json(res, 404, { error: 'not on hold' });
        const h = roster.held[idx];
        roster.held.splice(idx, 1);
        saveRoster();
        if (b.drop) {
            record({ kind: 'sys', text: (h.callsign || h.purpose || 'project') + ' removed from on-hold' });
            return json(res, 200, { ok: true, dropped: true });
        }
        let cs = null;
        if (h.cwd && h.purpose) {
            roster.handoffs = roster.handoffs || {};
            const handoff = roster.handoffs[cwdKey(h.cwd)] || null;
            try { cs = spawnWorker(resolveRepo(h.cwd), h.purpose, b.model, handoff); } catch { cs = null; }
        }
        record({ kind: 'sys', text: (h.callsign || h.purpose || 'project') + ' pulled back from on-hold' + (cs ? ' -> ' + cs : '') });
        enqueueSay((h.callsign || 'That project') + ' is back' + (cs ? ', ' + cs + ' is spinning up' : '') + '.', 'jarvis');
        return json(res, 200, { ok: true, callsign: cs });
    }
    if (key === 'GET /att') {
        const n = String(u.searchParams.get('n') || '').replace(/[\\/]/g, '');
        const p = join(DATA, 'attachments', n);
        if (!n || !existsSync(p)) return json(res, 404, { error: 'not found' });
        const ext = n.split('.').pop().toLowerCase();
        const ct = ext === 'png' ? 'image/png' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': ct });
        res.end(readFileSync(p));
        return;
    }
    if (key === 'GET /transcript') {
        const lim = Number(u.searchParams.get('limit') || 60);
        const kinds = { speech: 1, tts: 1, chat: 1, sys: 1, react: 1 };
        const evts = transcriptCache.filter(e => kinds[e.kind]).map(e => ({
            ts: e.ts,
            kind: e.kind === 'sys' ? 'sys' : e.kind === 'react' ? 'react' : 'msg',
            who: e.kind === 'speech' ? 'you' : e.kind === 'sys' ? 'sys' : (e.from || 'jarvis'),
            to: e.to || null,
            img: e.img || null,
            text: e.text,
            ...(e.kind === 'react' ? { target: e.target, reaction: e.reaction } : {}),
        }));
        return json(res, 200, lim > 0 ? evts.slice(-lim) : evts);
    }
    if (key === 'GET /tokens') {
        return json(res, 200, tokenStats);
    }
    if (key === 'GET /screen') {
        const s = roster.sessions[u.searchParams.get('uid')];
        if (Date.now() > screenGrant) {
            return json(res, 403, { error: 'screen is voice-gated: the human must say take a screenshot first, one capture per ask' });
        }
        try {
            const shot = await captureScreen(DATA, u.searchParams.get('all') === '1');
            screenGrant = 0;
            record({ kind: 'sys', text: (s ? s.callsign : 'someone') + ' took the screenshot' });
            return json(res, 200, shot);
        } catch (e) {
            return json(res, 500, { error: e.message });
        }
    }
    if (key === 'GET /protocol') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(existsSync(WORKER_DOC) ? readFileSync(WORKER_DOC, 'utf8') : 'WORKER.md missing');
        return;
    }
    if (key === 'GET /poll') {
        const uid = u.searchParams.get('uid');
        const cursor = Number(u.searchParams.get('cursor') || 0);
        const s = roster.sessions[uid];
        if (!s) return json(res, 404, { error: 'unknown uid' });
        if (s.ended) return json(res, 410, { error: 'retired' });
        s.lastSeen = new Date().toISOString();
        saveRosterThrottled();
        const out = eventsFor(uid, cursor);
        if (out.events.length) return json(res, 200, out);
        const waiter = { uid, cursor, res, timer: null };
        waiter.timer = setTimeout(() => {
            const i = pollWaiters.indexOf(waiter);
            if (i >= 0) pollWaiters.splice(i, 1);
            json(res, 200, { cursor: busBase + bus.length, events: [] });
        }, 25000);
        pollWaiters.push(waiter);
        req.on('close', () => {
            const i = pollWaiters.indexOf(waiter);
            if (i >= 0) { pollWaiters.splice(i, 1); clearTimeout(waiter.timer); }
        });
        return;
    }
    if (key === 'GET /heartbeat') {
        // Liveness-only ping, DECOUPLED from the agent turn. A worker fires this on a fixed
        // background timer (see WORKER.md §2) so lastSeen stays fresh through long agent turns
        // that never relaunch the event poll loop -- the loop only re-runs on a turn boundary,
        // so one 45-min turn would otherwise let lastSeen go stale and aliveNow() flip false.
        // It does NOT return events and NEVER blocks: bump lastSeen and reply immediately.
        const uid = u.searchParams.get('uid');
        const s = roster.sessions[uid];
        if (!s) return json(res, 404, { error: 'unknown uid' });
        if (s.ended) return json(res, 410, { error: 'retired' });
        s.lastSeen = new Date().toISOString();
        saveRosterThrottled();
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /register') {
        const b = await readBody(req);
        if (!String(b.purpose || '').trim() || !String(b.cwd || '').trim()) {
            return json(res, 400, { error: 'purpose and cwd are required. purpose is the one-line description the human sees on the board and hears in announcements; make it specific. Re-POST with both.' });
        }
        try { return json(res, 200, registerSession(b.cwd, b.purpose, b.pin, b.project)); }
        catch (e) { return json(res, 409, { error: e.message }); }
    }
    if (key === 'POST /health') {
        const b = await readBody(req);
        const s = roster.sessions[b.uid];
        if (!s || s.ended) return json(res, 404, { error: 'unknown uid' });
        const n = Math.round(Number(b.context));
        if (!Number.isFinite(n) || n < 0 || n > 100) return json(res, 400, { error: 'context must be a number 0-100' });
        s.ctx = n;
        s.ctxTs = new Date().toISOString();
        if (b.doing !== undefined) s.doing = String(b.doing || '').slice(0, 80);
        if (n >= 80 && !s.ctxWarned) {
            s.ctxWarned = true;
            enqueueSay(s.callsign + ' is at ' + n + ' percent context. Have it wrap up and hand off soon.', 'jarvis');
        }
        if (n < 80) s.ctxWarned = false;
        saveRoster();
        return json(res, 200, { ok: true });
    }
    if (key === 'GET /notify') {
        return json(res, 200, { url: (NOTIFY && NOTIFY.url) || '', configured: !!(NOTIFY && NOTIFY.url) });
    }
    if (key === 'POST /notify') {
        const b = await readBody(req);
        NOTIFY = { url: String(b.url || '').trim() };
        saveNotify();
        return json(res, 200, { ok: true, configured: !!NOTIFY.url });
    }
    if (key === 'POST /notify-test') {
        if (!(NOTIFY && NOTIFY.url)) return json(res, 400, { error: 'no ntfy url configured; POST /notify {url} first' });
        lastPushAt = 0;
        pushPhone('JARVIS test', 'Phone notifications are wired up. You will get a buzz when a session needs you.');
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /describe') {
        const b = await readBody(req);
        const uid = roster.sessions[b.uid] ? b.uid : liveUidOf(String(b.callsign || '').toLowerCase());
        const purpose = String(b.purpose || '').trim();
        if (!uid || !purpose) return json(res, 400, { error: 'need callsign (or uid) and purpose' });
        roster.sessions[uid].purpose = purpose;
        saveRoster();
        record({ kind: 'sys', text: roster.sessions[uid].callsign + ' described: ' + purpose });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /send') {
        const b = await readBody(req);
        const s = roster.sessions[b.from];
        const label = s ? s.callsign : 'jarvis';
        if (b.to === 'human') {
            record({ kind: 'chat', from: label, text: String(b.text || '') });
            return json(res, 200, { ok: true });
        }
        const toUid = roster.sessions[b.to] ? b.to : liveUidOf(String(b.to || '').toLowerCase());
        if (!toUid) return json(res, 404, { error: 'unknown recipient' });
        busAppend({ from: b.from, to: toUid, kind: 'msg', text: String(b.text || '') });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /say') {
        const b = await readBody(req);
        const s = roster.sessions[b.from];
        // A /say with a non-empty but unknown `from` is almost always a botched register+greet
        // (the shell extracted a garbage callsign from an error response -> "{ checking in.").
        // Reject it rather than mislabel it as jarvis and speak the garbage.
        if (b.from && !s) return json(res, 400, { error: 'unknown from uid ' + b.from + '; register successfully before /say' });
        const label = s ? s.callsign : 'jarvis';
        if (s && /^need you[:,]/i.test(String(b.text || '').trim())) {
            s.needsYou = true;
            saveRoster();
        }
        String(b.text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(l => enqueueSay(l, label));
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /react') {
        // Append-only message reaction (durable; a feedback signal on any message, incl. mine).
        const b = await readBody(req);
        const target = String(b.ts || '').trim();
        const reaction = String(b.reaction || '').trim();
        if (!target || !['up', 'love', 'squee', 'fire', 'down', 'poop'].includes(reaction)) {
            return json(res, 400, { error: 'need ts and reaction one of up|love|squee|fire|down|poop' });
        }
        record({ kind: 'react', target, reaction, from: 'you', text: reaction });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /focus') {
        const b = await readBody(req);
        const cs = String(b.callsign || '').toLowerCase();
        if (cs !== 'jarvis' && !liveUidOf(cs)) return json(res, 404, { error: 'no live session ' + cs });
        const w = loadWork();
        w.focus = cs;
        if (cs !== 'jarvis') ensureBoard(w, cs);
        saveWork(w);
        record({ kind: 'sys', text: 'focus: ' + cs });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /spawn') {
        const b = await readBody(req);
        const cwd = String(b.cwd || '').trim();
        const purpose = String(b.purpose || '').trim();
        if (!cwd || !purpose) return json(res, 400, { error: 'need cwd and purpose' });
        const repo = resolveRepo(cwd);
        roster.handoffs = roster.handoffs || {};
        const handoff = roster.handoffs[cwdKey(cwd)] || null;
        const cs = spawnWorker(repo, purpose, b.model, handoff, b.tier, b.project);
        enqueueSay('Launching ' + (b.project ? b.project + ' worker' : cs) + ' in ' + repo.key + (handoff ? ', resuming the handoff' : '') + '.', 'jarvis');
        return json(res, 200, { ok: true, callsign: cs });
    }
    if (key === 'POST /permission') {
        const b = await readBody(req);
        const cs = String(b.callsign || '').toLowerCase();
        const tool = String(b.tool || ''); const detail = String(b.detail || ''); const klass = String(b.klass || 'neutral');
        const uid = liveUidOf(cs);
        const sess = uid ? roster.sessions[uid] : null;
        const sig = permSig(tool, detail);
        if (sess && Array.isArray(sess.autoAllow) && sess.autoAllow.includes(sig)) {
            return json(res, 200, { decision: 'allow' });
        }
        if (klass !== 'danger' && sess) {
            if (sess.trustUntil && Date.now() < sess.trustUntil) return json(res, 200, { decision: 'allow' });
            if (sess.tier === 'trusted') return json(res, 200, { decision: 'allow' });
        }
        const id = 'perm_' + (++permSeq);
        const rec = { id, cs, uid, tool, detail, klass, sig, res };
        rec.timer = setTimeout(() => { if (pendingPerms.delete(id)) { try { json(res, 200, { decision: 'timeout' }); } catch { } } }, 300000);
        if (rec.timer.unref) rec.timer.unref();
        pendingPerms.set(id, rec);
        if (sess) { sess.needsYou = true; saveRoster(); }
        record({ kind: 'sys', text: cs + ' wants to run [' + tool + '] ' + detail.slice(0, 90) });
        enqueueSay('Need you: ' + cs + ' wants to run a ' + (klass === 'danger' ? 'risky ' : '') + tool + ' command.', 'jarvis');
        return;
    }
    if (key === 'POST /permission-answer') {
        const b = await readBody(req);
        const rec = pendingPerms.get(String(b.id || ''));
        if (!rec) return json(res, 404, { error: 'no pending permission' });
        pendingPerms.delete(rec.id);
        clearTimeout(rec.timer);
        let decision = String(b.decision || 'deny');
        if (decision === 'always') {
            decision = 'allow';
            if (rec.uid && roster.sessions[rec.uid]) {
                const s = roster.sessions[rec.uid];
                s.autoAllow = s.autoAllow || [];
                if (!s.autoAllow.includes(rec.sig)) s.autoAllow.push(rec.sig);
            }
        }
        if (rec.uid && roster.sessions[rec.uid]) roster.sessions[rec.uid].needsYou = false;
        saveRoster();
        record({ kind: 'sys', text: rec.cs + ' [' + rec.tool + '] ' + (decision === 'allow' ? 'approved' : 'denied') });
        try { json(rec.res, 200, { decision }); } catch { }
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /permission-answer-all') {
        const b = await readBody(req);
        const cs = String(b.callsign || '').toLowerCase();
        const uid = cs ? liveUidOf(cs) : String(b.uid || '');
        let decision = String(b.decision || 'allow');
        const store = decision === 'always';
        if (store) decision = 'allow';
        const recs = [...pendingPerms.values()].filter(p => p.uid === uid);
        for (const rec of recs) {
            pendingPerms.delete(rec.id);
            clearTimeout(rec.timer);
            if (store && roster.sessions[uid]) {
                const s = roster.sessions[uid];
                s.autoAllow = s.autoAllow || [];
                if (!s.autoAllow.includes(rec.sig)) s.autoAllow.push(rec.sig);
            }
            try { json(rec.res, 200, { decision }); } catch { }
        }
        if (uid && roster.sessions[uid]) roster.sessions[uid].needsYou = false;
        saveRoster();
        record({ kind: 'sys', text: (cs || uid) + ' [' + recs.length + ' requests] ' + (decision === 'allow' ? 'approved' : 'denied') });
        return json(res, 200, { ok: true, count: recs.length });
    }
    if (key === 'POST /attach') {
        const b = await readBody(req);
        const data = String(b.data || '');
        if (!data) return json(res, 400, { error: 'no data' });
        const name = (String(b.name || 'paste.png').replace(/[^a-zA-Z0-9._-]/g, '_') || 'file').slice(0, 60);
        const cs = String(b.callsign || '').toLowerCase();
        const dir = join(DATA, 'attachments');
        mkdirSync(dir, { recursive: true });
        const fname = new Date().toISOString().replace(/[:.]/g, '-') + '_' + name;
        const fpath = join(dir, fname);
        writeFileSync(fpath, Buffer.from(data, 'base64'));
        const w = loadWork();
        const uid = (cs && liveUidOf(cs)) || (w.focus !== 'jarvis' ? liveUidOf(w.focus) : null);
        if (uid) busAppend({ from: 'human', to: uid, kind: 'screenshot', text: fpath });
        const toCs = uid ? roster.sessions[uid].callsign : null;
        record({ kind: 'speech', text: '📎 ' + name + (toCs ? '' : ' (saved)'), to: toCs || null, img: '/att?n=' + encodeURIComponent(fname) });
        return json(res, 200, { ok: true, path: fpath, to: toCs });
    }
    if (key === 'POST /forget') {
        const b = await readBody(req);
        const cs = String(b.callsign || '').toLowerCase();
        if (!cs || cs === 'jarvis') return json(res, 400, { error: 'bad callsign' });
        const uid = liveUidOf(cs);
        if (uid) retireSession(uid, String(b.summary || '').trim() || 'Closed from console.');
        const w = loadWork();
        delete w.sessions[cs];
        const fUid = w.focus !== 'jarvis' ? liveUidOf(w.focus) : null;
        if (w.focus === cs || (w.focus !== 'jarvis' && (!fUid || !aliveNow(fUid)))) {
            w.focus = liveCallsigns().find(c => aliveNow(liveUidOf(c))) || 'jarvis';
        }
        saveWork(w);
        record({ kind: 'sys', text: 'removed ' + cs + ' from board' });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /worklist') {
        const b = await readBody(req);
        const w = loadWork();
        const cs = (b.callsign && (w.sessions[b.callsign] || liveUidOf(String(b.callsign).toLowerCase()) || b.callsign === 'jarvis')) ? String(b.callsign).toLowerCase() : w.focus;
        const board = ensureBoard(w, cs);
        const needle = String(b.text || '').trim();
        let task = needle || undefined;
        if (b.op === 'add' && needle) {
            task = makeTask(needle, b);
            board.queued.push(task);
        } else if (b.op === 'start' || b.op === 'done' || b.op === 'drop' || b.op === 'ready' || b.op === 'review') {
            const lists = b.op === 'start' ? ['queued', 'done', 'review']
                : b.op === 'done' ? ['working', 'queued', 'review']
                : b.op === 'ready' ? ['working', 'done', 'review']
                : b.op === 'review' ? ['working', 'queued', 'done']
                : ['working', 'queued', 'done', 'review'];
            const hit = findTaskAll(w, needle, lists, cs);
            if (!hit) return json(res, 404, { error: 'no task matching ' + needle });
            const dest = ensureBoard(w, hit.cs);
            const [t] = dest[hit.list].splice(hit.i, 1);
            if (b.op === 'start') dest.working.push(t);
            if (b.op === 'done') dest.done.push(t);
            if (b.op === 'ready') dest.queued.push(t);
            if (b.op === 'review') dest.review.push(t);
            task = t;
        } else if (b.op === 'top') {
            const hit = findTaskAll(w, needle, ['queued', 'working', 'review', 'done'], cs);
            if (!hit) return json(res, 404, { error: 'no task matching ' + needle });
            const arr = w.sessions[hit.cs][hit.list];
            const [t] = arr.splice(hit.i, 1);
            arr.unshift(t);
            task = t;
        } else if (b.op === 'move' && needle && b.to) {
            const hit = findTaskAll(w, needle, ['working', 'queued', 'done'], cs);
            if (!hit) return json(res, 404, { error: 'no task matching ' + needle });
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            ensureBoard(w, String(b.to).toLowerCase()).queued.push(t);
            task = t;
        } else if (b.op === 'clear-done') {
            board.done = [];
        } else {
            return json(res, 400, { error: 'op must be add|start|done|review|top|drop|move|clear-done' });
        }
        saveWork(w);
        record({ kind: 'task', op: b.op, board: cs, task: textOf(task) });
        return json(res, 200, { ok: true, op: b.op, task });
    }
    if (key === 'POST /retire') {
        const b = await readBody(req);
        const s = roster.sessions[b.uid];
        if (s && !s.ended && b.notes != null) s.handoff = String(b.notes);
        let successor = false;
        if (s && !s.ended) {
            const board = loadWork().sessions[s.callsign] || { working: [], queued: [] };
            const hasWork = (board.working || []).length + (board.queued || []).length > 0;
            // auto-successor on retire when work remains; explicit successor:true/false overrides
            successor = b.successor === true || (b.successor !== false && hasWork);
        }
        const ok = retireSession(b.uid, String(b.summary || '').trim() || null, { successor });
        return json(res, ok ? 200 : 404, ok ? { ok: true, successor } : { error: 'unknown or already retired uid' });
    }
    if (key === 'POST /handoff') {
        // A live session checkpoints its handoff (one-line summary + detailed notes) so a
        // successor can resume seamlessly. Safe to call repeatedly; latest wins.
        const b = await readBody(req);
        const s = roster.sessions[b.uid];
        if (!s || s.ended) return json(res, 404, { error: 'unknown or retired uid' });
        if (b.summary != null) s.summary = String(b.summary).trim();
        if (b.notes != null) s.handoff = String(b.notes);
        const w = loadWork();
        const board = w.sessions[s.callsign] || { working: [], queued: [] };
        roster.handoffs = roster.handoffs || {};
        if (s.cwd) roster.handoffs[cwdKey(s.cwd)] = {
            summary: s.summary || null, notes: s.handoff || '',
            board: { working: board.working || [], queued: board.queued || [] },
            from: s.callsign, fromUid: b.uid, cwd: s.cwd, purpose: s.purpose,
            ts: new Date().toISOString(),
        };
        saveRoster();
        return json(res, 200, { ok: true });
    }
    if (key === 'GET /handoff') {
        // A successor reads its predecessor's handoff. ?cs=<callsign> is the one-shot stash
        // the spawn wrote (consumed on read); ?cwd=<path> is the durable per-job record.
        roster.handoffs = roster.handoffs || {};
        const csq = String(u.searchParams.get('cs') || '').toLowerCase().replace(/[^a-z]/g, '');
        const cwdq = u.searchParams.get('cwd');
        let rec = null;
        if (csq && roster.handoffs['cs:' + csq]) {
            rec = roster.handoffs['cs:' + csq];
            delete roster.handoffs['cs:' + csq];
            saveRoster();
        } else if (cwdq) {
            rec = roster.handoffs[cwdKey(cwdq)] || null;
        } else if (csq) {
            rec = Object.entries(roster.handoffs)
                .filter(([k, r]) => !k.startsWith('cs:') && r && r.from === csq)
                .map(([, r]) => r)
                .sort((a, b2) => Date.parse(b2.ts) - Date.parse(a.ts))[0] || null;
        }
        if (!rec) return json(res, 200, { none: true });
        return json(res, 200, rec);
    }
    if (key === 'POST /repos') {
        const b = await readBody(req);
        const name = String(b.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!name || !b.cwd || !existsSync(b.cwd)) return json(res, 400, { error: 'need name and an existing cwd' });
        const repos = loadRepos();
        repos[name] = { cwd: b.cwd, defaultPurpose: b.defaultPurpose || '', ...(b.permissionMode ? { permissionMode: b.permissionMode } : {}), ...(b.model ? { model: b.model } : {}) };
        writeFileSync(REPOS, JSON.stringify(repos, null, 1));
        record({ kind: 'sys', text: 'repo registered: ' + name + ' -> ' + b.cwd });
        enqueueSay('Repo ' + name + ' registered.', 'jarvis');
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /voices') {
        const b = await readBody(req);
        record({ kind: 'sys', text: 'TTS chosen: ' + (b.chosen || 'none') + ' | available: ' + (Array.isArray(b.voices) ? b.voices.join(' ; ') : '') });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /mute') {
        const b = await readBody(req);
        setMute(!!b.on);
        return json(res, 200, { ok: true, muted });
    }
    if (key === 'POST /pause') {
        const b = await readBody(req);
        discard = !!b.on;
        record({ kind: 'sys', text: discard ? 'listening paused (console)' : 'listening resumed (console)' });
        return json(res, 200, { ok: true, paused: discard });
    }
    if (key === 'POST /voicemute') {
        // Silence one session's spoken lines (still logged in chat); per-session, not the global mute.
        const b = await readBody(req);
        const uid = b.uid || liveUidOf(String(b.callsign || '').toLowerCase());
        const s = uid && roster.sessions[uid];
        if (!s) return json(res, 404, { error: 'unknown session' });
        s.voiceMuted = !!b.on;
        saveRoster();
        record({ kind: 'sys', text: s.callsign + (s.voiceMuted ? ' voice muted' : ' voice unmuted') + ' (console)' });
        return json(res, 200, { ok: true, voiceMuted: s.voiceMuted });
    }
    if (key === 'POST /open') {
        const b = await readBody(req);
        let url = String(b.url || '');
        if (/^[A-Za-z]:[\\/]/.test(url)) url = 'file:///' + url.replace(/\\/g, '/');
        if (!/^(https?|file):\/\//i.test(url)) return json(res, 400, { error: 'http(s)/file urls or local paths only' });
        openInWorkChrome(url);
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /reveal') {
        const b = await readBody(req);
        let p = String(b.path || '');
        if (!p) return json(res, 400, { error: 'no path' });
        p = p.replace(/\//g, '\\');
        let isDir = false; try { isDir = existsSync(p) && statSync(p).isDirectory(); } catch { }
        const child = spawn('explorer.exe', isDir ? [p] : ['/select,' + p], { detached: true, stdio: 'ignore' });
        child.on('error', () => { });
        child.unref();
        record({ kind: 'sys', text: 'revealed: ' + p.slice(0, 90) });
        return json(res, 200, { ok: true });
    }
    if (key === 'GET /schedule') {
        const s = loadSchedule();
        const now = Date.now();
        const stale = s.date !== new Date().toDateString();
        const events = stale ? [] : (s.events || []);
        // Reminders live in the calendar too: keep upcoming ones plus any that fired within the
        // last hour, so a just-passed reminder lingers briefly instead of vanishing instantly.
        const reminders = (s.reminders || []).filter(r => r && r.start && Date.parse(r.start) > now - 3600000);
        // The NEXT banner promotes the soonest upcoming item, meeting OR reminder.
        const next = [...events, ...reminders].filter(e => Date.parse(e.start) > now)
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0] || null;
        const current = events.find(e => e.end && Date.parse(e.start) <= now && now < Date.parse(e.end)) || null;
        return json(res, 200, { events, reminders, next, current });
    }
    if (key === 'POST /schedule') {
        const b = await readBody(req);
        let s;
        if (Array.isArray(b.events)) {
            const events = b.events
                .filter(e => e && e.title && e.start && e.end)
                .map(e => ({
                    title: String(e.title).slice(0, 120),
                    start: e.start,
                    end: e.end,
                    ...(e.link ? { link: String(e.link) } : {}),
                    ...(e.join ? { join: String(e.join), joinKind: String(e.joinKind || 'meet') } : {}),
                }))
                .sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
            s = { date: new Date().toDateString(), events, announced: {} };
        } else {
            s = parseScheduleText(b.text || '');
        }
        // Reminders are independent of the (volatile, daily) meeting paste — carry them across.
        const prevSched = loadSchedule();
        s.reminders = Array.isArray(prevSched.reminders) ? prevSched.reminders : [];
        pruneReminders(s);
        if (!s.events.length) return json(res, 400, { error: 'no events parsed - expected title lines followed by H:MM AM-H:MM PM lines, or an events array' });
        saveSchedule(s);
        const upcoming = s.events.filter(e => Date.parse(e.start) > Date.now()).length;
        record({ kind: 'sys', text: 'schedule loaded: ' + s.events.length + ' events, ' + upcoming + ' upcoming' });
        enqueueSay('Schedule loaded. ' + upcoming + ' upcoming.', 'jarvis');
        return json(res, 200, { ok: true, events: s.events.length, upcoming });
    }
    if (key === 'POST /remind') {
        // Set a calendar reminder. Accepts {title,start} directly, or {text} to parse from
        // natural language ("remind me in 10 minutes to X", "remind me at 3pm to X").
        const b = await readBody(req);
        let title = b.title, start = b.start;
        if ((!title || !start) && b.text) {
            const p = parseReminder(b.text);
            if (!p) return json(res, 400, { error: 'could not find a time - try "remind me in 10 minutes to X" or "remind me at 3pm to X"' });
            title = p.title; start = p.start;
        }
        if (!start || isNaN(Date.parse(start))) return json(res, 400, { error: 'a valid start time (or parseable text) is required' });
        const r = createReminder(title, start);
        const mins = Math.max(1, Math.round((Date.parse(r.start) - Date.now()) / 60000));
        record({ kind: 'sys', text: 'reminder set: ' + r.title + ' @ ' + r.start });
        enqueueSay('Reminder set: ' + r.title + (mins < 60 ? ', in ' + mins + ' minute' + (mins === 1 ? '' : 's') : ', at ' + clk(r.start)) + '.', 'jarvis');
        return json(res, 200, { ok: true, reminder: r });
    }
    if (key === 'POST /hear') {
        const b = await readBody(req);
        if (b.text) handleUtterance(String(b.text), !!b.typed);
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /winddown') {
        // End-of-day: ask every live worker to checkpoint a /handoff and retire (no successor),
        // then stop the hub cleanly. {dry:true} returns the plan (live sessions + uncommitted git
        // work per cwd) WITHOUT doing anything, so the console can show a confirm first.
        const b = await readBody(req);
        const sessions = liveCallsigns().filter(cs => cs !== 'jarvis').map(cs => {
            const uid = liveUidOf(cs);
            const s = uid ? roster.sessions[uid] : null;
            if (!s || !aliveNow(uid)) return null;
            let dirty = null;
            if (s.cwd) {
                try { const o = execFileSync('git', ['-C', s.cwd, 'status', '--porcelain'], { encoding: 'utf8', timeout: 8000 }); dirty = o.trim() ? o.trim().split('\n').length : 0; }
                catch { dirty = 'unknown'; }
            }
            return { cs, uid, cwd: s.cwd || '', purpose: s.purpose || '', dirty };
        }).filter(Boolean);
        if (b.dry) return json(res, 200, { ok: true, dry: true, sessions });
        record({ kind: 'sys', text: 'WIND-DOWN initiated: ' + sessions.length + ' live session(s).' });
        for (const x of sessions) busAppend({ from: 'jarvis', to: x.uid, kind: 'retire-request', text: 'WIND-DOWN: post a /handoff then /retire with successor:false. Goodnight.' });
        json(res, 200, { ok: true, sessions, graceMs: WINDDOWN_GRACE_MS });
        setTimeout(() => {
            try {
                for (const x of sessions) if (aliveNow(x.uid)) retireSession(x.uid, 'Wound down for the night', { successor: false });
                try { writeFileSync(join(DATA, 'STOP'), new Date().toISOString()); } catch { } // tell the watchdog this is a real STOP, not a restart
                record({ kind: 'sys', text: 'WIND-DOWN complete; stopping hub. Goodnight.' });
                enqueueSay('Goodnight, Big Chris. Winding down for the night.', 'jarvis');
                running = false;
            } catch (e) { try { record({ kind: 'sys', text: 'wind-down error: ' + e.message }); } catch { } }
        }, WINDDOWN_GRACE_MS);
        return;
    }
    if (key === 'POST /restart') {
        record({ kind: 'sys', text: 'RESTART requested from console.' });
        enqueueSay('Restarting.', 'jarvis');
        try { unlinkSync(join(DATA, 'STOP')); } catch { } // ensure the watchdog relaunches, not stops
        json(res, 200, { ok: true });
        setTimeout(() => { running = false; }, 300);
        return;
    }
    // no-store: the console is redeployed by restarting the hub, so the browser must always
    // re-fetch fresh assets on reload — a cached console.js silently runs stale UI code.
    const NOCACHE = 'no-store, no-cache, must-revalidate';
    if (key === 'GET /console.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': NOCACHE }); return res.end(freshAsset('console.css', CONSOLE_CSS)); }
    if (key === 'GET /console.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': NOCACHE }); return res.end(freshAsset('console.js', CONSOLE_JS)); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': NOCACHE });
    res.end(freshAsset('console.html', CONSOLE_HTML));
}

async function main() {
    const server = createServer((req, res) => {
        handleRequest(req, res).catch(e => {
            try { json(res, 500, { error: e.message }); } catch { }
        });
    });
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));

    let consolePage = null;
    let context = null;
    if (!NO_UI) {
        const { chromium } = await import('playwright');
        context = await chromium.launchPersistentContext(USER_DATA, {
            channel: 'chrome', headless: false, viewport: null,
            args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--app=${ORIGIN}`],
        });
        await context.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'], { origin: ORIGIN }).catch(() => { });
        consolePage = context.pages()[0] || await context.newPage();
        if (!consolePage.url().startsWith(ORIGIN)) await consolePage.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
        await consolePage.exposeFunction('__jarvisHear', (text) => handleUtterance(text));
        consolePageRef = consolePage;
    }

    let speakingNow = false;
    const pump = () => {
        if (!sayQueue.length || speakingNow) return;
        speakingNow = true;
        const item = sayQueue.shift();
        record({ kind: 'tts', text: item.text, from: item.from });
        if (consolePage && (!muted || item.force) && !voiceMutedFrom(item.from)) {
            consolePage.evaluate(t => window.__speak(t), item.spoken || item.text)
                .catch(() => { })
                .finally(() => { speakingNow = false; });
        } else {
            setTimeout(() => { speakingNow = false; }, 50);
        }
    };

    record({ kind: 'sys', text: 'jarvis core started' + (NO_UI ? ' (no ui)' : '') });
    console.log('JARVIS CORE READY.');
    console.log(`  data dir   -> ${DATA}`);
    console.log(`  transcript -> ${TRANSCRIPT}`);
    console.log(`  console    -> ${ORIGIN}`);
    enqueueSay('Jarvis online.', 'jarvis');

    while (running) {
        if (!meetingMode) {
            const raw = drainWholeFile(SAY);
            if (raw.trim()) raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(l => enqueueSay(l, 'jarvis'));
        }
        pump();
        const cmds = drainWholeFile(CMD);
        if (cmds.split(/\r?\n/).some(l => l.trim() === 'stop')) running = false;
        await new Promise(r => setTimeout(r, 250));
    }

    const drainStart = Date.now();
    while ((speakingNow || sayQueue.length) && Date.now() - drainStart < 30000) {
        pump();
        await new Promise(r => setTimeout(r, 250));
    }
    for (const wt of pollWaiters.splice(0)) {
        clearTimeout(wt.timer);
        try { json(wt.res, 200, { cursor: busBase + bus.length, events: [] }); } catch { }
    }
    if (consolePage) await consolePage.evaluate(() => window.__shutdown()).catch(() => { });
    record({ kind: 'sys', text: 'jarvis core stopped' });
    if (context) await context.close();
    server.close();
    console.log('JARVIS CORE STOPPED.');
}
main().catch(e => { console.error(e.message); process.exit(1); });
