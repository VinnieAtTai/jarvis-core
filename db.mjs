// Local SQLite reporting store for the JARVIS hub — a STANDALONE, ADDITIVE module. Nothing in
// jarvis-core.mjs imports this; the hub keeps writing its JSON state as it always has. This is a
// read-only lens over that state for PM-style history: what each worker did/fixed (session
// summaries), and task throughput over time. Chris wanted this local instead of Notion; Node 26
// ships `node:sqlite` (DatabaseSync) built in, so there is no npm dependency to install.
//
// Two halves: (1) a thin data layer (init + upsert + query fns) over two tables, and (2) a
// backfill that reconstructs those tables READ-ONLY from the hub's existing files in JARVIS_DATA.
// The backfill is idempotent — every write is an upsert by primary key, and every ON CONFLICT uses
// COALESCE(new, old) so a weaker source can fill a NULL but never clobber a value another source
// already supplied. Re-running it (or pointing it at a growing log) is always safe.
//
// Style mirrors jarvis-text.mjs: small functions, WHY-comments over WHAT. Unlike that module this
// one necessarily does I/O — reading the db and the logs is the whole point — so it is not pure.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolve the hub's runtime data directory EXACTLY as jarvis-core.mjs does, so the backfill reads
// the same transcript/bus/worklist/sessions the live hub is writing: JARVIS_DATA wins, else
// %LOCALAPPDATA%\jarvis on Windows, else the repo dir (non-Windows / unset). Computed per-call (not
// cached at import) so tests can point JARVIS_DATA at a scratch dir before calling.
export function dataDir() {
    return process.env.JARVIS_DATA || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'jarvis') : HERE);
}

// Default db file: jarvis.db inside the data dir. init() accepts an explicit path (tests pass
// ':memory:' or a temp file) so the store never has to touch the live data dir to be exercised.
export function defaultDbPath() {
    return join(dataDir(), 'jarvis.db');
}

// The two tables. sessions.summary is first-class: it is the "what got done/fixed" line the human
// hears months later, so it is a plain queryable column, not buried in a blob. tasks link back to a
// session only by callsign (the board id) — the hub's task log carries no uid — so a reused callsign
// (alpha, echo...) can straddle successive sessions; recentWork() documents that caveat.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
    uid           TEXT PRIMARY KEY,
    callsign      TEXT,
    cwd           TEXT,
    purpose       TEXT,
    project       TEXT,
    parentProject TEXT,
    registeredAt  TEXT,
    retiredAt     TEXT,
    summary       TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
    id        TEXT PRIMARY KEY,
    callsign  TEXT,
    text      TEXT,
    tag       TEXT,
    lane      TEXT,
    addedAt   TEXT,
    startedAt TEXT,
    doneAt    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_parent  ON sessions(parentProject);
CREATE INDEX IF NOT EXISTS idx_tasks_callsign   ON tasks(callsign);
CREATE INDEX IF NOT EXISTS idx_tasks_lane       ON tasks(lane);
`;

// Open (creating if needed) the db and ensure the schema. Returns the DatabaseSync handle; the
// caller closes it. WAL keeps a reader from blocking the live hub if this ever runs concurrently
// against a shared file (today the hub never opens the db, but it is cheap insurance).
export function init(dbPath) {
    const db = new DatabaseSync(dbPath || defaultDbPath());
    try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* :memory: rejects WAL; fine */ }
    db.exec(SCHEMA);
    return db;
}

// node:sqlite rejects `undefined` and won't bind a JS value that isn't a string/number/null/bigint/
// buffer. Every column here is TEXT, so coerce: null stays null, everything else becomes a string.
// An empty string is normalized to null so COALESCE treats "unknown" and "" the same.
function nz(v) {
    if (v == null) return null;
    const s = String(v);
    return s === '' ? null : s;
}

// A collision-free key for a (callsign, text) pair — JSON.stringify of the pair, so there is no
// fragile in-band separator character to escape or accidentally embed. Used to match a worklist task
// against its transcript task-log events, and to seed a synthetic id.
function pairKey(a, b) {
    return JSON.stringify([String(a == null ? '' : a), String(b == null ? '' : b)]);
}

// Extract the leading category tag ("BUG:", "FEATURE:", ...) the board renders as a chip, matching
// jarvis-text.shortTitle's `^[A-Z]{2,10}:` rule. Returns the tag WITHOUT the colon, or null. `text`
// is stored verbatim (tag included) so the row is lossless; `tag` is the parsed-out facet.
export function tagOf(text) {
    const m = /^([A-Z]{2,10}):/.exec(String(text == null ? '' : text).trim());
    return m ? m[1] : null;
}

// Upsert one session by uid. COALESCE(excluded, existing) on every nullable field: whichever source
// supplies a value first keeps it, and a later source passing null never wipes it — so ingest order
// (roster vs transcript vs bus) does not matter and re-runs are no-ops.
const SESSION_UPSERT = `
INSERT INTO sessions (uid, callsign, cwd, purpose, project, parentProject, registeredAt, retiredAt, summary)
VALUES ($uid, $callsign, $cwd, $purpose, $project, $parentProject, $registeredAt, $retiredAt, $summary)
ON CONFLICT(uid) DO UPDATE SET
    callsign      = COALESCE(excluded.callsign, callsign),
    cwd           = COALESCE(excluded.cwd, cwd),
    purpose       = COALESCE(excluded.purpose, purpose),
    project       = COALESCE(excluded.project, project),
    parentProject = COALESCE(excluded.parentProject, parentProject),
    registeredAt  = COALESCE(excluded.registeredAt, registeredAt),
    retiredAt     = COALESCE(excluded.retiredAt, retiredAt),
    summary       = COALESCE(excluded.summary, summary)
`;
export function upsertSession(db, s) {
    if (!s || !nz(s.uid)) return false;
    db.prepare(SESSION_UPSERT).run({
        $uid: nz(s.uid), $callsign: nz(s.callsign), $cwd: nz(s.cwd), $purpose: nz(s.purpose),
        $project: nz(s.project), $parentProject: nz(s.parentProject),
        $registeredAt: nz(s.registeredAt), $retiredAt: nz(s.retiredAt), $summary: nz(s.summary),
    });
    return true;
}

// Upsert one task by id. Same COALESCE discipline: worklist.json supplies id/callsign/text/lane/
// addedAt; the transcript task log later fills startedAt/doneAt without disturbing the rest. tag is
// derived from text here so callers can pass a bare worklist task.
const TASK_UPSERT = `
INSERT INTO tasks (id, callsign, text, tag, lane, addedAt, startedAt, doneAt)
VALUES ($id, $callsign, $text, $tag, $lane, $addedAt, $startedAt, $doneAt)
ON CONFLICT(id) DO UPDATE SET
    callsign  = COALESCE(excluded.callsign, callsign),
    text      = COALESCE(excluded.text, text),
    tag       = COALESCE(excluded.tag, tag),
    lane      = COALESCE(excluded.lane, lane),
    addedAt   = COALESCE(excluded.addedAt, addedAt),
    startedAt = COALESCE(excluded.startedAt, startedAt),
    doneAt    = COALESCE(excluded.doneAt, doneAt)
`;
export function upsertTask(db, t) {
    if (!t || !nz(t.id)) return false;
    db.prepare(TASK_UPSERT).run({
        $id: nz(t.id), $callsign: nz(t.callsign), $text: nz(t.text),
        $tag: nz(t.tag != null ? t.tag : tagOf(t.text)), $lane: nz(t.lane),
        $addedAt: nz(t.addedAt), $startedAt: nz(t.startedAt), $doneAt: nz(t.doneAt),
    });
    return true;
}

// ---- queries -------------------------------------------------------------------------------

export function getSession(db, uid) {
    return db.prepare('SELECT * FROM sessions WHERE uid = ?').get(nz(uid)) || null;
}

// Sessions, newest-activity first. Optional filters: {project}, {parentProject}, {activeOnly} (not
// yet retired). Ordered by retiredAt then registeredAt so a live session sorts to the top.
export function listSessions(db, opts = {}) {
    const where = [];
    const params = {};
    if (opts.project != null) { where.push('project = $project'); params.$project = nz(opts.project); }
    if (opts.parentProject != null) { where.push('parentProject = $parent'); params.$parent = nz(opts.parentProject); }
    if (opts.activeOnly) where.push('retiredAt IS NULL');
    const sql = 'SELECT * FROM sessions'
        + (where.length ? ' WHERE ' + where.join(' AND ') : '')
        + ' ORDER BY COALESCE(retiredAt, registeredAt) DESC';
    return db.prepare(sql).all(params);
}

// Tasks, optionally filtered by {callsign} and/or {lane}, newest-added first.
export function listTasks(db, opts = {}) {
    const where = [];
    const params = {};
    if (opts.callsign != null) { where.push('callsign = $callsign'); params.$callsign = nz(opts.callsign); }
    if (opts.lane != null) { where.push('lane = $lane'); params.$lane = nz(opts.lane); }
    const sql = 'SELECT * FROM tasks'
        + (where.length ? ' WHERE ' + where.join(' AND ') : '')
        + ' ORDER BY addedAt DESC';
    return db.prepare(sql).all(params);
}

// The headline PM query: recent sessions with their "what got done" summary and how many tasks
// completed under their board. This is what answers "what did each worker do/fix lately". doneCount
// joins tasks by callsign — the only link the hub records — so for a REUSED callsign the count can
// include a predecessor's done tasks on the same board; treat it as a per-board figure, not a strict
// per-session one. Sessions with neither a summary nor any done task are omitted (nothing to report).
export function recentWork(db, limit = 20) {
    return db.prepare(`
        SELECT s.uid, s.callsign, s.purpose, s.project, s.parentProject,
               s.registeredAt, s.retiredAt, s.summary,
               COUNT(t.id) AS doneCount
        FROM sessions s
        LEFT JOIN tasks t ON t.callsign = s.callsign AND t.lane = 'done'
        GROUP BY s.uid
        HAVING s.summary IS NOT NULL OR doneCount > 0
        ORDER BY COALESCE(s.retiredAt, s.registeredAt) DESC
        LIMIT ?
    `).all(Math.max(1, Number(limit) || 20));
}

// Task counts grouped by lane — a one-glance throughput figure (how many done vs still working/queued).
export function taskCounts(db) {
    const rows = db.prepare('SELECT lane, COUNT(*) AS n FROM tasks GROUP BY lane').all();
    const out = {};
    for (const r of rows) out[r.lane || 'unknown'] = r.n;
    return out;
}

// ---- backfill ------------------------------------------------------------------------------
// Reconstruct the tables from the hub's on-disk state, READ-ONLY. Sources, and what each contributes:
//   sessions.json  (roster)     -> authoritative session rows: cwd, purpose, project, parentProject,
//                                   registeredAt (started), retiredAt (ended), summary.
//   transcript.jsonl            -> FALLBACK session facts for uids missing from the roster (parsed
//                                   from `registered`/`retired` sys lines + the retire tts summary),
//                                   AND task startedAt/doneAt (from `task` op=start/done events).
//   bus.jsonl                   -> retiredAt per uid (the `retired` event carries uid + timestamp).
//   worklist.json  (v2/v3 board)-> the task rows themselves (stable ids, current lane, addedAt).
// The roster fully populates sessions on its own; the transcript/bus paths let the module still do
// something useful if only the append-only logs are present. Returns counts for the caller to log.

function readText(dir, name) {
    const p = join(dir, name);
    try { return existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; }
}

// Parse a JSONL file into an array of objects, skipping blank/garbage lines (a half-written trailing
// line during a live append must not abort the whole backfill).
function readJsonl(dir, name) {
    const out = [];
    for (const line of readText(dir, name).split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        try { out.push(JSON.parse(s)); } catch { /* skip a torn/partial line */ }
    }
    return out;
}

function readJson(dir, name) {
    const raw = readText(dir, name);
    if (!raw.trim()) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

// Pull session facts out of the transcript's sys/tts lines. Kept exported + pure(ish) — it takes the
// already-parsed events array and returns a uid->partial-session map — so it unit-tests without a db
// or a file. Recognizes the exact strings jarvis-core emits at register/retire (see its record()
// calls); the retire tts ("<cs> retired. <summary>") has no uid, so it is attached to the uid of the
// immediately-preceding retire sys line for the same callsign.
export function sessionsFromTranscript(events) {
    const byUid = {};
    const get = uid => (byUid[uid] || (byUid[uid] = { uid }));
    let pendingRetire = null; // {uid, cs} from the last retire sys line, consumed by its tts summary
    for (const e of (Array.isArray(events) ? events : [])) {
        if (!e || e.kind === undefined) continue;
        const text = String(e.text == null ? '' : e.text);
        if (e.kind === 'sys') {
            let m;
            // "registered <uid> as <proj> worker (<cs>): <purpose>"  (project coordinator)
            if ((m = /^registered (\S+) as (\S+) worker \(([^)]+)\):\s?(.*)$/.exec(text))) {
                const s = get(m[1]); s.callsign = m[3]; s.project = m[2]; s.purpose = m[4]; s.registeredAt = e.ts;
            // "registered <uid> as <cs>: <purpose>"  (ordinary worker / sub-worker)
            } else if ((m = /^registered (\S+) as (\S+):\s?(.*)$/.exec(text))) {
                const s = get(m[1]); s.callsign = m[2]; s.purpose = m[3]; s.registeredAt = e.ts;
            // "<cs> (<proj> worker) retired (<uid>)..."
            } else if ((m = /^(\S+) \(\S+ worker\) retired \((\S+)\)/.exec(text))) {
                const s = get(m[2]); s.callsign = m[1]; s.retiredAt = e.ts; pendingRetire = { uid: m[2], cs: m[1] };
            // "<cs> retired (<uid>)..." (with or without a successor clause)
            } else if ((m = /^(\S+) retired \((\S+)\)/.exec(text))) {
                const s = get(m[2]); s.callsign = m[1]; s.retiredAt = e.ts; pendingRetire = { uid: m[2], cs: m[1] };
            }
        } else if (e.kind === 'tts' && pendingRetire) {
            // "<cs> retired. <summary>" — the spoken epitaph, right after the retire sys line.
            const m = /^(\S+) retired\.\s+(.+)$/.exec(text);
            if (m && m[1] === pendingRetire.cs) { get(pendingRetire.uid).summary = m[2].trim(); pendingRetire = null; }
        }
    }
    return byUid;
}

// Build a map from a worklist task's (callsign, text) to its {startedAt, doneAt}, read out of the
// transcript's task events, so a worklist task (which stores only addedAt) can be enriched with when
// it was started/finished. startedAt = earliest op=start; doneAt = latest op=done. The event's
// `board` field IS the callsign, and its `task` field is the same text the worklist stores.
export function taskTimesFromTranscript(events) {
    const map = new Map();
    for (const e of (Array.isArray(events) ? events : [])) {
        if (!e || e.kind !== 'task' || !e.board || e.task == null) continue;
        const key = pairKey(e.board, e.task);
        const cur = map.get(key) || {};
        if (e.op === 'start' && (!cur.startedAt || e.ts < cur.startedAt)) cur.startedAt = e.ts;
        if (e.op === 'done' && (!cur.doneAt || e.ts > cur.doneAt)) cur.doneAt = e.ts;
        map.set(key, cur);
    }
    return map;
}

// The key taskTimesFromTranscript uses, exported so callers (backfill) and tests share one convention
// instead of hand-building it.
export function taskTimeKey(callsign, text) {
    return pairKey(callsign, text);
}

// Flatten a v2/v3 worklist board into task rows tagged with their lane and callsign. Tolerates a bare
// string task (pre-v3) and a missing/oddly-shaped board. Ids are required to be a PK; a task without
// one is given a deterministic synthetic id from (callsign,text) so it still lands exactly once and
// re-runs stay idempotent.
export function tasksFromWorklist(worklist) {
    const out = [];
    const sessions = (worklist && worklist.sessions && typeof worklist.sessions === 'object') ? worklist.sessions : {};
    for (const callsign of Object.keys(sessions)) {
        const board = sessions[callsign];
        if (!board || typeof board !== 'object') continue;
        for (const lane of ['review', 'working', 'queued', 'done']) {
            const list = Array.isArray(board[lane]) ? board[lane] : [];
            for (const raw of list) {
                const t = (raw && typeof raw === 'object') ? raw : { text: raw };
                const text = t.text == null ? '' : String(t.text);
                const id = nz(t.id) || ('wl_' + callsign + '_' + hash32(pairKey(callsign, text)));
                out.push({ id, callsign, text, tag: tagOf(text), lane, addedAt: t.addedAt });
            }
        }
    }
    return out;
}

// Small stable non-crypto hash (FNV-1a, base36) for synthesizing a task id when the source row has
// none. Deterministic so the same (callsign,text) always maps to the same id — keeps backfill
// idempotent without a real uuid.
function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
}

// Run the whole backfill against `db`, reading from `dir` (defaults to the live JARVIS_DATA). Order
// is deliberate: transcript/bus fallback first, roster last, so the authoritative roster's values win
// via COALESCE without being pre-empted. Returns { sessions, tasks } counts touched.
export function backfill(db, dir) {
    const d = dir || dataDir();
    const transcript = readJsonl(d, 'transcript.jsonl');
    const bus = readJsonl(d, 'bus.jsonl');
    const roster = readJson(d, 'sessions.json');
    const worklist = readJson(d, 'worklist.json');

    let sessionCount = 0;
    let taskCount = 0;

    db.exec('BEGIN');
    try {
        // 1. Sessions from the transcript (fallback for uids the roster may not hold).
        for (const s of Object.values(sessionsFromTranscript(transcript))) {
            if (upsertSession(db, s)) sessionCount++;
        }
        // 2. retiredAt from bus `retired` events (uid is the event's `to`).
        for (const e of bus) {
            if (e && e.kind === 'retired' && e.to) upsertSession(db, { uid: e.to, retiredAt: e.ts });
        }
        // 3. Sessions from the roster — authoritative; started->registeredAt, ended->retiredAt.
        const rosterSessions = (roster && roster.sessions && typeof roster.sessions === 'object') ? roster.sessions : {};
        for (const [uid, s] of Object.entries(rosterSessions)) {
            if (!s || typeof s !== 'object') continue;
            const seen = getSession(db, uid);
            if (upsertSession(db, {
                uid, callsign: s.callsign, cwd: s.cwd, purpose: s.purpose,
                project: s.project, parentProject: s.parentProject,
                registeredAt: s.started, retiredAt: s.ended, summary: s.summary,
            }) && !seen) sessionCount++;
        }
        // 4. Tasks from the worklist, then enriched with start/done times from the transcript.
        const times = taskTimesFromTranscript(transcript);
        for (const t of tasksFromWorklist(worklist)) {
            const tm = times.get(taskTimeKey(t.callsign, t.text)) || {};
            if (upsertTask(db, { ...t, startedAt: tm.startedAt, doneAt: tm.doneAt })) taskCount++;
        }
        db.exec('COMMIT');
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
    }
    return { sessions: sessionCount, tasks: taskCount };
}

// Optional CLI: `node db.mjs backfill [dataDir] [dbPath]` — build/refresh the default db from the
// live data dir and print what it touched. Guarded so importing the module (tests, the future hub)
// never runs it. Kept dependency-free and side-effect-free on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const [, , cmd, argDir, argDb] = process.argv;
    if (cmd === 'backfill') {
        const db = init(argDb);
        const counts = backfill(db, argDir);
        const glance = taskCounts(db);
        console.log('backfilled ' + counts.sessions + ' sessions, ' + counts.tasks + ' tasks');
        console.log('task lanes: ' + JSON.stringify(glance));
        db.close();
    } else {
        console.log('usage: node db.mjs backfill [dataDir] [dbPath]');
    }
}
