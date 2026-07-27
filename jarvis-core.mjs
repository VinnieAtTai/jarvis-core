import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { captureScreen } from './screen.mjs';
import * as stt from './stt.mjs';
import { scanUsage, totalsOf, blockStats, burnOf, heatOf } from './tokens.mjs';
import { fetchRealUsage } from './usage.mjs';
import { worktreeRoot, worktreeBase, worktreePlan, shouldIsolate, orphanWorktrees } from './jarvis-text.mjs';
import { clk, remTitle, parseReminder, parseScheduleText, WORK_VERSION, textOf, shortTitle, summarizeBoard, migrateWork, cwdKey, handoffKey, shouldSpawnSuccessor, boardHasWork, transferBoard, AI_MODELS, AI_DEFAULT_MODEL, aiCost, monthKey, rollSpend, capExceeded, normalizeProject, pushCapped, subworkerBrief, PROJECT_LOG_CAP, normalizeMission, missionProgress, isMissionCloseIntent, isMissionConfirm, isMissionCancel, parseNewMissionTitle, matchMissionByPhrase, permSig, permLabel, PERM_MULTIWORD, canon, orderedTasks, projectForMission, pickProjectWorker, lastProjectCwd, projectOwningCwd, matchRepo, repoRow, focusHolderUid, focusHeldByLiveOther, nextFocusKey, boardKeyFor, resolveBinding, coordinatorSlotHolder, wedgeState, parseBodyLenient } from './jarvis-text.mjs';

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
const MISSIONS = join(DATA, 'missions.json');        // persistent always-visible mission tracker
const PROJECTS_FILE = join(DATA, 'projects.json');   // persistent project-manager context store
const AI_THREADS = join(DATA, 'ai-threads.json');   // conversational-tab thread store
const AI_SPEND = join(DATA, 'ai-spend.json');        // conversational-tab monthly spend tracker
// Hard monthly spend cap for the /ai tab (USD). Configurable; default $20. A non-positive/garbage
// value means "no cap" (see capExceeded), so a clean default is enforced here.
const AI_CAP = (() => { const v = Number(process.env.JARVIS_AI_CAP); return v > 0 ? v : 20; })();
const ARCHIVE = join(DATA, 'archive');
const WORKER_DOC = join(HERE, 'WORKER.md');
const PORT = Number(process.env.JARVIS_PORT || 8124);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NO_UI = !!process.env.JARVIS_NO_UI;
const PROJECTS = process.env.JARVIS_PROJECTS || join(process.env.USERPROFILE || '', '.claude', 'projects');
const NATO = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
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

// Crash survival. The hub is a personal always-on voice copilot: a single unhandled rejection or
// throw in an event/timer/Playwright callback used to take the WHOLE process down (and every worker
// long-poll with it) silently, leaving no trace. We now log every such error to crash.log and STAY
// UP -- uptime beats purity here, and the realistic offenders (closed Playwright page, malformed
// request body, a TTS eval, an fs race) don't corrupt on-disk state. The watchdog still relaunches
// on a hard exit; this just stops the soft, recoverable errors from ever getting that far.
const CRASHLOG = join(DATA, 'crash.log');
function logCrash(kind, err) {
    try {
        const stamp = new Date().toISOString();
        const detail = (err && err.stack) || (err && err.message) || String(err);
        appendFileSync(CRASHLOG, `[${stamp}] ${kind}: ${detail}\n`);
        console.error(`[${stamp}] ${kind}:`, err);
    } catch { }
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (err) => logCrash('unhandledRejection', err));

// Signal resilience. The hub kept "crashing" not from a JS fault but from a stray console
// interrupt (Ctrl+C / Ctrl+Break) reaching the watchdog window and killing node. An always-on
// copilot must not die to an accidental keypress or a parent shell being reaped. Ignore the
// interrupt signals and keep running -- intentional shutdown still goes through the console
// WIND DOWN button (STOP sentinel) and the commands.txt 'stop' path, never Ctrl+C.
for (const sig of ['SIGINT', 'SIGBREAK', 'SIGHUP']) {
    try { process.on(sig, () => logCrash('ignored-signal', new Error(sig + ' received; staying up (use WIND DOWN / commands stop to shut down)'))); } catch { }
}

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
let discard = false, meetingMode = false, running = true;
let screenGrant = 0;
let muted = false, autoMutedBy = null, consolePageRef = null;
function setMute(on, by) {
    muted = !!on;
    autoMutedBy = muted ? (by || null) : null;
    record({ kind: 'sys', text: muted ? 'muted' + (by ? ' (auto: ' + by + ')' : '') : 'unmuted' });
    if (consolePageRef) consolePageRef.evaluate(m => window.__setMute(m), muted).catch(() => { });
}
// Selectable speech-to-text backend. 'google' = the browser's webkitSpeechRecognition (cloud,
// the default). 'local' = mic audio is captured in the console, POSTed to /stt, and transcribed
// by a local whisper.cpp server spawned on demand (see stt.mjs) — fully offline, audio never
// leaves the machine. It is a privacy/offline toggle, not a replacement; Google stays default.
let sttBackend = 'google';
function setSttBackend(b) {
    const next = b === 'local' ? 'local' : 'google';
    if (next === sttBackend) return;
    sttBackend = next;
    record({ kind: 'sys', text: 'STT backend: ' + sttBackend });
    if (consolePageRef) consolePageRef.evaluate(v => window.__setSttBackend(v), sttBackend).catch(() => { });
    if (sttBackend === 'local') stt.ensureReady().catch(e => record({ kind: 'sys', text: 'STT local not ready: ' + e.message }));
    else stt.stop();
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
                enqueueSay('Heads up: ' + e.title + ' in ' + Math.max(1, Math.round((st - now) / 60000)) + ' minutes. Want a meeting worker for it?', 'jarvis');
                record({ kind: 'chat', from: 'jarvis', text: 'Meeting in ~5 min: "' + e.title + '". Spin up a meeting worker from the + tab → Meeting (it pre-selects this one), or skip.' });
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
const AWAY_DEFAULT_HOURS = 4;
// Away mode: trust every live worker (auto-approve non-danger) so the board keeps moving while
// Chris is gone — the danger floor in POST /permission still gates destructive actions regardless.
// Persisted on the roster so it survives a hub restart mid-absence. setAway(false) reverts all
// workers to guarded; new workers that register during the window are trusted in registerSession.
function setAway(on, hours) {
    const until = on ? Date.now() + (Number(hours) > 0 ? Number(hours) : AWAY_DEFAULT_HOURS) * 3600000 : 0;
    roster.awayUntil = until;
    for (const uid in roster.sessions) {
        if (!roster.sessions[uid].ended) roster.sessions[uid].trustUntil = until;
    }
    saveRoster();
    return until;
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
function loadWork() {
    let raw = null;
    if (existsSync(WORKLIST)) {
        try { raw = JSON.parse(readFileSync(WORKLIST, 'utf8')); }
        catch { backupCorrupt(WORKLIST); raw = null; }   // don't silently zero the only copy
    }
    const { w, changed } = migrateWork(raw, makeTask, newTaskId);
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
    if (existsSync(REPOS)) {
        try { return JSON.parse(readFileSync(REPOS, 'utf8')) || {}; }
        catch { backupCorrupt(REPOS); }   // preserve the only copy, don't silently reset
    }
    return {};
}
// cwdKey (stable key for a job's working directory: separator/case/trailing-slash insensitive)
// and handoffKey (cwd + purpose, so unrelated jobs sharing one cwd don't clobber each other's
// handoff) are imported from jarvis-text.mjs. Durable handoff records are stored under handoffKey
// so a successor on the same JOB — not merely the same cwd — finds them.
// Resolve a registered repo by cwd, falling back to an ad-hoc repo (same logic /spawn used).
// The match is cwdKey-based, and that is load-bearing rather than cosmetic: repos.json is written
// by hand/console with forward slashes (d:/claude/jarvis-core) while a session's cwd is the Windows
// path it actually booted in (d:\claude\jarvis-core). A case-only comparison missed every backslash
// caller — so a spawned worker in a CONFIGURED repo silently fell through to `adhoc`, losing
// repo.permissionMode and repo.tier. Concretely: Chris configured jarvis as bypassPermissions and
// still got woken to approve routine commits, because the successor spawn path passes s.cwd
// (backslashes) and the lookup missed. d:\code\tms never matched the broker repo either.
function resolveRepo(cwd) {
    return matchRepo(loadRepos(), cwd) || { key: 'adhoc', cwd };
}
function loadSchedule() {
    if (existsSync(SCHEDULE)) {
        try { return JSON.parse(readFileSync(SCHEDULE, 'utf8')) || { events: [], announced: {} }; }
        catch { backupCorrupt(SCHEDULE); }   // a corrupt paste would otherwise lose the day's meetings + reminders
    }
    return { events: [], announced: {} };
}
function saveSchedule(s) {
    atomicWrite(SCHEDULE, JSON.stringify(s, null, 1));
}
// —— Missions: a small, durable set of long-running objectives Chris wants ALWAYS visible in a
// pinned console rail. Unlike board tasks (per-session, transient), a mission survives restarts
// AND worker retire (it lives in hub state, not a session), tracks a phase checklist + progress +
// doc links, and is CLOSED ONLY via the voice gate ("mission accomplished" -> "are you sure" ->
// "yes"), which ARCHIVES it (status:'archived') — never a hard delete. The first mission is
// seeded once below so the rail is alive the instant the feature deploys.
let missionSeq = 0;
function newMissionId() {
    return 'm_' + Date.now().toString(36) + (missionSeq++).toString(36) + Math.random().toString(36).slice(2, 4);
}
function makeMission(title, phases, docs) {
    // Pure shaping lives in jarvis-text.mjs (normalizeMission); the hub stamps the one non-pure
    // field — a fresh creation timestamp — here.
    const m = normalizeMission({ title, phases, docs }, newMissionId());
    m.createdAt = new Date().toISOString();
    return m;
}
// One-time seed: Chris's first mission (his ask 2026-06-29). Only used when missions.json is absent.
function seedMissions() {
    return {
        version: 1, missions: [makeMission('PrimeNG 17 → 18 upgrade', [
            'Audit PrimeNG 17 usage + 18 breaking changes',
            'Bump dependency + theming / styled-mode migration',
            'Fix component API changes (p-fileUpload, dropdowns, dialogs)',
            'Visual QA pass across modals + forms',
            'Merge to beta2 + verify',
        ], [])],
    };
}
function loadMissions() {
    if (existsSync(MISSIONS)) {
        try {
            const m = JSON.parse(readFileSync(MISSIONS, 'utf8'));
            if (m && Array.isArray(m.missions)) return m;
        } catch { backupCorrupt(MISSIONS); }   // preserve + alert, don't silently reset
    }
    const seeded = seedMissions();
    try { saveMissions(seeded); } catch { }
    return seeded;
}
function saveMissions(m) {
    atomicWrite(MISSIONS, JSON.stringify(m, null, 1));
}
// missionProgress is pure (imported from jarvis-text.mjs).
// Active missions, decorated with derived progress, for the console rail.
function activeMissionsView() {
    return (loadMissions().missions || [])
        .filter(x => x.status === 'active')
        .map(mn => ({ ...mn, progress: missionProgress(mn) }));
}
// —— Projects: the durable operational container behind a project worker (e.g. 'jarvis'). A
// mission is the OBJECTIVE (PrimeNG 17→18 + phases); a board column is TRANSIENT tasks; a project
// holds the REBUILDABLE CONTEXT a manager rehydrates on boot instead of starting cold — a curated
// summary + current focus + open threads + an append-only log of recent work (incl. retired
// sub-worker outcomes) + doc links. Model B (Chris, 2026-07-09): the DATA is durable and "manager"
// is a role any session assumes by reading GET /project on register. Lives in DATA (outside the
// repo), atomic writes, backup-on-corrupt — same robustness contract as missions.
function makeProject(name, title, missionId) {
    const n = String(name == null ? '' : name).toLowerCase().trim();
    const now = new Date().toISOString();
    return {
        name: n,
        title: String(title == null ? n : title).trim() || n,
        status: 'active',
        missionId: missionId ? String(missionId) : null,
        managerUid: null,
        context: { summary: '', currentFocus: '', openThreads: [], recentLog: [], docs: [] },
        workers: [],
        createdAt: now,
        updatedAt: now,
    };
}
// First-run seed (used only when projects.json is absent): elevate the existing 'jarvis' project
// and stand up 'primeng' linked to its existing mission (Chris's dogfood pick for P1).
function seedProjects() {
    let primengMission = null;
    try { primengMission = (loadMissions().missions || []).find(m => /primeng/i.test(m.title || '')); } catch { }
    return {
        version: 1,
        projects: [
            makeProject('jarvis', 'JARVIS core', null),
            makeProject('primeng', 'PrimeNG 17 → 18', primengMission ? primengMission.id : null),
            makeProject('waterfall', 'Waterfall Tendering PS-23', null),
        ],
    };
}
function loadProjects() {
    if (existsSync(PROJECTS_FILE)) {
        try {
            const p = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
            if (p && Array.isArray(p.projects)) { p.projects = p.projects.map(normalizeProject).filter(Boolean); return p; }
        } catch { backupCorrupt(PROJECTS_FILE); }   // preserve + alert, don't silently reset
    }
    const seeded = seedProjects();
    try { saveProjects(seeded); } catch { }
    return seeded;
}
function saveProjects(p) {
    atomicWrite(PROJECTS_FILE, JSON.stringify(p, null, 1));
}
function getProject(name) {
    const n = String(name || '').toLowerCase().trim();
    if (!n) return null;
    return (loadProjects().projects || []).find(p => p.name === n) || null;
}
// Ensure a project row exists (auto-create the first time a worker registers with that .project).
// Returns the (possibly newly created) project.
function ensureProject(name, title) {
    const n = String(name || '').toLowerCase().trim();
    if (!n) return null;
    const store = loadProjects();
    let p = store.projects.find(x => x.name === n);
    if (!p) { p = makeProject(n, title || n, null); store.projects.push(p); saveProjects(store); }
    return p;
}
// Append one entry to a project's rebuildable log (append-only, capped) so the next manager can
// "rebuild the context from what we've been working on recently". Returns false if no such project.
function appendProjectLog(name, from, note) {
    const n = String(name || '').toLowerCase().trim();
    const store = loadProjects();
    const p = store.projects.find(x => x.name === n);
    if (!p) return false;
    p.context.recentLog = pushCapped(p.context.recentLog, { ts: new Date().toISOString(), from: String(from || ''), note: String(note || '') }, PROJECT_LOG_CAP);
    p.updatedAt = new Date().toISOString();
    saveProjects(store);
    return true;
}
// Bind/unbind the manager session on a project (set on register, cleared/reassigned on retire).
//
// `expectUid` makes the write CONDITIONAL on the slot still holding that uid — compare-and-set. Retire
// uses it to release its own claim without stomping somebody else's: a ghost coordinator being retired
// while a fresh one has already registered would otherwise null the LIVE one's managerUid, leaving the
// project with a coordinator nothing records as its manager. Omit it for an unconditional claim.
function setProjectManager(name, uid, expectUid) {
    const n = String(name || '').toLowerCase().trim();
    const store = loadProjects();
    const p = store.projects.find(x => x.name === n);
    if (!p) return false;
    if (expectUid && p.managerUid && p.managerUid !== expectUid) return false;
    p.managerUid = uid || null;
    p.updatedAt = new Date().toISOString();
    saveProjects(store);
    return true;
}
// Merge curated context fields from a manager checkpoint (only fields actually present are
// touched); an optional `log` string/entry is appended to the recent-work log. Returns the
// updated project, or null if unknown.
function updateProjectContext(name, patch) {
    const n = String(name || '').toLowerCase().trim();
    const store = loadProjects();
    const p = store.projects.find(x => x.name === n);
    if (!p) return null;
    const c = p.context;
    if (patch.summary != null) c.summary = String(patch.summary);
    if (patch.currentFocus != null) c.currentFocus = String(patch.currentFocus);
    if (Array.isArray(patch.openThreads)) c.openThreads = patch.openThreads.map(String).map(s => s.trim()).filter(Boolean);
    if (Array.isArray(patch.docs)) c.docs = patch.docs.map(d => (d && typeof d === 'object') ? { label: String(d.label == null ? (d.url || '') : d.label), url: String(d.url == null ? '' : d.url) } : { label: String(d), url: String(d) });
    if (patch.status && ['active', 'paused', 'archived'].includes(patch.status)) p.status = patch.status;
    if (patch.missionId != null) p.missionId = patch.missionId ? String(patch.missionId) : null;
    const logNote = (patch.log && typeof patch.log === 'object') ? patch.log.note : patch.log;
    if (logNote != null && String(logNote).trim()) {
        c.recentLog = pushCapped(c.recentLog, { ts: new Date().toISOString(), from: String((patch.log && patch.log.from) || patch.from || ''), note: String(logNote) }, PROJECT_LOG_CAP);
    }
    p.updatedAt = new Date().toISOString();
    saveProjects(store);
    return p;
}
// Compact per-project view for the console (name/title/status/focus + recent-log tail + mission link).
function projectsView() {
    return (loadProjects().projects || []).map(p => ({
        name: p.name, title: p.title, status: p.status, missionId: p.missionId,
        managerUid: p.managerUid, updatedAt: p.updatedAt,
        summary: p.context.summary, currentFocus: p.context.currentFocus,
        openThreads: p.context.openThreads, docs: p.context.docs,
        recentLog: (p.context.recentLog || []).slice(-8),
        workerCount: (p.workers || []).length,
    }));
}
// Compact context view from a project object (pure — no I/O), so the /board hot path can build it
// from a single loadProjects() instead of re-reading the file per card.
function compactProjectContext(p) {
    if (!p) return null;
    return {
        name: p.name, title: p.title, status: p.status, missionId: p.missionId,
        summary: p.context.summary, currentFocus: p.context.currentFocus,
        openThreads: p.context.openThreads, docs: p.context.docs,
        recentLog: (p.context.recentLog || []).slice(-8),
    };
}
function projectContextFor(name) {
    return compactProjectContext(getProject(name));
}
// —— Reminders: ad-hoc timed to-dos that live in the calendar next to meetings. Unlike the
// meeting list (volatile, re-pasted daily, date-gated), a reminder carries an absolute time,
// survives a schedule re-paste, and announces ONCE when due. The pure parsers (clk, remTitle,
// parseReminder) and parseScheduleText live in ./jarvis-text.mjs; the stateful helpers stay here.
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

// —— Conversational ASK tab (/ai/*). A model-backed chat that talks to the Anthropic API
// directly (not the speech bus / a Claude Code seat). Pure cost/cap/month math lives in
// jarvis-text.mjs (AI_MODELS, aiCost, monthKey, rollSpend, capExceeded); the stateful store I/O
// and the Anthropic fetch (both side-effecting) stay here. The key is read from a gitignored
// repo-root file and NEVER logged, committed, or sent to the client.
function loadThreads() {
    let raw = null;
    if (existsSync(AI_THREADS)) {
        try { raw = JSON.parse(readFileSync(AI_THREADS, 'utf8')); }
        catch { backupCorrupt(AI_THREADS); raw = null; }   // preserve the only copy, don't zero it
    }
    if (!raw || typeof raw !== 'object' || !raw.threads || typeof raw.threads !== 'object') return { threads: {} };
    return raw;
}
function saveThreads(t) { atomicWrite(AI_THREADS, JSON.stringify(t, null, 1)); }
// Always returned rolled to the current month: rollSpend zeroes usd when the stored month differs,
// so a stale file reads as $0 spent for the new month without a separate reset step.
function loadSpend() {
    let raw = null;
    if (existsSync(AI_SPEND)) {
        try { raw = JSON.parse(readFileSync(AI_SPEND, 'utf8')); }
        catch { backupCorrupt(AI_SPEND); raw = null; }
    }
    return rollSpend(raw, monthKey());
}
function saveSpend(s) { atomicWrite(AI_SPEND, JSON.stringify(s, null, 1)); }
let threadSeq = 0;
function newThreadId() { return 'th_' + Date.now().toString(36) + (threadSeq++).toString(36) + Math.random().toString(36).slice(2, 5); }
// The API key: gitignored repo-root anthropic-key.txt first (Chris pastes it there), then env.
// Read fresh each call so a newly-pasted key is picked up without a restart. Never logged.
function anthropicKey() {
    try { const k = readFileSync(join(HERE, 'anthropic-key.txt'), 'utf8').trim(); if (k) return k; } catch { }
    return process.env.ANTHROPIC_API_KEY || '';
}
// Short JARVIS persona for the tab — deliberately NOT the worker system prompt; this is a direct
// chat with no tools. Kept terse so it stays cheap on every turn.
const AI_SYSTEM = "You are JARVIS, Chris's terse, capable AI copilot, answering inside his command console. This is a direct chat — you have no tools and cannot run code or read files here. Lead with the conclusion, then only the reasoning that earns its place. Be concrete and brief; spell things out only when it genuinely helps. The console renders Markdown — use it: bold key terms, bullet lists, tables, and fenced code blocks so replies stay scannable. If you don't know or can't tell from the conversation, say so plainly.";
// One non-streaming Anthropic call. Opus gets adaptive thinking + effort (per CONVERSATIONAL-TAB.md
// and the claude-api skill); Sonnet/Haiku go plain (effort/adaptive 400s on Haiku). Returns the
// joined text blocks (thinking blocks come back empty-text by default and are skipped) + usage.
async function callAnthropic(model, messages) {
    const key = anthropicKey();
    if (!key) { const e = new Error('no Anthropic API key'); e.code = 'NO_KEY'; throw e; }
    const isOpus = model === 'claude-opus-4-8';
    const body = { model, max_tokens: isOpus ? 8192 : 2048, system: AI_SYSTEM, messages };
    if (isOpus) { body.thinking = { type: 'adaptive' }; body.output_config = { effort: 'high' }; }
    let r, data;
    try {
        r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(body),
        });
        data = await r.json().catch(() => ({}));
    } catch (e) { const err = new Error('network: ' + e.message); err.code = 'NET'; throw err; }
    if (!r.ok) {
        const msg = (data && data.error && data.error.message) || ('HTTP ' + r.status);
        const e = new Error(msg); e.code = 'API'; e.status = r.status; throw e;
    }
    const text = Array.isArray(data.content)
        ? data.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('').trim()
        : '';
    const u = data.usage || {};
    return { text, inTok: u.input_tokens || 0, outTok: u.output_tokens || 0, stop: data.stop_reason };
}

const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const IDX_FILLER = new Set(['item', 'number', 'no', 'task', 'the', 'on', 'to']);
function liveUidOf(cs) {
    const l = roster.callsigns[cs];
    if (!l || !l.length) return null;
    const s = roster.sessions[l[0]];
    return s && !s.ended ? l[0] : null;
}
// The board a callsign's work belongs on -- the project column for a bound coordinator, else the
// callsign. Use this ANY time a callsign is about to reach ensureBoard or w.focus; passing the raw
// callsign is what minted a second board for one session (see boardKeyFor). Note it is NOT a
// substitute for the callsign when looking a SESSION up: roster lookups still need the NATO name.
const boardKey = cs => boardKeyFor(cs, roster.sessions, roster.callsigns);
// A project (e.g. 'jarvis') is a durable board card that can host ONE live worker. The worker
// is a normal session (own uid + NATO callsign for the perm-hook) but carries .project, which
// binds its board + routing to the project card instead of giving it its own separate card.
function projectWorkerUid(name) {
    return pickProjectWorker(roster.sessions, name);
}
function liveCallsigns() {
    return NATO.filter(cs => liveUidOf(cs));
}
// Live sessions as BOARD CANDIDATES -- {callsign, project} -- for focus repair. A project-bound
// worker must be offered as its project (the thing with a card), never as its raw NATO callsign,
// or focusing it mints a phantom standalone card. Feeds the pure nextFocusKey.
function liveBoardCandidates() {
    return liveCallsigns()
        .filter(cs => aliveNow(liveUidOf(cs)))
        .map(cs => ({ callsign: cs, project: (roster.sessions[liveUidOf(cs)] || {}).project || null }));
}
function aliveNow(uid) {
    const s = roster.sessions[uid];
    return !!(s && s.lastSeen && Date.now() - Date.parse(s.lastSeen) < 120000);
}
// A watcher session (e.g. the jarvis worker running the #jarvis QA loop) re-pings POST /watch
// on each ~120s tick. The console's green "watching" light is lit ONLY while those pings are
// fresh AND the session is live — so it greys the instant the watcher stops ticking or goes
// quiet, rather than lying green off a stale flag (lastSeen alone can't tell watching from a
// session that's merely alive but doing other work). TTL is ~2.5x the tick so a single missed
// ping doesn't flicker it. Returns the watched channel label, or null when not watching.
const WATCH_TTL = 5 * 60 * 1000;
function watchingNow(uid) {
    const s = roster.sessions[uid];
    if (!s || !s.watching || !s.watching.ts) return null;
    if (!aliveNow(uid)) return null;
    if (Date.now() - Date.parse(s.watching.ts) > WATCH_TTL) return null;
    return s.watching.channel || '#jarvis';
}
function csFrom(word) {
    if (!word) return null;
    const n = word.toLowerCase().replace(/[^a-z]/g, '');
    if (n === 'jarvis') return 'jarvis';
    return liveUidOf(n) ? n : null;
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
// What the SPAWNER bound a callsign to, held until that worker registers. The boot prompt already
// tells it to echo project/parentProject back, but workers drop the field -- and a dropped field
// silently mints an orphan standalone card instead of nesting under the project, which is the
// recurring board fragmentation Chris keeps hitting. Stashing the intent here makes nesting
// deterministic instead of dependent on the worker following instructions. Mirrors pendingTier.
//
// TTL-swept, and deliberately the SAME window as the pendingPins reservation: once a pin expires
// the callsign can be handed to an unrelated session, so a bind that outlived its pin must never
// still be sitting there waiting to attach itself to that stranger.
const pendingBind = new Map();
const BIND_TTL = 300000;
function takePendingBind(cs) {
    const now = Date.now();
    for (const [k, v] of pendingBind) if (now - v.ts > BIND_TTL) pendingBind.delete(k);
    const b = pendingBind.get(cs);
    pendingBind.delete(cs);
    return b || null;
}
// Does this project already have a coordinator -- one live, or one spawned and still booting? Wraps
// the pure predicate with the two things it cannot know: the roster, and the pending-bind stash.
// EVERY site that is about to spawn a coordinator asks this first; a project gets exactly one.
// (Same wrapper shape as boardKey / wedgedNow: the decision is pure and unit-tested, the state is here.)
const coordinatorHeld = name => coordinatorSlotHolder(roster.sessions, pendingBind, name, Date.now());
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
if (existsSync(join(DATA, 'notify.json'))) {
    try { NOTIFY = JSON.parse(readFileSync(join(DATA, 'notify.json'), 'utf8')); }
    catch { backupCorrupt(join(DATA, 'notify.json')); }   // keep the env-default, preserve the corrupt file
}
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
    trimBus(); // bound bus + bus.jsonl at runtime, mirroring record()->trimTranscript()
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
// How many bused events this session has NOT picked up, measured from the cursor it last polled
// with. Zero for a session that has never polled — we cannot claim it is ignoring anything until
// it tells us where it is. Feeds the `pending` count on a wedge flag: a deaf worker with 0 pending
// is a curiosity, a deaf worker with the human's words queued behind it is an outage.
function pendingFor(uid) {
    const s = roster.sessions[uid];
    if (!s || !Number.isFinite(s.pollCursor)) return 0;
    let n = 0;
    for (let i = Math.max(0, s.pollCursor - busBase); i < bus.length; i++) {
        const e = bus[i];
        if (e.to === uid || e.to === 'all') n++;
    }
    return n;
}
// Is this session green-but-deaf? Wraps the pure detector with the two things it cannot know:
// which session we mean, and what is queued behind it.
function wedgedNow(uid) {
    const s = roster.sessions[uid];
    return s ? wedgeState(s, Date.now(), { pending: pendingFor(uid) }) : null;
}
function registerSession(cwd, purpose, pin, project, parentProject) {
    const cs = assignCallsign(pin);
    pendingPins.delete(cs);
    // An ISOLATED worker registers with the cwd it booted in — its worktree — which is a path no
    // configured repo matches. Left alone that quietly breaks four things that all key off cwd:
    // the trust tier and permissionMode resolved just below, the per-job handoff key, auto-bind's
    // repo-identity match, and resolveRepo on the successor spawn. So the session records the REPO
    // as its cwd (what it is working on) and carries the worktree beside it (where it is working).
    const wt = takePendingWorktree(cs);
    if (wt && wt.repoCwd) cwd = wt.repoCwd;
    let tier = pendingTier.get(cs); pendingTier.delete(cs);
    if (!tier) { try { tier = resolveRepo(cwd).tier; } catch { } }
    tier = tier === 'trusted' ? 'trusted' : 'guarded';
    const uid = 's_' + String(roster.nextUid++).padStart(4, '0');
    const now = new Date().toISOString();
    // Fall back to the binding the spawner stashed for this callsign when the worker did not echo it
    // back — an omitted field used to mean an orphan standalone card. What the worker sends still wins.
    // A SUB-WORKER carries .parentProject (its ephemeral card nests under the project) — kept DISTINCT
    // from .project so pickProjectWorker (which matches .project only) can never resolve it as the
    // coordinator. A session is one or the other, never both: a .project coordinator ignores parentProject.
    let { project: proj, parentProject: pproj } = resolveBinding(project, parentProject, takePendingBind(cs));
    // #39 AUTO-BIND ON REGISTER: the backstop for everything resolveBinding cannot see. The stash
    // above carries the hub's INTENT when the hub did the spawning; when there is no intent to
    // stash — a session Chris started by hand in a repo, or the auto-successor of a standalone —
    // infer the binding from repo IDENTITY so the session still lands on the project's card instead
    // of minting an orphan column beside the mission. Explicit flags (or the stash) always win: this
    // only fires when both are absent. Coordinator if the project has no live one, else nested as a
    // sub-worker — the same live test routeToMission uses, so binding and routing never disagree.
    let autoBound = '';
    if (!proj && !pproj && cwd) {
        try {
            const owner = projectOwningCwd(loadProjects(), roster.sessions, cwd);
            if (owner) {
                const mgr = projectWorkerUid(owner.name);          // the new session is not in the roster yet, so this cannot self-match
                if (mgr && aliveNow(mgr)) { pproj = owner.name; autoBound = 'sub-worker'; }
                else { proj = owner.name; autoBound = 'coordinator'; }
                if (owner.ambiguous > 1) record({ kind: 'sys', text: 'auto-bind: ' + owner.ambiguous + ' active missions claim ' + cwdKey(cwd) + '; picked ' + owner.name + ' (most recent)' });
            }
        } catch { }   // an unreadable project store must never block a register
    }
    roster.callsigns[cs] = [uid, ...(roster.callsigns[cs] || [])];
    roster.sessions[uid] = { callsign: cs, cwd: cwd || '', purpose: purpose || cs, started: now, ended: null, lastSeen: now, tier, ...(proj ? { project: proj } : {}), ...(pproj ? { parentProject: pproj } : {}), ...(wt ? { worktree: wt.path, branch: wt.branch, base: wt.base } : {}) };
    if (wt) record({ kind: 'sys', text: cs + ' is isolated on ' + wt.branch + ' (worktree ' + wt.path + ', repo ' + cwdKey(cwd) + ')' });
    if (roster.awayUntil && Date.now() < roster.awayUntil) roster.sessions[uid].trustUntil = roster.awayUntil;
    saveRoster();
    const w = loadWork();
    // A project worker binds to the project's durable card/column and gets NO separate card.
    ensureBoard(w, proj || cs);
    // ...and to the project's durable CONTEXT store: ensure the row exists and claim the manager
    // role. The boot prompt tells it to rehydrate from GET /project; we also hand the context back
    // in the register response so it resumes from minute one without a second round-trip.
    if (proj) { try { ensureProject(proj, purpose); setProjectManager(proj, uid); } catch { } }
    let focusedNote = '';
    // Don't STEAL focus from the human's live conversation with a DIFFERENT worker. A project
    // worker (successor or fresh) binds to its column regardless, but must not yank the human's
    // voice onto itself while a different live session already holds focus — e.g. a coordinator
    // mid-walkthrough. Grab focus only when it's idle: on 'jarvis', a dead/stale target, or this
    // very session. (The human can always say a callsign to switch back.) Decision is a pure,
    // unit-tested helper in jarvis-text.mjs (test/focus.test.mjs).
    const focusHeldByOther = focusHeldByLiveOther(w.focus, roster.sessions, roster.callsigns, uid, Date.now());
    // Note the shape: a project worker either takes its PROJECT card or takes nothing. It must never
    // fall through to the solo-worker branch below, which would focus its raw NATO callsign — that
    // both mints a phantom standalone card and defeats the guard we just applied.
    if (proj) {
        if (!focusHeldByOther) { w.focus = proj; focusedNote = ' Focused on ' + proj + '.'; }
    } else if (liveCallsigns().length === 1) { w.focus = cs; focusedNote = ' Focused on it.'; }
    saveWork(w);
    const reborn = roster.callsigns[cs].length > 1;
    if (proj) {
        record({ kind: 'sys', text: 'registered ' + uid + ' as ' + proj + ' worker (' + cs + '): ' + (purpose || '') });
        enqueueSay(proj + ' worker is up: ' + (purpose || 'the punchlist') + '.' + focusedNote, 'jarvis');
    } else {
        record({ kind: 'sys', text: 'registered ' + uid + ' as ' + cs + ': ' + (purpose || '') });
        enqueueSay((reborn ? cs + ' is now ' : 'New session. ' + cs + ' is ') + (purpose || 'unnamed work') + '.' + focusedNote, 'jarvis');
    }
    // Say so when a binding was INFERRED rather than asked for: it is the difference between "the
    // board looks odd" and "the board looks odd because the repo captured this session", which is
    // exactly the diagnosis that cost several sessions before.
    if (autoBound) record({ kind: 'sys', text: 'auto-bound ' + cs + ' to ' + (proj || pproj) + ' as ' + autoBound + ' (inferred from cwd ' + cwdKey(cwd) + ')' });
    const out = { uid, callsign: cs };
    // Tell a fresh session if a predecessor on this SAME JOB (cwd + purpose) left a handoff —
    // covers the manual "kill the terminal and start over" path that never goes through
    // spawnWorker. Scoping by purpose stops a new worker inheriting a different job's notes when
    // several jobs share one cwd. The hint carries the purpose so the follow-up GET resolves.
    roster.handoffs = roster.handoffs || {};
    const h = cwd ? roster.handoffs[handoffKey(cwd, purpose)] : null;
    if (h) out.handoff = { summary: h.summary, from: h.from, ts: h.ts, hint: 'GET /handoff?cwd=' + encodeURIComponent(cwd) + '&purpose=' + encodeURIComponent(purpose || '') + ' for full notes, then resume.' };
    if (proj) { try { out.project = projectContextFor(proj); } catch { } }   // rehydrate on register (model B)
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
    // A console-less worker runs in a ConPTY the hub owns; with no window to close, its idle
    // claude process would otherwise linger as a hub child forever after retire. Kill it here so
    // retiring actually reclaims the process. A successor (if any) is a separate pty under a new
    // callsign, so this never touches the replacement. Falls through harmlessly for wt-tab workers
    // (not in the map). onExit prunes the map; the delete is belt-and-suspenders.
    try { const wp = workerPtys.get(cs); if (wp) { wp.kill(); workerPtys.delete(cs); } } catch { }
    // Worktree teardown, AFTER the pty is dead so nothing is still writing into the tree: commit any
    // in-flight WIP to the worker's branch, drop the directory, keep the branch (it is the
    // deliverable). The successor spawned below inherits that branch and continues on it.
    teardownWorktree(s, cs);
    const w = loadWork();
    const board = w.sessions[cs] || { working: [], queued: [], done: [], review: [] };
    // The handoff record: one-line summary + detailed notes + the FULL board snapshot (all lanes).
    const rec = {
        summary: s.summary || null,
        notes: s.handoff || '',
        board: { working: board.working || [], queued: board.queued || [], review: board.review || [], done: board.done || [] },
        from: cs, fromUid: uid, cwd: s.cwd, purpose: s.purpose,
        ts: s.ended,
    };
    roster.handoffs = roster.handoffs || {};
    if (s.cwd) roster.handoffs[handoffKey(s.cwd, s.purpose)] = rec;
    writeFileSync(join(ARCHIVE, uid + '.json'), JSON.stringify({
        uid, callsign: cs, cwd: s.cwd, purpose: s.purpose,
        started: s.started, ended: s.ended, summary: s.summary || null,
        handoff: s.handoff || null, board,
    }, null, 1));

    // A retiring SUB-WORKER feeds its outcome back to its parent project's durable log (gap G3) so the
    // coordinator and the next worker rebuild the mission story from finished work with zero bookkeeping.
    // parentProject/project are mutually exclusive (registerSession enforces it), so this fires only for
    // a sub-worker; the project-coordinator path below keeps its own "manager retired" append.
    if (s.parentProject && !s.project && s.summary) {
        try { appendProjectLog(s.parentProject, cs, 'sub-worker retired: ' + s.summary); } catch { }
    }

    if (s.project) {
        // Project worker: the durable project column stays put; just spawn the successor
        // (which re-attaches to the project on register). No NATO column to delete/transfer.
        //
        // ...unless somebody ALREADY holds the coordinator slot. This path used to spawn
        // unconditionally, which is how retiring a GHOST primeng coordinator at 15:05:26 on 2026-07-27
        // minted whiskey while victor — auto-revived 43s earlier by a mission message — was already
        // coordinating the same project. `s.ended` is stamped at the top of this function, so the
        // predicate can never see the retiring session itself as the holder.
        let psucc = null;
        const held = opts.successor && s.cwd && s.purpose ? coordinatorHeld(s.project) : null;
        if (opts.successor && s.cwd && s.purpose && !held) {
            try { psucc = spawnWorker(resolveRepo(s.cwd), s.purpose, opts.model, rec, undefined, s.project, undefined, undefined, s.branch); } catch { psucc = null; }
        } else if (held) {
            const who = held.callsign || held.uid;
            record({ kind: 'sys', text: 'no successor for ' + s.project + ': ' + who + ' is already ' + (held.kind === 'live' ? 'coordinating it' : 'booting as its coordinator') + '; the project card keeps the unfinished work' });
            // Point the incumbent at the handoff we just filed. Without this those notes are silently
            // orphaned: roster.handoffs is keyed by handoffKey(cwd, purpose), and an auto-revived
            // coordinator's purpose is the project TITLE, so it can never match the predecessor's key
            // and the register-time handoff hint never fires for it. Only a LIVE holder can be sent
            // anything — a booting one has not registered, and it reads the project log on boot anyway.
            if (held.kind === 'live' && (rec.summary || rec.notes)) {
                busAppend({ from: 'jarvis', to: held.uid, kind: 'msg', text: cs + ' retired off ' + s.project + ' and you already hold the coordinator slot, so no successor was spawned. Its handoff: GET /handoff?cwd=' + encodeURIComponent(s.cwd || '') + '&purpose=' + encodeURIComponent(s.purpose || '') + (rec.summary ? ' -- summary: ' + rec.summary : '') });
            }
        }
        // Feed the retiring manager's summary into the durable project log so the successor
        // rebuilds context from recent work, and release the manager slot — the successor re-claims
        // it when it registers (it hasn't yet; spawnWorker only launches the ConPTY). The release is
        // CONDITIONAL on the slot still pointing at us: a ghost being retired while a fresh
        // coordinator has already registered would otherwise blank the LIVE one's claim, which is the
        // same one-slot-two-coordinators bug seen from the other end.
        try {
            if (s.summary) appendProjectLog(s.project, cs, 'manager retired: ' + s.summary);
            setProjectManager(s.project, null, uid);
        } catch { }
        saveWork(w);
        saveRoster();
        record({ kind: 'sys', text: cs + ' (' + s.project + ' worker) retired (' + uid + ')' + (psucc ? ' -> successor ' + psucc : '') });
        enqueueSay(psucc ? s.project + ' worker handed off.' : (held ? s.project + ' worker retired; ' + (held.callsign || 'another session') + ' still has it.' : s.project + ' worker retired; the card is idle.'), 'jarvis');
        busAppend({ from: 'jarvis', to: uid, kind: 'retired', text: 'retired' });
        return true;
    }

    let succCs = null;
    if (opts.successor && s.cwd && s.purpose) {
        // Carry .parentProject into the successor so a SUB-WORKER that hands off with work remaining
        // stays nested under its project and re-seeded with the mission STORY — mirroring how the
        // coordinator path threads s.project. undefined for a plain worker, so its successor is a plain
        // worker exactly as before.
        // s.branch carries the predecessor's isolation branch (undefined for a shared-cwd worker): the
        // successor CONTINUES it in a fresh worktree. Forking from base instead would leave every
        // commit the predecessor just made — including the WIP we committed above — on a branch
        // nobody is working on, which is the same "work quietly stranded" failure the WIP commit
        // exists to prevent.
        try { succCs = spawnWorker(resolveRepo(s.cwd), s.purpose, opts.model, rec, undefined, undefined, undefined, s.parentProject, s.branch); }
        catch { succCs = null; }
    }
    if (succCs) {
        delete w.sessions[cs];
        const nb = ensureBoard(w, succCs);
        // The FULL board travels: working+queued become the successor's queue (front), and the
        // review + done lanes carry over intact so nothing the human still needs to see is lost.
        // transferBoard owns the merge + the (moved/total) accounting (pure, unit-tested).
        const t = transferBoard(board, nb);
        w.sessions[succCs] = t.board;
        if (w.focus === cs) w.focus = succCs;             // focus follows the work
        saveWork(w);
        saveRoster();
        const moved = t.moved;
        record({ kind: 'sys', text: cs + ' retired (' + uid + ') -> successor ' + succCs + '; board transferred (' + moved + '/' + t.total + ' tasks)' });
        if (t.dropped) enqueueSay('Warning: handoff to ' + succCs + ' may have dropped tasks. Check the board.', 'jarvis');
        enqueueSay(cs + ' handed off to ' + succCs + '.' + (rec.summary ? ' ' + rec.summary : ''), 'jarvis');
        busAppend({ from: 'jarvis', to: uid, kind: 'retired', text: 'retired' });
        return true;
    }
    delete w.sessions[cs];
    if (w.focus === cs) w.focus = nextFocusKey(liveBoardCandidates(), cs);   // never strand focus on a dead board
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
    // Talking to a PROJECT by name (the focus can be a project — /focus accepts one). If that project
    // drives a mission, funnel through the mission path: routeToMission ALWAYS reaches a live brain
    // (busing to a live coordinator, or auto-reviving a dead/ghost one) AND persists to the durable
    // mission thread the coordinator reads on boot — so addressing a project by name behaves exactly
    // like the mission tab instead of busing to a corpse and nagging forever (the same dead-coordinator
    // hole T2 fixed for routeToMission; routeTo recorded to:cs, which a revived coordinator reading
    // mission-chat would never see). A live NATO callsign (never a project name, so liveUidOf is truthy)
    // skips this and keeps the normal direct-bus + gone-quiet nag. No-mission projects — including the
    // 'jarvis' project, which doubles as the solo-brain fallthrough where routeTo MUST return false so
    // the driver sees the speech — keep the exact prior behaviour.
    if (!liveUidOf(cs)) {
        const proj = getProject(cs);
        if (proj && proj.missionId) return routeToMission(proj.missionId, msg);
    }
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
            const other = nextFocusKey(liveBoardCandidates(), cs);
            const hint = other !== 'jarvis' ? ' Say focus on ' + other + ' to switch.' : '';
            enqueueSay(cs + ' has not checked in for ' + mins + ' minute' + (mins === 1 ? '' : 's') + '. Queueing for it.' + hint, 'jarvis');
        }
    } else {
        // Alive by lastSeen, but is anyone actually LISTENING? A wedged session accepts the message
        // into its queue and never reads it, which reads as being ignored -- the human keeps talking
        // to a corpse with no idea anything is wrong. Say it out loud, on the same 5-min nag throttle
        // as gone-quiet, because this is the moment it matters: they just spoke.
        const wedge = wedgedNow(uid);
        if (wedge && Date.now() - (nagAt[cs] || 0) > 300000) {
            nagAt[cs] = Date.now();
            enqueueSay(cs + ' looks wedged. Its heartbeat is fine but it has not checked its inbox in '
                + wedge.minutes + ' minute' + (wedge.minutes === 1 ? '' : 's') + ', so it may not hear that. Restart it from the console if it stays quiet.', 'jarvis');
        } else if (!wedge) {
            delete nagAt[cs];
        }
    }
    return true;
}
// Route a message to a MISSION rather than a single session. The mission conversation is the
// durable, mission-keyed thread Chris talks into: it is always persisted (tagged with missionId)
// so it survives sub-workers retiring and respawning, whether or not a coordinator is live right
// now. If the mission's linked project has a live manager, the message is also bused to it so the
// coordinator can act + dispatch to its sub-workers. Returns false only for an unknown mission.
function routeToMission(missionId, text) {
    const mm = loadMissions();
    const mn = (mm.missions || []).find(x => x.id === missionId);
    if (!mn) return false;
    record({ kind: 'speech', text, to: 'm:' + missionId, missionId, mission: mn.title });
    const proj = projectForMission(loadProjects().projects || [], missionId);
    const uid = proj ? projectWorkerUid(proj.name) : null;
    if (uid && aliveNow(uid)) {
        // Live coordinator: hand it the message so it can act + dispatch to its sub-workers.
        busAppend({ from: 'human', to: uid, kind: 'speech', text, missionId }, SPEECH_DEBOUNCE);
        if (roster.sessions[uid] && roster.sessions[uid].needsYou) {
            roster.sessions[uid].needsYou = false;
            saveRoster();
        }
        return true;
    }
    // No LIVE coordinator: either none is bound, or the only match is a dead/ghost session whose
    // lastSeen is stale (the invisible-coordinator bug — routeToMission used to bus straight to that
    // corpse and the message vanished). The message is already record()-ed to the durable mission
    // thread above, so T2 auto-revives a coordinator: it rehydrates GET /project + reads the mission
    // thread on boot, picking up this very message with no human re-brief.
    if (proj) reviveMissionCoordinator(proj);
    return true;
}
// T2 auto-revive. Bring up a fresh coordinator for a mission's project whose coordinator is dead or
// missing, so talking to a mission ALWAYS reaches a live brain — without ever making a SECOND one.
//
// This used to guard on its own `missionCoordinatorSpawns` map plus a 90s cooldown. Both are gone on
// purpose, not by accident: that map only ever knew about the spawns THIS path had made, so it was
// blind to the other site that spawns coordinators (the retire auto-successor), and on 2026-07-27 the
// two raced primeng into victor + whiskey 43s apart. coordinatorHeld reads pendingBind instead, which
// spawnWorker writes for EVERY spawn whatever the call site — the property the revive-only map could
// never have. The cooldown is subsumed too: registerSession stamps lastSeen at register, so the LIVE
// half of the predicate takes over from the BOOTING half with no gap between them to cover.
function reviveMissionCoordinator(proj) {
    const held = coordinatorHeld(proj.name);
    if (held) return null;                                  // one is already live or on the way — don't swarm
    const cwd = lastProjectCwd(roster.sessions, proj.name);
    if (!cwd) {
        // Never had a worker, so we cannot infer the repo; the message is safely queued on the durable
        // mission thread and the next manually-spawned coordinator picks it up on boot.
        record({ kind: 'sys', text: 'mission ' + proj.name + ': no live coordinator and no known repo to revive one' });
        return null;
    }
    let cs = null;
    try { cs = spawnWorker(resolveRepo(cwd), proj.title || proj.name, undefined, null, undefined, proj.name); }
    catch { cs = null; }
    if (cs) {
        // No bookkeeping to do here: spawnWorker already put this callsign in pendingBind bound to
        // proj.name, which IS the "a coordinator is booting" record every spawn site now reads.
        record({ kind: 'sys', text: 'auto-revived ' + proj.name + ' coordinator (' + cs + ') for an incoming mission message' });
        enqueueSay('Reviving the ' + proj.name + ' coordinator.', 'jarvis');
    }
    return cs;
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
// —— Per-worker git worktree isolation (docs/WORKTREE-ISOLATION-DESIGN.md, P1) ————————————————————
// Chris, 2026-07-24: "how do we make it so jarvis can work on multiple items in the same repository
// so it doesn't f*** up with what I'm working on ... something with worktrees." Until now every
// worker launched with cwd = repo.cwd — the same working tree Chris has open — so two workers, or a
// worker and Chris, edited the SAME files. A code-mutating sub-worker now gets its own worktree on
// its own `jarvis/<callsign>` branch, forked from the COMMITTED head of the integration branch, so
// it can neither see nor clobber his uncommitted work.
//
// Everything below is BEST-EFFORT and must never throw: it runs inside spawnWorker and
// retireSession, the machinery that keeps every session alive, including the coordinator's. A
// non-git cwd, a detached HEAD, an existing branch, a full disk — each logs and falls back to the
// shared cwd, which is exactly the behaviour that shipped before this. The decidable parts (naming,
// collisions, base resolution, who isolates, what is sweepable) are pure helpers in jarvis-text.mjs
// with unit tests in test/worktree.test.mjs; only the git calls live here.
const WT_ROOT_ENV = process.env.JARVIS_WT_ROOT || '';
const WT_ISOLATE = process.env.JARVIS_WORKTREES !== '0';     // kill switch: back to shared cwds
const WT_TIMEOUT = 30000;                                    // a checkout of a big repo is not instant
// git, with stderr captured rather than sprayed into the hub's log, and never throwing: null means
// the command failed, '' means it succeeded silently (the two must stay distinguishable — a
// successful `worktree remove` prints nothing).
function gitOut(cwd, args, timeout = 10000) {
    try { return String(execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })).trim(); }
    catch { return null; }
}
function wtDirs(root) {
    try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(root, d.name)); }
    catch { return []; }
}
// The pending worktree for a callsign the hub just spawned, held until that worker registers —
// mirroring pendingPins/pendingTier/pendingBind, TTL-swept on the same 5-minute window. The worker
// registers with the cwd it BOOTED in (the worktree), which resolves to no configured repo; this is
// how registerSession learns the repo it really belongs to.
const pendingWorktree = new Map();
function takePendingWorktree(cs) {
    const now = Date.now();
    for (const [k, v] of pendingWorktree) if (now - v.ts > 300000) pendingWorktree.delete(k);
    const v = pendingWorktree.get(cs);
    pendingWorktree.delete(cs);
    return v || null;
}
// Create this worker's worktree. Returns the plan (path/branch/base) or null to share the cwd.
function makeWorktree(repo, cs, inheritBranch) {
    try {
        if (!repo || !repo.cwd || !existsSync(repo.cwd)) return null;
        const head = gitOut(repo.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (head === null) {
            record({ kind: 'sys', text: 'no worktree for ' + cs + ': ' + cwdKey(repo.cwd) + ' is not a git repo; sharing the cwd' });
            return null;
        }
        const originHead = gitOut(repo.cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
        const base = worktreeBase(head, repo.base, (originHead || '').replace(/^origin\//, ''));
        if (!base) {
            record({ kind: 'sys', text: 'no worktree for ' + cs + ': detached HEAD in ' + cwdKey(repo.cwd) + ' and no base configured; sharing the cwd' });
            return null;
        }
        const taken = (gitOut(repo.cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/jarvis/']) || '').split('\n').filter(Boolean);
        const root = worktreeRoot(repo.cwd, WT_ROOT_ENV);
        const plan = worktreePlan(repo.key, cs, repo.cwd, base, { root: WT_ROOT_ENV, taken, paths: wtDirs(root), inherit: inheritBranch });
        if (!plan) { record({ kind: 'sys', text: 'no worktree for ' + cs + ': could not name one under ' + root + '; sharing the cwd' }); return null; }
        mkdirSync(plan.root, { recursive: true });
        // create:false is the successor case — check the predecessor's branch out again rather than
        // forking a new one from base, which would strand every commit it made.
        const args = plan.create
            ? ['worktree', 'add', '-b', plan.branch, plan.path, plan.base]
            : ['worktree', 'add', plan.path, plan.branch];
        if (gitOut(repo.cwd, args, WT_TIMEOUT) === null || !existsSync(plan.path)) {
            record({ kind: 'sys', text: 'worktree add FAILED for ' + cs + ' (' + plan.branch + '); sharing ' + cwdKey(repo.cwd) });
            return null;
        }
        record({ kind: 'sys', text: 'worktree for ' + cs + ': ' + plan.branch + (plan.create ? ' off ' + plan.base : ' (continued)') + ' at ' + plan.path });
        return plan;
    } catch (e) {
        try { record({ kind: 'sys', text: 'worktree setup errored for ' + cs + ' (' + (e && e.message) + '); sharing the cwd' }); } catch { }
        return null;
    }
}
// Tear a worktree down: commit in-flight WIP to the branch, remove the directory, KEEP the branch.
//
// The commit is not optional and it is never a stash (the tms-merge-dance rule: commit in-flight
// work, never stash it). The branch is the deliverable, awaiting merge. And if the commit does not
// take — no git identity, a rejecting pre-commit hook — we LEAVE THE WORKTREE WHERE IT IS: a
// stranded directory is recoverable by hand, a removed one with uncommitted work is gone forever.
function teardownWorktree(s, cs) {
    if (!s || !s.worktree) return null;
    const wtPath = s.worktree, repoCwd = s.cwd || '', branch = s.branch || '?';
    try {
        if (existsSync(wtPath)) {
            const dirty = gitOut(wtPath, ['status', '--porcelain'], WT_TIMEOUT);
            if (dirty) {
                gitOut(wtPath, ['add', '-A'], WT_TIMEOUT);
                gitOut(wtPath, ['commit', '-m', 'WIP (' + cs + '): ' + (s.summary || s.purpose || 'in-flight work at retire')], WT_TIMEOUT);
                if (gitOut(wtPath, ['status', '--porcelain'], WT_TIMEOUT)) {
                    record({ kind: 'sys', text: 'worktree for ' + cs + ' has UNCOMMITTED work that would not commit; KEPT at ' + wtPath + ' on ' + branch });
                    return 'kept';
                }
                record({ kind: 'sys', text: 'committed ' + cs + ' WIP to ' + branch });
            }
        }
        if (!repoCwd) { record({ kind: 'sys', text: 'worktree for ' + cs + ' has no home repo to remove it from; KEPT at ' + wtPath }); return 'kept'; }
        const removed = gitOut(repoCwd, ['worktree', 'remove', wtPath, '--force'], WT_TIMEOUT) !== null;
        gitOut(repoCwd, ['worktree', 'prune'], WT_TIMEOUT);
        record({ kind: 'sys', text: removed
            ? 'worktree for ' + cs + ' removed; branch ' + branch + ' kept for merge'
            : 'worktree remove FAILED for ' + cs + ' at ' + wtPath + '; branch ' + branch + ' kept' });
        return removed ? 'removed' : 'kept';
    } catch (e) {
        try { record({ kind: 'sys', text: 'worktree teardown errored for ' + cs + ' (' + (e && e.message) + '); ' + wtPath + ' left in place' }); } catch { }
        return 'kept';
    }
}
// Boot sweep. Console-less workers are hub children, so a restart kills every one of them and leaves
// its worktree on disk with no session to ever clean it up. Collect those: prune each repo's stale
// administrative entries, then tear down any directory under a WT_ROOT that no live session claims
// (WIP committed to its branch first — the sweep loses nothing).
function sweepWorktrees() {
    if (!WT_ISOLATE) return;
    try {
        const repos = loadRepos();
        const roots = new Map();
        for (const k of Object.keys(repos)) {
            const r = repos[k];
            if (!r || !r.cwd || !existsSync(r.cwd)) continue;
            gitOut(r.cwd, ['worktree', 'prune'], WT_TIMEOUT);
            const root = worktreeRoot(r.cwd, WT_ROOT_ENV);
            if (root && existsSync(root)) roots.set(cwdKey(root), root);
        }
        const dirs = [];
        for (const root of roots.values()) dirs.push(...wtDirs(root));
        const orphans = orphanWorktrees(dirs, roster.sessions, Date.now());
        for (const p of orphans) {
            // A worktree's .git is a FILE pointing at the parent repo. No .git at all means this is
            // some other directory that wandered into WT_ROOT — never touch it.
            if (!existsSync(join(p, '.git'))) continue;
            const owner = Object.values(roster.sessions).find(x => x && x.worktree && cwdKey(x.worktree) === cwdKey(p));
            const common = gitOut(p, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
            const repoCwd = (owner && owner.cwd) || (common ? dirname(common.replace(/\\/g, '/').replace(/\/+$/, '')) : '');
            teardownWorktree({ worktree: p, cwd: repoCwd, branch: (owner && owner.branch) || gitOut(p, ['rev-parse', '--abbrev-ref', 'HEAD']) || '?', purpose: 'orphaned by a hub restart' },
                (owner && owner.callsign) || 'a dead session');
        }
        if (orphans.length) record({ kind: 'sys', text: 'boot sweep: collected ' + orphans.length + ' orphaned worktree' + (orphans.length === 1 ? '' : 's') });
    } catch { }   // a sweep failure must never block the hub coming up
}
// Console-less worker spawning. A worker's only channel to Chris is this hub (board/chat/perm
// cards over HTTP), so its terminal window is pure crash-exposure: combining DOS/console windows
// tears that console down and kills the worker. node-pty runs claude inside an invisible ConPTY
// the hub owns (a real pseudo-TTY, so claude runs its normal persistent interactive session) with
// NO window for a combine to reach. Default ON; set JARVIS_CONSOLELESS=0 to fall back to wt tabs.
// Tradeoff: a ConPTY worker is a child of the hub, so it dies if the hub does (wt workers don't) —
// acceptable now that the hub itself is console-less and crash-surviving.
const CONSOLELESS = process.env.JARVIS_CONSOLELESS !== '0';
const requireCjs = createRequire(import.meta.url);
const workerPtys = new Map();
let ptyMod = null, ptyTried = false;
function getPty() {
    if (!ptyTried) { ptyTried = true; try { ptyMod = requireCjs('node-pty'); } catch { ptyMod = null; } }
    return ptyMod;
}
function spawnWorkerConsoleless(cs, repo, boot, model, hookSettings) {
    const pty = getPty();
    if (!pty) return false;
    const args = [];
    if (repo.permissionMode) args.push('--permission-mode', repo.permissionMode);
    const md = model || repo.model;
    if (md) args.push('--model', md);
    if (hookSettings) args.push('--settings', hookSettings);
    args.push(boot);
    const log = join(DATA, 'worker-' + cs + '.log');
    try { writeFileSync(log, ''); } catch { }
    const proc = pty.spawn(resolveClaude(), args, {
        name: 'xterm-color', cols: 140, rows: 40, cwd: repo.cwd,
        env: { ...process.env, JARVIS_CALLSIGN: cs, JARVIS_PORT: String(PORT) },
    });
    proc.onData((d) => { try { appendFileSync(log, d); } catch { } });
    proc.onExit(() => { workerPtys.delete(cs); });
    workerPtys.set(cs, proc);
    return true;
}
function spawnWorker(repo, purpose, model, handoff, tier, project, meeting, parentProject, inheritBranch) {
    const cs = assignCallsign();
    pendingPins.set(cs, Date.now());
    const effTier = (tier || repo.tier) === 'trusted' ? 'trusted' : null;
    if (effTier) pendingTier.set(cs, effTier);
    // wt.exe treats ';' as a command separator even inside argv (--title) — a purpose like
    // "...catalog; resuming" chops the wt command in half (0x80070002) and strands a pinned
    // phantom callsign. Strip it alongside the other shell/wt specials.
    const safePurpose = purpose.replace(/["'^&<>|%;]/g, '');
    const tabTitle = cs + ' - ' + safePurpose;
    // A sub-worker registers with parentProject (never project) so it nests under the project without
    // ever resolving as its coordinator; a worker is one role or the other, never both.
    const subOf = (!project && parentProject) ? String(parentProject).toLowerCase().trim() : null;
    // Record the binding we are about to ASK for, so registerSession can apply it even if the worker
    // never echoes it back. The boot prompt below is a request; this is the guarantee.
    const boundTo = project ? String(project).toLowerCase().trim() : null;
    if (boundTo || subOf) pendingBind.set(cs, { project: boundTo, parentProject: subOf, ts: Date.now() });
    // ISOLATION: a code-mutating sub-worker gets its own worktree + branch and launches THERE, so it
    // never shares a working tree with Chris or with another worker. Best-effort — wt stays null on
    // any git failure and the worker launches in repo.cwd exactly as it always did.
    const wt = (WT_ISOLATE && shouldIsolate({ project: boundTo, parentProject: subOf, meeting, purpose, isolate: repo && repo.isolate }))
        ? makeWorktree(repo, cs, inheritBranch) : null;
    if (wt) pendingWorktree.set(cs, { path: wt.path, branch: wt.branch, base: wt.base, repoCwd: repo.cwd, repoKey: repo.key, ts: Date.now() });
    const runRepo = wt ? { ...repo, cwd: wt.path } : repo;
    let boot = 'You are a JARVIS worker session. Fetch http://127.0.0.1:' + PORT + '/protocol with a plain GET request and follow it exactly. Register with pin: ' + cs + ' and purpose: ' + safePurpose + (project ? ' and project: ' + project : '') + (subOf ? ' and parentProject: ' + subOf : '') + '.';
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
    if (project) boot += ' You are the ' + project + ' PROJECT worker: your task board IS the ' + project + ' column - use callsign "' + project + '" for every /worklist op (add/start/done/etc), not your own callsign, and speech the human points at ' + project + ' arrives on your poll loop. When you must hand off, /retire with successor:true so a fresh ' + project + ' worker takes over.'
        + ' You are also this project\'s persistent MANAGER: the project owns a durable context store. The moment you register, GET http://127.0.0.1:' + PORT + '/project?name=' + project + ' to rehydrate that context (summary, current focus, open threads, recent-work log, doc links) and RESUME from it - do not start cold. As the project moves, keep it current so the next manager rebuilds from recent work: POST http://127.0.0.1:' + PORT + '/project-context {"name":"' + project + '","summary":"...","currentFocus":"...","openThreads":[...],"log":"one line of what just happened"} (send only the fields that changed; log entries are append-only and capped).';
    // If this project drives a mission, the human talks to the MISSION (not to you by callsign), so a
    // message can land on the durable mission thread while no coordinator is live — the very message
    // that auto-revived you. Tell the coordinator to catch up on that thread the instant it registers;
    // from then on live mission messages arrive on its poll loop.
    if (project) {
        let mlink = null;
        try { const pr = getProject(project); if (pr && pr.missionId) { const ms = (loadMissions().missions || []).find(x => x.id === pr.missionId); if (ms) mlink = { id: pr.missionId, title: ms.title }; } } catch { }
        if (mlink) boot += ' This project drives the mission "' + mlink.title + '". The human talks to the MISSION, not to you by callsign, so the moment you register GET http://127.0.0.1:' + PORT + '/mission-chat?missionId=' + mlink.id + ' to read the ongoing mission conversation and treat its most recent messages - including any that arrived while no coordinator was live - as your live prompt: reply there with /say and /send and dispatch sub-workers as needed. New mission messages arrive on your poll loop from then on.';
    }
    // A SUB-WORKER inherits the parent project's STORY (Chris: "workers get their context from the
    // mission") — mission + project context seeded read-only into the boot prompt so it starts with the
    // history, not a cold start — while its TASK stays its own. It is NOT the coordinator: it uses its
    // own callsign, never touches the project column or rehydrates the store, and its retire summary is
    // what feeds back up (auto-appended to the project log).
    if (subOf) {
        let pr = null, ms = null;
        try { pr = getProject(subOf); if (pr && pr.missionId) ms = (loadMissions().missions || []).find(x => x.id === pr.missionId) || null; } catch { }
        const brief = subworkerBrief(pr, ms);
        boot += ' You are a SUB-WORKER under ' + (brief || ('the ' + subOf + ' project.'))
            + ' That is your STORY/context so you carry the history without rebuilding it; your TASK is only what is described above. You are NOT the ' + subOf + ' coordinator: use your OWN callsign for every /worklist op, do not touch the ' + subOf + ' board column, and do not rehydrate or POST project context. When your task is done, /retire with a crisp one-line summary — it auto-appends to the ' + subOf + ' project log so the coordinator and the next worker rebuild from your outcome.';
    }
    if (meeting && meeting.title) {
        boot += ' You are a MEETING worker for "' + meeting.title + '"' + (meeting.start && meeting.end ? ' (' + meeting.start + ' to ' + meeting.end + ')' : '') + '. Assist Chris live during this call: capture decisions and action items, draft Jira items when he asks, and pull up references.';
        if (meeting.join) boot += ' Meet link: ' + meeting.join + '.';
        if (meeting.link) boot += ' Calendar event: ' + meeting.link + '.';
        boot += ' You have Google Calendar, Google Drive, and Jira MCP tools - use them. Look this event up in Google Calendar by its title and today\'s date to get the attendees, agenda/description, and any attached notes doc; if a notes doc is attached, READ it now for context. Draft Jira items only when Chris asks. Interaction is typing-first: keep spoken /say lines to short headlines and put notes, action items, drafts, and lists in chat via /send to human. When the meeting ends, post a concise summary - decisions, action items, and any drafted Jira items - and /retire with that as your handoff.';
    }
    // Tell it where it is. Without this a worker sees an unfamiliar path, assumes something is wrong,
    // and "helpfully" switches branches or goes looking for the real checkout.
    if (wt) boot += ' You are in a DEDICATED git worktree at ' + wt.path + ' on branch ' + wt.branch + ' (forked from ' + wt.base + '). Commit freely here: you cannot see or touch other worktrees or Chris\'s own checkout, so nothing you do can collide with his work. Do NOT switch branches and do not go looking for the main checkout. On retire, commit everything - your branch is how your work merges back.';
    boot += ' Permissions: read-only and routine build commands (git status/diff/log, npm run lint, node --check, ls/cat/grep/rg, dotnet build/test) run WITHOUT asking the human; only risky or out-of-repo actions prompt. Favor those pre-approved commands, batch shell calls, and self-verify (run the lint gate yourself) instead of asking. If you fan out subagents, keep them to the same safe command set so they do not each trigger a prompt.' + (effTier ? ' You are a TRUSTED session: your non-risky actions are auto-approved — work autonomously and only surface genuine decisions.' : '');
    const hookSettings = repo.permissionMode === 'bypassPermissions' ? null : join(DATA, 'perm-settings.json');
    if (CONSOLELESS && spawnWorkerConsoleless(cs, runRepo, boot, model, hookSettings)) {
        record({ kind: 'sys', text: 'spawned ' + cs + ' in ' + runRepo.cwd + ' (' + repo.key + ')' + (wt ? ' [worktree ' + wt.branch + ']' : '') + ' [console-less]' });
        return cs;
    }
    const pm = repo.permissionMode ? ' --permission-mode ' + repo.permissionMode : '';
    const md = model || repo.model;
    const mm = md ? ' --model ' + md : '';
    const scriptPath = join(DATA, 'spawn-' + cs + '.cmd');
    const hookFlag = hookSettings ? ' --settings "' + hookSettings + '"' : '';
    writeFileSync(scriptPath, [
        '@echo off',
        'title ' + tabTitle,
        'set JARVIS_CALLSIGN=' + cs,
        'set JARVIS_PORT=' + PORT,
        'cd /d "' + runRepo.cwd + '"',
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
            // ...and give back the worktree we cut for a worker that will never boot, so the next
            // spawn on this callsign gets its own name back instead of a suffix.
            const dead = takePendingWorktree(cs);
            if (dead) teardownWorktree({ worktree: dead.path, cwd: dead.repoCwd, branch: dead.branch, purpose: 'terminal launch failed' }, cs);
            try { unlinkSync(scriptPath); } catch { }
        });
        c2.unref();
    });
    child.unref();
    record({ kind: 'sys', text: 'spawned ' + cs + ' in ' + runRepo.cwd + ' (' + repo.key + ')' + (wt ? ' [worktree ' + wt.branch + ']' : '') });
    return cs;
}
// Two-step close gate for a mission: "mission accomplished" arms this, the follow-up "yes"
// archives it. Held in memory with a 60s window so a stray "yes" much later can't trip it.
let pendingMissionClose = null;
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

    // —— Mission tracker voice control. Closing a mission is a deliberate two-step gate so a
    // stray "mission accomplished" can't wipe a long-running objective; creating one is a single
    // phrase. ——
    if (pendingMissionClose && Date.now() < pendingMissionClose.until) {
        if (isMissionConfirm(lower)) {
            const mm = loadMissions();
            const mn = (mm.missions || []).find(x => x.id === pendingMissionClose.id && x.status === 'active');
            const title = pendingMissionClose.title; pendingMissionClose = null;
            if (mn) {
                mn.status = 'archived'; mn.archivedAt = new Date().toISOString(); saveMissions(mm);
                record({ kind: 'sys', text: 'mission accomplished + archived: ' + title });
                enqueueSay('Mission accomplished: ' + title + '. Archived. Well done, Big Chris.', 'jarvis');
            } else enqueueSay('That mission is already closed.', 'jarvis');
            return;
        }
        if (isMissionCancel(lower)) {
            const title = pendingMissionClose.title; pendingMissionClose = null;
            record({ kind: 'sys', text: 'mission close cancelled: ' + title });
            enqueueSay('Okay, leaving it open.', 'jarvis');
            return;
        }
        pendingMissionClose = null;   // anything else: drop the gate, don't trap unrelated speech
    }
    if (isMissionCloseIntent(lower)) {
        const act = (loadMissions().missions || []).filter(x => x.status === 'active');
        if (!act.length) { enqueueSay('There are no active missions.', 'jarvis'); return; }
        const target = matchMissionByPhrase(act, lower);
        if (!target) { enqueueSay('Which mission? You have ' + act.length + ' active. Name it, then say mission accomplished.', 'jarvis'); return; }
        pendingMissionClose = { id: target.id, title: target.title, until: Date.now() + 60000 };
        record({ kind: 'sys', text: 'mission close requested: ' + target.title });
        enqueueSay('Are you sure you want to mark ' + target.title + ' accomplished? Say yes to confirm.', 'jarvis');
        return;
    }
    {
        const nmTitle = parseNewMissionTitle(text);
        if (nmTitle !== null) {
            if (nmTitle) {
                const mm = loadMissions();
                const created = makeMission(nmTitle, [], []);
                mm.missions.push(created); saveMissions(mm);
                record({ kind: 'sys', text: 'mission created: ' + created.title });
                enqueueSay('New mission: ' + created.title + '. Pinned to the rail.', 'jarvis');
            } else enqueueSay('What should the mission be called?', 'jarvis');
            return;
        }
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
            // "focus on juliet" has to land on the primeng CARD, not mint a juliet board. The spoken
            // reply still names the worker and reads its purpose off the NATO callsign -- boardKey is
            // for the board, never for a roster lookup.
            const fk = boardKey(cs);
            w.focus = fk;
            if (fk !== 'jarvis') ensureBoard(w, fk);
            saveWork(w);
            record({ kind: 'sys', text: 'focus: ' + fk + (fk !== cs ? ' (' + cs + ' is its worker)' : '') });
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
    if (/\b(stepping away|step away|going away|away mode on|enable away mode|i'?m heading out)\b/.test(lower)) {
        const until = setAway(true);
        enqueueSay('Away mode on. Workers will keep going on their own and only stop for destructive actions. Say I am back when you return.', 'jarvis');
        record({ kind: 'sys', text: 'AWAY MODE on until ' + new Date(until).toISOString() });
        return;
    }
    if (/\b(i'?m back|i am back|away mode off|disable away mode|back at (my |the )?(desk|keyboard))\b/.test(lower)) {
        setAway(false);
        enqueueSay('Welcome back. Away mode off, I will ask again on non-routine actions.', 'jarvis');
        record({ kind: 'sys', text: 'AWAY MODE off' });
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
            .map(([cs, b]) => { const s = summarizeBoard(b); return s ? cs + '. ' + s : ''; })
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
        const spoken = summarizeBoard(ensureBoard(w, w.focus));
        const prefix = w.focus === 'jarvis' ? '' : 'On ' + w.focus + '. ';
        enqueueSay(spoken ? prefix + spoken : prefix + 'The list is empty.', 'jarvis');
        return;
    }
    // "on mission <id-or-title>, <text>" — the human is talking TO a mission (typed from a mission
    // tab or the send-to dropdown). Resolve to the mission thread + its coordinator and never drop,
    // even with no live worker. Must precede the generic "on <word>" parse below ("mission" is not
    // a callsign, so it would otherwise fall through).
    if ((m = canon(text).match(/^on\s+mission\s+(\S+?)[\s,.!]+(.+)$/i))) {
        const token = m[1].replace(/^m:/i, '');
        const body = m[2].trim();
        const all = loadMissions().missions || [];
        const mn = all.find(x => x.id === token) || matchMissionByPhrase(all.filter(x => x.status === 'active'), (token + ' ' + body).toLowerCase());
        if (mn) { routeToMission(mn.id, body); return; }
        enqueueSay('I do not have a mission matching ' + m[1] + '.', 'jarvis');
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
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}
function readBody(req) {
    return new Promise((resolve) => {
        // Collect raw Buffers and decode ONCE at the end. `data += chunk` decodes each chunk
        // independently, so a multibyte UTF-8 char split across a chunk boundary would corrupt
        // into U+FFFD (the tofu bug); Buffer.concat then toString('utf8') decodes the whole body.
        const chunks = [];
        let len = 0;
        req.on('data', c => { chunks.push(c); len += c.length; if (len > 30e6) req.destroy(); });
        req.on('end', () => resolve(parseBodyLenient(Buffer.concat(chunks).toString('utf8'))));
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
        const projById = {}; for (const p of (loadProjects().projects || [])) projById[p.name] = p;   // one read per /board, not per card
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
                // Green but DEAF: heartbeat ticking, poll loop dead. `alive` above cannot see this
                // (both endpoints feed it), so the card needs its own signal or the session lies
                // green through the whole outage. { minutes, pending } or null.
                wedged: (uid && cs !== 'jarvis') ? wedgedNow(uid) : null,
                context: uid && roster.sessions[uid].ctx !== undefined ? roster.sessions[uid].ctx : null,
                doing: uid ? roster.sessions[uid].doing || '' : '',
                watching: uid ? watchingNow(uid) : null,
                needsYou: uid ? !!roster.sessions[uid].needsYou : false,
                voiceMuted: uid ? !!roster.sessions[uid].voiceMuted : false,
                pendingPerm: pends[0] ? { id: pends[0].id, tool: pends[0].tool, detail: pends[0].detail, klass: pends[0].klass || 'neutral', label: permLabel(pends[0].tool, pends[0].detail) } : null,
                pendingPermCount: pends.length,
                // Durable project context for a project card (jarvis, primeng, ...); null for a
                // plain NATO worker card. Lets the console show what the project stands on.
                projectContext: compactProjectContext(projById[cs] || null),
                // The project a SUB-WORKER is nested under (its .parentProject), so the console can
                // group its card beneath that project/mission; null for coordinators + plain workers.
                parentProject: (uid && roster.sessions[uid] && roster.sessions[uid].parentProject) || null,
                working: b.working, queued: b.queued, done: b.done, review: b.review || [],
            };
        });
        return json(res, 200, { focus: w.focus, muted, paused: discard, sttBackend, sttReady: stt.isReady(), boards, awayUntil: roster.awayUntil || 0, missions: activeMissionsView() });
    }
    if (key === 'GET /missions') return json(res, 200, loadMissions());
    if (key === 'GET /projects') return json(res, 200, { projects: projectsView() });
    if (key === 'GET /project') {
        // A manager rehydrates its durable project context on boot from here (model B).
        const name = String(u.searchParams.get('name') || '').trim();
        const p = projectContextFor(name);
        if (!p) return json(res, 404, { error: 'no project ' + name });
        return json(res, 200, p);
    }
    if (key === 'POST /project-context') {
        // A manager checkpoints its curated context + appends a recent-work log line.
        const b = await readBody(req);
        const name = String(b.name || '').toLowerCase().trim();
        if (!name) return json(res, 400, { error: 'name is required' });
        const p = updateProjectContext(name, b);
        if (!p) return json(res, 404, { error: 'no project ' + name });
        return json(res, 200, { ok: true, project: projectContextFor(name) });
    }
    if (key === 'POST /project') {
        // Structural project op. op:rename atomically re-keys a project across every store that
        // keys off its name — the project row, its board column (worklist), the roster FOCUS, and
        // the live worker's session.project binding — so a plain /project-context can't be used
        // (that would create a duplicate under the new name and orphan the old column/focus). The
        // mission link (missionId) and curated context ride along on the same row untouched. The
        // live worker keeps its NATO callsign; it just re-anchors its /worklist ops to the new key.
        const b = await readBody(req);
        const op = String(b.op || '').toLowerCase();
        if (op === 'bind') {
            // Attach an ALREADY-LIVE worker to a project so its board + routing fold into the
            // project card and it nests under the project's mission — the live-session analogue of
            // spawning with a project (model B). Targets by uid or callsign; the project must exist.
            // Its NATO board key is migrated into the project column so it does not orphan as a
            // second ghost card; the session keeps its NATO callsign for the permission hook.
            const project = String(b.project || '').toLowerCase().trim();
            if (!project) return json(res, 400, { error: 'bind needs project' });
            if (!loadProjects().projects.some(x => x.name === project)) return json(res, 404, { error: 'no project ' + project });
            let bindUid = (b.uid && roster.sessions[b.uid] && !roster.sessions[b.uid].ended) ? b.uid : null;
            if (!bindUid && b.callsign) bindUid = liveUidOf(String(b.callsign).toLowerCase());
            const bs = bindUid ? roster.sessions[bindUid] : null;
            if (!bs || bs.ended) return json(res, 404, { error: 'no live session for that uid/callsign' });
            const fromKey = bs.callsign;
            bs.project = project;
            saveRoster();
            const wb = loadWork();
            if (wb.sessions && wb.sessions[fromKey] && fromKey !== project) {
                const dst = ensureBoard(wb, project), src = wb.sessions[fromKey];
                for (const col of ['working', 'queued', 'done', 'review']) {
                    for (const t of (src[col] || [])) if (!dst[col].some(x => textOf(x) === textOf(t))) dst[col].push(t);
                }
                delete wb.sessions[fromKey];
                if (wb.focus === fromKey) wb.focus = project;
                saveWork(wb);
            }
            record({ kind: 'sys', text: bs.callsign + ' bound to project ' + project });
            enqueueSay(bs.callsign + ' is now on ' + project + '.', 'jarvis');
            return json(res, 200, { ok: true, uid: bindUid, callsign: bs.callsign, project, projectContext: projectContextFor(project) });
        }
        if (op !== 'rename') return json(res, 400, { error: 'op must be rename or bind' });
        const from = String(b.from || '').toLowerCase().trim();
        const to = String(b.to || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
        if (!from || !to) return json(res, 400, { error: 'rename needs from and to' });
        if (from === to) return json(res, 400, { error: 'from and to are identical' });
        const store = loadProjects();
        const proj = store.projects.find(x => x.name === from);
        if (!proj) return json(res, 404, { error: 'no project ' + from });
        if (store.projects.some(x => x.name === to)) return json(res, 409, { error: 'project ' + to + ' already exists' });
        // 1) project row (keep missionId, context, managerUid; optionally refresh the display title)
        proj.name = to;
        if (b.title != null && String(b.title).trim()) proj.title = String(b.title).trim();
        proj.updatedAt = new Date().toISOString();
        saveProjects(store);
        // 2) board column: carry the tasks over to the new key (and follow focus)
        const w = loadWork();
        if (w.sessions && w.sessions[from]) {
            w.sessions[to] = { ...(w.sessions[to] || {}), ...w.sessions[from] };
            delete w.sessions[from];
        }
        if (w.focus === from) w.focus = to;
        saveWork(w);
        // 3) live session project-binding (the worker re-anchors its own /worklist ops to `to`)
        for (const uid in roster.sessions) {
            const s = roster.sessions[uid];
            if (!s.ended && s.project === from) s.project = to;
        }
        saveRoster();
        record({ kind: 'sys', text: 'project renamed: ' + from + ' -> ' + to });
        enqueueSay('Project ' + from + ' is now ' + to + '.', 'jarvis');
        return json(res, 200, { ok: true, project: projectContextFor(to) });
    }
    if (key === 'POST /trust') {
        // Flip a single live session's trust tier (trusted = its non-danger tool calls auto-approve
        // in POST /permission; guarded = they prompt). Takes effect immediately — the permission
        // check reads sess.tier live — so no respawn is needed. Targets by uid or callsign. The
        // danger floor in POST /permission still gates destructive actions regardless of tier.
        const b = await readBody(req);
        const tier = b.tier === 'guarded' ? 'guarded' : 'trusted';
        let uid = (b.uid && roster.sessions[b.uid] && !roster.sessions[b.uid].ended) ? b.uid : null;
        if (!uid && b.callsign) uid = liveUidOf(String(b.callsign).toLowerCase());
        const s = uid ? roster.sessions[uid] : null;
        if (!s || s.ended) return json(res, 404, { error: 'no live session for that uid/callsign' });
        s.tier = tier;
        saveRoster();
        record({ kind: 'sys', text: s.callsign + ' trust tier set to ' + tier });
        enqueueSay(s.callsign + ' is now ' + tier + '.', 'jarvis');
        return json(res, 200, { ok: true, uid, callsign: s.callsign, tier });
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
            hasHandoff: !!(roster.handoffs && (roster.handoffs[handoffKey(h.cwd, h.purpose)] || (h.callsign && roster.handoffs['cs:' + h.callsign]))),
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
        // Pull a parked project back. {drop:true} just removes it; otherwise spawn a fresh worker
        // (inheriting the handoff via its cwd, same as Archive "continue"). INVARIANT: the card is
        // only removed from On Hold once that successor is actually live — spawn first, delete after
        // — so a failed or impossible respawn can never delete the card and leave nothing behind.
        const b = await readBody(req);
        roster.held = roster.held || [];
        const wantKey = b.key || (b.cwd ? cwdKey(b.cwd) : null);
        const wantCs = String(b.callsign || '').toLowerCase();
        const idx = roster.held.findIndex(h => (wantKey && h.key === wantKey) || (b.cwd && cwdKey(h.cwd) === cwdKey(b.cwd)) || (wantCs && h.callsign === wantCs));
        if (idx < 0) return json(res, 404, { error: 'not on hold' });
        const h = roster.held[idx];
        if (b.drop) {
            roster.held.splice(idx, 1);
            saveRoster();
            record({ kind: 'sys', text: (h.callsign || h.purpose || 'project') + ' removed from on-hold' });
            return json(res, 200, { ok: true, dropped: true });
        }
        // A reminder card has no working directory, so there is nothing to spawn. Keep it parked
        // instead of silently deleting it, and tell the caller it needs a repo (or a drop).
        if (!h.cwd || !h.purpose) {
            enqueueSay((h.callsign || 'That') + ' is a reminder with no repo to spin up. Tell me which repo to launch it in, or drop it.', 'jarvis');
            return json(res, 200, { ok: true, callsign: null, needsRepo: true, key: h.key, purpose: h.purpose || '', summary: h.summary || '' });
        }
        let cs = null;
        roster.handoffs = roster.handoffs || {};
        const handoff = roster.handoffs[handoffKey(h.cwd, h.purpose)] || null;
        try { cs = spawnWorker(resolveRepo(h.cwd), h.purpose, b.model, handoff); } catch { cs = null; }
        if (!cs) {
            enqueueSay('I could not spin that back up, so it is still on hold. Try again.', 'jarvis');
            return json(res, 500, { error: 'spawn failed', stillHeld: true, key: h.key });
        }
        roster.held.splice(idx, 1);
        saveRoster();
        record({ kind: 'sys', text: (h.callsign || h.purpose || 'project') + ' pulled back from on-hold -> ' + cs });
        enqueueSay((h.callsign || 'That project') + ' is back, ' + cs + ' is spinning up.', 'jarvis');
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
            missionId: e.missionId || null,
            img: e.img || null,
            text: e.text,
            ...(e.kind === 'react' ? { target: e.target, reaction: e.reaction } : {}),
        }));
        return json(res, 200, lim > 0 ? evts.slice(-lim) : evts);
    }
    // The durable, mission-keyed conversation thread: every event tagged with this missionId, plus
    // any message bused to a worker currently bound to the mission's project. Survives sub-worker
    // turnover because it is keyed by the mission, not by any one callsign.
    if (key === 'GET /mission-chat') {
        const id = String(u.searchParams.get('missionId') || '').trim();
        const lim = Number(u.searchParams.get('limit') || 200);
        if (!id) return json(res, 400, { error: 'missionId required' });
        const proj = projectForMission(loadProjects().projects || [], id);
        const memberUids = new Set();
        for (const uid in roster.sessions) {
            const s = roster.sessions[uid];
            if (s && proj && s.project === proj.name) memberUids.add(uid);
        }
        const memberCs = new Set([...memberUids].map(uid => roster.sessions[uid].callsign).filter(Boolean));
        const kinds = { speech: 1, tts: 1, chat: 1 };
        const evts = transcriptCache.filter(e =>
            kinds[e.kind] && (e.missionId === id || memberCs.has(e.from) || (e.to && memberCs.has(e.to)))
        ).map(e => ({
            ts: e.ts,
            kind: 'msg',
            who: e.kind === 'speech' ? 'you' : (e.from || 'jarvis'),
            to: e.to || null,
            missionId: e.missionId || null,
            img: e.img || null,
            text: e.text,
        }));
        return json(res, 200, { missionId: id, project: proj ? proj.name : null, messages: lim > 0 ? evts.slice(-lim) : evts });
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
        // lastPoll is tracked APART from lastSeen so a dead poll loop stays visible. Both /poll and
        // /heartbeat bump lastSeen, so lastSeen alone cannot tell a working session from a deaf one
        // whose background ping is still firing (see wedgeState). pollCursor is what this worker has
        // consumed -- it's how pendingFor knows how many events it is currently ignoring.
        s.lastSeen = s.lastPoll = new Date().toISOString();
        s.pollCursor = cursor;
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
        // It must NOT touch lastPoll -- keeping the two apart is the whole wedge detector: this
        // endpoint proves a timer is alive, /poll proves the worker's EARS are.
        const uid = u.searchParams.get('uid');
        const s = roster.sessions[uid];
        if (!s) return json(res, 404, { error: 'unknown uid' });
        if (s.ended) return json(res, 410, { error: 'retired' });
        s.lastSeen = s.lastBeat = new Date().toISOString();
        saveRosterThrottled();
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /register') {
        const b = await readBody(req);
        if (!String(b.purpose || '').trim() || !String(b.cwd || '').trim()) {
            return json(res, 400, { error: 'purpose and cwd are required. purpose is the one-line description the human sees on the board and hears in announcements; make it specific. Re-POST with both.' });
        }
        try { return json(res, 200, registerSession(b.cwd, b.purpose, b.pin, b.project, b.parentProject)); }
        catch (e) { return json(res, 409, { error: e.message }); }
    }
    if (key === 'POST /away') {
        const b = await readBody(req);
        const until = setAway(!!b.on, b.hours);
        return json(res, 200, { ok: true, awayUntil: until });
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
    if (key === 'POST /watch') {
        // A watcher session reports that it is actively watching a channel (the #jarvis QA loop).
        // It re-pings on each ~120s tick to keep the light fresh (see watchingNow / WATCH_TTL);
        // POST {on:false} clears it the instant it stops. Liveness + freshness gating is at render.
        const b = await readBody(req);
        const s = roster.sessions[b.uid];
        if (!s || s.ended) return json(res, 404, { error: 'unknown uid' });
        if (b.on === false) s.watching = null;
        else s.watching = { channel: String(b.channel || '#jarvis').slice(0, 40), ts: new Date().toISOString() };
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
        // Focus targets: the solo brain ('jarvis'), any LIVE worker (by NATO callsign), or a durable
        // PROJECT by name (e.g. 'primeng'). A project card hosts a rehydrating worker, so the console
        // renders a focus ★ on it and the human expects to focus it — but without the project branch
        // the ★ posted callsign=<project> and this guard 404'd it as "no live session" (bit Chris
        // trying to promote the primeng card). Match against the durable project list so a real
        // project resolves even between its workers; ephemeral NATO boards still require a live uid.
        const isProject = (loadProjects().projects || []).some(p => p && p.name === cs);
        if (cs !== 'jarvis' && !liveUidOf(cs) && !isProject) return json(res, 404, { error: 'no live session or project ' + cs });
        const w = loadWork();
        // Focusing a bound coordinator by its NATO callsign must land on the PROJECT card -- that is
        // the card it renders on. Pointing focus at the callsign put it on a board with no card.
        const fk = boardKey(cs);
        w.focus = fk;
        if (fk !== 'jarvis') ensureBoard(w, fk);
        saveWork(w);
        record({ kind: 'sys', text: 'focus: ' + fk + (fk !== cs ? ' (' + cs + ' is its worker)' : '') });
        return json(res, 200, { ok: true, focus: fk });
    }
    if (key === 'POST /spawn') {
        const b = await readBody(req);
        const cwd = String(b.cwd || '').trim();
        const purpose = String(b.purpose || '').trim();
        if (!cwd || !purpose) return json(res, 400, { error: 'need cwd and purpose' });
        const repo = resolveRepo(cwd);
        roster.handoffs = roster.handoffs || {};
        const handoff = roster.handoffs[handoffKey(cwd, purpose)] || null;
        const cs = spawnWorker(repo, purpose, b.model, handoff, b.tier, b.project, b.meeting, b.parentProject);
        const subOf = (!b.project && b.parentProject) ? String(b.parentProject).toLowerCase().trim() : null;
        const launchWhat = b.meeting && b.meeting.title ? 'meeting worker for ' + b.meeting.title : (b.project ? b.project + ' worker' : (subOf ? subOf + ' sub-worker' : cs));
        enqueueSay('Launching ' + launchWhat + ' in ' + repo.key + (handoff ? ', resuming the handoff' : '') + '.', 'jarvis');
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
        const uid = (cs && (liveUidOf(cs) || projectWorkerUid(cs))) || liveUidOf(w.focus) || projectWorkerUid(w.focus);
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
        // Resolve the focus HOLDER properly: liveUidOf only understands NATO callsigns, so when focus
        // sat on a project it always came back empty and this "repair" dragged the human off a
        // perfectly live coordinator just because some unrelated dead card was forgotten.
        const fUid = w.focus !== 'jarvis' ? focusHolderUid(w.focus, roster.sessions, roster.callsigns) : null;
        if (w.focus === cs || (w.focus !== 'jarvis' && (!fUid || !aliveNow(fUid)))) {
            w.focus = nextFocusKey(liveBoardCandidates(), cs);
        }
        saveWork(w);
        record({ kind: 'sys', text: 'removed ' + cs + ' from board' });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /worklist') {
        const b = await readBody(req);
        const w = loadWork();
        // A bound coordinator posting as ITSELF ('juliet') belongs on its project column ('primeng').
        // Without boardKey this ensureBoard minted a second board and Chris got two trackers for one
        // session. Resolve AFTER the guard so an existing NATO board still validates.
        const cs = boardKey((b.callsign && (w.sessions[b.callsign] || liveUidOf(String(b.callsign).toLowerCase()) || b.callsign === 'jarvis')) ? String(b.callsign).toLowerCase() : w.focus);
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
    if (key === 'POST /mission') {
        // Mutate the durable mission set. Note: there is NO console close button — a mission is
        // closed only via the voice gate (handleUtterance). The 'archive' op here exists for
        // programmatic/recovery use, not the UI. ops: add | phase | unphase | title | doc | undoc
        // | archive | reactivate.
        const b = await readBody(req);
        const op = String(b.op || '').toLowerCase();
        const mm = loadMissions();
        if (op === 'add') {
            const mn = makeMission(b.title, b.phases, b.docs);
            if (!mn.title) return json(res, 400, { error: 'title required' });
            mm.missions.push(mn); saveMissions(mm);
            record({ kind: 'sys', text: 'mission created: ' + mn.title });
            return json(res, 200, { ok: true, mission: mn });
        }
        const mn = (mm.missions || []).find(x => x.id === b.id);
        if (!mn) return json(res, 404, { error: 'no such mission' });
        if (op === 'phase') {
            if (b.text != null && b.index == null) { mn.phases.push({ text: String(b.text), done: !!b.done }); }
            else {
                const i = Number(b.index);
                if (!(i >= 0 && i < mn.phases.length)) return json(res, 400, { error: 'bad phase index' });
                mn.phases[i].done = (b.done != null) ? !!b.done : !mn.phases[i].done;
            }
        } else if (op === 'unphase') {
            const i = Number(b.index);
            if (!(i >= 0 && i < mn.phases.length)) return json(res, 400, { error: 'bad phase index' });
            mn.phases.splice(i, 1);
        } else if (op === 'title') {
            if (b.title) mn.title = String(b.title).trim();
        } else if (op === 'doc') {
            mn.docs.push({ label: String(b.label || b.url || ''), url: String(b.url || '') });
        } else if (op === 'undoc') {
            const i = Number(b.index);
            if (i >= 0 && i < mn.docs.length) mn.docs.splice(i, 1);
        } else if (op === 'archive') {
            mn.status = 'archived'; mn.archivedAt = new Date().toISOString();
            record({ kind: 'sys', text: 'mission archived: ' + mn.title });
        } else if (op === 'reactivate') {
            mn.status = 'active'; mn.archivedAt = null;
        } else {
            return json(res, 400, { error: 'op must be add|phase|unphase|title|doc|undoc|archive|reactivate' });
        }
        saveMissions(mm);
        return json(res, 200, { ok: true, mission: mn });
    }
    if (key === 'POST /retire') {
        const b = await readBody(req);
        const s = roster.sessions[b.uid];
        if (s && !s.ended && b.notes != null) s.handoff = String(b.notes);
        let successor = false;
        if (s && !s.ended) {
            const board = loadWork().sessions[s.callsign] || { working: [], queued: [] };
            // auto-successor on retire when work remains; explicit successor:true/false overrides
            successor = shouldSpawnSuccessor(b.successor, boardHasWork(board));
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
        if (s.cwd) roster.handoffs[handoffKey(s.cwd, s.purpose)] = {
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
            // Durable per-job record, keyed by cwd + purpose (register hands back a hint that
            // carries the purpose). Bare legacy calls with no purpose fall back to the most recent
            // record on that cwd so an old-style GET /handoff?cwd=... still resolves.
            const purposeq = u.searchParams.get('purpose');
            rec = roster.handoffs[handoffKey(cwdq, purposeq)] || null;
            if (!rec && purposeq == null) {
                const pref = cwdKey(cwdq);
                rec = Object.entries(roster.handoffs)
                    .filter(([k, r]) => !k.startsWith('cs:') && r && cwdKey(r.cwd) === pref)
                    .map(([, r]) => r)
                    .sort((a, b2) => Date.parse(b2.ts) - Date.parse(a.ts))[0] || null;
            }
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
        const repos = loadRepos();
        const prev = repos[name];
        // cwd is required to CREATE a repo; an existing one can be amended (e.g. set tier) without
        // re-sending it, which is the point of the merge -- see repoRow.
        if (!name || (!prev && !b.cwd)) return json(res, 400, { error: 'need name and an existing cwd' });
        if (b.cwd && !existsSync(b.cwd)) return json(res, 400, { error: 'need name and an existing cwd' });
        repos[name] = repoRow(prev, b);
        writeFileSync(REPOS, JSON.stringify(repos, null, 1));
        record({ kind: 'sys', text: 'repo ' + (prev ? 'updated' : 'registered') + ': ' + name + ' -> ' + repos[name].cwd + (repos[name].tier === 'trusted' ? ' (trusted)' : '') });
        enqueueSay('Repo ' + name + ' ' + (prev ? 'updated' : 'registered') + '.', 'jarvis');
        return json(res, 200, { ok: true, name, ...repos[name] });
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
    if (key === 'POST /stt-backend') {
        // Flip the speech-to-text backend (google <-> local). Spawning/stopping the local
        // whisper server is handled by setSttBackend so the model is only warmed when in use.
        const b = await readBody(req);
        setSttBackend(String(b.backend || 'google'));
        return json(res, 200, { ok: true, sttBackend, sttReady: stt.isReady() });
    }
    if (key === 'POST /stt') {
        // Local-backend transcription bridge: the console captures one utterance of mic audio
        // (16 kHz mono WAV, base64) and POSTs it here; we hand it to the local whisper server and
        // return the text. Nothing is spoken/routed here — the console feeds the text back through
        // its normal buffer/flush path so mute, INSTANT commands, and the 2.5s merge all still apply.
        const b = await readBody(req);
        if (sttBackend !== 'local') return json(res, 409, { error: 'STT backend is not local' });
        if (!b.audio) return json(res, 400, { error: 'missing audio' });
        try {
            const text = await stt.transcribe(Buffer.from(String(b.audio), 'base64'));
            return json(res, 200, { ok: true, text: text || '' });
        } catch (e) {
            record({ kind: 'sys', text: 'STT transcribe error: ' + e.message });
            return json(res, 500, { error: e.message });
        }
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
    if (key === 'GET /ai/threads') {
        const store = loadThreads();
        const threads = Object.keys(store.threads).map(id => {
            const t = store.threads[id] || {};
            const msgs = Array.isArray(t.messages) ? t.messages : [];
            const last = msgs.length ? msgs[msgs.length - 1] : null;
            return { id, title: t.title || '(untitled)', model: t.model || AI_DEFAULT_MODEL, lastTs: last ? last.ts : null, count: msgs.length };
        }).sort((a, b) => (Date.parse(b.lastTs || 0) || 0) - (Date.parse(a.lastTs || 0) || 0));
        const spend = loadSpend();
        return json(res, 200, { threads, spend: { usd: spend.usd, cap: AI_CAP }, models: Object.keys(AI_MODELS), defaultModel: AI_DEFAULT_MODEL, hasKey: !!anthropicKey() });
    }
    if (key === 'GET /ai/thread') {
        const id = u.searchParams.get('id') || '';
        const t = loadThreads().threads[id];
        if (!t) return json(res, 404, { error: 'no such thread' });
        return json(res, 200, { id, title: t.title || '', model: t.model || AI_DEFAULT_MODEL, messages: (t.messages || []).map(m => ({ role: m.role, content: m.content, ts: m.ts, model: m.model })) });
    }
    if (key === 'POST /ai/newthread') {
        const b = await readBody(req);
        let model = String(b.model || AI_DEFAULT_MODEL); if (!AI_MODELS[model]) model = AI_DEFAULT_MODEL;
        const store = loadThreads();
        const id = newThreadId();
        store.threads[id] = { title: 'New chat', model, messages: [] };
        saveThreads(store);
        return json(res, 200, { ok: true, threadId: id });
    }
    if (key === 'POST /ai/deletethread') {
        const b = await readBody(req);
        const store = loadThreads();
        if (b.id && store.threads[b.id]) { delete store.threads[b.id]; saveThreads(store); }
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /ai/send') {
        const b = await readBody(req);
        const text = String(b.text == null ? '' : b.text).trim();
        if (!text) return json(res, 400, { error: 'text is required' });
        let model = String(b.model || AI_DEFAULT_MODEL); if (!AI_MODELS[model]) model = AI_DEFAULT_MODEL;
        // Hard cap: refuse BEFORE spending if we're already at/over the monthly limit.
        let spend = loadSpend();
        if (capExceeded(spend.usd, AI_CAP)) {
            return json(res, 402, { error: 'Monthly AI spend cap reached ($' + AI_CAP.toFixed(2) + '). It resets next month, or raise JARVIS_AI_CAP.', spend: { usd: spend.usd, cap: AI_CAP } });
        }
        const store = loadThreads();
        let id = (b.threadId && store.threads[b.threadId]) ? b.threadId : null;
        if (!id) { id = newThreadId(); store.threads[id] = { title: text.slice(0, 60), model, messages: [] }; }
        const thread = store.threads[id];
        thread.model = model;   // remember the last model used on this thread
        thread.messages.push({ role: 'user', content: text, ts: new Date().toISOString() });
        const history = thread.messages.map(m => ({ role: m.role, content: m.content }));
        let reply;
        try {
            reply = await callAnthropic(model, history);
        } catch (e) {
            saveThreads(store);   // keep the user message so the thread isn't lost on a transient error
            const code = e.code === 'NO_KEY' ? 503 : 502;
            const msg = e.code === 'NO_KEY'
                ? 'No Anthropic API key found. Paste one into anthropic-key.txt at the repo root (or set ANTHROPIC_API_KEY), then try again.'
                : ('Anthropic call failed: ' + e.message);
            return json(res, code, { error: msg, threadId: id });
        }
        const replyText = reply.text || (reply.stop === 'refusal' ? '(the model declined to respond)' : '(no text returned)');
        thread.messages.push({ role: 'assistant', content: replyText, ts: new Date().toISOString(), model });
        saveThreads(store);
        // Add the call's cost to the monthly tracker (re-read fresh to minimize a concurrent-send race).
        const cost = aiCost(model, reply.inTok, reply.outTok);
        spend = loadSpend();
        spend.usd = Math.round((spend.usd + cost) * 1e6) / 1e6;
        saveSpend(spend);
        return json(res, 200, { threadId: id, reply: replyText, model, title: thread.title, usage: { in: reply.inTok, out: reply.outTok, cost }, spend: { usd: spend.usd, cap: AI_CAP } });
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
        // `stale` (schedule not from today) + `date` let the console flag a missing morning pull
        // instead of silently hiding the panel — when stale, events above is already blanked.
        return json(res, 200, { events, reminders, next, current, stale, date: s.date || null });
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
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    }).catch(e => {
        // Bind failed -- almost always EADDRINUSE: another hub already owns the port (a duplicate
        // launch, or a restart before the old port fully released). Previously listen()'s 'error'
        // had no handler, so it was swallowed by the global uncaughtException handler while THIS
        // promise never resolved -- main() hung here forever, a wedged process the supervisor then
        // blocked on. Exit instead so the supervisor relaunches cleanly; paired with the supervisor's
        // singleton lock, only the legitimate hub ever holds the port.
        logCrash('listen-failed (' + ((e && e.code) || '?') + ') on ' + PORT + ' -- another hub may own it; exiting for the supervisor', e);
        process.exit(e && e.code === 'EADDRINUSE' ? 3 : 1);
    });

    // Collect worktrees whose worker died with the last hub (console-less workers are hub children).
    // After the listen, so a slow git call on a big repo never delays the port coming up.
    sweepWorktrees();

    let consolePage = null;
    let context = null;
    let reopening = false;
    let lastConsoleTry = 0;
    // The HTTP server is already listening above. A console/mic launch failure (locked chrome-profile,
    // missing Chrome, Playwright fault) must NOT take the server down -- workers depend on it for
    // polling. AND because the hub now runs console-less, if the console window ever dies there is no
    // terminal to fall back on, so we must REOPEN it automatically. openConsole() (re)launches the
    // mic-wired Playwright window; the while-loop below health-checks it and calls this again within
    // seconds of any death -- user-close, window-combine, hard kill, or the launch-race on restart
    // (which just retries until the old Chrome frees the profile lock). Degrades to headless meanwhile.
    async function openConsole() {
        if (NO_UI || reopening) return;
        reopening = true;
        try {
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
        } catch (e) {
            logCrash('ui-launch-failed (will retry; HTTP + workers still up)', e);
            try { if (context) await context.close(); } catch { }
            consolePage = null; context = null; consolePageRef = null;
        } finally {
            reopening = false;
        }
    }
    const consoleAlive = () => { try { return !!consolePage && !consolePage.isClosed(); } catch { return false; } };
    await openConsole();

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
        if (!NO_UI && !reopening && !consoleAlive() && Date.now() - lastConsoleTry > 4000) {
            lastConsoleTry = Date.now();
            openConsole().catch(() => { });
        }
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
