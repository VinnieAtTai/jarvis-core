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

// A VERBATIM capture of a worker that died on the folder-trust prompt Claude Code actually shows:
// callsign hotel, 2026-07-30, launched into an untrusted temp directory. Generated from the log file
// and checked byte-identical -- do NOT retype it and do not tidy it up.
//
// It is verbatim because the fixture it replaces was INVENTED, and that is the whole defect. The old
// one said `Do you trust the files in this folder?` inside a box, which is the pre-2026-07 wording;
// the signature was written to match the fixture, the fixture agreed with it forever, and neither
// had anything to do with the bytes on disk. So the test passed for months while the sweep reported
// `No reason in the log` for every real trust death -- an assumption pinned in place of reality.
//
// What makes it the hard case, and what the paraphrase quietly dropped: the words are NOT separated
// by spaces. Every gap is an ESC[1C cursor-forward and each sentence starts with an absolute ESC
// cursor move, so the readable sentence exists only once something renders it -- the substring
// `Quick safety check` does not occur anywhere in these bytes. The flattener is the entire subject.
const REAL_TRUST_LOG =
      '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;claude\x07\x1b[?25h\x1b[?2004h\x1b[?1004h'
    + '\x1b[?2031h\x1b[?25l\x1b[>0q\x1b[38;2;255;193;7m\r\n'
    + '\u2500'.repeat(140)
    + '\x1b[1m\x1b[3;2HAccessing\x1b[1Cworkspace:\x1b[m\x1b[1m'
    + '\x1b[5;2HC:\\Users\\vinni\\AppData\\Local\\Temp\\claude\\deadspawn-probe\x1b[22m\x1b[7;2HQuick'
    + '\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject\x1b[1Cyou\x1b[1Ccreated'
    + '\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?\x1b[1C(Like\x1b[1Cyour\x1b[1Cown\x1b[1Ccode,\x1b[1Ca'
    + '\x1b[1Cwell-known\x1b[1Copen\x1b[1Csource\x1b[1Cproject,\x1b[1Cor\x1b[1Cwork\x1b[1Cfrom\x1b[8;2Hyour'
    + '\x1b[1Cteam).\x1b[1CIf\x1b[1Cnot,\x1b[1Ctake\x1b[1Ca\x1b[1Cmoment\x1b[1Cto\x1b[1Creview'
    + '\x1b[1Cwhat\'s\x1b[1Cin\x1b[1Cthis\x1b[1Cfolder\x1b[1Cfirst.\x1b[10;2HClaude\x1b[1CCode\'ll\x1b[1Cbe'
    + '\x1b[1Cable\x1b[1Cto\x1b[1Cread,\x1b[1Cedit,\x1b[1Cand\x1b[1Cexecute\x1b[1Cfiles\x1b[1Chere.'
    + '\x1b[38;2;153;153;153m\x1b[12;2HSecurity\x1b[1Cguide\x1b[38;2;177;185;249m\x1b[14;2H>'
    + '\x1b[38;2;153;153;153m\x1b[1C1.\x1b[38;2;177;185;249m\x1b[1CYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis'
    + '\x1b[1Cfolder\x1b[38;2;153;153;153m\x1b[15;4H2.\x1b[m\x1b[1CNo,\x1b[1Cexit\x1b[38;2;153;153;153m'
    + '\x1b[17;2HEnter\x1b[1Cto\x1b[1Cconfirm\x1b[1C\u00b7\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel';

test('DEAD SPAWN: the folder-trust prompt is readable through the REAL escape soup', () => {
    // Pre-fix this returned null, and the sweep said `No reason in the log` about this exact capture.
    assert.match(diagnoseSpawnLog(REAL_TRUST_LOG), /folder-trust prompt/);
    // ...and the fixture really is the hard case. If either of these fails, the capture has been
    // replaced by something easier and the assertion above has quietly stopped meaning anything.
    assert.ok(!/trust the files/i.test(REAL_TRUST_LOG),
        'the capture carries the OLD wording, so it is not a capture of the current prompt');
    assert.ok(!/Quick safety check/.test(REAL_TRUST_LOG),
        'the words are space-separated in the capture, so nothing here exercises the flattener');
    assert.match(REAL_TRUST_LOG, /Quick\x1b\[1Csafety/,
        'the ESC[1C word gaps have been edited out of the capture');
});

test('DEAD SPAWN: the pre-2026-07 trust wording still reads (an old Claude Code is still a Claude Code)', () => {
    // Kept deliberately: workers do not all run the same build, and dropping the old phrasing to fix
    // the new one would just move the silence somewhere harder to find.
    const log = ESC + '[2J' + ESC + '[H' + ESC + '[1m\u2502  Do you ' + ESC + '[0mtrust the\n\u2502  files in this folder?\n';
    assert.match(diagnoseSpawnLog(log), /folder-trust prompt/);
});

test('DEAD SPAWN: each trust phrasing stands on its OWN, so one rewording cannot mute the diagnosis', () => {
    // FOUND BY MUTATION PROBE: deleting either current phrasing from the signature killed nothing,
    // because the real capture happens to carry both of them. The union is redundant deliberately --
    // that redundancy is the entire guard against the next rewording -- but until this test existed it
    // was an accident of one fixture rather than a promise, and a later `simplification` down to a
    // single phrase would have stayed green while removing the guard.
    for (const only of [
        'Is this a project you created or one you trust?',
        '1. Yes, I trust this folder',
        'Do you trust the files in this folder?',
    ]) {
        assert.match(diagnoseSpawnLog(ESC + '[2J' + only + '\n'), /folder-trust prompt/,
            'this phrasing no longer reads on its own: ' + only);
    }
});

test('DEAD SPAWN: a prompt nobody has worded yet still reads as a prompt, not as silence', () => {
    // THE GUARD, and the reason it exists is one directory up in this file's history: the trust
    // signature was keyed to a sentence, the sentence changed, and the diagnosis went quiet without
    // one test going red. The next rewording would do it again. An unrecognised question wearing the
    // keypress chrome is still a worker waiting for a key nobody can press, so it must answer.
    const reworded = ESC + '[7;2HIs' + ESC + '[1Cthis' + ESC + '[1Csomething' + ESC + '[1Cnobody'
        + ESC + '[1Chas' + ESC + '[1Cworded' + ESC + '[1Cthis' + ESC + '[1Cway' + ESC + '[1Cyet?'
        + ESC + '[14;2H1.' + ESC + '[1CYes' + ESC + '[15;4H2.' + ESC + '[1CNo'
        + ESC + '[17;2HEnter' + ESC + '[1Cto' + ESC + '[1Cconfirm' + ESC + '[1C\u00b7' + ESC + '[1CEsc'
        + ESC + '[1Cto' + ESC + '[1Ccancel';
    assert.match(diagnoseSpawnLog(reworded), /interactive prompt/);
});

test('DEAD SPAWN: the prompt SHAPE never outranks a cause that is actually named', () => {
    // The real capture carries the keypress chrome too, so the ordering is load-bearing: let the
    // generic answer win and every trust death regresses from a named cause to `an interactive
    // prompt`, which is a worse note than the one this feature shipped with.
    assert.match(diagnoseSpawnLog(REAL_TRUST_LOG), /folder-trust prompt/);
    assert.match(diagnoseSpawnLog('The system cannot find the file specified.\nEnter to confirm'), /angle bracket/);
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

test('DEAD SPAWN: an unrecognised log says so HONESTLY, and still names the file to open', () => {
    // It used to say `No reason in the log`, and that turned out to be a claim rather than a fact:
    // the log that exposed the stale trust signature held a complete folder-trust prompt while the
    // note insisted there was no reason in it. What is true is narrower -- nothing in there matched a
    // signature we know -- and the difference decides whether the reader opens the file or gives up.
    const note = deadSpawnNote(spawnAt('kilo', 'd:/repo'), null, T0 + 90000);
    assert.match(note, /No known signature in the log/);
    assert.ok(!/No reason in the log/.test(note), 'the note still claims the log holds no reason');
    assert.match(note, /worker-kilo\.log/);
});

// --- the real thing -----------------------------------------------------------------------------

const sysLines = (hub, re) => hub.transcript().split('\n').filter(l => /"kind":"sys"/.test(l) && re.test(l));
const registered = (hub, cs) => hub.waitFor(cs + ' to register', async () => {
    const row = await hub.live(cs);
    return row && row.alive ? row : null;
}, 60000);
const GOOD_CLAUDE = '@echo off\r\nnode "%~dp0stub-worker.mjs"\r\n';
// The CURRENT folder-trust wording, not the historical one. This stub used to echo `Do you trust the
// files in this folder?`, which is the pre-2026-07 phrasing -- so the integration run was matching
// through the backward-compatibility alternative and never exercised the prompt that actually kills
// spawns today. Same defect as the unit fixture had, one layer further down, and it is why the
// end-to-end test stayed green while the diagnosis was dead in production.
const DYING_CLAUDE = '@echo off\r\n'
    + 'echo Quick safety check: Is this a project you created or one you trust?\r\n'
    + 'echo   1. Yes, I trust this folder\r\n'
    + 'echo   2. No, exit\r\n'
    + 'exit /b 1\r\n';

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
            () => existsSync(deadLog) && /Is this a project you created/.test(readFileSync(deadLog, 'utf8')), 30000);

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

        // ---- 8. THE SESSION THAT ASKED IS TOLD ---------------------------------------------------
        // Every observable above reports to the HUMAN -- sys line, /roster row, spoken headline. The
        // session that DISPATCHED the worker learned nothing, and it is the one that cannot act: a
        // coordinator sitting on its poll loop cannot tell `delegate still working` from `delegate never
        // existed`, and the design that keeps managers thin is precisely what stops it noticing.
        //
        // THREE doomed spawns in ONE sweep, because there are three separate decisions here and a
        // single dispatch cannot tell them apart -- the first cut of this step pointed two dispatches at
        // the same session, and deleting the whole `from` mechanism still passed it by falling through
        // to the project fallback:
        //   S1  signed with `from`, no project      -> only the signature can reach its dispatcher, and
        //                                              the dispatcher is NOT a coordinator
        //   S2  signed, dispatcher then RETIRES     -> the recipient must be re-resolved, not trusted
        //   S3  unsigned, nested under the project  -> only the project fallback can reach anybody
        // They die in the same window, so all three cost one wait.
        const lead = await hub.post('/register', { cwd: hub.REPO, purpose: 'the dispatch coordinator', project: 'dispatch' });
        const plain = await hub.post('/register', { cwd: hub.REPO, purpose: 'a plain session that delegates' });
        // Deliberately NOT nested under `dispatch`: a retiring sub-worker already sends its coordinator
        // a `retired` message of its own, and that correct behaviour would land in the counts below and
        // read as a duplicate notification. It measured 3-instead-of-2 on the first run.
        const goner = await hub.post('/register', { cwd: hub.REPO, purpose: 'a dispatcher that retires first' });
        for (const r of [lead, plain, goner]) assert.ok(r && r.uid, 'a probe session could not register: ' + JSON.stringify(r));

        // Taken before the three later spawns so step 9 can bound their `at` stamps against a real
        // instant. Checking timestamps only against EACH OTHER is what let a frozen clock through.
        const t0 = Date.now();
        writeFileSync(join(hub.BIN, 'claude.cmd'), DYING_CLAUDE);
        // S1 signs with a CALLSIGN and S2 with a uid, so both halves of what `from` accepts are under
        // test. /spawn is generous here on purpose -- POST /send already is -- because a coordinator that
        // types its own callsign should not be silently downgraded to an unattributed spawn.
        const S1 = await hub.post('/spawn', { cwd: hub.REPO, purpose: 'delegate of a plain session', from: plain.callsign });
        const S2 = await hub.post('/spawn', { cwd: hub.REPO, purpose: 'delegate whose dispatcher retires', parentProject: 'dispatch', from: goner.uid });
        const S3 = await hub.post('/spawn', { cwd: hub.REPO, purpose: 'delegate nobody signed for', parentProject: 'dispatch' });
        for (const r of [S1, S2, S3]) assert.ok(r && r.callsign, '/spawn refused a dispatch: ' + JSON.stringify(r));

        // S2's dispatcher goes away INSIDE the window -- the case a uid stashed at spawn time gets
        // wrong, and it is not a rare one: a spawn is declared dead ~100s after launch in production.
        const bye = await hub.post('/retire', { uid: goner.uid, summary: 'retired before its delegate was declared dead', successor: false });
        assert.ok(bye && bye.ok !== false, '/retire refused: ' + JSON.stringify(bye));

        for (const cs of [S1.callsign, S2.callsign, S3.callsign]) {
            await hub.waitFor(cs + ' to be swept as never registered',
                () => sysLines(hub, new RegExp(cs + ' never registered')).length > 0, 60000);
        }

        // Delivered to the inbox each session is ALREADY sitting on -- the same channel a delegate's own
        // report arrives on. That is the point: nothing new to watch and no board to poll.
        const msgsFor = async (uid) => {
            const r = await hub.get('/poll?uid=' + uid + '&cursor=0');
            return (r.events || []).filter(e => e.kind === 'msg');
        };
        const leadBox = await hub.waitFor('the coordinator to hear about both dispatches nested under it',
            async () => { const m = await msgsFor(lead.uid); return m.length >= 2 ? m : null; }, 40000);
        const plainBox = await hub.waitFor('the plain dispatcher to hear about its own',
            async () => { const m = await msgsFor(plain.uid); return m.length >= 1 ? m : null; }, 40000);
        const named = (box, cs) => box.find(m => String(m.text || '').includes(cs)) || null;

        // 1. `from` reaches the session that asked -- and it does not have to be a coordinator. Nothing
        // else could have reached this one: S1 carried no project and no parentProject at all.
        const one = named(plainBox, S1.callsign);
        assert.ok(one, 'a plain session that signed its dispatch with `from` was never told: '
            + JSON.stringify(plainBox.map(m => m.text)));

        // 2. RESOLVED AT SWEEP TIME, not stashed and trusted. S2's dispatcher retired inside the window,
        // so the uid recorded at spawn time now belongs to a session nothing will ever poll again --
        // busing the report at it would read as delivered and be seen by nobody. The live coordinator of
        // the project it was nested under has to catch it instead.
        assert.ok(named(leadBox, S2.callsign), 'a dispatch whose dispatcher retired was addressed to the corpse: '
            + JSON.stringify(leadBox.map(m => m.text)));

        // 3. an UNSIGNED dispatch -- the console + button, a voice spawn -- still reaches the coordinator
        // whose worker it was going to be.
        assert.ok(named(leadBox, S3.callsign), 'an unsigned dispatch reached nobody: '
            + JSON.stringify(leadBox.map(m => m.text)));

        // ...and nothing leaked sideways. A delegation report on a session that delegated nothing is a
        // new kind of noise, not a fix.
        assert.equal(named(plainBox, S3.callsign), null, 'a session was told about a dispatch that was not its');
        assert.equal(named(plainBox, S2.callsign), null, 'a session was told about a dispatch that was not its');

        // The message has to carry WHY and that the name is reusable, or the coordinator goes and greps
        // for both -- which is the busy-work this removes.
        assert.match(one.text, /folder-trust prompt/, 'the notification does not say WHY: ' + one.text);
        assert.match(one.text, /freed/, 'the notification does not say the callsign is reusable: ' + one.text);
        assert.match(one.text, new RegExp('worker-' + S1.callsign + '\\.log'),
            'the notification does not point at the evidence: ' + one.text);

        // ---- 9. /roster's dead-spawn list is NEWEST FIRST, and the cap depends on it ---------------
        // FOUND BY AN INDEPENDENT PROBE, and this one had already escaped: `deadSpawns.unshift` ->
        // `push` killed no test, and that exact mutation reached production -- the live hub booted on it
        // with a dirty tree. Nothing here is cosmetic, because the cap two lines below the unshift is
        // `deadSpawns.length = 10`, which truncates from the END. Newest-first plus drop-the-end means
        // the cap forgets the OLDEST death, which is right. Append plus drop-the-end means it forgets
        // the NEWEST one, so past ten deaths /roster would silently stop showing new failures -- the
        // exact silence this whole feature was built to end, restored by one word.
        //
        // Asserted as the general invariant rather than as a fixed sequence: D died in an earlier sweep
        // pass, minutes before these three, so it must sit BELOW all of them however a single pass
        // happens to walk its own Map. That is what makes this independent of insertion order.
        const deadRows = (await hub.get('/roster')).deadSpawns || [];
        const posOf = (cs) => deadRows.findIndex(x => x.callsign === cs);
        for (const cs of [S1.callsign, S2.callsign, S3.callsign, D]) {
            assert.ok(posOf(cs) >= 0, cs + ' is missing from /roster deadSpawns: ' + JSON.stringify(deadRows.map(x => x.callsign)));
        }
        for (const cs of [S1.callsign, S2.callsign, S3.callsign]) {
            assert.ok(posOf(cs) < posOf(D), 'deadSpawns is not newest-first: ' + cs + ' died after ' + D
                + ' but sits below it, so the cap would drop the NEWEST failures: '
                + JSON.stringify(deadRows.map(x => x.callsign)));
        }
        // Each row's `at` must be a REAL instant, not just consistent with its neighbours. FOUND BY
        // PROBE: freezing every `at` to epoch 0 survived the ordering checks below, because a
        // non-strict descending comparison is vacuously true when every value is identical -- so the
        // invariant I thought was general was only ever as good as the positions it agreed with. It
        // matters on its own terms too: `at` is how a human reads WHEN a dispatch died, and a row
        // that has lost its clock still looks perfectly well-formed on /roster.
        for (const cs of [S1.callsign, S2.callsign, S3.callsign]) {
            const t = Date.parse(deadRows[posOf(cs)].at);
            assert.ok(t >= t0, cs + ' has an `at` before it was even launched (' + deadRows[posOf(cs)].at + ')');
        }
        assert.ok(Date.parse(deadRows[posOf(D)].at) < t0,
            D + ' died in an earlier pass but its `at` is not earlier: ' + deadRows[posOf(D)].at);

        // ...and the same claim stated as the invariant the cap actually relies on, so a future change
        // to how the list is built has one thing to satisfy rather than one example to match. Non-strict
        // on purpose -- two spawns can share a millisecond -- which is exactly why the bounds above
        // have to carry the weight of proving the clock is real.
        const stamps = deadRows.map(x => Date.parse(x.at)).filter(Number.isFinite);
        assert.equal(stamps.length, deadRows.length, 'a deadSpawns row has no parseable `at`: ' + JSON.stringify(deadRows));
        for (let i = 1; i < stamps.length; i++) {
            assert.ok(stamps[i - 1] >= stamps[i], 'deadSpawns is not ordered newest-first at index ' + i
                + ': ' + JSON.stringify(deadRows.map(x => ({ cs: x.callsign, at: x.at }))));
        }

        // ONCE each, same discipline as step 5. The sweep ticks every few seconds forever, and a report
        // that is sent but not cleared turns one dead worker into an endless drip on a coordinator's
        // inbox -- strictly worse than the silence it replaced.
        await sleep(8000);
        const about = (box) => box.filter(m => [S1, S2, S3].some(x => String(m.text || '').includes(x.callsign)));
        assert.equal(about(await msgsFor(lead.uid)).length, 2, 'the coordinator was told more than once');
        assert.equal(about(await msgsFor(plain.uid)).length, 1, 'the plain dispatcher was told more than once');
    });
