// Per-worker ConPTY host.
//
// A console-less worker used to be a node-pty child of the hub itself, which made the hub's
// lifetime the worker's lifetime: a deliberate restart, a hub crash, or guardian.mjs firing
// `taskkill /F /T` on the supervisor all took the whole fleet with them. The console's own
// Restart tooltip promised "live sessions survive" and had been lying since console-less
// spawning became the default.
//
// So the ConPTY moves out here, into a process the hub launches through orphan-spawn.mjs and
// then forgets about. The host outlives the hub; the hub re-adopts it on the way back up by
// reading the pidfile this file writes.
//
// ONE HOST PER WORKER, and no IPC back to the hub. That is affordable because the hub never
// actually wrote to a worker's pty -- its only uses were appending the log and killing on
// retire. The log this file keeps appending covers the first, and the pidfile covers the
// second (the hub kills the recorded host pid, and claude really is this process's child, so
// a /T off that pid is both correct and tightly scoped). A shared multiplexing daemon would
// need a protocol, a reconnect story, and a restart story of its own to buy nothing.
//
// Usage: node pty-host.mjs <configPath>
//
// The config is a FILE, and deliberately so. The worker boot prompt is a paragraph containing
// quotes, semicolons and URLs, and this codebase has twice lost launch config in transit
// (a757af9, 2273b18). Adding a process hop would have widened that blast radius; passing a
// path instead means the prompt never touches a command line again.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';

const requireCjs = createRequire(import.meta.url);
const configPath = process.argv[2];
if (!configPath) process.exit(2);

const rm = (p) => { try { if (p) unlinkSync(p); } catch { } };

let cfg;
try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); }
catch { rm(configPath); process.exit(2); }
// Read once, then gone. The config carries the full worker boot prompt, and JARVIS_DATA is not
// the place to accumulate a transcript of every brief the hub has ever handed out. Everything
// re-adoption needs later lives in the pidfile instead.
rm(configPath);

// The pidfile IS the hub's handle on this worker across a restart, so it is written BEFORE the
// pty is spawned and rewritten with the child pid straight after. A host that dies between the
// two leaves a record the hub can still identify and clean up, rather than an invisible orphan.
// `spawnedAt` is the original spawn time and survives re-adoption, so booting-state staleness is
// measured against when the worker actually started, not when the hub came back.
function writePidfile(extra) {
    try {
        writeFileSync(cfg.pidfile, JSON.stringify({
            cs: cfg.cs,
            hostPid: process.pid,
            cwd: cfg.cwd || '',
            project: cfg.project || null,
            parentProject: cfg.parentProject || null,
            // The worktree this worker was isolated into. Carried here because it lives only in hub
            // memory (pendingWorktree) until the worker registers: without it, a worker that is
            // still booting when the hub restarts registers with no worktree on its session row,
            // and an unclaimed directory is exactly what the sweep eats.
            worktree: cfg.worktree || null,
            spawnedAt: cfg.spawnedAt || new Date().toISOString(),
            ...extra,
        }, null, 1));
    } catch { }
}

function cleanup() {
    rm(cfg.pidfile);
}

writePidfile({ childPid: 0 });

let pty;
try { pty = requireCjs('node-pty'); }
catch (e) {
    // The hub probes for node-pty before choosing this path, so getting here means the module
    // resolved there and not here. Leave the reason on disk -- with no console and no IPC, a
    // log line is the only way this failure is ever explicable.
    try { appendFileSync(cfg.log, '\n[pty-host] node-pty unavailable: ' + (e && e.message) + '\n'); } catch { }
    cleanup();
    process.exit(3);
}

try { writeFileSync(cfg.log, ''); } catch { }

const proc = pty.spawn(cfg.claude, cfg.args || [], {
    name: 'xterm-color', cols: 140, rows: 40,
    cwd: cfg.cwd,
    env: { ...process.env, ...(cfg.env || {}) },
});

writePidfile({ childPid: proc.pid });

proc.onData((d) => { try { appendFileSync(cfg.log, d); } catch { } });

// When claude exits -- retired, crashed, or killed -- this host has nothing left to own, so it
// goes with it. Clearing the pidfile on the way out is what keeps boot re-adoption honest: a
// pidfile that still exists means a worker that is still up.
proc.onExit(({ exitCode }) => {
    try { appendFileSync(cfg.log, '\n[pty-host] worker exited (' + exitCode + ')\n'); } catch { }
    cleanup();
    process.exit(0);
});

// A hub kill arrives as taskkill /F, which is not catchable, so these only cover the polite
// paths. Cleanup is idempotent and boot re-adoption treats a live pid as authoritative over a
// stale file anyway, so a pidfile that outlives its host is recoverable either way.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    try { process.on(sig, () => { try { proc.kill(); } catch { } cleanup(); process.exit(0); }); } catch { }
}
process.on('exit', cleanup);
