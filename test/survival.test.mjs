// The end-to-end proof of 13e3f8a: a console-less worker OUTLIVES its hub.
//
// Everything else about restart resilience is unit-tested (restart.test.mjs covers the pure
// classification, worktree.test.mjs the sweep), but the claim Chris actually cares about is a
// process fact on Windows, and no pure test can reach it. This one drives the real /spawn path,
// tree-kills the hub the way guardian.mjs does, and then asks the operating system whether the
// worker is still there.
//
// SKIPPED by default: it spawns real hubs, a real ConPTY and real processes, and takes about a
// minute. Run it deliberately:
//
//     JARVIS_INTEGRATION=1 node --test test/survival.test.mjs
//
// It is a test rather than a scratch script because alpha's harness was ad hoc and died with the
// session -- the fix was verified once by someone who is now gone, and the next person to touch
// pty-host.mjs or the boot reconcile had no way to re-prove it.
//
// WORKTREE WORKERS, READ THIS. A git worktree has no node_modules of its own, so `node-pty` does
// not resolve there, and spawnWorkerConsoleless SILENTLY falls back to visible wt tabs. A run that
// falls back proves NOTHING about the code under test while still going green (this bit alpha three
// times). Two defences below: resolveNodeModules() finds the real checkout's node_modules through
// git's common dir, and the harness REFUSES TO START if node-pty still will not load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns real hubs, ConPTYs and processes; ~1 minute)';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A recorded pid is only interesting if a node process is still behind it. Same check the hub uses
// (hostAlive), and deliberately narrower than process.kill(pid,0), which pid reuse can fool.
function nodeAlive(pid) {
    if (!pid) return false;
    try { return /node\.exe/i.test(execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { encoding: 'utf8', timeout: 8000 })); }
    catch { return false; }
}
// Never taskkill a pid this harness did not spawn, and never one that is not a node process.
function treeKill(pid, what) {
    assert.ok(nodeAlive(pid), 'refusing to kill ' + what + ' pid ' + pid + ': not a live node process');
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 10000 }); } catch { }
}
// The worktree fix. `git rev-parse --git-common-dir` points at the MAIN checkout's .git even from a
// worktree, so its parent is where node_modules actually lives.
function resolveNodeModules() {
    const local = join(HERE, 'node_modules');
    if (existsSync(join(local, 'node-pty'))) return local;
    try {
        const common = execFileSync('git', ['-C', HERE, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 8000 }).trim();
        if (common) {
            const cand = join(dirname(common.replace(/\\/g, '/').replace(/\/+$/, '')), 'node_modules');
            if (existsSync(join(cand, 'node-pty'))) return cand;
        }
    } catch { }
    return local;
}
async function freePort(from = 8177) {
    for (let p = from; p < from + 40; p++) {
        const ok = await new Promise(r => {
            const s = createServer();
            s.once('error', () => r(false));
            s.listen(p, '127.0.0.1', () => s.close(() => r(true)));
        });
        if (ok) return p;
    }
    throw new Error('no free port in ' + from + '..' + (from + 40));
}
async function waitFor(label, fn, timeoutMs = 30000, everyMs = 400) {
    const until = Date.now() + timeoutMs;
    let last;
    for (;;) {
        try { const v = await fn(); if (v) return v; last = null; }
        catch (e) { last = e; }
        if (Date.now() > until) throw new Error('timed out after ' + timeoutMs + 'ms waiting for ' + label + (last ? ' (last error: ' + last.message + ')' : ''));
        await sleep(everyMs);
    }
}

test('SURVIVAL: a console-less worker outlives a tree-killed hub, and the next hub re-adopts it',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        const NODE_MODULES = resolveNodeModules();
        // Refuse to run a green-but-worthless pass. Without node-pty the hub takes the wt-tab path,
        // opens terminal windows, and every assertion below passes while testing nothing.
        try { createRequire(join(NODE_MODULES, 'x.js'))('node-pty'); }
        catch (e) {
            assert.fail('node-pty will not load from ' + NODE_MODULES + ' -- the hub would silently fall '
                + 'back to visible wt tabs and this run would prove nothing. ' + e.message);
        }

        const root = mkdtempSync(join(tmpdir(), 'jarvis-survival-'));
        const DATA = join(root, 'data'), BIN = join(root, 'bin'), REPO = join(root, 'repo'), LAD = join(root, 'localappdata');
        for (const d of [DATA, BIN, REPO, LAD]) mkdirSync(d, { recursive: true });
        const PORT = await freePort();
        const ORIGIN = 'http://127.0.0.1:' + PORT;

        // The stub that stands in for claude. resolveClaude() searches PATH for claude.exe/.cmd/.bat,
        // so putting this at the front of PATH is enough to divert the real spawn path onto it.
        //
        // It deliberately does NOT forward %* -- the boot prompt is a paragraph of quotes, semicolons
        // and URLs, and everything the stub needs (callsign, port) arrives in the environment that
        // pty-host.mjs sets. Forwarding it would only add a cmd.exe quoting hazard to a test whose
        // subject is process lifetime.
        writeFileSync(join(BIN, 'claude.cmd'), '@echo off\r\nnode "%~dp0stub-worker.mjs"\r\n');
        // A worker reduced to its two load-bearing behaviours: register, then poll forever. The
        // retry-on-failure is not politeness, it is the thing under test -- a real worker's poll loop
        // rides out a hub restart by sleeping and retrying, and that is how a survivor reconnects.
        writeFileSync(join(BIN, 'stub-worker.mjs'), `
const base = 'http://127.0.0.1:' + process.env.JARVIS_PORT;
const cs = process.env.JARVIS_CALLSIGN;
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let uid = null;
(async () => {
    while (!uid) {
        try { const r = await post('/register', { cwd: process.cwd(), purpose: 'survival stub', pin: cs }); uid = r && r.uid; } catch {}
        if (!uid) await sleep(1000);
    }
    let cur = 0;
    for (;;) {
        try {
            const r = await (await fetch(base + '/poll?uid=' + uid + '&cursor=' + cur)).json();
            if (r && r.error === 'retired') process.exit(0);
            if (r && typeof r.cursor === 'number') cur = r.cursor;
            if (r && r.events && r.events.some(e => e.kind === 'retired')) process.exit(0);
        } catch { await sleep(1000); }   // the hub is down: keep breathing, that is the point
    }
})();
`);

        const hubEnv = () => ({
            ...process.env,
            PATH: BIN + ';' + process.env.PATH,
            NODE_PATH: NODE_MODULES,
            JARVIS_DATA: DATA,
            LOCALAPPDATA: LAD,          // keep the real console's chrome profile out of this
            JARVIS_PORT: String(PORT),
            JARVIS_NO_UI: '1',          // no Playwright window
            JARVIS_WORKTREES: '0',      // worktree isolation is worktree.test.mjs's subject, not ours
            JARVIS_CONSOLELESS: '1',    // the code under test
            JARVIS_READOPT_GRACE_MS: '5000',
            JARVIS_REAL_USAGE: '',
        });
        const hubs = [];
        async function startHub(label) {
            const p = spawn(process.execPath, ['jarvis-core.mjs'], { cwd: HERE, env: hubEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            p.stdout.on('data', d => { out += d; });
            p.stderr.on('data', d => { out += d; });
            hubs.push(p);
            await waitFor(label + ' to print JARVIS CORE READY', () => {
                if (p.exitCode !== null) throw new Error('hub exited ' + p.exitCode + ': ' + out.slice(-500));
                return /JARVIS CORE READY/.test(out);
            }, 45000);
            return p;
        }
        const get = async (p) => (await fetch(ORIGIN + p)).json();
        // /roster answers {focus, live, retired}: `live` is every unended session, `alive` within it
        // is the heartbeat test. A buried session leaves `live` entirely and turns up in `retired`.
        const rosterRow = async (cs) => (await get('/roster')).live.find(r => r.callsign === cs) || null;
        const retiredRow = async (cs) => (await get('/roster')).retired.find(r => r.callsign === cs) || null;
        const transcript = () => { try { return readFileSync(join(DATA, 'transcript.jsonl'), 'utf8'); } catch { return ''; } };

        // Teardown has to be thorough in a way most teardowns do not, because the thing under test is
        // a process that deliberately survives having its parent tree-killed. A missed host is not a
        // stray child that dies with the runner -- it is an orphan holding a ConPTY forever, and the
        // only record of its pid is in a scratch directory this block is about to delete. So sweep
        // every pidfile actually present rather than guessing which callsign the scratch hub issued.
        t.after(() => {
            for (const h of hubs) { if (h.pid && nodeAlive(h.pid)) treeKill(h.pid, 'hub'); }
            try {
                for (const f of readdirSync(DATA)) {
                    if (!/^worker-.+\.pid$/i.test(f)) continue;
                    try {
                        const r = JSON.parse(readFileSync(join(DATA, f), 'utf8'));
                        if (r.hostPid && nodeAlive(r.hostPid)) treeKill(r.hostPid, 'leftover worker host from ' + f);
                    } catch { }
                }
            } catch { }
            try { rmSync(root, { recursive: true, force: true }); } catch { }
        });

        // ---- 1. spawn a worker through the REAL /spawn path -------------------------------------
        const hub1 = await startHub('first hub');
        const spawned = await (await fetch(ORIGIN + '/spawn', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd: REPO, purpose: 'survival probe' }),
        })).json();
        assert.ok(spawned.callsign, 'spawn returned no callsign: ' + JSON.stringify(spawned));
        const CS = spawned.callsign;
        const pidfile = join(DATA, 'worker-' + CS + '.pid');

        // The pidfile is the anti-fallback assert: only the pty-host path writes one, so its
        // existence proves the hub did not quietly open a wt tab instead.
        const rec = await waitFor('the pty-host pidfile (proves the ConPTY path, not a wt tab)',
            () => { try { const r = JSON.parse(readFileSync(pidfile, 'utf8')); return r.hostPid ? r : null; } catch { return null; } }, 20000);
        assert.ok(nodeAlive(rec.hostPid), 'pidfile names host ' + rec.hostPid + ' but no node process is there');
        await waitFor('the worker to register', async () => (await rosterRow(CS))?.alive, 30000);
        // launch:'pty' is what makes this row PROVABLE next restart rather than merely suspected.
        const preKill = await waitFor('the host pid and childPid to both be recorded',
            () => { const r = JSON.parse(readFileSync(pidfile, 'utf8')); return r.childPid ? r : null; }, 10000);
        assert.ok(nodeAlive(preKill.hostPid));

        // ---- 2. tree-kill the hub, exactly the way guardian.mjs recovers a wedged one ------------
        treeKill(hub1.pid, 'first hub');
        await waitFor('the hub port to stop answering', async () => {
            try { await get('/roster'); return false; } catch { return true; }
        }, 20000);
        // THE CLAIM. Before 13e3f8a the worker was a node-pty child of the hub and /T walked
        // straight into it; this is the assertion that used to be false.
        await sleep(1500);
        assert.ok(nodeAlive(preKill.hostPid), 'REGRESSION: the worker host died with its hub -- taskkill /F /T reached it, so the orphaning in orphan-spawn.mjs is not working');
        assert.ok(existsSync(pidfile), 'the pidfile went with the hub, so the next hub has no handle to re-adopt by');

        // ---- 3. a genuinely new hub re-adopts the survivor ---------------------------------------
        await startHub('second hub');
        await waitFor('boot reconcile to report a re-adoption', () => /boot reconcile: re-adopted 1 live worker/.test(transcript()), 20000);
        const readopted = await rosterRow(CS);
        assert.ok(readopted, CS + ' is missing from the roster after re-adoption');
        assert.ok(!/buried/.test(transcript().split('boot reconcile: re-adopted')[0] || ''), 'something was buried before the re-adoption ran');
        // Survived the grace window rather than being swept by the second pass.
        await sleep(8000);
        assert.ok((await rosterRow(CS))?.alive, CS + ' was buried or went quiet after the grace window -- the survivor did not reconnect to the new hub');
        // Reconnection is not just liveness: the poll loop must be talking to THIS hub.
        const seen1 = Date.parse((await rosterRow(CS)).lastSeen);
        await sleep(3000);
        assert.ok(Date.parse((await rosterRow(CS)).lastSeen) >= seen1, 'lastSeen is not advancing: the worker is alive but no longer reaching the hub');

        // ---- 4. and a worker whose host IS dead gets buried, with its pidfile collected ----------
        const live = JSON.parse(readFileSync(pidfile, 'utf8'));
        treeKill(live.hostPid, 'worker host');
        await waitFor('the host to be gone', () => !nodeAlive(live.hostPid), 15000);
        for (const h of hubs) if (h.pid && nodeAlive(h.pid)) treeKill(h.pid, 'hub');
        await startHub('third hub');
        // launch:'pty' + no host = provable, so this one is buried on the FIRST pass, no grace window.
        await waitFor('boot reconcile to bury the dead worker', () => new RegExp('boot reconcile: buried 1 ghost session\\(s\\) - ' + CS).test(transcript()), 20000);
        assert.equal(await rosterRow(CS), null, CS + ' is still listed as live after its host was killed -- this is the ghost-roster symptom the fix exists to remove');
        assert.match((await retiredRow(CS))?.summary || '', /hub restarted/, 'the ghost was dropped from the roster but not archived with a reason');
        // And Chris is TOLD. A roster that silently empties itself after a restart is indistinguishable
        // from the bug; the burial passes each speak one summary line rather than one per corpse.
        assert.ok(transcript().split('\n').some(l => /"kind":"tts"/.test(l) && /did not survive the restart/.test(l)),
            'the fleet was buried without a word spoken -- silence here reads as the ghost-roster bug, not as a fix');
        assert.ok(!existsSync(pidfile), 'the dead worker\'s pidfile was not collected; it would spare its worktree from the sweep forever');
    });
