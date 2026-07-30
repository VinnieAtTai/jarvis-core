// Unit tests for wedgeState in jarvis-text.mjs -- the detector for a session whose heartbeat timer
// is alive but whose poll loop is DEAD, so it looks green on the board while being deaf to the
// human. This is the real 2026-07-24 PrimeNG outage: coordinator lima sat green for ~12 minutes
// while Chris talked into a void. Run with `npm test` (node --test) -- no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wedgeState, wedgeGraceMs, coordGraceMs, wedgeEscalateDue, WEDGE_GRACE_WORKER, WEDGE_ESCALATE_MS } from '../jarvis-text.mjs';

const NOW = 10_000_000;
const iso = ms => new Date(ms).toISOString();
const ago = ms => iso(NOW - ms);
const MIN = 60_000;

// A healthy worker: heartbeat 10s ago, polled 5s ago.
const healthy = { started: ago(60 * MIN), lastBeat: ago(10_000), lastPoll: ago(5_000), ended: null };
// The lima shape: heartbeat ticking, poll loop dead 12 minutes.
const wedged = { started: ago(60 * MIN), lastBeat: ago(10_000), lastPoll: ago(12 * MIN), ended: null };

test('wedgeState -- a healthy worker (both signals fresh) reports nothing', () => {
    assert.equal(wedgeState(healthy, NOW), null);
});

test('wedgeState -- fresh heartbeat + long-dead poll loop is flagged, with minutes deaf', () => {
    const w = wedgeState(wedged, NOW);
    assert.ok(w, 'expected the lima shape to be flagged');
    assert.equal(w.minutes, 12);
    assert.equal(w.pending, 0);
});

test('wedgeState -- reports how many events the deaf session has not picked up', () => {
    assert.equal(wedgeState(wedged, NOW, { pending: 3 }).pending, 3);
});

test('wedgeState -- silent inside the grace window, fires once past it', () => {
    const at = ms => wedgeState({ ...wedged, lastPoll: ago(ms) }, NOW);
    assert.equal(at(4 * MIN), null, '4min is still within the 5min grace');
    assert.equal(at(5 * MIN - 1), null, 'just under grace stays silent');
    assert.ok(at(5 * MIN), 'at grace it fires');
});

test('wedgeState -- grace is tunable', () => {
    assert.ok(wedgeState({ ...wedged, lastPoll: ago(2 * MIN) }, NOW, { graceMs: MIN }));
    assert.equal(wedgeState(wedged, NOW, { graceMs: 60 * MIN }), null);
});

// —— the cases it must stay quiet for ——

test('wedgeState -- a STALE heartbeat is not a wedge (that is the ordinary gone-quiet path)', () => {
    // Both signals dead = the session is simply gone. The board already says so, louder.
    assert.equal(wedgeState({ ...wedged, lastBeat: ago(10 * MIN) }, NOW), null);
});

test('wedgeState -- a session that never sent a heartbeat is not a wedge', () => {
    assert.equal(wedgeState({ started: ago(60 * MIN), lastPoll: ago(12 * MIN) }, NOW), null);
    assert.equal(wedgeState({ ...wedged, lastBeat: null }, NOW), null);
    assert.equal(wedgeState({ ...wedged, lastBeat: 'not a date' }, NOW), null);
});

test('wedgeState -- a retired session is never flagged', () => {
    assert.equal(wedgeState({ ...wedged, ended: iso(NOW - MIN) }, NOW), null);
});

test('wedgeState -- garbage input yields null, never a throw', () => {
    assert.equal(wedgeState(null, NOW), null);
    assert.equal(wedgeState(undefined, NOW), null);
    assert.equal(wedgeState({}, NOW), null);
});

// —— never polled: measured from registration, not exempt ——

test('wedgeState -- a worker that registered and NEVER launched its poll loop is wedged from birth', () => {
    // Heartbeat came up, the event loop never did -- a real boot failure that used to look green.
    const bornDeaf = { started: ago(8 * MIN), lastBeat: ago(10_000), ended: null };
    const w = wedgeState(bornDeaf, NOW);
    assert.ok(w, 'a never-polled session past grace should be flagged');
    assert.equal(w.minutes, 8);
});

test('wedgeState -- a freshly registered worker gets its grace window before being judged', () => {
    assert.equal(wedgeState({ started: ago(30_000), lastBeat: ago(5_000), ended: null }, NOW), null);
});

test('wedgeState -- minutes floors rather than rounds, so it never overstates the outage', () => {
    assert.equal(wedgeState({ ...wedged, lastPoll: ago(7 * MIN + 59_000) }, NOW).minutes, 7);
});

// -- seconds, added beside minutes rather than replacing it --

test('wedgeState -- reports seconds as well as minutes, because sub-minute outages exist now', () => {
    const w = wedgeState({ ...wedged, lastPoll: ago(7 * MIN + 59_000) }, NOW);
    assert.equal(w.minutes, 7, 'minutes must keep flooring exactly as it always did');
    assert.equal(w.seconds, 479, 'seconds is the TOTAL, not the remainder');
});

test('wedgeState -- a sub-minute outage still reports honestly instead of "0 minutes"', () => {
    // The bug a seconds-scale threshold would otherwise ship: floor(45s) is 0, so the chip read
    // "DEAF 0m" and the spoken line became "has not checked its inbox in 0 minutes".
    const w = wedgeState({ ...wedged, lastPoll: ago(45_000) }, NOW, { graceMs: 20_000 });
    assert.equal(w.minutes, 0);
    assert.equal(w.seconds, 45);
});

test('wedgeState -- the poll-age path names itself as the reason', () => {
    assert.equal(wedgeState(wedged, NOW).reason, 'deaf');
});

// -- the permission fast path: a certainty, so no grace window at all --

test('wedgeState -- a pending permission prompt with traffic queued is flagged with NO grace', () => {
    // The session polled 5 seconds ago: nowhere near any grace window, and by poll age alone it is
    // perfectly healthy. It is still unable to act on the queued messages until the human answers,
    // which is the difference between inferring a wedge and knowing one.
    const w = wedgeState(healthy, NOW, { pending: 2, pendingPerms: 1 });
    assert.ok(w, 'a permission block with queued traffic must be flagged immediately');
    assert.equal(w.reason, 'perm');
    assert.equal(w.pending, 2);
    assert.equal(w.pendingPerms, 1);
    assert.equal(w.seconds, 5, 'it still reports how long since the last poll');
});

test('wedgeState -- a permission prompt with NOTHING queued is ordinary operation, not a wedge', () => {
    // Chris approving a write while nobody waits on the session is the normal case. Flagging it
    // would be the false alarm this detector exists to avoid.
    assert.equal(wedgeState(healthy, NOW, { pending: 0, pendingPerms: 1 }), null);
});

test('wedgeState -- queued traffic with no permission prompt still waits out the grace window', () => {
    assert.equal(wedgeState(healthy, NOW, { pending: 2, pendingPerms: 0 }), null);
});

test('wedgeState -- the permission path does not outrank the guards that keep it quiet', () => {
    const opts = { pending: 2, pendingPerms: 1 };
    assert.equal(wedgeState({ ...healthy, ended: iso(NOW - MIN) }, NOW, opts), null, 'retired');
    assert.equal(wedgeState({ ...healthy, lastBeat: ago(10 * MIN) }, NOW, opts), null, 'gone quiet');
    assert.equal(wedgeState(null, NOW, opts), null, 'garbage');
});

test('wedgeState -- pendingPerms is reported on the poll-age path too, so a surface can say why', () => {
    assert.equal(wedgeState(wedged, NOW, { pending: 1 }).pendingPerms, 0);
});

// -- role-aware grace --

test('wedgeGraceMs -- a sub-worker keeps the 5 minute window', () => {
    assert.equal(wedgeGraceMs({ coordinator: false, pending: 4 }), WEDGE_GRACE_WORKER);
    assert.equal(WEDGE_GRACE_WORKER, 300000);
});

test('wedgeGraceMs -- a coordinator with traffic queued gets the tight window', () => {
    assert.equal(wedgeGraceMs({ coordinator: true, pending: 1 }), 90000, '3.6 holds at the 25s default');
});

test('wedgeGraceMs -- a coordinator with NOTHING queued keeps the generous window', () => {
    // Deaf with nobody waiting is a curiosity on any role. The tight window on an idle coordinator
    // would fire every time it spent 90 seconds thinking.
    assert.equal(wedgeGraceMs({ coordinator: true, pending: 0 }), WEDGE_GRACE_WORKER);
});

test('coordGraceMs -- DERIVED from the poll hold, so tuning the hold cannot silently break it', () => {
    // The multiple is the load-bearing part, not the 90 seconds. A hard-coded 90000 would stop
    // being 3.6x the hold the day someone changed the hold, and start firing on ordinary turns.
    assert.equal(coordGraceMs(25000), 90000);
    assert.equal(coordGraceMs(10000), 36000);
    assert.equal(coordGraceMs(50000), 180000);
    assert.equal(wedgeGraceMs({ coordinator: true, pending: 1, pollHoldMs: 10000 }), 36000);
});

test('coordGraceMs -- an absent or junk hold falls back to the documented 25s default', () => {
    for (const junk of [undefined, null, 0, -1, 'nope', NaN]) assert.equal(coordGraceMs(junk), 90000);
});

test('the two pieces together -- a 100s-deaf coordinator is caught where a sub-worker is not', () => {
    const s = { ...wedged, lastPoll: ago(100_000) };
    const asCoord = wedgeGraceMs({ coordinator: true, pending: 3 });
    const asWorker = wedgeGraceMs({ coordinator: false, pending: 3 });
    assert.ok(wedgeState(s, NOW, { graceMs: asCoord, pending: 3 }), 'the coordinator is flagged');
    assert.equal(wedgeState(s, NOW, { graceMs: asWorker, pending: 3 }), null, 'the sub-worker is not');
});

// -- escalation: widening, so a real outage gets louder and a brief one costs one line --

test('wedgeEscalateDue -- a condition never announced fires immediately', () => {
    assert.equal(wedgeEscalateDue(null, NOW), true);
    assert.equal(wedgeEscalateDue(undefined, NOW), true);
    assert.equal(wedgeEscalateDue({ count: 0, lastAt: NOW }, NOW), true);
});

test('wedgeEscalateDue -- the interval WIDENS with each announcement rather than nagging flat', () => {
    const due = (count, sinceMs) => wedgeEscalateDue({ count, lastAt: NOW - sinceMs }, NOW);
    assert.equal(due(1, 59_000), false, '1 minute after the first line');
    assert.equal(due(1, 60_000), true);
    assert.equal(due(2, 179_000), false, 'then 3 minutes');
    assert.equal(due(2, 180_000), true);
    assert.equal(due(3, 419_000), false, 'then 7');
    assert.equal(due(3, 420_000), true);
});

test('wedgeEscalateDue -- past the end of the table it clamps instead of going silent forever', () => {
    // A long outage must keep getting mentioned; running off the end of the array would make the
    // step undefined and every comparison false, which is silence dressed up as a schedule.
    assert.equal(wedgeEscalateDue({ count: 99, lastAt: NOW - 899_000 }, NOW), false);
    assert.equal(wedgeEscalateDue({ count: 99, lastAt: NOW - 900_000 }, NOW), true);
    assert.equal(WEDGE_ESCALATE_MS[WEDGE_ESCALATE_MS.length - 1], 900000);
});
