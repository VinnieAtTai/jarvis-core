import { spawn } from 'node:child_process';
import { openSync, existsSync, unlinkSync } from 'node:fs';
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
