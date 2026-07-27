// The end-to-end proof that a parentProject SUB-WORKER is not a coordinator -- in both directions --
// and that its outcome feeds back into the project's durable log when it retires (gap G3).
//
// Same gap in the same shape as revive.test.mjs. The pure halves are well covered: resolveBinding
// decides the role (binding.test.mjs), coordinatorSlotHolder refuses to let a sub-worker hold the
// slot (coordinator.test.mjs), missionIdOfCard nests its card under the mission (nesting.test.mjs).
// None of them can see whether a real /spawn produces that role, and the G3 feedback append --
// jarvis-core.mjs, retireSession -> appendProjectLog('sub-worker retired: ...') -- had no test at
// all, despite being the mechanism by which a manager rebuilds the story of finished work it never
// witnessed. It is load-bearing for every future coordinator and was resting on nothing.
//
// The two directions matter separately, and a fix for one is not a fix for the other:
//   - a sub-worker must not DISPLACE a live coordinator (or every sub-worker steals the project)
//   - a sub-worker must not BLOCK reviving a dead one (or one sub-worker wedges the project shut
//     forever and talking to the mission reaches nobody)
//
// SKIPPED by default: it spawns a real hub and real ConPTYs. Run it deliberately:
//
//     npm run test:subworker
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub, assertConsolelessPossible, sleep } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub and ConPTYs; ~40 seconds)';

const reviveLines = (hub) => hub.transcript().split('\n').filter(l => /auto-revived probe coordinator/.test(l));
const notes = async (hub) => ((await hub.get('/project?name=probe')).recentLog || []).map(e => e.note);

test('SUB-WORKER: parentProject nests under a project without taking its coordinator slot, and reports back on retire',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        assertConsolelessPossible();
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('subworker hub');

        // ---- 1. a mission, a project, its coordinator, and a sub-worker beneath it ---------------
        const made = await hub.post('/mission', { op: 'add', title: 'Probe Mission' });
        const missionId = made && made.mission && made.mission.id;
        assert.ok(missionId, 'POST /mission add returned no mission: ' + JSON.stringify(made));

        const A = await hub.spawnWorker({ purpose: 'probe coordinator', project: 'probe' });
        const a = await hub.waitFor('coordinator ' + A + ' to register', async () => {
            const row = await hub.live(A);
            return row && row.alive ? row : null;
        }, 60000);
        assert.equal((await hub.post('/project-context', { name: 'probe', missionId })).ok, true);

        const S = await hub.spawnWorker({ purpose: 'probe sub-worker', parentProject: 'probe' });
        const s = await hub.waitFor('sub-worker ' + S + ' to register', async () => {
            const row = await hub.live(S);
            return row && row.alive ? row : null;
        }, 60000);
        assert.notEqual(S, A);

        // ---- 2. it must not DISPLACE the live coordinator ----------------------------------------
        // If the sub-worker counted as a coordinator, pickProjectWorker could hand it the mission
        // (it is the more recently seen of the two) and revive would think the slot was filled by
        // the wrong session. Talking to the mission must still find A, and must spawn nothing.
        await hub.post('/hear', { text: 'on mission ' + missionId + ', while both are up', typed: true });
        await sleep(3000);
        assert.deepEqual(reviveLines(hub), [], 'a mission message revived a coordinator while one was live');
        const liveNow = (await hub.get('/roster')).live.map(x => x.callsign).sort();
        assert.deepEqual(liveNow, [A, S].sort(), 'roster gained or lost a session: ' + JSON.stringify(liveNow));

        // ---- 3. the coordinator retires, and says so in the project's own log --------------------
        const byeA = await hub.post('/retire', { uid: a.uid, summary: 'handing the project over', successor: false });
        assert.equal(byeA.ok, true, 'could not retire the coordinator: ' + JSON.stringify(byeA));
        assert.equal(byeA.successor, false);
        assert.ok((await notes(hub)).some(n => n === 'manager retired: handing the project over'),
            'a coordinator retired without its summary reaching the project log: ' + JSON.stringify(await notes(hub)));

        // ---- 4. ...and the surviving sub-worker must not BLOCK a revive --------------------------
        // THE DEADLOCK. The project now has a live session bound to it and no coordinator. If a
        // sub-worker held the slot, this message would reach nobody, forever -- the project could
        // never get a brain again and Chris would be talking into a void that looks staffed.
        await hub.post('/hear', { text: 'on mission ' + missionId + ', now that the coordinator is gone', typed: true });
        const line = await hub.waitFor('a revive despite the live sub-worker', () => reviveLines(hub)[0], 20000);
        const B = (line.match(/auto-revived probe coordinator \(([a-z]+)\)/) || [])[1];
        assert.ok(B && B !== A && B !== S, 'the revive line names no new callsign: ' + line);
        await hub.waitFor('the revived coordinator ' + B + ' to register', async () => {
            const row = await hub.live(B);
            return row && row.alive;
        }, 60000);
        // Exactly one, even with a sub-worker in the roster muddying the scan.
        await sleep(4000);
        assert.equal(reviveLines(hub).length, 1, 'revive fired more than once: ' + JSON.stringify(reviveLines(hub)));

        // ---- 5. G3: the sub-worker's outcome lands in the project log on retire ------------------
        // This is what lets a manager rehydrate work it never saw. Untested until now, and the
        // wording is asserted exactly because the log is read by the next model, not by a parser
        // that could be forgiving about it.
        const byeS = await hub.post('/retire', { uid: s.uid, summary: 'finished the probe sweep', successor: false });
        assert.equal(byeS.ok, true, 'could not retire the sub-worker: ' + JSON.stringify(byeS));
        const after = await notes(hub);
        assert.ok(after.some(n => n === 'sub-worker retired: finished the probe sweep'),
            'the sub-worker retired without feeding its outcome back to the project (gap G3): ' + JSON.stringify(after));
        // And the two roles are not confused for one another in either direction.
        assert.ok(!after.some(n => n === 'manager retired: finished the probe sweep'),
            'the sub-worker was logged as a manager');
        assert.ok(!after.some(n => n === 'sub-worker retired: handing the project over'),
            'the coordinator was logged as a sub-worker');
    });
