import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const fileCache = new Map();

function entriesFrom(path, st) {
    const c = fileCache.get(path);
    if (c && c.mtimeMs === st.mtimeMs) return c.entries;
    const entries = [];
    let txt;
    try { txt = readFileSync(path, 'utf8'); } catch { return entries; }
    for (const line of txt.split('\n')) {
        if (!line.includes('"usage"')) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const ts = Date.parse(e.timestamp || 0);
        const u = e.message && e.message.usage;
        if (!ts || !u) continue;
        entries.push({
            ts,
            output: u.output_tokens || 0,
            input: u.input_tokens || 0,
            cacheWrite: u.cache_creation_input_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0,
        });
    }
    fileCache.set(path, { mtimeMs: st.mtimeMs, entries });
    return entries;
}

export function scanUsage(root, sinceMs) {
    const all = [];
    if (!existsSync(root)) return all;
    const seen = new Set();
    for (const proj of readdirSync(root)) {
        const dir = join(root, proj);
        let files;
        try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
        for (const f of files) {
            const p = join(dir, f);
            let st;
            try { st = statSync(p); } catch { continue; }
            if (st.mtimeMs < sinceMs) continue;
            seen.add(p);
            for (const e of entriesFrom(p, st)) {
                if (e.ts >= sinceMs) all.push(e);
            }
        }
    }
    for (const p of fileCache.keys()) {
        if (!seen.has(p)) fileCache.delete(p);
    }
    all.sort((a, b) => a.ts - b.ts);
    return all;
}

export function totalsOf(entries, sinceMs) {
    const t = { output: 0, input: 0, cacheWrite: 0, cacheRead: 0, turns: 0 };
    for (const e of entries) {
        if (e.ts < sinceMs) continue;
        t.output += e.output;
        t.input += e.input;
        t.cacheWrite += e.cacheWrite;
        t.cacheRead += e.cacheRead;
        t.turns++;
    }
    return t;
}

export function blockStats(entries, nowMs) {
    const FIVE_H = 5 * 3600000;
    let blockStart = null, curBurn = 0, maxBurn = 0;
    for (const e of entries) {
        if (blockStart === null || e.ts >= blockStart + FIVE_H) {
            if (curBurn > maxBurn) maxBurn = curBurn;
            blockStart = e.ts - (e.ts % 3600000);
            curBurn = 0;
        }
        curBurn += e.output + e.input + e.cacheWrite;
    }
    if (curBurn > maxBurn) maxBurn = curBurn;
    const active = blockStart !== null && nowMs < blockStart + FIVE_H;
    return {
        resetAt: active ? blockStart + FIVE_H : null,
        blockBurn: active ? curBurn : 0,
        maxBlockBurn: maxBurn,
    };
}

export function burnOf(totals) {
    return totals.output + totals.input + totals.cacheWrite;
}

export function heatOf(burn) {
    if (burn < 1000) return { icon: '\u{1F4A4}', label: 'none' };
    if (burn < 300000) return { icon: '❄️', label: 'cool' };
    if (burn < 1500000) return { icon: '☕', label: 'medium' };
    if (burn < 4000000) return { icon: '\u{1F525}', label: 'hot' };
    return { icon: '\u{1F373}', label: 'cooking' };
}
