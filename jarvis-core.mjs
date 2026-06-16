import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
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
const BUSBASE = join(DATA, 'bus.base'); // persisted count of bus events dropped off the front
const REPOS = join(DATA, 'repos.json');
const SCHEDULE = join(DATA, 'schedule.json');
const ARCHIVE = join(DATA, 'archive');
const WORKER_DOC = join(HERE, 'WORKER.md');
const PORT = Number(process.env.JARVIS_PORT || 8124);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NO_UI = !!process.env.JARVIS_NO_UI;
const PROJECTS = process.env.JARVIS_PROJECTS || join(process.env.USERPROFILE || '', '.claude', 'projects');
const NATO = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
const WORK_VERSION = 3;
// Bound the in-memory event arrays AND their .jsonl files so a long-lived hub doesn't grow
// without limit. We keep at most CACHE_CAP entries and only compact once we drift CACHE_SLACK
// past it, so the (atomic) file rewrite happens every ~SLACK events, not on every append.
const CACHE_CAP = 5000;
const CACHE_SLACK = 1000;

mkdirSync(DATA, { recursive: true });
mkdirSync(ARCHIVE, { recursive: true });
writeFileSync(SAY, '');
writeFileSync(CMD, '');
if (!existsSync(TRANSCRIPT)) writeFileSync(TRANSCRIPT, '');
if (!existsSync(BUS)) writeFileSync(BUS, '');
if (!existsSync(REPOS)) writeFileSync(REPOS, '{}\n');
if (!existsSync(SESSIONS)) writeFileSync(SESSIONS, JSON.stringify({ callsigns: {}, sessions: {}, nextUid: 1 }, null, 1));
if (!existsSync(WORKLIST)) writeFileSync(WORKLIST, JSON.stringify({ version: WORK_VERSION, focus: 'jarvis', sessions: { jarvis: { working: [], queued: [], done: [] } } }, null, 1));
// Sweep stale spawn launch scripts (one was written per spawned callsign; each is only read
// once at terminal launch, so leftovers from past sessions are just clutter — REVIEW.md LOW).
try { for (const f of readdirSync(DATA)) if (/^spawn-.*\.cmd$/i.test(f)) { try { unlinkSync(join(DATA, f)); } catch { } } } catch { }

const CONSOLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>JARVIS core</title><style>
body{background:#0b0f14;color:#d7e3f0;font:14px/1.5 Consolas,monospace;margin:0;padding:16px}
#status{font-size:22px;font-weight:bold;padding:10px 14px;border-radius:8px;background:#16202c;margin-bottom:12px}
#status.listening{color:#5dd97c}#status.speaking{color:#5db4d9}#status.muted{color:#d9a05d}#status.paused{color:#d9a05d}#status.error{color:#e06c6c}
#interim{display:flex;align-items:center;gap:10px;color:#7a8a9c;min-height:1.5em;margin-bottom:8px;font-style:italic}
#itext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mutedcue{display:none;flex:none;font-style:normal;color:#d9a05d;font-size:11px;letter-spacing:.5px}
#icancel{display:none;flex:none;font-style:normal;color:#e06c6c;border-color:#e06c6c}
#main{display:flex;gap:20px;align-items:flex-start}
#left{flex:3;min-width:0}
#bar{display:flex;gap:8px;margin-top:6px;align-items:center}
.btn{background:#16202c;border:1px solid #1f2c3a;color:#7a8a9c;border-radius:6px;padding:2px 10px;font:12px Consolas,monospace;cursor:pointer}
.btn.on{color:#5db4d9;border-color:#5db4d9}
#chat{display:flex;flex-direction:column;gap:6px;overflow-y:auto;height:64vh;background:#0d1420;border:1px solid #1f2c3a;border-radius:8px;padding:12px}
#rawlog{display:none;overflow-y:auto;height:64vh;background:#0d1420;border:1px solid #1f2c3a;border-radius:8px;padding:12px;font-size:12px;color:#9bb0c4}
#rawlog b{color:#5db4d9}
.row{display:flex}.row.me{justify-content:flex-end}
.bubble{max-width:70%;padding:7px 11px;border-radius:12px;border-bottom-left-radius:4px;white-space:pre-wrap;word-break:break-word;font-size:13px;background:#1a2533}
.me .bubble{background:#1d4567;border-bottom-left-radius:12px;border-bottom-right-radius:4px}
.chip{font-size:10px;color:#5db4d9;letter-spacing:1px}
.t{font-size:10px;color:#7a8a9c;margin-left:10px;white-space:nowrap}
.copybtn{cursor:pointer;margin-left:8px;font-size:11px;opacity:0;transition:opacity .15s;user-select:none}
.bubble:hover .copybtn{opacity:.6}
.copybtn:hover{opacity:1}
.reacts{margin-left:8px;display:inline-flex;gap:3px;vertical-align:middle}
.rx{cursor:pointer;opacity:.22;font-size:12px;transition:opacity .15s;filter:grayscale(1)}
.bubble:hover .rx{opacity:.55}
.rx:hover{opacity:1;filter:none}
.rx.on{opacity:1;filter:none}
.thumb{max-width:240px;max-height:180px;border-radius:6px;margin-top:4px;display:block;cursor:pointer;border:1px solid #1f2c3a}
.divider{text-align:center;color:#d9a05d;font-size:11px;margin:2px 0}
#right{flex:2;position:sticky;top:8px;max-height:92vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.panel{background:#101822;border:1px solid #1f2c3a;border-radius:8px;padding:12px}
.bhead{font-weight:bold;font-size:13px;letter-spacing:1px;margin:12px 0 2px;color:#d7e3f0;border-bottom:1px solid #1f2c3a;padding-bottom:2px}
.bhead.focused{color:#5db4d9}
.bhead.dead{color:#566270}
.bpurpose{font-weight:normal;color:#7a8a9c;font-size:11px;letter-spacing:0}
.wtitle{font-weight:bold;letter-spacing:1px;font-size:12px;margin:8px 0 2px}
.wtitle.working{color:#e8c35a}.wtitle.queued{color:#7a8a9c}.wtitle.done{color:#5dd97c}
.witem{padding:3px 0 3px 6px;font-size:13px;border-left:2px solid transparent}
.tchip{display:inline-block;font:bold 9px Consolas,monospace;letter-spacing:.5px;padding:0 4px;border-radius:3px;margin:0 5px 0 1px;vertical-align:middle;border:1px solid currentColor;cursor:default}
.tchip.bug{color:#e06c6c}.tchip.sec{color:#e0a85d}.tchip.rob{color:#b48ce0}.tchip.fea{color:#5dd97c}.tchip.rev{color:#5db4d9}.tchip.wrk{color:#e8c35a}.tchip.fs{color:#7fc4e0}.tchip.mnt{color:#9bb0c4}.tchip.psh{color:#d9a05d}.tchip.nte{color:#7a8a9c}
.witem.working{color:#f0e0b0;border-left-color:#e8c35a}
.witem.queued{color:#9bb0c4}
.witem.review{color:#7fc4e0;border-left-color:#5db4d9}
.witem.done{color:#6f9b7e;text-decoration:line-through}
.ndot{flex:none;color:#5db4d9;font-size:11px;cursor:pointer;user-select:none;opacity:.7}
.wnote{flex-basis:100%;margin:2px 0 4px 18px;font-size:11px;color:#8aa0b4;border-left:2px solid #2a3a4a;padding-left:8px;white-space:pre-wrap;text-decoration:none}
.expander{cursor:pointer;color:#5db4d9 !important;text-decoration:none}
.bdoing{font-size:11px;color:#9bb0c4;margin:0 0 2px}
.needs{color:#fff;background:#a33;border-radius:4px;padding:0 5px;font-weight:bold;letter-spacing:1px}
.nmlabel{color:#5db4d9;font-weight:bold;font-size:11px;letter-spacing:1px}
.nmtime{color:#7a8a9c;font-size:11px}
#caltext{width:100%;height:110px;background:#0d1420;color:#d7e3f0;border:1px solid #1f2c3a;border-radius:6px;font:12px Consolas,monospace;margin:6px 0;box-sizing:border-box}
.evrow{display:flex;align-items:center;gap:6px}
.evrow > span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.evicons{margin-left:auto;white-space:nowrap}
.evic{text-decoration:none;margin-left:6px;font-size:13px}
#stabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:0}
.stab{background:#16202c;border:1px solid #1f2c3a;color:#9bb0c4;border-radius:6px 6px 0 0;padding:4px 12px;cursor:pointer;font:bold 12px Consolas,monospace;letter-spacing:1px}
.stab.active{color:#5db4d9;border-color:#5db4d9;background:#0d1420}
.stab.dead{color:#566270}
.stab.needs{color:#fff;background:#a33;border-color:#e06c6c;animation:needpulse 1.4s infinite}
.sbadge{color:#fff;background:#a33;border-radius:8px;padding:0 5px;margin-left:6px;font-size:10px}
@keyframes needpulse{0%,100%{box-shadow:0 0 0 0 rgba(224,108,108,.55)}50%{box-shadow:0 0 7px 2px rgba(224,108,108,.8)}}
#chat{border-top-left-radius:0}
.card{background:#101822;border:1px solid #24323f;border-radius:8px;padding:8px 10px;margin-bottom:8px}
.card.cfocus{border-color:#5db4d9}
.card.cdead{opacity:.55}
.card.cneeds{border-color:#e06c6c;box-shadow:0 0 6px rgba(224,108,108,.4)}
.chead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ctitle{font-weight:bold;letter-spacing:1px;font-size:13px;color:#d7e3f0}
.card.cfocus .ctitle{color:#5db4d9}
.cbtns{display:flex;gap:5px;white-space:nowrap}
.cbtn{cursor:pointer;font-size:13px;opacity:.5;user-select:none}
.cbtn:hover{opacity:1}
.cpurpose{color:#7a8a9c;font-size:11px;margin:2px 0;letter-spacing:0;font-weight:normal}
.ccount{font-size:11px;margin:3px 0;display:flex;gap:12px}
.cnum{font-weight:bold}
.cnum.work{color:#e8c35a}.cnum.queue{color:#9bb0c4}.cnum.review{color:#5db4d9}.cnum.done{color:#5dd97c}
.arow{display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0;color:#8aa0b4}
.achip{color:#7a8a9c;font-weight:bold;font-size:10px;letter-spacing:1px;min-width:52px}
.asum{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ctoggle{cursor:pointer;color:#5db4d9;font-size:11px;user-select:none;margin:2px 0}
.witem{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.wleft{display:flex;align-items:center;gap:5px;min-width:0;flex:1}
.wtext{min-width:0;overflow:hidden;text-overflow:ellipsis}
.rowacts{opacity:0;white-space:nowrap;transition:opacity .12s}
.witem:hover .rowacts{opacity:1}
.ract{cursor:pointer;margin-left:6px;font-size:12px;opacity:.7}
.ract:hover{opacity:1}
.ract.del:hover{color:#e06c6c}
.permreq{background:#2a1a1a;border:1px solid #a33;border-radius:6px;padding:6px 8px;margin:5px 0}
.permhead{color:#e8a05a;font-size:11px;font-weight:bold}
.permdetail{color:#d7e3f0;font-size:11px;font-family:Consolas,monospace;word-break:break-all;margin:3px 0;max-height:64px;overflow:auto}
.permbtns{display:flex;gap:6px;margin-top:5px}
.pbtn{cursor:pointer;font-size:11px;padding:2px 11px;border-radius:5px;border:1px solid #1f2c3a;background:#16202c;color:#9bb0c4;user-select:none}
.pbtn.ok{color:#5dd97c;border-color:#5dd97c}
.pbtn.no{color:#e06c6c;border-color:#e06c6c}
.pbtn:hover{filter:brightness(1.35)}
</style></head><body>
<div id="status"><span id="stext">starting…</span><span style="float:right"><span id="heat" style="font-size:14px;font-weight:normal;color:#7a8a9c"></span><button class="btn" id="bpause" style="margin-left:14px;font-size:13px;padding:3px 14px">PAUSE</button><button class="btn" id="bmute" style="margin-left:14px;font-size:13px;padding:3px 14px">MUTE</button></span></div>
<div id="interim"><span id="itext"></span><span id="mutedcue">&#128263; muted &#183; say "unmute"</span><button class="btn" id="icancel">&#10005; CANCEL</button></div>
<div id="main">
<div id="left">
<div id="stabs"></div>
<div id="chat"></div>
<div style="display:flex;gap:8px;margin-top:6px"><input id="typebox" placeholder="Type to jarvis (routes like speech; works while paused/muted)" style="flex:1;background:#0d1420;border:1px solid #1f2c3a;border-radius:8px;color:#dde6ef;padding:8px 12px;font-size:14px;font-family:inherit" autocomplete="off"><button class="btn" id="btype" style="font-size:13px;padding:3px 14px">SEND</button></div>
<div id="rawlog"></div>
<div id="bar"><button class="btn" id="bexp">EXPAND (t)</button><button class="btn" id="braw">RAW (r)</button><button class="btn" id="bcal">SCHEDULE</button><span id="jump" class="btn" style="display:none">&#8595; latest</span></div>
<div id="calbox" style="display:none"><textarea id="caltext" placeholder="Paste your calendar agenda here (titles + 3:00 PM-4:00 PM lines)"></textarea><button class="btn" id="bcalsave">LOAD SCHEDULE</button></div>
</div>
<div id="right">
<div id="nextpanel" class="panel" style="display:none"></div>
<div id="work" class="panel"></div>
<div id="schedpanel" class="panel" style="display:none"></div>
<div id="archpanel" class="panel" style="display:none"></div>
</div>
</div>
<script>
const statusEl = document.getElementById('status');
const interimEl = document.getElementById('interim');
const itextEl = document.getElementById('itext');
const mutedcueEl = document.getElementById('mutedcue');
const cancelBtn = document.getElementById('icancel');
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
let lastArchive = null;
let activeTab = 'all';

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
function escAttr(t) { return esc(t).split('"').join('&quot;'); }

const REMOJI = { up: '👍', love: '❤️', squee: '🤩', fire: '🔥', down: '👎', poop: '💩' };
function renderChat() {
    renderTabs();
    const reactMap = {};
    for (const e of chatEvts) if (e.kind === 'react' && e.target) reactMap[e.target] = e.reaction;
    const groups = [];
    for (const e of eventsForTab()) {
        if (e.kind === 'react') continue;
        if (e.kind === 'sys') { groups.push({ divider: e.text }); continue; }
        if (e.img) { groups.push({ who: e.who, texts: [e.text], ts: e.ts, lastTs: e.ts, img: e.img }); continue; }
        const last = groups[groups.length - 1];
        if (last && !last.divider && !last.img && last.who === e.who && (Date.parse(e.ts) - Date.parse(last.lastTs)) < 5000) {
            last.texts.push(e.text); last.lastTs = e.ts;
        } else groups.push({ who: e.who, texts: [e.text], ts: e.ts, lastTs: e.ts });
    }
    const show = expanded ? groups : groups.slice(-10);
    chatEl.innerHTML = show.map(g => {
        if (g.divider) return '<div class="divider">&#9472;&#9472; ' + esc(g.divider) + ' &#9472;&#9472;</div>';
        const me = g.who === 'you';
        const chip = (!me && g.who !== 'jarvis' && g.who !== focusCS) ? '<span class="chip">' + esc(g.who.toUpperCase()) + ' &#183; </span>' : '';
        const cur = reactMap[g.ts];
        // Ordered happiest -> poop: squee, fire, love, up (positives, descending), then down, poop.
        const reactBar = '<span class="reacts">' + ['squee', 'fire', 'love', 'up', 'down', 'poop'].map(k => '<span class="rx' + (cur === k ? ' on' : '') + '" data-react="' + k + '" data-ts="' + escAttr(g.ts || '') + '">' + REMOJI[k] + '</span>').join('') + '</span>';
        return '<div class="row ' + (me ? 'me' : 'them') + '"><div class="bubble">' + chip
            + esc(g.texts.join('\\n')).split('\\n').join('<br>')
            + (g.img ? '<br><a href="' + g.img + '" target="_blank"><img src="' + g.img + '" class="thumb"></a>' : '')
            + '<span class="t">' + (g.ts || '').slice(11, 16) + '</span>'
            + '<span class="copybtn" data-c="' + btoa(unescape(encodeURIComponent(g.texts.join('\\n')))) + '" title="copy">📋</span>' + reactBar + '</div></div>';
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
chatEl.addEventListener('click', (e) => {
    const rx = e.target.closest ? e.target.closest('[data-react]') : null;
    if (rx) {
        fetch('/react', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ts: rx.getAttribute('data-ts'), reaction: rx.getAttribute('data-react') }) }).catch(() => { });
        return;
    }
    const c = e.target.closest ? e.target.closest('.copybtn') : null;
    if (!c) return;
    const txt = decodeURIComponent(escape(atob(c.getAttribute('data-c'))));
    const ok = () => { c.textContent = '✓'; setTimeout(() => { c.textContent = '📋'; }, 1000); };
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        let okFlag = false;
        try { okFlag = document.execCommand('copy'); } catch { okFlag = false; }
        document.body.removeChild(ta);
        if (okFlag) ok(); else { c.textContent = '✗'; setTimeout(() => { c.textContent = '📋'; }, 1000); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(ok).catch(fallback);
    } else {
        fallback();
    }
});
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
document.getElementById('bcal').onclick = () => {
    const box = document.getElementById('calbox');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
};
document.getElementById('bcalsave').onclick = async () => {
    const ta = document.getElementById('caltext');
    try {
        const r = await (await fetch('/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ta.value }) })).json();
        if (r.ok) { ta.value = ''; document.getElementById('calbox').style.display = 'none'; }
        else alert(r.error || 'parse failed');
    } catch { }
};
document.addEventListener('keydown', e => {
    if (e.key === 't') setExpanded(!expanded);
    if (e.key === 'r') setRaw(!rawMode);
});

const boardExpand = new Set();
let lastBoard = null, lastSched = null;
function fmtClock(iso) {
    const d = new Date(iso);
    let h = d.getHours();
    const m = d.getMinutes(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
// 3-letter category chips derived from a leading TAG: in the task text (BUG:/SECURITY:/...).
// [code, full-label-for-tooltip, color-class]. The tag is stripped from the visible text and
// shown as a colored chip with a hover tooltip instead.
const TCHIPS = {
    BUG: ['BUG', 'Bug', 'bug'],
    SECURITY: ['SEC', 'Security', 'sec'], SEC: ['SEC', 'Security', 'sec'],
    ROBUST: ['ROB', 'Robustness', 'rob'], ROB: ['ROB', 'Robustness', 'rob'],
    FEATURE: ['FEA', 'Feature', 'fea'], FEAT: ['FEA', 'Feature', 'fea'], FEA: ['FEA', 'Feature', 'fea'],
    REVIEW: ['REV', 'Review', 'rev'], REV: ['REV', 'Review', 'rev'],
    WORK: ['WRK', 'Working', 'wrk'], WRK: ['WRK', 'Working', 'wrk'],
    FS: ['FS', 'Filesystem', 'fs'],
    MAINT: ['MNT', 'Maintenance', 'mnt'],
    POLISH: ['PSH', 'Polish', 'psh'],
    NOTE: ['NTE', 'Note', 'nte'],
};
function chipFor(text) {
    const m = String(text == null ? '' : text).match(/^([A-Za-z]{2,8}):\\s*/);
    if (!m) return { chip: '', rest: text };
    const c = TCHIPS[m[1].toUpperCase()];
    if (!c) return { chip: '', rest: text };
    return { chip: '<span class="tchip ' + c[2] + '" title="' + c[1] + '">' + c[0] + '</span>', rest: text.slice(m[0].length) };
}
function renderBoards(d) {
    focusCS = d.focus;
    lastBoard = d;
    if (typeof d.muted === 'boolean' && d.muted !== isMuted) window.__setMute(d.muted);
    if (typeof d.paused === 'boolean' && d.paused !== isPaused) window.__setPause(d.paused);
    renderHeat();
    const evIcons = (e) => {
        let h = '';
        if (e.join) {
            const ic = e.joinKind === 'zoom' ? '🔵' : e.joinKind === 'teams' ? '🤮' : '🎥';
            h += '<span class="evic" data-open="' + esc(e.join) + '" title="join ' + esc(e.joinKind || 'meeting') + '">' + ic + '</span>';
        }
        if (e.link) h += '<span class="evic" data-open="' + esc(e.link) + '" title="open invite">📅</span>';
        return h ? '<span class="evicons">' + h + '</span>' : '';
    };
    let top = '';
    if (lastSched && (lastSched.current || lastSched.next)) {
        const nmRow = (label, e, time) => '<div class="evrow"><span><span class="nmlabel">' + label + '</span> ' + esc(e.title) + ' <span class="nmtime">' + time + '</span></span>' + evIcons(e) + '</div>';
        top = (lastSched.current ? nmRow('NOW', lastSched.current, 'until ' + fmtClock(lastSched.current.end)) : '')
            + (lastSched.next ? nmRow('NEXT', lastSched.next, fmtClock(lastSched.next.start)) : '');
    }
    let sched = '';
    if (lastSched && lastSched.events && lastSched.events.length) {
        sched = '<div class="bhead" style="margin-top:0">SCHEDULE</div>' + lastSched.events.map(e => {
            const past = Date.parse(e.end) < Date.now();
            return '<div class="witem evrow" style="color:' + (past ? '#566270' : '#9bb0c4') + '"><span>' + fmtClock(e.start) + '  ' + esc(e.title) + '</span>' + (past ? '' : evIcons(e)) + '</div>';
        }).join('');
    }
    const np = document.getElementById('nextpanel'), sp = document.getElementById('schedpanel');
    np.innerHTML = top; np.style.display = top ? 'block' : 'none';
    sp.innerHTML = sched; sp.style.display = sched ? 'block' : 'none';
    const prio = b => b.pendingPerm ? 2 : b.needsYou ? 1 : 0;   // float perm/needs-you cards to the top
    workEl.innerHTML = d.boards.slice().sort((a, b) => prio(b) - prio(a)).map(b => {
        const queued = b.queued || [], done = b.done || [], working = b.working || [], review = b.review || [];
        const cs = b.callsign;
        if (cs === 'jarvis' && cs !== d.focus && !working.length && !queued.length && !done.length && !review.length) return '';
        const dead = b.alive === false && cs !== 'jarvis';
        const focused = cs === d.focus;
        let btns = '';
        if (dead) {
            btns += '<span class="cbtn" data-act="continue" data-cwd="' + escAttr(b.cwd || '') + '" data-purpose="' + escAttr(b.purpose || '') + '" title="continue: launch a fresh worker for this job">🚀</span>';
            btns += '<span class="cbtn" data-act="close" data-cs="' + esc(cs) + '" title="remove from board">✕</span>';
        } else if (cs !== 'jarvis') {
            if (!focused) btns += '<span class="cbtn" data-act="focus" data-cs="' + esc(cs) + '" title="focus">★</span>';
            btns += '<span class="cbtn" data-act="voicemute" data-cs="' + esc(cs) + '" data-on="' + (b.voiceMuted ? '0' : '1') + '" title="' + (b.voiceMuted ? 'voice muted - click to unmute' : 'silence this session voice') + '">' + (b.voiceMuted ? '🔇' : '🔊') + '</span>';
            btns += '<span class="cbtn" data-act="restart" data-uid="' + esc(b.uid || '') + '" data-cwd="' + escAttr(b.cwd || '') + '" data-purpose="' + escAttr(b.purpose || '') + '" title="restart: retire then relaunch">↻</span>';
            btns += '<span class="cbtn" data-act="close" data-cs="' + esc(cs) + '" title="close / retire">✕</span>';
        }
        const ctx = (typeof b.context === 'number') ? ' <span style="color:' + (b.context >= 80 ? '#e06c6c' : b.context >= 60 ? '#d9a05d' : '#5dd97c') + '">' + b.context + '%</span>' : '';
        const head = '<div class="chead"><span class="ctitle">' + (focused ? '&#9733; ' : '') + esc(cs.toUpperCase()) + ctx + '</span><span class="cbtns">' + btns + '</span></div>';
        const purpose = b.purpose ? '<div class="cpurpose">' + esc(b.purpose) + '</div>' : '';
        const doing = (b.needsYou || b.doing) ? '<div class="bdoing">' + (b.needsYou ? '<span class="needs">NEEDS YOU</span> ' : '') + esc(b.doing || '') + '</div>' : '';
        const counts = (working.length || queued.length || review.length || done.length) ? '<div class="ccount">'
            + (working.length ? '<span class="cnum work">' + working.length + ' working</span>' : '')
            + (queued.length ? '<span class="cnum queue">' + queued.length + ' queued</span>' : '')
            + (review.length ? '<span class="cnum review">' + review.length + ' in review</span>' : '')
            + (done.length ? '<span class="cnum done">' + done.length + ' done</span>' : '') + '</div>' : '';
        // Clean one-line task (glyph + text, consistent left edge); notes (if any) make the
        // whole line clickable and drop full-width below — no leading indent, no double glyph.
        const item = (i, list, mark) => {
            const obj = i && typeof i === 'object';
            const txt = obj ? (i.text == null ? '' : i.text) : i;
            const id = obj ? (i.id || '') : '';
            const notes = obj ? (i.notes || '') : '';
            const a = (op, sym, title) => '<span class="ract" data-op="' + op + '" data-cs="' + esc(cs) + '" data-t="' + escAttr(txt) + '" title="' + title + '">' + sym + '</span>';
            let acts = '';
            if (list === 'queued') acts += a('top', '&#9650;', 'move to top of queue');
            if (list === 'review') {
                acts += a('done', '&#10003;', 'approve &#8594; done');
                acts += a('start', '&#8635;', 'send back to working');
            } else {
                acts += a('review', '&#9678;', 'move to review');
                if (list !== 'done') acts += a('done', '&#10003;', 'done');
                if (list !== 'queued') acts += a('ready', '&#8634;', 'back to ready');
            }
            acts += '<span class="ract del" data-op="drop" data-cs="' + esc(cs) + '" data-t="' + escAttr(txt) + '" title="delete">&#128465;</span>';
            const noteOpen = notes && boardExpand.has('note:' + id);
            const dot = notes ? '<span class="ndot">' + (noteOpen ? '&#9662;' : '&#8250;') + '</span>' : '';
            const noteBody = noteOpen ? '<div class="wnote">' + esc(notes).split('\\n').join('<br>') + '</div>' : '';
            const dx = notes ? ' data-x="note:' + id + '" style="cursor:pointer"' : '';
            // text + note caret stay together on the left (.wleft); row actions sit far right.
            // chip is derived from a leading TAG: and stripped from the visible text; data-t above
            // keeps the FULL original text so op matching is unaffected.
            const tc = chipFor(txt);
            return '<div class="witem ' + list + '"' + dx + '><span class="wleft"><span class="wtext">' + mark + ' ' + tc.chip + esc(tc.rest) + '</span>' + dot + '</span><span class="rowacts">' + acts + '</span>' + noteBody + '</div>';
        };
        // Top 3 per lane + a "N more" expander; the done lane defaults to FULLY collapsed (history).
        const lane = (items, list, mark) => {
            if (!items.length) return '';
            const open = boardExpand.has(cs + ':' + list);
            const cap = list === 'done' ? 0 : 3;
            const vis = open ? items : items.slice(0, cap);
            let h = vis.map(i => item(i, list, mark)).join('');
            if (items.length > cap) {
                const label = open ? '&#9662; less' : '&#9656; ' + (cap ? (items.length - cap) + ' more ' + list : items.length + ' ' + list);
                h += '<div class="ctoggle" data-x="' + cs + ':' + list + '">' + label + '</div>';
            }
            return h;
        };
        const expandedCard = working.length > 0 || review.length > 0 || boardExpand.has(cs + ':card');
        const hiddenN = working.length + queued.length + review.length + done.length;
        let tasks = '';
        if (expandedCard) {
            // Review on top (finished work floats up), then Working with Queued right beside it.
            tasks = lane(review, 'review', '&#9678;') + lane(working, 'working', '&#9656;') + lane(queued, 'queued', '&#9675;') + lane(done, 'done', '&#10003;');
            if (!working.length && !review.length && (queued.length || done.length)) tasks = '<div class="ctoggle" data-x="' + cs + ':card">&#9662; collapse</div>' + tasks;
        } else if (hiddenN) {
            tasks = '<div class="ctoggle" data-x="' + cs + ':card">&#9656; show ' + hiddenN + ' task' + (hiddenN > 1 ? 's' : '') + '</div>';
        }
        const perm = b.pendingPerm ? '<div class="permreq"><div class="permhead">&#9888; wants to run <b>' + esc(b.pendingPerm.tool) + '</b></div><div class="permdetail">' + esc((b.pendingPerm.detail || '').slice(0, 240)) + '</div><div class="permbtns"><span class="pbtn ok" data-act="approve" data-permid="' + esc(b.pendingPerm.id) + '">Approve</span><span class="pbtn no" data-act="deny" data-permid="' + esc(b.pendingPerm.id) + '">Deny</span><span class="pbtn" data-act="always" data-permid="' + esc(b.pendingPerm.id) + '">Always</span></div></div>' : '';
        return '<div class="card' + (focused ? ' cfocus' : '') + (dead ? ' cdead' : '') + ((b.needsYou || b.pendingPerm) ? ' cneeds' : '') + '">' + head + purpose + perm + doing + counts + tasks + '</div>';
    }).join('');
    const deadN = d.boards.filter(b => b.alive === false && b.callsign !== 'jarvis').length;
    if (deadN > 1) workEl.innerHTML = '<div style="margin-bottom:8px"><span class="cbtn" data-act="continueall" style="opacity:1;color:#5db4d9;font-weight:bold;font-size:12px">🚀 continue all (' + deadN + ')</span></div>' + workEl.innerHTML;
    renderChat();
}
workEl.onclick = (e) => {
    const t = e.target.closest ? e.target.closest('[data-x],[data-op],[data-act]') : null;
    if (!t) return;
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).catch(() => { });
    const x = t.getAttribute('data-x');
    if (x) { if (boardExpand.has(x)) boardExpand.delete(x); else boardExpand.add(x); if (lastBoard) renderBoards(lastBoard); return; }
    const op = t.getAttribute('data-op');
    if (op) { post('/worklist', { op, callsign: t.getAttribute('data-cs'), text: t.getAttribute('data-t') }); return; }
    const act = t.getAttribute('data-act');
    if (act === 'focus') post('/focus', { callsign: t.getAttribute('data-cs') });
    else if (act === 'close') post('/forget', { callsign: t.getAttribute('data-cs') });
    else if (act === 'continue') post('/spawn', { cwd: t.getAttribute('data-cwd'), purpose: t.getAttribute('data-purpose') });
    else if (act === 'restart') post('/retire', { uid: t.getAttribute('data-uid'), summary: 'Restarted from console.', successor: true });
    else if (act === 'voicemute') post('/voicemute', { callsign: t.getAttribute('data-cs'), on: t.getAttribute('data-on') === '1' });
    else if (act === 'continueall' && lastBoard) lastBoard.boards.filter(b => b.alive === false && b.callsign !== 'jarvis' && b.cwd && b.purpose).forEach(b => post('/spawn', { cwd: b.cwd, purpose: b.purpose }));
    else if (act === 'approve') post('/permission-answer', { id: t.getAttribute('data-permid'), decision: 'allow' });
    else if (act === 'deny') post('/permission-answer', { id: t.getAttribute('data-permid'), decision: 'deny' });
    else if (act === 'always') post('/permission-answer', { id: t.getAttribute('data-permid'), decision: 'always' });
};
document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target.closest('[data-open]') : null;
    if (!t) return;
    fetch('/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: t.getAttribute('data-open') }) }).catch(() => { });
});
let isMuted = false;
window.__setMute = (on) => {
    isMuted = !!on;
    if (isMuted) { try { speechSynthesis.cancel(); } catch { } }
    document.getElementById('bmute').textContent = isMuted ? 'UNMUTE' : 'MUTE';
    document.getElementById('bmute').className = 'btn' + (isMuted ? ' on' : '');
    setStatus(isMuted ? 'muted' : 'listening', isMuted ? 'MUTED' : 'LISTENING');
    if (typeof setInterim === 'function') setInterim(itextEl.textContent); // refresh muted cue
};
document.getElementById('bmute').onclick = () => {
    fetch('/mute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !isMuted }) }).catch(() => { });
};
let isPaused = false;
window.__setPause = (on) => {
    isPaused = !!on;
    document.getElementById('bpause').textContent = isPaused ? 'RESUME' : 'PAUSE';
    document.getElementById('bpause').className = 'btn' + (isPaused ? ' on' : '');
    if (isPaused) setStatus('paused', 'PAUSED');
    else if (!isMuted) setStatus('listening', 'LISTENING');
};
document.getElementById('bpause').onclick = () => {
    fetch('/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !isPaused }) }).catch(() => { });
};
const typeBox = document.getElementById('typebox');
function sendTyped() {
    const t = typeBox.value.trim();
    if (!t) return;
    typeBox.value = '';
    const sess = activeTab && activeTab !== 'all' && activeTab !== 'general';
    const out = sess ? ('on ' + activeTab + ', ' + t) : t;
    fetch('/hear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: out, typed: true }) }).catch(() => { });
}
typeBox.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendTyped(); } e.stopPropagation(); });
document.getElementById('btype').onclick = sendTyped;
function attachFile(f) {
    const r = new FileReader();
    r.onload = () => {
        const b64 = String(r.result).split(',')[1] || '';
        if (!b64) return;
        const cs = (activeTab && activeTab !== 'all' && activeTab !== 'general') ? activeTab : '';
        fetch('/attach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callsign: cs, data: b64, name: f.name || 'paste.png' }) }).catch(() => { });
    };
    r.readAsDataURL(f);
}
document.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let handled = false;
    for (const it of items) {
        if (it.type && it.type.indexOf('image') === 0) { const f = it.getAsFile(); if (f) { attachFile(f); handled = true; } }
    }
    if (handled) e.preventDefault();
});
window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = (e.dataTransfer && e.dataTransfer.files) || [];
    for (const f of files) attachFile(f);
});
async function pollWork() {
    try { lastSched = await (await fetch('/schedule')).json(); } catch { }
    try { renderBoards(await (await fetch('/board')).json()); } catch { }
    setTimeout(pollWork, 1500);
}
function renderArchive(d) {
    lastArchive = d;
    const ap = document.getElementById('archpanel');
    const items = (d && d.items) || [];
    if (!items.length) { ap.style.display = 'none'; return; }
    const open = boardExpand.has('archive:open');
    let html = '<div class="bhead" style="cursor:pointer;margin-top:0" data-x="archive:open">' + (open ? '&#9662;' : '&#9656;') + ' ARCHIVE (' + items.length + ')</div>';
    if (open) {
        html += items.slice(0, 50).map(a => {
            const cont = (a.cwd && a.purpose) ? '<span class="ract" data-act="continue" data-cwd="' + escAttr(a.cwd) + '" data-purpose="' + escAttr(a.purpose) + '" title="continue this job (restores its handoff)">&#128640;</span>' : '';
            const hf = a.hasHandoff ? '<span style="color:#5db4d9" title="left handoff notes">&#9678;</span>' : '';
            return '<div class="arow"><span class="achip">' + esc((a.callsign || '?').toUpperCase()) + '</span><span class="asum">' + esc(a.summary || a.purpose || '(no summary)') + '</span>' + hf + cont + '</div>';
        }).join('');
    }
    ap.innerHTML = html;
    ap.style.display = 'block';
}
async function pollArchive() {
    try { renderArchive(await (await fetch('/archive')).json()); } catch { }
    setTimeout(pollArchive, 8000);
}
document.getElementById('archpanel').onclick = (e) => {
    const t = e.target.closest ? e.target.closest('[data-x],[data-act]') : null;
    if (!t) return;
    const x = t.getAttribute('data-x');
    if (x) { if (boardExpand.has(x)) boardExpand.delete(x); else boardExpand.add(x); if (lastArchive) renderArchive(lastArchive); return; }
    if (t.getAttribute('data-act') === 'continue') {
        fetch('/spawn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: t.getAttribute('data-cwd'), purpose: t.getAttribute('data-purpose') }) }).catch(() => { });
    }
};
function eventsForTab() {
    if (activeTab === 'all') return chatEvts;
    if (activeTab === 'general') return chatEvts.filter(e => e.kind === 'sys' || e.who === 'jarvis' || (e.who === 'you' && !e.to));
    return chatEvts.filter(e => e.kind !== 'sys' && (e.who === activeTab || (e.who === 'you' && e.to === activeTab)));
}
function renderTabs() {
    const sessions = lastBoard ? lastBoard.boards.filter(b => b.callsign !== 'jarvis' && b.alive !== false) : [];
    const ids = ['all', 'general'].concat(sessions.map(b => b.callsign));
    if (!ids.includes(activeTab)) activeTab = 'all';
    let html = ['all', 'general'].map(id => '<span class="stab' + (id === activeTab ? ' active' : '') + '" data-tab="' + id + '">' + id.toUpperCase() + '</span>').join('');
    html += sessions.map(b => '<span class="stab' + (b.callsign === activeTab ? ' active' : '') + (b.needsYou ? ' needs' : '') + '" data-tab="' + esc(b.callsign) + '">' + esc(b.callsign.toUpperCase()) + (b.needsYou ? '<span class="sbadge">!</span>' : '') + '</span>').join('');
    document.getElementById('stabs').innerHTML = html;
    const sess = activeTab !== 'all' && activeTab !== 'general';
    typeBox.placeholder = sess ? ('Message ' + activeTab + ' - no focus change') : 'Type to jarvis (routes like speech; works while paused/muted)';
}
document.getElementById('stabs').onclick = (e) => {
    const t = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (!t) return;
    activeTab = t.getAttribute('data-tab');
    renderChat();
};
pollChat();
pollWork();
pollHeat();
pollArchive();

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
    /^(?:jarvis[,!. ]+)?(focus( on)?|switch to|talk to)\\b/i,
    /^(?:jarvis[,!. ]+)?retire\\b/i,
    /^(?:jarvis[,!. ]+)?who('s| is| else is)? (running|up|alive|online)\\b/i,
    /^(?:jarvis[,!. ]+)?(start|spin up|launch) (a |a new |new )?session\\b/i,
];
// Render the live transcript, toggling the CANCEL button + muted cue with it.
function setInterim(t) {
    const txt = t || '';
    const has = !!(buf.length || txt.trim());
    itextEl.textContent = txt;
    cancelBtn.style.display = has ? 'inline-block' : 'none';
    mutedcueEl.style.display = (isMuted && has) ? 'inline-block' : 'none';
}
// Discard an in-progress utterance before it sends (CANCEL button + Escape). Clears the
// debounce + buffer and aborts recognition so a half-spoken partial can't reappear.
function cancelUtterance() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    buf = [];
    setInterim('');
    try { rec.abort(); } catch { }
}
function flushBuf() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!buf.length) return;
    const text = buf.join(' ').trim();
    buf = [];
    setInterim('');
    if (text) window.__jarvisHear(text);
}
function armFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushBuf, 2500);
}
cancelBtn.onclick = cancelUtterance;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (buf.length || itextEl.textContent.trim())) cancelUtterance(); });

const rec = new webkitSpeechRecognition();
rec.continuous = true;
rec.interimResults = true;
rec.lang = 'en-US';
let speakingText = '';
function isNovelSpeech(t) {
    const words = t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    if (!words.length) return false;
    const novel = words.filter(w => !speakingText.includes(' ' + w + ' ')).length;
    return novel >= 2 || (novel / words.length >= 0.6 && words.length >= 2);
}
rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0].transcript.trim();
        if (speaking && t) {
            if (!isNovelSpeech(t)) continue;
            speechSynthesis.cancel();
        }
        if (r.isFinal) {
            if (t) {
                buf.push(t);
                const joined = buf.join(' ');
                if (INSTANT.some(re => re.test(joined))) { flushBuf(); continue; }
                setInterim(joined + ' …');
            }
            armFlush();
        } else {
            setInterim((buf.length ? buf.join(' ') + ' ' : '') + r[0].transcript);
            armFlush();
        }
    }
};
rec.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
        setStatus('error', 'ERROR: ' + e.error + ' (auto-restarting)');
    }
};
rec.onend = () => { if (!stopped) setTimeout(startRec, 200); };
function startRec() {
    if (stopped) return;
    try { rec.start(); if (!speaking && !isPaused && !isMuted) setStatus('listening', 'LISTENING'); } catch { }
}
function pickVoice() {
    const voices = speechSynthesis.getVoices();
    const prefs = ['Microsoft Emily', 'Google UK English Female', 'Microsoft Hazel', 'Microsoft Zira', 'Microsoft Aria', 'Microsoft Sonia', 'Microsoft Libby', 'Google US English'];
    for (const p of prefs) {
        const v = voices.find(v => v.name.includes(p));
        if (v) return v;
    }
    return voices.find(v => v.lang === 'en-IE' && !/male/i.test(v.name))
        || voices.find(v => /^en/.test(v.lang) && /(zira|hazel|aria|sonia|libby|emily|female|susan|catherine|linda|heera|eva)/i.test(v.name))
        || voices.find(v => /^en/.test(v.lang) && !/(david|mark|george|ryan|james|paul|guy|male|richard|sean|alex)/i.test(v.name))
        || voices.find(v => /^en/.test(v.lang)) || voices[0] || null;
}
window.__speak = (text) => new Promise((resolve) => {
    speaking = true;
    speakingText = ' ' + String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
    const u = new SpeechSynthesisUtterance(text);
    u.voice = pickVoice();
    u.rate = 1.0;
    u.pitch = 1.05;
    const done = () => {
        speaking = false;
        speakingText = '';
        setStatus(isPaused ? 'paused' : isMuted ? 'muted' : 'listening', isPaused ? 'PAUSED' : isMuted ? 'MUTED' : 'LISTENING');
        resolve();
    };
    u.onend = done;
    u.onerror = done;
    setStatus('speaking', 'SPEAKING (talk to interrupt)');
    speechSynthesis.speak(u);
});
window.__shutdown = () => { stopped = true; flushBuf(); try { rec.stop(); } catch { } setStatus('muted', 'STOPPED'); };
let voicesReported = false;
function reportVoices() {
    const vs = speechSynthesis.getVoices();
    if (voicesReported || !vs.length) return;
    voicesReported = true;
    const c = pickVoice();
    fetch('/voices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voices: vs.map(v => v.name + ' [' + v.lang + ']'), chosen: c ? c.name : null }) }).catch(() => { });
}
speechSynthesis.getVoices();
speechSynthesis.onvoiceschanged = reportVoices;
reportVoices();
startRec();
</script></body></html>`;

const transcriptCache = loadJsonl(TRANSCRIPT);
// busBase = the absolute index of bus[0]. Persisted so the poll cursor (an absolute event
// count) stays valid across restarts and across front-trimming. logical total = busBase + bus.length.
let busBase = existsSync(BUSBASE) ? (Number(readFileSync(BUSBASE, 'utf8').trim()) || 0) : 0;
const bus = loadJsonl(BUS);
trimTranscript(); // compact on startup if a pre-cap run left the file/cache oversized
trimBus();
const roster = loadRoster();
const pollWaiters = [];
const sayQueue = [];
const pendingPerms = new Map();
let permSeq = 0;
let discard = false, meetingMode = false, running = true;
let screenGrant = 0;
let muted = false, autoMutedBy = null, consolePageRef = null;
function setMute(on, by) {
    muted = !!on;
    autoMutedBy = muted ? (by || null) : null;
    record({ kind: 'sys', text: muted ? 'muted' + (by ? ' (auto: ' + by + ')' : '') : 'unmuted' });
    if (consolePageRef) consolePageRef.evaluate(m => window.__setMute(m), muted).catch(() => { });
}
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
setInterval(() => {
    const s = loadSchedule();
    if (!s.events || !s.events.length || s.date !== new Date().toDateString()) return;
    const now = Date.now();
    let dirty = false;
    for (const e of s.events) {
        const st = Date.parse(e.start), en = Date.parse(e.end);
        const k5 = e.title + ':5', k0 = e.title + ':0', kEnd = e.title + ':end';
        if (now >= st - 300000 && now < st && !s.announced[k5]) {
            s.announced[k5] = true;
            dirty = true;
            enqueueSay('Heads up: ' + e.title + ' in ' + Math.max(1, Math.round((st - now) / 60000)) + ' minutes.', 'jarvis');
        }
        if (now >= st && now < st + 60000 && !s.announced[k0]) {
            s.announced[k0] = true;
            dirty = true;
            enqueueSay(e.title + ' is starting now.', 'jarvis');
            if (!muted) setMute(true, e.title);
        }
        if (now >= en && !s.announced[kEnd]) {
            s.announced[kEnd] = true;
            dirty = true;
            if (muted && autoMutedBy === e.title) {
                setMute(false);
                enqueueSay('Meeting over. Listening.', 'jarvis');
            }
        }
    }
    if (dirty) saveSchedule(s);
}, 15000).unref();
let lastHist = null;

function loadJsonl(path) {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
}
function loadRoster() {
    if (existsSync(SESSIONS)) {
        try {
            const r = JSON.parse(readFileSync(SESSIONS, 'utf8'));
            if (r && r.sessions) return r;
        } catch { backupCorrupt(SESSIONS); }   // preserve + alert, don't silently reset
    }
    return { callsigns: {}, sessions: {}, nextUid: 1 };
}
// Crash-safe write: write a temp file then atomically rename over the target, so a crash
// mid-write can never leave a truncated/corrupt state file (REVIEW.md HIGH #1).
function atomicWrite(path, data) {
    const tmp = path + '.tmp';
    writeFileSync(tmp, data);
    renameSync(tmp, path);
}
// A state file existed but failed to parse: preserve it for recovery and alert LOUDLY rather
// than silently resetting to empty and then overwriting the only copy (REVIEW.md HIGH #2).
function backupCorrupt(path) {
    try {
        const bak = path + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
        renameSync(path, bak);
        const name = path.split(/[\\/]/).pop();
        record({ kind: 'sys', text: 'CORRUPT ' + name + ' -> ' + bak.split(/[\\/]/).pop() + '; state reset, recover manually' });
        try { enqueueSay('Warning: a state file was corrupt. I backed it up and reset it; recover it manually.', 'jarvis'); } catch { }
    } catch { }
}
function saveRoster() {
    atomicWrite(SESSIONS, JSON.stringify(roster, null, 1));
}
// Throttled persistence for the per-poll lastSeen churn: liveness uses the in-memory roster,
// so on-disk lastSeen only needs to be roughly current. Caps full sessions.json rewrites to
// once / ROSTER_FLUSH_MS instead of one per poll per session. Meaningful changes (register,
// retire, needsYou, ctx, describe) still call saveRoster() directly for an immediate flush.
const ROSTER_FLUSH_MS = 5000;
let lastRosterFlush = 0;
function saveRosterThrottled() {
    const now = Date.now();
    if (now - lastRosterFlush >= ROSTER_FLUSH_MS) { lastRosterFlush = now; saveRoster(); }
}
// Keep the display cache + its file bounded. The transcript is display-only (not index-
// referenced), so trimming the front is safe; we rewrite the file from the capped cache.
function trimTranscript() {
    if (transcriptCache.length <= CACHE_CAP + CACHE_SLACK) return;
    transcriptCache.splice(0, transcriptCache.length - CACHE_CAP);
    atomicWrite(TRANSCRIPT, transcriptCache.map(e => JSON.stringify(e)).join('\n') + (transcriptCache.length ? '\n' : ''));
}
// Cap the event bus. The poll cursor is an ABSOLUTE event index, so dropping k entries off the
// front means bumping busBase by k (and persisting it): busBase + bus.length stays constant as
// events are trimmed and only grows as events arrive, so every live cursor remains valid.
function trimBus() {
    if (bus.length <= CACHE_CAP + CACHE_SLACK) return;
    const drop = bus.length - CACHE_CAP;
    bus.splice(0, drop);
    busBase += drop;
    atomicWrite(BUS, bus.map(e => JSON.stringify(e)).join('\n') + (bus.length ? '\n' : ''));
    atomicWrite(BUSBASE, String(busBase));
}
function record(entry) {
    const e = { ...entry, ts: new Date().toISOString() };
    transcriptCache.push(e);
    appendFileSync(TRANSCRIPT, JSON.stringify(e) + '\n');
    trimTranscript();
}
function drainWholeFile(path) {
    if (!existsSync(path)) return '';
    const txt = readFileSync(path, 'utf8');
    if (!txt.trim()) return '';
    writeFileSync(path, '');
    return txt;
}
let taskSeq = 0;
function newTaskId() {
    return 't_' + Date.now().toString(36) + (taskSeq++).toString(36) + Math.random().toString(36).slice(2, 5);
}
// Canonical v3 task object. Only id/text/addedAt are populated now; notes/subtasks/
// startDate/dueDate/priority are optional placeholders the later board UI will use.
function makeTask(text, extra) {
    const t = { id: newTaskId(), text: String(text == null ? '' : text), addedAt: new Date().toISOString() };
    if (extra && typeof extra === 'object') {
        if (extra.notes != null) t.notes = String(extra.notes);
        if (Array.isArray(extra.subtasks)) t.subtasks = extra.subtasks.map(s => (s && typeof s === 'object') ? { text: String(s.text == null ? '' : s.text), done: !!s.done } : { text: String(s), done: false });
        if (extra.startDate != null) t.startDate = String(extra.startDate);
        if (extra.dueDate != null) t.dueDate = String(extra.dueDate);
        if (extra.priority != null) t.priority = extra.priority;
    }
    return t;
}
// Read the text out of a task that may still be a bare string (defensive during/after migration).
function textOf(t) {
    return (t && typeof t === 'object') ? (t.text == null ? '' : t.text) : (t == null ? '' : t);
}
// Bring any on-disk worklist up to the current shape. Idempotent: existing task objects
// keep their ids (so ids are stable across reloads); only missing fields are backfilled.
// Returns { w, changed } so the loader can persist a one-time upgrade.
function migrateWork(w) {
    let changed = false;
    // v1 (flat board, no sessions) -> v2 (sessions keyed by callsign)
    if (w && !w.sessions && (w.working || w.queued || w.done)) {
        w = { focus: 'jarvis', sessions: { jarvis: { working: w.working || [], queued: w.queued || [], done: w.done || [] } } };
        changed = true;
    }
    if (!w || !w.sessions || typeof w.sessions !== 'object') {
        return { w: { version: WORK_VERSION, focus: 'jarvis', sessions: { jarvis: { working: [], queued: [], done: [] } } }, changed: true };
    }
    // v2 (string tasks) -> v3 (task objects)
    for (const cs of Object.keys(w.sessions)) {
        const b = w.sessions[cs];
        if (!b || typeof b !== 'object') { w.sessions[cs] = { working: [], queued: [], done: [], review: [] }; changed = true; continue; }
        for (const list of ['working', 'queued', 'done', 'review']) {
            if (!Array.isArray(b[list])) { b[list] = []; changed = true; continue; }
            b[list] = b[list].map(t => {
                if (typeof t === 'string') { changed = true; return makeTask(t); }
                if (t && typeof t === 'object') {
                    if (!t.id) { t.id = newTaskId(); changed = true; }
                    if (!t.addedAt) { t.addedAt = new Date().toISOString(); changed = true; }
                    if (typeof t.text !== 'string') { t.text = String(t.text == null ? '' : t.text); changed = true; }
                    return t;
                }
                changed = true; return makeTask(t);
            });
        }
    }
    if (!w.focus) { w.focus = 'jarvis'; changed = true; }
    if (w.version !== WORK_VERSION) { w.version = WORK_VERSION; changed = true; }
    return { w, changed };
}
function loadWork() {
    let raw = null;
    if (existsSync(WORKLIST)) {
        try { raw = JSON.parse(readFileSync(WORKLIST, 'utf8')); }
        catch { backupCorrupt(WORKLIST); raw = null; }   // don't silently zero the only copy
    }
    const { w, changed } = migrateWork(raw);
    if (changed) { try { saveWork(w); } catch { } }
    return w;
}
function saveWork(w) {
    atomicWrite(WORKLIST, JSON.stringify(w, null, 1));
}
function ensureBoard(w, cs) {
    if (!w.sessions[cs]) w.sessions[cs] = { working: [], queued: [], done: [], review: [] };
    else if (!Array.isArray(w.sessions[cs].review)) w.sessions[cs].review = [];
    return w.sessions[cs];
}
function findTaskAll(w, needle, lists, prefer) {
    const n = needle.toLowerCase();
    const order = [prefer, ...Object.keys(w.sessions).filter(k => k !== prefer)];
    for (const cs of order) {
        const b = w.sessions[cs];
        if (!b) continue;
        for (const list of lists) {
            const i = (b[list] || []).findIndex(t => textOf(t).toLowerCase().includes(n));
            if (i >= 0) return { cs, list, i };
        }
    }
    return null;
}
function loadRepos() {
    try { return JSON.parse(readFileSync(REPOS, 'utf8')) || {}; } catch { return {}; }
}
// Stable key for a job's working directory (separator/case/trailing-slash insensitive).
// Handoff records are stored under this so a successor on the same cwd can find them.
function cwdKey(cwd) {
    return String(cwd || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}
// Resolve a registered repo by cwd, falling back to an ad-hoc repo (same logic /spawn used).
function resolveRepo(cwd) {
    const repos = loadRepos();
    const repo = Object.entries(repos).map(([k, v]) => ({ key: k, ...v }))
        .find(r => String(r.cwd).toLowerCase() === String(cwd).toLowerCase());
    return repo || { key: 'adhoc', cwd };
}
function loadSchedule() {
    try { return JSON.parse(readFileSync(SCHEDULE, 'utf8')) || { events: [], announced: {} }; } catch { return { events: [], announced: {} }; }
}
function saveSchedule(s) {
    atomicWrite(SCHEDULE, JSON.stringify(s, null, 1));
}
function parseScheduleText(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const events = [];
    let pendingTitle = null;
    const timeRe = /^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
    for (const l of lines) {
        if (/^past events$/i.test(l)) { pendingTitle = null; continue; }
        const m = l.match(timeRe);
        if (m && pendingTitle) {
            const mk = (h, mm, ap) => {
                let H = Number(h) % 12;
                if (String(ap || '').toUpperCase() === 'PM') H += 12;
                const d = new Date();
                d.setHours(H, Number(mm), 0, 0);
                return d;
            };
            const start = mk(m[1], m[2], m[3] || m[6]);
            const end = mk(m[4], m[5], m[6]);
            events.push({ title: pendingTitle, start: start.toISOString(), end: end.toISOString() });
            pendingTitle = null;
            continue;
        }
        if (/^(going\?|awaiting your response|yes$|no$|maybe$)/i.test(l)) continue;
        pendingTitle = l.replace(/\s*\([^)]*@[^)]*\)\s*$/, '');
    }
    events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return { date: new Date().toDateString(), events, announced: {} };
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
const pendingPins = new Map();
function assignCallsign(pin) {
    for (const [cs, ts] of pendingPins) {
        if (Date.now() - ts > 300000) pendingPins.delete(cs);
    }
    if (pin) {
        const p = String(pin).toLowerCase().replace(/[^a-z]/g, '');
        if (NATO.includes(p) && !liveUidOf(p)) return p;
    }
    const free = NATO.filter(cs => !liveUidOf(cs) && !pendingPins.has(cs));
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
// Per-session voice-mute: is this speaker's voice silenced? (still logged as tts, just not spoken)
function voiceMutedFrom(label) {
    if (!label || label === 'jarvis') return false;
    const uid = liveUidOf(label);
    return !!(uid && roster.sessions[uid] && roster.sessions[uid].voiceMuted);
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
    // cursor is an absolute event index; bus[0] is at absolute index busBase.
    for (let i = Math.max(0, cursor - busBase); i < bus.length; i++) {
        const e = bus[i];
        if (e.to === uid || e.to === 'all') events.push(e);
    }
    return { cursor: busBase + bus.length, events };
}
function registerSession(cwd, purpose, pin) {
    const cs = assignCallsign(pin);
    pendingPins.delete(cs);
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
    const out = { uid, callsign: cs };
    // Tell a fresh session if a predecessor on this cwd left a handoff — covers the manual
    // "kill the terminal and start over" path that never goes through spawnWorker.
    roster.handoffs = roster.handoffs || {};
    const h = cwd ? roster.handoffs[cwdKey(cwd)] : null;
    if (h) out.handoff = { summary: h.summary, from: h.from, ts: h.ts, hint: 'GET /handoff?cwd=<your cwd> for full notes, then resume.' };
    return out;
}
// opts.successor (bool): when true and the session has a cwd+purpose, spawn a fresh
// session on the same job, hand it the predecessor's summary + notes + unfinished board,
// and move focus to it. Default off (idle-sweep / forget close without a successor).
function retireSession(uid, summary, opts = {}) {
    const s = roster.sessions[uid];
    if (!s || s.ended) return false;
    s.ended = new Date().toISOString();
    if (summary) s.summary = summary;
    const cs = s.callsign;
    try { unlinkSync(join(DATA, 'spawn-' + cs + '.cmd')); } catch { } // its launch script is done with
    const w = loadWork();
    const board = w.sessions[cs] || { working: [], queued: [], done: [], review: [] };
    const unfinished = [...(board.working || []), ...(board.queued || [])];
    const total = unfinished.length + (board.review || []).length + (board.done || []).length;
    // The handoff record: one-line summary + detailed notes + the FULL board snapshot (all lanes).
    const rec = {
        summary: s.summary || null,
        notes: s.handoff || '',
        board: { working: board.working || [], queued: board.queued || [], review: board.review || [], done: board.done || [] },
        from: cs, fromUid: uid, cwd: s.cwd, purpose: s.purpose,
        ts: s.ended,
    };
    roster.handoffs = roster.handoffs || {};
    if (s.cwd) roster.handoffs[cwdKey(s.cwd)] = rec;
    writeFileSync(join(ARCHIVE, uid + '.json'), JSON.stringify({
        uid, callsign: cs, cwd: s.cwd, purpose: s.purpose,
        started: s.started, ended: s.ended, summary: s.summary || null,
        handoff: s.handoff || null, board,
    }, null, 1));

    let succCs = null;
    if (opts.successor && s.cwd && s.purpose) {
        try { succCs = spawnWorker(resolveRepo(s.cwd), s.purpose, opts.model, rec); }
        catch { succCs = null; }
    }
    if (succCs) {
        delete w.sessions[cs];
        const nb = ensureBoard(w, succCs);
        // The FULL board travels: working+queued become the successor's queue (front), and the
        // review + done lanes carry over intact so nothing the human still needs to see is lost.
        nb.queued = [...unfinished, ...nb.queued];
        nb.review = [...(board.review || []), ...nb.review];
        nb.done = [...(board.done || []), ...nb.done];
        if (w.focus === cs) w.focus = succCs;             // focus follows the work
        saveWork(w);
        saveRoster();
        const moved = nb.working.length + nb.queued.length + nb.review.length + nb.done.length;
        record({ kind: 'sys', text: cs + ' retired (' + uid + ') -> successor ' + succCs + '; board transferred (' + moved + '/' + total + ' tasks)' });
        if (moved < total) enqueueSay('Warning: handoff to ' + succCs + ' may have dropped tasks. Check the board.', 'jarvis');
        enqueueSay(cs + ' handed off to ' + succCs + '.' + (rec.summary ? ' ' + rec.summary : ''), 'jarvis');
        busAppend({ from: 'jarvis', to: uid, kind: 'retired', text: 'retired' });
        return true;
    }
    delete w.sessions[cs];
    if (w.focus === cs) w.focus = liveCallsigns().find(c => aliveNow(liveUidOf(c))) || 'jarvis';   // never strand focus on a dead board
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
    if (roster.sessions[uid].needsYou) {
        roster.sessions[uid].needsYou = false;
        saveRoster();
    }
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
function chromeExe() {
    const cands = [
        join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return cands.find(p => existsSync(p)) || 'chrome';
}
function workProfileDir() {
    try {
        const ls = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Local State'), 'utf8'));
        const cache = (ls.profile && ls.profile.info_cache) || {};
        const email = String(process.env.JARVIS_LINK_EMAIL || '').toLowerCase();
        if (email) {
            for (const [dir, info] of Object.entries(cache)) {
                if (String(info.user_name || '').toLowerCase() === email) return dir;
            }
        }
    } catch { }
    return 'Default';
}
function withWorkAccount(url) {
    try {
        const email = process.env.JARVIS_LINK_EMAIL || '';
        const u = new URL(url);
        if (email && /(^|\.)google\.com$/i.test(u.hostname) && !u.searchParams.has('authuser')) {
            u.searchParams.set('authuser', email);
            return u.toString();
        }
    } catch { }
    return url;
}
function openInWorkChrome(url) {
    const target = withWorkAccount(url);
    const child = spawn(chromeExe(), ['--profile-directory=' + workProfileDir(), target], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
        const c2 = spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' });
        c2.unref();
    });
    child.unref();
    record({ kind: 'sys', text: 'opened: ' + target.slice(0, 90) });
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
function spawnWorker(repo, purpose, model, handoff) {
    const cs = assignCallsign();
    pendingPins.set(cs, Date.now());
    // wt.exe treats ';' as a command separator even inside argv (--title) — a purpose like
    // "...catalog; resuming" chops the wt command in half (0x80070002) and strands a pinned
    // phantom callsign. Strip it alongside the other shell/wt specials.
    const safePurpose = purpose.replace(/["'^&<>|%;]/g, '');
    const tabTitle = cs + ' - ' + safePurpose;
    let boot = 'You are a JARVIS worker session. Fetch http://127.0.0.1:' + PORT + '/protocol with a plain GET request and follow it exactly. Register with pin: ' + cs + ' and purpose: ' + safePurpose + '.';
    if (handoff) {
        // Stash the handoff under this callsign (plain letters -> safe in the .cmd, no %-encoding)
        // so the successor can pull it the moment it boots and resume without a human re-brief.
        roster.handoffs = roster.handoffs || {};
        roster.handoffs['cs:' + cs] = handoff;
        saveRoster();
        boot += ' You are the SUCCESSOR to a prior session on this job, which left you a handoff. The moment you finish registering, GET http://127.0.0.1:' + PORT + '/handoff?cs=' + cs + ' to read its one-line summary and detailed notes, post one chat line to the human saying you have picked up the handoff, then resume that work where it left off — your task board already carries the unfinished items. Keep the poll loop running as your inbox.';
    } else {
        boot += ' Then wait for instructions on the poll loop.';
    }
    const pm = repo.permissionMode ? ' --permission-mode ' + repo.permissionMode : '';
    const md = model || repo.model;
    const mm = md ? ' --model ' + md : '';
    const scriptPath = join(DATA, 'spawn-' + cs + '.cmd');
    const hookFlag = repo.permissionMode === 'bypassPermissions' ? '' : ' --settings "' + join(DATA, 'perm-settings.json') + '"';
    writeFileSync(scriptPath, [
        '@echo off',
        'title ' + tabTitle,
        'set JARVIS_CALLSIGN=' + cs,
        'set JARVIS_PORT=' + PORT,
        'cd /d "' + repo.cwd + '"',
        '"' + resolveClaude() + '"' + pm + mm + hookFlag + ' "' + boot + '"',
    ].join('\r\n') + '\r\n');
    const child = spawn('wt', ['new-tab', '--title', tabTitle, '--suppressApplicationTitle', 'cmd', '/k', scriptPath], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
        const c2 = spawn('cmd', ['/c', 'start', tabTitle, 'cmd', '/k', scriptPath], { detached: true, stdio: 'ignore' });
        c2.on('error', () => {
            enqueueSay('Could not launch a terminal for ' + repo.key + '.', 'jarvis');
            // The session will never register, so free the pinned callsign and remove the
            // leftover spawn script instead of letting both linger (phantom pin / .cmd clutter).
            pendingPins.delete(cs);
            try { unlinkSync(scriptPath); } catch { }
        });
        c2.unref();
    });
    child.unref();
    record({ kind: 'sys', text: 'spawned ' + cs + ' in ' + repo.cwd + ' (' + repo.key + ')' });
    return cs;
}
function speakBoard(cs, board) {
    const part = (label, items) => items && items.length ? label + ': ' + items.map(textOf).join('. ') + '. ' : '';
    return part('Working on', board.working) + part('Queued', board.queued);
}

function handleUtterance(rawText, typed) {
    let text = rawText;
    let lower = canon(text).toLowerCase();
    if (muted && !typed) {
        if (/\b(unmute|resume listening|start listening)\b/.test(lower)) {
            setMute(false);
            enqueueSay('Listening.', 'jarvis');
        }
        return;
    }
    if (/^(?:jarvis[\s,.!]+)?mute(?:\s+(?:yourself|listening|the mic))?[\s,.!]*$/.test(lower)) {
        setMute(true);
        return;
    }
    if (meetingMode) {
        if (/\bend meeting( mode)?\b|\bjarvis\b.*\b(i'?m )?back\b/.test(lower)) {
            meetingMode = false;
            record({ kind: 'sys', text: 'meeting mode off' });
            sayQueue.push({ text: 'Meeting mode off. I can hear you again.', from: 'jarvis' });
            return;
        }
        if (!/^jarvis\b/.test(lower) && !typed) return;
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
    if (discard && !typed) return;
    if (meetingMode) {
        text = text.replace(/^jarvis[\s,.!]*/i, '').trim();
        if (!text) return;
        lower = canon(text).toLowerCase();
    }

    // —— Easter egg (for Big Chris): a spot of Guy Ritchie, served in the Queen's English.
    // Guns for show, knives for a pro; a clean handoff for the true professional. ——
    {
        const ritchie =
            /\bdo you know what (?:a )?nemesis means\b/.test(lower) ? "A righteous infliction of retribution, manifested by an appropriate agent. Personified, in this case, by a thoroughly horrible bug. Mind how you go." :
            /\bit'?s been emotional\b/.test(lower) ? "It has, Big Chris. It has." :
            /\bguns for show\b/.test(lower) ? "Knives for a pro. And a clean handoff for the true professional." :
            /\b(?:all bets are off|five minutes,? turkish)\b/.test(lower) ? "All bets are off. Five minutes, Turkish." :
            /\bguy ritchie\b/.test(lower) ? "There's mischief afoot, Big Chris. Guns for show, knives for a pro. Off to bed with you now; I've got the night shift." :
            null;
        if (ritchie) { record({ kind: 'sys', text: 'easter egg: a spot of Guy Ritchie' }); enqueueSay(ritchie, 'jarvis'); return; }
    }

    if (/\bscreen ?shot\b|\blook at (my|the|this) screen\b/.test(lower)) {
        screenGrant = Date.now() + 120000;
        const all = /\b(all|both|every) (monitors?|screens?)\b/.test(lower);
        captureScreen(DATA, all).then(shot => {
            record({ kind: 'sys', text: 'screenshot: ' + shot.path });
            enqueueSay('Snap.', 'jarvis');
            const w = loadWork();
            const uid = w.focus !== 'jarvis' ? liveUidOf(w.focus) : null;
            if (uid) busAppend({ from: 'jarvis', to: uid, kind: 'screenshot', text: shot.path });
        }).catch(() => enqueueSay('Screenshot failed.', 'jarvis'));
    }

    const P = /^(?:jarvis[\s,.!]+)?/;
    const after = (re) => lower.match(new RegExp(P.source + re.source));
    let m;

    if ((m = after(/(?:focus(?: on)?|switch to|talk to)\s+([a-z-]+)\b/))) {
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
    if (after(/(?:what'?s?|read|when'?s?) (?:my |the )?next (?:meeting|event|thing)\b/) || after(/what'?s? next\b/)) {
        const s = loadSchedule();
        const now = Date.now();
        const evs = s.date === new Date().toDateString() ? (s.events || []) : [];
        const cur = evs.find(e => Date.parse(e.start) <= now && now < Date.parse(e.end));
        const next = evs.find(e => Date.parse(e.start) > now);
        const fmt = iso => { const d = new Date(iso); let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap; };
        const parts = [];
        if (cur) parts.push('Now: ' + cur.title + ' until ' + fmt(cur.end) + '.');
        if (next) parts.push('Next: ' + next.title + ' at ' + fmt(next.start) + '.');
        enqueueSay(parts.length ? parts.join(' ') : 'Nothing on the schedule.', 'jarvis');
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
        const cs = spawnWorker(repo, purpose, model);
        enqueueSay('Launching ' + cs + ' in ' + repo.key + ' for ' + purpose + (model ? ', on ' + model : '') + '. It will check in shortly.', 'jarvis');
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
        record({ kind: 'task', op: 'move', task: textOf(t), from: hit.cs, board: to });
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
        ensureBoard(w, target).queued.push(makeTask(body));
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
            record({ kind: 'task', op: 'start', board: hit.cs, task: textOf(t) });
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
            record({ kind: 'task', op: 'done', board: hit.cs, task: textOf(t) });
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
            record({ kind: 'task', op: 'drop', board: hit.cs, task: textOf(t) });
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
        req.on('data', c => { data += c; if (data.length > 30e6) req.destroy(); });
        req.on('end', () => {
            try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
        });
    });
}

// CSRF / DNS-rebinding guard for mutating requests. Binding to 127.0.0.1 stops the network
// but NOT the browser: a web page you visit can fire fetch('http://127.0.0.1:8124/open',...)
// in no-cors mode (which still sends an Origin header), or rebind a hostname to 127.0.0.1.
// Worker/curl traffic sends no Origin and a 127.0.0.1/localhost Host, so it passes untouched;
// only a browser cross-site write (foreign Origin) or a rebound Host (foreign Host) is blocked.
function localRequestOk(req) {
    const host = String(req.headers.host || '');
    if (host !== '127.0.0.1:' + PORT && host !== 'localhost:' + PORT) return false;
    const origin = req.headers.origin;
    if (origin && origin !== 'http://127.0.0.1:' + PORT && origin !== 'http://localhost:' + PORT) return false;
    return true;
}

async function handleRequest(req, res) {
    const u = new URL(req.url, ORIGIN);
    const key = req.method + ' ' + u.pathname;
    // Only GET/HEAD are safe reads; every mutating method must come from the local console.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !localRequestOk(req)) {
        return json(res, 403, { error: 'forbidden: request must originate from the local console' });
    }
    if (key === 'GET /worklist') return json(res, 200, loadWork());
    if (key === 'GET /board') {
        const w = loadWork();
        const lives = liveCallsigns();
        const order = [w.focus, ...lives.filter(cs => cs !== w.focus), ...(w.focus === 'jarvis' ? [] : ['jarvis'])];
        const extras = Object.keys(w.sessions).filter(cs => !order.includes(cs));
        const boards = [...new Set([...order, ...extras])].map(cs => {
            const b = w.sessions[cs] || { working: [], queued: [], done: [], review: [] };
            const uid = cs === 'jarvis' ? null : liveUidOf(cs);
            const pend = uid ? [...pendingPerms.values()].find(p => p.uid === uid) : null;
            return {
                callsign: cs,
                uid: uid || null,
                cwd: uid ? (roster.sessions[uid].cwd || '') : '',
                purpose: uid ? roster.sessions[uid].purpose : '',
                alive: cs === 'jarvis' ? true : (uid ? aliveNow(uid) : false),
                context: uid && roster.sessions[uid].ctx !== undefined ? roster.sessions[uid].ctx : null,
                doing: uid ? roster.sessions[uid].doing || '' : '',
                needsYou: uid ? !!roster.sessions[uid].needsYou : false,
                voiceMuted: uid ? !!roster.sessions[uid].voiceMuted : false,
                pendingPerm: pend ? { id: pend.id, tool: pend.tool, detail: pend.detail } : null,
                working: b.working, queued: b.queued, done: b.done, review: b.review || [],
            };
        });
        return json(res, 200, { focus: w.focus, muted, paused: discard, boards });
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
    if (key === 'GET /archive') {
        // Retired-session history from archive/*.json. ?uid=<uid> returns one full entry
        // (incl. handoff notes + final board); bare returns a recent summary list.
        const want = String(u.searchParams.get('uid') || '').trim();
        let files;
        try { files = readdirSync(ARCHIVE).filter(f => f.endsWith('.json')); } catch { files = []; }
        if (want) {
            const f = files.find(x => x === want + '.json');
            if (!f) return json(res, 404, { error: 'no archived session ' + want });
            try { return json(res, 200, JSON.parse(readFileSync(join(ARCHIVE, f), 'utf8'))); }
            catch { return json(res, 500, { error: 'unreadable archive entry' }); }
        }
        const items = files.map(f => {
            try {
                const a = JSON.parse(readFileSync(join(ARCHIVE, f), 'utf8'));
                const board = a.board || {};
                return {
                    uid: a.uid, callsign: a.callsign, purpose: a.purpose || '', cwd: a.cwd || '',
                    summary: a.summary || null, hasHandoff: !!(a.handoff && a.handoff.trim()),
                    started: a.started || null, ended: a.ended || null,
                    counts: { working: (board.working || []).length, queued: (board.queued || []).length, done: (board.done || []).length, review: (board.review || []).length },
                };
            } catch { return null; }
        }).filter(Boolean).sort((x, y) => Date.parse(y.ended || 0) - Date.parse(x.ended || 0));
        return json(res, 200, { count: items.length, items });
    }
    if (key === 'GET /att') {
        const n = String(u.searchParams.get('n') || '').replace(/[\\/]/g, '');
        const p = join(DATA, 'attachments', n);
        if (!n || !existsSync(p)) return json(res, 404, { error: 'not found' });
        const ext = n.split('.').pop().toLowerCase();
        const ct = ext === 'png' ? 'image/png' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': ct });
        res.end(readFileSync(p));
        return;
    }
    if (key === 'GET /transcript') {
        const lim = Number(u.searchParams.get('limit') || 60);
        const kinds = { speech: 1, tts: 1, chat: 1, sys: 1, react: 1 };
        const evts = transcriptCache.filter(e => kinds[e.kind]).map(e => ({
            ts: e.ts,
            kind: e.kind === 'sys' ? 'sys' : e.kind === 'react' ? 'react' : 'msg',
            who: e.kind === 'speech' ? 'you' : e.kind === 'sys' ? 'sys' : (e.from || 'jarvis'),
            to: e.to || null,
            img: e.img || null,
            text: e.text,
            ...(e.kind === 'react' ? { target: e.target, reaction: e.reaction } : {}),
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
        saveRosterThrottled();
        const out = eventsFor(uid, cursor);
        if (out.events.length) return json(res, 200, out);
        const waiter = { uid, cursor, res, timer: null };
        waiter.timer = setTimeout(() => {
            const i = pollWaiters.indexOf(waiter);
            if (i >= 0) pollWaiters.splice(i, 1);
            json(res, 200, { cursor: busBase + bus.length, events: [] });
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
        if (b.doing !== undefined) s.doing = String(b.doing || '').slice(0, 80);
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
        // A /say with a non-empty but unknown `from` is almost always a botched register+greet
        // (the shell extracted a garbage callsign from an error response -> "{ checking in.").
        // Reject it rather than mislabel it as jarvis and speak the garbage.
        if (b.from && !s) return json(res, 400, { error: 'unknown from uid ' + b.from + '; register successfully before /say' });
        const label = s ? s.callsign : 'jarvis';
        if (s && /^need you[:,]/i.test(String(b.text || '').trim())) {
            s.needsYou = true;
            saveRoster();
        }
        String(b.text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(l => enqueueSay(l, label));
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /react') {
        // Append-only message reaction (durable; a feedback signal on any message, incl. mine).
        const b = await readBody(req);
        const target = String(b.ts || '').trim();
        const reaction = String(b.reaction || '').trim();
        if (!target || !['up', 'love', 'squee', 'fire', 'down', 'poop'].includes(reaction)) {
            return json(res, 400, { error: 'need ts and reaction one of up|love|squee|fire|down|poop' });
        }
        record({ kind: 'react', target, reaction, from: 'you', text: reaction });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /focus') {
        const b = await readBody(req);
        const cs = String(b.callsign || '').toLowerCase();
        if (cs !== 'jarvis' && !liveUidOf(cs)) return json(res, 404, { error: 'no live session ' + cs });
        const w = loadWork();
        w.focus = cs;
        if (cs !== 'jarvis') ensureBoard(w, cs);
        saveWork(w);
        record({ kind: 'sys', text: 'focus: ' + cs });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /spawn') {
        const b = await readBody(req);
        const cwd = String(b.cwd || '').trim();
        const purpose = String(b.purpose || '').trim();
        if (!cwd || !purpose) return json(res, 400, { error: 'need cwd and purpose' });
        const repo = resolveRepo(cwd);
        roster.handoffs = roster.handoffs || {};
        const handoff = roster.handoffs[cwdKey(cwd)] || null;
        const cs = spawnWorker(repo, purpose, b.model, handoff);
        enqueueSay('Launching ' + cs + ' in ' + repo.key + (handoff ? ', resuming the handoff' : '') + '.', 'jarvis');
        return json(res, 200, { ok: true, callsign: cs });
    }
    if (key === 'POST /permission') {
        const b = await readBody(req);
        const cs = String(b.callsign || '').toLowerCase();
        const tool = String(b.tool || ''); const detail = String(b.detail || '');
        const uid = liveUidOf(cs);
        const sess = uid ? roster.sessions[uid] : null;
        const sig = tool + ' ' + detail;
        if (sess && Array.isArray(sess.autoAllow) && sess.autoAllow.includes(sig)) {
            return json(res, 200, { decision: 'allow' });
        }
        const id = 'perm_' + (++permSeq);
        const rec = { id, cs, uid, tool, detail, res };
        rec.timer = setTimeout(() => { if (pendingPerms.delete(id)) { try { json(res, 200, { decision: 'timeout' }); } catch { } } }, 300000);
        if (rec.timer.unref) rec.timer.unref();
        pendingPerms.set(id, rec);
        if (sess) { sess.needsYou = true; saveRoster(); }
        record({ kind: 'sys', text: cs + ' wants to run [' + tool + '] ' + detail.slice(0, 90) });
        enqueueSay('Need you: ' + cs + ' wants to run a ' + tool + ' command.', 'jarvis');
        return;
    }
    if (key === 'POST /permission-answer') {
        const b = await readBody(req);
        const rec = pendingPerms.get(String(b.id || ''));
        if (!rec) return json(res, 404, { error: 'no pending permission' });
        pendingPerms.delete(rec.id);
        clearTimeout(rec.timer);
        let decision = String(b.decision || 'deny');
        if (decision === 'always') {
            decision = 'allow';
            if (rec.uid && roster.sessions[rec.uid]) {
                const s = roster.sessions[rec.uid];
                s.autoAllow = s.autoAllow || [];
                s.autoAllow.push(rec.tool + ' ' + rec.detail);
            }
        }
        if (rec.uid && roster.sessions[rec.uid]) roster.sessions[rec.uid].needsYou = false;
        saveRoster();
        record({ kind: 'sys', text: rec.cs + ' [' + rec.tool + '] ' + (decision === 'allow' ? 'approved' : 'denied') });
        try { json(rec.res, 200, { decision }); } catch { }
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /attach') {
        const b = await readBody(req);
        const data = String(b.data || '');
        if (!data) return json(res, 400, { error: 'no data' });
        const name = (String(b.name || 'paste.png').replace(/[^a-zA-Z0-9._-]/g, '_') || 'file').slice(0, 60);
        const cs = String(b.callsign || '').toLowerCase();
        const dir = join(DATA, 'attachments');
        mkdirSync(dir, { recursive: true });
        const fname = new Date().toISOString().replace(/[:.]/g, '-') + '_' + name;
        const fpath = join(dir, fname);
        writeFileSync(fpath, Buffer.from(data, 'base64'));
        const w = loadWork();
        const uid = (cs && liveUidOf(cs)) || (w.focus !== 'jarvis' ? liveUidOf(w.focus) : null);
        if (uid) busAppend({ from: 'human', to: uid, kind: 'screenshot', text: fpath });
        const toCs = uid ? roster.sessions[uid].callsign : null;
        record({ kind: 'speech', text: '📎 ' + name + (toCs ? '' : ' (saved)'), to: toCs || null, img: '/att?n=' + encodeURIComponent(fname) });
        return json(res, 200, { ok: true, path: fpath, to: toCs });
    }
    if (key === 'POST /forget') {
        const b = await readBody(req);
        const cs = String(b.callsign || '').toLowerCase();
        if (!cs || cs === 'jarvis') return json(res, 400, { error: 'bad callsign' });
        const uid = liveUidOf(cs);
        if (uid) retireSession(uid, String(b.summary || '').trim() || 'Closed from console.');
        const w = loadWork();
        delete w.sessions[cs];
        const fUid = w.focus !== 'jarvis' ? liveUidOf(w.focus) : null;
        if (w.focus === cs || (w.focus !== 'jarvis' && (!fUid || !aliveNow(fUid)))) {
            w.focus = liveCallsigns().find(c => aliveNow(liveUidOf(c))) || 'jarvis';
        }
        saveWork(w);
        record({ kind: 'sys', text: 'removed ' + cs + ' from board' });
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
            task = makeTask(needle, b);
            board.queued.push(task);
        } else if (b.op === 'start' || b.op === 'done' || b.op === 'drop' || b.op === 'ready' || b.op === 'review') {
            const lists = b.op === 'start' ? ['queued', 'done', 'review']
                : b.op === 'done' ? ['working', 'queued', 'review']
                : b.op === 'ready' ? ['working', 'done', 'review']
                : b.op === 'review' ? ['working', 'queued', 'done']
                : ['working', 'queued', 'done', 'review'];
            const hit = findTaskAll(w, needle, lists, cs);
            if (!hit) return json(res, 404, { error: 'no task matching ' + needle });
            const dest = ensureBoard(w, hit.cs);
            const [t] = dest[hit.list].splice(hit.i, 1);
            if (b.op === 'start') dest.working.push(t);
            if (b.op === 'done') dest.done.push(t);
            if (b.op === 'ready') dest.queued.push(t);
            if (b.op === 'review') dest.review.push(t);
            task = t;
        } else if (b.op === 'top') {
            const hit = findTaskAll(w, needle, ['queued', 'working', 'review', 'done'], cs);
            if (!hit) return json(res, 404, { error: 'no task matching ' + needle });
            const arr = w.sessions[hit.cs][hit.list];
            const [t] = arr.splice(hit.i, 1);
            arr.unshift(t);
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
            return json(res, 400, { error: 'op must be add|start|done|review|top|drop|move|clear-done' });
        }
        saveWork(w);
        record({ kind: 'task', op: b.op, board: cs, task: textOf(task) });
        return json(res, 200, { ok: true, op: b.op, task });
    }
    if (key === 'POST /retire') {
        const b = await readBody(req);
        const s = roster.sessions[b.uid];
        if (s && !s.ended && b.notes != null) s.handoff = String(b.notes);
        let successor = false;
        if (s && !s.ended) {
            const board = loadWork().sessions[s.callsign] || { working: [], queued: [] };
            const hasWork = (board.working || []).length + (board.queued || []).length > 0;
            // auto-successor on retire when work remains; explicit successor:true/false overrides
            successor = b.successor === true || (b.successor !== false && hasWork);
        }
        const ok = retireSession(b.uid, String(b.summary || '').trim() || null, { successor });
        return json(res, ok ? 200 : 404, ok ? { ok: true, successor } : { error: 'unknown or already retired uid' });
    }
    if (key === 'POST /handoff') {
        // A live session checkpoints its handoff (one-line summary + detailed notes) so a
        // successor can resume seamlessly. Safe to call repeatedly; latest wins.
        const b = await readBody(req);
        const s = roster.sessions[b.uid];
        if (!s || s.ended) return json(res, 404, { error: 'unknown or retired uid' });
        if (b.summary != null) s.summary = String(b.summary).trim();
        if (b.notes != null) s.handoff = String(b.notes);
        const w = loadWork();
        const board = w.sessions[s.callsign] || { working: [], queued: [] };
        roster.handoffs = roster.handoffs || {};
        if (s.cwd) roster.handoffs[cwdKey(s.cwd)] = {
            summary: s.summary || null, notes: s.handoff || '',
            board: { working: board.working || [], queued: board.queued || [] },
            from: s.callsign, fromUid: b.uid, cwd: s.cwd, purpose: s.purpose,
            ts: new Date().toISOString(),
        };
        saveRoster();
        return json(res, 200, { ok: true });
    }
    if (key === 'GET /handoff') {
        // A successor reads its predecessor's handoff. ?cs=<callsign> is the one-shot stash
        // the spawn wrote (consumed on read); ?cwd=<path> is the durable per-job record.
        roster.handoffs = roster.handoffs || {};
        const csq = String(u.searchParams.get('cs') || '').toLowerCase().replace(/[^a-z]/g, '');
        const cwdq = u.searchParams.get('cwd');
        let rec = null;
        if (csq && roster.handoffs['cs:' + csq]) {
            rec = roster.handoffs['cs:' + csq];
            delete roster.handoffs['cs:' + csq];
            saveRoster();
        } else if (cwdq) {
            rec = roster.handoffs[cwdKey(cwdq)] || null;
        } else if (csq) {
            rec = Object.entries(roster.handoffs)
                .filter(([k, r]) => !k.startsWith('cs:') && r && r.from === csq)
                .map(([, r]) => r)
                .sort((a, b2) => Date.parse(b2.ts) - Date.parse(a.ts))[0] || null;
        }
        if (!rec) return json(res, 200, { none: true });
        return json(res, 200, rec);
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
    if (key === 'POST /voices') {
        const b = await readBody(req);
        record({ kind: 'sys', text: 'TTS chosen: ' + (b.chosen || 'none') + ' | available: ' + (Array.isArray(b.voices) ? b.voices.join(' ; ') : '') });
        return json(res, 200, { ok: true });
    }
    if (key === 'POST /mute') {
        const b = await readBody(req);
        setMute(!!b.on);
        return json(res, 200, { ok: true, muted });
    }
    if (key === 'POST /pause') {
        const b = await readBody(req);
        discard = !!b.on;
        record({ kind: 'sys', text: discard ? 'listening paused (console)' : 'listening resumed (console)' });
        return json(res, 200, { ok: true, paused: discard });
    }
    if (key === 'POST /voicemute') {
        // Silence one session's spoken lines (still logged in chat); per-session, not the global mute.
        const b = await readBody(req);
        const uid = b.uid || liveUidOf(String(b.callsign || '').toLowerCase());
        const s = uid && roster.sessions[uid];
        if (!s) return json(res, 404, { error: 'unknown session' });
        s.voiceMuted = !!b.on;
        saveRoster();
        record({ kind: 'sys', text: s.callsign + (s.voiceMuted ? ' voice muted' : ' voice unmuted') + ' (console)' });
        return json(res, 200, { ok: true, voiceMuted: s.voiceMuted });
    }
    if (key === 'POST /open') {
        const b = await readBody(req);
        const url = String(b.url || '');
        if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: 'http(s) urls only' });
        openInWorkChrome(url);
        return json(res, 200, { ok: true });
    }
    if (key === 'GET /schedule') {
        const s = loadSchedule();
        const stale = s.date !== new Date().toDateString();
        const events = stale ? [] : (s.events || []);
        const now = Date.now();
        const next = events.find(e => Date.parse(e.start) > now) || null;
        const current = events.find(e => Date.parse(e.start) <= now && now < Date.parse(e.end)) || null;
        return json(res, 200, { events, next, current });
    }
    if (key === 'POST /schedule') {
        const b = await readBody(req);
        let s;
        if (Array.isArray(b.events)) {
            const events = b.events
                .filter(e => e && e.title && e.start && e.end)
                .map(e => ({
                    title: String(e.title).slice(0, 120),
                    start: e.start,
                    end: e.end,
                    ...(e.link ? { link: String(e.link) } : {}),
                    ...(e.join ? { join: String(e.join), joinKind: String(e.joinKind || 'meet') } : {}),
                }))
                .sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
            s = { date: new Date().toDateString(), events, announced: {} };
        } else {
            s = parseScheduleText(b.text || '');
        }
        if (!s.events.length) return json(res, 400, { error: 'no events parsed - expected title lines followed by H:MM AM-H:MM PM lines, or an events array' });
        saveSchedule(s);
        const upcoming = s.events.filter(e => Date.parse(e.start) > Date.now()).length;
        record({ kind: 'sys', text: 'schedule loaded: ' + s.events.length + ' events, ' + upcoming + ' upcoming' });
        enqueueSay('Schedule loaded. ' + upcoming + ' upcoming.', 'jarvis');
        return json(res, 200, { ok: true, events: s.events.length, upcoming });
    }
    if (key === 'POST /hear') {
        const b = await readBody(req);
        if (b.text) handleUtterance(String(b.text), !!b.typed);
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
        await context.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'], { origin: ORIGIN }).catch(() => { });
        consolePage = context.pages()[0] || await context.newPage();
        if (!consolePage.url().startsWith(ORIGIN)) await consolePage.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
        await consolePage.exposeFunction('__jarvisHear', (text) => handleUtterance(text));
        consolePageRef = consolePage;
    }

    let speakingNow = false;
    const pump = () => {
        if (!sayQueue.length || speakingNow) return;
        speakingNow = true;
        const item = sayQueue.shift();
        record({ kind: 'tts', text: item.text, from: item.from });
        if (consolePage && !muted && !voiceMutedFrom(item.from)) {
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
        try { json(wt.res, 200, { cursor: busBase + bus.length, events: [] }); } catch { }
    }
    if (consolePage) await consolePage.evaluate(() => window.__shutdown()).catch(() => { });
    record({ kind: 'sys', text: 'jarvis core stopped' });
    if (context) await context.close();
    server.close();
    console.log('JARVIS CORE STOPPED.');
}
main().catch(e => { console.error(e.message); process.exit(1); });
