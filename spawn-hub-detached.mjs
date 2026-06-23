import { spawn } from 'node:child_process';
import { openSync, existsSync, unlinkSync, writeFileSync, readFileSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Console-less supervisor for the JARVIS hub.
//
// Root cause of the recurring "everything crashed": the hub ran inside a console (the cmd
// watchdog window). Combining DOS/console windows in Windows tears down the console and fires
// CTRL_CLOSE/SIGHUP across every process attached to it -- node's signal handlers can ignore the
// signal but cannot survive its console being destroyed, so it died anyway (watchdog.log: SIGHUP
// "staying up" immediately followed by ^C).
//
// Fix: launch with DETACHED_PROCESS (Node `detached:true` on Windows), so the hub has NO console.
// A console event has nothing to deliver to. Stage 1 re-launches this file as a detached,
// console-less supervisor and exits; Stage 2 is the supervisor loop (its children inherit its
// lack of a console) that keeps the hub up across hard exits, the same job the cmd watchdog did.

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DATA = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'jarvis') : HERE;
const LOG = join(DATA, 'watchdog.log');
const STOP = join(DATA, 'STOP');
const LOCK = join(DATA, 'supervisor.lock');
const ENV = { ...process.env, JARVIS_REAL_USAGE: '1', JARVIS_LINK_EMAIL: 'chris.vinciguerra@tai-software.com' };
const ts = () => new Date().toISOString();

if (process.env.JARVIS_SUPERVISOR !== '1') {
    const out = openSync(LOG, 'a');
    const child = spawn(process.execPath, [SELF], {
        cwd: HERE, detached: true, windowsHide: true,
        stdio: ['ignore', out, out],
        env: { ...ENV, JARVIS_SUPERVISOR: '1' },
    });
    child.unref();
    console.log('jarvis supervisor detached (console-less), pid ' + child.pid);
    process.exit(0);
}

// --- Singleton guard (Stage 2 only) -----------------------------------------------------------
// Without this, every `node spawn-hub-detached.mjs` spawns ANOTHER detached supervisor, and each
// supervisor races to spawn a hub on the same port. The loser used to hang forever at listen()
// (see jarvis-core.mjs), leaving wedged orphan supervisor+hub pairs that accumulate silently.
// Allow exactly one live supervisor: the lockfile holds the owner's pid; a 2nd supervisor that
// finds a LIVE owner bows out. A stale lock (owner dead) is taken over.
function pidAlive(pid) {
    if (!pid || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireSingleton() {
    try {
        const fd = openSync(LOCK, 'wx'); // atomic create; throws EEXIST if a lock is already there
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        return true;
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let owner = 0;
        try { owner = parseInt(String(readFileSync(LOCK, 'utf8')).trim(), 10) || 0; } catch { }
        if (pidAlive(owner)) return false;             // a live supervisor already owns it
        try { writeFileSync(LOCK, String(process.pid)); } catch { } // stale lock -> take it over
        return true;
    }
}
if (!acquireSingleton()) {
    process.stdout.write('[supervisor] another supervisor already owns ' + LOCK + ' -> exiting\n');
    process.exit(0);
}
process.on('exit', () => {
    try { if (parseInt(String(readFileSync(LOCK, 'utf8')).trim(), 10) === process.pid) unlinkSync(LOCK); } catch { }
});

let running = true;
async function loop() {
    while (running) {
        process.stdout.write('===== supervisor launch ' + ts() + ' (console-less) =====\n');
        const code = await new Promise((res) => {
            const c = spawn(process.execPath, ['jarvis-core.mjs'], {
                cwd: HERE, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], env: ENV,
            });
            c.on('exit', (x) => res(x));
            c.on('error', () => res(-1));
        });
        if (existsSync(STOP)) { try { unlinkSync(STOP); } catch { } process.stdout.write('[supervisor] STOP sentinel -> stopping for the night\n'); break; }
        process.stdout.write('[supervisor] hub exited (' + code + ') -> relaunch in 2s\n');
        await new Promise((r) => setTimeout(r, 2000));
    }
}
loop();
