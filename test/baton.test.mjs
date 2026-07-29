// The commit baton's decisions (docs/COMMIT-BATON-DESIGN.md §6). Pure helpers, so every rule below
// is pinned without a hub, a repo or a git call -- the same split focus.test.mjs uses for
// focusHeldByLiveOther.
//
// What is worth testing here is not "does a free lane grant" but the four ways a merge lane WEDGES,
// because a wedged lane is worse than no lane at all -- it stops every worker from merging while
// looking exactly like a lane that is busy:
//   - a worker seated twice, so a release hands the lane to whoever already has it
//   - a queue that is not FIFO, so someone waits forever behind later arrivals
//   - a holder that died holding it
//   - a force-free that empties the holder and strands a queue nobody will ever pop
//
// Every assertion in this file was mutation-probed: the helper was broken on purpose to watch the
// assertion fail. A test that has never failed has not been shown to check anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BATON_STALE_MS, normalizeLane, batonRequest, batonRelease, batonCancel, batonForce, batonReap,
} from '../jarvis-text.mjs';

const T0 = Date.parse('2026-07-28T12:00:00.000Z');
const at = (min) => T0 + min * 60000;
const iso = (min) => new Date(at(min)).toISOString();
// A lane with `holder` holding and `queue` waiting, built through the real request path so the
// fixtures cannot drift from the shape the endpoint actually produces.
function laneWith(holder, ...queued) {
    let lane = null, min = 0;
    for (const p of [holder, ...queued]) lane = batonRequest(lane, p, at(min++)).lane;
    return lane;
}
const csOf = (l) => (l.holder ? l.holder.cs : null);
const waiting = (l) => l.queue.map(e => e.cs);

const HOTEL = { uid: 's_1', cs: 'hotel', branch: 'jarvis/hotel', note: 'TMS-19966 fix' };
const KILO = { uid: 's_2', cs: 'kilo', branch: 'jarvis/kilo', note: 'attach-docs layout' };
const MIKE = { uid: 's_3', cs: 'mike', branch: 'jarvis/mike', note: 'mileage bug' };

test('batonRequest -- a free lane grants, a busy one queues in arrival order', () => {
    const first = batonRequest(null, HOTEL, at(0));
    assert.equal(first.granted, true);
    assert.equal(first.position, 0);
    assert.equal(csOf(first.lane), 'hotel');
    assert.equal(first.lane.holder.takenAt, iso(0), 'the grant was not stamped from the injected now');
    assert.equal(first.lane.lastHandoff, iso(0));

    const second = batonRequest(first.lane, KILO, at(2));
    assert.equal(second.granted, false, 'a busy lane granted a second holder');
    assert.equal(second.position, 1);
    assert.equal(second.holder, 'hotel', 'a queued worker was not told who holds the lane');
    assert.equal(csOf(second.lane), 'hotel', 'the incumbent lost the lane to a later request');
    assert.deepEqual(waiting(second.lane), ['kilo']);
    assert.equal(second.lane.queue[0].since, iso(2));
    assert.equal(second.lane.queue[0].takenAt, undefined, 'a queued entry carries a holder stamp');

    const third = batonRequest(second.lane, MIKE, at(3));
    assert.equal(third.position, 2, 'the third request did not land BEHIND the second');
    assert.deepEqual(waiting(third.lane), ['kilo', 'mike'], 'the queue is not FIFO');
});

test('batonRequest -- IDEMPOTENT: a retry never seats a worker twice, or behind itself', () => {
    const lane = laneWith(HOTEL, KILO);

    const reHold = batonRequest(lane, HOTEL, at(9));
    assert.equal(reHold.granted, true, 'the holder was refused its own lane');
    assert.equal(reHold.already, true);
    assert.equal(reHold.lane.holder.takenAt, lane.holder.takenAt, 're-requesting reset the hold time');
    assert.deepEqual(waiting(reHold.lane), ['kilo'], 'the holder was ALSO queued behind itself');

    const reQueue = batonRequest(lane, KILO, at(9));
    assert.equal(reQueue.granted, false);
    assert.equal(reQueue.position, 1, 'a queued worker was moved by its own retry');
    assert.equal(reQueue.already, true);
    assert.equal(reQueue.lane.queue.length, 1, 'a retry duplicated the queue entry');

    // The duplicate has to be impossible on the way IN too: a hand-edited file must not be able to
    // seat one uid twice, or the release below grants the lane to a worker that already holds it.
    const doubled = normalizeLane({ holder: HOTEL, queue: [KILO, { ...KILO, note: 'again' }, MIKE] });
    assert.deepEqual(waiting(doubled), ['kilo', 'mike'], 'a duplicate uid survived normalizeLane');
});

test('batonRelease -- pops FIFO, and a non-holder release is a no-op', () => {
    const lane = laneWith(HOTEL, KILO, MIKE);

    const r = batonRelease(lane, 's_1', at(10));
    assert.equal(r.held, true);
    assert.equal(r.grantedTo.cs, 'kilo', 'release did not grant to the FRONT of the queue');
    assert.equal(r.grantedTo.takenAt, iso(10), 'the new holder was not stamped as taking it now');
    assert.equal(r.grantedTo.since, undefined, 'the new holder still carries its queued stamp');
    assert.equal(csOf(r.lane), 'kilo');
    assert.deepEqual(waiting(r.lane), ['mike'], 'the rest of the queue did not survive the handoff');
    assert.equal(r.lane.lastHandoff, iso(10));

    // A queued worker releasing must not pop the lane it does not hold -- that would let anyone in
    // the queue evict the holder by calling the wrong verb.
    const byQueued = batonRelease(lane, 's_2', at(10));
    assert.equal(byQueued.held, false);
    assert.equal(byQueued.grantedTo, null);
    assert.equal(csOf(byQueued.lane), 'hotel', 'a non-holder release evicted the holder');
    assert.deepEqual(waiting(byQueued.lane), ['kilo', 'mike']);

    const byStranger = batonRelease(lane, 's_99', at(10));
    assert.equal(byStranger.held, false);
    assert.equal(csOf(byStranger.lane), 'hotel');
    assert.equal(batonRelease(null, 's_1', at(10)).held, false, 'releasing an empty lane claimed a hold');

    // Released with nobody waiting: the lane goes free, and lastHandoff is left where it was --
    // nobody took it, so dating a handoff to now would misdate the last real one.
    const solo = batonRelease(laneWith(HOTEL), 's_1', at(20));
    assert.equal(solo.held, true);
    assert.equal(solo.lane.holder, null);
    assert.equal(solo.grantedTo, null);
    assert.equal(solo.lane.lastHandoff, iso(0), 'an empty release re-dated the last handoff');
});

test('batonCancel -- leaves the queue, and refuses to be a silent release', () => {
    const lane = laneWith(HOTEL, KILO, MIKE);

    const c = batonCancel(lane, 's_2');
    assert.equal(c.dropped, true);
    assert.equal(c.holding, false);
    assert.deepEqual(waiting(c.lane), ['mike'], 'cancel dropped the wrong entry');
    assert.equal(csOf(c.lane), 'hotel', 'cancel disturbed the holder');

    // The holder calling cancel is a mistake worth naming: doing nothing quietly leaves the lane
    // wedged by a worker that believes it let go.
    const byHolder = batonCancel(lane, 's_1');
    assert.equal(byHolder.holding, true, 'the holder was not told it holds the lane');
    assert.equal(byHolder.dropped, false);
    assert.equal(csOf(byHolder.lane), 'hotel', 'cancel released the lane behind the caller');

    const stranger = batonCancel(lane, 's_99');
    assert.equal(stranger.dropped, false);
    assert.deepEqual(waiting(stranger.lane), ['kilo', 'mike']);
});

test('batonForce -- the human override, in both directions', () => {
    const lane = laneWith(HOTEL, KILO, MIKE);

    // Targeted: mike jumps the queue because Chris said so, and does not stay in it as well.
    const toMike = batonForce(lane, MIKE, at(30));
    assert.equal(csOf(toMike.lane), 'mike');
    assert.equal(toMike.revoked.cs, 'hotel', 'the revoked holder was not reported');
    assert.equal(toMike.grantedTo.takenAt, iso(30));
    assert.deepEqual(waiting(toMike.lane), ['kilo'], 'the forced holder kept its place in the queue too');

    // Untargeted: revoke and POP. Leaving holder:null with kilo still waiting is its own wedge --
    // kilo is parked on its poll loop and a re-request only reports the position it already has.
    const freed = batonForce(lane, null, at(31));
    assert.equal(freed.revoked.cs, 'hotel');
    assert.equal(csOf(freed.lane), 'kilo', 'a force-free stranded the queue with no holder');
    assert.deepEqual(waiting(freed.lane), ['mike']);

    // Only an EMPTY queue leaves the lane genuinely free.
    const empty = batonForce(laneWith(HOTEL), null, at(32));
    assert.equal(empty.lane.holder, null);
    assert.equal(empty.grantedTo, null);
    assert.equal(empty.revoked.cs, 'hotel');
});

test('batonReap -- a dead holder never wedges the lane, and the queue survives it', () => {
    const lane = laneWith(HOTEL, KILO, MIKE);
    // hotel died holding it 6 minutes ago; kilo and mike are both beating.
    const seenAt = (uid) => (uid === 's_1' ? at(24) : at(30));

    const r = batonReap(lane, seenAt, at(30), BATON_STALE_MS);
    assert.equal(r.revoked.cs, 'hotel', 'the dead holder kept the lane');
    assert.equal(r.grantedTo.cs, 'kilo', 'the lane was not handed to the next in line');
    assert.equal(csOf(r.lane), 'kilo');
    assert.deepEqual(waiting(r.lane), ['mike'], 'the queue did not survive the reclaim');
    assert.deepEqual(r.dropped, [], 'a live queue entry was swept');

    // Inside the window: a worker mid-build-gate does not poll for minutes, and robbing it there is
    // worse than an idle lane. 4 minutes quiet must survive a 5-minute rule.
    const spared = batonReap(lane, (uid) => (uid === 's_1' ? at(26) : at(30)), at(30), BATON_STALE_MS);
    assert.equal(spared.revoked, null, 'a holder was reaped inside the stale window');
    assert.equal(csOf(spared.lane), 'hotel');

    // Retired or missing from the roster (seenAt -> null) is not a time judgment: gone is gone.
    const buried = batonReap(lane, (uid) => (uid === 's_1' ? null : at(30)), at(30), BATON_STALE_MS);
    assert.equal(buried.revoked.cs, 'hotel', 'a retired holder was spared as if it were merely quiet');
    assert.equal(csOf(buried.lane), 'kilo');

    // Dead queue entries go in the same pass, and a live holder is left alone while they do.
    const deadQueue = batonReap(lane, (uid) => (uid === 's_2' ? null : at(30)), at(30), BATON_STALE_MS);
    assert.equal(deadQueue.revoked, null, 'sweeping the queue revoked a live holder');
    assert.equal(csOf(deadQueue.lane), 'hotel');
    assert.deepEqual(deadQueue.dropped.map(e => e.cs), ['kilo'], 'a dead queue entry kept its place');
    assert.deepEqual(waiting(deadQueue.lane), ['mike']);

    // A dead holder AND a dead front-of-queue: the lane must skip the corpse, not grant to it.
    const both = batonReap(lane, (uid) => (uid === 's_3' ? at(30) : null), at(30), BATON_STALE_MS);
    assert.equal(both.revoked.cs, 'hotel');
    assert.equal(csOf(both.lane), 'mike', 'the lane was granted to a dead queue entry');
    assert.deepEqual(both.lane.queue, []);

    // Everything dead: the lane empties rather than keeping a corpse enthroned.
    const wiped = batonReap(lane, () => null, at(30), BATON_STALE_MS);
    assert.equal(wiped.lane.holder, null);
    assert.deepEqual(wiped.lane.queue, []);
    assert.equal(wiped.grantedTo, null);
});

test('batonReap -- staleMs Infinity is the BOOT rule: provably gone only', () => {
    // Right after a restart every survivor's lastSeen is frozen at whatever it was before the hub
    // went down, so a staleness reap at boot would revoke the lane from a worker that is still
    // running. Infinity keeps the ended/missing half and drops the clock half.
    const lane = laneWith(HOTEL, KILO);
    const frozen = (uid) => (uid === 's_1' ? at(-60) : at(-60));   // an hour "quiet", both alive

    const boot = batonReap(lane, frozen, at(0), Infinity);
    assert.equal(boot.revoked, null, 'the boot reap robbed a restart survivor');
    assert.deepEqual(boot.dropped, [], 'the boot reap swept a surviving queue entry');
    assert.equal(csOf(boot.lane), 'hotel');

    // ...but a session the restart actually buried is still collected.
    const buried = batonReap(lane, (uid) => (uid === 's_1' ? null : at(-60)), at(0), Infinity);
    assert.equal(buried.revoked.cs, 'hotel', 'boot revalidation left a retired holder on the lane');
    assert.equal(csOf(buried.lane), 'kilo');
});

test('batonReap -- an unreadable clock or probe spares the lane instead of clearing it', () => {
    const lane = laneWith(HOTEL, KILO);
    // A bad `now` must not read as "everything is infinitely stale". Losing a lane to a clock glitch
    // would revoke every holder on the box at once.
    const bad = batonReap(lane, () => at(-999), NaN, BATON_STALE_MS);
    assert.equal(bad.revoked, null, 'a NaN clock reaped a live holder');
    assert.deepEqual(waiting(bad.lane), ['kilo']);

    // A probe that THROWS reads as gone -- the roster could not vouch for the session, which is the
    // same evidence as it not being there. Deliberate, and the opposite of the clock case: one is a
    // failure to judge, the other is a failed lookup.
    const threw = batonReap(lane, () => { throw new Error('roster unreadable'); }, at(0), BATON_STALE_MS);
    assert.equal(threw.revoked.cs, 'hotel');
    assert.equal(threw.lane.holder, null, 'a throwing probe left the lane half-swept');
});

test('normalizeLane -- junk in, usable lane out, and nothing invented', () => {
    const empty = normalizeLane(null);
    assert.deepEqual(empty, { base: null, holder: null, queue: [], lastHandoff: null });
    assert.deepEqual(normalizeLane('nonsense'), empty, 'a non-object lane did not degrade to empty');
    assert.deepEqual(normalizeLane({ queue: 'nope' }), empty, 'a non-array queue did not degrade to empty');

    // Timestamps already on disk are PRESERVED, never restamped: normalizeLane runs on every load and
    // a restamp there would silently reset the stale-sweep clock on every read.
    const kept = normalizeLane({
        base: 'NewBeta2', lastHandoff: iso(1),
        holder: { uid: 's_1', cs: 'hotel', branch: 'jarvis/hotel', note: 'fix', takenAt: iso(1) },
        queue: [{ uid: 's_2', cs: 'kilo', since: iso(2) }],
    });
    assert.equal(kept.base, 'NewBeta2');
    assert.equal(kept.holder.takenAt, iso(1));
    assert.equal(kept.queue[0].since, iso(2));
    assert.equal(kept.lastHandoff, iso(1));

    // A row with no uid is not a participant -- it is dropped, not seated with a blank identity that
    // no release could ever match.
    const junk = normalizeLane({ holder: { cs: 'hotel' }, queue: [{ cs: 'kilo' }, { uid: '  ' }, KILO] });
    assert.equal(junk.holder, null, 'a holder with no uid was seated anyway');
    assert.deepEqual(waiting(junk), ['kilo'], 'uid-less queue rows were seated');
    assert.equal(junk.queue[0].uid, 's_2');
});

test('BATON_STALE_MS is longer than gone-quiet, on purpose', () => {
    // The 2-minute figure is the hub's aliveNow/gone-quiet window. If these ever met, a worker in the
    // middle of a build gate would be declared quiet and robbed of the lane in the same breath.
    assert.ok(BATON_STALE_MS > 120000, 'the lane reclaims at or before the gone-quiet threshold');
    assert.equal(BATON_STALE_MS, 300000);
});
