// Pure text/time parsers for the JARVIS hub — no I/O, no module-level state, no side effects.
// Split out of jarvis-core.mjs so they can be unit-tested without booting the server
// (jarvis-core truncates say.txt and binds the port on import). See test/text.test.mjs.

const NUMWORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// Format an ISO timestamp as a short clock like "3:30 PM" / "9 AM".
export function clk(iso) {
    const d = new Date(iso); let h = d.getHours(); const m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return h + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap;
}

// Strip the command framing ("remind me", "set a timer for", the time clause, a leading "to")
// to recover just the thing to be reminded of. Heuristic, but good enough for spoken input.
export function remTitle(t) {
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
export function parseReminder(text) {
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

// Parse a pasted day schedule: title lines, each optionally followed by an "H:MM AM - H:MM PM"
// line, into { date, events:[{title,start,end}], announced:{} }. Skips "Past events" markers,
// RSVP noise, and a trailing "(name @ email)" on a title.
export function parseScheduleText(text) {
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

// ---- worklist shape helpers ----------------------------------------------------------------
// Pure (no I/O) helpers for the on-disk worklist. migrateWork is injectable: the caller passes
// its own makeTask/newTaskId so the id/time generation stays in jarvis-core, keeping this module
// free of module-level state and unit-testable without booting the server.

// Current worklist schema version. Bumped when the on-disk shape changes; migrateWork upgrades
// older files to it. Single source of truth (jarvis-core imports this).
export const WORK_VERSION = 3;

// Read the text out of a task that may still be a bare string (defensive during/after migration).
export function textOf(t) {
    return (t && typeof t === 'object') ? (t.text == null ? '' : t.text) : (t == null ? '' : t);
}

// Trim a task to a speakable headline: drop a leading category tag (e.g. "BUG:") and keep the
// first few words. Used for spoken read-back and short status lines.
export function shortTitle(s) {
    const t = String(s).replace(/^[A-Z]{2,10}:\s*/, '').trim();
    return t.split(/\s+/).slice(0, 7).join(' ').slice(0, 50);
}

// Spoken summary of one board's open work: counts plus a headline task, NOT every task read out
// verbatim — Chris asked for read-back to be summarized. Returns '' when nothing is open so the
// caller can say "the list is empty". Scope mirrors the old speakBoard: working + queued only.
export function summarizeBoard(board) {
    if (!board) return '';
    const open = lane => (board[lane] || []).map(textOf).filter(s => s && s.trim());
    const working = open('working');
    const queued = open('queued');
    const parts = [];
    if (working.length === 1) parts.push('working on ' + shortTitle(working[0]));
    else if (working.length > 1) parts.push('working on ' + working.length + ', starting with ' + shortTitle(working[0]));
    if (queued.length === 1) parts.push('1 queued, ' + shortTitle(queued[0]));
    else if (queued.length > 1) parts.push(queued.length + ' queued, next ' + shortTitle(queued[0]));
    if (!parts.length) return '';
    const s = parts.join('; ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// Bring any on-disk worklist up to the current shape. Idempotent: existing task objects
// keep their ids (so ids are stable across reloads); only missing fields are backfilled.
// Returns { w, changed } so the loader can persist a one-time upgrade. makeTask(text)->task and
// newTaskId()->id are injected by the caller (they generate ids/timestamps, not pure).
export function migrateWork(w, makeTask, newTaskId) {
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

// ---- handoff / retire helpers --------------------------------------------------------------
// Pure (no I/O) helpers for the retire/handoff path. Split out so the successor decision and the
// board-transfer accounting can be unit-tested without booting the server or spawning a worker.

// Canonical key for a working directory: lowercased, backslashes -> forward slashes, no trailing
// slash. Handoffs are stashed/read by this key so the same job matches regardless of how its path
// was typed. Used by both /handoff and retireSession.
export function cwdKey(cwd) {
    return String(cwd || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

// Key for the DURABLE per-job handoff store (roster.handoffs). cwdKey alone was too coarse: one
// working directory is shared by many unrelated jobs (e.g. d:/code/tms hosts a PrimeNG-QA worker,
// a TMS-20018 mileage-bug worker, a PRD-23 worker...), so whoever retired last on that cwd
// overwrote the single slot and the next fresh worker on it inherited a DIFFERENT job's handoff.
// Scoping by cwd + the job's purpose (the human-facing description, present at every register/
// retire/hold/spawn site and stable across a manual restart of the same job) keeps each job's
// handoff separate, so a successor only ever picks up its own job's notes. Purpose is normalized
// (lowercased, trimmed, whitespace-collapsed) so trivial re-typings still match. The newline
// joiner can never appear in a path or a whitespace-collapsed purpose, so two different
// (cwd, purpose) pairs can never collide onto one key.
export function handoffKey(cwd, purpose) {
    const p = String(purpose || '').toLowerCase().trim().replace(/\s+/g, ' ');
    return cwdKey(cwd) + String.fromCharCode(10) + p;
}

// The auto-successor rule for POST /retire: spawn a successor when work remains, but let an
// explicit request override either way. `requested` is the body's `successor` field (may be
// undefined); `hasWork` is whether the retiring board still has working+queued tasks.
//   successor:true  -> always spawn (even with an empty board)
//   successor:false -> never spawn (even with work left)
//   omitted         -> spawn iff work remains
export function shouldSpawnSuccessor(requested, hasWork) {
    return requested === true || (requested !== false && !!hasWork);
}

// Whether a retiring board still has unfinished work (working+queued). Drives the auto-successor
// default; matches the inline check in POST /retire.
export function boardHasWork(board) {
    const b = board || {};
    return (Array.isArray(b.working) ? b.working.length : 0) + (Array.isArray(b.queued) ? b.queued.length : 0) > 0;
}

// Move a retiring session's full board onto its successor's board. working+queued land at the
// FRONT of the successor's queue (unfinished work resumes first); review and done carry over at
// the front of their lanes so nothing the human still needs to see is lost. Pure: returns a new
// board plus the accounting the caller logs/announces. `total` counts the predecessor's tasks;
// `moved` counts the resulting board (a successor is normally fresh/empty, so they match). A
// `moved < total` shortfall flags a dropped task and is what the hub warns about.
export function transferBoard(fromBoard, toBoard) {
    const from = fromBoard || {};
    const to = toBoard || {};
    const fWorking = Array.isArray(from.working) ? from.working : [];
    const fQueued = Array.isArray(from.queued) ? from.queued : [];
    const fReview = Array.isArray(from.review) ? from.review : [];
    const fDone = Array.isArray(from.done) ? from.done : [];
    const tQueued = Array.isArray(to.queued) ? to.queued : [];
    const tReview = Array.isArray(to.review) ? to.review : [];
    const tDone = Array.isArray(to.done) ? to.done : [];
    const tWorking = Array.isArray(to.working) ? to.working : [];
    const unfinished = [...fWorking, ...fQueued];
    const board = {
        working: tWorking,
        queued: [...unfinished, ...tQueued],
        review: [...fReview, ...tReview],
        done: [...fDone, ...tDone],
    };
    const total = unfinished.length + fReview.length + fDone.length;
    const moved = board.working.length + board.queued.length + board.review.length + board.done.length;
    return { board, moved, total, dropped: moved < total };
}

// ---- conversational-tab (/ai) helpers ------------------------------------------------------
// Pure (no I/O) helpers for the model-backed chat tab. The Anthropic fetch itself stays in
// jarvis-core (it is I/O); only the cost math, the month-rollover, and the cap predicate live
// here so they can be unit-tested deterministically. See test/ai.test.mjs.

// Allowed conversational-tab models and their USD/token rates (input, output). The tab refuses
// any model not in this table; the default is claude-sonnet-4-6 (the workhorse). Rates mirror
// CONVERSATIONAL-TAB.md: Haiku $1/$5, Sonnet $3/$15, Opus $5/$25 per Mtok.
export const AI_MODELS = {
    'claude-haiku-4-5': { in: 1 / 1e6, out: 5 / 1e6 },
    'claude-sonnet-4-6': { in: 3 / 1e6, out: 15 / 1e6 },
    'claude-opus-4-8': { in: 5 / 1e6, out: 25 / 1e6 },
};
export const AI_DEFAULT_MODEL = 'claude-sonnet-4-6';

// USD cost of one call: input_tokens*rate_in + output_tokens*rate_out, by model. Throws on an
// unknown model so a typo can never be silently billed at $0 (the caller validates up front).
// Missing/negative token counts clamp to 0 (a model can report only one of the two). Every rate
// is an integer multiple of $1e-6/token, so the true cost is always a whole number of micro-
// dollars; we round to 1e-6 to shed binary-float noise (e.g. 0.013500000000000002 -> 0.0135)
// rather than let it accumulate in the monthly spend tracker.
export function aiCost(model, inTok, outTok) {
    const r = AI_MODELS[model];
    if (!r) throw new Error('unknown model: ' + model);
    const i = Number(inTok) > 0 ? Number(inTok) : 0;
    const o = Number(outTok) > 0 ? Number(outTok) : 0;
    return Math.round((i * r.in + o * r.out) * 1e6) / 1e6;
}

// The "YYYY-MM" key for a Date (defaults to now). The spend tracker rolls over when this changes.
export function monthKey(d = new Date()) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// Roll the spend tracker forward: if its month differs from `currentMonth` (or the object is
// missing/invalid), reset usd to 0 and stamp the new month. Pure — returns a NEW object, never
// mutates the input — so the caller decides when to persist. usd is coerced to a finite number.
export function rollSpend(spend, currentMonth) {
    const s = (spend && typeof spend === 'object') ? spend : {};
    const usd = Number(s.usd);
    if (s.month === currentMonth) {
        return { month: currentMonth, usd: usd > 0 ? usd : 0 };
    }
    return { month: currentMonth, usd: 0 };
}

// Whether the running spend has reached/exceeded the monthly cap. At-or-over is over (so a call
// that would tip past the cap is refused before it is made). Non-finite spend reads as 0.
export function capExceeded(spend, cap) {
    const usd = Number(spend) > 0 ? Number(spend) : 0;
    const c = Number(cap);
    if (!(c > 0)) return false;   // a non-positive/invalid cap means "no cap"
    return usd >= c;
}

// —— Projects (persistent project-manager store). The pure shape/log helpers live here so they
// unit-test without booting the hub; the file I/O + endpoints stay in jarvis-core.mjs.
export const PROJECT_LOG_CAP = 50;   // keep the most-recent N log entries so the store can't grow forever
// Coerce a stored project object into the current shape: backfill missing fields, clamp the log,
// drop junk. Pure — never invents timestamps (the caller stamps createdAt/updatedAt), returns a
// NEW object, and returns null for anything without a usable name so a bad row is dropped, not
// silently half-migrated.
export function normalizeProject(p) {
    if (!p || typeof p !== 'object') return null;
    const name = String(p.name == null ? '' : p.name).toLowerCase().trim();
    if (!name) return null;
    const c = (p.context && typeof p.context === 'object') ? p.context : {};
    const docs = (Array.isArray(c.docs) ? c.docs : []).map(d => (d && typeof d === 'object')
        ? { label: String(d.label == null ? (d.url || '') : d.label), url: String(d.url == null ? '' : d.url) }
        : { label: String(d), url: String(d) });
    const recentLog = (Array.isArray(c.recentLog) ? c.recentLog : [])
        .filter(e => e && typeof e === 'object')
        .map(e => ({ ts: String(e.ts || ''), from: String(e.from || ''), note: String(e.note == null ? '' : e.note) }))
        .slice(-PROJECT_LOG_CAP);
    return {
        name,
        title: String(p.title == null ? name : p.title).trim() || name,
        status: ['active', 'paused', 'archived'].includes(p.status) ? p.status : 'active',
        missionId: p.missionId ? String(p.missionId) : null,
        managerUid: p.managerUid ? String(p.managerUid) : null,
        context: {
            summary: String(c.summary == null ? '' : c.summary),
            currentFocus: String(c.currentFocus == null ? '' : c.currentFocus),
            openThreads: (Array.isArray(c.openThreads) ? c.openThreads : []).map(String).map(s => s.trim()).filter(Boolean),
            recentLog,
            docs,
        },
        workers: (Array.isArray(p.workers) ? p.workers : []).filter(w => w && typeof w === 'object'),
        createdAt: p.createdAt ? String(p.createdAt) : '',
        updatedAt: p.updatedAt ? String(p.updatedAt) : '',
    };
}
// Push an entry onto an append-only, capped log. Pure — returns a NEW array holding the most
// recent `cap` entries, so a project's context store can't grow without bound.
export function pushCapped(arr, entry, cap = PROJECT_LOG_CAP) {
    const next = (Array.isArray(arr) ? arr.slice() : []);
    next.push(entry);
    return next.length > cap ? next.slice(next.length - cap) : next;
}

// Compose the read-only STORY brief a parentProject SUB-WORKER is seeded with on boot (Chris's ask:
// "workers get their context from the mission"). Given the parent project object and its linked
// mission (or null), returns a compact prose brief — project title, the mission it serves + phase
// progress, where the project stands, current focus, and open threads — so an ephemeral sub-worker
// inherits the history without rehydrating the store or acting as the coordinator. Its TASK stays its
// own; this is only context. Returns '' when there is no project to describe. Pure: reads its args,
// mutates nothing, invents nothing.
export function subworkerBrief(project, mission) {
    if (!project || typeof project !== 'object') return '';
    const c = (project.context && typeof project.context === 'object') ? project.context : {};
    const title = String(project.title || project.name || 'the project').trim();
    let head = 'the ' + String(project.name || title) + ' project ("' + title + '")';
    if (mission && mission.title) {
        head += ', serving the mission "' + String(mission.title).trim() + '"';
        const ph = Array.isArray(mission.phases) ? mission.phases : [];
        if (ph.length) head += ' (' + ph.filter(p => p && p.done).length + ' of ' + ph.length + ' phases done)';
    }
    const parts = [head + '.'];
    if (c.summary && String(c.summary).trim()) parts.push('Where it stands: ' + String(c.summary).trim());
    if (c.currentFocus && String(c.currentFocus).trim()) parts.push('Current focus: ' + String(c.currentFocus).trim() + '.');
    const ot = Array.isArray(c.openThreads) ? c.openThreads.map(String).map(s => s.trim()).filter(Boolean) : [];
    if (ot.length) parts.push('Open threads: ' + ot.join('; ') + '.');
    return parts.join(' ');
}

// —— Missions (persistent, voice-gated objective tracker). The pure shape + phrase helpers live
// here so they unit-test without booting the hub; the file I/O, id/timestamp stamping, and the
// voice state machine stay in jarvis-core.mjs. Closing a mission is a two-step spoken gate
// ("mission accomplished" -> "yes"), so the phrase predicates below are the safety-critical bits
// most worth testing in isolation.

// Coerce a raw mission into the canonical shape: trimmed title, phases as {text,done}, docs as
// {label,url}, status restricted to active|archived. Pure — never invents timestamps (createdAt/
// archivedAt are preserved as-is; the caller stamps a fresh mission), keeps an existing `id` else
// falls back to the supplied one, and returns null only for a non-object so a junk row is dropped
// rather than half-shaped. Lenient on an empty title (the /mission add endpoint rejects those with
// a 400; a transient blank must not collapse to null).
export function normalizeMission(raw, fallbackId) {
    if (!raw || typeof raw !== 'object') return null;
    const id = (typeof raw.id === 'string' && raw.id.trim()) ? raw.id : String(fallbackId == null ? '' : fallbackId);
    const phases = (Array.isArray(raw.phases) ? raw.phases : []).map(p => (p && typeof p === 'object')
        ? { text: String(p.text == null ? '' : p.text), done: !!p.done }
        : { text: String(p), done: false });
    const docs = (Array.isArray(raw.docs) ? raw.docs : []).map(d => (d && typeof d === 'object')
        ? { label: String(d.label == null ? (d.url || '') : d.label), url: String(d.url == null ? '' : d.url) }
        : { label: String(d), url: String(d) });
    return {
        id,
        title: String(raw.title == null ? '' : raw.title).trim(),
        phases,
        docs,
        status: raw.status === 'archived' ? 'archived' : 'active',
        createdAt: String(raw.createdAt == null ? '' : raw.createdAt),
        archivedAt: raw.archivedAt == null ? null : String(raw.archivedAt),
    };
}

// Percent of a mission's phases that are done (0 when it has none). Pure.
export function missionProgress(mn) {
    const ph = (mn && Array.isArray(mn.phases)) ? mn.phases : [];
    if (!ph.length) return 0;
    return Math.round(ph.filter(p => p.done).length / ph.length * 100);
}

// —— Voice-gate phrase predicates. These operate on already-canonicalized lowercase speech, except
// parseNewMissionTitle which takes the raw text so it can keep the spoken title's casing. The
// regexes are copied verbatim from the handleUtterance gate so spoken behavior is unchanged —
// extracted only so the gate can be tested without the server.

// "mission accomplished" / "close|complete|finish|archive [the|this] mission" — arms the close gate.
export function isMissionCloseIntent(lower) {
    return /\bmission accomplished\b|\b(close|complete|finish|archive) (the |this )?mission\b/.test(String(lower == null ? '' : lower));
}
// Affirmative confirmation of an armed close gate.
export function isMissionConfirm(lower) {
    return /\b(ye(s|ah|p)|confirm(ed)?|do it|affirmative|i'?m sure|absolutely|aye)\b/.test(String(lower == null ? '' : lower));
}
// Explicit cancel of an armed close gate.
export function isMissionCancel(lower) {
    return /\b(no|nope|cancel|stop|never ?mind|not yet|hold on|wait)\b/.test(String(lower == null ? '' : lower));
}
// "new|start|begin|create|add [a] mission: <title>" — returns the trimmed title, or null when the
// phrase isn't a mission-create. An empty string means the phrase matched but named nothing.
export function parseNewMissionTitle(text) {
    const m = /^(?:jarvis[\s,.!]+)?(?:new|start|begin|create|add) (?:a )?mission[:\s]+(.+)$/i.exec(String(text == null ? '' : text).trim());
    return m ? m[1].trim() : null;
}
// Which active mission a spoken close refers to: the only one when a single mission is active, else
// the first whose title's leading word appears in the utterance. null when nothing matches.
export function matchMissionByPhrase(active, lower) {
    const list = Array.isArray(active) ? active : [];
    if (list.length === 1) return list[0];
    const l = String(lower == null ? '' : lower);
    return list.find(x => x && x.title && l.includes(String(x.title).toLowerCase().split(/[\s→>\-]+/)[0])) || null;
}

// Command families where the second word is the real verb, so one "Always" covers the family
// ("git show" / "npm run") rather than every distinct argument list.
export const PERM_MULTIWORD = new Set(['git', 'npm', 'pnpm', 'yarn', 'dotnet', 'ng', 'npx', 'node', 'python', 'python3', 'pip', 'go', 'cargo', 'docker', 'kubectl', 'powershell']);
// A coarse signature so one "Always" covers a whole command family: Bash/PowerShell collapse to
// their leading verb ("git show abc" -> "Bash::git show"); other tools collapse to the tool name.
export function permSig(tool, detail) {
    if (tool === 'Bash' || tool === 'PowerShell') {
        const toks = String(detail || '').trim().split(/\s+/);
        const n = PERM_MULTIWORD.has((toks[0] || '').toLowerCase()) ? 2 : 1;
        return tool + '::' + toks.slice(0, n).join(' ').toLowerCase();
    }
    return tool + '::*';
}
// Human-readable label for a permission family ("git show *" / "Bash").
export function permLabel(tool, detail) {
    if (tool === 'Bash' || tool === 'PowerShell') {
        const toks = String(detail || '').trim().split(/\s+/);
        const n = PERM_MULTIWORD.has((toks[0] || '').toLowerCase()) ? 2 : 1;
        return toks.slice(0, n).join(' ') + ' *';
    }
    return tool;
}

// Normalize the NATO aliases STT commonly mangles (x-ray / x ray -> xray, juliette -> juliet).
export function canon(s) {
    return s.replace(/\bx[\s-]ray\b/gi, 'xray').replace(/\bjuliette\b/gi, 'juliet');
}

// Display-order task list for a session (matches the console card: review -> working -> queued
// -> done). The position in this array is the 1-based index the human sees and speaks.
export function orderedTasks(board) {
    const out = [];
    for (const list of ['review', 'working', 'queued', 'done']) {
        (board[list] || []).forEach((item, i) => out.push({ item, list, i }));
    }
    return out;
}

// Reverse of the mission<->project link: the project that hosts a mission's coordinator. Missions
// point nowhere; projects carry project.missionId, so this scans projects for the match. Returns
// the first matching project object or null. Used to route "talk to the mission" -> its manager.
export function projectForMission(projects, missionId) {
    if (!missionId) return null;
    const list = Array.isArray(projects) ? projects : [];
    return list.find(p => p && p.missionId === missionId) || null;
}

// Resolve a project name to the uid of its ONE live worker. A project (e.g. `jarvis`) is a durable
// board card hosting a single worker that carries `.project=<name>`; the coordinator role rehydrates
// across retires, so at any moment 0..1 sessions should legitimately match. Among the non-ended
// matches we return the MOST-RECENTLY-SEEN one, never merely the first in roster order.
//
// Why most-recent-seen and not first: `.ended` is only set on an explicit /retire, so a worker that
// dies WITHOUT retiring (crash, console kill, machine transfer) lingers in the roster as a non-ended
// "ghost" forever. Returning the first non-ended match then resolves the project to that corpse, and
// a freshly-registered live coordinator is invisible/unreachable until someone manually retires the
// ghost — the invisible-coordinator bug (india shadowed quebec; hotel/juliet before it), and the T2
// root cause. A live worker heartbeats (poll + the 30s ping) so its lastSeen is always fresher than a
// frozen ghost's, so max-lastSeen picks the real one automatically with no manual cleanup. A missing
// or unparseable lastSeen sorts oldest, so a lone match still resolves (never regress to null). Pure:
// takes the sessions map (roster.sessions), reads it, mutates nothing.
export function pickProjectWorker(sessions, name) {
    if (!name || !sessions || typeof sessions !== 'object') return null;
    let best = null, bestSeen = -Infinity;
    for (const uid in sessions) {
        const s = sessions[uid];
        if (!s || s.ended || s.project !== name) continue;
        const t = Date.parse(s.lastSeen);
        const seen = Number.isFinite(t) ? t : 0;
        if (seen > bestSeen) { bestSeen = seen; best = uid; }
    }
    return best;
}

// Who holds a project's COORDINATOR SLOT right now -- live, or spawned and still booting. THE one
// predicate every coordinator-spawn site consults before launching one, because a project gets
// exactly one coordinator and the spawn sites could not previously see each other.
//
// The bug, 2026-07-27 post-restart: primeng ended up with two coordinators 43 seconds apart. `victor`
// (s_0347, 15:04:43) came from reviveMissionCoordinator -- its purpose is the project TITLE, that
// path's signature -- and `whiskey` (s_0349, 15:05:26) came from the retire auto-successor path,
// carrying the retiring coordinator's own purpose line AND its handoff. Both registered
// project:primeng, both were handed the same handoff, and Chris had two brains answering for one
// board. Cause: revive guarded on `missionCoordinatorSpawns`, a map of the spawns IT had made, and
// the successor path guarded on nothing at all -- so a ghost coordinator being retired at the moment
// a mission message revives that same project races into two, and would have recurred every restart.
//
// Held means either of:
//   - LIVE: pickProjectWorker's answer (freshest non-ended session carrying .project === name) seen
//     inside `staleMs`. Reusing pickProjectWorker is deliberate: spawning and routing must never
//     disagree about who a project's coordinator is. A RETIRED coordinator never counts -- cleanup
//     has to keep being able to target the corpse -- and a `.parentProject` sub-worker never counts,
//     since it is nested UNDER the project, not running it.
//   - BOOTING: a spawn whose stashed binding is `project === name` that has not registered yet.
//
// `booting` is the pending-bind stash, taken as a PARAMETER and read as an iterable of
// `[callsign, {project, parentProject, ts}]` entries (a Map satisfies that as-is). It is never read
// from a module global here, and that is load-bearing rather than stylistic: live-spawn state and
// state a restarted hub restores from pidfiles must arrive through the SAME door, or this is right
// for one and wrong for the other. Entries older than `staleMs` are ignored so a spawn that never
// came up cannot wedge the slot shut forever; an entry with no parseable `ts` is treated as fresh,
// because a coordinator delayed by one window is a smaller failure than two coordinators.
//
// Returns { kind:'live', uid, callsign } | { kind:'booting', callsign } | null -- the kind matters to
// callers, not just the boolean: what you tell the human differs, and only a LIVE holder can be sent
// anything. `now`/`staleMs` injected for deterministic tests. Pure: reads, mutates nothing.
export function coordinatorSlotHolder(sessions, booting, name, now, staleMs = 120000) {
    const n = name ? String(name).toLowerCase().trim() : '';
    if (!n) return null;
    const uid = pickProjectWorker(sessions, n);
    if (uid) {
        const s = sessions[uid] || {};
        const t = Date.parse(s.lastSeen);
        if (Number.isFinite(t) && (now - t) < staleMs) return { kind: 'live', uid, callsign: s.callsign || null };
    }
    // A half-written or wrong-shaped stash must degrade to "nobody is booting", never throw: this runs
    // on the retire path, and a throw here would strand a session mid-retire.
    if (!booting || typeof booting[Symbol.iterator] !== 'function') return null;
    for (const e of booting) {
        if (!Array.isArray(e)) continue;
        const [cs, b] = e;
        if (!b || typeof b !== 'object') continue;
        if (!b.project || String(b.project).toLowerCase().trim() !== n) continue;
        const ts = typeof b.ts === 'number' ? b.ts : Date.parse(b.ts);   // epoch ms today; an ISO string from a restore also works
        if (Number.isFinite(ts) && (now - ts) >= staleMs) continue;
        return { kind: 'booting', callsign: cs ? String(cs) : null };
    }
    return null;
}

// Resolve a project name to the cwd its coordinator last lived in, so an auto-revived coordinator
// (T2) spawns in the RIGHT repo even when the previous one is a dead ghost. Unlike pickProjectWorker
// this deliberately includes ENDED sessions: once a coordinator retires or dies the durable project
// column stays put but nothing live still carries the cwd, so we fall back to the most-recently-seen
// session that ever hosted the project (ended or not) and reuse where it worked. Returns null only
// when the project has never had a worker at all (nothing to infer the repo from). Pure: reads the
// sessions map, mutates nothing.
export function lastProjectCwd(sessions, name) {
    const hit = newestProjectSession(sessions, name);
    return hit ? hit.cwd : null;
}
// The scan behind lastProjectCwd, keeping the timestamp too: projectOwningCwd needs BOTH the repo a
// project last lived in and how recently, to break a tie when two projects claim one repo. One
// source of truth so "which repo is this project's" can never disagree between the two callers.
function newestProjectSession(sessions, name) {
    if (!name || !sessions || typeof sessions !== 'object') return null;
    let best = null, bestSeen = -Infinity;
    for (const uid in sessions) {
        const s = sessions[uid];
        if (!s || s.project !== name || !s.cwd) continue;
        const t = Date.parse(s.lastSeen);
        const seen = Number.isFinite(t) ? t : 0;
        if (seen > bestSeen) { bestSeen = seen; best = { cwd: String(s.cwd), seen }; }
    }
    return best;
}

// Resolve a configured repo (repos.json) by working directory. Pure: the caller supplies the store.
//
// Matching goes through cwdKey, which is the whole point. repos.json holds hand-written forward-slash
// paths (d:/claude/jarvis-core); a session's cwd is the Windows path it booted in
// (d:\claude\jarvis-core). The old case-insensitive string compare missed every backslash caller, so
// a worker spawned in a CONFIGURED repo fell through to `adhoc` and silently lost that repo's
// permissionMode and tier -- which is why Chris kept being woken to approve routine commits in a repo
// he had marked bypassPermissions. Returns the repo row with its key attached, or null.
export function matchRepo(repos, cwd) {
    const key = cwdKey(cwd);
    if (!key || !repos || typeof repos !== 'object') return null;
    for (const k of Object.keys(repos)) {
        const r = repos[k];
        if (r && typeof r === 'object' && cwdKey(r.cwd) === key) return { key: k, ...r };
    }
    return null;
}

// Build the repos.json row for POST /repos. Pure: merge the posted fields over the row already there.
//
// Two defects this closes, both found on 2026-07-27 while probing whether a757af9 had shipped:
// (1) `tier` was UNSETTABLE. resolveRepo(cwd).tier is live-read in two places -- registerSession (the
//     session's trust tier) and spawnWorker (effTier) -- but the endpoint never wrote it, so the only
//     way in was hand-editing repos.json under JARVIS_DATA, which no session is allowed to do. The
//     symptom that led here: a jarvis-core session reads tier `guarded` no matter what, because the
//     row has no tier field at all, which reads exactly like a failed deploy.
// (2) the row was REBUILT from the body, so a partial re-register silently ERASED whatever it omitted
//     -- a hand-written tier, a model, the defaultPurpose. Same class of bug as the slash mismatch:
//     the config is right there in the file and gets dropped in transit.
// Merging matches the /project-context convention -- send only the fields that changed. Passing an
// empty value for an optional field CLEARS it, so a repo can be taken back off bypassPermissions.
export function repoRow(prev, body) {
    const b = body && typeof body === 'object' ? body : {};
    const row = { ...(prev && typeof prev === 'object' ? prev : {}) };
    if (b.cwd) row.cwd = String(b.cwd);
    if (typeof b.defaultPurpose === 'string') row.defaultPurpose = b.defaultPurpose;
    for (const f of ['permissionMode', 'model']) {
        if (b[f] === undefined) continue;
        if (b[f]) row[f] = String(b[f]); else delete row[f];
    }
    // `trusted` is the only tier that grants anything; guarded IS the absence of the field, so never
    // store a typo as a tier -- a misspelled 'trused' that persisted would read as deliberate config.
    if (b.tier !== undefined) {
        if (String(b.tier) === 'trusted') row.tier = 'trusted'; else delete row.tier;
    }
    row.cwd = row.cwd || '';
    row.defaultPurpose = row.defaultPurpose || '';
    return row;
}

// #39 AUTO-BIND. Which project OWNS a working directory -- the backstop that stops the recurring
// "standalone card outside the mission" fragmentation Chris kept hitting.
//
// A session that boots in a repo already owning an active mission-backed project, but registers
// with no `project`/`parentProject` (a hand-started session, or the auto-successor of a standalone,
// which has no spawn intent to stash), used to get its own orphan NATO column. Two-plus cards for
// one mission and the hub cannot tell which is the brain. resolveBinding fixes that only when the
// hub SPAWNED the worker and knew the intent; this infers it from repo identity instead, so it
// catches the paths the stash cannot see.
//
// Gated on missionId deliberately: only mission-backed projects auto-capture sessions, so an
// incidental repo that once hosted a plain worker never starts swallowing unrelated ones. That gate
// is also why a jarvis-core session stays its own `jarvis` card -- the jarvis project has no
// mission. Projects carry no repo field today, so the repo is INFERRED from their sessions
// (newestProjectSession); an explicit project.repo would remove the inference but needs a store
// migration, so it stays a follow-up.
//
// Returns null, or {name, ambiguous} -- ambiguous is how many active mission-backed projects claim
// this repo (1 is the clean case). More than one is real, not hypothetical: d:/code/tms is claimed
// by both `primeng` and `mycarrierpackets`. Most-recent-session wins, and the caller logs the
// collision rather than silently guessing. Pure: reads, mutates nothing.
export function projectOwningCwd(projects, sessions, cwd) {
    const key = cwdKey(cwd);
    if (!key) return null;
    const list = Array.isArray(projects) ? projects : (projects && Array.isArray(projects.projects) ? projects.projects : null);
    if (!list) return null;
    let best = null, bestSeen = -Infinity, matches = 0;
    for (const p of list) {
        if (!p || !p.name || p.status !== 'active' || !p.missionId) continue;
        const hit = newestProjectSession(sessions, p.name);
        if (!hit || cwdKey(hit.cwd) !== key) continue;
        matches++;
        if (hit.seen > bestSeen) { bestSeen = hit.seen; best = String(p.name); }
    }
    return best ? { name: best, ambiguous: matches } : null;
}

// Resolve which session currently HOLDS console focus. Focus is one of: the solo brain 'jarvis'
// (holds no session), a live NATO callsign, or a project name hosting a coordinator. Returns the
// holder's uid, or null when focus is idle/on jarvis/unresolvable. `callsigns` maps a NATO callsign
// to [newest..oldest uid] (roster.callsigns); `sessions` is roster.sessions. Pure: reads, mutates
// nothing.
export function focusHolderUid(focus, sessions, callsigns) {
    if (!focus || focus === 'jarvis' || !sessions || typeof sessions !== 'object') return null;
    const l = callsigns && callsigns[focus];
    if (l && l.length) {                          // focus is a NATO callsign -> its newest session
        const s = sessions[l[0]];
        return (s && !s.ended) ? l[0] : null;
    }
    return pickProjectWorker(sessions, focus);    // else treat focus as a project name
}

// Would a newly-registered session (newUid) STEAL console focus from the human's live conversation
// with a DIFFERENT worker? True only when focus is currently held by ANOTHER session that is not
// ended and was seen within `staleMs`. So: re-grabbing your own focus is never a steal (uid ===
// newUid -> false), and a gone-quiet/dead holder never blocks a legitimate grab (stale -> false).
// This is the guard that stops a successor/sub-worker register from yanking the human off a
// coordinator mid-walkthrough. `now` + `staleMs` injected for deterministic tests. Pure.
export function focusHeldByLiveOther(focus, sessions, callsigns, newUid, now, staleMs = 120000) {
    const uid = focusHolderUid(focus, sessions, callsigns);
    if (!uid || uid === newUid) return false;
    const s = sessions[uid];
    if (!s || s.ended) return false;
    const t = Date.parse(s.lastSeen);
    return Number.isFinite(t) && (now - t) < staleMs;
}

// Decide what a registering session is BOUND to: a project (it coordinates that project's card),
// a parentProject (it nests under one as a sub-worker), or neither (a standalone card).
//
// Two sources disagree in practice. The worker sends what its boot prompt told it to echo -- and
// workers drop the field, which used to silently mint an orphan standalone card instead of nesting.
// `bind` is what the spawner stashed when it created the callsign, i.e. what the hub actually
// intended. Precedence: an explicit field from the worker beats the stash (it may know better --
// it could have been re-tasked), and project beats parentProject, because a session is one role or
// the other and a coordinator ignores parentProject entirely.
//
// Returns { project, parentProject }, lowercased and trimmed, each null when absent. Pure.
export function resolveBinding(project, parentProject, bind) {
    const norm = v => {
        const s = v ? String(v).toLowerCase().trim() : '';
        return s || null;
    };
    const b = bind || {};
    const proj = norm(project) || norm(b.project);
    return { project: proj, parentProject: proj ? null : (norm(parentProject) || norm(b.parentProject)) };
}

// Where console focus should land when the focused board goes away (a retire, a /forget). Returns
// a BOARD KEY -- the thing that actually has a card -- never a raw callsign that has none.
//
// That distinction is the bug this fixes. A project-bound worker renders on its PROJECT's card; its
// own NATO callsign has no card at all. The old repair grabbed the first live NATO callsign it
// could find, so forgetting one dead card could focus 'charlie' -- a jarvis-project worker -- which
// both minted a phantom standalone charlie card and yanked focus off wherever the human was.
//
// `live` is [{callsign, project}] for alive sessions in preference order; `exclude` is the board key
// being torn down. Falls back to the solo brain. Pure: reads, mutates nothing.
export function nextFocusKey(live, exclude = null) {
    for (const c of live || []) {
        const key = c && (c.project || c.callsign);
        if (key && key !== exclude) return key;
    }
    return 'jarvis';
}

// Which BOARD a callsign's work belongs on: the PROJECT key for a project-bound session, else the
// callsign itself. The companion to nextFocusKey above -- that one picks a board key, this one
// converts a callsign into one.
//
// The invariant is already stated twice in this codebase (nextFocusKey's comment, and the
// project-worker comment in jarvis-core): a project-bound worker renders on its PROJECT's card and
// its own NATO callsign has no card at all. registerSession honours it -- ensureBoard(w, proj || cs)
// -- but three other sites did not, and called ensureBoard on whatever callsign they were handed. So
// a coordinator that posted /worklist as ITSELF instead of as its project MINTED A SECOND BOARD.
// Chris hit it on 2026-07-27: primeng and juliet sat on screen as two separate trackers for one
// session, showing the same pending permission prompt twice, the 154-card backlog on one and two
// stray cards on the other. Focusing the NATO callsign of a bound worker had the same effect.
// Same class as the phantom-card focus bug (3696440): a raw NATO callsign used where a board key was
// needed.
//
// `sessions` is roster.sessions; `callsigns` maps a callsign to its uids, newest first. Only
// `project` binds -- a `parentProject` SUB-worker legitimately owns its own card (that is what it
// nests under the coordinator), so it maps to itself. A retired session does not bind either: a dead
// coordinator's callsign resolves to the callsign, so cleanup paths can still find its own card.
// Pure: reads, mutates nothing.
export function boardKeyFor(cs, sessions, callsigns) {
    const key = cs ? String(cs).toLowerCase().trim() : '';
    if (!key || key === 'jarvis') return key;
    const list = callsigns && callsigns[key];
    const uid = Array.isArray(list) && list.length ? list[0] : null;
    const s = uid && sessions ? sessions[uid] : null;
    if (!s || s.ended) return key;
    const proj = s.project ? String(s.project).toLowerCase().trim() : '';
    return proj || key;
}

// A session's liveness has TWO independent signals, and they can disagree. `/heartbeat` is a dumb
// background timer; `/poll` is the worker's actual event loop -- its ears. When the poll loop dies
// but the heartbeat timer keeps ticking, the session looks perfectly green while being completely
// DEAF. That took PrimeNG down for ~12 minutes on 2026-07-24 (coordinator lima): Chris talked, the
// hub queued his words against a corpse, and nothing on the board looked wrong. `lastSeen` cannot
// see it, because BOTH endpoints bump it -- which is why the hub now records lastPoll and lastBeat
// separately and asks this helper whether they disagree.
//
// Returns null when there is nothing to report, else { minutes, pending }: how long the session has
// gone without polling, and how many events are queued that it has not picked up.
//
// Deliberately conservative -- it reports POSSIBLY wedged, and stays silent for:
//   - an ended session, or one with no fresh heartbeat (the ordinary gone-quiet path already says
//     that, louder -- this is only for the case that path CANNOT see),
//   - a poll loop that is merely between cycles (grace defaults to 5min, ~12x the 25s long-poll).
// A long agent turn does not relaunch the poll loop, so a genuinely busy worker can trip this
// honestly. That is intended: from the human's side, "busy for 6 minutes with my words queued up"
// and "wedged" are the same outage. `pending` is what separates them -- 0 means nobody is waiting.
// `now` injected for deterministic tests. Pure: reads, mutates nothing.
export function wedgeState(s, now, { graceMs = 300000, staleMs = 120000, pending = 0 } = {}) {
    if (!s || s.ended) return null;
    const beat = Date.parse(s.lastBeat);
    if (!Number.isFinite(beat) || (now - beat) >= staleMs) return null;
    // Never polled at all? Measure from registration: a worker that came up but never launched its
    // loop is wedged from birth (a real boot failure), not exempt from the check.
    const ref = Date.parse(s.lastPoll || s.started);
    if (!Number.isFinite(ref)) return null;
    const deaf = now - ref;
    if (deaf < graceMs) return null;
    return { minutes: Math.floor(deaf / 60000), pending };
}

// Parse a JSON request body, tolerating the single most common worker mistake: a Windows path
// pasted into `curl -d` with un-escaped backslashes, e.g. {"cwd":"d:\claude\jarvis-core"}. That
// is invalid JSON (\c, \j, \u<not-4-hex> are not valid escapes), so a strict JSON.parse throws and
// readBody swallowed it to {} — which on /register surfaces as the misleading "purpose and cwd are
// required" even though both were sent (the register-escape bug; nearly every fresh Windows worker
// hits it on boot).
//
// A VALID body parses on the first try and never touches the repair path, so well-formed payloads
// are left byte-for-byte untouched. Only when the strict parse FAILS do we retry once, treating the
// body as a raw-pasted path: we double every LONE backslash so it survives as a real path separator.
// Ordered alternation preserves the sequences that carry JSON structure — an already-escaped pair
// `\\`, an escaped quote/slash `\"` `\/`, and a `\uXXXX` unicode escape — matching each as a unit so
// it passes through untouched; everything else (a lone `\`, including `\b \f \n \r \t` which would
// otherwise mangle common path segments like c:\bin, c:\temp, c:\node into control chars) is doubled.
// Because repair only runs on already-broken input, we cannot recover a truly-intended \n/\t in a
// malformed body — but a client that meant those sends valid JSON and never reaches here. Pure; never throws.
export function parseBodyLenient(data) {
    if (!data) return {};
    try { return JSON.parse(data); } catch { }
    try {
        const repaired = data.replace(/\\\\|\\u[0-9a-fA-F]{4}|\\["\/]|\\/g, m => (m === '\\' ? '\\\\' : m));
        return JSON.parse(repaired);
    } catch { }
    return {};
}

// —— Per-worker git worktree isolation (docs/WORKTREE-ISOLATION-DESIGN.md, P1) ————————————————————
// Chris, 2026-07-24: "how do we make it so jarvis can work on multiple items in the same repository
// so it doesn't f*** up with what I'm working on ... something with worktrees." Every worker used to
// launch in repo.cwd — the same working tree Chris has open — so two workers, or a worker and Chris,
// edited the SAME files: WIP clobbers, branch churn, a worker trampling whatever he had open.
//
// These helpers are the decidable half of the fix: WHERE a worktree goes, WHAT it forks from, WHICH
// workers get one, and WHICH leftovers are safe to sweep. Pure, so the naming and collision rules
// are testable without a real repo (test/worktree.test.mjs). The git calls themselves live in
// jarvis-core.mjs and are strictly best-effort: any failure falls back to the shared cwd.

const WT_DIR = '.jarvis-wt';
const wtSlashes = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

// WT_ROOT: where a repo's worktrees live — a sibling of the repo, one level UP, so a worktree is
// never INSIDE a repo. That placement is load-bearing, not tidiness: a worktree under d:/code/tms
// would show up in that repo's own `git status` as an untracked directory, i.e. new noise in exactly
// the checkout this feature exists to keep clean. d:/code/tms -> d:/code/.jarvis-wt.
// `override` (JARVIS_WT_ROOT) wins, for tests and for parking worktrees on another disk. A drive
// root or garbage returns null — there is no safe sibling — and the caller then shares the cwd.
export function worktreeRoot(repoCwd, override) {
    if (override) return wtSlashes(override);
    const p = wtSlashes(repoCwd);
    const cut = p.lastIndexOf('/');
    if (cut <= 0) return null;              // '', 'd:', 'd:/', '/foo' — nothing to sit beside
    return p.slice(0, cut) + '/' + WT_DIR;
}

// Which branch a worktree forks FROM. The repo's CURRENT branch is the integration line the human is
// on (e.g. NewBeta2), so workers fork off it and merge back cleanly — and because a worktree forks
// from committed HEAD, his uncommitted WIP is neither visible to the worker nor clobberable by it.
//
// `git rev-parse --abbrev-ref HEAD` answers the literal string 'HEAD' when the checkout is DETACHED;
// branching from that would fork off a nameless commit, so fall back to a configured base (a repos
// .json `base`) and then to the repo's default branch. Null means we could not name a base at all,
// which means no isolation rather than a wrong one.
export function worktreeBase(head, configured, fallback) {
    const h = String(head || '').trim();
    if (h && h !== 'HEAD' && !/\s/.test(h)) return h;
    const c = String(configured || '').trim();
    if (c) return c;
    return String(fallback || '').trim() || null;
}

// Where THIS worker's worktree goes and what its branch is called:
//   branch = jarvis/<callsign>,  path = <WT_ROOT>/<repoKey>-<callsign>
// Names stay short deliberately — a worktree is a full checkout and Windows still has MAX_PATH.
//
// The collision case is NOT hypothetical. Retire keeps the branch (it is the deliverable, awaiting
// merge) and callsigns are recycled, so the second worker ever spawned as `xray` in a repo meets an
// existing jarvis/xray and `worktree add -b` fails outright — isolation would quietly stop happening
// after one lap of the alphabet. So suffix until BOTH the branch and the directory are free.
//
// `inherit` is the successor case: a worker that hands off leaves its work committed on jarvis/<cs>,
// so its replacement CONTINUES that branch (checked out into a fresh worktree, `create:false`)
// rather than forking a new one from base and stranding everything the predecessor did.
export function worktreePlan(repoKey, callsign, repoCwd, base, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const root = worktreeRoot(repoCwd, o.root);
    const cs = String(callsign || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = String(repoKey || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'repo';
    const b = String(base || '').trim();
    if (!root || !cs || !b) return null;
    const taken = new Set((o.taken || []).map(x => String(x).toLowerCase()));
    const dirs = new Set((o.paths || []).map(p => wtSlashes(p).toLowerCase()));
    const inherit = String(o.inherit || '').trim();
    for (let n = 1; n <= 99; n++) {
        const sfx = n > 1 ? '-' + n : '';
        const path = root + '/' + key + '-' + cs + sfx;
        if (dirs.has(path.toLowerCase())) continue;
        if (inherit) return { root, path, branch: inherit, base: b, create: false };
        const branch = 'jarvis/' + cs + sfx;
        if (taken.has(branch.toLowerCase())) continue;
        return { root, path, branch, base: b, create: true };
    }
    return null;
}

// Which workers get a worktree. A checkout costs real disk, so this is not free — but the wrong
// answer in the OTHER direction puts a code-mutating worker back in the human's working tree, which
// is the entire thing we are preventing. The bias is therefore deliberate: when in doubt, isolate.
//
// - sub-worker (`parentProject` — the only workers the hub hands build tasks to): YES.
// - coordinator (`project`): NO. It delegates rather than edits (manager-stays-thin) and must stay in
//   the real checkout, since it answers questions about the repo the human is looking at.
// - meeting worker: NO — it takes notes, it does not build.
// - non-git cwd: NO — nothing to fork from; the caller shares the cwd and logs.
// - an explicit `isolate` flag on the spawn body always wins, in either direction.
// Read-only wording opts a sub-worker out, and that keyword list stays TIGHT on purpose: guessing
// "share" wrong can clobber the human's tree; guessing "isolate" wrong costs one directory.
export function shouldIsolate(spec) {
    const s = spec && typeof spec === 'object' ? spec : {};
    if (s.git === false) return false;
    if (s.isolate === true) return true;
    if (s.isolate === false) return false;
    if (s.project || s.meeting) return false;
    if (!s.parentProject) return false;
    return !/\b(research|read[\s-]?only|readonly|investigate|audit|triage|watch|monitor|explore|browse)\b/i.test(String(s.purpose || ''));
}

// Sort every unended roster row into "still running" and "corpse", given the set of callsigns that
// have a live worker host process behind them. This is the thing that stops /roster reporting five
// live sessions when two processes exist.
//
// The evidence is deliberately graded, because being wrong is expensive in both directions: bury a
// live worker and its board and worktree go with it; spare a dead one and the ghost keeps taking
// focus, keeps being routed messages nobody reads, and keeps its cards on the board forever.
//   live      — a host pid is running for that callsign. Deterministic, nothing to argue with.
//   provable  — `launch:'pty'` and no host. A console-less worker's host writes its pidfile before
//               it starts claude, so no pidfile means no process. Dead, immediately, no window.
//   suspected — no host and no `launch:'pty'`: a wt tab, or a session started by hand. Both
//               legitimately outlive the hub and never had a pidfile, so the only evidence left is
//               the heartbeat — which is exactly the evidence that is worthless right after a
//               restart, when every survivor's lastSeen is frozen at pre-restart. Hence
//               `provableOnly`: the caller runs once at boot with it set, then again after a grace
//               window with it clear, by which time a survivor has polled and looks warm.
export function reconcileRoster(sessions, liveHosts, now, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : 120000;
    const hosts = liveHosts instanceof Set ? liveHosts : new Set(liveHosts || []);
    const out = { readopt: [], ghosts: [] };
    for (const uid of Object.keys(sessions || {})) {
        const s = sessions[uid];
        if (!s || s.ended) continue;
        const cs = s.callsign;
        if (hosts.has(cs)) { out.readopt.push({ uid, cs }); continue; }
        const provable = s.launch === 'pty';
        const seen = Date.parse(s.lastSeen);
        const warm = Number.isFinite(seen) && (now - seen) < staleMs;
        if (provable || (!o.provableOnly && !warm)) out.ghosts.push({ uid, cs, provable });
    }
    return out;
}

// Which directories under WT_ROOT belong to nobody. A worker that dies leaves its worktree on disk
// with no session to ever clean it up, so something has to collect them — otherwise the disk fills
// with dead checkouts and, worse, a recycled callsign trips over its own leftover directory and
// silently loses isolation.
//
// This used to say "a hub restart kills every console-less worker, so boot has to collect them".
// That was true and is not any more: workers now run in their own pty-host process and outlive the
// hub deliberately. Sweeping on that old assumption deletes a LIVE worker's working directory and
// its uncommitted work with it, so the assumption is worth naming as dead rather than leaving the
// next reader to infer it.
//
// Two ways a directory is claimed, in order of how much they are worth trusting:
//   opts.claimed — paths the caller can PROVE are in use, from a live host pid or a worktree cut
//                  for a worker that has not registered yet. Deterministic; outranks everything.
//   heartbeat    — an unended session whose lastSeen is inside `staleMs`. The only signal available
//                  for a worker the caller holds no pid for (a wt tab, or one Chris started by
//                  hand), but note it is useless immediately after a restart, when every survivor's
//                  lastSeen is frozen at whatever it was before the hub went down. A caller running
//                  at boot must give survivors time to check in before trusting this.
// Removal is the caller's job and it commits any WIP to the branch first — nothing is swept unsaved.
export function orphanWorktrees(dirs, sessions, now, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : 120000;
    const live = new Set();
    for (const p of (o.claimed || [])) if (p) live.add(wtSlashes(p).toLowerCase());
    for (const uid in (sessions || {})) {
        const s = sessions[uid];
        if (!s || s.ended || !s.worktree) continue;
        const seen = Date.parse(s.lastSeen);
        if (Number.isFinite(seen) && (now - seen) < staleMs) live.add(wtSlashes(s.worktree).toLowerCase());
    }
    return (dirs || []).filter(d => d && !live.has(wtSlashes(d).toLowerCase()));
}
