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
