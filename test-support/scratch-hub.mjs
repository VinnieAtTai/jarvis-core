// A throwaway JARVIS hub, on its own port and its own data dir, for tests and sessions that need to
// exercise the real server rather than a pure function.
//
// WHY THIS EXISTS. Four sessions have now hand-rolled this rig -- alpha, yankee, papa and me -- and
// the copies did not agree. alpha's drifted onto the visible wt-tab path, so its run went green
// without ever entering the console-less code it was written to verify; mine hardcoded a port and
// collided with a concurrent run. Both failures are the same shape: a rig that quietly tests
// something other than what you think it does. So the guarantees are enforced here, once, instead of
// being re-remembered per copy.
//
// WHY NOT IN test/. `node --test` matches `**/test/**/*.?(c|m)js` -- EVERY .mjs under test/, not just
// *.test.mjs. A helper placed there is loaded, has its top-level code executed, and is counted as a
// passing test file. Measured, not assumed: a two-line probe under test/ took the suite from 301 to
// 302 "passing". Hence test-support/, which also makes the CLI at the bottom safe to add.
//
// Use from a test:
//     import { createScratchHub, assertConsolelessPossible } from '../test-support/scratch-hub.mjs';
//     assertConsolelessPossible();                       // refuse a run that would prove nothing
//     const hub = await createScratchHub();
//     try { await hub.start('first hub'); ... } finally { hub.dispose(); }
//
// Use from a session that wants a real hub to poke by hand:
//     node test-support/scratch-hub.mjs --hold 180
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The port the real hub owns. Nothing here may ever touch it: a rig that points at the live hub
// spawns REAL workers into Chris's roster, and that is the one failure mode worse than a false pass.
export const LIVE_PORT = 8124;

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A git worktree has no node_modules of its own, so `node-pty` does not resolve from one and the hub
// SILENTLY falls back to visible wt tabs -- terminal windows appear, console-less spawning never
// happens, and the tests stay green while testing nothing. That cost alpha three runs on 2026-07-27.
// `git rev-parse --git-common-dir` points at the MAIN checkout's .git even from a worktree, so its
// parent is where node_modules actually lives.
export function resolveNodeModules() {
    const local = join(REPO_ROOT, 'node_modules');
    if (existsSync(join(local, 'node-pty'))) return local;
    try {
        const common = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            { encoding: 'utf8', timeout: 8000 }).trim();
        if (common) {
            const cand = join(dirname(common.replace(/\\/g, '/').replace(/\/+$/, '')), 'node_modules');
            if (existsSync(join(cand, 'node-pty'))) return cand;
        }
    } catch { }
    return local;
}
// Call this FIRST in any test whose subject is console-less spawning. Failing loudly here is the
// whole point: without it the run degrades to the wt-tab path and every later assertion passes for
// the wrong reason.
export function assertConsolelessPossible() {
    const nm = resolveNodeModules();
    try { createRequire(join(nm, 'x.js'))('node-pty'); }
    catch (e) {
        throw new Error('node-pty will not load from ' + nm + ' -- the hub would silently fall back to '
            + 'visible wt tabs and the run would prove nothing about console-less spawning. '
            + 'Running from a git worktree? Point NODE_PATH at the main checkout, or npm install there. ' + e.message);
    }
    return nm;
}

// A recorded pid is only interesting if a node process is still behind it. Same check the hub uses
// (hostAlive), and deliberately narrower than process.kill(pid,0), which pid reuse can fool.
export function nodeAlive(pid) {
    if (!pid) return false;
    try { return /node\.exe/i.test(execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { encoding: 'utf8', timeout: 8000 })); }
    catch { return false; }
}
// Never kill a pid that is not a live node process. Callers pass pids they spawned or read out of a
// scratch pidfile; this is the backstop against a stale number reaching taskkill.
export function treeKill(pid, what = 'process') {
    if (!nodeAlive(pid)) return false;
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 10000 }); }
    catch { return false; }
    return true;
}

export async function waitFor(label, fn, timeoutMs = 30000, everyMs = 400) {
    const until = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
        try { const v = await fn(); if (v) return v; last = null; }
        catch (e) { last = e; }
        if (Date.now() > until) {
            throw new Error('timed out after ' + timeoutMs + 'ms waiting for ' + label + (last ? ' (last error: ' + last.message + ')' : ''));
        }
        await sleep(everyMs);
    }
}

// Probing a port and then handing the number to someone else is check-then-act: two concurrent runs
// both see it free and both claim it, which is exactly the EADDRINUSE echo hit on a hardcoded 8177.
// Two defences. Here, start the scan at a pid-derived offset so concurrent runs do not walk the same
// range. And in start(), treat a collision as recoverable rather than a failed test -- jarvis-core
// exits with code 3 specifically on EADDRINUSE, so the real signal is available and worth using.
async function probeFreePort() {
    const base = 8300 + ((process.pid * 7) % 600);
    for (let i = 0; i < 80; i++) {
        const p = base + i;
        if (p === LIVE_PORT) continue;
        const ok = await new Promise(r => {
            const s = createServer();
            s.once('error', () => r(false));
            s.listen(p, '127.0.0.1', () => s.close(() => r(true)));
        });
        if (ok) return p;
    }
    throw new Error('no free port found near ' + base);
}

// The stub that stands in for claude. resolveClaude() searches PATH for claude.exe/.cmd/.bat, so
// putting this at the front of PATH diverts the real spawn path onto it without touching hub code.
//
// It deliberately does NOT forward %* -- the boot prompt is a paragraph of quotes, semicolons and
// URLs, and everything the stub needs (callsign, port) arrives in the environment that pty-host.mjs
// sets. Forwarding it would add a cmd.exe quoting hazard to tests whose subject is something else.
const STUB_WORKER = `
const base = 'http://127.0.0.1:' + process.env.JARVIS_PORT;
const cs = process.env.JARVIS_CALLSIGN;
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let uid = null;
(async () => {
    while (!uid) {
        try { const r = await post('/register', { cwd: process.cwd(), purpose: 'scratch stub', pin: cs }); uid = r && r.uid; } catch {}
        if (!uid) await sleep(1000);
    }
    let cur = 0;
    for (;;) {
        try {
            const r = await (await fetch(base + '/poll?uid=' + uid + '&cursor=' + cur)).json();
            if (r && r.error === 'retired') process.exit(0);
            if (r && typeof r.cursor === 'number') cur = r.cursor;
            if (r && r.events && r.events.some(e => e.kind === 'retired')) process.exit(0);
        } catch { await sleep(1000); }   // the hub is down: keep breathing, that is usually the point
    }
})();
`;

/**
 * Boot-ready scratch hub. Nothing is started until you call start().
 *
 * opts.graceMs   JARVIS_READOPT_GRACE_MS for the hub (default 5000; the real default is 90s).
 * opts.worktrees pass true to leave worktree isolation ON (default OFF -- it is a separate subject).
 * opts.env       extra env for the hub, applied last. Cannot override the safety forcings below.
 */
export async function createScratchHub(opts = {}) {
    const nodeModules = resolveNodeModules();
    const root = mkdtempSync(join(tmpdir(), 'jarvis-scratch-'));
    const DATA = join(root, 'data'), BIN = join(root, 'bin'), REPO = join(root, 'repo'), LAD = join(root, 'localappdata');
    for (const d of [DATA, BIN, REPO, LAD]) mkdirSync(d, { recursive: true });

    // The guard that matters most. Two scratch hubs cannot collide with each other -- each has its
    // own JARVIS_DATA -- so the disaster is not collision, it is a rig that points at the LIVE hub
    // and spawns real workers into the real roster. Refuse to be that rig.
    const ambientData = process.env.JARVIS_DATA || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'jarvis') : REPO_ROOT);
    if (DATA === ambientData) throw new Error('scratch data dir resolved to the LIVE data dir (' + DATA + ')');

    writeFileSync(join(BIN, 'claude.cmd'), '@echo off\r\nnode "%~dp0stub-worker.mjs"\r\n');
    writeFileSync(join(BIN, 'stub-worker.mjs'), STUB_WORKER);

    let PORT = await probeFreePort();
    const hubs = [];
    let disposed = false;

    const api = {
        root, DATA, BIN, REPO, nodeModules, hubs,
        get port() { return PORT; },
        get origin() { return 'http://127.0.0.1:' + PORT; },

        // The forcings are applied AFTER opts.env deliberately: a caller must not be able to turn off
        // console-less spawning, open a Playwright window, or aim the rig at the live port by passing
        // env through. Those are the guarantees this helper exists to make.
        hubEnv() {
            const e = {
                ...process.env,
                NODE_PATH: nodeModules,
                PATH: BIN + ';' + process.env.PATH,
                JARVIS_READOPT_GRACE_MS: String(opts.graceMs ?? 5000),
                JARVIS_REAL_USAGE: '',
                ...(opts.env || {}),
            };
            e.JARVIS_DATA = DATA;
            e.LOCALAPPDATA = LAD;         // keeps the real console's chrome profile out of it
            e.JARVIS_PORT = String(PORT);
            e.JARVIS_NO_UI = '1';         // no Playwright window
            e.JARVIS_CONSOLELESS = '1';   // the thing rigs keep accidentally turning off
            e.JARVIS_WORKTREES = opts.worktrees ? '1' : '0';
            return e;
        },

        // Starts a hub and resolves once it has printed JARVIS CORE READY. A port collision with a
        // concurrent run is retried on a fresh port rather than failing the caller -- jarvis-core
        // exits 3 on EADDRINUSE, which makes the retry precise instead of a guess.
        async start(label = 'hub', { retries = 3 } = {}) {
            for (let attempt = 0; ; attempt++) {
                const p = spawn(process.execPath, ['jarvis-core.mjs'], {
                    cwd: REPO_ROOT, env: api.hubEnv(), stdio: ['ignore', 'pipe', 'pipe'],
                });
                let out = '';
                p.stdout.on('data', d => { out += d; });
                p.stderr.on('data', d => { out += d; });
                hubs.push(p);
                try {
                    await waitFor(label + ' to print JARVIS CORE READY', () => {
                        if (p.exitCode !== null) {
                            const err = new Error('hub exited ' + p.exitCode + ': ' + out.slice(-500));
                            err.exitCode = p.exitCode;
                            throw err;
                        }
                        return /JARVIS CORE READY/.test(out);
                    }, 45000);
                    return p;
                } catch (e) {
                    hubs.pop();
                    const collided = p.exitCode === 3 || /EADDRINUSE/i.test(out);
                    if (!collided || attempt >= retries) throw e;
                    PORT = await probeFreePort();   // another run took it between probe and bind
                }
            }
        },

        currentHub: () => hubs[hubs.length - 1] || null,
        // Tree-kill, the way guardian.mjs recovers a wedged hub. This is what a restart-resilience
        // test needs: anything that must survive it has to be outside the hub's process tree.
        killHubs() { let n = 0; for (const h of hubs) if (h.pid && treeKill(h.pid, 'scratch hub')) n++; return n; },
        async waitHubDown(timeoutMs = 20000) {
            return waitFor('the hub port to stop answering', async () => {
                try { await api.get('/roster'); return false; } catch { return true; }
            }, timeoutMs);
        },

        get: async (path) => (await fetch(api.origin + path)).json(),
        post: async (path, body) => (await fetch(api.origin + path, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })).json(),

        // Drives the REAL /spawn path, so everything downstream of it is under test.
        async spawnWorker({ cwd = REPO, purpose = 'scratch probe', ...rest } = {}) {
            const r = await api.post('/spawn', { cwd, purpose, ...rest });
            if (!r || !r.callsign) throw new Error('/spawn returned no callsign: ' + JSON.stringify(r));
            return r.callsign;
        },

        // /roster answers {focus, live, retired}: `live` is every unended session and `alive` within
        // it is the heartbeat test, while a buried session leaves `live` and turns up in `retired`.
        live: async (cs) => (await api.get('/roster')).live.find(r => r.callsign === cs) || null,
        retired: async (cs) => (await api.get('/roster')).retired.find(r => r.callsign === cs) || null,
        transcript() { try { return readFileSync(join(DATA, 'transcript.jsonl'), 'utf8'); } catch { return ''; } },
        spoke(re) { return api.transcript().split('\n').some(l => /"kind":"tts"/.test(l) && re.test(l)); },

        pidfile: (cs) => join(DATA, 'worker-' + cs + '.pid'),
        // The anti-fallback observable: ONLY the pty-host path writes a pidfile, so its presence is
        // proof the hub did not quietly open a wt tab instead.
        hostRecord(cs) {
            try { const r = JSON.parse(readFileSync(api.pidfile(cs), 'utf8')); return r.hostPid ? r : null; }
            catch { return null; }
        },
        waitFor,

        // Teardown has to be thorough in a way most teardowns do not, because what these rigs create
        // is a process deliberately spawned outside every process tree so that killing its parent
        // cannot reach it. A missed host is not a stray child that dies with the runner -- it is an
        // orphan holding a ConPTY forever, and the only record of its pid is in the directory this is
        // about to delete. So sweep every pidfile actually present; never guess at callsigns.
        dispose() {
            if (disposed) return;
            disposed = true;
            api.killHubs();
            try {
                for (const f of readdirSync(DATA)) {
                    if (!/^worker-.+\.pid$/i.test(f)) continue;
                    try {
                        const r = JSON.parse(readFileSync(join(DATA, f), 'utf8'));
                        if (r.hostPid) treeKill(r.hostPid, 'leftover worker host from ' + f);
                    } catch { }
                }
            } catch { }
            try { rmSync(root, { recursive: true, force: true }); } catch { }
        },
    };
    return api;
}

// CLI, for a session that wants a real hub to curl at by hand instead of writing a test. Safe to
// have here only because test-support/ is outside the paths `node --test` collects -- the same file
// under test/ would run this during the suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const holdArg = process.argv.indexOf('--hold');
    const holdSec = holdArg > -1 ? Number(process.argv[holdArg + 1]) || 120 : 120;
    assertConsolelessPossible();
    const hub = await createScratchHub();
    // Tear down on the way out however we leave, so a hand-driven rig cannot strand an orphaned host.
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { hub.dispose(); process.exit(0); });
    process.on('exit', () => hub.dispose());
    await hub.start('scratch hub');
    console.log('scratch hub  -> ' + hub.origin);
    console.log('  data dir   -> ' + hub.DATA);
    console.log('  spawn cwd  -> ' + hub.REPO + '   (claude is a stub; workers register and poll, nothing else)');
    console.log('  holding ' + holdSec + 's, then tearing down. Ctrl-C also tears down.');
    await sleep(holdSec * 1000);
    console.log('tearing down.');
}
