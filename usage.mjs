import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CREDS = join(process.env.USERPROFILE || '', '.claude', '.credentials.json');

function pct(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const n = v > 0 && v <= 1 ? v * 100 : v;
    return Math.min(100, Math.round(n));
}

export async function fetchRealUsage() {
    let token;
    try {
        const c = JSON.parse(readFileSync(CREDS, 'utf8'));
        token = c.claudeAiOauth && c.claudeAiOauth.accessToken;
    } catch {
        return null;
    }
    if (!token) return null;
    try {
        const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
            headers: {
                authorization: 'Bearer ' + token,
                'anthropic-beta': 'oauth-2025-04-20',
                'content-type': 'application/json',
            },
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return null;
        const d = await r.json();
        const fh = d.five_hour || {};
        const sd = d.seven_day || {};
        return {
            sessionPct: pct(fh.utilization),
            resetAt: fh.resets_at || null,
            weekPct: pct(sd.utilization),
            weekResetAt: sd.resets_at || null,
        };
    } catch {
        return null;
    }
}
