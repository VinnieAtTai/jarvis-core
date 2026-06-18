
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
let lastHold = null;
let activeTab = 'all';
let nsRepos = [];

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
function b64(s) { return btoa(unescape(encodeURIComponent(String(s)))); }
function unb64(s) { return decodeURIComponent(escape(atob(s))); }
// Click-to-copy: any element with data-copy="<base64 text>" copies on click. Works in the
// Playwright console (clipboard-write is granted to the context; falls back to execCommand).
function doCopy(txt, el) {
    const flash = (cls) => { if (!el) return; el.classList.add(cls); setTimeout(() => el.classList.remove('copied', 'copyfail'), 700); };
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        let okFlag = false; try { okFlag = document.execCommand('copy'); } catch { okFlag = false; }
        document.body.removeChild(ta); flash(okFlag ? 'copied' : 'copyfail');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => flash('copied')).catch(fallback);
    else fallback();
}
// Single delegated, capture-phase handler so copy works anywhere (chat, cards, archive, hold)
// and fires before each panel's own click handler without needing to touch them.
document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!t) return;
    e.stopPropagation(); e.preventDefault();
    doCopy(unb64(t.getAttribute('data-copy')), t);
}, true);
// Hover any copyable path/URL token -> floating menu to open it in Explorer or Chrome.
const pathfly = document.createElement('div');
pathfly.id = 'pathfly'; pathfly.style.display = 'none';
document.body.appendChild(pathfly);
let pathflyTimer = null;
function showPathFly(tok) {
    clearTimeout(pathflyTimer);
    const val = unb64(tok.getAttribute('data-copy') || '');
    if (!val) return;
    const isUrl = /^https?:\/\//i.test(val);
    let h = '';
    if (!isUrl) h += '<span class="pathact" data-revealpath="' + b64(val) + '">&#128193; Explorer</span>';
    h += '<span class="pathact" data-openpath="' + b64(val) + '">&#127760; ' + (isUrl ? 'Open in Chrome' : 'Chrome') + '</span>';
    pathfly.innerHTML = h;
    const r = tok.getBoundingClientRect();
    pathfly.style.left = Math.round(r.left) + 'px';
    pathfly.style.top = Math.round(r.bottom + 2) + 'px';
    pathfly.style.display = 'block';
}
function hidePathFlySoon() { clearTimeout(pathflyTimer); pathflyTimer = setTimeout(() => { pathfly.style.display = 'none'; }, 280); }
document.addEventListener('mouseover', (e) => { const t = e.target.closest ? e.target.closest('.pathtok') : null; if (t) showPathFly(t); });
document.addEventListener('mouseout', (e) => { const t = e.target.closest ? e.target.closest('.pathtok') : null; if (t) hidePathFlySoon(); });
pathfly.addEventListener('mouseover', () => clearTimeout(pathflyTimer));
pathfly.addEventListener('mouseleave', hidePathFlySoon);
pathfly.addEventListener('click', (e) => {
    const rev = e.target.closest ? e.target.closest('[data-revealpath]') : null;
    if (rev) { fetch('/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: unb64(rev.getAttribute('data-revealpath')) }) }).catch(() => { }); pathfly.style.display = 'none'; return; }
    const op = e.target.closest ? e.target.closest('[data-openpath]') : null;
    if (op) { fetch('/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: unb64(op.getAttribute('data-openpath')) }) }).catch(() => { }); pathfly.style.display = 'none'; return; }
});
// Turn every URL and drive-letter file path inside free text into a click-to-copy token.
// Non-matching text is escaped; matches are escaped for display but carry the raw value (b64)
// for the clipboard. Trailing sentence punctuation is left outside the token.
function linkify(raw) {
    const re = /(https?:\/\/[^\s<>"']+|[A-Za-z]:[\\\/][^\s<>"']*)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(raw))) {
        out += esc(raw.slice(last, m.index));
        let tok = m[0], trail = '';
        const tm = tok.match(/[).,;:!?\]]+$/);
        if (tm) { trail = tok.slice(tok.length - tm[0].length); tok = tok.slice(0, tok.length - tm[0].length); }
        out += '<span class="cpy pathtok" data-copy="' + b64(tok) + '" title="click to copy; hover to open">' + esc(tok) + '</span>' + esc(trail);
        last = m.index + m[0].length;
    }
    out += esc(raw.slice(last));
    return out;
}

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
            + linkify(g.texts.join('\n')).split('\n').join('<br>')
            + (g.img ? '<br><a href="' + g.img + '" target="_blank"><img src="' + g.img + '" class="thumb"></a>' : '')
            + '<span class="t">' + fmtHM(g.ts) + '</span>'
            + '<span class="copybtn" data-c="' + btoa(unescape(encodeURIComponent(g.texts.join('\n')))) + '" title="copy">📋</span>' + reactBar + '</div></div>';
    }).join('');
    rawEl.innerHTML = chatEvts.slice(-200).reverse().map(e =>
        '<div>[' + fmtHMS(e.ts) + '] <b>' + esc(e.kind === 'sys' ? 'SYS' : (e.who === 'you' ? 'YOU' : String(e.who).toUpperCase())) + '</b> ' + esc(e.text) + '</div>'
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
// Phone alerts (ntfy) — set the topic URL, save, and fire a test push.
async function loadNotify() {
    try {
        const r = await (await fetch('/notify')).json();
        const el = document.getElementById('nturl');
        if (el && document.activeElement !== el) el.value = r.url || '';
        const st = document.getElementById('ntstatus');
        if (st) { st.textContent = r.configured ? 'on' : 'off'; st.className = 'ntstatus' + (r.configured ? ' on' : ''); }
    } catch { }
}
document.getElementById('ntsave').onclick = async () => {
    const url = document.getElementById('nturl').value.trim();
    try { await fetch('/notify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }); } catch { }
    loadNotify();
};
document.getElementById('nttest').onclick = async () => {
    const st = document.getElementById('ntstatus');
    try {
        const r = await fetch('/notify-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (st) { st.textContent = r.ok ? 'test sent ✓' : 'set a URL first'; }
    } catch { if (st) st.textContent = 'failed'; }
    setTimeout(loadNotify, 1500);
};
loadNotify();

const boardExpand = new Set();
let lastBoard = null, lastSched = null;
// Local-time 24-hour clock (HH:MM) for chat, raw-log, and schedule timestamps. The stored ts is an
// ISO/UTC instant; new Date() + getHours/getMinutes render it in the viewer's local zone, instead of
// slicing the raw "...Z" string which showed UTC. 24-hour keeps every time a fixed 5 chars so the
// schedule column right-aligns cleanly (no ragged "9:00 AM" vs "12:00 PM").
function fmtHM(iso) { if (!iso) return ''; const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function fmtHMS(iso) { if (!iso) return ''; const d = new Date(iso); return fmtHM(iso) + ':' + String(d.getSeconds()).padStart(2, '0'); }
// human countdown to a future ms-delta: "in 8 min" / "in 1 hr 20 min"
function fmtCountdown(ms) {
    const totalMin = Math.round(ms / 60000);
    if (totalMin <= 0) return 'now';
    if (totalMin < 60) return 'in ' + totalMin + ' min';
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return 'in ' + h + ' hr' + (h > 1 ? 's' : '') + (m ? ' ' + m + ' min' : '');
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
    const m = String(text == null ? '' : text).match(/^([A-Za-z]{2,8}):\s*/);
    if (!m) return { chip: '', rest: text };
    const c = TCHIPS[m[1].toUpperCase()];
    if (!c) return { chip: '', rest: text };
    return { chip: '<span class="tchip ' + c[2] + '" title="' + c[1] + '">' + c[0] + '</span>', rest: text.slice(m[0].length) };
}
function renderBoards(d) {
    focusCS = d.focus;
    lastBoard = d;
    populateAddTaskCols(d);
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
        h += '<span class="evic evtask" data-mtask="' + b64(e.title || '') + '" title="add as a JARVIS task to work on">&#10133;</span>';
        return '<span class="evicons">' + h + '</span>';
    };
    let top = '', imminent = false;
    if (lastSched && (lastSched.current || lastSched.next)) {
        const now = Date.now();
        const rows = [];
        if (lastSched.current) {
            const e = lastSched.current, s = Date.parse(e.start), en = Date.parse(e.end);
            const leftMin = Math.max(0, Math.round((en - now) / 60000));
            const pct = en > s ? Math.min(100, Math.max(0, Math.round((now - s) / (en - s) * 100))) : 0;
            rows.push('<div class="evrow nmrow"><span><span class="nmlabel now">NOW</span> ' + esc(e.title)
                + ' <span class="nmtime">' + (leftMin ? leftMin + ' min left' : 'wrapping up') + '</span></span>' + evIcons(e) + '</div>'
                + '<div class="nmbar"><div class="nmbarfill" style="width:' + pct + '%"></div></div>');
        }
        if (lastSched.next) {
            const e = lastSched.next, ms = Date.parse(e.start) - now, soon = ms <= 300000;
            if (soon) imminent = true;
            const cd = ms <= 0 ? 'starting now' : fmtCountdown(ms);
            const isRem = e.kind === 'reminder';
            rows.push('<div class="evrow nmrow"><span><span class="nmlabel next' + (soon ? ' soon' : '') + '">' + (isRem ? 'REMINDER' : 'NEXT') + '</span> ' + (isRem ? '⏰ ' : '') + esc(e.title)
                + ' <span class="nmtime nmcd' + (soon ? ' soon' : '') + '">' + cd + ' · ' + fmtHM(e.start) + '</span></span>' + evIcons(e) + '</div>');
        }
        top = rows.join('');
    }
    if (!top && lastSched && lastSched.events && lastSched.events.length) {
        top = '<div class="nmclear">&#127881; That\'s the lot - day\'s clear.</div>';
    }
    let sched = '';
    const _rem = (lastSched && lastSched.reminders) || [];
    if (lastSched && (((lastSched.events || []).length) || _rem.length)) {
        const now = Date.now();
        // Merge meetings + reminders into one time-sorted list; reminders render with a clock glyph.
        const items = [...((lastSched.events) || []).map(e => ({ ...e, _k: 'm' })), ..._rem.map(r => ({ ...r, _k: 'r' }))]
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        sched = '<div class="bhead" style="margin-top:0">SCHEDULE</div>' + items.map(e => {
            if (e._k === 'r') {
                const due = Date.parse(e.start) <= now, fired = !!e.firedAt;
                const col = (due || fired) ? '#7d6fb0' : '#b9a7e6';
                return '<div class="witem evrow" style="color:' + col + '"><span>' + fmtHM(e.start) + '  ⏰ ' + esc(e.title) + (fired ? ' ✓' : '') + '</span></div>';
            }
            const s = Date.parse(e.start), en = Date.parse(e.end);
            const past = en < now, cur = s <= now && now < en;
            const col = past ? '#566270' : cur ? '#e8c35a' : '#9bb0c4';
            return '<div class="witem evrow" style="color:' + col + (cur ? ';font-weight:bold' : '') + '"><span>' + fmtHM(e.start) + '  ' + esc(e.title) + '</span>' + (past ? '' : evIcons(e)) + '</div>';
        }).join('');
    }
    const np = document.getElementById('nextpanel'), sp = document.getElementById('schedpanel');
    np.innerHTML = top; np.style.display = top ? 'block' : 'none';
    np.classList.toggle('imminent', imminent);
    sp.innerHTML = sched; sp.style.display = sched ? 'block' : 'none';
    const prio = b => b.pendingPerm ? 2 : b.needsYou ? 1 : 0;   // float perm/needs-you cards to the top
    workEl.innerHTML = d.boards.slice().sort((a, b) => prio(b) - prio(a)).map(b => {
        const queued = b.queued || [], done = b.done || [], working = b.working || [], review = b.review || [];
        const cs = b.callsign;
        const dead = b.alive === false && cs !== 'jarvis';
        const focused = cs === d.focus;
        let btns = '';
        const holdBtn = '<span class="cbtn" data-act="hold" data-cs="' + esc(cs) + '" data-cwd="' + escAttr(b.cwd || '') + '" data-purpose="' + escAttr(b.purpose || '') + '" title="park on hold (resume later — distinct from closing)">💤</span>';
        if (dead) {
            btns += '<span class="cbtn" data-act="continue" data-cwd="' + escAttr(b.cwd || '') + '" data-purpose="' + escAttr(b.purpose || '') + '" title="continue: launch a fresh worker for this job">🚀</span>';
            btns += holdBtn;
            btns += '<span class="cbtn" data-act="close" data-cs="' + esc(cs) + '" title="remove from board">✕</span>';
        } else if (cs !== 'jarvis') {
            if (!focused) btns += '<span class="cbtn" data-act="focus" data-cs="' + esc(cs) + '" title="focus">★</span>';
            btns += '<span class="cbtn" data-act="voicemute" data-cs="' + esc(cs) + '" data-on="' + (b.voiceMuted ? '0' : '1') + '" title="' + (b.voiceMuted ? 'voice muted - click to unmute' : 'silence this session voice') + '">' + (b.voiceMuted ? '🔇' : '🔊') + '</span>';
            btns += holdBtn;
            btns += '<span class="cbtn" data-act="restart" data-uid="' + esc(b.uid || '') + '" data-cwd="' + escAttr(b.cwd || '') + '" data-purpose="' + escAttr(b.purpose || '') + '" title="restart: retire then relaunch">↻</span>';
            btns += '<span class="cbtn" data-act="close" data-cs="' + esc(cs) + '" title="close / retire">✕</span>';
        } else if (cs === 'jarvis') {
            if (b.uid) {
                // a jarvis PROJECT worker is attached -> full session controls, never Close
                // (jarvis is permanent; when the worker retires the card idles on the punchlist).
                if (!focused) btns += '<span class="cbtn" data-act="focus" data-cs="jarvis" title="focus">★</span>';
                btns += '<span class="cbtn" data-act="voicemute" data-cs="jarvis" data-uid="' + esc(b.uid) + '" data-on="' + (b.voiceMuted ? '0' : '1') + '" title="' + (b.voiceMuted ? 'voice muted - click to unmute' : 'silence this session voice') + '">' + (b.voiceMuted ? '🔇' : '🔊') + '</span>';
                btns += '<span class="cbtn" data-act="hold" data-cs="jarvis" data-uid="' + esc(b.uid) + '" data-cwd="' + escAttr(b.cwd || '') + '" data-purpose="' + escAttr(b.purpose || '') + '" title="park the jarvis worker - resume later">💤</span>';
                btns += '<span class="cbtn" data-act="restart" data-uid="' + esc(b.uid) + '" data-cwd="' + escAttr(b.cwd || '') + '" data-purpose="' + escAttr(b.purpose || '') + '" title="restart the jarvis worker (retire + relaunch)">↻</span>';
            } else {
                btns += '<span class="cbtn" data-act="spawnjarvis" title="spin up the jarvis worker to work the punchlist">🚀</span>';
            }
            btns += '<span class="cbtn" data-act="rebuild" title="rebuild: restart the hub with the latest jarvis-core code">↻</span>';
        }
        let bctx = b.context;
        if (cs === 'jarvis' && typeof bctx !== 'number') { const jw = (d.boards || []).find(x => x.alive && /jarvis-core/i.test(x.cwd || '') && typeof x.context === 'number'); if (jw) bctx = jw.context; }
        const ctx = (typeof bctx === 'number') ? ' <span style="color:' + (bctx >= 80 ? '#e06c6c' : bctx >= 60 ? '#d9a05d' : '#5dd97c') + '">' + bctx + '%</span>' : '';
        // Project card: show which session (NATO callsign) is currently driving it, e.g. JARVIS · XRAY · 30%.
        const worker = b.worker ? ' <span class="cworker">' + esc(b.worker.toUpperCase()) + '</span>' : '';
        const cwdChip = b.cwd ? '<span class="cpybtn pathtok" data-copy="' + b64(b.cwd) + '" title="copy path: ' + escAttr(b.cwd) + '">📋</span>' : '';
        const head = '<div class="chead"><span class="ctitle">' + (focused ? '&#9733; ' : '') + esc(cs.toUpperCase()) + worker + ctx + '</span>' + cwdChip + '<span class="cbtns">' + btns + '</span></div>';
        const purpose = b.purpose ? '<div class="cpurpose">' + esc(b.purpose) + '</div>' : '';
        const doing = (b.needsYou || b.doing) ? '<div class="bdoing">' + (b.needsYou ? '<span class="needs">NEEDS YOU</span> ' : '') + esc(b.doing || '') + '</div>' : '';
        const counts = (working.length || queued.length || review.length || done.length) ? '<div class="ccount">'
            + (working.length ? '<span class="cnum work">' + working.length + ' working</span>' : '')
            + (queued.length ? '<span class="cnum queue">' + queued.length + ' queued</span>' : '')
            + (review.length ? '<span class="cnum review">' + review.length + ' in review</span>' : '')
            + (done.length ? '<span class="cnum done">' + done.length + ' done</span>' : '') + '</div>' : '';
        // Clean one-line task (glyph + text, consistent left edge); notes (if any) make the
        // whole line clickable and drop full-width below — no leading indent, no double glyph.
        const _laneArrs = { review, working, queued, done };
        const _laneOff = {}; { let _c = 0; for (const _L of ['review', 'working', 'queued', 'done']) { _laneOff[_L] = _c; _c += (_laneArrs[_L] || []).length; } }
        const item = (i, list, mark, num) => {
            const obj = i && typeof i === 'object';
            const txt = obj ? (i.text == null ? '' : i.text) : i;
            const id = obj ? (i.id || '') : '';
            const notes = obj ? (i.notes || '') : '';
            const a = (op, sym, title) => '<span class="ract" data-op="' + op + '" data-cs="' + esc(cs) + '" data-t="' + escAttr(txt) + '" title="' + title + ' — ' + escAttr(txt) + '">' + sym + '</span>';
            let acts = '';
            if (list === 'queued') acts += a('top', '&#9650;', 'move to top of queue');
            if (list === 'review') {
                acts += a('done', '&#10003;', 'approve &#8594; done');
                acts += a('ready', '&#8634;', 'back to queue');
                acts += a('start', '&#8635;', 'send back to working');
            } else {
                acts += a('review', '&#9678;', 'move to review');
                if (list !== 'done') acts += a('done', '&#10003;', 'done');
                if (list !== 'queued') acts += a('ready', '&#8634;', 'back to ready');
            }
            acts += '<span class="ract del" data-op="drop" data-cs="' + esc(cs) + '" data-t="' + escAttr(txt) + '" title="delete — ' + escAttr(txt) + '">&#128465;</span>';
            const noteOpen = notes && boardExpand.has('note:' + id);
            const dot = notes ? '<span class="ndot">' + (noteOpen ? '&#9662;' : '&#8250;') + '</span>' : '';
            const noteBody = noteOpen ? '<div class="wnote">' + esc(notes).split('\n').join('<br>') + '</div>' : '';
            const dx = notes ? ' data-x="note:' + id + '" style="cursor:pointer"' : '';
            // text + note caret stay together on the left (.wleft); row actions sit far right.
            // chip is derived from a leading TAG: and stripped from the visible text; data-t above
            // keeps the FULL original text so op matching is unaffected.
            const tc = chipFor(txt);
            return '<div class="witem ' + list + '"' + dx + ' title="' + escAttr(txt) + '"><span class="wleft"><span class="wtext"><span class="wnum">' + num + '</span> ' + mark + ' ' + tc.chip + esc(tc.rest) + '</span>' + dot + '</span><span class="rowacts">' + acts + '</span>' + noteBody + '</div>';
        };
        // Top 3 per lane + a "N more" expander; the done lane defaults to FULLY collapsed (history).
        const lane = (items, list, mark) => {
            if (!items.length) return '';
            const open = boardExpand.has(cs + ':' + list);
            const cap = list === 'done' ? 0 : 3;
            const vis = open ? items : items.slice(0, cap);
            let h = vis.map((it, j) => item(it, list, mark, _laneOff[list] + j + 1)).join('');
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
        const pp = b.pendingPerm;
        const pcount = b.pendingPermCount || 0;
        const batch = pcount > 1 ? '<div class="permbatch"><span class="pbtn ok" data-act="approveall" data-cs="' + esc(b.callsign) + '">Approve all (' + pcount + ')</span><span class="pbtn no" data-act="denyall" data-cs="' + esc(b.callsign) + '">Deny all</span></div>' : '';
        const perm = pp ? '<div class="permreq' + (pp.klass === 'danger' ? ' permdanger' : '') + '"><div class="permhead">' + (pp.klass === 'danger' ? '&#9888; RISKY: ' : '&#9888; ') + 'wants to run <b>' + esc(pp.tool) + '</b></div><div class="permdetail">' + esc((pp.detail || '').slice(0, 240)) + '</div><div class="permbtns"><span class="pbtn ok" data-act="approve" data-permid="' + esc(pp.id) + '">Approve</span><span class="pbtn no" data-act="deny" data-permid="' + esc(pp.id) + '">Deny</span><span class="pbtn" data-act="always" data-permid="' + esc(pp.id) + '" title="auto-allow this command family from now on">Always: ' + esc(pp.label || pp.tool) + '</span></div>' + batch + '</div>' : '';
        return '<div class="card' + (focused ? ' cfocus' : '') + (dead ? ' cdead' : '') + ((b.needsYou || b.pendingPerm) ? ' cneeds' : '') + '">' + head + purpose + perm + doing + counts + tasks + '</div>';
    }).join('');
    const deadN = d.boards.filter(b => b.alive === false && b.callsign !== 'jarvis').length;
    if (deadN > 1) workEl.innerHTML = '<div style="margin-bottom:8px"><span class="cbtn" data-act="continueall" style="opacity:1;color:#5db4d9;font-weight:bold;font-size:12px">🚀 continue all (' + deadN + ')</span></div>' + workEl.innerHTML;
    renderChat();
}
workEl.onclick = (e) => {
    const t = e.target.closest ? e.target.closest('[data-x],[data-op],[data-act]') : null;
    if (!t) return;
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then(r => { if (!r.ok) alert('Action failed (' + r.status + ') on ' + url + ' — the hub rejected it, nothing was saved.'); return r; })
        .catch(() => alert('Could not reach the hub for ' + url + ' — it is down or restarting, so NOTHING was saved. Reload the console once it is back, then retry.'));
    const x = t.getAttribute('data-x');
    if (x) { if (boardExpand.has(x)) boardExpand.delete(x); else boardExpand.add(x); if (lastBoard) renderBoards(lastBoard); return; }
    const op = t.getAttribute('data-op');
    if (op) { post('/worklist', { op, callsign: t.getAttribute('data-cs'), text: t.getAttribute('data-t') }); return; }
    const act = t.getAttribute('data-act');
    if (act === 'focus') post('/focus', { callsign: t.getAttribute('data-cs') });
    else if (act === 'close') post('/forget', { callsign: t.getAttribute('data-cs') });
    else if (act === 'continue') post('/spawn', { cwd: t.getAttribute('data-cwd'), purpose: t.getAttribute('data-purpose') });
    else if (act === 'spawnjarvis') post('/spawn', { cwd: 'd:/claude/jarvis-core', purpose: 'JARVIS punchlist', project: 'jarvis' });
    else if (act === 'rebuild') { if (confirm('Rebuild JARVIS now? Restarts the hub with the latest jarvis-core code. Live sessions ride it out. Heads-up: this resets the in-memory token gauge.')) post('/restart', {}); }
    else if (act === 'restart') post('/retire', { uid: t.getAttribute('data-uid'), summary: 'Restarted from console.', successor: true });
    else if (act === 'hold') post('/hold', { uid: t.getAttribute('data-uid') || undefined, callsign: t.getAttribute('data-cs'), cwd: t.getAttribute('data-cwd'), purpose: t.getAttribute('data-purpose') });
    else if (act === 'voicemute') post('/voicemute', { uid: t.getAttribute('data-uid') || undefined, callsign: t.getAttribute('data-cs'), on: t.getAttribute('data-on') === '1' });
    else if (act === 'continueall' && lastBoard) lastBoard.boards.filter(b => b.alive === false && b.callsign !== 'jarvis' && b.cwd && b.purpose).forEach(b => post('/spawn', { cwd: b.cwd, purpose: b.purpose }));
    else if (act === 'approve') post('/permission-answer', { id: t.getAttribute('data-permid'), decision: 'allow' });
    else if (act === 'deny') post('/permission-answer', { id: t.getAttribute('data-permid'), decision: 'deny' });
    else if (act === 'always') post('/permission-answer', { id: t.getAttribute('data-permid'), decision: 'always' });
    else if (act === 'approveall') post('/permission-answer-all', { callsign: t.getAttribute('data-cs'), decision: 'allow' });
    else if (act === 'denyall') post('/permission-answer-all', { callsign: t.getAttribute('data-cs'), decision: 'deny' });
};
document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target.closest('[data-open]') : null;
    if (!t) return;
    fetch('/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: t.getAttribute('data-open') }) }).catch(() => { });
});
document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target.closest('[data-mtask]') : null;
    if (!t) return;
    const title = unb64(t.getAttribute('data-mtask'));
    fetch('/worklist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'add', text: title, callsign: 'jarvis' }) }).then(() => { t.style.color = '#5dd97c'; t.textContent = '✓'; }).catch(() => { });
});
// Add-task / to-do bar: human-side task entry (sessions add via the /worklist API; the
// console had no way to). Persistent (lives in console.html, not the 1.5s board re-render),
// so focus/typing survive. Target selector defaults to the focused session and always
// offers a general "jarvis" to-do list. Category tags (BUG:/FEATURE:/…) chip automatically.
function populateAddTaskCols(d) {
    const sel = document.getElementById('atcol');
    if (!sel || sel === document.activeElement) return; // don't yank an open dropdown
    const names = [];
    (d.boards || []).forEach(b => { if (b.callsign && !names.includes(b.callsign)) names.push(b.callsign); });
    if (!names.includes('jarvis')) names.unshift('jarvis');
    const cur = sel.value;
    const want = (cur && names.includes(cur)) ? cur : ((d.focus && names.includes(d.focus)) ? d.focus : 'jarvis');
    const sig = names.join('|') + '>' + want;
    if (sel.dataset.sig === sig) return; // nothing changed — leave the DOM (and selection) alone
    sel.dataset.sig = sig;
    sel.innerHTML = names.map(n => '<option value="' + escAttr(n) + '"' + (n === want ? ' selected' : '') + '>' + esc(n === 'jarvis' ? 'jarvis (to-do)' : n) + '</option>').join('');
    sel.value = want;
}
function submitAddTask() {
    const ti = document.getElementById('atext'), sel = document.getElementById('atcol');
    const text = (ti.value || '').trim();
    if (!text) return;
    const cs = (sel && sel.value) || 'jarvis';
    const clear = () => { ti.value = ''; ti.focus(); };
    const addToBoard = () => fetch('/worklist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'add', callsign: cs, text }) }).then(clear);
    // Reminder-looking text ("remind…", "…in 10 min", "…at 3pm") becomes a timed calendar
    // reminder; everything else is a board to-do. Falls back to the board if /remind can't parse it.
    const looksReminder = /^\s*(remind|timer|set (a|an) timer)\b/i.test(text) || /\b(?:in|for)\s+\d+\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i.test(text) || /\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(text);
    if (looksReminder) {
        fetch('/remind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
            .then(r => r.json()).then(j => { if (j && j.ok) { clear(); } else { return addToBoard(); } }).catch(() => { });
        return;
    }
    addToBoard().catch(() => { });
}
document.getElementById('atadd').onclick = submitAddTask;
document.getElementById('atext').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitAddTask(); } e.stopPropagation(); });
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
const jvmenu = document.getElementById('jvmenu');
document.getElementById('bjv').onclick = (e) => { e.stopPropagation(); jvmenu.style.display = jvmenu.style.display === 'none' ? 'block' : 'none'; };
document.addEventListener('click', () => { if (jvmenu) jvmenu.style.display = 'none'; });
document.getElementById('jvrestart').onclick = () => {
    jvmenu.style.display = 'none';
    if (!confirm('Restart JARVIS now?\n\nRelaunches the hub with the latest code. Live sessions keep running (their poll loops ride out the bounce). Any pending permission prompt is dropped and will re-ask.')) return;
    fetch('/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => { });
    if (typeof setStatus === 'function') setStatus('muted', 'RESTARTING…');
};
document.getElementById('jvwind').onclick = async () => {
    jvmenu.style.display = 'none';
    let plan = null;
    try { plan = await (await fetch('/winddown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dry: true }) })).json(); } catch { }
    let msg = 'Wind down JARVIS for the night?\n\nThis asks every live session to checkpoint a handoff and retire (no successors), then stops the hub.';
    if (plan && plan.sessions) {
        const live = plan.sessions.map(s => s.cs + (s.dirty && s.dirty !== 0 ? ' (' + s.dirty + ' uncommitted)' : '')).join(', ') || 'none';
        msg += '\n\nLive: ' + live;
        const dirty = plan.sessions.filter(s => s.dirty && s.dirty !== 0);
        if (dirty.length) msg += '\n\nWARNING - uncommitted work in: ' + dirty.map(s => s.cs + ' [' + s.cwd + ']').join('; ') + '\nCommit/push those first if you want them saved.';
    }
    if (!confirm(msg)) return;
    fetch('/winddown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }).catch(() => { });
    if (typeof setStatus === 'function') setStatus('muted', 'WINDING DOWN…');
};
const typeBox = document.getElementById('typebox');
function sendTyped() {
    if (activeTab === 'ask') { sendAi(); return; }   // ASK tab posts to /ai/send, not the speech bus
    const t = typeBox.value.trim();
    if (!t) return;
    typeBox.value = '';
    const sess = activeTab && activeTab !== 'all' && activeTab !== 'general' && activeTab !== 'jarvis';
    const out = activeTab === 'jarvis' ? ('jarvis ' + t) : sess ? ('on ' + activeTab + ', ' + t) : t;
    fetch('/hear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: out, typed: true }) }).catch(() => { });
}
// —— Conversational ASK tab. A direct model chat that talks to /ai/* (not the speech bus): its
// own thread list, model picker (Sonnet default, Opus one click away), and a running spend/cap
// readout. Reuses the chat input box; sendTyped() routes here when the ASK tab is active.
const MODEL_LABELS = { 'claude-haiku-4-5': 'Haiku · fast', 'claude-sonnet-4-6': 'Sonnet · default', 'claude-opus-4-8': 'Opus · deep' };
const aiState = { threads: [], models: [], defaultModel: 'claude-sonnet-4-6', curThreadId: null, messages: [], model: '', spend: null, hasKey: false, busy: false };
let askActive = false;
const aichatEl = document.getElementById('aichat');
const aibarEl = document.getElementById('aibar');
const aiThreadsSel = document.getElementById('aithreads');
const aiModelSel = document.getElementById('aimodel');
const aispendEl = document.getElementById('aispend');
// Toggle the left panel between the speech chat and the ASK chat. Idempotent + cheap: only acts
// on a real mode change, so the 1.5s board re-render (which calls renderTabs) never reloads it.
function applyTabMode() {
    const want = activeTab === 'ask';
    if (want === askActive) return;
    askActive = want;
    if (want) {
        chatEl.style.display = 'none'; rawEl.style.display = 'none';
        document.getElementById('bar').style.display = 'none';
        document.getElementById('newsessbox').style.display = 'none';
        aibarEl.style.display = 'flex'; aichatEl.style.display = 'flex';
        typeBox.placeholder = 'Ask JARVIS — direct model chat, separate from the voice bus';
        loadAiThreads(true);
    } else {
        aibarEl.style.display = 'none'; aichatEl.style.display = 'none';
        document.getElementById('bar').style.display = 'flex';
        setRaw(rawMode);   // restores #chat / #rawlog visibility
        renderTabs();      // resets the input placeholder for the new tab
    }
}
function renderSpend() {
    if (!aiState.spend) { aispendEl.textContent = ''; aispendEl.className = 'aispend'; return; }
    const usd = aiState.spend.usd || 0, cap = aiState.spend.cap || 0;
    const over = cap > 0 && usd >= cap, near = cap > 0 && usd >= cap * 0.8;
    aispendEl.textContent = '$' + usd.toFixed(2) + (cap > 0 ? ' / $' + cap.toFixed(0) : '');
    aispendEl.className = 'aispend' + (over ? ' over' : near ? ' near' : '');
}
function renderModelSel() {
    if (!aiState.models.length) return;
    const want = aiState.model || aiState.defaultModel;
    const sig = aiState.models.join('|') + '>' + want;
    if (aiModelSel.dataset.sig === sig) return;
    aiModelSel.dataset.sig = sig;
    aiModelSel.innerHTML = aiState.models.map(m => '<option value="' + escAttr(m) + '"' + (m === want ? ' selected' : '') + '>' + esc(MODEL_LABELS[m] || m) + '</option>').join('');
    aiModelSel.value = want;
}
function renderThreadSel() {
    const opts = ['<option value="">+ new chat</option>'].concat(aiState.threads.map(t =>
        '<option value="' + escAttr(t.id) + '"' + (t.id === aiState.curThreadId ? ' selected' : '') + '>' + esc((t.title || 'chat').slice(0, 42)) + '</option>'));
    aiThreadsSel.innerHTML = opts.join('');
    aiThreadsSel.value = aiState.curThreadId || '';
}
function renderAiMessages() {
    if (!aiState.messages.length) {
        aichatEl.innerHTML = '<div class="aiempty">' + (aiState.hasKey
            ? 'New chat. Pick a model and ask anything — this talks straight to the Claude API, not the voice bus.'
            : '&#9888; No API key found. Paste one into <b>anthropic-key.txt</b> at the repo root (or set ANTHROPIC_API_KEY) to use this tab.') + '</div>';
        return;
    }
    let h = aiState.messages.map(m => {
        const me = m.role === 'user';
        const tag = (!me && m.model) ? '<span class="chip">' + esc((MODEL_LABELS[m.model] || m.model).split(' ')[0].toUpperCase()) + ' &#183; </span>' : '';
        return '<div class="row ' + (me ? 'me' : 'them') + '"><div class="bubble">' + tag
            + linkify(m.content || '').split('\n').join('<br>')
            + (m.ts ? '<span class="t">' + fmtHM(m.ts) + '</span>' : '')
            + '<span class="copybtn" data-c="' + b64(m.content || '') + '" title="copy">📋</span></div></div>';
    }).join('');
    if (aiState.busy) h += '<div class="row them"><div class="bubble aiwait">…thinking</div></div>';
    aichatEl.innerHTML = h;
    aichatEl.scrollTop = aichatEl.scrollHeight;
}
async function loadAiThreads(selectLatest) {
    try {
        const r = await (await fetch('/ai/threads')).json();
        aiState.threads = r.threads || [];
        aiState.models = r.models || [];
        aiState.defaultModel = r.defaultModel || 'claude-sonnet-4-6';
        aiState.spend = r.spend || null;
        aiState.hasKey = !!r.hasKey;
        if (!aiState.model) aiState.model = aiState.defaultModel;
        if (selectLatest && aiState.curThreadId == null && aiState.threads.length) { await openAiThread(aiState.threads[0].id); return; }
        renderThreadSel(); renderModelSel(); renderSpend();
        if (aiState.curThreadId == null) renderAiMessages();
    } catch { }
}
async function openAiThread(id) {
    if (!id) { aiState.curThreadId = null; aiState.messages = []; renderThreadSel(); renderModelSel(); renderAiMessages(); return; }
    try {
        const r = await (await fetch('/ai/thread?id=' + encodeURIComponent(id))).json();
        if (r.error) return;
        aiState.curThreadId = id;
        aiState.messages = r.messages || [];
        aiState.model = r.model || aiState.defaultModel;
        renderThreadSel(); renderModelSel(); renderAiMessages();
    } catch { }
}
async function sendAi() {
    const t = typeBox.value.trim();
    if (!t || aiState.busy) return;
    typeBox.value = '';
    aiState.model = aiModelSel.value || aiState.defaultModel;
    aiState.messages.push({ role: 'user', content: t, ts: new Date().toISOString() });
    aiState.busy = true; renderAiMessages();
    try {
        const r = await fetch('/ai/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: aiState.curThreadId || undefined, text: t, model: aiState.model }) });
        const j = await r.json().catch(() => ({}));
        aiState.busy = false;
        if (j.threadId) aiState.curThreadId = j.threadId;
        if (j.spend) aiState.spend = j.spend;
        if (!r.ok) {
            aiState.messages.push({ role: 'assistant', content: '⚠ ' + (j.error || ('error ' + r.status)), ts: new Date().toISOString() });
            renderAiMessages(); renderSpend();
            return;
        }
        aiState.messages.push({ role: 'assistant', content: j.reply, ts: new Date().toISOString(), model: j.model });
        renderAiMessages(); renderSpend();
        loadAiThreads(false);   // refresh thread titles/order without disturbing the open chat
    } catch {
        aiState.busy = false;
        aiState.messages.push({ role: 'assistant', content: '⚠ could not reach the hub', ts: new Date().toISOString() });
        renderAiMessages();
    }
}
aiThreadsSel.onchange = () => openAiThread(aiThreadsSel.value);
aiModelSel.onchange = () => { aiState.model = aiModelSel.value; };
aichatEl.addEventListener('click', (e) => {   // copy button on ASK messages (chatEl's handler is bound to #chat only)
    const c = e.target.closest ? e.target.closest('.copybtn') : null;
    if (c) doCopy(unb64(c.getAttribute('data-c')), c);
});
document.getElementById('ainew').onclick = () => { aiState.curThreadId = null; aiState.messages = []; renderThreadSel(); renderAiMessages(); typeBox.focus(); };
document.getElementById('aidel').onclick = async () => {
    if (!aiState.curThreadId) return;
    if (!confirm('Delete this chat?')) return;
    const id = aiState.curThreadId;
    aiState.curThreadId = null; aiState.messages = [];
    try { await fetch('/ai/deletethread', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }); } catch { }
    loadAiThreads(false); renderAiMessages();
};
typeBox.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendTyped(); } e.stopPropagation(); });
document.getElementById('btype').onclick = sendTyped;
function attachFile(f) {
    const r = new FileReader();
    r.onload = () => {
        const b64 = String(r.result).split(',')[1] || '';
        if (!b64) return;
        const cs = (activeTab && activeTab !== 'all' && activeTab !== 'general' && activeTab !== 'jarvis') ? activeTab : '';
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
            const park = (a.cwd && a.purpose) ? '<span class="ract" data-act="holdarchive" data-cwd="' + escAttr(a.cwd) + '" data-purpose="' + escAttr(a.purpose) + '" data-cs="' + esc(a.callsign || '') + '" title="put this project on hold (resume later)">&#128164;</span>' : '';
            const hf = a.hasHandoff ? '<span style="color:#5db4d9" title="left handoff notes">&#9678;</span>' : '';
            const title = a.purpose || a.summary || '(untitled session)';
            const sm = (a.summary || '').trim().toLowerCase();
            const isStub = sm === 'closed from console.' || sm === 'restarted from console.' || sm === 'closed from console' || sm === 'restarted from console';
            const epi = (a.summary && a.summary !== a.purpose && !isStub) ? '<span class="aepi">' + esc(a.summary) + '</span>' : '';
            const tip = (a.summary && !isStub) ? a.summary : (a.purpose || '');
            const acwd = a.cwd ? '<span class="cpybtn pathtok" data-copy="' + b64(a.cwd) + '" title="copy path: ' + escAttr(a.cwd) + '">📋</span>' : '';
            return '<div class="arow"><span class="achip">' + esc((a.callsign || '?').toUpperCase()) + '</span><span class="asum"><span class="atitle" title="' + escAttr(tip) + '">' + esc(title) + '</span>' + epi + '</span>' + acwd + hf + park + cont + '</div>';
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
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).catch(() => { });
    const x = t.getAttribute('data-x');
    if (x) { if (boardExpand.has(x)) boardExpand.delete(x); else boardExpand.add(x); if (lastArchive) renderArchive(lastArchive); return; }
    const act = t.getAttribute('data-act');
    if (act === 'continue') post('/spawn', { cwd: t.getAttribute('data-cwd'), purpose: t.getAttribute('data-purpose') });
    else if (act === 'holdarchive') post('/hold', { cwd: t.getAttribute('data-cwd'), purpose: t.getAttribute('data-purpose'), callsign: t.getAttribute('data-cs') });
};
// ON HOLD — projects parked for later (distinct from Archive=finished). Pull back to resume.
function renderHold(d) {
    lastHold = d;
    const hp = document.getElementById('holdpanel');
    const items = (d && d.items) || [];
    if (!items.length) { hp.style.display = 'none'; return; }
    const open = boardExpand.has('hold:open');
    let html = '<div class="bhead holdhead" style="cursor:pointer;margin-top:0" data-x="hold:open">' + (open ? '&#9662;' : '&#9656;') + ' &#128164; ON HOLD (' + items.length + ')</div>';
    if (open) {
        html += items.slice(0, 50).map(h => {
            const resume = '<span class="ract" data-act="resume" data-key="' + escAttr(h.key || '') + '" data-cwd="' + escAttr(h.cwd || '') + '" data-purpose="' + escAttr(h.purpose || '') + '" title="pull back: resume this project now">&#128640;</span>';
            const drop = '<span class="ract del" data-act="drophold" data-key="' + escAttr(h.key || '') + '" data-cs="' + esc(h.callsign || '') + '" title="remove from on hold (keeps archive history)">&#128465;</span>';
            const hf = h.hasHandoff ? '<span style="color:#5db4d9" title="has handoff notes">&#9678;</span>' : '';
            const title = h.purpose || h.summary || '(parked project)';
            const epi = (h.summary && h.summary !== h.purpose) ? '<span class="aepi">' + esc(h.summary) + '</span>' : '';
            const tip = h.summary || h.purpose || '';
            const hcwd = h.cwd ? '<span class="cpybtn pathtok" data-copy="' + b64(h.cwd) + '" title="copy path: ' + escAttr(h.cwd) + '">📋</span>' : '';
            return '<div class="arow"><span class="achip">' + esc((h.callsign || '?').toUpperCase()) + '</span><span class="asum"><span class="atitle" title="' + escAttr(tip) + '">' + esc(title) + '</span>' + epi + '</span>' + hcwd + hf + resume + drop + '</div>';
        }).join('');
    }
    hp.innerHTML = html;
    hp.style.display = 'block';
}
async function pollHold() {
    try { renderHold(await (await fetch('/hold')).json()); } catch { }
    setTimeout(pollHold, 8000);
}
document.getElementById('holdpanel').onclick = (e) => {
    const t = e.target.closest ? e.target.closest('[data-x],[data-act]') : null;
    if (!t) return;
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).catch(() => { });
    const x = t.getAttribute('data-x');
    if (x) { if (boardExpand.has(x)) boardExpand.delete(x); else boardExpand.add(x); if (lastHold) renderHold(lastHold); return; }
    const act = t.getAttribute('data-act');
    if (act === 'resume') post('/unhold', { key: t.getAttribute('data-key'), cwd: t.getAttribute('data-cwd'), purpose: t.getAttribute('data-purpose') });
    else if (act === 'drophold') post('/unhold', { key: t.getAttribute('data-key'), callsign: t.getAttribute('data-cs'), drop: true });
};
function eventsForTab() {
    if (activeTab === 'ask') return [];   // ASK is a separate model chat, not the speech transcript
    if (activeTab === 'all') return chatEvts;
    // The jarvis PROJECT worker speaks under its own callsign (e.g. "uniform"), but it IS jarvis —
    // surface its messages on the JARVIS/GENERAL tabs by treating the bound worker callsign as jarvis.
    const _jb = lastBoard && lastBoard.boards.find(b => b.callsign === 'jarvis');
    const _jw = _jb && _jb.worker;
    if (activeTab === 'general') return chatEvts.filter(e => e.kind === 'sys' || e.who === 'jarvis' || (_jw && e.who === _jw) || (e.who === 'you' && !e.to));
    if (activeTab === 'jarvis') return chatEvts.filter(e => e.who === 'jarvis' || (_jw && e.who === _jw) || (e.who === 'you' && (!e.to || e.to === 'jarvis' || (_jw && e.to === _jw))));
    return chatEvts.filter(e => e.kind !== 'sys' && (e.who === activeTab || (e.who === 'you' && e.to === activeTab)));
}
function renderTabs() {
    const sessions = lastBoard ? lastBoard.boards.filter(b => b.callsign !== 'jarvis' && b.alive !== false) : [];
    const base = ['all', 'general', 'jarvis', 'ask'];
    const ids = base.concat(sessions.map(b => b.callsign));
    if (!ids.includes(activeTab)) activeTab = 'all';
    let html = base.map(id => '<span class="stab' + (id === activeTab ? ' active' : '') + '" data-tab="' + id + '">' + id.toUpperCase() + '</span>').join('');
    html += sessions.map(b => '<span class="stab' + (b.callsign === activeTab ? ' active' : '') + (b.needsYou ? ' needs' : '') + '" data-tab="' + esc(b.callsign) + '">' + esc(b.callsign.toUpperCase()) + (b.needsYou ? '<span class="sbadge">!</span>' : '') + '</span>').join('');
    html += '<span class="stab plus" data-newsession="1" title="new session: spin up a fresh worker">+</span>';
    document.getElementById('stabs').innerHTML = html;
    if (activeTab !== 'ask') {   // ASK manages its own placeholder (see applyTabMode)
        const sess = activeTab !== 'all' && activeTab !== 'general' && activeTab !== 'jarvis';
        typeBox.placeholder = sess ? ('Message ' + activeTab + ' - no focus change') : 'Type to jarvis (routes like speech; works while paused/muted)';
    }
    applyTabMode();
}
document.getElementById('stabs').onclick = (e) => {
    const plus = e.target.closest ? e.target.closest('[data-newsession]') : null;
    if (plus) { toggleNewSession(); return; }
    const t = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (!t) return;
    activeTab = t.getAttribute('data-tab');
    renderChat();
};
// "+" tab → inline composer: pick a repo, type a purpose, spin up a fresh worker via /spawn.
// The new session appears as its own tab within a few seconds (renderTabs polls /board).
async function loadNsRepos() {
    try { const r = await (await fetch('/repos')).json(); nsRepos = r.items || []; } catch { nsRepos = []; }
    const sel = document.getElementById('nsrepo');
    sel.innerHTML = nsRepos.length
        ? nsRepos.map((r, i) => '<option value="' + i + '">' + esc(r.key) + (r.defaultPurpose ? ' — ' + esc(r.defaultPurpose) : '') + '</option>').join('')
        : '<option value="">(no repos registered)</option>';
}
function toggleNewSession() {
    const box = document.getElementById('newsessbox');
    const show = box.style.display === 'none' || !box.style.display;
    box.style.display = show ? 'flex' : 'none';
    if (show) loadNsRepos().then(() => document.getElementById('nspurpose').focus());
}
function spawnNewSession() {
    const repo = nsRepos[Number(document.getElementById('nsrepo').value)] || nsRepos[0];
    if (!repo) { alert('No repos registered yet — register one before spinning up a session.'); return; }
    const purpose = document.getElementById('nspurpose').value.trim() || repo.defaultPurpose || repo.key;
    fetch('/spawn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: repo.cwd, purpose }) }).catch(() => { });
    document.getElementById('nspurpose').value = '';
    document.getElementById('newsessbox').style.display = 'none';
}
document.getElementById('nsgo').onclick = spawnNewSession;
document.getElementById('nscancel').onclick = () => { document.getElementById('newsessbox').style.display = 'none'; };
document.getElementById('nspurpose').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); spawnNewSession(); } e.stopPropagation(); });
pollChat();
pollWork();
pollHeat();
pollArchive();
pollHold();

let buf = [];
let flushTimer = null;
const INSTANT = [
    /\b(pause|stop|resume|start) listening\b/i,
    /\bjarvis\b.*\b(shut ?down|shutdown)\b/i,
    /\bend (the )?session\b/i,
    /\bmeeting mode\b/i,
    /\bend meeting\b/i,
    /^(?:jarvis[,!. ]+)?(add|new) task\b/i,
    /^(?:jarvis[,!. ]+)?(start|begin|finish|complete|scratch|drop) task\b/i,
    /^(?:jarvis[,!. ]+)?done with\b/i,
    /^(?:jarvis[,!. ]+)?clear done\b/i,
    /^(?:jarvis[,!. ]+)?(read|what is|what's) (the |on |my )?(list|worklist|tasks)\b/i,
    /^(?:jarvis[,!. ]+)?read everyone/i,
    /^(?:jarvis[,!. ]+)?(focus( on)?|switch to|talk to)\b/i,
    /^(?:jarvis[,!. ]+)?retire\b/i,
    /^(?:jarvis[,!. ]+)?who('s| is| else is)? (running|up|alive|online)\b/i,
    /^(?:jarvis[,!. ]+)?(start|spin up|launch) (a |a new |new )?session\b/i,
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
    const words = t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/s+/).filter(w => w.length > 2);
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
    speakingText = ' ' + String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/s+/g, ' ') + ' ';
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
