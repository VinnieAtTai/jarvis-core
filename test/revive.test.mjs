// The end-to-end proof of T2 auto-revive: talking to a mission whose coordinator is gone brings up
// a new one, and never a second.
//
// coordinator.test.mjs already covers the PREDICATE (coordinatorSlotHolder) exhaustively, in both
// directions of the 2026-07-27 double-spawn race. What no pure test can reach is the wiring around
// it -- that a human sentence arriving over HTTP actually travels handleUtterance -> routeToMission
// -> reviveMissionCoordinator -> spawnWorker -> a real ConPTY -> a session that registers bound to
// the project. Every one of those hops is a place the fix can be correct and still not run, and the
// board card for this verify sat blocked for days waiting for the live preconditions (a dead
// coordinator plus a mission message) to line up on Chris's own hub. They line up here on demand.
//
// The dead coordinator is RETIRED rather than left to go stale, on purpose: newestProjectSession
// deliberately keeps ended sessions (that is how a project remembers its repo after its worker
// dies), so a retired coordinator still supplies the cwd revive needs, and the slot is empty
// immediately instead of 120 seconds from now. The stale-ghost shape of the same predicate is
// already pinned in coordinator.test.mjs.
//
// SKIPPED by default: it spawns a real hub and real ConPTYs. Run it deliberately:
//
//     npm run test:revive
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub, assertConsolelessPossible, sleep } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub and ConPTYs; ~30 seconds)';

// Every 'auto-revived <project> coordinator (<cs>)' line the hub has written so far.
const reviveLines = (hub) => hub.transcript().split('\n').filter(l => /auto-revived probe coordinator/.test(l));
// Live sessions that are not the original coordinator -- i.e. anything revive brought up.
async function revived(hub, original) {
    return (await hub.get('/roster')).live.filter(s => s.callsign !== original);
}

test('AUTO-REVIVE: a mission message with no live coordinator brings up exactly one, and a live one is never doubled',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        // FIRST, before anything is spawned: without node-pty the hub silently falls back to visible
        // wt tabs and every assertion below would pass while testing a different code path.
        assertConsolelessPossible();
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('revive hub');

        // ---- 1. a mission, a project, and a live coordinator bound to both ----------------------
        const made = await hub.post('/mission', { op: 'add', title: 'Probe Mission' });
        const missionId = made && made.mission && made.mission.id;
        assert.ok(missionId, 'POST /mission add returned no mission: ' + JSON.stringify(made));

        // Spawning WITH a project is what creates the project row (registerSession -> ensureProject),
        // so the coordinator has to come up before the mission can be linked to it.
        const A = await hub.spawnWorker({ purpose: 'probe coordinator', project: 'probe' });
        const a = await hub.waitFor('coordinator ' + A + ' to register', async () => {
            const row = await hub.live(A);
            return row && row.alive ? row : null;
        }, 60000);
        const link = await hub.post('/project-context', { name: 'probe', missionId });
        assert.equal(link.ok, true, 'could not link project probe to the mission: ' + JSON.stringify(link));

        // ---- 2. LIVE coordinator: the message routes to it, and nothing is spawned ---------------
        // The negative half matters as much as the positive one. A revive that fires whenever a
        // mission is addressed would mint a second coordinator for every sentence Chris speaks --
        // which is the shape of the bug this path was rewritten to prevent, not a milder version of it.
        await hub.post('/hear', { text: 'on mission ' + missionId + ', first message', typed: true });
        await sleep(3000);
        assert.deepEqual(await revived(hub, A), [], 'a mission message spawned a coordinator while one was already live');
        assert.deepEqual(reviveLines(hub), [], 'revive fired even though the coordinator was live and heartbeating');

        // ---- 3. retire the coordinator, so the slot is genuinely empty ---------------------------
        const bye = await hub.post('/retire', { uid: a.uid, summary: 'stepping aside for the revive probe', successor: false });
        assert.equal(bye.ok, true, 'could not retire ' + A + ': ' + JSON.stringify(bye));
        assert.equal(bye.successor, false, 'the retire path spawned a successor, which would mask what revive does next');
        assert.equal(await hub.live(A), null, A + ' is still listed live after retiring');

        // ---- 4. DEAD coordinator: one message revives, and a second does NOT double it -----------
        // Fired back to back deliberately. The real incident put victor and whiskey 43s apart from two
        // spawn sites that could not see each other; the fix reads pendingBind, which is written
        // synchronously by spawnWorker, so the second sentence must find the slot held by a coordinator
        // that has not registered yet. That BOOTING window is the one this can still regress in.
        await hub.post('/hear', { text: 'on mission ' + missionId + ', second message', typed: true });
        await hub.post('/hear', { text: 'on mission ' + missionId + ', third message', typed: true });

        const line = await hub.waitFor('the hub to report an auto-revive', () => reviveLines(hub)[0], 20000);
        const B = (line.match(/auto-revived probe coordinator \(([a-z]+)\)/) || [])[1];
        assert.ok(B && B !== A, 'the revive line names no new callsign: ' + line);

        // It is not revived until it is actually THERE. The sys line only proves spawnWorker returned.
        await hub.waitFor('the revived coordinator ' + B + ' to register', async () => {
            const row = await hub.live(B);
            return row && row.alive;
        }, 60000);

        // Settle, then count. Anything spawned by the third message has had ample time to appear.
        await sleep(5000);
        assert.equal(reviveLines(hub).length, 1, 'revive fired more than once: ' + JSON.stringify(reviveLines(hub)));
        const up = await revived(hub, A);
        assert.equal(up.length, 1, 'expected exactly one revived coordinator, got ' + JSON.stringify(up.map(s => s.callsign)));
        assert.equal(up[0].callsign, B);

        // ---- 5. and not one word of the human's was dropped on the way ---------------------------
        // The durable mission thread is the reason revive can be lazy: the message is recorded before
        // any coordinator exists, so the revived one reads it on boot with no re-brief. If these went
        // missing, revive would be bringing up a brain with nothing to act on.
        const chat = await hub.get('/mission-chat?missionId=' + missionId);
        const said = (chat.messages || []).map(m => m.text).join(' | ');
        for (const w of ['first message', 'second message', 'third message']) {
            assert.ok(said.includes(w), 'the mission thread lost "' + w + '": ' + said);
        }

        // And Chris is told, for the same reason the burial speaks: a coordinator appearing out of
        // nowhere is indistinguishable from a bug unless the hub says it did it on purpose.
        assert.ok(hub.spoke(/Reviving the probe coordinator/),
            'a coordinator was revived without a word spoken');
    });
