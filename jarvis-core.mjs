import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { captureScreen } from './screen.mjs';
import * as stt from './stt.mjs';
import { scanUsage, totalsOf, blockStats, burnOf, heatOf } from './tokens.mjs';
import { fetchRealUsage } from './usage.mjs';
import { worktreeRoot, worktreeBase, worktreePlan, claudeTrustPatch, shouldIsolate, orphanWorktrees, reconcileRoster, buildIdentity } from './jarvis-text.mjs';
import { BATON_STALE_MS, normalizeLane, batonRequest, batonRelease, batonCancel, batonForce, batonReap } from './jarvis-text.mjs';
import { SPAWN_REGISTER_TIMEOUT_MS, overdueSpawns, diagnoseSpawnLog, deadSpawnNote } from './jarvis-text.mjs';
import { clk, remTitle, parseReminder, parseScheduleText, WORK_VERSION, textOf, shortTitle, summarizeBoard, migrateWork, cwdKey, handoffKey, shouldSpawnSuccessor, boardHasWork, transferBoard, AI_MODELS, AI_DEFAULT_MODEL, aiCost, monthKey, rollSpend, capExceeded, normalizeProject, pushCapped, subworkerBrief, PROJECT_LOG_CAP, normalizeMission, missionProgress, isMissionCloseIntent, isMissionConfirm, isMissionCancel, parseNewMissionTitle, matchMissionByPhrase, permSig, permLabel, PERM_MULTIWORD, canon, orderedTasks, projectForMission, pickProjectWorker, lastProjectCwd, projectOwningCwd, activeProjectsForCwd, shouldNudgeSchedulePull, matchRepo, repoRow, focusHolderUid, focusHeldByLiveOther, nextFocusKey, boardKeyFor, resolveBinding, coordinatorSlotHolder, wedgeState, parseBodyLenient } from './jarvis-text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// What code is actually RUNNING, resolved once at load and stated out loud.
//
// Five sessions in a row have now reasoned about a deploy from the wrong evidence. The roster,
// the archive epitaphs and the session churn all look the SAME whether the hub bounced or not,
// so "the fixes are merged" kept getting read as "the fixes are live" — and on 2026-07-27 four
// commits sat undeployed for three hours while a whole verify plan was aimed at code the hub had
// never loaded. Nothing in the old surface could have caught that: the only honest observable
// was the hub process's creation time, which no session thought to check.
//
// So the hub publishes its own identity — the commit it was started from, whether that tree was
// dirty, and when THIS process booted — on /roster and in every /register response. A worker
// asking "is my fix live?" now compares SHAs against its own checkout
// (`git merge-base --is-ancestor <build.commit> HEAD`) instead of inferring a restart from
// session churn. Resolved at load, never refreshed: a running process does not change build, and
// re-reading git would make it lie the moment someone commits under a live hub.
const BUILD = (() => {
    const git = (...a) => execFileSync('git', ['-C', HERE, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let rev = null, status = null;
    try { rev = git('rev-parse', 'HEAD'); } catch { }
    // Deliberately NOT `git status --porcelain`. That answer is driven by cached file stats, and on
    // 2026-07-27 it kept reporting ` M jarvis-text.mjs` for a file whose content was provably
    // identical to HEAD — worktree, index and HEAD blobs all 3632e27, `git diff HEAD` clean, and a
    // `git add` that staged nothing. The hub booted on it and published `dirty: true`, which is the
    // very failure c059932 exists to prevent wearing the other face: instead of believing a stale
    // build is fresh, the next session believes a clean one is modified and hunts for a diff that
    // was never there. `git diff` compares CONTENT, so it cannot invent a modification; the second
    // call keeps the untracked half `status` was also covering. If either throws, status stays null
    // and buildIdentity renders dirty:null — unknown, never a silent false.
    try { status = git('diff', '--name-only', 'HEAD') + git('ls-files', '--others', '--exclude-standard'); } catch { }
    return buildIdentity({ rev, status, bootedAt: new Date().toISOString(), pid: process.pid });
})();
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
// The transcript ARCHIVE: every line trimTranscript() takes off the front of the display cache, in
// the order it left. Append-only, never rewritten, and read by GET /search alongside the cache.
// Not to be confused with ARCHIVE above, which is a DIRECTORY of one JSON epitaph per retired session.
const TRANSCRIPT_ARCHIVE = join(DATA, 'transcript-archive.jsonl');
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
// How much of the transcript archive GET /search reads, and how much of it is ever resident.
//
// The archive is walked BACKWARDS in ARCHIVE_CHUNK_BYTES slices — newest first, which is the order a
// search wants anyway — so peak memory is one slice, not the file. That makes the byte cap a LATENCY
// bound rather than a memory one: it exists so one search cannot spend seconds of the hub's single
// thread, not to stop the archive growing.
//
// Sized on measurement, not guesswork: the live transcript held 5510 lines at ~285 bytes each over the
// seven days to 2026-07-29, so the cache cap is reached about weekly and the archive will grow ~11 MB
// a month. 64 MiB is therefore roughly six months of history, worst case ~1s of scanning broken across
// ~64 awaits so long-polls keep being served. Raising it is this one constant — and when the cap DOES
// clip, /search says so (`archive.capped` + `archive.oldestScannedTs`) and the hub logs it, so a search
// never answers "no such chat" about history it declined to read.
//
// The env override exists so the bounded-scan behaviour is testable without a 64 MiB fixture; the chunk
// size deliberately has no override, because a seam bug that only appears at the real 1 MiB boundary is
// exactly what a shrunk-for-tests chunk would hide.
const ARCHIVE_SCAN_CAP_BYTES = (() => { const v = Number(process.env.JARVIS_ARCHIVE_SCAN_CAP); return v > 0 ? v : 64 * 1024 * 1024; })();
const ARCHIVE_CHUNK_BYTES = 1024 * 1024;
// How far back archiveTailLine() reads to recognise an already-archived batch. Declared up here with
// the other bounds rather than beside its function, because the boot-time trimTranscript() below runs
// before that point in the file and a const — unlike a function declaration — does not hoist its value.
const ARCHIVE_TAIL_WINDOW = 64 * 1024;

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

// Reporting store (db.mjs) — the LIVE event path.
//
// db.mjs keeps a local SQLite record of sessions and tasks for PM-style history ("what did each
// worker do, how much got finished"). It shipped as a backfill only: a RECONSTRUCTION assembled
// after the fact from the JSON state and the append-only logs, so it could never know more than
// those files still remembered. The hooks below make it a RECORD instead — register, retire and
// every board op write their row as the event happens — which is the difference between history
// and a re-read of the present.
//
// Three rules keep this strictly additive, because reporting is not the hub's job:
//   1. The import is DYNAMIC and guarded. db.mjs statically imports node:sqlite; a static import
//      here would mean a runtime without that builtin could not boot the hub AT ALL. Loaded once
//      at boot, and if it throws the store simply stays off for the life of the process.
//   2. Every write is best-effort inside a try/catch. A store failure must never fail a register,
//      a retire, or a board op — those are the real work and the store is a bystander.
//   3. Nothing here ever READS from it. The store is write-only on the hub's side (the queries in
//      db.mjs serve its CLI), so no hub behaviour can come to depend on its contents.
let storeMod = null;      // db.mjs namespace once loaded
let storeDb = null;       // open handle, or null while the store is unavailable
let storeOff = false;     // sticky: it does not work here, stop trying on every event
let storeFails = 0;
async function initStore() {
    try {
        storeMod = await import('./db.mjs');
        // No path argument: db.mjs owns defaultDbPath(), so the file the hub writes and the file
        // `node db.mjs backfill` reads can never drift apart.
        storeDb = storeMod.init();
    } catch (e) {
        storeMod = null; storeDb = null; storeOff = true;
        logCrash('reporting-store-unavailable (history off; hub otherwise unaffected)', e);
    }
}
// Run one store write, swallowing everything. Three consecutive failures turn the store off for
// good: a transient lock recovers on the next event, but an unwritable db would otherwise append to
// crash.log once per register/retire/board op forever.
function store(what, fn) {
    if (storeOff || !storeDb) return false;
    try { fn(storeMod, storeDb); storeFails = 0; return true; }
    catch (e) {
        logCrash('reporting-store-write-failed (' + what + ')', e);
        if (++storeFails >= 3) { storeOff = true; logCrash('reporting-store-off', new Error('3 consecutive write failures; history off for this process')); }
        return false;
    }
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
// Keep the display cache + its file bounded WITHOUT losing what comes off the front.
//
// This used to say trimming the front was safe "because the transcript is display-only (not index-
// referenced)". That premise died the day GET /search shipped: the transcript stopped being a scroll-back
// buffer and became the searchable record of every conversation, so this function was quietly deleting
// that record a week at a time. Measured on the live hub before the fix — 5510 lines, oldest
// 2026-07-22T10:56Z, i.e. exactly the seven days the cap holds — against a human who expected to search
// months. The cache still has to be bounded (it is walked synchronously by /transcript and /search);
// what changes is where the dropped lines GO.
//
// Order matters, and it is chosen for the survivable failure. The batch is appended to the archive
// FIRST and the trimmed transcript is written only after. A crash between the two therefore re-archives
// the same batch on the next boot — duplicate lines — whereas the reverse order loses them outright,
// which is the bug this is fixing. archiveTranscriptLines() then catches that replay: the batch boundary
// is deterministic (the same splice recomputed from the same file), so if the archive already ends with
// the batch's last line, it has already taken this batch.
//
// And if the archive will not take them at all, the whole trim is abandoned rather than completed
// lossily: an over-cap cache is bounded and self-healing (the next record() retries), while a trim whose
// archive write failed is the original bug back again.
function trimTranscript() {
    if (transcriptCache.length <= CACHE_CAP + CACHE_SLACK) return;
    const cut = transcriptCache.length - CACHE_CAP;
    try { archiveTranscriptLines(transcriptCache.slice(0, cut)); }
    catch (e) { logCrash('transcript-archive-append-failed (trim abandoned, nothing dropped)', e); return; }
    transcriptCache.splice(0, cut);
    atomicWrite(TRANSCRIPT, transcriptCache.map(e => JSON.stringify(e)).join('\n') + (transcriptCache.length ? '\n' : ''));
}
// Append a trimmed batch to the archive, unless the archive already ends with it (see trimTranscript).
// Throws on a write failure — deliberately, because the caller must not drop lines the archive refused.
function archiveTranscriptLines(entries) {
    if (!entries.length) return;
    const lines = entries.map(e => JSON.stringify(e));
    if (archiveTailLine() === lines[lines.length - 1]) {
        logCrash('transcript-archive-replay', new Error('archive already ends with this batch of '
            + lines.length + ' lines (a crash between the append and the transcript rewrite); not re-appending'));
        return;
    }
    appendFileSync(TRANSCRIPT_ARCHIVE, lines.join('\n') + '\n');
}
// The archive's last line, or null. Reads only the tail because the archive is months of chat and this
// runs on every trim. A line longer than the window reads back partial and so will not match, which
// costs a duplicate append rather than a lost batch — the same direction the ordering above is chosen for.
function archiveTailLine() {
    try {
        if (!existsSync(TRANSCRIPT_ARCHIVE)) return null;
        const size = statSync(TRANSCRIPT_ARCHIVE).size;
        if (!size) return null;
        const want = Math.min(size, ARCHIVE_TAIL_WINDOW);
        const fd = openSync(TRANSCRIPT_ARCHIVE, 'r');
        try {
            const buf = Buffer.allocUnsafe(want);
            readSync(fd, buf, 0, want, size - want);
            const parts = buf.toString('utf8').split('\n').filter(Boolean);
            return parts.length ? parts[parts.length - 1].replace(/\r$/, '') : null;
        } finally { closeSync(fd); }
    } catch (e) { logCrash('transcript-archive-tail-read-failed', e); return null; }
}
// Walk the archive NEWEST-FIRST in bounded slices, handing each raw JSONL line to onLine().
//
// Backwards because that is the order search needs, and because it makes the cap mean "the newest N
// bytes of history" instead of the oldest. Three details are load-bearing:
//   - Slices are stitched as BUFFERS, split on the newline byte, and only then decoded. Decoding a slice
//     that begins mid-character would plant a replacement glyph in the partial line at its front, and
//     that line is precisely the one carried down to be completed by the next slice. 0x0A cannot occur
//     inside a multi-byte UTF-8 sequence, so splitting bytes first is exact where splitting text is not.
//   - The carry is COPIED out of the slice. A subarray keeps its whole 1 MiB backing buffer alive, which
//     would turn a bounded scan into one retained megabyte per iteration.
//   - The size is snapshotted before the first read. The archive is append-only, so a concurrent trim can
//     only add bytes ABOVE the snapshot and can never move the ones being read — which is also why there
//     is no rotation: renaming segments mid-scan would invalidate every offset below.
async function scanArchiveBackwards(onLine, capBytes = ARCHIVE_SCAN_CAP_BYTES) {
    const stats = { searched: false, lines: 0, bytes: 0, capped: false, oldestScannedTs: null };
    if (!existsSync(TRANSCRIPT_ARCHIVE)) return stats;
    let fh = null;
    try {
        fh = await open(TRANSCRIPT_ARCHIVE, 'r');
        const st = await fh.stat();
        // "No archive yet" and "an archive I cannot read" are different answers and must not collapse
        // into the same one. An absent or empty file is the honest searched:false above; anything else
        // that is not a plain file is a fault, and a search has to say so rather than quietly report a
        // cache-only result as though that were all of history. (Windows opens a DIRECTORY without
        // complaint and stats it at size 0, which is exactly how that collapse gets in.)
        if (!st.isFile()) throw new Error('archive path is not a regular file');
        const size = st.size;
        if (!size) return stats;
        stats.searched = true;
        let last = null;
        const emit = (slice) => {
            const line = slice.toString('utf8').replace(/\r$/, '');
            if (!line) return;
            stats.lines++; last = line; onLine(line);
        };
        let pos = size, carry = Buffer.alloc(0);
        while (pos > 0 && stats.bytes < capBytes) {
            const want = Math.min(ARCHIVE_CHUNK_BYTES, pos, capBytes - stats.bytes);
            // A zero-length slice would read nothing and leave `pos` where it was: an infinite loop on
            // the hub's only thread, which takes voice, the console and every long-poll down with it.
            // The while condition already prevents that, so this line is REDUNDANT BY DESIGN and both
            // mutation probes against it survive as equivalent mutants -- either guard alone terminates
            // the loop and enforces the cap. Kept anyway, and the redundancy noted rather than removed:
            // the probe that deleted the while condition HUNG rather than failing, which is how it became
            // clear that termination rested entirely on a bound three lines away.
            if (want <= 0) break;
            const start = pos - want;
            const buf = Buffer.allocUnsafe(want);
            await fh.read(buf, 0, want, start);
            stats.bytes += want;
            const block = carry.length ? Buffer.concat([buf, carry]) : buf;
            let end = block.length;
            for (;;) {
                if (end <= 0) break;
                const nl = block.lastIndexOf(0x0a, end - 1);
                if (nl < 0) break;
                emit(block.subarray(nl + 1, end));
                end = nl;
            }
            carry = Buffer.from(block.subarray(0, end));
            pos = start;
        }
        // Only a scan that reached byte 0 has seen the whole archive; the first line of the file has no
        // newline before it, so it arrives as the final carry rather than through the loop above.
        if (pos === 0 && carry.length) emit(carry);
        stats.capped = pos > 0;
        if (last) { const m = /"ts":"([^"]*)"/.exec(last); stats.oldestScannedTs = m ? m[1] : null; }
        return stats;
    } catch (e) {
        // A search that cannot read the archive must say so, not quietly answer from the cache alone.
        logCrash('transcript-archive-read-failed', e);
        stats.error = String((e && e.message) || e);
        return stats;
    } finally {
        if (fh) { try { await fh.close(); } catch { } }
    }
}
// One predicate and one projection for BOTH halves of a search, so the cache walk and the archive walk
// can never drift into answering differently about the same line. Returns the hit, or null for a miss.
function searchProject(e, want, terms, fromWant, missionWant) {
    if (!e || !want[e.kind]) return null;
    if (missionWant && e.missionId !== missionWant) return null;
    const who = e.kind === 'speech' ? 'you' : e.kind === 'sys' ? 'sys' : (e.from || 'jarvis');
    if (fromWant && who.toLowerCase() !== fromWant) return null;
    const hay = String(e.text == null ? '' : e.text).toLowerCase();
    if (!terms.every(t => hay.includes(t))) return null;
    return {
        ts: e.ts,
        kind: e.kind === 'sys' ? 'sys' : e.kind === 'react' ? 'react' : 'msg',
        srcKind: e.kind,
        who,
        to: e.to || null,
        missionId: e.missionId || null,
        img: e.img || null,
        text: e.text,
        ...(e.kind === 'react' ? { target: e.target, reaction: e.reaction } : {}),
    };
}
// Say the cap out loud. Loudly ONCE in the transcript, because a search box fires a request every few
// keystrokes and a sys line per capped search would bury the conversation being searched; on stdout
// every time, where it costs nothing and lands in the watchdog log.
let archiveCapAnnounced = false;
function noteArchiveCapped(stats) {
    const mb = Math.round(ARCHIVE_SCAN_CAP_BYTES / (1024 * 1024));
    console.warn('[search] archive scan stopped at the ' + mb + ' MB cap; chat older than '
        + stats.oldestScannedTs + ' was not read');
    if (archiveCapAnnounced) return;
    archiveCapAnnounced = true;
    record({ kind: 'sys', text: 'search: the chat archive is bigger than the ' + mb + ' MB scan cap, so chat older than '
        + stats.oldestScannedTs + ' is archived but not being searched. Raise JARVIS_ARCHIVE_SCAN_CAP to reach it.' });
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
    pendingSpawns.delete(cs);
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
            const owner = projectOwningCwd(loadProjects(), roster.sessions, cwd, loadMissions());
            if (owner) {
                const mgr = projectWorkerUid(owner.name);          // the new session is not in the roster yet, so this cannot self-match
                if (mgr && aliveNow(mgr)) { pproj = owner.name; autoBound = 'sub-worker'; }
                else { proj = owner.name; autoBound = 'coordinator'; }
                if (owner.ambiguous > 1) record({ kind: 'sys', text: 'auto-bind: ' + owner.ambiguous + ' active missions claim ' + cwdKey(cwd) + '; picked ' + owner.name + ' (most recent)' });
            }
        } catch { }   // an unreadable project store must never block a register
    }
    roster.callsigns[cs] = [uid, ...(roster.callsigns[cs] || [])];
    // How this worker was launched, recorded because after a hub restart it is the difference
    // between a corpse and a survivor. A console-less worker's host writes its pidfile before it
    // ever starts claude, so the file being here means this session is one — and the absence of one
    // means a wt tab or a session Chris started by hand, both of which outlive the hub on their own
    // and must be given a grace window rather than buried on sight.
    const launch = existsSync(workerPidfile(cs)) ? 'pty' : 'wt';
    roster.sessions[uid] = { callsign: cs, cwd: cwd || '', purpose: purpose || cs, started: now, ended: null, lastSeen: now, tier, launch, ...(proj ? { project: proj } : {}), ...(pproj ? { parentProject: pproj } : {}), ...(wt ? { worktree: wt.path, branch: wt.branch, base: wt.base } : {}) };
    if (wt) record({ kind: 'sys', text: cs + ' is isolated on ' + wt.branch + ' (worktree ' + wt.path + ', repo ' + cwdKey(cwd) + ')' });
    if (roster.awayUntil && Date.now() < roster.awayUntil) roster.sessions[uid].trustUntil = roster.awayUntil;
    saveRoster();
    // The session enters the reporting store the moment it exists (best-effort; see initStore).
    // Read back off the ROSTER ROW rather than the arguments so the live write and db.mjs's roster
    // backfill agree field for field: purpose falls back to the callsign there, and cwd was already
    // remapped from the worktree to the repo above.
    const srow = roster.sessions[uid];
    store('register ' + uid, (m, db) => m.upsertSession(db, {
        uid, callsign: cs, cwd: srow.cwd, purpose: srow.purpose,
        project: srow.project, parentProject: srow.parentProject, registeredAt: srow.started,
    }));
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
    // THE MORNING SCHEDULE PULL, asked rather than done. The hub cannot reach Google itself, so the
    // day's meetings only appear if a Calendar-capable session goes and gets them — which until now
    // depended on a human, or a worker, remembering. The decision is a pure helper; what lives here is
    // the state it cannot see. Best-effort throughout: a schedule file that will not load or a queue
    // that will not append must never cost somebody their registration.
    try {
        const sch = loadSchedule();
        const today = new Date().toDateString();
        if (shouldNudgeSchedulePull({ scheduleDate: sch.date, nudgedFor: sch.nudgedFor, today, sessionCwd: cwd, hubCwd: HERE, isSubWorker: !!pproj })) {
            // Stamp BEFORE queueing, so a failure to deliver cannot leave the day un-stamped and turn
            // the next register into a second ask.
            sch.nudgedFor = today;
            saveSchedule(sch);
            busAppend({
                from: 'jarvis', to: uid, kind: 'msg',
                text: 'The hub schedule is stale (' + (sch.date ? 'dated ' + sch.date : 'never pulled') + ', today is ' + today
                    + ') and the hub holds no Google credentials, so it cannot refresh itself. If you have Calendar access, list the'
                    + ' events for today and POST /schedule with them, then tell Chris what is on and flag any collisions.'
                    + ' If you have no Calendar access, say so in one line and drop it - nobody else will be asked today.',
            });
            record({ kind: 'sys', text: 'schedule stale (' + (sch.date || 'never pulled') + '); asked ' + cs + ' to pull today' });
        }
    } catch { }
    // Hand every worker the running build. This is the cheapest place to kill the "merged means
    // deployed" error for good: a session learns what code it is talking to before it does any work.
    const out = { uid, callsign: cs, build: BUILD };
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
    // Close the session out in the reporting store HERE, before any of the teardown below: the retire
    // is already a fact in the roster, so the record must not hinge on the pty kill or the worktree
    // teardown surviving. The identity fields ride along even though only retiredAt/summary are new:
    // both writes read the SAME roster row, so re-sending them is a no-op on a row that already has
    // them and COMPLETES one for a session that registered while the store was unavailable (or before
    // these hooks existed). Be precise about what db.mjs's COALESCE(excluded, existing) buys here --
    // it stops a NULL from wiping a value, NOT a non-null from replacing one. So it is passing the
    // roster's own values that makes these two writes order-independent, not the COALESCE.
    store('retire ' + uid, (m, db) => m.upsertSession(db, {
        uid, callsign: cs, cwd: s.cwd, purpose: s.purpose, project: s.project,
        parentProject: s.parentProject, registeredAt: s.started, retiredAt: s.ended, summary: s.summary,
    }));
    try { unlinkSync(join(DATA, 'spawn-' + cs + '.cmd')); } catch { } // its launch script is done with
    // A console-less worker runs in a ConPTY owned by its own pty-host process; with no window to
    // close, its idle claude process would otherwise linger forever after retire — and now that
    // the host deliberately outlives the hub, "forever" really is forever. Kill it here so
    // retiring actually reclaims the process. A successor (if any) is a separate host under a new
    // callsign, so this never touches the replacement. Falls through harmlessly for wt-tab workers
    // (no pidfile).
    try { killWorkerHost(cs); } catch { }
    // Worktree teardown, AFTER the pty is dead so nothing is still writing into the tree: commit any
    // in-flight WIP to the worker's branch, drop the directory, keep the branch (it is the
    // deliverable). The successor spawned below inherits that branch and continues on it.
    teardownWorktree(s, cs);
    // Free any merge lane this worker held (and take it out of any queue it was waiting in) BEFORE the
    // successor spawn below. A dead holder must never wedge the lane, and a retire is the one moment
    // we know for certain it is gone -- the stale sweep is only the backstop for workers that die
    // without saying so. The successor does not inherit: it re-requests, so an unfinished merge rejoins
    // the queue rather than being granted to a session that has not read the handoff yet.
    try { releaseBatonsFor(uid, cs); } catch (e) { logCrash('baton-release-on-retire-failed', e); }
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
        // ...and PUSH it to the live coordinator, which closes the delegation loop. The append above is
        // durable but PASSIVE: it lands in a store the manager has no reason to re-read, so a manager
        // that delegated could only notice its own delegate had finished by polling the project log --
        // busy-work for the one session that is supposed to stay thin and responsive. Deliver it to the
        // inbox it is already sitting on instead.
        //
        // Only a LIVE holder can be sent anything: a booting one has not registered (nothing would ever
        // read the event) and it rehydrates the project log on boot anyway, which is where the append
        // above is waiting for it. The retiring session can never BE that holder -- s.ended is stamped
        // at the top of this function, and a .parentProject sub-worker never holds the coordinator slot
        // regardless -- but compare the uid anyway, so neither invariant can quietly become a message
        // addressed to a corpse if a later change relaxes one of them.
        //
        // Its OWN try, not the append's: an unreadable project store must not cost the coordinator its
        // notification, and neither failure may ever block the retire.
        try {
            const pc = coordinatorHeld(s.parentProject);
            if (pc && pc.kind === 'live' && pc.uid && pc.uid !== uid) {
                busAppend({ from: 'jarvis', to: pc.uid, kind: 'msg', text: 'your sub-worker ' + cs + ' retired: ' + s.summary });
            }
        } catch (e) { logCrash('subworker-retire-notify-failed', e); }
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
        if (!opts.quiet) enqueueSay(psucc ? s.project + ' worker handed off.' : (held ? s.project + ' worker retired; ' + (held.callsign || 'another session') + ' still has it.' : s.project + ' worker retired; the card is idle.'), 'jarvis');
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
    // opts.quiet: boot reconciliation can bury a whole fleet at once, and one spoken line per corpse
    // would be a minute of Chris being read a casualty list. The caller speaks a single summary.
    if (!opts.quiet) enqueueSay(opts.spoken || (cs + ' retired.' + (summary ? ' ' + summary : '')), 'jarvis');
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
// Where Claude Code keeps its per-directory trust decisions. JARVIS_CLAUDE_CONFIG is a test seam:
// nothing in the suite may go anywhere near the real one.
const CLAUDE_HOME = process.env.USERPROFILE || process.env.HOME || '';
const CLAUDE_JSON = process.env.JARVIS_CLAUDE_CONFIG || (CLAUDE_HOME ? join(CLAUDE_HOME, '.claude.json') : '');
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
// Register a freshly created worktree as trusted, so its worker boots into its job instead of into
// Claude Code's folder-trust prompt. claudeTrustPatch (jarvis-text.mjs) carries the measurements and
// the argument for why this is the hub's decision to make.
//
// Everything here is shaped to be UNABLE to hurt that file. It is the human's live global config --
// mcpServers, oauthAccount, every project's history -- and losing it would be far worse than a worker
// stopping on a prompt. So: read-modify-write rather than composing a new document; refuse to write at
// all unless the existing file parsed, because writing a fresh minimal file over a transient read
// failure is precisely how a config gets wiped; the same 2-space JSON the file already uses, so
// Claude Code's own next write is not a whole-file reformat; atomicWrite, so a crash mid-write cannot
// truncate it; and never throw, because a hub that dies inside spawnWorker is worse than the bug.
//
// Known and accepted race: another live claude session holds this file in memory and writes its own
// full copy on exit, which can drop the flag we just set. The failure mode of losing that race is
// exactly today's behaviour -- the worker meets the prompt -- so it is not worth locking the human's
// config over.
function trustWorktreePath(p) {
    try {
        if (!p || !CLAUDE_JSON || !existsSync(CLAUDE_JSON)) {
            record({ kind: 'sys', text: 'no trust mark for ' + p + ': ' + (CLAUDE_JSON || 'no home dir') + ' not found; the worker may stop on the folder-trust prompt' });
            return false;
        }
        let cfg;
        try { cfg = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')); }
        catch (e) {
            record({ kind: 'sys', text: 'no trust mark for ' + p + ': could not parse ' + CLAUDE_JSON + ' (' + (e && e.message) + '); leaving it ALONE' });
            return false;
        }
        const next = claudeTrustPatch(cfg, p);
        if (!next) return true;                  // already trusted -- touching the file would be gratuitous
        atomicWrite(CLAUDE_JSON, JSON.stringify(next, null, 2));
        return true;
    } catch (e) {
        try { record({ kind: 'sys', text: 'trust mark errored for ' + p + ' (' + (e && e.message) + '); continuing' }); } catch { }
        return false;
    }
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
        // BEFORE the worker launches, not after: claude reads its trust state the instant it starts
        // in this directory, and there is no second chance to answer the dialog console-lessly.
        trustWorktreePath(plan.path);
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
        const ok = gitOut(repoCwd, ['worktree', 'remove', wtPath, '--force'], WT_TIMEOUT) !== null;
        gitOut(repoCwd, ['worktree', 'prune'], WT_TIMEOUT);
        // git's exit code is not proof the directory is gone. Measured 2026-07-27 in a throwaway
        // repo: with a node_modules JUNCTION inside the worktree (what a worker needs to run a hub
        // from one at all), `worktree remove --force` exits 0, drops the entry from `worktree list`
        // and deletes every real file -- then leaves the directory, junction included, on disk. And
        // because git has already forgotten the worktree, the `prune` above cannot finish the job,
        // so it is stranded for good. It does NOT follow the junction; the real node_modules is
        // safe. The damage is purely that we logged a removal that did not happen. Ask the
        // filesystem, which is the thing the claim is actually about.
        const gone = !existsSync(wtPath);
        record({ kind: 'sys', text: !ok
            ? 'worktree remove FAILED for ' + cs + ' at ' + wtPath + '; branch ' + branch + ' kept'
            : gone
                ? 'worktree for ' + cs + ' removed; branch ' + branch + ' kept for merge'
                : 'git reported removing ' + cs + ' worktree but ' + wtPath + ' is STILL THERE (a junction or open handle inside blocks it, and git has already forgotten the worktree so prune cannot help); branch ' + branch + ' kept' });
        return ok && gone ? 'removed' : 'kept';
    } catch (e) {
        try { record({ kind: 'sys', text: 'worktree teardown errored for ' + cs + ' (' + (e && e.message) + '); ' + wtPath + ' left in place' }); } catch { }
        return 'kept';
    }
}
// ---- restart resilience -------------------------------------------------------------------
// Everything down to sweepWorktrees exists because a console-less worker now OUTLIVES the hub.
// Three things that used to be true by construction have to be re-established by hand on the way
// back up: which workers are still running, which roster rows are corpses, and which spawns were
// still in flight when the hub went down.

// Every worker host with a live process behind it, keyed by callsign. A pidfile whose host is gone
// is deleted on sight: it is a lie, and an uncollected one would spare a dead worker's worktree
// from the sweep forever.
function liveWorkerHosts() {
    const out = new Map();
    let files = [];
    try { files = readdirSync(DATA); } catch { return out; }
    for (const f of files) {
        const m = /^worker-(.+)\.pid$/i.exec(f);
        if (!m) continue;
        let rec = null;
        try { rec = JSON.parse(readFileSync(join(DATA, f), 'utf8')); } catch { }
        if (rec && rec.hostPid && hostAlive(rec.hostPid)) out.set(rec.cs || m[1], rec);
        else { try { unlinkSync(join(DATA, f)); } catch { } }
    }
    return out;
}
// A worker's launch config carries its whole boot prompt, and pty-host.mjs deletes it the moment it
// has been read — so a config still sitting on disk means the host died before parsing it, and no
// pidfile was ever written to give liveWorkerHosts a way to notice. Left alone they accumulate
// forever, each one a stale copy of a brief.
//
// Only files older than the grace window are collected, which sidesteps the one race here: a config
// written by the previous hub in the instant before it died, whose host is still on its way up.
function collectDeadWorkerConfigs(hosts) {
    let files = [];
    try { files = readdirSync(DATA); } catch { return 0; }
    let n = 0;
    for (const f of files) {
        const m = /^worker-(.+)\.json$/i.exec(f);
        if (!m || (hosts && hosts.has(m[1]))) continue;
        const p = join(DATA, f);
        try {
            if (Date.now() - statSync(p).mtimeMs < READOPT_GRACE_MS) continue;
            unlinkSync(p); n++;
        } catch { }
    }
    if (n) record({ kind: 'sys', text: 'boot reconcile: collected ' + n + ' unread worker launch config(s)' });
    return n;
}
// A ghost is a roster row with no process behind it — what the old design produced on EVERY
// restart, and what Chris sees as /roster reporting five live sessions when two processes exist.
// Two grades of evidence, because being wrong either way is expensive:
//   provable  — launched console-less (`launch:'pty'`) and no live host. Dead, full stop.
//   suspected — no host, but it might be a wt-tab worker (JARVIS_CONSOLELESS=0) or a session Chris
//               started by hand; both legitimately outlive the hub and never had a pidfile.
// lastSeen cannot settle the suspected case at boot, because it is frozen at whatever it was
// before the restart: a survivor of a slow restart reads cold, a corpse of a fast one reads warm.
// So suspected rows get a grace window to prove themselves by polling, and are judged after it.
// The classification itself is pure and lives in jarvis-text (reconcileRoster) with its own tests —
// it is the part of this that is easy to get subtly wrong and impossible to exercise by hand.
const READOPT_GRACE_MS = Number(process.env.JARVIS_READOPT_GRACE_MS || 90000);
function buryGhosts(ghosts, why) {
    if (!ghosts.length) return 0;
    for (const g of ghosts) {
        // The ordinary retire path, deliberately: it commits the worktree WIP to the branch, archives
        // the session, and files the full board under the cwd+purpose handoff key so the next worker
        // on that job inherits it. NEVER with a successor — one guardian firing can produce a fleet of
        // these at once, and spawning off corpses is exactly how a swarm gets minted.
        try { retireSession(g.uid, why, { successor: false, quiet: true }); } catch { }
    }
    record({ kind: 'sys', text: 'boot reconcile: buried ' + ghosts.length + ' ghost session(s) - ' + ghosts.map(g => g.cs).join(', ') });
    return ghosts.length;
}
// Spawn-in-flight state lives in module-global Maps that a restart wipes. That was harmless while a
// restart also killed the booting ConPTY -- respawning afterwards was then the CORRECT behaviour,
// because nothing was coming up any more. This change kills that premise: the booting worker now
// survives, registers a minute later, and finds its callsign reissued or its project already
// coordinated. Rebuild from the pidfiles, the only record that outlived the hub.
//
// MUST run after the burial: the "already registered" test reads `ended`, and until the corpses are
// buried every one of them still reads unended.
function restoreBootingState(hosts) {
    const registered = new Set();
    for (const uid in roster.sessions) {
        const s = roster.sessions[uid];
        if (s && !s.ended && s.callsign) registered.add(s.callsign);
    }
    let n = 0;
    for (const [cs, rec] of hosts) {
        if (registered.has(cs)) continue;      // it came up already; a bind for it now is a phantom
        const parsed = Date.parse(rec.spawnedAt);
        // The real spawn time, not boot time, so staleness measures how long the worker has actually
        // been failing to come up rather than resetting its clock on every restart.
        const at = Number.isFinite(parsed) ? parsed : Date.now();
        pendingPins.set(cs, at);               // stops assignCallsign reissuing a name that is in use
        if (rec.project || rec.parentProject) pendingBind.set(cs, { project: rec.project || null, parentProject: rec.parentProject || null, ts: at });
        // Without this the worker registers with no worktree on its session row, and the sweep then
        // sees an unclaimed directory and tears it down underneath a live worker.
        if (rec.worktree && rec.worktree.path) pendingWorktree.set(cs, { ...rec.worktree, ts: at });
        n++;
    }
    if (n) record({ kind: 'sys', text: 'boot reconcile: ' + n + ' worker(s) still booting; spawn state restored' });
    return n;
}
// The seam yankee's coordinator-uniqueness predicate takes as a parameter. pendingBind is the
// container on purpose: it already carries {project,parentProject,ts} for every spawn site, and
// takePendingBind deletes on register, which is what makes membership mean "booting" rather than
// "bound". Handing over the map itself keeps one source of truth, so the predicate cannot drift
// from this restore the way boardKeyFor and nextFocusKey drifted apart in 14f3ad4.
function bootingCoordinators() {
    return pendingBind;
}
// Boot orchestration. The ORDER is load-bearing; see the note on restoreBootingState.
function reconcileWorkersOnBoot() {
    const hosts = liveWorkerHosts();
    const first = reconcileRoster(roster.sessions, new Set(hosts.keys()), Date.now(), { provableOnly: true });
    if (first.readopt.length) {
        // Re-adopting is mostly just declining to treat them as dead. Stamp `launch` while we are
        // here so rows written by an older hub (which never recorded it) are provable next restart.
        for (const r of first.readopt) { const s = roster.sessions[r.uid]; if (s) s.launch = 'pty'; }
        record({ kind: 'sys', text: 'boot reconcile: re-adopted ' + first.readopt.length + ' live worker(s) - ' + first.readopt.map(r => r.cs).join(', ') });
    }
    const buried = buryGhosts(first.ghosts, 'Lost when the hub restarted');
    restoreBootingState(hosts);
    saveRoster();
    // Revalidate the merge lanes now that the corpses are `ended`: a holder or queue entry the restart
    // buried has to leave, or the lane comes back up shut with nobody able to release it. staleMs
    // Infinity keeps this to what is PROVABLY gone -- every survivor's lastSeen is still frozen at
    // pre-restart, so a staleness reap here would rob a worker that is very much alive. Quiet, because
    // buryGhosts already speaks for the whole fleet and one line per lane would be a casualty list.
    try { reapBatons({ staleMs: Infinity, quiet: true }); } catch (e) { logCrash('baton-boot-revalidate-failed', e); }
    if (buried) enqueueSay('Back up. ' + buried + (buried === 1 ? ' session did not survive the restart.' : ' sessions did not survive the restart.'), 'jarvis');
    // The suspected rows and the worktree sweep both wait out the grace window: a wt-tab survivor
    // deserves the chance to poll before it is judged, and the sweep must not run while any live
    // worker's claim on its directory is still unproven.
    setTimeout(() => {
        try {
            const late = liveWorkerHosts();
            const n = buryGhosts(reconcileRoster(roster.sessions, new Set(late.keys()), Date.now(), {}).ghosts,
                'Gone by the time the hub came back');
            if (n) saveRoster();
            // Say it. This pass looks like the rare one -- in steady state it only ever catches a wt
            // tab or a hand-started session that failed to check in -- but on the FIRST boot after
            // this change lands it catches the entire pre-existing roster at once, because rows
            // written by an older hub carry no `launch` and so cannot be judged until now. Silence
            // there means Chris watches the roster empty itself a minute and a half after boot with
            // nothing said, which reads exactly like the bug he asked us to fix.
            if (n) enqueueSay('Roster reconciled. Cleared ' + n + (n === 1 ? ' session that never came back.' : ' sessions that never came back.'), 'jarvis');
            // No second baton revalidation here, deliberately. Every session buried by THIS pass goes
            // through retireSession, which releases its lane and clears it from every queue on the way
            // past -- so a reap here could only ever repeat what the burial just did. What the boot
            // revalidation above catches is the case no burial can: a holder the roster has never heard
            // of (a store left by an earlier roster, a hand-edited file). Adding a copy that no probe
            // can distinguish from a no-op is how a rule stops being checked.
            collectDeadWorkerConfigs(late);
            sweepWorktrees(late);
        } catch { }        // a reconcile failure must never take the hub down
    }, READOPT_GRACE_MS);
}
// Worktree sweep. A worktree whose owner is gone has to be collected, or the disk fills with dead
// checkouts and a recycled callsign trips over its own leftover directory and silently loses
// isolation. Prune each repo's stale administrative entries, then tear down any directory under a
// WT_ROOT that nothing claims (WIP committed to its branch first — the sweep loses nothing).
//
// This used to run at boot on the assumption that a restart had killed every console-less worker,
// so every worktree it found was by definition abandoned. That assumption is now FALSE and the
// consequence is not cosmetic: run it unchanged and it deletes the working directory out from
// under a live worker, taking uncommitted work with it. Hence `hosts` — a live host pid is a
// deterministic claim on a directory — and hence the caller deferring this until after the
// re-adoption grace window. Do not call it at boot again.
function sweepWorktrees(hosts) {
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
        // Two claims that outrank the heartbeat test inside orphanWorktrees: a live host pid (the
        // worker is provably running, whatever its lastSeen says) and a pending worktree (cut for a
        // worker that has not registered yet, so no session row mentions it at all).
        const claimed = [];
        for (const rec of (hosts || new Map()).values()) if (rec && rec.worktree && rec.worktree.path) claimed.push(rec.worktree.path);
        for (const v of pendingWorktree.values()) if (v && v.path) claimed.push(v.path);
        const orphans = orphanWorktrees(dirs, roster.sessions, Date.now(), { claimed });
        for (const p of orphans) {
            // A worktree's .git is a FILE pointing at the parent repo. No .git at all means this is
            // some other directory that wandered into WT_ROOT — never touch it.
            if (!existsSync(join(p, '.git'))) continue;
            const owner = Object.values(roster.sessions).find(x => x && x.worktree && cwdKey(x.worktree) === cwdKey(p));
            const common = gitOut(p, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
            const repoCwd = (owner && owner.cwd) || (common ? dirname(common.replace(/\\/g, '/').replace(/\/+$/, '')) : '');
            teardownWorktree({ worktree: p, cwd: repoCwd, branch: (owner && owner.branch) || gitOut(p, ['rev-parse', '--abbrev-ref', 'HEAD']) || '?', purpose: 'left behind by a dead session' },
                (owner && owner.callsign) || 'a dead session');
        }
        if (orphans.length) record({ kind: 'sys', text: 'boot sweep: collected ' + orphans.length + ' orphaned worktree' + (orphans.length === 1 ? '' : 's') });
    } catch { }   // a sweep failure must never block the hub coming up
}
// ---- commit baton: one serialized merge lane per repo (docs/COMMIT-BATON-DESIGN.md) -----------
// P2 of the worktree work above, and deliberately adjacent to it: isolation stops workers clobbering
// each other's FILES, the baton stops them clobbering each other's MERGES. It gates the merge lane
// only -- everything else stays parallel -- and the hub never runs `git merge` itself. It hands out
// turns; the worker does the work, in its own worktree, against a fresh base.
//
// The decisions (grant / queue / release / revoke) are pure helpers in jarvis-text.mjs with unit tests
// in test/baton.test.mjs. What lives here is the four things they cannot know: the file, the roster,
// the git call that names the base, and the event that wakes the worker whose turn it is.
const BATONS = join(DATA, 'batons.json');
// The store is one lane per repo key, keyed exactly as resolveRepo().key -- so jarvis-core and tms
// have independent lanes and can never block each other. A bare map (repos.json's shape, not
// missions.json's {version, missions:[]}) because the design's shape is `{ "tms": {lane} }` and a
// `version` key alongside repo keys would read as a repo called version.
function loadBatons() {
    if (existsSync(BATONS)) {
        let raw = null, bad = false;
        try { raw = JSON.parse(readFileSync(BATONS, 'utf8')); } catch { bad = true; }
        // Valid JSON of the WRONG SHAPE gets the same treatment as unparseable. Falling through to an
        // empty store would mean the next save silently overwrote the only copy, which is the one
        // thing every state file here promises not to do.
        if (!bad && (!raw || typeof raw !== 'object' || Array.isArray(raw))) bad = true;
        if (bad) backupCorrupt(BATONS);
        else {
            const out = {};
            for (const k of Object.keys(raw)) out[k] = normalizeLane(raw[k]);
            return out;
        }
    }
    return {};
}
function saveBatons(b) {
    atomicWrite(BATONS, JSON.stringify(b, null, 1));
}
// The integration branch a lane's merges land on. Resolved from the repo's own checkout the SAME way
// the worktree path resolves a fork point (worktreeBase), so isolation and the baton can never
// disagree about what "the base" is. null means we could not name one, and the holder falls back to
// whatever branch the repo is on -- which is what it would have merged into anyway.
function laneBase(repoKey, sessionCwd) {
    try {
        const row = loadRepos()[repoKey] || null;
        // A caller may name a lane for a repo it is not sitting in (the console forcing a lane it can
        // see on the board). Only trust the session's cwd when it really is that repo, or the lane
        // would be stamped with a base read out of somebody else's checkout.
        const cwd = (row && row.cwd) || (sessionCwd && resolveRepo(sessionCwd).key === repoKey ? sessionCwd : '');
        if (!cwd || !existsSync(cwd)) return null;
        const head = gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (head === null) return null;
        const originHead = gitOut(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
        return worktreeBase(head, row && row.base, (originHead || '').replace(/^origin\//, ''));
    } catch { return null; }
}
// Which lane a request means: an explicit `repo` wins, else the repo the session is working on. A
// session's cwd is the REPO (registerSession stores the repo and keeps the worktree beside it), so an
// isolated worker resolves to the same lane as a shared-cwd one -- they are merging into the same
// branch, which is the entire thing being serialized.
function batonRepoKey(s, bodyRepo) {
    const named = String(bodyRepo || '').toLowerCase().trim().replace(/[^a-z0-9_.-]/g, '');
    if (named) return named;
    if (!s || !s.cwd) return null;
    try { return resolveRepo(s.cwd).key || null; } catch { return null; }
}
const batonWho = (e) => (e && (e.cs || e.uid)) || '?';
// The grant is an EVENT, not something a waiting worker polls for. A queued worker parks on its
// ordinary poll loop -- zero tokens while idle, the existing rule for idle sessions -- and is woken
// when the lane becomes its turn, exactly like speech and msg. The text carries the recipe rather
// than a bare "your turn" because the worker has to merge the fresh base FIRST, in its own tree.
//
// Only a QUEUE->HOLDER transition is evented. A worker granted the lane synchronously by its own
// request already has the answer in the response, and waking it to repeat that costs a turn.
function notifyBatonGrant(repoKey, lane, holder) {
    if (!holder || !holder.uid) return;
    busAppend({
        from: 'jarvis', to: holder.uid, kind: 'baton',
        text: 'baton granted: ' + repoKey + ' (base ' + ((lane && lane.base) || 'unknown') + '). Merge the fresh base into YOUR worktree first, run the gate there, then merge your branch into the base and POST /baton {"op":"release","uid":"<uid>","merged":true}.',
    });
}
// When the hub last saw a session: epoch ms, or null when it is retired or gone from the roster.
// This is the reaper's whole view of liveness, and it is deliberately NOT aliveNow(): that is a
// 2-minute window, and a worker running a full build gate legitimately goes minutes without polling.
// Measuring the raw signal lets the lane wait BATON_STALE_MS instead of punishing a long turn.
function batonSeenAt(uid) {
    const s = roster.sessions[uid];
    if (!s || s.ended) return null;
    const t = Date.parse(s.lastSeen || s.started);
    return Number.isFinite(t) ? t : null;
}
// Take lanes back off holders that are gone and clear dead workers out of the queues. A lane that
// depends on a worker staying healthy is a lane that wedges -- the wedged-worker failure mode that
// took primeng down on 2026-07-24 -- so this runs on a timer, at boot, and on every /baton call.
//
// opts.staleMs Infinity is the BOOT rule: sweep only what is provably gone (retired/missing) and
// ignore the clock, because right after a restart every survivor's lastSeen is frozen at whatever it
// was before the hub went down and would read as five minutes quiet.
// opts.quiet suppresses the spoken line (boot can bury a fleet at once; one voice line per lane
// would be a casualty list).
// The stale window, overridable. The design calls 5 minutes a DEFAULT, and this is the only knob that
// makes the sweep exercisable at all: a test that had to wait out five real minutes to watch a lane be
// reclaimed would not get written, and an unexercised sweep is the half of this feature most likely to
// be wrong (it is the one that fires when nobody is watching). A non-positive/garbage value means the
// default -- never zero, which would revoke a holder the instant it stopped polling.
const BATON_STALE = (() => { const v = Number(process.env.JARVIS_BATON_STALE_MS); return v > 0 ? v : BATON_STALE_MS; })();
function reapBatons(opts = {}) {
    const staleMs = opts.staleMs === Infinity || Number.isFinite(opts.staleMs) ? opts.staleMs : BATON_STALE;
    let store;
    try { store = loadBatons(); } catch { return false; }
    const grants = [];
    let dirty = false;
    for (const key of Object.keys(store)) {
        const r = batonReap(store[key], batonSeenAt, Date.now(), staleMs);
        if (!r.revoked && !r.dropped.length) continue;
        store[key] = r.lane;
        dirty = true;
        if (r.revoked) {
            record({ kind: 'sys', text: 'merge lane ' + key + ' reclaimed from ' + batonWho(r.revoked) + ' (gone)' + (r.grantedTo ? ' -> ' + batonWho(r.grantedTo) : ' (free)') });
            if (!opts.quiet) enqueueSay('Merge lane reclaimed from ' + batonWho(r.revoked) + '.', 'jarvis');
        }
        if (r.dropped.length) record({ kind: 'sys', text: 'merge lane ' + key + ' dropped ' + r.dropped.length + ' dead queue entr' + (r.dropped.length === 1 ? 'y' : 'ies') + ': ' + r.dropped.map(batonWho).join(', ') });
        if (r.grantedTo) grants.push([key, r.lane, r.grantedTo]);
    }
    // Persist BEFORE waking anyone. A worker told it holds the lane must never be able to ask and be
    // told it does not, which is what an event pushed ahead of a failed write would produce.
    if (dirty) {
        try { saveBatons(store); } catch (e) { logCrash('baton-save-failed (reap)', e); return false; }
        for (const [k, lane, holder] of grants) notifyBatonGrant(k, lane, holder);
    }
    return dirty;
}
// Nobody has to ask for the sweep to happen: a lane whose holder died silently would otherwise stay
// shut until the next /baton call, and the workers who would make that call are the ones being
// blocked. .unref() so it never keeps the process alive on its own.
//
// The period follows the window rather than being its own number, because the two are one decision:
// sweeping every 30s against a 2s window (or every 30s against a window shortened for a test) would
// mean the lane's reclaim time was really the sweep period all along. Clamped to [5s, 30s] -- the
// floor stops a tiny window turning this into a busy loop, and 30s is as slow as it gets.
const BATON_SWEEP_MS = Math.min(30000, Math.max(5000, BATON_STALE));
setInterval(() => { try { reapBatons(); } catch (e) { logCrash('baton-reap-failed', e); } }, BATON_SWEEP_MS).unref();
// Retire releases. The stale sweep is the backstop for a worker that dies without saying so; a retire
// is the case where we KNOW it is gone, so the lane should move on immediately rather than sit shut
// for five minutes. Called from retireSession before any successor is spawned -- and a successor
// deliberately does NOT inherit the baton: it re-requests, so an unfinished merge goes back into the
// fair queue instead of being handed to a session that has not read the handoff yet.
//
// Blind across every lane, because a worker can hold one lane while queued on another.
function releaseBatonsFor(uid, cs) {
    let store;
    try { store = loadBatons(); } catch { return; }
    const grants = [];
    let dirty = false;
    for (const key of Object.keys(store)) {
        const lane = store[key];
        if (lane.holder && lane.holder.uid === uid) {
            const r = batonRelease(lane, uid, Date.now());
            store[key] = r.lane;
            dirty = true;
            record({ kind: 'sys', text: 'merge lane ' + key + ' released by ' + (cs || uid) + ' on retire' + (r.grantedTo ? ' -> ' + batonWho(r.grantedTo) : ' (free)') });
            if (r.grantedTo) grants.push([key, r.lane, r.grantedTo]);
        } else if (lane.queue.some(e => e.uid === uid)) {
            store[key] = batonCancel(lane, uid).lane;
            dirty = true;
            record({ kind: 'sys', text: (cs || uid) + ' left the ' + key + ' merge queue on retire' });
        }
    }
    if (dirty) {
        try { saveBatons(store); } catch (e) { logCrash('baton-save-failed (retire)', e); return; }
        for (const [k, lane, holder] of grants) notifyBatonGrant(k, lane, holder);
    }
}
// One lane, shaped for a caller: queue positions spelled out so nobody has to count, and `waiting` so
// the console can render "2 waiting" without walking the array.
function batonView(key, lane) {
    const l = lane || normalizeLane(null);
    return {
        repo: key,
        base: l.base,
        holder: l.holder,
        queue: l.queue.map((e, i) => ({ ...e, position: i + 1 })),
        waiting: l.queue.length,
        lastHandoff: l.lastHandoff,
    };
}
// Console-less worker spawning. A worker's only channel to Chris is this hub (board/chat/perm
// cards over HTTP), so its terminal window is pure crash-exposure: combining DOS/console windows
// tears that console down and kills the worker. node-pty runs claude inside an invisible ConPTY
// (a real pseudo-TTY, so claude runs its normal persistent interactive session) with NO window
// for a combine to reach. Default ON; set JARVIS_CONSOLELESS=0 to fall back to wt tabs.
//
// The ConPTY used to be owned by the hub itself, which quietly made the hub's lifetime the
// fleet's lifetime — a restart, a crash, or one guardian.mjs `taskkill /F /T` on the supervisor
// killed every worker, while the console's Restart tooltip went on promising "live sessions
// survive". Now each worker gets its own pty-host.mjs process, launched THROUGH orphan-spawn.mjs
// so it is not a descendant of the supervisor and /T cannot walk to it. The hub keeps no handle:
// the host's pidfile in JARVIS_DATA is the handle, which is the whole point, because a pid on
// disk is the only kind of handle that survives the hub restarting.
const CONSOLELESS = process.env.JARVIS_CONSOLELESS !== '0';
const requireCjs = createRequire(import.meta.url);
let ptyMod = null, ptyTried = false;
function getPty() {
    if (!ptyTried) {
        ptyTried = true;
        try { ptyMod = requireCjs('node-pty'); } catch { ptyMod = null; }
        // SAY IT OUT LOUD, once. Without node-pty every spawn silently takes the wt-tab path: real
        // terminal windows appear, a window-combine can now kill a worker, and nothing about the
        // roster or the board looks any different. That silence cost alpha three verification runs
        // on 2026-07-27 -- it ran the hub from a git WORKTREE, which has no node_modules of its own,
        // so the whole restart-survival mechanism was never entered while the tests stayed green.
        if (!ptyMod && CONSOLELESS) {
            record({ kind: 'sys', text: 'node-pty did not resolve from ' + HERE + ' -- console-less spawning is OFF and workers will open visible wt tabs. '
                + 'Running from a git worktree? A worktree has no node_modules: set NODE_PATH to the main checkout\'s node_modules, or npm install here.' });
            enqueueSay('Heads up: console-less spawning is unavailable, so workers will open terminal windows.', 'jarvis');
        }
    }
    return ptyMod;
}
const workerPidfile = (cs) => join(DATA, 'worker-' + cs + '.pid');
function readWorkerPidfile(cs) {
    try { const r = JSON.parse(readFileSync(workerPidfile(cs), 'utf8')); return (r && r.hostPid) ? r : null; }
    catch { return null; }
}
// Liveness of a recorded host pid. `process.kill(pid,0)` alone would be fooled by PID reuse — and
// a false "alive" is the expensive direction here, since it would leave a ghost session on the
// roster and spare a dead worker's worktree from the sweep forever. So confirm the pid is still a
// node process, the same tasklist check guardian.mjs uses (wmic is gone on Win11 26200; the
// replacement is Get-CimInstance, but tasklist is cheaper and already the house pattern).
function hostAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
    try { return /node\.exe/i.test(execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { encoding: 'utf8', timeout: 8000 })); }
    catch { return false; }
}
function spawnWorkerConsoleless(cs, repo, boot, model, hookSettings, meta) {
    // Probe node-pty HERE even though the host is what actually uses it: the wt-tab fallback
    // decision has to be made synchronously, and the host resolves the module from the same
    // node_modules this process does.
    if (!getPty()) return false;
    // Both the pidfile and the log are keyed by CALLSIGN, so reusing a name whose host is somehow
    // still running would overwrite the only record of that host's pid — leaving a process nothing
    // can ever kill, still holding a claude session and still claiming a worktree. Retire clears the
    // pidfile, so in the ordinary case there is nothing here and this costs one failed stat. The
    // case it covers is a host whose claude never registered (wedged on a prompt, say): its pin
    // reservation expires after five minutes and the callsign becomes issuable again while the
    // process lives on. Taking the name means taking the handle, so take the process too.
    try { killWorkerHost(cs); } catch { }
    const args = [];
    if (repo.permissionMode) args.push('--permission-mode', repo.permissionMode);
    const md = model || repo.model;
    if (md) args.push('--model', md);
    if (hookSettings) args.push('--settings', hookSettings);
    args.push(boot);
    const cfgPath = join(DATA, 'worker-' + cs + '.json');
    // The boot prompt travels as a JSON FILE, never as argv. It is a paragraph of quotes,
    // semicolons and URLs, and launch config has been silently lost in transit twice already
    // (a757af9, 2273b18) — adding a process hop on a command line would have widened exactly
    // that blast radius. pty-host.mjs deletes the file the moment it has read it.
    //
    // `meta` is what re-adoption needs after a restart and cannot recover from anywhere else:
    // the binding (so pendingBind can be restored for a worker still booting) and the worktree
    // (so the sweep knows the directory is claimed, and so registerSession can still hand the
    // session its branch). Both live only in hub memory today and a restart wipes them.
    try {
        writeFileSync(cfgPath, JSON.stringify({
            cs,
            claude: resolveClaude(),
            args,
            cwd: repo.cwd,
            env: { JARVIS_CALLSIGN: cs, JARVIS_PORT: String(PORT) },
            log: join(DATA, 'worker-' + cs + '.log'),
            pidfile: workerPidfile(cs),
            spawnedAt: new Date().toISOString(),
            project: (meta && meta.project) || null,
            parentProject: (meta && meta.parentProject) || null,
            worktree: (meta && meta.worktree) || null,
        }, null, 1));
    } catch { return false; }
    try {
        const child = spawn(process.execPath, [join(HERE, 'orphan-spawn.mjs'), join(HERE, 'pty-host.mjs'), cfgPath],
            { cwd: HERE, detached: true, windowsHide: true, stdio: 'ignore' });
        child.unref();
    } catch { try { unlinkSync(cfgPath); } catch { } return false; }
    return true;
}
// Retire's end of the deal. The hub no longer holds a pty handle to kill, so it kills the
// recorded host pid instead. /T is correct and tightly scoped here in a way it never was on the
// supervisor: claude genuinely is this host's own child, and nothing else is under that pid.
function killWorkerHost(cs) {
    const rec = readWorkerPidfile(cs);
    try { unlinkSync(workerPidfile(cs)); } catch { }
    try { unlinkSync(join(DATA, 'worker-' + cs + '.json')); } catch { }   // never-read config, if the host died early
    if (!rec || !hostAlive(rec.hostPid)) return false;
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(rec.hostPid)], { stdio: 'ignore', timeout: 10000 }); }
    catch { return false; }
    return true;
}
// Spawns the hub has LAUNCHED but that have not registered yet. POST /spawn answers the instant the
// pty starts, so from that moment until POST /register the worker is invisible: no roster row, no
// error, nothing in the transcript past "spawned" -- and a launch that died looks exactly like one
// that is merely slow. This stash is what makes the two distinguishable. The measurements behind the
// window, and the reasoning about which way to be wrong, are on SPAWN_REGISTER_TIMEOUT_MS in
// jarvis-text.mjs. The env override exists so tests can run the real path in seconds.
const pendingSpawns = new Map();
const SPAWN_TIMEOUT_MS = Number(process.env.JARVIS_SPAWN_TIMEOUT_MS) > 0 ? Number(process.env.JARVIS_SPAWN_TIMEOUT_MS) : SPAWN_REGISTER_TIMEOUT_MS;
const SPAWN_SWEEP_MS = Math.min(15000, Math.max(2000, Math.round(SPAWN_TIMEOUT_MS / 6)));
// The last few never-registered spawns, so /roster (and so the console, and any session that asks)
// can SHOW the failure instead of everyone grepping the transcript for a gap. Deliberately in memory
// and capped: the durable, searchable copy is the sys line, this is only the live view.
const deadSpawns = [];
function watchSpawn(cs, cwd, repoKey, log) {
    pendingSpawns.set(cs, { cs, cwd: cwd || '', repoKey: repoKey || '', log: log || null, at: Date.now() });
}
// The tail of a worker's log, which is where the answer has actually been every time one of these
// died. pty-host truncates this file as it starts, so whatever is in it belongs to THIS spawn.
function readLogTail(path, maxBytes = 65536) {
    try {
        if (!path) return '';
        const size = statSync(path).size;
        if (!size) return '';
        const len = Math.min(size, maxBytes);
        const fd = openSync(path, 'r');
        try {
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, size - len);
            return buf.toString('utf8');
        } finally { closeSync(fd); }
    } catch { return ''; }
}
// Notice the spawns that never came up, say so, and give their reservations back.
//
// Freeing the pin EARLY is the part that needs care. pendingPins / pendingTier / pendingBind /
// pendingWorktree all expire on the SAME five-minute window on purpose, so that a reservation can
// never outlive its pin and attach itself to the stranger who inherits the callsign next (the
// argument is written out on pendingBind). Handing the name back sooner means honouring that sooner
// too -- so all four go together here, or a dead TRUSTED spawn would lend its tier, or its project
// binding, to whoever gets the name. The worktree is released but never torn down: it is evidence,
// and the orphan sweep already owns collecting it.
function sweepDeadSpawns() {
    if (!pendingSpawns.size) return;
    const now = Date.now();
    for (const e of overdueSpawns(pendingSpawns.values(), roster.sessions, now, SPAWN_TIMEOUT_MS)) {
        pendingSpawns.delete(e.cs);
        pendingPins.delete(e.cs);
        pendingTier.delete(e.cs);
        takePendingBind(e.cs);
        takePendingWorktree(e.cs);
        const reason = diagnoseSpawnLog(readLogTail(e.log));
        record({ kind: 'sys', text: deadSpawnNote(e, reason, now) });
        deadSpawns.unshift({ callsign: e.cs, cwd: e.cwd, repoKey: e.repoKey, log: e.log, reason: reason || null, at: new Date(e.at).toISOString() });
        if (deadSpawns.length > 10) deadSpawns.length = 10;
        enqueueSay(e.cs + ' never came up. Details in chat.', 'jarvis');
    }
}
setInterval(() => { try { sweepDeadSpawns(); } catch (e) { logCrash('dead-spawn-sweep-failed', e); } }, SPAWN_SWEEP_MS).unref();
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
    // DELEGATION, and the reason it has to be said here. POST /spawn has always accepted
    // parentProject, so a coordinator could always have dispatched its own sub-workers -- but nothing
    // ever TOLD one. /protocol, which every worker reads on boot, documents registering, polling,
    // reporting and retiring; it never mentions spawning, because it is written for the worker end of
    // the wire. So the capability existed and went unused: managers did the heavy lifting inline,
    // which is the "coordinators must stay thin" problem seen from the other side -- a manager three
    // minutes into its own build turn is a manager Chris cannot reach. Spell the contract out where
    // the role is handed over.
    //
    // ONLY on this branch, deliberately: `subOf` workers must not spawn grandchildren. Delegation is
    // one level deep on purpose -- a tree of sub-workers has no coordinator anyone can find, and the
    // retire-summary feedback path (below, and in retireSession) is defined for exactly one hop.
    // NO ANGLE BRACKETS in this paragraph, and it is not a style rule. node-pty runs claude through
    // cmd.exe when it resolves to a .cmd, so the whole prompt is re-parsed as a cmd command line, and
    // a stray "<" or ">" is a REDIRECTION: measured, an angle-bracketed placeholder here made cmd
    // answer "The system cannot find the file specified" and the worker never registered at all. The
    // rest of the boot text has always been angle-bracket free, and safePurpose above strips the same
    // class from the one part a human controls. Placeholders go in quotes instead.
    if (project) boot += ' You DELEGATE the heavy work rather than doing it yourself. To dispatch a sub-worker: POST http://127.0.0.1:' + PORT + '/spawn {"cwd":"the repo path","purpose":"one short speakable line","parentProject":"' + project + '"} - the response carries the new callsign, and it is parentProject that nests the worker under ' + project + ' instead of minting an unrelated session. Brief it with POST http://127.0.0.1:' + PORT + '/send {"from":"your uid","to":"its callsign","text":"goals, paths, constraints"} - send goals and paths, never file contents it can read itself. When it retires, its one-line summary auto-appends to the ' + project + ' project log AND arrives as a message on your poll loop, so you get the outcome back without watching for it. The discipline that makes this worth doing: delegate the HEAVY work (long builds, wide sweeps, deep research) and stay THIN and responsive. A coordinator that disappears into a twenty-minute turn cannot be reached, cannot re-plan, and has become the bottleneck it was meant to remove.';
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
    const hostMeta = {
        project: boundTo, parentProject: subOf,
        worktree: wt ? { path: wt.path, branch: wt.branch, base: wt.base, repoCwd: repo.cwd, repoKey: repo.key } : null,
    };
    if (CONSOLELESS && spawnWorkerConsoleless(cs, runRepo, boot, model, hookSettings, hostMeta)) {
        watchSpawn(cs, runRepo.cwd, repo.key, join(DATA, 'worker-' + cs + '.log'));
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
            pendingSpawns.delete(cs);
            // ...and give back the worktree we cut for a worker that will never boot, so the next
            // spawn on this callsign gets its own name back instead of a suffix.
            const dead = takePendingWorktree(cs);
            if (dead) teardownWorktree({ worktree: dead.path, cwd: dead.repoCwd, branch: dead.branch, purpose: 'terminal launch failed' }, cs);
            try { unlinkSync(scriptPath); } catch { }
        });
        c2.unref();
    });
    child.unref();
    watchSpawn(cs, runRepo.cwd, repo.key, null);
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
        // Merge-lane state per card, so the lock chip + waiting strip need no second fetch (mirroring
        // how parentProject was surfaced in eca1395). One store read per /board, not one per card, and
        // NO git call -- the base is whatever the lane was stamped with when it was granted.
        const batonLanes = loadBatons();
        const batonFor = (uid) => {
            if (!uid) return null;
            for (const k of Object.keys(batonLanes)) {
                const l = batonLanes[k];
                if (l.holder && l.holder.uid === uid) {
                    return { repo: k, base: l.base, holding: true, takenAt: l.holder.takenAt, waiting: l.queue.length, queue: l.queue.map(batonWho) };
                }
                const i = l.queue.findIndex(e => e.uid === uid);
                if (i >= 0) {
                    return { repo: k, base: l.base, holding: false, position: i + 1, waiting: l.queue.length, holder: l.holder ? batonWho(l.holder) : null };
                }
            }
            return null;
        };
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
                // A PROJECT card with no live session still has to be restartable, and that is the
                // only moment the console's continue button matters at all. `uid` goes null once
                // every session bound to the project has been buried, so these shipped empty, the
                // button posted cwd:'' and /spawn answered 400 "need cwd and purpose" — a control
                // that worked only while it was useless. Chris hit it trying to restart primeng
                // after the 22:00 reconcile swept its last four sessions.
                //
                // Retired sessions keep their cwd on purpose (it is how a project remembers which
                // repo it lives in), so fall back to the SAME lookup reviveMissionCoordinator uses.
                // One source of truth means the console and the hub can never disagree about where
                // a project lives. A plain NATO card has no project row and keeps the old blank.
                cwd: uid ? (roster.sessions[uid].cwd || '') : (projById[cs] ? (lastProjectCwd(roster.sessions, cs) || '') : ''),
                purpose: uid ? roster.sessions[uid].purpose : (projById[cs] ? (projById[cs].title || cs) : ''),
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
                // The merge lane this card's worker holds, or is waiting in; null for neither.
                baton: batonFor(uid),
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
        return json(res, 200, { focus: loadWork().focus, build: BUILD, live, retired, deadSpawns });
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
    if (key === 'GET /report') {
        // The reporting store's READ surface — the first one it has ever had, and deliberately nothing
        // more than a serializer. db.mjs already owns every query (recentWork / listSessions /
        // listTasks / taskCounts) and they had exactly one caller, its own CLI. So b5be7e2 put the hub
        // on the live write path and the history has been accumulating since with no way to ask for it.
        // This asks. It adds NO new SQL: a second definition of "what got done" living here is how the
        // two answers start to disagree, and db.mjs's is the one the semantics were settled against.
        //
        // This stays inside b5be7e2's rule — "nothing in the hub ever READS it back, so no hub
        // behaviour can come to depend on its contents" — in the sense that mattered: the rows go
        // straight OUT to the caller, and no hub state, decision or branch is taken on them. Serving
        // history is not depending on it. Keep it that way; the moment hub logic tests one of these
        // values, an unavailable store stops being harmless.
        //
        // Three things a read here must never do:
        //  1. Assume the store is there. It is OFF whenever db.mjs would not load or its file would not
        //     open, and the hub boots and serves anyway — so an unavailable store answers 503 saying
        //     so. NOT an empty 200: "history is switched off" and "nothing has ever been worked on"
        //     look identical that way, and this repo has already paid for reading silence as success.
        //  2. Throw into the hub. Same discipline as the writes — the store is a bystander.
        //  3. Count its own failures against the WRITE path. storeFails/storeOff belong to the record,
        //     so they are deliberately not touched below: if a read could trip that kill-switch, then
        //     asking for the history would be a way to switch the history off.
        if (storeOff || !storeDb || !storeMod) {
            return json(res, 503, { error: 'reporting store unavailable — history is off for this hub process (see crash.log)', store: 'off' });
        }
        const view = String(u.searchParams.get('view') || 'work');
        if (view !== 'work' && view !== 'sessions' && view !== 'tasks') {
            return json(res, 400, { error: 'view must be work|sessions|tasks' });
        }
        const limit = Math.max(1, Math.min(1000, Number(u.searchParams.get('limit')) || 100));
        try {
            // A whole-table aggregate GROUPED BY LANE, and lane is the CURRENT TRUTH. Two things this
            // buys, both of them traps b5be7e2 documented:
            //   'done' is what got finished — never a doneAt count. op:ready pulls a finished card back
            //   to queued and COALESCE means its doneAt cannot be cleared, so counting timestamps
            //   over-reports, and a confidently wrong throughput number is worse than none.
            //   'dropped' is abandoned work, and it appears here as its own lane rather than being
            //   folded in or quietly filtered out — a lane the backfill can never produce, so this is
            //   the only place it is visible. A caller excludes it KNOWINGLY or not at all.
            const counts = storeMod.taskCounts(storeDb);
            let items, total = null;
            if (view === 'sessions') {
                // searchParams.get() answers null for an absent key, which is exactly what db.mjs's
                // `opts.project != null` guards read as "no filter" — so these pass through untouched.
                items = storeMod.listSessions(storeDb, {
                    project: u.searchParams.get('project'),
                    parentProject: u.searchParams.get('parentProject'),
                    activeOnly: u.searchParams.get('activeOnly') === '1',
                });
            } else if (view === 'tasks') {
                items = storeMod.listTasks(storeDb, {
                    callsign: u.searchParams.get('callsign'),
                    lane: u.searchParams.get('lane'),
                });
            } else {
                items = storeMod.recentWork(storeDb, limit);
            }
            // Cap here for the two views db.mjs returns whole, and report `total` so the truncation is
            // never silent — a short list that looks complete is its own kind of wrong answer. `work`
            // gets no total on purpose: recentWork caps in SQL, and its HAVING clause means the
            // reportable-session count is not a plain table count. Re-deriving it here would be that
            // second definition again, so the honest move is to omit it and let `limit` speak.
            if (items.length > limit) { total = items.length; items = items.slice(0, limit); }
            return json(res, 200, {
                store: storeMod.defaultDbPath(),
                view, limit, counts,
                // The finished figure, spelled out so no caller has to know the lane rule to get it
                // right. It IS counts.done — one number from one source, not a second opinion.
                finished: counts.done || 0,
                count: items.length,
                ...(total == null ? {} : { total }),
                items,
            });
        } catch (e) {
            logCrash('reporting-store-read-failed (GET /report view=' + view + ')', e);
            return json(res, 500, { error: 'reporting store read failed (see crash.log)', store: 'on' });
        }
    }
    if (key === 'GET /baton') {
        // Lane state, for the console and for a worker's own check. The reap first is deliberate: a
        // lane whose holder died must never be SERVED as busy, because the answer a worker acts on is
        // this one. It is a write on a read, the same way the pendingPins/pendingBind TTL sweeps happen
        // on access, and it can only ever remove entries the roster already says are gone.
        try { reapBatons(); } catch (e) { logCrash('baton-reap-failed (GET /baton)', e); }
        const store = loadBatons();
        const want = String(u.searchParams.get('repo') || '').toLowerCase().trim();
        if (want) return json(res, 200, { staleMs: BATON_STALE, ...batonView(want, store[want]) });
        return json(res, 200, { staleMs: BATON_STALE, lanes: Object.keys(store).map(k => batonView(k, store[k])) });
    }
    if (key === 'POST /baton') {
        const b = await readBody(req);
        const op = String(b.op || '').toLowerCase().trim();
        try { reapBatons(); } catch (e) { logCrash('baton-reap-failed (POST /baton)', e); }
        const store = loadBatons();
        const save = () => { try { saveBatons(store); return true; } catch (e) { logCrash('baton-save-failed (' + op + ')', e); return false; } };
        if (op === 'force') {
            // The human's override, from the console: break a lane they think is stuck. No uid --
            // Chris is not a session. ALWAYS announced (spoken + recorded): a lane changing hands
            // without the worker asking is exactly the thing that must never happen silently.
            const target = String(b.cs || '').toLowerCase().replace(/[^a-z]/g, '');
            let to = null;
            if (target) {
                const tuid = liveUidOf(target);
                if (!tuid) return json(res, 404, { error: 'no live session ' + target });
                const ts = roster.sessions[tuid];
                to = { uid: tuid, cs: target, branch: ts.branch || null, note: String(b.note || 'human override') };
            }
            const repoKey = batonRepoKey(to ? roster.sessions[to.uid] : null, b.repo);
            if (!repoKey) return json(res, 400, { error: 'force needs repo (or a cs whose session has a cwd)' });
            const lane = store[repoKey] || normalizeLane(null);
            // Nothing to break and nobody named to hand it to: say so, rather than writing an empty
            // lane to disk and reporting a handover that did not happen. Forcing a lane that does not
            // exist yet is still legitimate WITH a target -- that is Chris granting a turn up front.
            if (!to && !lane.holder && !lane.queue.length) return json(res, 404, { error: 'no baton lane for ' + repoKey });
            const base = laneBase(repoKey, to ? roster.sessions[to.uid].cwd : '');
            const r = batonForce({ ...lane, base: base || lane.base }, to, Date.now());
            store[repoKey] = r.lane;
            if (!save()) return json(res, 500, { error: 'could not write batons.json (see crash.log)' });
            const what = 'merge lane ' + repoKey + ' forced by the console: '
                + (r.revoked ? 'revoked from ' + batonWho(r.revoked) : 'was free')
                + (r.grantedTo ? ' -> ' + batonWho(r.grantedTo) : ' -> free');
            record({ kind: 'sys', text: what });
            enqueueSay(r.grantedTo
                ? 'Merge lane ' + repoKey + ' handed to ' + batonWho(r.grantedTo) + '.'
                : 'Merge lane ' + repoKey + ' is now free.', 'jarvis');
            if (r.grantedTo) notifyBatonGrant(repoKey, r.lane, r.grantedTo);
            return json(res, 200, { ok: true, ...batonView(repoKey, r.lane), revoked: r.revoked ? batonWho(r.revoked) : null, grantedTo: r.grantedTo ? batonWho(r.grantedTo) : null });
        }
        const s = roster.sessions[b.uid];
        if (!s) return json(res, 404, { error: 'unknown uid' });
        const repoKey = batonRepoKey(s, b.repo);
        if (!repoKey) return json(res, 400, { error: 'could not resolve a repo for this session; pass repo' });
        const lane = store[repoKey] || normalizeLane(null);
        if (op === 'request') {
            if (s.ended) return json(res, 410, { error: 'retired' });
            // Re-resolve the base on every request: it is what the holder will merge, and Chris moves
            // the integration branch. A git read that fails keeps whatever the lane already knew rather
            // than blanking it -- a stale base beats no base, and null already means "use the repo's
            // current branch".
            const base = laneBase(repoKey, s.cwd);
            const r = batonRequest({ ...lane, base: base || lane.base }, {
                uid: b.uid, cs: s.callsign, branch: b.branch || s.branch || null, note: b.note,
            }, Date.now());
            store[repoKey] = r.lane;
            if (!save()) return json(res, 500, { error: 'could not write batons.json (see crash.log)' });
            if (!r.already) {
                record({ kind: 'sys', text: r.granted
                    ? 'merge lane ' + repoKey + ' granted to ' + s.callsign + (r.lane.base ? ' (base ' + r.lane.base + ')' : '')
                    : 'merge lane ' + repoKey + ' busy with ' + r.holder + '; ' + s.callsign + ' queued at ' + r.position });
            }
            return json(res, 200, {
                ok: true, granted: r.granted, position: r.position, holder: r.holder,
                already: r.already, repo: repoKey, base: r.lane.base, waiting: r.lane.queue.length,
            });
        }
        if (op === 'release') {
            const r = batonRelease(lane, b.uid, Date.now());
            if (!r.held) return json(res, 200, { ok: true, held: false, repo: repoKey, holder: lane.holder ? batonWho(lane.holder) : null });
            store[repoKey] = r.lane;
            if (!save()) return json(res, 500, { error: 'could not write batons.json (see crash.log)' });
            // Whether the merge actually LANDED is the punchlist's question, so it goes in the log
            // rather than being inferred from the lane moving on.
            record({ kind: 'sys', text: 'merge lane ' + repoKey + ' released by ' + s.callsign + (b.merged ? ' (merged)' : ' (nothing merged)') + (r.grantedTo ? ' -> ' + batonWho(r.grantedTo) : ' (free)') });
            if (r.grantedTo) notifyBatonGrant(repoKey, r.lane, r.grantedTo);
            return json(res, 200, { ok: true, held: true, repo: repoKey, grantedTo: r.grantedTo ? batonWho(r.grantedTo) : null, waiting: r.lane.queue.length });
        }
        if (op === 'cancel') {
            const c = batonCancel(lane, b.uid);
            // Cancelling while HOLDING is a mistake worth naming: doing nothing quietly would leave the
            // lane shut by a worker that believes it let go.
            if (c.holding) return json(res, 409, { error: 'you hold the ' + repoKey + ' lane; use op:release' });
            if (c.dropped) {
                store[repoKey] = c.lane;
                if (!save()) return json(res, 500, { error: 'could not write batons.json (see crash.log)' });
                record({ kind: 'sys', text: s.callsign + ' left the ' + repoKey + ' merge queue' });
            }
            return json(res, 200, { ok: true, dropped: c.dropped, repo: repoKey, waiting: c.lane.queue.length });
        }
        return json(res, 400, { error: 'op must be request|release|cancel|force' });
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
    // Chat search over the transcript -- "a search for chats would be legit".
    //
    // v1 said transcriptCache "IS the whole transcript ... the CACHE_CAP trim above is the only thing
    // that ages a hit out". Both halves of that were true and the second one was the bug: the trim ages
    // out EVERYTHING older than 5000 lines, which measured out at seven days, so a search sold as
    // covering months could only ever see the last week of it. The trim now archives instead of
    // deleting (see trimTranscript), and this route reads the cache AND that archive.
    //
    // Always-on, never a flag. An `archive=1` opt-in would have left the exact original bug in place for
    // anyone who did not know to pass it, which is everyone using the search box.
    //
    // A hit is deliberately GET /transcript's projection, field for field, so a console search box can
    // render results with the code it already has. srcKind is the one addition: /transcript collapses
    // everything that is not sys or react into 'msg', which is fine when you are only ever shown the
    // conversation but loses the sys-vs-task distinction the moment a search widens into them.
    //
    // NOT in v1, so the next session reads these as scoped out rather than missed:
    //   - ai-threads.json, the conversational side-tabs, is a SEPARATE chat surface. v1 covers the
    //     transcript because that is the chat he lives in; searching the side-threads is a v2.
    //   - surrounding context (N lines either side of a hit). A real usability win, but the endpoint
    //     lands first.
    if (key === 'GET /search') {
        // Every kind record() can put in the transcript. Keep this in step with record()'s callers --
        // an unlisted kind is unreachable through `kinds` AND invisible to kinds=all.
        const SEARCHABLE = ['speech', 'chat', 'tts', 'sys', 'task', 'react'];
        // "chats" means the CONVERSATION. sys and task are machinery: measured on the live transcript
        // they are 2.4k lines of 5.4k, and formulaic ones -- every register, retire and board move --
        // so a common term hits hundreds of near-identical lines and buries the real hits under them.
        const DEFAULT_KINDS = ['speech', 'chat', 'tts'];
        const LIMIT_DEFAULT = 50, LIMIT_MAX = 200;

        const q = String(u.searchParams.get('q') || '');
        // Case-insensitive, ANDed, SUBSTRING terms: every term must appear somewhere in the line, not
        // necessarily on a word boundary -- he searches partial ids, shas and path fragments.
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
        // A blank q is an ERROR, not an empty result set: [] here is indistinguishable from "nothing
        // in months of history matches", which is the wrong thing to let someone believe.
        if (!terms.length) return json(res, 400, { error: 'q required: one or more terms to search for, e.g. /search?q=commit%20baton' });

        const kindsRaw = String(u.searchParams.get('kinds') || '').trim().toLowerCase();
        let kinds;
        if (!kindsRaw) kinds = DEFAULT_KINDS;
        else if (kindsRaw === 'all') kinds = SEARCHABLE;
        else {
            kinds = kindsRaw.split(',').map(s => s.trim()).filter(Boolean);
            // Same reasoning as the blank q: a typo'd kind must not answer with a confident empty set.
            const bad = kinds.filter(k => !SEARCHABLE.includes(k));
            if (bad.length) return json(res, 400, { error: 'unknown kind: ' + bad.join(', ') + ' -- use all, or any of ' + SEARCHABLE.join(', ') });
        }
        const want = {};
        for (const k of kinds) want[k] = 1;
        // Narrowing filters. `from` matches the PROJECTED who -- what the console actually shows -- so
        // from=you finds his own speech, from=jarvis the hub's, from=<callsign> one session's.
        const fromWant = String(u.searchParams.get('from') || '').trim().toLowerCase();
        const missionWant = String(u.searchParams.get('missionId') || '').trim();
        const askedLim = Math.floor(Number(u.searchParams.get('limit')));
        const lim = Math.min(Number.isFinite(askedLim) && askedLim > 0 ? askedLim : LIMIT_DEFAULT, LIMIT_MAX);

        // NEWEST FIRST -- a search across months of history that hands back the oldest match first is
        // useless. Cache backwards, THEN archive backwards: every archived line is older than every
        // cached one by construction (the archive is what fell off the cache's front), so those two
        // walks concatenated are already in descending order and nothing needs sorting. `total` keeps
        // counting past the limit so a caller can say "50 of 347" instead of pretending 50 was all
        // there was -- which is why the archive is scanned even once the page is full.
        const hits = [];
        let total = 0;
        const take = (hit) => { if (hit) { total++; if (hits.length < lim) hits.push(hit); } };
        for (let i = transcriptCache.length - 1; i >= 0; i--) {
            take(searchProject(transcriptCache[i], want, terms, fromWant, missionWant));
        }
        // Then the history the cache no longer holds. A raw-substring prefilter keeps JSON.parse off the
        // ~99% of archived lines that cannot match: the projected text is a verbatim substring of its
        // JSONL line, so a line missing the term cannot hold it after parsing either. That only holds for
        // terms JSON does not rewrite, though -- a term containing a quote or a backslash appears escaped
        // in the line and the prefilter would MISS it -- so those terms are excluded from the prefilter
        // rather than trusted, which costs speed on an exotic query instead of correctness.
        const plainTerms = terms.filter(t => !/["\\]/.test(t) && ![...t].some(c => c.charCodeAt(0) < 32));
        const archive = await scanArchiveBackwards((line) => {
            const low = line.toLowerCase();
            for (const t of plainTerms) if (!low.includes(t)) return;
            let e = null;
            try { e = JSON.parse(line); } catch { return; }
            take(searchProject(e, want, terms, fromWant, missionWant));
        });
        if (archive.capped) noteArchiveCapped(archive);
        // `archive` is additive: every field a caller had in v1 keeps its name and meaning, so a console
        // box written against the old shape renders this unchanged. It is here because a bounded read
        // that does not report its bound is indistinguishable from a complete one.
        return json(res, 200, {
            q, terms, kinds, limit: lim, total, truncated: total > hits.length, results: hits,
            archive: {
                searched: archive.searched,
                lines: archive.lines,
                bytes: archive.bytes,
                cap: ARCHIVE_SCAN_CAP_BYTES,
                capped: archive.capped,
                oldestScannedTs: archive.oldestScannedTs,
                ...(archive.error ? { error: archive.error } : {}),
            },
        });
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
        // THE THIRD SPAWN SITE. The retire auto-successor and mission auto-revive both ask
        // coordinatorHeld before minting a coordinator; this endpoint -- the console "+" and the
        // voice spawn -- never did, so it was the one door left open to two brains on one project.
        // A human's explicit ask is not refused: the new session NESTS under the incumbent instead,
        // which is the same coordinator-if-free-else-sub-worker rule auto-bind applies at register,
        // so both doors decide alike rather than each having its own idea of the slot.
        let project = b.project ? String(b.project).toLowerCase().trim() : null;
        let parentProject = b.parentProject ? String(b.parentProject).toLowerCase().trim() : null;
        let held = null;
        if (project) {
            held = coordinatorHeld(project);
            if (held) { parentProject = project; project = null; }
        }
        const cs = spawnWorker(repo, purpose, b.model, handoff, b.tier, project, b.meeting, parentProject);
        const subOf = (!project && parentProject) ? parentProject : null;
        if (held) {
            record({ kind: 'sys', text: 'spawn: ' + parentProject + ' already has a coordinator (' + (held.callsign || held.uid) + ' is ' + (held.kind === 'live' ? 'live' : 'booting') + '), so ' + cs + ' launches as its sub-worker instead' });
        } else if (!project && !parentProject) {
            // No binding asked for at all. This stays a standalone session -- inferring one from the
            // repo is auto-bind's job at register, and it is mission-gated on purpose -- but the
            // overlap gets NAMED here, because that is what was missing when two jarvis coordinators
            // ran 76 seconds deep into each other with the log showing only two ordinary spawns.
            try {
                for (const name of activeProjectsForCwd(loadProjects(), roster.sessions, cwd)) {
                    const h = coordinatorHeld(name);
                    if (!h) continue;
                    record({ kind: 'sys', text: 'spawn: ' + cs + ' is standalone in ' + repo.key + ' where ' + (h.callsign || h.uid) + ' already ' + (h.kind === 'live' ? 'coordinates' : 'boots as coordinator of') + ' ' + name });
                }
            } catch { }   // visibility only; an unreadable project store must never block a spawn
        }
        const launchWhat = b.meeting && b.meeting.title ? 'meeting worker for ' + b.meeting.title : (project ? project + ' worker' : (subOf ? subOf + ' sub-worker' : cs));
        enqueueSay('Launching ' + launchWhat + ' in ' + repo.key + (handoff ? ', resuming the handoff' : '') + '.', 'jarvis');
        return json(res, 200, { ok: true, callsign: cs, ...(held ? { nestedUnder: parentProject } : {}) });
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
        // Where the task ENDS UP, for the transcript line and the reporting store below. Tracked
        // per-branch because neither half is derivable from `cs` and `b.op` alone: findTaskAll searches
        // EVERY board, so a start/done/move can land on another session's, and `drop` leaves the board
        // entirely. `stamped` names the timestamp column this op IS the moment of, if any; `from` is
        // the board a move took it OFF.
        let lane = null, owner = cs, stamped = null, from = null;
        if (b.op === 'add' && needle) {
            task = makeTask(needle, b);
            board.queued.push(task);
            lane = 'queued';
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
            owner = hit.cs;
            // 'dropped' is a lane that exists ONLY in the store: a dropped task is gone from
            // worklist.json, so the backfill can never see one. Naming it here is what lets a report
            // EXCLUDE abandoned work instead of silently losing it.
            lane = b.op === 'start' ? 'working' : b.op === 'done' ? 'done'
                : b.op === 'ready' ? 'queued' : b.op === 'review' ? 'review' : 'dropped';
            stamped = b.op === 'start' ? 'startedAt' : b.op === 'done' ? 'doneAt' : null;
        } else if (b.op === 'top') {
            const hit = findTaskAll(w, needle, ['queued', 'working', 'review', 'done'], cs);
            if (!hit) return json(res, 404, { error: 'no task matching ' + needle });
            const arr = w.sessions[hit.cs][hit.list];
            const [t] = arr.splice(hit.i, 1);
            arr.unshift(t);
            task = t;
            owner = hit.cs;
            lane = hit.list;    // a bump reorders within a lane; it does not change one
        } else if (b.op === 'move' && needle && b.to) {
            const hit = findTaskAll(w, needle, ['working', 'queued', 'done'], cs);
            if (!hit) return json(res, 404, { error: 'no task matching ' + needle });
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            ensureBoard(w, String(b.to).toLowerCase()).queued.push(t);
            task = t;
            owner = String(b.to).toLowerCase();   // the row follows the task to its new board
            from = hit.cs;                        // ...and the record still says where it came from
            lane = 'queued';
        } else if (b.op === 'clear-done') {
            board.done = [];
        } else {
            return json(res, 400, { error: 'op must be add|start|done|review|top|drop|move|clear-done' });
        }
        saveWork(w);
        // Credit the board HOLDING the task, not the one that POSTED the op. findTaskAll searches every
        // board, so `cs` is only the poster and can be somebody else entirely -- and this line is not
        // just a log, it is a SOURCE. db.mjs's taskTimesFromTranscript keys it as (board, text) and has
        // to match task rows keyed on the board the task actually lives on, so crediting the poster
        // produced a key that matched nothing: a cross-board start or done did not misplace the
        // timestamp, it LOST it, and every reconstruction inherited that hole. `owner` is the same value
        // the live store write below uses, which is what makes the two records agree rather than merely
        // both existing. The voice handlers above already do this (they read hit.cs); this was the older
        // half that did not.
        // `from` only appears on a move, mirroring the voice path's move line: with `board` naming the
        // destination, the source board would otherwise be absent from the record entirely.
        record({ kind: 'task', op: b.op, board: owner, task: textOf(task), ...(from ? { from } : {}) });
        // The board op, as it happens. LANE IS CURRENT TRUTH; startedAt/doneAt are HISTORY, and the
        // two are allowed to disagree. db.mjs COALESCEs every column, so a timestamp once written can
        // never be cleared -- which means `ready` on a finished task leaves its doneAt standing beside
        // lane='queued'. That is the deliberate call, not an oversight: it WAS done at that moment,
        // and un-finishing it is not time travel. The consequence a report has to respect is that
        // "what is finished" means lane='done', NEVER doneAt IS NOT NULL.
        // `clear-done` writes nothing on purpose: it empties a lane without changing any task's fate,
        // and the store is precisely the history the board just threw away.
        // Tasks with no id (pre-v3 bare strings) are skipped -- upsertTask needs a primary key, and
        // minting one here would not match the synthetic id the backfill derives for the same task.
        if (lane && task && typeof task === 'object' && task.id) {
            const t = task;
            store('worklist ' + b.op + ' ' + t.id, (m, db) => m.upsertTask(db, {
                id: t.id, callsign: owner, text: textOf(t), lane, addedAt: t.addedAt,
                ...(stamped ? { [stamped]: new Date().toISOString() } : {}),
            }));
        }
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

    // Bring the reporting store up BEFORE the boot reconcile: that sweep retires every worker that
    // did not survive, and those retires are history worth keeping. After the listen, per the rule
    // below -- the port comes up first, unconditionally. A register landing in the millisecond
    // between the two is simply not stored; the store is best-effort by design and nothing reads it.
    await initStore();

    // Re-adopt the workers that outlived the last hub, bury the ones that did not, and restore the
    // spawn state that was in flight when it went down. This also owns the worktree sweep, which it
    // defers until survivors have had a chance to check in — calling sweepWorktrees() here directly
    // would delete live workers' directories, which is precisely what it used to do.
    // After the listen, so a slow git call on a big repo never delays the port coming up.
    reconcileWorkersOnBoot();

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

    // The build goes in the TRANSCRIPT, not just stdout: stdout belongs to a detached process
    // nobody reads, while the transcript is what a session greps when it asks "did the hub
    // actually bounce, and onto what?". This line is the timestamped answer to both.
    const treeNote = BUILD.dirty === true ? ' (dirty tree)' : BUILD.dirty === null ? ' (tree state unknown)' : '';
    const buildNote = BUILD.short ? ' @ ' + BUILD.short + treeNote : ' @ unknown build';
    record({ kind: 'sys', text: 'jarvis core started' + (NO_UI ? ' (no ui)' : '') + buildNote + ' pid ' + process.pid });
    console.log('JARVIS CORE READY.');
    console.log(`  build      -> ${BUILD.short || 'unknown'}${treeNote}  pid ${process.pid}`);
    console.log(`  data dir   -> ${DATA}`);
    console.log(`  transcript -> ${TRANSCRIPT}`);
    // Say whether history is actually being recorded. An unavailable store is invisible by design --
    // every write is swallowed -- and this repo has paid for treating silence as success before.
    console.log(`  store      -> ${storeDb ? storeMod.defaultDbPath() : 'OFF (db.mjs unavailable; see crash.log)'}`);
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
