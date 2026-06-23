import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// OS-level guardian for the JARVIS hub. A Windows Scheduled Task runs this every minute, OUTSIDE the
// node process tree, so it survives the in-node supervisor itself wedging or dying (which it has,
// twice). If the hub is down and it was NOT a deliberate wind-down, it kills any wedged supervisor
// still holding the singleton lock (otherwise a fresh supervisor bows out to it) and relaunches a
// clean one. This is the safety net the in-node supervisor fundamentally cannot be.

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8124;
const DATA = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'jarvis') : HERE;
const LOCK = join(DATA, 'supervisor.lock');
const STOP = join(DATA, 'STOP');
const GLOG = join(DATA, 'guardian.log');

function log(msg) { try { appendFileSync(GLOG, new Date().toISOString() + ' ' + msg + '\n'); } catch { } }

function probe() {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: '/heartbeat', timeout: 2500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pidAlive(pid) {
    if (!pid) return false;
    try { return /node\.exe/i.test(execSync('tasklist /FI "PID eq ' + pid + '" /NH', { encoding: 'utf8' })); }
    catch { return false; }
}

(async () => {
    if (await probe()) return;                                   // hub healthy — nothing to do
    if (existsSync(STOP)) { log('down + STOP sentinel — deliberate wind-down, leaving it'); return; }
    await sleep(15000);                                          // ride out a normal supervisor relaunch (~2-3s)
    if (await probe()) return;                                   // recovered on its own
    if (existsSync(STOP)) { log('STOP appeared during recheck — leaving it'); return; }
    // Genuinely down >15s. Any supervisor that exists is not doing its job — kill it so a fresh one
    // does not bow out to its still-held singleton lock, then relaunch clean.
    let note = '';
    try {
        if (existsSync(LOCK)) {
            const pid = parseInt(String(readFileSync(LOCK, 'utf8')).trim(), 10) || 0;
            if (pid && pidAlive(pid)) { try { execSync('taskkill /F /PID ' + pid); note = ' (killed wedged supervisor ' + pid + ')'; } catch { } }
            try { unlinkSync(LOCK); } catch { }
        }
    } catch { }
    const child = spawn(process.execPath, [join(HERE, 'spawn-hub-detached.mjs')], { cwd: HERE, detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    log('hub was down >15s — relaunched supervisor' + note);
})();
