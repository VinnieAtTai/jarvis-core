// The end-to-end proof of 13e3f8a: a console-less worker OUTLIVES its hub.
//
// Everything else about restart resilience is unit-tested (restart.test.mjs covers the pure
// classification, worktree.test.mjs the sweep), but the claim Chris actually cares about is a
// process fact on Windows, and no pure test can reach it. This one drives the real /spawn path,
// tree-kills the hub the way guardian.mjs does, and then asks the operating system whether the
// worker is still there.
//
// SKIPPED by default: it spawns real hubs, a real ConPTY and real processes, and takes about twenty
// seconds. Run it deliberately:
//
//     npm run test:survival
//
// It is a test rather than a scratch script because alpha's harness was ad hoc and died with the
// session -- the fix was verified once by someone who is now gone, and the next person to touch
// pty-host.mjs or the boot reconcile had no way to re-prove it. The rig itself now lives in
// test-support/scratch-hub.mjs for the same reason, one level up: four sessions had hand-rolled it
// and the copies disagreed about whether console-less spawning was even switched on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createScratchHub, assertConsolelessPossible, nodeAlive, treeKill, sleep } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns real hubs, ConPTYs and processes; ~20 seconds)';

test('SURVIVAL: a console-less worker outlives a tree-killed hub, and the next hub re-adopts it',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        // FIRST, before anything is spawned. Without node-pty every spawn silently takes the wt-tab
        // path and each assertion below would pass for the wrong reason -- the exact failure that cost
        // alpha three verification runs on 2026-07-27.
        assertConsolelessPossible();
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());

        // ---- 1. spawn a worker through the REAL /spawn path -------------------------------------
        const hub1 = await hub.start('first hub');
        const CS = await hub.spawnWorker({ purpose: 'survival probe' });

        // The pidfile is the anti-fallback assert: only the pty-host path writes one, so its
        // existence proves the hub did not quietly open a wt tab instead.
        const rec = await hub.waitFor('the pty-host pidfile (proves the ConPTY path, not a wt tab)',
            () => hub.hostRecord(CS), 20000);
        assert.ok(nodeAlive(rec.hostPid), 'pidfile names host ' + rec.hostPid + ' but no node process is there');
        await hub.waitFor('the worker to register', async () => (await hub.live(CS))?.alive, 30000);
        const preKill = await hub.waitFor('the host pid and childPid to both be recorded',
            () => { const r = hub.hostRecord(CS); return r && r.childPid ? r : null; }, 10000);

        // ---- 2. tree-kill the hub, exactly the way guardian.mjs recovers a wedged one ------------
        treeKill(hub1.pid, 'first hub');
        await hub.waitHubDown();
        // THE CLAIM. Before 13e3f8a the worker was a node-pty child of the hub and /T walked
        // straight into it; this is the assertion that used to be false.
        await sleep(1500);
        assert.ok(nodeAlive(preKill.hostPid), 'REGRESSION: the worker host died with its hub -- taskkill /F /T reached it, so the orphaning in orphan-spawn.mjs is not working');
        assert.ok(existsSync(hub.pidfile(CS)), 'the pidfile went with the hub, so the next hub has no handle to re-adopt by');

        // ---- 3. a genuinely new hub re-adopts the survivor ---------------------------------------
        await hub.start('second hub');
        await hub.waitFor('boot reconcile to report a re-adoption', () => /boot reconcile: re-adopted 1 live worker/.test(hub.transcript()), 20000);
        assert.ok(await hub.live(CS), CS + ' is missing from the roster after re-adoption');
        assert.ok(!/buried/.test(hub.transcript().split('boot reconcile: re-adopted')[0] || ''), 'something was buried before the re-adoption ran');
        // Survived the grace window rather than being swept by the second pass.
        await sleep(8000);
        assert.ok((await hub.live(CS))?.alive, CS + ' was buried or went quiet after the grace window -- the survivor did not reconnect to the new hub');
        // Reconnection is not just liveness: the poll loop must be talking to THIS hub.
        const seen1 = Date.parse((await hub.live(CS)).lastSeen);
        await sleep(3000);
        assert.ok(Date.parse((await hub.live(CS)).lastSeen) >= seen1, 'lastSeen is not advancing: the worker is alive but no longer reaching the hub');

        // ---- 4. and a worker whose host IS dead gets buried, with its pidfile collected ----------
        const live = hub.hostRecord(CS);
        treeKill(live.hostPid, 'worker host');
        await hub.waitFor('the host to be gone', () => !nodeAlive(live.hostPid), 15000);
        hub.killHubs();
        await hub.start('third hub');
        // launch:'pty' + no host = provable, so this one is buried on the FIRST pass, no grace window.
        await hub.waitFor('boot reconcile to bury the dead worker',
            () => new RegExp('boot reconcile: buried 1 ghost session\\(s\\) - ' + CS).test(hub.transcript()), 20000);
        assert.equal(await hub.live(CS), null, CS + ' is still listed as live after its host was killed -- this is the ghost-roster symptom the fix exists to remove');
        assert.match((await hub.retired(CS))?.summary || '', /hub restarted/, 'the ghost was dropped from the roster but not archived with a reason');
        // And Chris is TOLD. A roster that silently empties itself after a restart is indistinguishable
        // from the bug; the burial passes each speak one summary line rather than one per corpse.
        assert.ok(hub.spoke(/did not survive the restart/),
            'the fleet was buried without a word spoken -- silence here reads as the ghost-roster bug, not as a fix');
        assert.ok(!existsSync(hub.pidfile(CS)), 'the dead worker\'s pidfile was not collected; it would spare its worktree from the sweep forever');
    });
