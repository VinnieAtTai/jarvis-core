// When a COORDINATOR retires, every live sub-worker nested under it has to be told who runs the
// project now. The downward half of the delegation loop.
//
// THE INCIDENT, measured 2026-07-31. bravo retired off the jarvis project at 20:13:58 having briefed
// two sub-workers. Nothing told either of them. At 20:15 uniform sent its completion report to oscar
// opening with "(Routing to you because bravo briefed me and has since retired - you hold the console
// board-rot job now. If this belongs somewhere else, say so.)" -- it had to GUESS its coordinator and
// hedge the guess in the first line of its own report. whiskey, still live, still believed it
// reported to bravo. Neither had done anything wrong: nothing on the wire could have told them.
//
// The UPWARD half already worked and was already tested (test/delegate.test.mjs step 4: a retiring
// sub-worker's outcome is pushed to the live coordinator). retireSession's coordinator branch --
// the `s.project` one -- only ever messaged `held.uid`, i.e. another COORDINATOR that already held
// the slot. It never walked the sessions whose `parentProject` is the project being handed over.
//
// WHY THE ROUTE-LEVEL HALF IS NOT OPTIONAL, and it is the lesson from boardkey.test.mjs, where a
// green suite covering only the pure helper sat alongside three real writers that never called it:
// what is under test here is WHICH BRANCH of a retire the fan-out hangs off and WHEN it runs. A pure
// test of liveSubWorkers passes just as happily with the call site on the sub-worker branch, or
// placed BEFORE the successor is spawned -- and that second one is the failure that matters, because
// it notifies with a null callsign, which reads as "your coordinator is gone" with the actionable
// half missing. That is precisely the state uniform was already in. Only a real /retire can see it.
//
// The three outcomes are three branches of the same retire and each says something different to a
// sub-worker, so each is driven for real:
//   A. a SUCCESSOR was spawned inside this retire -> report to it, it is still booting
//   B. another coordinator ALREADY HELD the slot, so no successor -> report there instead
//   C. NOBODY replaced it -> you have no coordinator; send findings to the human
//
// The integration half is SKIPPED by default: it spawns a real hub and real ConPTY workers. Run it:
//
//     npm run test:coordchange
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveSubWorkers, coordinatorChangeNote } from '../jarvis-text.mjs';
import { createScratchHub, assertConsolelessPossible, REPO_ROOT, sleep } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub and ConPTYs; ~60 seconds)';

const NOW = Date.parse('2026-07-31T20:13:58.000Z');
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

// The roster shape the incident happened in: one coordinator, two sub-workers under it.
//
// KEY ORDER IS DELIBERATELY NOT SORTED ORDER (s_0485 before s_0484). A fixture in sorted order would
// pass with the sort deleted -- insertion order would carry it -- so the ordering claim below would
// be probed by nothing. Order is worth claiming because a roster reloaded from JSON has whatever key
// order the file happened to hold, and a test that asserts the whole set has to be able to.
const FLEET = () => ({
    s_0480: { callsign: 'bravo', project: 'jarvis', ended: null, lastSeen: at(3) },
    s_0485: { callsign: 'uniform', parentProject: 'jarvis', ended: null, lastSeen: at(2) },
    s_0484: { callsign: 'whiskey', parentProject: 'jarvis', ended: null, lastSeen: at(5) },
});

test('liveSubWorkers -- THE INCIDENT: every live sub-worker under the project, and only those', () => {
    assert.deepEqual(liveSubWorkers(FLEET(), 'jarvis', NOW), [
        { uid: 's_0484', callsign: 'whiskey' },
        { uid: 's_0485', callsign: 'uniform' },
    ]);
});

test('liveSubWorkers -- the COORDINATOR is not one of its own sub-workers', () => {
    // registerSession makes .project and .parentProject mutually exclusive, so this can only fire if
    // that invariant is ever relaxed. Getting it wrong tells the incoming coordinator that its own
    // arrival replaced it, and tells the retiring one it has been replaced by its successor.
    const f = FLEET();
    f.s_0480.parentProject = 'jarvis';                        // both fields, which must not qualify
    assert.deepEqual(liveSubWorkers(f, 'jarvis', NOW).map(s => s.callsign), ['whiskey', 'uniform']);
});

test('liveSubWorkers -- a RETIRED sub-worker is never notified', () => {
    const f = FLEET();
    f.s_0484.ended = at(60);
    assert.deepEqual(liveSubWorkers(f, 'jarvis', NOW).map(s => s.callsign), ['uniform']);
});

test('liveSubWorkers -- a session the hub has stopped believing in is not notified, and the window is injectable', () => {
    const f = FLEET();
    f.s_0484.lastSeen = at(200);                              // beyond the 2-minute gone-quiet window
    assert.deepEqual(liveSubWorkers(f, 'jarvis', NOW).map(s => s.callsign), ['uniform']);
    // Same session, wider window: this is the staleness gate deciding, not some other exclusion.
    assert.deepEqual(liveSubWorkers(f, 'jarvis', NOW, 600000).map(s => s.callsign), ['whiskey', 'uniform']);
});

test('liveSubWorkers -- an unparseable or absent lastSeen is not live', () => {
    // Deliberately the same verdict as coordinatorSlotHolder's LIVE arm: liveness must not mean one
    // thing to the slot predicate and another to the fan-out that follows it in the same retire.
    const f = FLEET();
    delete f.s_0484.lastSeen;
    f.s_0485.lastSeen = 'not a date';
    assert.deepEqual(liveSubWorkers(f, 'jarvis', NOW), []);
});

test('liveSubWorkers -- another project\'s sub-workers and unbound workers are left alone', () => {
    const f = FLEET();
    f.s_0490 = { callsign: 'victor', parentProject: 'primeng', ended: null, lastSeen: at(1) };
    f.s_0491 = { callsign: 'tango', ended: null, lastSeen: at(1) };          // plain, bound to nothing
    assert.deepEqual(liveSubWorkers(f, 'jarvis', NOW).map(s => s.callsign), ['whiskey', 'uniform']);
    assert.deepEqual(liveSubWorkers(f, 'primeng', NOW).map(s => s.callsign), ['victor']);
});

test('liveSubWorkers -- the name is normalized, so a project cannot be missed on case alone', () => {
    assert.deepEqual(liveSubWorkers(FLEET(), '  JARVIS ', NOW).map(s => s.callsign), ['whiskey', 'uniform']);
});

test('liveSubWorkers -- `exclude` keeps a notification off the retiring session itself', () => {
    assert.deepEqual(liveSubWorkers(FLEET(), 'jarvis', NOW, 120000, 's_0484').map(s => s.callsign), ['uniform']);
});

test('liveSubWorkers -- junk degrades to nobody rather than throwing on the retire path', () => {
    // This runs mid-retire, after s.ended is stamped. A throw here strands a session half-retired.
    // What this actually guards is a REFACTOR: `for...in` tolerates a null or non-object roster on its
    // own, so the explicit shape guard this file once asserted was dead code and was deleted (see the
    // note on liveSubWorkers). An Object.entries/map rewrite of that loop would throw here instead.
    for (const bad of [null, undefined, 'nope', 42]) assert.deepEqual(liveSubWorkers(bad, 'jarvis', NOW), []);
    for (const bad of [null, undefined, '', '   ']) assert.deepEqual(liveSubWorkers(FLEET(), bad, NOW), []);
    assert.deepEqual(liveSubWorkers({ s_1: null, s_2: 7, s_3: { parentProject: 'jarvis' } }, 'jarvis', NOW), []);
});

test('coordinatorChangeNote -- SUCCESSOR: names it, and says it is still booting', () => {
    const n = coordinatorChangeNote('jarvis', 'bravo', { kind: 'successor', callsign: 'oscar' });
    assert.match(n, /^YOUR COORDINATOR CHANGED: bravo retired off jarvis and oscar was spawned/);
    assert.match(n, /Report to oscar from now on/);
    assert.match(n, /BOOTING/, 'a sub-worker that fires a report at an unregistered session writes into a void');
});

test('coordinatorChangeNote -- HOLDER: names the incumbent and says no successor was spawned', () => {
    const n = coordinatorChangeNote('jarvis', 'bravo', { kind: 'holder', callsign: 'oscar' });
    assert.match(n, /oscar already holds the coordinator slot, so no successor was spawned/);
    assert.match(n, /Report to oscar from now on/);
    assert.ok(!/BOOTING/.test(n), 'a session that already holds the slot has already registered');
});

test('coordinatorChangeNote -- NOBODY: says so plainly, and says what to do instead', () => {
    // "You have no coordinator" is itself actionable -- it means stop reporting upward. A line that
    // only announced the departure would reproduce the incident with extra steps.
    const n = coordinatorChangeNote('jarvis', 'bravo', { kind: 'none', callsign: null });
    assert.match(n, /nothing replaced it: you currently have NO coordinator/);
    assert.ok(n.includes('to:"human"'), 'the fallback channel is not named: ' + n);
    assert.match(n, /retire with a summary/);
});

test('coordinatorChangeNote -- THE GUARD: a verdict with no callsign never renders "null"', () => {
    // The ordering trap. Notify before the successor spawn returns and `next.callsign` is null; the
    // sub-worker then gets "your coordinator is gone" with the actionable half missing, which is the
    // exact state uniform was in. Degrade to the no-coordinator wording, which is at least true.
    for (const next of [{ kind: 'successor', callsign: null }, { kind: 'holder' }, { kind: 'wat', callsign: 'x' }, null, undefined]) {
        const n = coordinatorChangeNote('jarvis', 'bravo', next);
        assert.match(n, /you currently have NO coordinator/, 'not the fallback wording for ' + JSON.stringify(next));
        assert.ok(!/\bnull\b|\bundefined\b/.test(n), 'a placeholder leaked into the message: ' + n);
    }
});

test('coordinatorChangeNote -- missing project or callsign still produces a readable sentence', () => {
    const n = coordinatorChangeNote(null, null, { kind: 'successor', callsign: 'oscar' });
    assert.match(n, /^YOUR COORDINATOR CHANGED: your coordinator retired off the project and oscar/);
});

test('coordinatorChangeNote -- ASCII only and no markup: it rides curl.exe JSON and is read as plain text', () => {
    for (const next of [{ kind: 'successor', callsign: 'oscar' }, { kind: 'holder', callsign: 'oscar' }, { kind: 'none' }]) {
        const n = coordinatorChangeNote('jarvis', 'bravo', next);
        assert.match(n, /^[\x20-\x7e]+$/, 'non-ASCII would arrive as tofu: ' + n);
        assert.ok(!/[*_`#]/.test(n), 'markup in a plain-text channel: ' + n);
    }
});

// ---------------------------------------------------------------------------------------------
// Route level: a real hub, real /spawn, real /retire, real /poll.
// ---------------------------------------------------------------------------------------------

const registered = (hub, cs) => hub.waitFor(cs + ' to register', async () => {
    const row = await hub.live(cs);
    return row && row.alive ? row : null;
}, 60000);

// Read the bus off disk for the NEGATIVE claims: "nobody else was told" is a claim about every
// recipient, and /poll can only ever answer for one.
const busEvents = (hub) => readFileSync(join(hub.DATA, 'bus.jsonl'), 'utf8').split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

const CHANGED = /YOUR COORDINATOR CHANGED/;
// Read it the way the sub-worker itself would -- off its own inbox. A wrong `to` leaves the event on
// the bus and breaks nothing else, so reading the bus alone could not catch it.
const inboxNotes = async (hub, uid) => ((await hub.get('/poll?uid=' + uid + '&cursor=0')).events || [])
    .filter(e => e.kind === 'msg' && CHANGED.test(e.text || ''))
    .map(e => e.text);

test('COORDINATOR CHANGE: every live sub-worker is told who runs the project now, in all three outcomes',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        assertConsolelessPossible();
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('coordchange hub');

        // ---- 1. the fleet: a coordinator, two sub-workers under it, and two controls -------------
        // cwd is REPO_ROOT rather than the rig's scratch repo for the same reason delegate.test.mjs
        // does it: the rig points spawnWorker at a throwaway dir, so anything keyed on the hub's own
        // checkout silently never fires there.
        const C1 = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'probe coordinator one', project: 'probe' });
        const c1 = await registered(hub, C1);
        // Registering as the project's coordinator is what creates the project row; prove it exists
        // before relying on anything downstream of it.
        assert.equal((await hub.post('/project-context', { name: 'probe', summary: 'coordinator change probe' })).ok, true);

        const S1 = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'probe delegate one', parentProject: 'probe' });
        const S2 = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'probe delegate two', parentProject: 'probe' });
        // The controls. TWO of them, because "notify the sub-workers" has two distinct ways to
        // over-reach: fanning out to another project's tree, and fanning out to every live session.
        const X = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'other project delegate', parentProject: 'other' });
        const P = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'unbound plain worker' });
        const [s1, s2, x, p] = [await registered(hub, S1), await registered(hub, S2), await registered(hub, X), await registered(hub, P)];
        assert.equal(new Set([C1, S1, S2, X, P]).size, 5, 'callsigns collided, so the assertions below cannot be trusted');
        // Nothing has said anything about a coordinator change yet, so every count below is caused by
        // the retire it follows rather than by the setup.
        assert.deepEqual(busEvents(hub).filter(e => CHANGED.test(e.text || '')), []);

        // ---- 2. OUTCOME A: a successor is spawned, and the sub-workers are told ITS callsign ------
        const byeC1 = await hub.post('/retire', { uid: c1.uid, summary: 'handing the project over', successor: true });
        assert.equal(byeC1.ok, true, 'could not retire the coordinator: ' + JSON.stringify(byeC1));
        assert.equal(byeC1.successor, true, 'this run did not take the successor branch, so it proves nothing about it');
        // The successor's callsign, from the hub's own sys line -- never inferred from the roster,
        // which cannot distinguish a successor from any other spawn.
        const succLine = await hub.waitFor('the successor sys line', () => {
            const m = hub.transcript().match(new RegExp(C1 + ' \\(probe worker\\) retired \\([^)]*\\) -> successor ([a-z]+)'));
            return m ? m[1] : null;
        }, 30000);
        const SUCC = succLine;
        assert.ok(SUCC && SUCC !== C1, 'no successor callsign in the sys line');

        for (const [cs, uid] of [[S1, s1.uid], [S2, s2.uid]]) {
            const notes = await inboxNotes(hub, uid);
            assert.equal(notes.length, 1, cs + ' was told ' + notes.length + ' times instead of once: ' + JSON.stringify(notes));
            const n = notes[0];
            // THE ORDERING ASSERTION. If the fan-out runs before spawnWorker returns, this is the
            // assertion that fails -- and it is the whole point: a notice that names no replacement
            // leaves the sub-worker exactly where uniform was, guessing.
            assert.match(n, new RegExp('\\b' + SUCC + '\\b'), cs + ' was told its coordinator changed but not to WHOM: ' + n);
            assert.ok(!/\bnull\b|\bundefined\b/.test(n), 'a placeholder reached a real sub-worker: ' + n);
            assert.match(n, new RegExp('\\b' + C1 + '\\b'), cs + ' was not told WHICH coordinator went away: ' + n);
        }
        // The controls, read off the bus so the claim covers every recipient.
        const strays = busEvents(hub).filter(e => CHANGED.test(e.text || '') && ![s1.uid, s2.uid].includes(e.to));
        assert.deepEqual(strays.map(e => e.to), [],
            'the fan-out reached sessions outside the project: ' + JSON.stringify(strays.map(e => e.to)));
        // kind matters as much as the recipient: a `chat` line lands in the mission thread that a
        // booting coordinator reads as its opening prompt, so this notice would come back to the hub
        // as an instruction to the very session it announces.
        for (const e of busEvents(hub).filter(e => CHANGED.test(e.text || ''))) {
            assert.equal(e.kind, 'msg', 'wrong event kind for a coordinator-change notice: ' + JSON.stringify(e));
            assert.equal(e.from, 'jarvis', 'a coordinator-change notice must come from the hub: ' + JSON.stringify(e));
        }

        // ---- 3. OUTCOME B: somebody already holds the slot, so no successor ----------------------
        // The shape this happens in for real (primeng, 2026-07-27): a GHOST coordinator is retired
        // while a live one already holds the project. The ghost registers the way every worker does
        // and is retired immediately, so the holder is the genuinely live, still-polling session.
        const succRow = await registered(hub, SUCC);
        const ghost = await hub.post('/register', { cwd: REPO_ROOT, purpose: 'ghost probe coordinator', project: 'probe' });
        assert.ok(ghost && ghost.uid, '/register did not produce a second session bound to probe: ' + JSON.stringify(ghost));
        assert.notEqual(ghost.uid, succRow.uid);

        const byeGhost = await hub.post('/retire', { uid: ghost.uid, summary: 'the ghost stands down', successor: true });
        assert.equal(byeGhost.ok, true, 'could not retire the ghost coordinator: ' + JSON.stringify(byeGhost));
        assert.ok(await hub.live(SUCC), 'the holder is not live, so this is not the held branch at all');

        for (const [cs, uid] of [[S1, s1.uid], [S2, s2.uid]]) {
            const notes = await inboxNotes(hub, uid);
            assert.equal(notes.length, 2, cs + ' did not get exactly one notice for the held branch: ' + JSON.stringify(notes));
            const n = notes[1];
            assert.match(n, /already holds the coordinator slot, so no successor was spawned/,
                cs + ' got the wrong branch for a retire into a held slot: ' + n);
            assert.match(n, new RegExp('\\b' + SUCC + '\\b'), cs + ' was not told who holds it: ' + n);
            assert.match(n, new RegExp('\\b' + ghost.callsign + '\\b'), cs + ' was not told which session went away: ' + n);
        }

        // ---- 4. OUTCOME C: nobody replaced it, said plainly -------------------------------------
        const byeSucc = await hub.post('/retire', { uid: succRow.uid, summary: 'nobody behind me', successor: false });
        assert.equal(byeSucc.ok, true, 'could not retire the surviving coordinator: ' + JSON.stringify(byeSucc));
        assert.equal(byeSucc.successor, false, 'a successor was spawned, so this is not the empty branch');
        await sleep(1500);
        assert.equal(await hub.live(SUCC), null, 'the coordinator is still live, so the project is not actually idle');

        for (const [cs, uid] of [[S1, s1.uid], [S2, s2.uid]]) {
            const notes = await inboxNotes(hub, uid);
            assert.equal(notes.length, 3, cs + ' did not get exactly one notice for the idle branch: ' + JSON.stringify(notes));
            const n = notes[2];
            assert.match(n, /you currently have NO coordinator/, cs + ' got the wrong branch for an unreplaced retire: ' + n);
            assert.ok(n.includes('to:"human"'), cs + ' was told it has no coordinator but not where to send its findings: ' + n);
            assert.ok(!/\bnull\b|\bundefined\b/.test(n), 'a placeholder reached a real sub-worker: ' + n);
        }

        // ---- 5. the controls, across all three retires -------------------------------------------
        // Read from the inboxes this time as well as the bus: the two channels fail differently and
        // "the sub-workers of another project were left alone" has to hold in both.
        for (const [cs, uid] of [[X, x.uid], [P, p.uid]]) {
            assert.deepEqual(await inboxNotes(hub, uid), [],
                cs + ' is not under this project and was told its coordinator changed anyway');
        }
        const recipients = busEvents(hub).filter(e => CHANGED.test(e.text || '')).map(e => e.to).sort();
        assert.deepEqual(recipients, [s1.uid, s1.uid, s1.uid, s2.uid, s2.uid, s2.uid].sort(),
            'the three retires did not each notify exactly the two sub-workers: ' + JSON.stringify(recipients));
    });
