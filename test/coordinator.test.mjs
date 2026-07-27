// Unit tests for coordinatorSlotHolder in jarvis-text.mjs -- "does this project already have a
// coordinator, live or booting?", the one predicate every coordinator-spawn site consults.
//
// The bug, 2026-07-27 post-restart (found by whiskey, evidence assembled by echo): primeng ended up
// with TWO live coordinators 43 seconds apart, both bound project:primeng, both handed the same
// handoff, both answering for one board.
//
//   15:04:43  victor  s_0347  purpose = the project TITLE 'PrimeNG 17 -> 18'
//                             -> reviveMissionCoordinator (it passes proj.title), fired because the
//                                previous coordinator juliet was a post-restart ghost
//   15:05:26  whiskey s_0349  purpose = juliet's own purpose line, carrying juliet's handoff
//                             -> the retire auto-successor path, fired when the ghost was retired
//
// Neither site could see the other: revive guarded on `missionCoordinatorSpawns`, a map of the spawns
// IT had made, and the successor path guarded on nothing whatsoever. Both orderings are pinned below,
// because the race runs in both directions and fixing only the observed one leaves the bug in place.
// Run with `npm test` (node --test) -- no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorSlotHolder, pickProjectWorker } from '../jarvis-text.mjs';

// The moment whiskey was spawned. Every fixture below is dated against the real incident so the
// staleness arithmetic is the arithmetic that actually happened.
const NOW = Date.parse('2026-07-27T15:05:26.000Z');
const at = iso => Date.parse('2026-07-27T' + iso + '.000Z');

// juliet: primeng's coordinator before the restart. Never retired (it died with the hub), so it sits
// in the roster unended forever with a lastSeen frozen 5 minutes back -- a ghost.
const GHOST_JULIET = { s_0345: { callsign: 'juliet', project: 'primeng', ended: null, lastSeen: '2026-07-27T15:00:12.000Z' } };
// victor: the auto-revived coordinator, registered 43s before NOW and heartbeating.
const LIVE_VICTOR = { s_0347: { callsign: 'victor', project: 'primeng', ended: null, lastSeen: '2026-07-27T15:04:50.000Z' } };
const held = (sessions, booting, name = 'primeng', now = NOW) => coordinatorSlotHolder(sessions, booting, name, now);

test('THE BUG, order as it happened: retiring the ghost must see victor and NOT spawn whiskey', () => {
    // This is the assertion that stops the observed double. At 15:05:26 retireSession(juliet) asks who
    // holds primeng; pre-fix it asked nobody and spawned whiskey regardless.
    const h = held({ ...GHOST_JULIET, ...LIVE_VICTOR }, new Map());
    assert.deepEqual(h, { kind: 'live', uid: 's_0347', callsign: 'victor' });
});

test('THE BUG, reverse order: a successor already BOOTING must stop the mission revive', () => {
    // Same race the other way round -- the retire successor is spawned first and a mission message
    // lands while it is still coming up. pendingBind knows about it before it registers, which is the
    // whole reason the predicate reads pendingBind and not a per-site map.
    const booting = new Map([['whiskey', { project: 'primeng', parentProject: null, ts: NOW - 3000 }]]);
    assert.deepEqual(held(GHOST_JULIET, booting), { kind: 'booting', callsign: 'whiskey' });
});

test('a project with only a stale ghost and nothing booting is genuinely unheld', () => {
    // The fix must not deadlock the slot: T2 auto-revive still has to fire, or talking to a mission
    // whose coordinator died reaches nobody at all.
    assert.equal(held(GHOST_JULIET, new Map()), null);
    assert.equal(held({}, new Map()), null);
});

test('a RETIRED coordinator never holds the slot, however fresh its lastSeen', () => {
    // Deliberate: cleanup (/forget, the idle sweep) still has to be able to target the corpse, and a
    // properly-retired coordinator SHOULD be replaced. Only `ended: null` counts as a holder.
    const retired = { s_0347: { ...LIVE_VICTOR.s_0347, ended: '2026-07-27T15:05:00.000Z' } };
    assert.equal(held(retired, new Map()), null);
    assert.equal(pickProjectWorker(retired, 'primeng'), null);   // and the live half agrees with routing
});

test('a parentProject SUB-WORKER is not a coordinator -- live or booting', () => {
    // A sub-worker nests UNDER the project; it does not run it. If it counted, one sub-worker would
    // block the project from ever reviving a brain.
    const sub = { s_0346: { callsign: 'xray', parentProject: 'primeng', ended: null, lastSeen: '2026-07-27T15:05:20.000Z' } };
    assert.equal(held(sub, new Map()), null);
    assert.equal(held(sub, new Map([['xray', { project: null, parentProject: 'primeng', ts: NOW - 1000 }]])), null);
});

test('a booting entry older than the window is ignored -- a dead spawn cannot wedge the slot shut', () => {
    // A ConPTY that never registers would otherwise hold the slot forever and the project could never
    // get a coordinator again. 120s matches aliveNow, so booting hands over to live with no gap.
    assert.equal(held(GHOST_JULIET, new Map([['whiskey', { project: 'primeng', ts: NOW - 200000 }]])), null);
    // ...and one inside the window still holds it.
    assert.deepEqual(held(GHOST_JULIET, new Map([['whiskey', { project: 'primeng', ts: NOW - 119000 }]])), { kind: 'booting', callsign: 'whiskey' });
});

test('an undateable booting entry is treated as FRESH, on purpose', () => {
    // Asymmetric by design: a coordinator delayed by one window is a smaller failure than two
    // coordinators, so an entry we cannot date blocks rather than waves through.
    for (const ts of [undefined, null, 'not-a-date', {}]) {
        assert.deepEqual(held(GHOST_JULIET, new Map([['whiskey', { project: 'primeng', ts }]])), { kind: 'booting', callsign: 'whiskey' });
    }
    // ISO strings work too -- alpha's boot restore may hand back a real spawn time rather than epoch ms.
    assert.deepEqual(held(GHOST_JULIET, new Map([['whiskey', { project: 'primeng', ts: '2026-07-27T15:05:20.000Z' }]])), { kind: 'booting', callsign: 'whiskey' });
    assert.equal(held(GHOST_JULIET, new Map([['whiskey', { project: 'primeng', ts: '2026-07-27T14:50:00.000Z' }]])), null);
});

test('another project\'s coordinator does not hold THIS project\'s slot', () => {
    // The reason a bare Set of booting callsigns could not answer this question: a NATO callsign
    // carries no project, so the intended binding has to travel with it.
    const sessions = { ...LIVE_VICTOR, s_0344: { callsign: 'delta', project: 'jarvis', ended: null, lastSeen: '2026-07-27T15:05:25.000Z' } };
    assert.equal(held(sessions, new Map(), 'mycarrierpackets'), null);
    assert.equal(held(sessions, new Map([['whiskey', { project: 'jarvis', ts: NOW }]]), 'mycarrierpackets'), null);
    assert.deepEqual(held(sessions, new Map(), 'jarvis'), { kind: 'live', uid: 's_0344', callsign: 'delta' });
});

test('the live window is exclusive at the boundary, matching aliveNow', () => {
    const s = { s_1: { callsign: 'victor', project: 'primeng', ended: null, lastSeen: new Date(NOW - 120000).toISOString() } };
    assert.equal(held(s, new Map()), null);                                  // exactly stale
    const s2 = { s_1: { ...s.s_1, lastSeen: new Date(NOW - 119999).toISOString() } };
    assert.equal(held(s2, new Map()).kind, 'live');                          // one ms inside
});

test('project names normalize like every other project path', () => {
    // Session .project is lowercased by resolveBinding and store names by normalizeProject; a caller
    // passing a spoken/typed name must still match.
    assert.equal(held(LIVE_VICTOR, new Map(), ' PrimeNG ').kind, 'live');
    assert.equal(held(GHOST_JULIET, new Map([['whiskey', { project: ' PRIMENG ', ts: NOW }]]), 'primeng').kind, 'booting');
});

test('the result names the holder, so the caller can say WHO has it', () => {
    // The two sys lines differ ('already coordinating it' vs 'booting as its coordinator'), and only a
    // live holder has a uid to bus the orphaned handoff pointer to.
    const live = held({ ...GHOST_JULIET, ...LIVE_VICTOR }, new Map());
    assert.equal(live.kind, 'live');
    assert.equal(live.callsign, 'victor');
    assert.equal(live.uid, 's_0347');
    const boot = held(GHOST_JULIET, new Map([['whiskey', { project: 'primeng', ts: NOW }]]));
    assert.equal(boot.kind, 'booting');
    assert.equal(boot.callsign, 'whiskey');
    assert.equal(boot.uid, undefined);          // nothing to send to yet -- it has not registered
});

test('the live half IS pickProjectWorker plus a window -- spawning and routing cannot disagree', () => {
    // If these two ever diverged, a project could be revived while routeToMission still bused the
    // human's words to the old session (or the reverse). Same source of truth, by construction.
    const sessions = { ...GHOST_JULIET, ...LIVE_VICTOR };
    assert.equal(held(sessions, new Map()).uid, pickProjectWorker(sessions, 'primeng'));
    // Freshest-seen wins, not roster order: two unended sessions, the ghost listed first.
    assert.equal(pickProjectWorker(sessions, 'primeng'), 's_0347');
});

test('garbage in never throws, and never invents a holder', () => {
    // This runs on the retire path; a throw here would strand a session mid-retire.
    for (const bad of [null, undefined, '', 0, false, '   ']) assert.equal(coordinatorSlotHolder(LIVE_VICTOR, new Map(), bad, NOW), null);
    assert.equal(held(null, null), null);
    assert.equal(held(undefined, undefined), null);
    assert.equal(held('not-a-map', 'not-a-map'), null);
    assert.equal(held({ s_1: null }, new Map()), null);
    // A non-iterable stash (someone hands us a plain object instead of a Map) degrades to "nobody".
    assert.equal(held(GHOST_JULIET, { whiskey: { project: 'primeng', ts: NOW } }), null);
    // Malformed entries are skipped, not fatal -- and a later good entry still resolves.
    assert.deepEqual(held(GHOST_JULIET, [null, 'nope', [], ['x', null], ['y', 'str'], ['whiskey', { project: 'primeng', ts: NOW }]]), { kind: 'booting', callsign: 'whiskey' });
    assert.equal(held(GHOST_JULIET, [['whiskey', { project: '   ', ts: NOW }]]), null);
});

test('an array of entries works as well as a Map -- the param is just an iterable', () => {
    // Keeps the contract with alpha's restart-resilience work open: whatever it repopulates booting
    // state from, it comes through this one door in this one shape.
    assert.deepEqual(held(GHOST_JULIET, [['whiskey', { project: 'primeng', ts: NOW - 1000 }]]), { kind: 'booting', callsign: 'whiskey' });
});

test('pure: mutates neither the roster nor the booting stash it reads', () => {
    const sessions = { ...GHOST_JULIET, ...LIVE_VICTOR };
    const booting = new Map([['whiskey', { project: 'primeng', ts: NOW }]]);
    const before = JSON.stringify({ sessions, booting: [...booting] });
    held(sessions, booting); held(sessions, booting, 'jarvis'); held(sessions, booting, 'nobody');
    assert.equal(JSON.stringify({ sessions, booting: [...booting] }), before);
    assert.equal(booting.size, 1);               // in particular it does not CONSUME the stash
});
