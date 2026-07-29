// POST /spawn is the THIRD site that can mint a project coordinator, and the only one that never
// asked whether the project already had one.
//
// The other two do: retireSession's auto-successor and reviveMissionCoordinator both consult
// coordinatorHeld, and coordinator.test.mjs pins that predicate in both directions. What no test
// could see is that the endpoint behind the console "+" and the voice spawn skipped the question
// entirely -- so the guard that stopped the AUTOMATIC paths from doubling up left the human-driven
// one wide open. On 2026-07-28 two jarvis brains were spawned into d:/claude/jarvis-core 27 seconds
// apart and overlapped for 76, and Chris's chat scattered across two tabs.
//
// The fix does not refuse the human's ask -- it nests the new session under the incumbent, the same
// coordinator-if-free-else-sub-worker rule auto-bind applies at register, so both doors agree.
//
// THE OBSERVABLE, and why it is this one: registerSession records "registered <uid> as <project>
// worker (<cs>)" for a coordinator and a plain "registered <uid> as <cs>" for anything else, so the
// number of coordinator-register lines for a project is the number of brains it got. Pre-fix the
// second spawn produced a second such line; the response field alone would only prove the endpoint
// DECIDED to nest, not that the worker came up nested.
//
// SKIPPED by default: it spawns a real hub and real ConPTYs. Run it deliberately:
//
//     npm run test:spawnslot
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub, assertConsolelessPossible, sleep } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub and ConPTYs; ~60 seconds)';

// How many sessions registered as <name>'s coordinator. One is the invariant; this counts brains.
const coordLines = (hub, name) =>
    hub.transcript().split('\n').filter(l => l.includes('registered ') && l.includes(' as ' + name + ' worker ('));
const sysLines = (hub, re) =>
    hub.transcript().split('\n').filter(l => /"kind":"sys"/.test(l) && re.test(l));
const registered = (hub, cs) => hub.waitFor(cs + ' to register', async () => {
    const row = await hub.live(cs);
    return row && row.alive ? row : null;
}, 60000);

test('SPAWN SLOT: /spawn nests under a live coordinator instead of minting a second one',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        assertConsolelessPossible();
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('spawnslot hub');

        // ---- 1. the incumbent -------------------------------------------------------------------
        const A = await hub.spawnWorker({ purpose: 'probe coordinator', project: 'probe' });
        await registered(hub, A);
        assert.equal(coordLines(hub, 'probe').length, 1, 'the first spawn did not produce a coordinator');

        // ---- 2. a second coordinator asked for, out loud, while the first is live ----------------
        // Exactly what the console "+" does when Chris re-launches a project he thinks is dead.
        const second = await hub.post('/spawn', { cwd: hub.REPO, purpose: 'probe coordinator again', project: 'probe' });
        assert.ok(second && second.callsign, '/spawn refused the ask outright: ' + JSON.stringify(second));
        assert.equal(second.nestedUnder, 'probe', 'the endpoint did not report nesting: ' + JSON.stringify(second));
        const B = second.callsign;
        await registered(hub, B);

        // THE ASSERTION. Pre-fix this is 2: B came up bound project:probe from pendingBind, answering
        // for the same board and the same project log as A.
        assert.equal(coordLines(hub, 'probe').length, 1,
            'probe got a second coordinator: ' + JSON.stringify(coordLines(hub, 'probe')));
        assert.equal(sysLines(hub, new RegExp('probe already has a coordinator \\(' + A + ' is live\\)')).length, 1,
            'the demotion was silent in the log');
        // And it is audible, not just logged -- the spoken line is how Chris learns his relaunch
        // landed as a sub-worker rather than the brain he asked for.
        assert.ok(hub.spoke(/Launching probe sub-worker/), 'the demotion was never spoken');

        // ---- 3. THE INCIDENT SHAPE: the incumbent is still BOOTING, not yet registered -----------
        // This is the case the card was written for -- "a spawn does not notice a coordinator already
        // REGISTERING". Nothing is in the roster yet, so only the pendingBind stash knows C is on its
        // way, and D is asked for before C has said a word.
        const C = await hub.spawnWorker({ purpose: 'other coordinator', project: 'other' });
        const D = await hub.post('/spawn', { cwd: hub.REPO, purpose: 'other coordinator again', project: 'other' });
        assert.equal(D.nestedUnder, 'other', 'a spawn beat a still-booting coordinator: ' + JSON.stringify(D));
        assert.equal(sysLines(hub, new RegExp('other already has a coordinator \\(' + C + ' is booting\\)')).length, 1,
            'the booting incumbent was not named in the log');
        await registered(hub, C);
        await registered(hub, D.callsign);
        assert.equal(coordLines(hub, 'other').length, 1,
            'the booting half let a second coordinator through: ' + JSON.stringify(coordLines(hub, 'other')));

        // ---- 4. an UNBOUND spawn into an occupied repo stays standalone, but says so -------------
        // Behaviour deliberately unchanged: inferring a binding from the repo is auto-bind's job at
        // register and it is mission-gated, which is why `jarvis` -- mission-less -- was never
        // caught. What changes is that the overlap is no longer invisible. This is the line whose
        // absence meant reconstructing the incident from timestamps.
        const E = await hub.spawnWorker({ purpose: 'unbound bystander' });
        await registered(hub, E);
        assert.equal(sysLines(hub, new RegExp(E + ' is standalone in .* where ' + A + ' already coordinates probe')).length, 1,
            'a standalone spawn into an occupied repo went unrecorded');
        assert.equal(coordLines(hub, 'probe').length, 1, 'the bystander was captured as a coordinator');

        // ---- 5. and the slot is released when the incumbent goes ---------------------------------
        // The guard must not be a permanent lock: once A retires, asking for a probe coordinator has
        // to produce one again, or a project can never be re-staffed after its brain dies.
        const a = await hub.live(A);
        assert.equal((await hub.post('/retire', { uid: a.uid, summary: 'stepping aside', successor: false })).ok, true);
        await sleep(1000);
        const third = await hub.post('/spawn', { cwd: hub.REPO, purpose: 'probe coordinator, take three', project: 'probe' });
        assert.equal(third.nestedUnder, undefined, 'the slot stayed locked after the coordinator retired: ' + JSON.stringify(third));
        await registered(hub, third.callsign);
        assert.equal(coordLines(hub, 'probe').length, 2, 'the replacement coordinator never registered as one');
    });
