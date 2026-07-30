// A spawn that DIES BEFORE IT REGISTERS used to vanish without a trace.
//
// POST /spawn answers `{ok, callsign}` the instant the pty launches, and everything after that --
// the host starting claude, claude booting, reading /protocol, POSTing /register -- happens where
// the hub cannot see. A worker that died inside that window left NOTHING: no roster row (not ended,
// not booting -- absent), a pinned callsign burned for five minutes, no error on any channel. It was
// indistinguishable from a launch that never happened. On 2026-07-29 three TMS dispatches died that
// way on Claude Code's folder-trust prompt and the diagnosis cost a whole session; the transcript
// still holds five such spawns with no explanation anywhere.
//
// The unit tests below pin the decisions. The integration test at the bottom is the one that matters,
// because the defect was never in a predicate -- it was in nobody ASKING. It runs a real hub with a
// real ConPTY and a claude stub that dies on the folder-trust prompt, and asserts the hub notices.
// It has already earned its keep once: it killed a first cut that inferred "a session came up in
// that directory, so the spawn must have dropped its pin rather than died".
//
// SKIPPED by default (the integration half): it spawns a real hub and real ConPTYs. Run it with:
//
//     npm run test:deadspawn
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchHub, assertConsolelessPossible, sleep } from '../test-support/scratch-hub.mjs';
import { SPAWN_REGISTER_TIMEOUT_MS, overdueSpawns, diagnoseSpawnLog, deadSpawnNote } from '../jarvis-text.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub and ConPTYs; ~60 seconds)';

const ESC = String.fromCharCode(27);
const T0 = Date.parse('2026-07-29T23:00:00.000Z');
const spawnAt = (cs, cwd, ms = 0) => ({ cs, cwd, repoKey: 'probe', log: 'C:/data/worker-' + cs + '.log', at: T0 + ms });
const session = (callsign, cwd, ms) => ({ callsign, cwd, started: new Date(T0 + ms).toISOString() });

// --- the window ---------------------------------------------------------------------------------

test('DEAD SPAWN: the default window clears every spawn-to-register time ever measured', () => {
    // 91 real pairs from the hub transcript over 7.5 days topped out at 24.0s (p95 22.0s). The
    // default has to sit well clear of that -- a false alarm on a healthy worker frees a pin and a
    // binding that are about to be used, which is worse than the bug -- and under the 2-minute
    // gone-quiet threshold, so a spawn that never boots is noticed at least as fast as one that does.
    assert.ok(SPAWN_REGISTER_TIMEOUT_MS >= 3 * 24000, 'window is too close to the measured worst case');
    assert.ok(SPAWN_REGISTER_TIMEOUT_MS < 120000, 'window is slower than the gone-quiet alarm it front-runs');
});

// --- overdueSpawns ------------------------------------------------------------------------------

test('DEAD SPAWN: a spawn inside the window is left alone, one past it is reported', () => {
    const pending = [spawnAt('kilo', 'd:/repo')];
    assert.deepEqual(overdueSpawns(pending, {}, T0 + 89999, 90000), []);
    const out = overdueSpawns(pending, {}, T0 + 90000, 90000);
    assert.equal(out.length, 1);
    assert.equal(out[0].cs, 'kilo');
    assert.equal(out[0].log, 'C:/data/worker-kilo.log', 'the entry lost the evidence path');
});

test('DEAD SPAWN: a worker that registered under its own callsign is never reported', () => {
    const pending = [spawnAt('kilo', 'd:/repo')];
    const sessions = { s_1: session('kilo', 'd:/repo', 20000) };
    assert.deepEqual(overdueSpawns(pending, sessions, T0 + 300000, 90000), []);
});

test('DEAD SPAWN: a session that was already up before the spawn does not cover for it', () => {
    // The trap this guards: callsigns are recycled, so an OLD session under the same name would
    // otherwise mask every later death of that callsign forever.
    const pending = [spawnAt('kilo', 'd:/repo')];
    const sessions = { s_1: session('kilo', 'd:/repo', -600000) };
    assert.equal(overdueSpawns(pending, sessions, T0 + 300000, 90000).length, 1,
        'a pre-existing session masked a real death');
});

test('DEAD SPAWN: a healthy worker in the same directory cannot explain away a death', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The first cut also matched on cwd, to catch a worker that
    // dropped its pin and registered under another name. Two spawns into one repo is routine, and it
    // made the healthy one account for the dead one -- the original silence, now wearing a reassuring
    // message. Only the callsign counts.
    const pending = [spawnAt('kilo', 'd:/repo')];
    const sessions = {
        s_1: session('zulu', 'd:/repo', 10000),
        s_2: { callsign: 'yankee', cwd: 'd:/other', worktree: 'd:/repo', started: new Date(T0 + 11000).toISOString() },
    };
    assert.equal(overdueSpawns(pending, sessions, T0 + 300000, 90000).length, 1,
        'a bystander session was allowed to account for a spawn that never came up');
});

test('DEAD SPAWN: junk in or around the stash cannot break the sweep', () => {
    assert.deepEqual(overdueSpawns(null, null, T0, 90000), []);
    assert.deepEqual(overdueSpawns([spawnAt('kilo', 'd:/repo')], {}, NaN, 90000), [], 'a bad clock must spare everything');
    assert.deepEqual(overdueSpawns([null, { cs: 'kilo' }, { at: T0 }], {}, T0 + 300000, 90000), []);
    // A session row under the right callsign but with no `started` must not resolve as a match by
    // way of a NaN comparison.
    assert.equal(overdueSpawns([spawnAt('kilo', 'd:/repo')], { s_1: { callsign: 'kilo', cwd: 'd:/repo' } }, T0 + 300000, 90000).length, 1);
});

// --- diagnoseSpawnLog ---------------------------------------------------------------------------

test('DEAD SPAWN: the folder-trust prompt is readable through the TUI escape soup', () => {
    // This is the shape the real logs have: the phrase is on screen but wrapped inside a box, so a
    // naive substring search over the raw bytes finds nothing.
    const log = ESC + '[2J' + ESC + '[H' + ESC + '[1m\u2502  Do you ' + ESC + '[0mtrust the\n\u2502  files in this folder?\n';
    assert.match(diagnoseSpawnLog(log), /folder-trust prompt/);
});

test('DEAD SPAWN: the cmd.exe redirection death is named for what it is', () => {
    // charlie, 2026-07-29: a stray angle bracket in the boot prompt is a REDIRECTION, because
    // node-pty runs claude through cmd.exe. The worker never registered and nothing said why.
    assert.match(diagnoseSpawnLog('The system cannot find the file specified.\n'), /angle bracket/);
});

test('DEAD SPAWN: an exit code is the fallback, never the headline', () => {
    // A worker stopped on a prompt and then killed shows BOTH. The prompt is the cause; the exit is
    // only the symptom, and reporting the symptom is what sent people looking in the wrong place.
    const both = ESC + '[1m Do you trust the files in this folder?\n[pty-host] worker exited (1)\n';
    assert.match(diagnoseSpawnLog(both), /folder-trust prompt/);
    assert.match(diagnoseSpawnLog('[pty-host] worker exited (3221225786)\n'), /exited \(code 3221225786\)/);
    assert.match(diagnoseSpawnLog('[pty-host] node-pty unavailable: no binding\n'), /node-pty/);
});

test('DEAD SPAWN: a log with no known signature says so instead of inventing one', () => {
    assert.equal(diagnoseSpawnLog('something nobody has seen before\n'), null);
    assert.equal(diagnoseSpawnLog(ESC + '[2J' + ESC + '[H'), null, 'escape codes alone are not a diagnosis');
    assert.match(diagnoseSpawnLog(''), /log is empty/);
    assert.match(diagnoseSpawnLog(null), /log is empty/);
});

// --- deadSpawnNote ------------------------------------------------------------------------------

test('DEAD SPAWN: the note carries everything needed to go and look', () => {
    const note = deadSpawnNote(spawnAt('kilo', 'd:/code/.jarvis-wt/broker-kilo'),
        'it stopped on Claude Code folder-trust prompt', T0 + 92000);
    assert.match(note, /^kilo never registered \(92s after launch\)/);
    assert.match(note, /d:\/code\/\.jarvis-wt\/broker-kilo/, 'the note does not say WHERE');
    assert.match(note, /\(probe\)/, 'the note does not say which repo');
    assert.match(note, /folder-trust prompt/, 'the note does not say WHY');
    assert.match(note, /worker-kilo\.log/, 'the note does not point at the evidence');
    assert.match(note, /Callsign freed/);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x20-\x7e]/.test(note), 'curl.exe mangles non-ASCII into tofu; the note must stay plain');
});

test('DEAD SPAWN: with no reason in the log the note still names the file to open', () => {
    const note = deadSpawnNote(spawnAt('kilo', 'd:/repo'), null, T0 + 90000);
    assert.match(note, /No reason in the log/);
    assert.match(note, /worker-kilo\.log/);
});

// --- the real thing -----------------------------------------------------------------------------

const sysLines = (hub, re) => hub.transcript().split('\n').filter(l => /"kind":"sys"/.test(l) && re.test(l));
const registered = (hub, cs) => hub.waitFor(cs + ' to register', async () => {
    const row = await hub.live(cs);
    return row && row.alive ? row : null;
}, 60000);
const GOOD_CLAUDE = '@echo off\r\nnode "%~dp0stub-worker.mjs"\r\n';
const DYING_CLAUDE = '@echo off\r\necho Do you trust the files in this folder?\r\nexit /b 1\r\n';

test('DEAD SPAWN: the hub notices a worker that never registers, and says why',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        assertConsolelessPossible();
        // 20s window so the run is a minute rather than eight, and still long enough for a healthy
        // worker to come up INSIDE it -- which is the masking case step 3 depends on.
        const hub = await createScratchHub({ graceMs: 5000, env: { JARVIS_SPAWN_TIMEOUT_MS: '20000' } });
        t.after(() => hub.dispose());
        await hub.start('deadspawn hub');

        // ---- 1. the CONTROL, and it goes first on purpose ---------------------------------------
        // Every assertion below is worthless if a healthy worker also gets reported. This one
        // registers normally and then sits there for the rest of the run, well past the window.
        const healthy = await hub.spawnWorker({ purpose: 'healthy control' });
        await registered(hub, healthy);

        // ---- 2. a spawn that dies before it can register -----------------------------------------
        // The stub prints the folder-trust prompt and exits -- the exact 2026-07-29 failure, and the
        // reason it was invisible: from the hub's side this is identical to a slow boot.
        writeFileSync(join(hub.BIN, 'claude.cmd'), DYING_CLAUDE);
        const dead = await hub.post('/spawn', { cwd: hub.REPO, purpose: 'a worker that dies on boot', project: 'ghost' });

        // THE CONSTRAINT: /spawn still answers synchronously with a callsign. Callers depend on it,
        // and nothing about noticing a death later is allowed to change that.
        assert.ok(dead && dead.ok !== false && dead.callsign, '/spawn stopped answering with a callsign: ' + JSON.stringify(dead));
        const D = dead.callsign;
        assert.equal(await hub.live(D), null, 'the dead spawn somehow registered');

        // Wait for it to have actually run and died before putting the good stub back. /spawn returns
        // the moment the host process is forked, and the host takes a beat to boot node, read its
        // config and start claude -- restoring claude.cmd on the way past that beat means the worker
        // launches HEALTHY and the test proves nothing. (Measured: it did exactly that, and the run
        // read as a missing feature rather than a racing test.)
        const deadLog = join(hub.DATA, 'worker-' + D + '.log');
        await hub.waitFor(D + ' to reach the trust prompt and exit',
            () => existsSync(deadLog) && /trust the files/.test(readFileSync(deadLog, 'utf8')), 30000);

        // ---- 3. ...while a HEALTHY worker comes up in the same directory inside the same window ---
        // This is routine (two workers on one repo) and it is what killed the first cut of the
        // feature, which treated any session appearing in the cwd as proof the spawn had merely
        // dropped its pin. The death below has to be reported anyway.
        writeFileSync(join(hub.BIN, 'claude.cmd'), GOOD_CLAUDE);
        const bystander = await hub.spawnWorker({ cwd: hub.REPO, purpose: 'bystander in the same repo' });
        await registered(hub, bystander);

        // ---- 4. THE ASSERTION: it is noticed, and named -------------------------------------------
        // Pre-fix this waits forever: nothing anywhere ever mentions D again.
        await hub.waitFor(D + ' to be reported as never registered',
            () => sysLines(hub, new RegExp(D + ' never registered')).length > 0, 40000);
        const [note] = sysLines(hub, new RegExp(D + ' never registered'));
        assert.match(note, /folder-trust prompt/, 'the reason was not read out of the log: ' + note);
        assert.match(note, new RegExp('worker-' + D + '\\.log'), 'the note does not point at the evidence: ' + note);

        // ...and it is visible without grepping the transcript, which is what the console reads.
        const roster = await hub.get('/roster');
        const row = (roster.deadSpawns || []).find(x => x.callsign === D);
        assert.ok(row, '/roster does not surface the dead spawn: ' + JSON.stringify(roster.deadSpawns));
        assert.match(row.reason, /folder-trust prompt/);
        assert.ok(row.log && row.cwd, 'the roster row is missing the evidence path or the cwd');
        // Spoken, not just written -- a dispatch that silently failed is the whole complaint. The wait
        // is for the say pump, which drains the queue on its own 250ms tick well after the sys line
        // is already on disk.
        await hub.waitFor('the failed dispatch to be spoken',
            () => hub.spoke(new RegExp(D + ' never came up')), 5000);

        // ---- 5. reported ONCE, and this has to come BEFORE step 6 --------------------------------
        // The sweep runs every few seconds forever. An entry that is reported but not cleared turns
        // one dead worker into an endless stream of chat dividers and spoken lines.
        //
        // ORDER IS LOAD-BEARING, found by mutation probe: step 6 registers a session under D, which
        // makes overdueSpawns skip the entry from then on whether or not the sweep ever cleared it.
        // Run these the other way round and deleting `pendingSpawns.delete(e.cs)` from the hub is a
        // change no test can see -- the probe survived exactly that way.
        await sleep(10000);
        assert.equal(sysLines(hub, new RegExp(D + ' never registered')).length, 1,
            'the same dead spawn was reported more than once');

        // ---- 6. the reservations really are given back -------------------------------------------
        // The dead spawn asked for project "ghost", so pendingBind holds that intent for D for five
        // minutes. Freeing the callsign without releasing the binding is worse than burning it: the
        // next session to take the name silently inherits a dead worker's project. Registering as D
        // now must produce a plain standalone session.
        const took = await hub.post('/register', { cwd: hub.REPO, purpose: 'took the freed callsign', pin: D });
        assert.equal(took.callsign, D, 'the freed callsign was not reissued: ' + JSON.stringify(took));
        assert.equal(sysLines(hub, new RegExp('registered ' + took.uid + ' as ghost worker')).length, 0,
            'a dead spawn handed its project binding to whoever took its callsign next');

        // ---- 7. and neither healthy worker was ever touched ---------------------------------------
        // Both have now been up many times longer than the window.
        for (const cs of [healthy, bystander]) {
            assert.equal(sysLines(hub, new RegExp(cs + ' never registered')).length, 0,
                'a healthy registered worker (' + cs + ') was reported dead');
        }
    });
