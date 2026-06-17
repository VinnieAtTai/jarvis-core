import http from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Normalize an absolute path for case-insensitive, separator-agnostic prefix comparison (Windows).
function norm(p) { return resolve(String(p == null ? '' : p)).replace(/\\/g, '/').toLowerCase(); }

function out(decision, reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, ...(reason ? { permissionDecisionReason: reason } : {}) } }));
    process.exit(0);
}

// --- shell command classifier ----------------------------------------------
// 'safe'    read-only / known-harmless -> auto-allowed locally, no hub round trip, works offline
// 'danger'  destructive / outward / irreversible -> ALWAYS escalates; never fast-pathed by a
//           trust tier or timed trust (only an explicit Always pattern can ever waive it)
// 'neutral' unrecognized -> the hub decides (tier / timed-trust / Always-pattern / card)
const DANGER = [
    /\brm\b/, /\brmdir\b/, /\bdel\b/, /\berase\b/, /\bremove-item\b/, /\brd\s+\/s/,
    /\bgit\s+push\b/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-/, /\bgit\s+checkout\s+--/,
    /\bgit\s+rebase\b/, /\bgit\s+filter-/, /\bgit\s+commit\b/, /--force\b/, /\s-f\b.*\bpush\b/,
    /\bnpm\s+(install|i|ci|publish|update|uninstall|add)\b/, /\byarn\s+(add|install|remove|upgrade)\b/, /\bpnpm\s+(add|install|remove)\b/,
    /\bshutdown\b/, /\bformat\b/, /\bmkfs\b/, /\bdd\s+if=/, /\breg\s+(add|delete)\b/, /\bschtasks\b/,
    /\btaskkill\b/, /\bstop-process\b/, /\bkill\b/, /\bdiskpart\b/, /\bnet\s+(user|localgroup)\b/, /\bsetx\b/,
    /\bchmod\b/, /\bchown\b/, /\bicacls\b/, /\btakeown\b/, /:\(\)\s*\{/,
];
const SAFE = [
    /^git\s+(status|diff|log|show|branch|rev-parse|remote|describe|blame|ls-files|ls-tree|shortlog|whatchanged|tag|fetch|cat-file|name-rev|symbolic-ref|for-each-ref)\b/,
    /^git\s+stash\s+(list|show)\b/,
    /^git\s+config\s+--get\b/,
    /^(ls|dir|pwd|cd|cat|type|head|tail|less|more|wc|echo|printf|file|stat|du|df|tree|basename|dirname|realpath|readlink|env|whoami|hostname|date|uptime|uname|sleep|clear|cls)\b/,
    /^(rg|grep|egrep|fgrep|fd|ag|ack|find)\b/,
    /^node\s+(--check|-c|-v|--version)\b/,
    /^npm\s+(run\s+(lint|build|test[\w:-]*)|test|-v|--version|ls|list|outdated)\b/,
    /^npx\s+(eslint|stylelint|tsc|prettier)\b/,
    /^(ng\s+(lint|build|version)|tsc(\s+--noemit)?|eslint|stylelint|vitest|jest|karma)\b/,
    /^(dotnet\s+(build|test|--version|--info|--list-sdks)|msbuild)\b/,
    /^(where|which|whereis|get-command|get-childitem|gci|get-content|gc|test-path|resolve-path|select-string|measure-object|get-location|gl|get-date|get-process|get-item|gi)\b/,
    /^(git|node|npm|dotnet|python|python3|pip)\s+(--version|-v|--help|-h)\b/,
    /^(curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b.*(127\.0\.0\.1|localhost)/,
];
// These flip an otherwise-safe verb back to neutral (e.g. `find ... -delete`).
const SAFE_VETO = [/-delete\b/, /-exec\b/];

function classifyOne(seg) {
    const s = seg.trim().replace(/^(sudo|time|nice|env)\s+/i, '').replace(/^(\w+=\S+\s+)+/, '');
    if (!s) return 'safe';
    const low = s.toLowerCase();
    if (DANGER.some(r => r.test(low))) return 'danger';
    if (SAFE.some(r => r.test(low)) && !SAFE_VETO.some(r => r.test(low))) return 'safe';
    return 'neutral';
}
// A chain is as risky as its riskiest segment: danger if any segment is danger, safe only if
// every segment is safe, neutral otherwise.
function classify(cmd) {
    const segs = String(cmd).split(/&&|\|\||;|\|/).map(x => x.trim()).filter(Boolean);
    if (!segs.length) return 'neutral';
    let worst = 'safe';
    for (const seg of segs) {
        const c = classifyOne(seg);
        if (c === 'danger') return 'danger';
        if (c === 'neutral') worst = 'neutral';
    }
    return worst;
}

let ev = {};
try { ev = JSON.parse(readFileSync(0, 'utf8')); } catch { }
const tool = ev.tool_name || '';
const input = ev.tool_input || {};
const cs = (process.env.JARVIS_CALLSIGN || '').toLowerCase();
const port = Number(process.env.JARVIS_PORT || 8124);

if (!cs) out('ask');

const isShell = tool === 'Bash' || tool === 'PowerShell';
const isWrite = tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit';
let detail = '';
if (isShell) detail = input.command || '';
else if (isWrite) detail = input.file_path || input.notebook_path || '';
else detail = JSON.stringify(input).slice(0, 200);

// The worker's lifeline to the hub is always allowed.
if (isShell && (detail.includes('127.0.0.1:' + port) || detail.includes('localhost:' + port))) out('allow');

// A worker owns its own repo: auto-allow file writes inside its cwd. Writes that ESCAPE the
// cwd (the hub's source, another repo) fall through to the hub gate as 'neutral'.
if (isWrite) {
    const fp = input.file_path || input.notebook_path;
    if (fp) {
        const cwd = norm(ev.cwd || process.cwd());
        const target = norm(fp);
        if (cwd && (target === cwd || target.startsWith(cwd + '/'))) out('allow', 'write within worker cwd');
    }
}

// Classify shell commands; safe ones (the ~80%: status/diff/lint/build/ls/cat/grep) auto-allow
// here with no hub round trip and even when the hub is down. Everything else asks the hub.
let klass = 'neutral';
if (isShell) {
    klass = classify(detail);
    if (klass === 'safe') out('allow', 'read-only/safe command');
}

const body = JSON.stringify({ callsign: cs, tool, detail, klass });
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
