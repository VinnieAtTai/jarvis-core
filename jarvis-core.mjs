import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { captureScreen } from './screen.mjs';
import { scanUsage, totalsOf, blockStats, burnOf, heatOf } from './tokens.mjs';
import { fetchRealUsage } from './usage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.JARVIS_DATA || HERE;
const USER_DATA = process.env.CHROME_USER_DATA || join(HERE, 'chrome-profile');
const TRANSCRIPT = join(DATA, 'transcript.jsonl');
const SAY = join(DATA, 'say.txt');
const CMD = join(DATA, 'commands.txt');
const WORKLIST = join(DATA, 'worklist.json');
const SESSIONS = join(DATA, 'sessions.json');
const BUS = join(DATA, 'bus.jsonl');
const REPOS = join(DATA, 'repos.json');
const ARCHIVE = join(DATA, 'archive');
const WORKER_DOC = join(HERE, 'WORKER.md');
const PORT = Number(process.env.JARVIS_PORT || 8124);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NO_UI = !!process.env.JARVIS_NO_UI;
const PROJECTS = process.env.JARVIS_PROJECTS || join(process.env.USERPROFILE || '', '.claude', 'projects');
const NATO = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];

mkdirSync(DATA, { recursive: true });
mkdirSync(ARCHIVE, { recursive: true });
writeFileSync(SAY, '');
writeFileSync(CMD, '');
if (!existsSync(TRANSCRIPT)) writeFileSync(TRANSCRIPT, '');
if (!existsSync(BUS)) writeFileSync(BUS, '');
if (!existsSync(REPOS)) writeFileSync(REPOS, '{}\n');
if (!existsSync(SESSIONS)) writeFileSync(SESSIONS, JSON.stringify({ callsigns: {}, sessions: {}, nextUid: 1 }, null, 1));
if (!existsSync(WORKLIST)) writeFileSync(WORKLIST, JSON.stringify({ focus: 'jarvis', sessions: { jarvis: { working: [], queued: [], done: [] } } }, null, 1));

const CONSOLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>JARVIS core</title><style>
body{background:#0b0f14;color:#d7e3f0;font:14px/1.5 Consolas,monospace;margin:0;padding:16px}
#status{font-size:22px;font-weight:bold;padding:10px 14px;border-radius:8px;background:#16202c;margin-bottom:12px}
#status.listening{color:#5dd97c}#status.speaking{color:#5db4d9}#status.muted{color:#d9a05d}#status.error{color:#e06c6c}
#interim{color:#7a8a9c;min-height:1.5em;margin-bottom:8px;font-style:italic}
#main{display:flex;gap:20px;align-items:flex-start}
#left{flex:3;min-width:0}
#bar{display:flex;gap:8px;margin-top:6px;align-items:center}
.btn{background:#16202c;border:1px solid #1f2c3a;color:#7a8a9c;border-radius:6px;padding:2px 10px;font:12px Consolas,monospace;cursor:pointer}
.btn.on{color:#5db4d9;border-color:#5db4d9}
#chat{display:flex;flex-direction:column;gap:6px;overflow-y:auto;height:76vh;background:#0d1420;border:1px solid #1f2c3a;border-radius:8px;padding:12px}
#rawlog{display:none;overflow-y:auto;height:76vh;background:#0d1420;border:1px solid #1f2c3a;border-radius:8px;padding:12px;font-size:12px;color:#9bb0c4}
#rawlog b{color:#5db4d9}
.row{display:flex}.row.me{justify-content:flex-end}
.bubble{max-width:70%;padding:7px 11px;border-radius:12px;border-bottom-left-radius:4px;white-space:pre-wrap;word-break:break-word;font-size:13px;background:#1a2533}
.me .bubble{background:#1d4567;border-bottom-left-radius:12px;border-bottom-right-radius:4px}
.chip{font-size:10px;color:#5db4d9;letter-spacing:1px}
.t{font-size:10px;color:#7a8a9c;margin-left:10px;white-space:nowrap}
.divider{text-align:center;color:#d9a05d;font-size:11px;margin:2px 0}
#work{flex:2;background:#101822;border:1px solid #1f2c3a;border-radius:8px;padding:12px;position:sticky;top:8px;max-height:90vh;overflow-y:auto}
.bhead{font-weight:bold;font-size:13px;letter-spacing:1px;margin:12px 0 2px;color:#d7e3f0;border-bottom:1px solid #1f2c3a;padding-bottom:2px}
.bhead.focused{color:#5db4d9}
.bhead.dead{color:#566270}
.bpurpose{font-weight:normal;color:#7a8a9c;font-size:11px;letter-spacing:0}
.wtitle{font-weight:bold;letter-spacing:1px;font-size:12px;margin:8px 0 2px}
.wtitle.working{color:#e8c35a}.wtitle.queued{color:#7a8a9c}.wtitle.done{color:#5dd97c}
.witem{padding:3px 0 3px 6px;font-size:13px;border-left:2px solid transparent}
.witem.working{color:#f0e0b0;border-left-color:#e8c35a}
.witem.queued{color:#9bb0c4}
.witem.done{color:#6f9b7e;text-decoration:line-through}
</style></head><body>
<div id="status"><span id="stext">starting…</span><span id="heat" style="float:right;font-size:14px;font-weight:normal;color:#7a8a9c"></span></div>
<div id="interim"></div>
<div id="main">
<div id="left">
<div id="chat"></div>
<div id="rawlog"></div>
<div id="bar"><button class="btn" id="bexp">EXPAND (t)</button><button class="btn" id="braw">RAW (r)</button><span id="jump" class="btn" style="display:none">&#8595; latest</span></div>
</div>
<div id="work"></div>
</div>
<script>
const statusEl = document.getElementById('status');
const interimEl = document.getElementById('interim');
const chatEl = document.getElementById('chat');
const rawEl = document.getElementById('rawlog');
const workEl = document.getElementById('work');
const jumpEl = document.getElementById('jump');
const bexp = document.getElementById('bexp');
const braw = document.getElementById('braw');
let speaking = false, stopped = false;
let expanded = false, rawMode = false, pinned = true;
let focusCS = 'jarvis', chatEvts = [], lastChatPayload = '';
let lastTokens = null;

function fmtTok(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
}
function renderHeat() {
    const parts = [];
    if (lastTokens) parts.push(lastTokens.heat.icon + ' ' + lastTokens.heat.label + ' · ' + fmtTok(lastTokens.burn) + ' tok/hr');
    if (lastTokens && typeof lastTokens.sessionPct === 'number') parts.push('session ' + lastTokens.sessionPct + '%');
    if (lastTokens && lastTokens.resetAt) {
        const ms = Date.parse(lastTokens.resetAt) - Date.now();
        if (ms > 0) {
            const h = Math.floor(ms / 3600000), mn = Math.ceil((ms % 3600000) / 60000);
            parts.push('reset ' + (h ? h + 'h' : '') + mn + 'm');
        }
    }
    document.getElementById('heat').textContent = parts.join('  ·  ');
}
async function pollHeat() {
    try { lastTokens = await (await fetch('/tokens')).json(); renderHeat(); } catch { }
    setTimeout(pollHeat, 30000);
}

function setStatus(cls, text) { statusEl.className = cls; document.getElementById('stext').textContent = text; }
function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function renderChat() {
    const groups = [];
    for (const e of chatEvts) {
        if (e.kind === 'sys') { groups.push({ divider: e.text }); continue; }
        const last = groups[groups.length - 1];
        if (last && !last.divider && last.who === e.who && (Date.parse(e.ts) - Date.parse(last.lastTs)) < 5000) {
            last.texts.push(e.text); last.lastTs = e.ts;
        } else groups.push({ who: e.who, texts: [e.text], ts: e.ts, lastTs: e.ts });
    }
    const show = expanded ? groups : groups.slice(-10);
    chatEl.innerHTML = show.map(g => {
        if (g.divider) return '<div class="divider">&#9472;&#9472; ' + esc(g.divider) + ' &#9472;&#9472;</div>';
        const me = g.who === 'you';
        const chip = (!me && g.who !== 'jarvis' && g.who !== focusCS) ? '<span class="chip">' + esc(g.who.toUpperCase()) + ' &#183; </span>' : '';
        return '<div class="row ' + (me ? 'me' : 'them') + '"><div class="bubble">' + chip
            + esc(g.texts.join('\\n')).split('\\n').join('<br>')
            + '<span class="t">' + (g.ts || '').slice(11, 16) + '</span></div></div>';
    }).join('');
    rawEl.innerHTML = chatEvts.slice(-200).reverse().map(e =>
        '<div>[' + (e.ts || '').slice(11, 19) + '] <b>' + esc(e.kind === 'sys' ? 'SYS' : (e.who === 'you' ? 'YOU' : String(e.who).toUpperCase())) + '</b> ' + esc(e.text) + '</div>'
    ).join('');
    if (pinned) chatEl.scrollTop = chatEl.scrollHeight;
}
async function pollChat() {
    try {
        const r = await (await fetch('/transcript?limit=' + (expanded ? 0 : 60))).json();
        const p = JSON.stringify(r);
        if (p !== lastChatPayload) { lastChatPayload = p; chatEvts = r; renderChat(); }
    } catch { }
    setTimeout(pollChat, 1500);
}
function refreshChat() { lastChatPayload = ''; }
function setExpanded(v) { expanded = v; bexp.className = 'btn' + (v ? ' on' : ''); refreshChat(); }
function setRaw(v) { rawMode = v; braw.className = 'btn' + (v ? ' on' : ''); chatEl.style.display = v ? 'none' : 'flex'; rawEl.style.display = v ? 'block' : 'none'; }
chatEl.onscroll = () => {
    pinned = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;
    jumpEl.style.display = pinned ? 'none' : 'inline-block';
};
jumpEl.onclick = () => { pinned = true; chatEl.scrollTop = chatEl.scrollHeight; jumpEl.style.display = 'none'; };
bexp.onclick = () => setExpanded(!expanded);
braw.onclick = () => setRaw(!rawMode);
document.addEventListener('keydown', e => {
    if (e.key === 't') setExpanded(!expanded);
    if (e.key === 'r') setRaw(!rawMode);
});

function renderBoards(d) {
    focusCS = d.focus;
    renderHeat();
    workEl.innerHTML = d.boards.map(b => {
        const sec = (title, items, cls, mark) => (items && items.length)
            ? '<div class="wtitle ' + cls + '">' + title + '</div>'
                + items.map(i => '<div class="witem ' + cls + '">' + mark + ' ' + esc(i) + '</div>').join('')
            : '';
        const cls = 'bhead' + (b.callsign === d.focus ? ' focused' : '') + (b.alive === false ? ' dead' : '');
        const star = b.callsign === d.focus ? ' &#9733;' : '';
        const body = sec('WORKING ON', b.working, 'working', '&#9656;')
            + sec('QUEUED', b.queued, 'queued', '&#9675;')
            + sec('DONE', b.done, 'done', '&#10003;');
        const ctx = (typeof b.context === 'number')
            ? ' <span class="bpurpose" style="color:' + (b.context >= 80 ? '#e06c6c' : b.context >= 60 ? '#d9a05d' : '#5dd97c') + '">' + b.context + '%</span>'
            : '';
        return '<div class="' + cls + '">' + esc(b.callsign.toUpperCase()) + star + ctx
            + (b.purpose ? ' <span class="bpurpose">' + esc(b.purpose) + '</span>' : '') + '</div>'
            + (body || '<div class="witem queued" style="color:#566270">empty</div>');
    }).join('');
}
async function pollWork() {
    try { renderBoards(await (await fetch('/board')).json()); } catch { }
    setTimeout(pollWork, 1500);
}
pollChat();
pollWork();
pollHeat();

let buf = [];
let flushTimer = null;
const INSTANT = [
    /\\b(pause|stop|resume|start) listening\\b/i,
    /\\bjarvis\\b.*\\b(shut ?down|shutdown)\\b/i,
    /\\bend (the )?session\\b/i,
    /\\bmeeting mode\\b/i,
    /\\bend meeting\\b/i,
    /^(?:jarvis[,!. ]+)?(add|new) task\\b/i,
    /^(?:jarvis[,!. ]+)?(start|begin|finish|complete|scratch|drop) task\\b/i,
    /^(?:jarvis[,!. ]+)?done with\\b/i,
    /^(?:jarvis[,!. ]+)?clear done\\b/i,
    /^(?:jarvis[,!. ]+)?(read|what is|what's) (the |on |my )?(list|worklist|tasks)\\b/i,
    /^(?:jarvis[,!. ]+)?read everyone/i,
    /^(?:jarvis[,!. ]+)?(focus on|switch to|talk to)\\b/i,
    /^(?:jarvis[,!. ]+)?retire\\b/i,
    /^(?:jarvis[,!. ]+)?who('s| is| else is)? (running|up|alive|online)\\b/i,
    /^(?:jarvis[,!. ]+)?(start|spin up|launch) (a |a new |new )?session\\b/i,
];
function flushBuf() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!buf.length) return;
    const text = buf.join(' ').trim();
    buf = [];
    interimEl.textContent = '';
    if (text) window.__jarvisHear(text);
}
function armFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushBuf, 2500);
}

const rec = new webkitSpeechRecognition();
rec.continuous = true;
rec.interimResults = true;
rec.lang = 'en-US';
rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
            const text = r[0].transcript.trim();
            if (text) {
                buf.push(text);
                const joined = buf.join(' ');
                if (INSTANT.some(re => re.test(joined))) { flushBuf(); continue; }
                interimEl.textContent = joined + ' …';
            }
            armFlush();
        } else {
            interimEl.textContent = (buf.length ? buf.join(' ') + ' ' : '') + r[0].transcript;
            armFlush();
        }
    }
};
rec.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
        setStatus('error', 'ERROR: ' + e.error + ' (auto-restarting)');
    }
};
rec.onend = () => { if (!speaking && !stopped) setTimeout(startRec, 200); };
function startRec() {
    if (speaking || stopped) return;
    try { rec.start(); setStatus('listening', 'LISTENING'); } catch { }
}
function pickVoice() {
    const voices = speechSynthesis.getVoices();
    return voices.find(v => v.name === 'Google US English')
        || voices.find(v => v.lang === 'en-US' && v.name.includes('Google'))
        || voices.find(v => v.lang === 'en-US')
        || null;
}
window.__speak = (text) => new Promise((resolve) => {
    speaking = true;
    try { rec.stop(); } catch { }
    const u = new SpeechSynthesisUtterance(text);
    u.voice = pickVoice();
    u.rate = 1.05;
    const done = () => {
        speaking = false;
        setTimeout(startRec, 300);
        resolve();
    };
    u.onend = done;
    u.onerror = done;
    setStatus('speaking', 'SPEAKING');
    speechSynthesis.speak(u);
});
window.__shutdown = () => { stopped = true; flushBuf(); try { rec.stop(); } catch { } setStatus('muted', 'STOPPED'); };
speechSynthesis.getVoices();
speechSynthesis.onvoiceschanged = () => { };
startRec();
</script></body></html>`;

const transcriptCache = loadJsonl(TRANSCRIPT);
const bus = loadJsonl(BUS);
const roster = loadRoster();
const pollWaiters = [];
const sayQueue = [];
let discard = false, meetingMode = false, running = true;
let screenGrant = 0;
const SESSION_BUDGET = Number(process.env.JARVIS_SESSION_BUDGET || 0);
let tokenStats = { totals: { output: 0, input: 0, cacheWrite: 0, cacheRead: 0, turns: 0 }, burn: 0, heat: heatOf(0), resetAt: null, sessionPct: null, source: 'estimate', weekPct: null, blockBurn: 0, budget: null, at: null };
let realUsage = null;
function refreshTokens() {
    try {
        const now = Date.now();
        const entries = scanUsage(PROJECTS, now - 7 * 24 * 3600000);
        const totals = totalsOf(entries, now - 3600000);
        const burn = burnOf(totals);
        const b = blockStats(entries, now);
        const budget = SESSION_BUDGET || b.maxBlockBurn || 0;
        const estPct = b.resetAt && budget ? Math.min(100, Math.round(b.blockBurn / budget * 100)) : null;
        const estReset = b.resetAt ? new Date(b.resetAt).toISOString() : null;
        tokenStats = {
            totals, burn, heat: heatOf(burn),
            resetAt: realUsage && realUsage.resetAt ? realUsage.resetAt : estReset,
            sessionPct: realUsage && realUsage.sessionPct !== null ? realUsage.sessionPct : estPct,
            source: realUsage && realUsage.sessionPct !== null ? 'api' : 'estimate',
            weekPct: realUsage ? realUsage.weekPct : null,
            blockBurn: b.blockBurn, budget,
            at: new Date().toISOString(),
        };
    } catch { }
}
async function refreshRealUsage() {
    realUsage = await fetchRealUsage();
    refreshTokens();
}
const REAL_USAGE = process.env.JARVIS_REAL_USAGE === '1';
refreshTokens();
if (REAL_USAGE) {
    refreshRealUsage();
    setInterval(refreshRealUsage, 600000).unref();
}
setInterval(refreshTokens, 30000).unref();
let lastHist = null;

function loadJsonl(path) {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
}
function loadRoster() {
    try {
        const r = JSON.parse(readFileSync(SESSIONS, 'utf8'));
        if (r && r.sessions) return r;
    } catch { }
    return { callsigns: {}, sessions: {}, nextUid: 1 };
}
function saveRoster() {
    writeFileSync(SESSIONS, JSON.stringify(roster, null, 1));
}
function record(entry) {
    const e = { ...entry, ts: new Date().toISOString() };
    transcriptCache.push(e);
    appendFileSync(TRANSCRIPT, JSON.stringify(e) + '\n');
}
function drainWholeFile(path) {
    if (!existsSync(path)) return '';
    const txt = readFileSync(path, 'utf8');
    if (!txt.trim()) return '';
    writeFileSync(path, '');
    return txt;
}
function loadWork() {
    try {
        const w = JSON.parse(readFileSync(WORKLIST, 'utf8'));
        if (w && w.sessions) return w;
        if (w && (w.working || w.queued || w.done)) {
            return { focus: 'jarvis', sessions: { jarvis: { working: w.working || [], queued: w.queued || [], done: w.done || [] } } };
        }
    } catch { }
    return { focus: 'jarvis', sessions: { jarvis: { working: [], queued: [], done: [] } } };
}
function saveWork(w) {
    writeFileSync(WORKLIST, JSON.stringify(w, null, 1));
}
function ensureBoard(w, cs) {
    if (!w.sessions[cs]) w.sessions[cs] = { working: [], queued: [], done: [] };
    return w.sessions[cs];
}
function findTaskAll(w, needle, lists, prefer) {
    const n = needle.toLowerCase();
    const order = [prefer, ...Object.keys(w.sessions).filter(k => k !== prefer)];
    for (const cs of order) {
        const b = w.sessions[cs];
        if (!b) continue;
        for (const list of lists) {
            const i = (b[list] || []).findIndex(t => t.toLowerCase().includes(n));
            if (i >= 0) return { cs, list, i };
        }
    }
    return null;
}
function loadRepos() {
    try { return JSON.parse(readFileSync(REPOS, 'utf8')) || {}; } catch { return {}; }
}

function liveUidOf(cs) {
    const l = roster.callsigns[cs];
    if (!l || !l.length) return null;
    const s = roster.sessions[l[0]];
    return s && !s.ended ? l[0] : null;
}
function liveCallsigns() {
    return NATO.filter(cs => liveUidOf(cs));
}
function aliveNow(uid) {
    const s = roster.sessions[uid];
    return !!(s && s.lastSeen && Date.now() - Date.parse(s.lastSeen) < 120000);
}
function csFrom(word) {
    if (!word) return null;
    const n = word.toLowerCase().replace(/[^a-z]/g, '');
    if (n === 'jarvis') return 'jarvis';
    return liveUidOf(n) ? n : null;
}
function canon(s) {
    return s.replace(/\bx[\s-]ray\b/gi, 'xray').replace(/\bjuliette\b/gi, 'juliet');
}
function assignCallsign(pin) {
    if (pin) {
        const p = String(pin).toLowerCase().replace(/[^a-z]/g, '');
        if (NATO.includes(p) && !liveUidOf(p)) return p;
    }
    const free = NATO.filter(cs => !liveUidOf(cs));
    if (!free.length) throw new Error('all 26 callsigns are live');
    const never = free.filter(cs => !(roster.callsigns[cs] || []).length);
    if (never.length) return never[0];
    free.sort((a, b) => Date.parse(roster.sessions[roster.callsigns[a][0]].ended || 0) - Date.parse(roster.sessions[roster.callsigns[b][0]].ended || 0));
    return free[0];
}
function enqueueSay(text, from) {
    const label = from || 'jarvis';
    const focus = loadWork().focus;
    const spoken = (label !== 'jarvis' && label !== focus) ? label + ' says: ' + text : text;
    sayQueue.push({ text, spoken, from: label });
}
function releaseWaiters() {
    for (let i = pollWaiters.length - 1; i >= 0; i--) {
        const wt = pollWaiters[i];
        const out = eventsFor(wt.uid, wt.cursor);
        if (out.events.length) {
            pollWaiters.splice(i, 1);
            clearTimeout(wt.timer);
            json(wt.res, 200, out);
        }
    }
}
let speechReleaseTimer = null;
function busAppend(ev, debounceMs) {
    const e = { ...ev, ts: new Date().toISOString() };
    bus.push(e);
    appendFileSync(BUS, JSON.stringify(e) + '\n');
    if (!debounceMs) {
        if (speechReleaseTimer) { clearTimeout(speechReleaseTimer); speechReleaseTimer = null; }
        releaseWaiters();
        return;
    }
    if (speechReleaseTimer) clearTimeout(speechReleaseTimer);
    speechReleaseTimer = setTimeout(() => { speechReleaseTimer = null; releaseWaiters(); }, debounceMs);
}
function eventsFor(uid, cursor) {
    const events = [];
    for (let i = Math.max(0, cursor); i < bus.length; i++) {
        const e = bus[i];
        if (e.to === uid || e.to === 'all') events.push(e);
    }
    return { cursor: bus.length, events };
}
function registerSession(cwd, purpose, pin) {
    const cs = assignCallsign(pin);
    const uid = 's_' + String(roster.nextUid++).padStart(4, '0');
    const now = new Date().toISOString();
    roster.callsigns[cs] = [uid, ...(roster.callsigns[cs] || [])];
    roster.sessions[uid] = { callsign: cs, cwd: cwd || '', purpose: purpose || cs, started: now, ended: null, lastSeen: now };
    saveRoster();
    const w = loadWork();
    ensureBoard(w, cs);
    let focusedNote = '';
    if (liveCallsigns().length === 1) { w.focus = cs; focusedNote = ' Focused on it.'; }
    saveWork(w);
    const reborn = roster.callsigns[cs].length > 1;
    record({ kind: 'sys', text: 'registered ' + uid + ' as ' + cs + ': ' + (purpose || '') });
    enqueueSay((reborn ? cs + ' is now ' : 'New session. ' + cs + ' is ') + (purpose || 'unnamed work') + '.' + focusedNote, 'jarvis');
    return { uid, callsign: cs };
}
function retireSession(uid, summary) {
    const s = roster.sessions[uid];
    if (!s || s.ended) return false;
    s.ended = new Date().toISOString();
    if (summary) s.summary = summary;
    const cs = s.callsign;
    const w = loadWork();
    const board = w.sessions[cs] || { working: [], queued: [], done: [] };
    writeFileSync(join(ARCHIVE, uid + '.json'), JSON.stringify({
        uid, callsign: cs, cwd: s.cwd, purpose: s.purpose,
        started: s.started, ended: s.ended, summary: s.summary || null, board,
    }, null, 1));
    delete w.sessions[cs];
    if (w.focus === cs) w.focus = liveCallsigns()[0] || 'jarvis';
    saveWork(w);
    saveRoster();
    record({ kind: 'sys', text: cs + ' retired (' + uid + ')' });
    enqueueSay(cs + ' retired.' + (summary ? ' ' + summary : ''), 'jarvis');
    busAppend({ from: 'jarvis', to: uid, kind: 'retired', text: 'retired' });
    return true;
}
const SPEECH_DEBOUNCE = Number(process.env.JARVIS_SPEECH_DEBOUNCE || 4000);
const nagAt = {};
function routeTo(cs, msg) {
    const uid = liveUidOf(cs);
    if (!uid) return false;
    busAppend({ from: 'human', to: uid, kind: 'speech', text: msg }, SPEECH_DEBOUNCE);
    record({ kind: 'speech', text: msg, to: cs });
    if (!aliveNow(uid)) {
        if (Date.now() - (nagAt[cs] || 0) > 300000) {
            nagAt[cs] = Date.now();
            const mins = Math.max(1, Math.round((Date.now() - Date.parse(roster.sessions[uid].lastSeen)) / 60000));
            const other = liveCallsigns().find(c => c !== cs && aliveNow(liveUidOf(c)));
            const hint = other ? ' Say focus on ' + other + ' to switch.' : '';
            enqueueSay(cs + ' has not checked in for ' + mins + ' minute' + (mins === 1 ? '' : 's') + '. Queueing for it.' + hint, 'jarvis');
        }
    } else {
        delete nagAt[cs];
    }
    return true;
}
function findRepo(spoken) {
    const repos = loadRepos();
    const clean = spoken.toLowerCase().replace(/\b(the|a|an|repo|repository|project|folder|workspace)\b/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const keys = Object.keys(repos);
    const key = keys.find(x => x.toLowerCase() === clean)
        || keys.find(x => clean.includes(x.toLowerCase()))
        || keys.find(x => x.toLowerCase().includes(clean));
    return key ? { key, ...repos[key] } : null;
}
function resolveClaude() {
    const home = process.env.USERPROFILE || '';
    const dirs = [
        ...(process.env.PATH || '').split(';').filter(Boolean),
        join(home, '.local', 'bin'),
        join(process.env.APPDATA || '', 'npm'),
        join(process.env.LOCALAPPDATA || '', 'Programs', 'claude'),
    ];
    for (const d of dirs) {
        for (const ext of ['.exe', '.cmd', '.bat']) {
            const p = join(d, 'claude' + ext);
            if (existsSync(p)) return p;
        }
    }
    return 'claude';
}
function spawnWorker(repo, purpose, model) {
    const safePurpose = purpose.replace(/["'^&<>|%]/g, '');
    const boot = 'You are a JARVIS worker session. Fetch http://127.0.0.1:' + PORT + '/protocol with a plain GET request and follow it exactly. Register with purpose: ' + safePurpose + '. Then wait for instructions on the poll loop.';
    const pm = repo.permissionMode ? ' --permission-mode ' + repo.permissionMode : '';
    const md = model || repo.model;
    const mm = md ? ' --model ' + md : '';
    const scriptPath = join(DATA, 'spawn-' + repo.key + '.cmd');
    writeFileSync(scriptPath, [
        '@echo off',
        'title JARVIS worker - ' + repo.key,
        'cd /d "' + repo.cwd + '"',
        '"' + resolveClaude() + '"' + pm + mm + ' "' + boot + '"',
    ].join('\r\n') + '\r\n');
    const child = spawn('wt', ['cmd', '/k', scriptPath], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
        const c2 = spawn('cmd', ['/c', 'start', 'JARVIS worker', 'cmd', '/k', scriptPath], { detached: true, stdio: 'ignore' });
        c2.on('error', () => enqueueSay('Could not launch a terminal for ' + repo.key + '.', 'jarvis'));
        c2.unref();
    });
    child.unref();
    record({ kind: 'sys', text: 'spawned session in ' + repo.cwd + ' (' + repo.key + ')' });
}
function speakBoard(cs, board) {
    const part = (label, items) => items && items.length ? label + ': ' + items.join('. ') + '. ' : '';
    return part('Working on', board.working) + part('Queued', board.queued);
}

function handleUtterance(rawText) {
    let text = rawText;
    let lower = canon(text).toLowerCase();
    if (meetingMode) {
        if (/\bend meeting( mode)?\b|\bjarvis\b.*\b(i'?m )?back\b/.test(lower)) {
            meetingMode = false;
            record({ kind: 'sys', text: 'meeting mode off' });
            sayQueue.push({ text: 'Meeting mode off. I can hear you again.', from: 'jarvis' });
            return;
        }
        if (!/^jarvis\b/.test(lower)) return;
    } else if (/\bmeeting mode\b/.test(lower) && !/\bend\b/.test(lower)) {
        meetingMode = true;
        record({ kind: 'sys', text: 'meeting mode on' });
        sayQueue.push({ text: 'Meeting mode. Say jarvis to reach me, end meeting when you are done.', from: 'jarvis' });
        return;
    }
    if (/\bjarvis\b.*\b(shut ?down|shutdown)\b|\bend (the )?session\b/.test(lower)) {
        record({ kind: 'speech', text, command: 'shutdown' });
        enqueueSay('Shutting down.', 'jarvis');
        running = false;
        return;
    }
    if (/\b(pause|stop) listening\b/.test(lower)) {
        discard = true;
        record({ kind: 'sys', text: 'listening paused' });
        enqueueSay('Pausing. Say resume listening when you want me back.', 'jarvis');
        return;
    }
    if (/\b(resume|start) listening\b/.test(lower)) {
        discard = false;
        record({ kind: 'sys', text: 'listening resumed' });
        enqueueSay('Listening.', 'jarvis');
        return;
    }
    if (discard) return;
    if (meetingMode) {
        text = text.replace(/^jarvis[\s,.!]*/i, '').trim();
        if (!text) return;
        lower = canon(text).toLowerCase();
    }

    if (/\bscreen ?shot\b|\blook at (my|the|this) screen\b/.test(lower)) {
        screenGrant = Date.now() + 120000;
    }

    const P = /^(?:jarvis[\s,.!]+)?/;
    const after = (re) => lower.match(new RegExp(P.source + re.source));
    let m;

    if ((m = after(/(?:focus on|switch to|talk to)\s+([a-z-]+)\b/))) {
        const cs = csFrom(m[1]);
        if (cs) {
            const w = loadWork();
            w.focus = cs;
            if (cs !== 'jarvis') ensureBoard(w, cs);
            saveWork(w);
            record({ kind: 'sys', text: 'focus: ' + cs });
            if (cs === 'jarvis') enqueueSay('Focused on me.', 'jarvis');
            else enqueueSay('Focused on ' + cs + ', ' + roster.sessions[liveUidOf(cs)].purpose + '.', 'jarvis');
        } else enqueueSay('No live session called ' + m[1] + '.', 'jarvis');
        return;
    }
    if (after(/(?:who|what)(?:'s| is| else is)?\s+(?:running|up|alive|online)\b/)) {
        const lives = liveCallsigns();
        if (!lives.length) { enqueueSay('No sessions registered. Just me.', 'jarvis'); return; }
        const focus = loadWork().focus;
        enqueueSay(lives.map(cs => {
            const uid = liveUidOf(cs);
            return cs + ', ' + roster.sessions[uid].purpose + (aliveNow(uid) ? '' : ', quiet') + (cs === focus ? ', focused' : '');
        }).join('. ') + '.', 'jarvis');
        return;
    }
    if (after(/context (?:check|health|report)\b/) || after(/how(?:'s| is) (?:the |everyone'?s? )?context\b/)) {
        const lives = liveCallsigns();
        if (!lives.length) { enqueueSay('No sessions to report context for.', 'jarvis'); return; }
        enqueueSay(lives.map(cs => {
            const s = roster.sessions[liveUidOf(cs)];
            return cs + (typeof s.ctx === 'number' ? ' at ' + s.ctx + ' percent' : ', no report yet');
        }).join('. ') + '.', 'jarvis');
        return;
    }
    if ((m = after(/what did (?:the )?(?:old|previous|last)\s+([a-z-]+)\s+do\b/))) {
        const n = m[1].replace(/[^a-z]/g, '');
        const list = (roster.callsigns[n] || []).filter(u => roster.sessions[u].ended);
        if (!list.length) { enqueueSay('No retired ' + n + ' on record.', 'jarvis'); return; }
        lastHist = { cs: n, idx: 0 };
        const s = roster.sessions[list[0]];
        enqueueSay('The previous ' + n + ' was ' + s.purpose + '. ' + (s.summary || 'No summary was recorded.'), 'jarvis');
        return;
    }
    if (after(/(?:and )?(?:the )?one before that\b/) && lastHist) {
        const list = (roster.callsigns[lastHist.cs] || []).filter(u => roster.sessions[u].ended);
        if (lastHist.idx + 1 >= list.length) { enqueueSay('That is the oldest ' + lastHist.cs + ' on record.', 'jarvis'); return; }
        lastHist.idx++;
        const s = roster.sessions[list[lastHist.idx]];
        enqueueSay('Before that, ' + lastHist.cs + ' was ' + s.purpose + '. ' + (s.summary || 'No summary was recorded.'), 'jarvis');
        return;
    }
    if ((m = after(/who(?:'s| is)\s+([a-z-]+)\b/))) {
        const n = m[1].replace(/[^a-z]/g, '');
        const uid = liveUidOf(n);
        if (uid) {
            const s = roster.sessions[uid];
            enqueueSay(n + ' is ' + s.purpose + (aliveNow(uid) ? '.' : '. Quiet lately.'), 'jarvis');
        } else if ((roster.callsigns[n] || []).length) {
            const s = roster.sessions[roster.callsigns[n][0]];
            enqueueSay(n + ' is retired. Last time it was ' + s.purpose + '.', 'jarvis');
        } else enqueueSay('Nobody called ' + n + '.', 'jarvis');
        return;
    }
    if ((m = after(/call (?:this one|this session|it)\s+([a-z-]+)\b/))) {
        const target = m[1].replace(/[^a-z]/g, '');
        const w = loadWork();
        const cur = w.focus;
        if (cur === 'jarvis' || !liveUidOf(cur)) { enqueueSay('Nothing is focused to rename.', 'jarvis'); return; }
        if (!NATO.includes(target)) { enqueueSay(target + ' is not a callsign I use.', 'jarvis'); return; }
        if (liveUidOf(target)) { enqueueSay(target + ' is taken.', 'jarvis'); return; }
        const uid = liveUidOf(cur);
        roster.callsigns[cur] = roster.callsigns[cur].slice(1);
        if (!roster.callsigns[cur].length) delete roster.callsigns[cur];
        roster.callsigns[target] = [uid, ...(roster.callsigns[target] || [])];
        roster.sessions[uid].callsign = target;
        saveRoster();
        w.sessions[target] = w.sessions[cur] || { working: [], queued: [], done: [] };
        delete w.sessions[cur];
        w.focus = target;
        saveWork(w);
        record({ kind: 'sys', text: cur + ' renamed to ' + target });
        enqueueSay('Done. This one is ' + target + ' now.', 'jarvis');
        return;
    }
    if ((m = after(/describe\s+([a-z-]+)\s+as\s+(.+)$/))) {
        const cs = csFrom(m[1]);
        if (!cs || cs === 'jarvis') { enqueueSay('No live session called ' + m[1] + '.', 'jarvis'); return; }
        roster.sessions[liveUidOf(cs)].purpose = m[2].trim();
        saveRoster();
        record({ kind: 'sys', text: cs + ' described: ' + m[2].trim() });
        enqueueSay(cs + ' is now ' + m[2].trim() + '.', 'jarvis');
        return;
    }
    if ((m = after(/retire\s+([a-z-]+)(\s+anyway)?\b/))) {
        const cs = csFrom(m[1]);
        if (!cs || cs === 'jarvis') { enqueueSay('No live session called ' + m[1] + '.', 'jarvis'); return; }
        const uid = liveUidOf(cs);
        const board = loadWork().sessions[cs] || { working: [] };
        if (board.working.length && !m[2]) {
            enqueueSay(cs + ' still has ' + board.working.length + ' task' + (board.working.length === 1 ? '' : 's') + ' working. Say retire ' + cs + ' anyway to force it.', 'jarvis');
            return;
        }
        if (aliveNow(uid)) {
            busAppend({ from: 'jarvis', to: uid, kind: 'retire-request', text: 'Wrap up now: post your one-line summary to /retire, then stop polling.' });
            enqueueSay('Asked ' + cs + ' to wrap up and retire.', 'jarvis');
        } else {
            retireSession(uid, null);
        }
        return;
    }
    if ((m = after(/(?:start|spin up|launch)(?: a| a new| new)?( cheap| haiku| fast)? session (?:in|on|at|for)\s+(.+)$/))) {
        const parts = m[2].split(/\s+for\s+/);
        const repo = findRepo(parts[0]);
        if (!repo) {
            const keys = Object.keys(loadRepos());
            enqueueSay('I do not know a repo matching ' + parts[0].trim() + '.' + (keys.length ? ' I know ' + keys.join(', ') + '.' : ' No repos are registered yet.'), 'jarvis');
            return;
        }
        const model = m[1] ? 'haiku' : undefined;
        const purpose = (parts[1] || repo.defaultPurpose || repo.key).trim();
        spawnWorker(repo, purpose, model);
        enqueueSay('Launching a session in ' + repo.key + ' for ' + purpose + (model ? ', on ' + model : '') + '. It will check in shortly.', 'jarvis');
        return;
    }
    if ((m = after(/(?:give|move|send) (?:the )?(.+?) task to ([a-z-]+)\b/))) {
        const to = csFrom(m[2]);
        if (!to) { enqueueSay('No live session called ' + m[2] + '.', 'jarvis'); return; }
        const w = loadWork();
        const hit = findTaskAll(w, m[1].trim(), ['working', 'queued', 'done'], w.focus);
        if (!hit) { enqueueSay('Nothing matching ' + m[1].trim() + '.', 'jarvis'); return; }
        const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
        ensureBoard(w, to).queued.push(t);
        saveWork(w);
        record({ kind: 'task', op: 'move', task: t, from: hit.cs, board: to });
        enqueueSay('Moved to ' + to + '.', 'jarvis');
        return;
    }
    if (after(/read (?:everyone'?s'?|all)(?: the)? (?:list|lists|tasks)\b/)) {
        const w = loadWork();
        const parts = Object.entries(w.sessions)
            .map(([cs, b]) => { const s = speakBoard(cs, b); return s ? cs + '. ' + s : ''; })
            .filter(Boolean);
        enqueueSay(parts.length ? parts.join(' ') : 'Every list is empty.', 'jarvis');
        return;
    }
    if ((m = after(/(?:add|new) task[,:]?\s+(.+)/))) {
        const w = loadWork();
        let target = w.focus, body = m[1].trim();
        const fm = body.match(/^(.*\S)\s+for\s+([a-z-]+)$/);
        if (fm) {
            const cs = csFrom(fm[2]);
            if (cs) { target = cs; body = fm[1].trim(); }
        }
        ensureBoard(w, target).queued.push(body);
        saveWork(w);
        record({ kind: 'task', op: 'add', board: target, task: body });
        enqueueSay(target === w.focus ? 'Added.' : 'Added to ' + target + '.', 'jarvis');
        return;
    }
    if ((m = after(/(?:start|begin) task[,:]?\s+(.+)/))) {
        const w = loadWork();
        const hit = findTaskAll(w, m[1].trim(), ['queued', 'done'], w.focus);
        if (hit) {
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            w.sessions[hit.cs].working.push(t);
            saveWork(w);
            record({ kind: 'task', op: 'start', board: hit.cs, task: t });
            enqueueSay('Working on it.', 'jarvis');
        } else enqueueSay('No queued task matching ' + m[1].trim() + '.', 'jarvis');
        return;
    }
    if ((m = after(/(?:done with|finish task|complete task|finish|complete)[,:]?\s+(.+)/))) {
        const w = loadWork();
        const hit = findTaskAll(w, m[1].trim(), ['working', 'queued'], w.focus);
        if (hit) {
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            w.sessions[hit.cs].done.push(t);
            saveWork(w);
            record({ kind: 'task', op: 'done', board: hit.cs, task: t });
            const b = w.sessions[hit.cs];
            enqueueSay('Done. ' + (b.working.length + b.queued.length) + ' to go.', 'jarvis');
        } else enqueueSay('No open task matching ' + m[1].trim() + '.', 'jarvis');
        return;
    }
    if ((m = after(/(?:scratch|drop) task[,:]?\s+(.+)/))) {
        const w = loadWork();
        const hit = findTaskAll(w, m[1].trim(), ['working', 'queued', 'done'], w.focus);
        if (hit) {
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            saveWork(w);
            record({ kind: 'task', op: 'drop', board: hit.cs, task: t });
            enqueueSay('Scratched.', 'jarvis');
        } else enqueueSay('Nothing matching ' + m[1].trim() + '.', 'jarvis');
        return;
    }
    if (after(/clear done\b/)) {
        const w = loadWork();
        const board = ensureBoard(w, w.focus);
        const n = board.done.length;
        board.done = [];
        saveWork(w);
        record({ kind: 'task', op: 'clear-done', board: w.focus, count: n });
        enqueueSay('Cleared ' + n + '.', 'jarvis');
        return;
    }
    if (after(/(?:read|what is|what's) (?:the |on |my )?(?:list|worklist|tasks)\b/)) {
        const w = loadWork();
        const spoken = speakBoard(w.focus, ensureBoard(w, w.focus));
        const prefix = w.focus === 'jarvis' ? '' : 'On ' + w.focus + '. ';
        enqueueSay(spoken ? prefix + spoken : prefix + 'The list is empty.', 'jarvis');
        return;
    }
    if ((m = canon(text).match(/^on\s+(\S+)[\s,.!]+(.+)$/i))) {
        const cs = csFrom(m[1]);
        if (cs && cs !== 'jarvis') { routeTo(cs, m[2].trim()); return; }
        if (cs === 'jarvis') { record({ kind: 'speech', text: m[2].trim() }); return; }
    }
    if (/^jarvis[\s,.!]+/i.test(text)) {
        const t = text.replace(/^jarvis[\s,.!]+/i, '').trim();
        if (t) record({ kind: 'speech', text: t });
        return;
    }
    const focus = loadWork().focus;
    if (focus !== 'jarvis' && liveUidOf(focus)) {
        routeTo(focus, text);
        return;
    }
    record({ kind: 'speech', text });
    console.log(`  HEARD "${text}"`);
}

function json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
}
function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on('end', () => {
            try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
        });
    });
}

async function handleRequest(req, res) {
    const u = new URL(req.url, ORIGIN);
    const key = req.method + ' ' + u.pathname;
    if (key === 'GET /worklist') return json(res, 200, loadWork());
    if (key === 'GET /board') {
        const w = loadWork();
        const lives = liveCallsigns();
        const order = [w.focus, ...lives.filter(cs => cs !== w.focus), ...(w.focus === 'jarvis' ? [] : ['jarvis'])];
        const extras = Object.keys(w.sessions).filter(cs => !order.includes(cs));
        const boards = [...new Set([...order, ...extras])].map(cs => {
            const b = w.sessions[cs] || { working: [], queued: [], done: [] };
            const uid = cs === 'jarvis' ? null : liveUidOf(cs);
            return {
                callsign: cs,
                purpose: uid ? roster.sessions[uid].purpose : '',
                alive: cs === 'jarvis' ? true : (uid ? aliveNow(uid) : false),
                context: uid && roster.sessions[uid].ctx !== undefined ? roster.sessions[uid].ctx : null,
                working: b.working, queued: b.queued, done: b.done,
            };
        });
        return json(res, 200, { focus: w.focus, boards });
    }
    if (key === 'GET /roster') {
        const live = liveCallsigns().map(cs => {
            const uid = liveUidOf(cs);
            const s = roster.sessions[uid];
            return { callsign: cs, uid, purpose: s.purpose, cwd: s.cwd, started: s.started, lastSeen: s.lastSeen, alive: aliveNow(uid) };
        });
        const retired = Object.entries(roster.sessions)
            .filter(([, s]) => s.ended)
            .sort((a, b) => Date.parse(b[1].ended) - Date.parse(a[1].ended))
            .slice(0, 20)
            .map(([uid, s]) => ({ uid, callsign: s.callsign, purpose: s.purpose, summary: s.summary || null, ended: s.ended }));
        return json(res, 200, { focus: loadWork().focus, live, retired });
    }
    if (key === 'GET /transcript') {
        const lim = Number(u.searchParams.get('limit') || 60);
        const kinds = { speech: 1, tts: 1, chat: 1, sys: 1 };
        const evts = transcriptCache.filter(e => kinds[e.kind]).map(e => ({
            ts: e.ts,
            kind: e.kind === 'sys' ? 'sys' : 'msg',
            who: e.kind === 'speech' ? 'you' : e.kind === 'sys' ? 'sys' : (e.from || 'jarvis'),
            text: e.text,
        }));
        return json(res, 200, lim > 0 ? evts.slice(-lim) : evts);
    }
    if (key === 'GET /tokens') {
        return json(res, 200, tokenStats);
    }
    if (key === 'GET /screen') {
        const s = roster.sessions[u.searchParams.get('uid')];
        if (Date.now() > screenGrant) {
            return json(res, 403, { error: 'screen is voice-gated: the human must say take a screenshot first, one capture per ask' });
        }
        try {
            const shot = await captureScreen(DATA, u.searchParams.get('all') === '1');
            screenGrant = 0;
            record({ kind: 'sys', text: (s ? s.callsign : 'someone') + ' took the screenshot' });
            return json(res, 200, shot);
        } catch (e) {
            return json(res, 500, { error: e.message });
        }
    }
    if (key === 'GET /protocol') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(existsSync(WORKER_DOC) ? readFileSync(WORKER_DOC, 'utf8') : 'WORKER.md missing');
        return;
    }
    if (key === 'GET /poll') {
        const uid = u.searchParams.get('uid');
        const cursor = Number(u.searchParams.get('cursor') || 0);
        const s = roster.sessions[uid];
        if (!s) return json(res, 404, { error: 'unknown uid' });
        if (s.ended) return json(res, 410, { error: 'retired' });
        s.lastSeen = new Date().toISOString();
        saveRoster();
        const out = eventsFor(uid, cursor);
        if (out.events.length) return json(res, 200, out);
        const waiter = { uid, cursor, res, timer: null };
        waiter.timer = setTimeout(() => {
            const i = pollWaiters.indexOf(waiter);
            if (i >= 0) pollWaiters.splice(i, 1);
            json(res, 200, { cursor: bus.length, events: [] });
        }, 25000);
        pollWaiters.push(waiter);
        req.on('close', () => {
            const i = pollWaiters.indexOf(waiter);
            if (i >= 0) { pollWaiters.splice(i, 1); clearTimeout(waiter.timer); }
        });
        return;
    }
    if (key === 'POST /register') {
        const b = await readBody(req);
        if (!String(b.purpose || '').trim() || !String(b.cwd || '').trim()) {
            return json(res, 400, { error: 'purpose and cwd are required. purpose is the one-line description the human sees on the board and hears in announcements; make it specific. Re-POST with both.' });
        }
        try { return json(res, 200, registerSession(b.cwd, b.purpose, b.pin)); }
        catch (e) { return json(res, 409, { error: e.message }); }
    }
    if (key === 'POST /health') {
        const b = await readBody(req);
        const s = roster.sessions[b.uid];
        if (!s || s.ended) return json(res, 404, { error: 'unknown uid' });
        const n = Math.round(Number(b.context));
        if (!Number.isFinite(n) || n < 0 || n > 100) return json(res, 400, { error: 'context must be a number 0-100' });
        s.ctx = n;
        s.ctxTs = new Date().toISOString();
        if (n >= 80 && !s.ctxWarned) {
            s.ctxWarned = true;
            enqueueSay(s.callsign + ' is at ' + n + ' percent context. Have it wrap up and hand off soon.', 'jarvis');
        }
        if (n < 80) s.ctxWarned = false;
        saveRoster();
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /describe') {
        const b = await readBody(req);
        const uid = roster.sessions[b.uid] ? b.uid : liveUidOf(String(b.callsign || '').toLowerCase());
        const purpose = String(b.purpose || '').trim();
        if (!uid || !purpose) return json(res, 400, { error: 'need callsign (or uid) and purpose' });
        roster.sessions[uid].purpose = purpose;
        saveRoster();
        record({ kind: 'sys', text: roster.sessions[uid].callsign + ' described: ' + purpose });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /send') {
        const b = await readBody(req);
        const s = roster.sessions[b.from];
        const label = s ? s.callsign : 'jarvis';
        if (b.to === 'human') {
            record({ kind: 'chat', from: label, text: String(b.text || '') });
            return json(res, 200, { ok: true });
        }
        const toUid = roster.sessions[b.to] ? b.to : liveUidOf(String(b.to || '').toLowerCase());
        if (!toUid) return json(res, 404, { error: 'unknown recipient' });
        busAppend({ from: b.from, to: toUid, kind: 'msg', text: String(b.text || '') });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /say') {
        const b = await readBody(req);
        const s = roster.sessions[b.from];
        const label = s ? s.callsign : 'jarvis';
        String(b.text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(l => enqueueSay(l, label));
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /worklist') {
        const b = await readBody(req);
        const w = loadWork();
        const cs = (b.callsign && (w.sessions[b.callsign] || liveUidOf(String(b.callsign).toLowerCase()) || b.callsign === 'jarvis')) ? String(b.callsign).toLowerCase() : w.focus;
        const board = ensureBoard(w, cs);
        const needle = String(b.text || '').trim();
        let task = needle || undefined;
        if (b.op === 'add' && needle) {
            board.queued.push(needle);
        } else if (b.op === 'start' || b.op === 'done' || b.op === 'drop') {
            const lists = b.op === 'start' ? ['queued', 'done'] : b.op === 'done' ? ['working', 'queued'] : ['working', 'queued', 'done'];
            const hit = findTaskAll(w, needle, lists, cs);
            if (!hit) return json(res, 404, { error: 'no task matching ' + needle });
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            if (b.op === 'start') w.sessions[hit.cs].working.push(t);
            if (b.op === 'done') w.sessions[hit.cs].done.push(t);
            task = t;
        } else if (b.op === 'move' && needle && b.to) {
            const hit = findTaskAll(w, needle, ['working', 'queued', 'done'], cs);
            if (!hit) return json(res, 404, { error: 'no task matching ' + needle });
            const [t] = w.sessions[hit.cs][hit.list].splice(hit.i, 1);
            ensureBoard(w, String(b.to).toLowerCase()).queued.push(t);
            task = t;
        } else if (b.op === 'clear-done') {
            board.done = [];
        } else {
            return json(res, 400, { error: 'op must be add|start|done|drop|move|clear-done' });
        }
        saveWork(w);
        record({ kind: 'task', op: b.op, board: cs, task });
        return json(res, 200, { ok: true, op: b.op, task });
    }
    if (key === 'POST /retire') {
        const b = await readBody(req);
        const ok = retireSession(b.uid, String(b.summary || '').trim() || null);
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'unknown or already retired uid' });
    }
    if (key === 'POST /repos') {
        const b = await readBody(req);
        const name = String(b.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!name || !b.cwd || !existsSync(b.cwd)) return json(res, 400, { error: 'need name and an existing cwd' });
        const repos = loadRepos();
        repos[name] = { cwd: b.cwd, defaultPurpose: b.defaultPurpose || '', ...(b.permissionMode ? { permissionMode: b.permissionMode } : {}), ...(b.model ? { model: b.model } : {}) };
        writeFileSync(REPOS, JSON.stringify(repos, null, 1));
        record({ kind: 'sys', text: 'repo registered: ' + name + ' -> ' + b.cwd });
        enqueueSay('Repo ' + name + ' registered.', 'jarvis');
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /hear') {
        const b = await readBody(req);
        if (b.text) handleUtterance(String(b.text));
        return json(res, 200, { ok: true });
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CONSOLE_HTML);
}

async function main() {
    const server = createServer((req, res) => {
        handleRequest(req, res).catch(e => {
            try { json(res, 500, { error: e.message }); } catch { }
        });
    });
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));

    let consolePage = null;
    let context = null;
    if (!NO_UI) {
        const { chromium } = await import('playwright');
        context = await chromium.launchPersistentContext(USER_DATA, {
            channel: 'chrome', headless: false, viewport: null,
            args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--app=${ORIGIN}`],
        });
        await context.grantPermissions(['microphone'], { origin: ORIGIN }).catch(() => { });
        consolePage = context.pages()[0] || await context.newPage();
        if (!consolePage.url().startsWith(ORIGIN)) await consolePage.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
        await consolePage.exposeFunction('__jarvisHear', (text) => handleUtterance(text));
    }

    let speakingNow = false;
    const pump = () => {
        if (!sayQueue.length || speakingNow) return;
        speakingNow = true;
        const item = sayQueue.shift();
        record({ kind: 'tts', text: item.text, from: item.from });
        if (consolePage) {
            consolePage.evaluate(t => window.__speak(t), item.spoken || item.text)
                .catch(() => { })
                .finally(() => { speakingNow = false; });
        } else {
            setTimeout(() => { speakingNow = false; }, 50);
        }
    };

    record({ kind: 'sys', text: 'jarvis core started' + (NO_UI ? ' (no ui)' : '') });
    console.log('JARVIS CORE READY.');
    console.log(`  data dir   -> ${DATA}`);
    console.log(`  transcript -> ${TRANSCRIPT}`);
    console.log(`  console    -> ${ORIGIN}`);
    enqueueSay('Jarvis online.', 'jarvis');

    while (running) {
        if (!meetingMode) {
            const raw = drainWholeFile(SAY);
            if (raw.trim()) raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(l => enqueueSay(l, 'jarvis'));
        }
        pump();
        const cmds = drainWholeFile(CMD);
        if (cmds.split(/\r?\n/).some(l => l.trim() === 'stop')) running = false;
        await new Promise(r => setTimeout(r, 250));
    }

    const drainStart = Date.now();
    while ((speakingNow || sayQueue.length) && Date.now() - drainStart < 30000) {
        pump();
        await new Promise(r => setTimeout(r, 250));
    }
    for (const wt of pollWaiters.splice(0)) {
        clearTimeout(wt.timer);
        try { json(wt.res, 200, { cursor: bus.length, events: [] }); } catch { }
    }
    if (consolePage) await consolePage.evaluate(() => window.__shutdown()).catch(() => { });
    record({ kind: 'sys', text: 'jarvis core stopped' });
    if (context) await context.close();
    server.close();
    console.log('JARVIS CORE STOPPED.');
}
main().catch(e => { console.error(e.message); process.exit(1); });
