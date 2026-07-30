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

// Should this registering session be ASKED to pull the day's schedule?
//
// The hub holds no Google credentials, so it cannot refresh the schedule itself -- a session with
// Calendar access has to, and a human who has to remember to ask is a human whose calendar goes five
// days stale (it did, on 2026-06-23). What the hub CAN do is ask, once a day, of a session that
// plausibly has that access.
//
// The capability test is the working directory: a session booted in the hub's OWN checkout is a JARVIS
// brain, sharing the config that gives it Calendar in the first place. A TMS worker is not, and
// nudging one wastes a turn it cannot act on.
//
// ONCE a day, deliberately: `nudgedFor` is persisted beside the schedule, so a hub restart cannot
// re-ask and a fleet registering together cannot turn one chore into six. The cost is a day's pull
// lost if the session asked turns out to have no Calendar access -- accepted, because
// jarvis-checkout sessions all carry the same MCP config, so that is a config failure rather than a
// bad draw, and it announces itself in the log instead of quietly repeating.
//
// A SUB-WORKER is never asked. It was spawned for one named job and is usually isolated in a
// worktree; interrupting it with a chore is how a delegated build turns into a distracted one. The
// pull belongs to a brain, so it goes to a coordinator or a standalone session.
//
// Pure: every fact is passed in. `today` is a day STAMP compared for equality, never parsed -- the
// caller supplies whatever it already stores (toDateString), so the comparison cannot disagree with
// the file it is about. Options object rather than positional args: five of the six values are
// strings, and a mis-ordered pair would read as a working call.
export function shouldNudgeSchedulePull({ scheduleDate, nudgedFor, today, sessionCwd, hubCwd, isSubWorker } = {}) {
    if (!today) return false;                       // no notion of "today" -> no notion of stale
    if (scheduleDate === today) return false;       // already pulled
    if (nudgedFor === today) return false;          // already asked
    if (isSubWorker) return false;                  // busy on a delegated job
    const a = cwdKey(sessionCwd);
    return !!a && a === cwdKey(hubCwd);
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
// Returns null, or {name, ambiguous} -- ambiguous is how many live-mission projects claim this repo
// (1 is the clean case). More than one is real, not hypothetical: d:/code/tms is claimed by both
// `primeng` and `mycarrierpackets`. Most-recent-session wins, and the caller logs the collision
// rather than silently guessing. Pure: reads, mutates nothing.
//
// `missions` is the missions store and is REQUIRED, because the gate is not "the project names a
// mission" but "the mission it names is still LIVE". Those read the same until a mission is
// archived, and then they diverge badly: on 2026-07-28 both `macropoint` and `mycarrierpackets`
// still pointed at the ARCHIVED Descartes mission, so three projects raced for d:/code/tms and a
// TMS worker was filed as a primeng sub-worker. A dead mission must not win a repo, or even
// compete for one. Omitting the argument -- or handing over a store nothing can be read out of --
// resolves to "no mission can be confirmed live", which returns null and stands auto-bind DOWN
// rather than guessing: an orphan standalone card is visible and one command to fix, while a
// session bound to a dead mission's project is neither.
export function projectOwningCwd(projects, sessions, cwd, missions) {
    const key = cwdKey(cwd);
    const list = projectList(projects);
    if (!key || !list) return null;
    // ONE enforcement point for "the mission is live", deliberately: an empty set already rejects
    // every project below, so an extra early return here would be a second copy of the same rule
    // with nothing to keep it honest -- a mutation probe cannot tell it apart from a no-op.
    const live = liveMissionIds(missions);
    let best = null, bestSeen = -Infinity, matches = 0;
    for (const p of list) {
        if (!p || !p.name || p.status !== 'active' || !p.missionId) continue;
        if (!live.has(String(p.missionId))) continue;
        const hit = newestProjectSession(sessions, p.name);
        if (!hit || cwdKey(hit.cwd) !== key) continue;
        matches++;
        if (hit.seen > bestSeen) { bestSeen = hit.seen; best = String(p.name); }
    }
    return best ? { name: best, ambiguous: matches } : null;
}
// Which ACTIVE projects have last been worked in this repo, newest occupant first.
//
// Deliberately NOT mission-gated, and that is the whole reason it exists separately from
// projectOwningCwd: this one is not choosing what to BIND a session to, it is answering "is there
// already a brain in this repo" for the spawn path -- and the project that keeps raising that
// question is `jarvis`, the mission-less one the bind gate exists to exclude. On 2026-07-28 two
// jarvis coordinators were spawned into d:/claude/jarvis-core 27 seconds apart and overlapped for
// 76, with nothing in the log to say so. Pure: reads, mutates nothing.
export function activeProjectsForCwd(projects, sessions, cwd) {
    const key = cwdKey(cwd);
    const list = projectList(projects);
    if (!key || !list) return [];
    const hits = [];
    for (const p of list) {
        if (!p || !p.name || p.status !== 'active') continue;
        const hit = newestProjectSession(sessions, p.name);
        if (!hit || cwdKey(hit.cwd) !== key) continue;
        hits.push({ name: String(p.name), seen: hit.seen });
    }
    return hits.sort((a, b) => b.seen - a.seen).map(h => h.name);
}
// The projects store arrives either as the raw {projects:[...]} file or as the bare array, depending
// on the caller; one reader so a malformed store is null (never a throw) in both places.
function projectList(projects) {
    if (Array.isArray(projects)) return projects;
    return (projects && Array.isArray(projects.projects)) ? projects.projects : null;
}
// The ids of every mission that has NOT been archived. Mirrors normalizeMission's rule -- archived
// is the only status that means dead, anything else reads as active -- so the gate and the store's
// own normalizer can never disagree about what "live" means. An id missing from this set covers the
// archived case AND the dangling one (a project pointing at a mission that is simply gone).
function liveMissionIds(missions) {
    const list = Array.isArray(missions) ? missions : (missions && Array.isArray(missions.missions) ? missions.missions : null);
    const out = new Set();
    if (!list) return out;
    for (const m of list) {
        if (!m || typeof m !== 'object' || !m.id || m.status === 'archived') continue;
        out.add(String(m.id));
    }
    return out;
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

// Claude Code's first-run FOLDER-TRUST prompt, and why a brand-new worktree walks straight into it.
//
// A worker launched in a directory Claude Code does not trust stops at "Quick safety check: Is this a
// project you created or one you trust?" -- a dialog that fires BEFORE the model starts, so the boot
// prompt never runs and /register is never called. The hub sees no roster row at all: not ended, not
// booting, absent, with the pinned callsign burned. It is indistinguishable from a spawn that simply
// failed, and a console-less worker has nobody to press Enter, so it waits there forever. Three
// broker dispatches died exactly this way on 2026-07-29.
//
// The mechanism is ANCESTOR-INHERITED per-directory trust, measured that night rather than reasoned:
// the real claude, launched through node-pty into fresh directories, prompts when no ancestor is
// trusted and starts clean when one is. d:/claude is trusted, so all eleven jarvis worktrees under
// d:/claude/.jarvis-wt inherited that while their own hasTrustDialogAccepted stayed false; d:/code is
// not trusted, so every broker worktree under it prompted. Measured too, because it is the intuitive
// wrong answer: --permission-mode bypassPermissions does NOT suppress the dialog. The landmine
// therefore waits for any repo whose parent directory is untrusted, whatever permissions it runs with.
//
// So the hub registers the path it just created, and only that path. This is not a new trust decision
// taken on the human's behalf: he configured the repo in repos.json, its checkout is one he already
// works in, and the worktree is an implementation detail of isolation. Marking the PARENT instead
// would be shorter and much too broad -- it would pre-trust every future repo that happens to sit
// beside this one, including ones the hub has never heard of.
//
// Pure, so the merge rule is testable without going near the real config. Returns null when there is
// nothing to do (already trusted, or a path that cannot be keyed) and otherwise the WHOLE object to
// write back, every other key carried through untouched: this is the human's live global config, and
// the only field that is ours to set is this one flag on this one path.
export function claudeTrustPatch(cfg, wtPath) {
    const plain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
    // Trimmed: a path that is only whitespace is not a directory, and a key with stray spaces
    // would never match the one Claude Code looks up. Either way it has no business in that file.
    const key = wtSlashes(wtPath).trim();
    if (!key || !plain(cfg)) return null;
    // A shape we do not recognise is a shape we do not rewrite. Refusing costs one trust prompt --
    // the bug we already have -- while guessing costs the human's global config.
    const projects = cfg.projects === undefined ? {} : cfg.projects;
    if (!plain(projects)) return null;
    const entry = projects[key] === undefined ? {} : projects[key];
    if (!plain(entry)) return null;
    if (entry.hasTrustDialogAccepted === true) return null;   // already trusted; do not touch the file
    return { ...cfg, projects: { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } } };
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

// The running build, normalized from raw git output. Pure so it can be tested; the hub supplies
// `rev` (git rev-parse HEAD) and `status` (git status --porcelain), either of which may be null
// when git is absent or the source tree is not a checkout at all.
//
// Why this exists: a merged commit and a deployed one are different facts, and every observable
// the hub had -- roster, epitaphs, session churn -- read the same either way. On 2026-07-27 four
// commits sat unloaded for three hours while sessions verified against them. `dirty` matters as
// much as the sha: a hub started from an uncommitted tree is running code that no sha describes,
// so an ancestry check against HEAD would quietly lie.
export function buildIdentity({ rev, status, bootedAt, pid } = {}) {
    const commit = /^[0-9a-f]{40}$/i.test(String(rev || '').trim()) ? String(rev).trim().toLowerCase() : null;
    return {
        commit,
        short: commit ? commit.slice(0, 7) : null,
        // Unknown status is NOT clean. A hub that could not read git cannot promise its tree matched.
        dirty: status == null ? null : String(status).trim().length > 0,
        bootedAt: bootedAt || null,
        pid: Number.isFinite(pid) ? pid : null,
    };
}

// —— Commit baton: one serialized merge lane per repo (docs/COMMIT-BATON-DESIGN.md, P2) ——————————
// P1 (worktrees, above) isolates the FILESYSTEM so parallel workers stop clobbering each other. It
// leaves the hard half open: once N workers each hold a `jarvis/<cs>` branch they all want to merge
// into the same base, which is concurrent `git merge` on one branch, half-merged states when two land
// seconds apart, and nobody knowing whose turn it is. The baton gates the MERGE LANE ONLY -- research,
// planning, editing and committing inside your own worktree stay unrestricted and parallel.
//
// The decisions live here, pure, because they are the part worth pinning: who gets the lane, who
// waits and in what order, and when a lane is taken back off a worker that died holding it. The hub
// owns the file I/O, the git call that names the base, and pushing the grant event.
//
// INVARIANT, and every function below preserves it: at most one holder per lane, and a uid appears
// AT MOST ONCE across holder+queue. Two entries for one uid is not cosmetic -- a release would grant
// the lane to a worker that is already the holder and leave a phantom behind it forever.

// How long a holder may be unseen before the lane is taken back. Deliberately longer than the
// 2-minute gone-quiet threshold: a worker running a full build/test gate does not poll for minutes at
// a stretch, and robbing it mid-merge is worse than a lane sitting idle a little longer.
export const BATON_STALE_MS = 300000;

// One participant, identity only. The timestamp is stamped by whoever builds the row rather than
// here, because the two roles record genuinely different facts: a holder carries `takenAt` (when the
// lane became yours) and a queued worker carries `since` (when you joined the line). Returns null for
// anything with no usable uid, so a junk row is dropped rather than half-shaped.
function batonParty(e) {
    if (!e || typeof e !== 'object') return null;
    const uid = String(e.uid == null ? '' : e.uid).trim();
    if (!uid) return null;
    return {
        uid,
        cs: e.cs ? String(e.cs) : null,
        branch: e.branch ? String(e.branch) : null,
        note: e.note == null ? '' : String(e.note),
    };
}
// The two role stamps. Passing a party through asHolder DROPS `since` and vice versa, so a row's
// shape always says which role it is in -- there is never a queue entry carrying a stale takenAt.
const asHolder = (p, ts) => ({ ...p, takenAt: ts });
const asQueued = (p, ts) => ({ ...p, since: ts });
// The ISO stamp for a lane change, from the injected `now` (epoch ms or an ISO string) and NOTHING
// else. Never falls back to a wall-clock read: these helpers stay a pure function of their arguments,
// so an unreadable `now` yields a null timestamp rather than a value the caller did not supply.
function batonTs(now) {
    const t = typeof now === 'string' ? Date.parse(now) : Number(now);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Coerce a stored lane into the current shape. Pure, invents no timestamps, and drops a uid that
// appears more than once (see the invariant above) -- a hand-edited or half-written file must not be
// able to seat one worker twice.
export function normalizeLane(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const h = batonParty(r.holder);
    const holder = h ? { ...h, takenAt: r.holder.takenAt ? String(r.holder.takenAt) : null } : null;
    const seen = new Set(holder ? [holder.uid] : []);
    const queue = [];
    for (const q of (Array.isArray(r.queue) ? r.queue : [])) {
        const p = batonParty(q);
        if (!p || seen.has(p.uid)) continue;
        seen.add(p.uid);
        queue.push({ ...p, since: q.since ? String(q.since) : null });
    }
    return {
        base: r.base ? String(r.base) : null,
        holder,
        queue,
        lastHandoff: r.lastHandoff ? String(r.lastHandoff) : null,
    };
}

// Ask for the lane. Free -> you hold it. Busy -> you are appended to the FIFO queue with your
// position. IDEMPOTENT in both directions: re-requesting while you already hold it, or while you are
// already queued, reports where you stand and adds nothing -- a worker that retries after a timeout
// must not end up in the queue twice, or behind itself.
//
// FIFO with no priority field is the whole point (fairness is what makes serialization tolerable);
// preemption stays a non-goal until a real case turns up.
export function batonRequest(lane, req, now) {
    const L = normalizeLane(lane);
    const p = batonParty(req);
    const held = L.holder ? (L.holder.cs || L.holder.uid) : null;
    if (!p) return { lane: L, granted: false, position: null, holder: held, already: false };
    if (L.holder && L.holder.uid === p.uid) return { lane: L, granted: true, position: 0, holder: held, already: true };
    const qi = L.queue.findIndex(e => e.uid === p.uid);
    if (qi >= 0) return { lane: L, granted: false, position: qi + 1, holder: held, already: true };
    const ts = batonTs(now);
    if (!L.holder) {
        return { lane: { ...L, holder: asHolder(p, ts), lastHandoff: ts }, granted: true, position: 0, holder: p.cs || p.uid, already: false };
    }
    return { lane: { ...L, queue: [...L.queue, asQueued(p, ts)] }, granted: false, position: L.queue.length + 1, holder: held, already: false };
}

// Hand the lane on. Pops the FIFO queue and grants to the next in line, whose `since` becomes a
// `takenAt`. A release by anyone who is NOT the holder is a no-op reporting `held:false` -- including
// by someone sitting in the queue, who wants batonCancel instead. Making it a no-op rather than an
// error matters on the retire path, which releases blind for every lane.
export function batonRelease(lane, uid, now) {
    const L = normalizeLane(lane);
    const id = String(uid == null ? '' : uid).trim();
    if (!id || !L.holder || L.holder.uid !== id) return { lane: L, held: false, grantedTo: null };
    const ts = batonTs(now);
    const [next, ...rest] = L.queue;
    const grantedTo = next ? asHolder(batonParty(next), ts) : null;
    return {
        // lastHandoff means "when the lane last changed HANDS", so releasing to an empty queue leaves
        // it alone: nobody took it, and claiming otherwise would misdate the last real handoff.
        lane: { ...L, holder: grantedTo, queue: next ? rest : [], lastHandoff: grantedTo ? ts : L.lastHandoff },
        held: true,
        grantedTo,
    };
}

// Drop out of the queue without ever holding (the task was dropped, or the worker changed its mind).
// Reports `holding` when the caller is in fact the holder: that is a release, not a cancel, and
// silently doing nothing there would leave the lane wedged by someone who believes they let it go.
export function batonCancel(lane, uid) {
    const L = normalizeLane(lane);
    const id = String(uid == null ? '' : uid).trim();
    const holding = !!(id && L.holder && L.holder.uid === id);
    const queue = id ? L.queue.filter(e => e.uid !== id) : L.queue;
    const dropped = L.queue.length - queue.length;
    return { lane: dropped ? { ...L, queue } : L, dropped: dropped > 0, holding };
}

// The human's override: break a lane they think is stuck. `to` is who gets it next, or null.
//
// With a target: that worker becomes the holder and is removed from the queue if it was waiting, so
// it cannot hold a place it now owns. The revoked holder is NOT put at the back of the queue -- the
// human took the lane off it deliberately, and quietly re-queueing it would hand it straight back.
//
// With no target: revoke and POP THE QUEUE, rather than leaving the lane free with workers still
// waiting on it. That combination is its own wedge: a queued worker is parked on its poll loop
// waiting to be woken, and re-requesting only reports the position it already has, so nothing would
// ever grant. "Free the lane" only means holder:null when the queue is genuinely empty.
export function batonForce(lane, to, now) {
    const L = normalizeLane(lane);
    const ts = batonTs(now);
    const revoked = L.holder;
    const p = batonParty(to);
    if (p) {
        return {
            lane: { ...L, holder: asHolder(p, ts), queue: L.queue.filter(e => e.uid !== p.uid), lastHandoff: ts },
            revoked, grantedTo: asHolder(p, ts),
        };
    }
    const [next, ...rest] = L.queue;
    const grantedTo = next ? asHolder(batonParty(next), ts) : null;
    return {
        lane: { ...L, holder: grantedTo, queue: next ? rest : [], lastHandoff: grantedTo ? ts : L.lastHandoff },
        revoked, grantedTo,
    };
}

// Take the lane back off a holder that is gone, and clear dead workers out of the queue, in one pass.
// A lane that depends on a worker staying healthy is a lane that wedges: this is the same failure
// mode that took primeng down on 2026-07-24, and a merge queue nobody can enter is worse than no
// queue at all.
//
// `seenAt(uid)` answers when the hub last saw that session -- epoch ms or an ISO string -- or null
// when it is retired or not in the roster at all. Two separate verdicts come out of that:
//   null      -> gone, revoke NOW. Nothing to wait for; the session does not exist any more.
//   too old   -> unseen for >= staleMs, revoke. Note this is NOT the hub's 2-minute aliveNow window:
//                the spec asks for "aliveNow false for > BATON_STALE_MS", which a boolean cannot
//                express without the lane remembering when it first read dead. Measuring the one
//                signal directly gives the same 5-minute guarantee with no extra persisted state and
//                no ratchet to re-arm after a restart.
// `staleMs` of Infinity therefore means "sweep only what is provably gone, ignore staleness" -- which
// is exactly what a boot revalidation needs, because right after a restart every survivor's lastSeen
// is frozen at whatever it was before the hub went down and would read as 5 minutes quiet.
// An unreadable `now` spares every live entry rather than reaping the lane on a bad clock.
export function batonReap(lane, seenAt, now, staleMs = BATON_STALE_MS) {
    const L = normalizeLane(lane);
    const t = Number(typeof now === 'string' ? Date.parse(now) : now);
    const gone = (e) => {
        if (!e) return false;
        let seen = null;
        try { seen = seenAt ? seenAt(e.uid) : null; } catch { seen = null; }
        if (seen == null) return true;
        const at = typeof seen === 'number' ? seen : Date.parse(seen);
        if (!Number.isFinite(at) || !Number.isFinite(t)) return false;
        return (t - at) >= staleMs;
    };
    const dropped = L.queue.filter(gone);
    const queue = L.queue.filter(e => !gone(e));
    if (!gone(L.holder)) {
        return { lane: dropped.length ? { ...L, queue } : L, revoked: null, dropped, grantedTo: null };
    }
    const ts = batonTs(now);
    const [next, ...rest] = queue;
    const grantedTo = next ? asHolder(batonParty(next), ts) : null;
    return {
        lane: { ...L, holder: grantedTo, queue: next ? rest : [], lastHandoff: grantedTo ? ts : L.lastHandoff },
        revoked: L.holder, dropped, grantedTo,
    };
}

// —— "Who holds the merge lane?" — the spoken half of the same question ————————————————————————————
// The console chips (batonRole/batonTip in console.js) answer this when Chris is LOOKING at the board.
// The question he actually asks is spoken, hands-off, usually while reading something else, and the
// answer has to arrive as one sentence he can hear. Same lesson as chat search: the plumbing existing
// is not the feature. The predicate and the sentence live here, pure, so they can be pinned by the
// gate; handleSpeech in jarvis-core.mjs owns the `if` and the enqueueSay, as it does for every intent.

// One participant's spoken name. Callsigns are NATO words, so they read aloud correctly as-is; a uid
// (s_0416) is the fallback and is deliberately NOT prettified -- if it ever surfaces, it means a lane
// entry lost its callsign, and hearing the raw uid is the signal.
const batonSpokenName = (e) => (e && (e.cs || e.uid)) || 'someone';
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Is this utterance ASKING about the merge lane?
//
// The gate is tight on purpose, and the reason is not politeness. handleSpeech runs its intent ladder
// BEFORE routing speech on to the focused worker, so a false positive does not merely answer the wrong
// question -- it SWALLOWS a sentence Chris meant for a session, and neither end is told. Three rules,
// each earning its keep:
//   1. an explicit lane/baton noun must appear at all;
//   2. a COMMAND verb disqualifies -- "hand the baton to kilo" and "who holds the baton" are different
//      intents and only the second belongs to this branch;
//   3. the interrogative must lead the utterance (after the optional "jarvis" address the rest of the
//      ladder also strips). That last rule is what stops "romeo, what's your status on the merge lane"
//      being eaten by the hub instead of reaching romeo -- the same anchoring every other intent gets
//      from handleSpeech's own `after()` prefix.
// The bare noun said on its own is allowed too ("jarvis, merge lane" / "merge lane status"), because
// that is how someone asks a machine they trust.
export function isBatonQuestion(text) {
    const s = String(text == null ? '' : text).toLowerCase()
        .replace(/[?!.,\s]+$/g, '').trim()
        .replace(/^(?:hey\s+)?jarvis[\s,.!]+/, '');
    if (!/\b(?:merge lane|merge queue|commit baton|baton)\b/.test(s)) return false;
    if (/\b(?:take|takes|taking|grab|grabs|claim|claims|request|requests|release|releases|releasing|drop|drops|hand|hands|give|gives|pass|force|cancel|steal|reclaim|revoke)\b/.test(s)) return false;
    // "what's YOUR status on the merge lane" is addressed to whoever is in focus, not to the hub -- and
    // with no callsign in front, leading-interrogative anchoring alone cannot tell the two apart. A
    // second-person possessive is the tell. Only `your`, deliberately not a bare `you`: "do you know who
    // has the baton" is a hub question, and a false negative here merely falls through to the focused
    // session, while a false positive eats the sentence outright.
    if (/\byours?\b/.test(s)) return false;
    if (/^(?:the\s+)?(?:merge lane|merge queue|commit baton|baton)(?:\s+(?:status|update|state))?$/.test(s)) return true;
    // Leading interrogatives, plus the polite openers ("can you tell me who holds...") -- Chris uses
    // those. "tell" is deliberately NOT in the set: "tell romeo the merge lane is his" leads with it and
    // is an instruction to a worker, and a command verb is not always there to veto it.
    return /^(?:who|whose|what|what's|whats|which|where|is|are|does|do|did|can|could|would|any|anyone|anybody|how many|status of)\b/.test(s);
}

// The spoken answer, from the batons store ({ repoKey: lane }) and an injected `now`. One sentence per
// lane that has anything to say; lanes nobody is in are skipped rather than announced as free, because
// reading out eight idle repos is how a headline becomes a list.
//
// Pure, and `now` is an argument for the same reason the rest of this section takes one: the duration is
// the most useful thing in the sentence ("holds it, for eleven minutes" is the shape of a stuck merge),
// and a helper that read the clock itself could not be tested for it.
export function speakBaton(lanes, now) {
    const store = lanes && typeof lanes === 'object' ? lanes : {};
    const parts = [];
    for (const key of Object.keys(store).sort()) {
        const L = normalizeLane(store[key]);
        if (!L.holder && !L.queue.length) continue;
        parts.push(batonSentence(key, L, now));
    }
    // The honest empty answer. Every lane free is the NORMAL state, and it is also the answer to the
    // question, so it gets said rather than swallowed.
    if (!parts.length) return 'Nobody holds a merge lane. Everyone is clear to merge.';
    return parts.join(' ');
}

// Whole minutes between an ISO stamp and `now`, or null if either is unreadable or the stamp is in the
// future. Null means "say nothing about the duration" -- a wrong number spoken with confidence is worse
// than an unqualified sentence.
function batonMinutes(iso, now) {
    const a = Date.parse(String(iso == null ? '' : iso));
    const b = typeof now === 'string' ? Date.parse(now) : Number(now);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
    return Math.floor((b - a) / 60000);
}

function batonSentence(repo, L, now) {
    const q = L.queue.map(batonSpokenName);
    if (!L.holder) {
        // A queue with no holder is a lane mid-reap, not a deadlock. Saying which it is stops Chris
        // going to break something that is about to fix itself.
        return 'The ' + repo + ' merge lane is free with ' + (q.length === 1 ? 'one worker' : q.length + ' workers')
            + ' queued. It should grant on the next sweep.';
    }
    const m = batonMinutes(L.holder.takenAt, now);
    const held = m === null ? '' : m < 1 ? ', just now' : m === 1 ? ', for a minute' : ', for ' + m + ' minutes';
    const tail = !q.length ? 'Nobody is waiting.'
        : q.length === 1 ? capFirst(q[0]) + ' is waiting behind it.'
            : q.length + ' are waiting: ' + q.join(', ') + '.';
    return capFirst(batonSpokenName(L.holder)) + ' holds the ' + repo + ' merge lane' + held + '. ' + tail;
}

// --- spawns that die before they register ------------------------------------------------------
//
// A spawn is INVISIBLE until it registers. POST /spawn answers with a callsign the instant the pty
// launches, and everything after that -- the host starting claude, claude booting, reading
// /protocol, POSTing /register -- happens out of the hub's sight. A worker that dies inside that
// window leaves nothing at all: no roster row (not ended, not booting -- absent), a pinned callsign
// burned for five minutes, and no error on any channel. It is indistinguishable from a launch that
// never happened, which is why on 2026-07-29 three TMS dispatches died on Claude Code's folder-trust
// prompt and cost a whole session to diagnose. That specific cause is fixed; the INVISIBILITY is the
// general defect, and it is this.
//
// THE TIMEOUT IS MEASURED, NOT GUESSED. 91 real spawn->register pairs in the hub transcript over a
// 7.5-day window, across three repos including the big TMS checkout and worktree-isolated workers:
//     min 7.3s   p50 13.5s   p90 19.3s   p95 22.0s   max 24.0s
// The default below is ~4x that worst case, because the two errors are not symmetric. A late alarm
// costs a few more seconds of not-knowing. A false alarm on a HEALTHY worker frees a pin and a
// binding that are about to be used -- it turns a slow spawn into a broken one, which is worse than
// the bug being fixed. It stays under the 2-minute gone-quiet threshold, so a spawn that never boots
// is noticed at least as fast as one that boots and then goes silent.
export const SPAWN_REGISTER_TIMEOUT_MS = 90000;

// Which pending spawns are overdue: launched more than `timeoutMs` ago with no session to show for
// it. `pending` is the hub's spawned-but-not-registered stash ({cs, cwd, at} entries, `at` in ms),
// `sessions` is roster.sessions.
//
// THE ONLY THING THAT COUNTS AS HAVING REGISTERED is a session under this callsign that started
// at or after the spawn. Not "a session appeared in that directory" -- the first cut of this tried
// exactly that, to catch a worker that DROPPED its pin and came up under another name, and the
// integration test caught it masking a genuine death within seconds: two spawns into one cwd, and
// the healthy one explains away the dead one. That is the original bug wearing a reassuring
// message, which is worse than the silence it replaced. The evidence says drop it: of 96 real
// spawns in the transcript, 91 registered under their own pin and the 5 that did not were all
// genuine deaths. Zero pin-drops observed; same-cwd spawns are routine.
//
// `at or after` is strict. A recycled callsign means an OLDER session can carry the same name, and
// letting it match would mask every later death of that callsign forever.
export function overdueSpawns(pending, sessions, now, timeoutMs = SPAWN_REGISTER_TIMEOUT_MS) {
    const t = Number(now);
    if (!Number.isFinite(t)) return [];
    const rows = Object.values(sessions || {}).filter(s => s && s.callsign);
    const out = [];
    for (const e of (pending || [])) {
        if (!e || !e.cs || !Number.isFinite(Number(e.at))) continue;
        if (t - Number(e.at) < timeoutMs) continue;
        if (rows.some(s => s.callsign === e.cs && Date.parse(s.started) >= Number(e.at))) continue;
        out.push({ ...e });
    }
    return out;
}

// What a dead spawn's log says, reduced to one line worth reading. Every signature here is one that
// has actually happened -- the folder-trust prompt (2026-07-29, three workers), cmd.exe eating an
// angle bracket in the boot prompt as a redirection (charlie, same night), a host that could not
// load node-pty. Returns null when the log says nothing recognizable, and the caller still names the
// file: pointing at real evidence beats inventing a reason for it.
//
// Order matters. A worker stopped on a prompt and then killed shows BOTH the prompt and an exit
// code, and the prompt is the cause while the exit is only the symptom.
export function diagnoseSpawnLog(text) {
    const raw = String(text == null ? '' : text);
    if (!raw.trim()) return 'the log is empty -- claude produced no output at all';
    // A claude log is a TUI recording: escape sequences, box borders, spinners, and hard wrapping at
    // the pty width. Strip it back to printable ASCII on one line, because otherwise a phrase that is
    // plainly on screen is unfindable -- the words are there but a border or a newline sits inside it.
    const flat = raw
        .replace(/\x1b\][^\x07\x1b]*\x07?/g, ' ')
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ' ')
        .replace(/[^\x20-\x7e]+/g, ' ')
        .replace(/\s+/g, ' ');
    // FOLDER TRUST, and its wording is NOT a constant. `trust the files` is the pre-2026-07
    // phrasing and it had already aged into a no-op: measured against a real capture of the prompt
    // Claude Code shows today it matches ZERO times, so a textbook trust death reported `No reason
    // in the log` -- the one failure this whole feature exists to name, back to being silent. Three
    // independent phrasings now, because the sentence is product copy and the next release can
    // reword it again:
    //   `trust the files`               pre-2026-07 wording, kept so an older Claude Code still reads
    //   `is this a project you created` the current question
    //   `trust this folder`             the current option label (`1. Yes, I trust this folder`)
    if (/trust the files|is this a project you created|trust this folder/i.test(flat)) return 'it stopped on Claude Code folder-trust prompt -- nobody can press Enter on a console-less worker';
    if (/cannot find the file specified/i.test(flat)) return 'cmd.exe could not run the boot prompt -- a stray angle bracket in it is a redirection';
    if (/node-pty unavailable/i.test(flat)) return 'the worker host could not load node-pty';
    if (/invalid api key|please run \/login|\bnot logged in\b/i.test(flat)) return 'claude is not authenticated';
    // ANY interactive prompt, recognised by SHAPE instead of by its sentence -- the guard against
    // the failure above happening again. A phrase-keyed signature is one release away from going
    // quiet, and when it goes quiet this function returns null and the note claims there is no
    // reason in a log that plainly holds one. The keypress chrome is the part a console-less worker
    // can never satisfy, which is also precisely the diagnosis, so it degrades honestly: a re-worded
    // trust dialog, or a prompt nobody has seen yet, still comes back as an answer rather than
    // silence. Ordered AFTER the named signatures so the specific cause always wins, and BEFORE the
    // exit code for the reason the exit-code test already pins -- a worker stopped on a prompt and
    // then killed shows both, and the prompt is the cause while the exit is only the symptom.
    if (/enter to confirm|esc to cancel/i.test(flat)) return 'it stopped on an interactive prompt -- nobody can press a key on a console-less worker';
    const ex = [...flat.matchAll(/worker exited \((-?\d+)\)/gi)].pop();
    if (ex) return 'claude exited (code ' + ex[1] + ') before it registered';
    return null;
}

// The sys line the human reads. One ASCII line, because it renders as a divider in the console chat
// and lands in the searchable transcript -- it has to say what died, where, why, and what to open.
export function deadSpawnNote(entry, reason, now) {
    const e = entry || {};
    const secs = Number.isFinite(Number(now)) && Number.isFinite(Number(e.at))
        ? Math.round((Number(now) - Number(e.at)) / 1000) : null;
    const age = secs === null ? '' : ' (' + secs + 's after launch)';
    return e.cs + ' never registered' + age + ': spawned in ' + (e.cwd || 'an unknown directory')
        + (e.repoKey ? ' (' + e.repoKey + ')' : '') + '. '
        // `No known signature`, not `No reason`. The log almost always HOLDS the reason -- the one
        // time this mattered it held a full folder-trust prompt -- and claiming there was no reason
        // sent the reader away from the only evidence there is. Say what is actually true: nothing in
        // there matched a signature we know, and the file is named immediately after this.
        + (reason ? reason[0].toUpperCase() + reason.slice(1) : 'No known signature in the log') + '.'
        + (e.log ? ' Evidence: ' + e.log + '.' : '') + ' Callsign freed.';
}
