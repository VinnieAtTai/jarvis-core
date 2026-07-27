// The orphaning intermediate.
//
// Why this file exists at all: guardian.mjs recovers a wedged hub with `taskkill /F /T` on the
// supervisor pid, and /T walks the ProcessId->ParentProcessId chain in the live process snapshot.
// Node's `detached:true` on Windows sets DETACHED_PROCESS (no console) but does NOT clear that
// parent field, so a worker spawned straight from the hub is still in the supervisor's tree and
// one guardian firing wipes the whole fleet. Measured, not assumed: a directly-detached child is
// killed and taskkill names it ("child process of <hub pid>"), while a child spawned through this
// file survives and keeps running.
//
// The trick is that we EXIT immediately. The process we launch is left pointing at a parent pid
// that no longer exists, so it is in nobody's tree and /T cannot reach it. Nothing else in here
// matters -- keep it dependency-free and keep it exiting.
//
// Usage: node orphan-spawn.mjs <script.mjs> [args...]
import { spawn } from 'node:child_process';

const [target, ...rest] = process.argv.slice(2);
if (!target) process.exit(2);

// stdio 'ignore' is deliberate: inheriting a pipe would keep a handle open to whoever spawned us
// and re-couple the lifetimes we just went to the trouble of severing.
const child = spawn(process.execPath, [target, ...rest], {
    detached: true, windowsHide: true, stdio: 'ignore',
});
child.unref();

// Hand the pid back on stdout for the rare synchronous caller. The hub does not read it -- it
// learns the real host pid from the pidfile the host writes -- but it costs nothing and makes
// this runnable by hand when debugging.
try { process.stdout.write(String(child.pid || 0)); } catch { }
process.exit(0);
