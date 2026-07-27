// The regression for a button that only ever broke when it was needed.
//
// Chris, 2026-07-27 22:02 and again at 22:53: the rocket on the primeng card answered
// 400 {"error":"need cwd and purpose"}. The console posts /spawn with the cwd and purpose it read
// off the card, and /board filled those in from the LIVE session only:
//
//     cwd: uid ? (roster.sessions[uid].cwd || '') : ''
//
// `uid` is liveUidOf() || projectWorkerUid(), and both skip ended sessions. So the moment every
// session bound to a project was buried -- which the 22:00 boot reconcile did to all four primeng
// sessions at once -- the card shipped cwd:'' and the button posted nothing. The continue button
// exists FOR the dead case and was broken in exactly and only that case, which is why it survived
// this long: every time anyone tested it, there was a live session filling the field in.
//
// The fix leans on a property that already existed rather than inventing state: retired sessions
// keep their cwd deliberately, because that is how a project remembers which repo it lives in.
// lastProjectCwd reads exactly that, and is the same lookup reviveMissionCoordinator uses, so the
// console and the hub cannot disagree about where a project lives.
//
// SKIPPED by default: it spawns a real hub and a real ConPTY. Run it deliberately:
//
//     npm run test:boardcard
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub, assertConsolelessPossible } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub and a ConPTY; ~20 seconds)';

const card = async (hub, name) => ((await hub.get('/board')).boards || []).find(b => b.callsign === name) || null;

test('BOARD CARD: a project whose every session has been buried still carries the cwd needed to relaunch it',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        assertConsolelessPossible();
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('boardcard hub');

        // ---- a project with a live coordinator: the case that always worked ---------------------
        const A = await hub.spawnWorker({ cwd: hub.REPO, purpose: 'probe coordinator', project: 'probe' });
        const a = await hub.waitFor('coordinator ' + A + ' to register', async () => {
            const row = await hub.live(A);
            return row && row.alive ? row : null;
        }, 60000);
        const alive = await hub.waitFor('the probe project card', () => card(hub, 'probe'), 20000);
        assert.equal(alive.alive, true);
        assert.ok(alive.cwd, 'a project card with a LIVE coordinator has no cwd, which was never the bug');
        assert.ok(alive.purpose, 'a project card with a LIVE coordinator has no purpose');

        // ---- bury the only session, which is when the button is actually wanted ------------------
        await hub.post('/retire', { uid: a.uid, summary: 'buried for the board-card probe', successor: false });
        assert.equal(await hub.live(A), null, A + ' is still live after retiring');

        const dead = await hub.waitFor('the probe card to go dead', async () => {
            const c = await card(hub, 'probe');
            return c && c.alive === false ? c : null;
        }, 20000);

        // THE ASSERTION. Pre-fix both of these were '' and the console's 🚀 posted an empty body.
        assert.ok(dead.cwd, 'REGRESSION: a dead project card has no cwd, so the console can only post cwd:"" and collect a 400');
        assert.ok(dead.purpose, 'REGRESSION: a dead project card has no purpose, the other half of "need cwd and purpose"');
        assert.equal(dead.cwd, alive.cwd, 'the dead card points at a DIFFERENT repo than the live one did');

        // Not merely non-empty: /spawn has to actually accept it. This is the 400 itself, re-run.
        const relaunch = await hub.post('/spawn', { cwd: dead.cwd, purpose: dead.purpose, project: 'probe' });
        assert.ok(relaunch && relaunch.callsign, 'the card\'s own values were rejected by /spawn: ' + JSON.stringify(relaunch));
        assert.notEqual(relaunch.callsign, A);

        // ---- a plain NATO card keeps the old blank, and the console now hides the button ---------
        // Deliberate: a standalone worker has no project row to remember a repo for it, so there is
        // nothing honest to put here. Better an absent button than one that 400s.
        const B = await hub.spawnWorker({ cwd: hub.REPO, purpose: 'plain standalone probe' });
        const b = await hub.waitFor('standalone ' + B + ' to register', async () => {
            const row = await hub.live(B);
            return row && row.alive ? row : null;
        }, 60000);
        await hub.post('/retire', { uid: b.uid, summary: 'done', successor: false });
        const plain = await card(hub, B);
        if (plain) assert.equal(plain.cwd, '', 'a plain NATO card invented a cwd from somewhere');
    });
