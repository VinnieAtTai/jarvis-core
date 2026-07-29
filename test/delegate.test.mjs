// The DELEGATION CONTRACT: does a project coordinator get told it can dispatch sub-workers, is a
// sub-worker told it cannot, and does a delegate's outcome come back to the manager that sent it?
//
// Two halves of one gap. POST /spawn has accepted parentProject since sub-workers existed, so
// delegation was always technically possible -- and never used, because nothing ever told a
// coordinator it was there. /protocol is written for the worker end of the wire (register, poll,
// report, retire) and never mentions spawning; the coordinator paragraph in spawnWorker said only
// that it manages a board and a context store. Meanwhile the feedback path stopped half way: a
// retiring sub-worker appended its summary to the parent project's durable log, which is a store the
// manager has no reason to re-read, so a manager that delegated could only find out its delegate had
// finished by polling for it. Both halves add up to the same thing -- managers did heavy work inline,
// which is the "coordinators must stay thin" problem from the other end.
//
// WHY THIS CANNOT BE A PURE TEST. What is under test is which BRANCH a paragraph is built on, and
// which live session an event is addressed to. A pure test of the text would pass just as happily
// with the paragraph on the sub-worker branch, which is the one failure that actually matters here:
// a sub-worker that spawns grandchildren produces a tree with no coordinator anyone can find, and
// the retire-summary feedback path is defined for exactly one hop.
//
// SKIPPED by default: it spawns a real hub and real ConPTYs. Run it deliberately:
//
//     npm run test:delegate
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchHub, assertConsolelessPossible, REPO_ROOT } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub and ConPTYs; ~40 seconds)';

// Capturing the boot prompt. It is deliberately never persisted: spawnWorkerConsoleless hands it to
// pty-host in a config file that pty-host deletes the instant it has read it, specifically so
// JARVIS_DATA does not accumulate every brief the hub has ever written. So catch it at the far end,
// in the claude stub, which is the only place it comes to rest.
//
// It cannot be forwarded with %*. node-pty escapes the prompt's own quotes as \" when it builds the
// command line; cmd.exe does not understand that escape, so the quote state unbalances and the &s in
// the hub's URLs leak out as command separators. !CMDCMDLINE! under DELAYED expansion is substituted
// AFTER the line has been parsed, so nothing inside it is ever re-interpreted -- and it has to be
// delayed expansion rather than %CMDCMDLINE%, which is a cmd pseudo-variable that no child process
// inherits (measured: the child sees it empty).
//
// The capture is byte-exact except for non-ASCII, which the console codepage folds. Hence ASCII-only
// needles below -- the same rule the hub's own bodies follow.
function recordBootPrompts(hub) {
    writeFileSync(join(hub.BIN, 'claude.cmd'), [
        '@echo off',
        'setlocal enabledelayedexpansion',
        '> "' + join(hub.DATA, 'boot-') + '%JARVIS_CALLSIGN%.txt" echo(!CMDCMDLINE!',
        'endlocal',
        'node "%~dp0stub-worker.mjs"',
    ].join('\r\n') + '\r\n');
}

// The recorded prompt with node-pty's argv escaping undone, so needles read the way the prompt does.
// Length-gated because the redirect above and this read are not synchronised: a zero-length or
// half-written file means "not yet", not "no prompt".
const bootPrompt = (hub, cs) => hub.waitFor('the boot prompt for ' + cs, () => {
    const p = join(hub.DATA, 'boot-' + cs + '.txt');
    if (!existsSync(p)) return null;
    const t = readFileSync(p, 'utf8');
    return t.length > 400 ? t.replace(/\\"/g, '"') : null;
}, 60000);

const registered = (hub, cs) => hub.waitFor(cs + ' to register', async () => {
    const row = await hub.live(cs);
    return row && row.alive ? row : null;
}, 60000);

const notes = async (hub) => ((await hub.get('/project?name=probe')).recentLog || []).map(e => e.note);
// Read the bus off disk rather than through a session inbox: "nobody was notified" is a claim about
// every recipient, and /poll can only ever answer for one.
const busMsgs = (hub) => readFileSync(join(hub.DATA, 'bus.jsonl'), 'utf8').split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.kind === 'msg');

const DONE_1 = 'mapped the delegated sweep';
const DONE_2 = 'finished with nobody home';

test('DELEGATION: a coordinator is told how to dispatch sub-workers, a sub-worker is not, and a delegate reports back to the live manager',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        assertConsolelessPossible();
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        recordBootPrompts(hub);          // before start(): the stub is read at spawn time, not at boot
        await hub.start('delegate hub');

        // ---- 1. a coordinator, and a sub-worker under it -----------------------------------------
        // cwd is REPO_ROOT rather than the rig's default scratch repo deliberately. The rig points
        // spawnWorker at a throwaway repo dir, so anything keyed on the hub's own checkout silently
        // never fires there and the assertions pass for the wrong reason.
        const A = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'probe coordinator', project: 'probe' });
        const a = await registered(hub, A);
        // Registering as the project's coordinator is what creates the project row, and
        // appendProjectLog is a no-op without one -- so prove the row exists before relying on it.
        assert.equal((await hub.post('/project-context', { name: 'probe', summary: 'delegation probe' })).ok, true);

        const S = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'probe delegate', parentProject: 'probe' });
        const s = await registered(hub, S);
        assert.notEqual(S, A);

        // ---- 2. the contract is in the COORDINATOR's brief ---------------------------------------
        // Asserted as whole phrases, not keywords: this text is read by a model, and "mentions the
        // word spawn somewhere" is not the same as telling it what to POST and what shape.
        const bootA = await bootPrompt(hub, A);
        assert.ok(bootA.includes('POST http://127.0.0.1:' + hub.port + '/spawn'),
            'the coordinator brief never names the spawn endpoint: ' + bootA.slice(-900));
        assert.ok(bootA.includes('"parentProject":"probe"'),
            'the coordinator brief does not show parentProject in the spawn body, which is the field that nests the worker: ' + bootA.slice(-900));
        assert.ok(bootA.includes('the response carries the new callsign'),
            'the coordinator brief never says where the new callsign comes from');
        assert.ok(bootA.includes('POST http://127.0.0.1:' + hub.port + '/send'),
            'the coordinator brief never says how to brief the sub-worker it just spawned');
        assert.ok(/stay THIN and responsive/.test(bootA),
            'the coordinator brief states the mechanism but not the discipline (delegate heavy work, stay thin)');

        // ---- 3. ...and NOT in the sub-worker's. This is the no-grandchildren guard ----------------
        // The assertion most worth having. A sub-worker that can spawn produces a tree instead of one
        // hop, with no coordinator anyone can find and a feedback path that only defines one level.
        const bootS = await bootPrompt(hub, S);
        assert.ok(/You are a SUB-WORKER under/.test(bootS),
            'this is not a sub-worker brief at all, so the check below would prove nothing: ' + bootS.slice(0, 400));
        assert.ok(!/\/spawn/.test(bootS),
            'a SUB-WORKER was told how to spawn: it can now mint grandchildren: ' + bootS.slice(-900));
        assert.ok(!/DELEGATE/.test(bootS),
            'the delegation contract leaked onto the sub-worker branch: ' + bootS.slice(-900));

        // ---- 4. the delegate retires and the LIVE manager is told, without asking -----------------
        const byeS = await hub.post('/retire', { uid: s.uid, summary: DONE_1, successor: false });
        assert.equal(byeS.ok, true, 'could not retire the sub-worker: ' + JSON.stringify(byeS));
        // The durable half (gap G3) still happens -- the push is additional to the log, not instead.
        assert.ok((await notes(hub)).some(n => n === 'sub-worker retired: ' + DONE_1),
            'the sub-worker retired without its outcome reaching the project log: ' + JSON.stringify(await notes(hub)));
        // The pushed half. Read it the way the coordinator would, off its own inbox: a wrong `to`
        // would leave the event on the bus and break nothing else.
        const inbox = await hub.get('/poll?uid=' + a.uid + '&cursor=0');
        const note = (inbox.events || []).find(e => e.kind === 'msg' && (e.text || '').includes(DONE_1));
        assert.ok(note, 'the delegate\'s outcome never reached the live coordinator inbox: '
            + JSON.stringify((inbox.events || []).map(e => e.kind + ':' + (e.text || '').slice(0, 60))));
        assert.match(note.text, new RegExp('\\b' + S + '\\b'),
            'the manager was told a delegate finished but not WHICH one: ' + note.text);

        // ---- 5. no live coordinator: no notify, and the retire still completes --------------------
        // A sub-worker routinely outlives its manager, and this is the path where a naive push aims
        // an event at a retired uid -- delivered to nobody, forever unread, and counted as pending
        // against a corpse.
        const byeA = await hub.post('/retire', { uid: a.uid, summary: 'coordinator done', successor: false });
        assert.equal(byeA.ok, true, 'could not retire the coordinator: ' + JSON.stringify(byeA));
        assert.equal(await hub.live(A), null, 'the coordinator is still live, so this case is not being tested');

        const S2 = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'orphan delegate', parentProject: 'probe' });
        const s2 = await registered(hub, S2);
        const byeS2 = await hub.post('/retire', { uid: s2.uid, summary: DONE_2, successor: false });
        assert.equal(byeS2.ok, true, 'a retire with no coordinator to notify must still complete: ' + JSON.stringify(byeS2));
        assert.ok((await notes(hub)).some(n => n === 'sub-worker retired: ' + DONE_2),
            'the durable append stopped happening once there was nobody to push to: ' + JSON.stringify(await notes(hub)));
        assert.ok(!busMsgs(hub).some(e => (e.text || '').includes(DONE_2)),
            'something was notified about a delegate with no coordinator live: '
            + JSON.stringify(busMsgs(hub).filter(e => (e.text || '').includes(DONE_2))));
    });
