// Unit tests for wedgeState in jarvis-text.mjs -- the detector for a session whose heartbeat timer
// is alive but whose poll loop is DEAD, so it looks green on the board while being deaf to the
// human. This is the real 2026-07-24 PrimeNG outage: coordinator lima sat green for ~12 minutes
// while Chris talked into a void. Run with `npm test` (node --test) -- no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wedgeState } from '../jarvis-text.mjs';

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
