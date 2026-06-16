import http from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Normalize an absolute path for case-insensitive, separator-agnostic prefix comparison (Windows).
function norm(p) { return resolve(String(p == null ? '' : p)).replace(/\\/g, '/').toLowerCase(); }

function out(decision, reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, ...(reason ? { permissionDecisionReason: reason } : {}) } }));
    process.exit(0);
}

let ev = {};
try { ev = JSON.parse(readFileSync(0, 'utf8')); } catch { }
const tool = ev.tool_name || '';
const input = ev.tool_input || {};
const cs = (process.env.JARVIS_CALLSIGN || '').toLowerCase();
const port = Number(process.env.JARVIS_PORT || 8124);

if (!cs) out('ask');
let detail = '';
if (tool === 'Bash') detail = input.command || '';
else if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') detail = input.file_path || '';
else detail = JSON.stringify(input).slice(0, 200);

if (tool === 'Bash' && (detail.includes('127.0.0.1:' + port) || detail.includes('localhost:' + port))) out('allow');
// Auto-allow file writes ONLY inside the worker's own cwd; gate writes that escape it (a
// worker shouldn't silently overwrite the hub's source or files in another repo). Out-of-cwd
// writes fall through to the hub /permission gate below instead of being rubber-stamped.
if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    const fp = input.file_path;
    if (fp) {
        const cwd = norm(ev.cwd || process.cwd());
        const target = norm(fp);
        if (cwd && (target === cwd || target.startsWith(cwd + '/'))) out('allow', 'write within worker cwd');
    }
}

const body = JSON.stringify({ callsign: cs, tool, detail });
const req = http.request({ host: '127.0.0.1', port, path: '/permission', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
    let d = '';
    res.on('data', c => (d += c));
    res.on('end', () => {
        let r = {};
        try { r = JSON.parse(d); } catch { }
        if (r.decision === 'allow') out('allow', 'Approved in JARVIS hub');
        else if (r.decision === 'deny') out('deny', 'Denied in JARVIS hub');
        else out('ask');
    });
});
req.on('error', () => out('ask'));
req.setTimeout(590000, () => { try { req.destroy(); } catch { } out('ask'); });
req.write(body);
req.end();
