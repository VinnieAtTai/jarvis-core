// Unit tests for pickProjectWorker — the pure project->worker resolver behind projectWorkerUid in
// jarvis-core.mjs. It backs speech routing + the board's worker binding, so the invisible-coordinator
// regression (a dead, non-ended "ghost" shadowing a live coordinator — the T2 root cause) is exactly
// what these guard. Run with `npm test` (node --test) — no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickProjectWorker, lastProjectCwd } from '../jarvis-text.mjs';

const iso = ms => new Date(ms).toISOString();

test('pickProjectWorker — returns the only non-ended match', () => {
    const s = { s1: { project: 'jarvis', ended: null, lastSeen: iso(1000) } };
    assert.equal(pickProjectWorker(s, 'jarvis'), 's1');
});

test('pickProjectWorker — a live coordinator beats a stale non-ended ghost (the T2 root cause)', () => {
    // ghost registered first (earlier key order) and never got .ended; the coordinator is fresher.
    const s = {
        ghost: { project: 'primeng', ended: null, lastSeen: iso(1_000) },       // died days ago, never retired
        live:  { project: 'primeng', ended: null, lastSeen: iso(9_000_000) },   // heartbeating now
    };
    assert.equal(pickProjectWorker(s, 'primeng'), 'live');
});

test('pickProjectWorker — ignores ended (retired) sessions even if recently seen', () => {
    const s = {
        old: { project: 'jarvis', ended: iso(5000), lastSeen: iso(9_000_000) },
        cur: { project: 'jarvis', ended: null, lastSeen: iso(2000) },
    };
    assert.equal(pickProjectWorker(s, 'jarvis'), 'cur');
});

test('pickProjectWorker — only matches the named project', () => {
    const s = {
        a: { project: 'other', ended: null, lastSeen: iso(9_000_000) },
        b: { project: 'jarvis', ended: null, lastSeen: iso(1000) },
    };
    assert.equal(pickProjectWorker(s, 'jarvis'), 'b');
});

test('pickProjectWorker — null when no live worker hosts the project', () => {
    const s = {
        a: { project: 'jarvis', ended: iso(1), lastSeen: iso(1) },   // all retired
        b: { project: 'other', ended: null, lastSeen: iso(2) },
    };
    assert.equal(pickProjectWorker(s, 'jarvis'), null);
});

test('pickProjectWorker — a missing/garbage lastSeen still resolves a lone match (sorts oldest)', () => {
    assert.equal(pickProjectWorker({ x: { project: 'jarvis', ended: null } }, 'jarvis'), 'x');
    assert.equal(pickProjectWorker({ x: { project: 'jarvis', ended: null, lastSeen: 'not-a-date' } }, 'jarvis'), 'x');
    const s = {
        nolast: { project: 'jarvis', ended: null },                    // undefined lastSeen -> treated as oldest
        fresh:  { project: 'jarvis', ended: null, lastSeen: iso(500) },
    };
    assert.equal(pickProjectWorker(s, 'jarvis'), 'fresh');
});

test('pickProjectWorker — guards bad inputs', () => {
    assert.equal(pickProjectWorker(null, 'jarvis'), null);
    assert.equal(pickProjectWorker({}, 'jarvis'), null);
    assert.equal(pickProjectWorker({ a: { project: 'jarvis', ended: null } }, ''), null);
});

// —— lastProjectCwd — the repo an auto-revived (T2) coordinator spawns in. Unlike pickProjectWorker it
// INCLUDES ended sessions (the coordinator we revive from is by definition dead/retired), so it can
// still recover the cwd to spawn into. ——

test('lastProjectCwd — the most-recently-seen session (ended included) wins', () => {
    const s = {
        old:  { project: 'primeng', ended: iso(5000),  lastSeen: iso(1_000),     cwd: 'd:/old' },
        last: { project: 'primeng', ended: iso(9_000), lastSeen: iso(9_000_000), cwd: 'd:/code/tms' },
    };
    assert.equal(lastProjectCwd(s, 'primeng'), 'd:/code/tms');
});

test('lastProjectCwd — recovers the cwd of a dead ghost when nothing is live (the revive case)', () => {
    const s = { ghost: { project: 'primeng', ended: null, lastSeen: iso(1_000), cwd: 'd:/code/tms' } };
    assert.equal(lastProjectCwd(s, 'primeng'), 'd:/code/tms');
});

test('lastProjectCwd — only matches the named project', () => {
    const s = {
        a: { project: 'other',  ended: null, lastSeen: iso(9_000_000), cwd: 'd:/other' },
        b: { project: 'jarvis', ended: null, lastSeen: iso(1000),      cwd: 'd:/claude/jarvis-core' },
    };
    assert.equal(lastProjectCwd(s, 'jarvis'), 'd:/claude/jarvis-core');
});

test('lastProjectCwd — null when the project never had a worker (no repo to infer)', () => {
    const s = { a: { project: 'other', ended: null, lastSeen: iso(2), cwd: 'd:/other' } };
    assert.equal(lastProjectCwd(s, 'primeng'), null);
});

test('lastProjectCwd — skips sessions with no cwd, still resolves a usable one', () => {
    const s = {
        nocwd: { project: 'primeng', ended: null, lastSeen: iso(9_000_000) },   // freshest but cwd-less
        has:   { project: 'primeng', ended: iso(1), lastSeen: iso(1000), cwd: 'd:/code/tms' },
    };
    assert.equal(lastProjectCwd(s, 'primeng'), 'd:/code/tms');
});

test('lastProjectCwd — guards bad inputs', () => {
    assert.equal(lastProjectCwd(null, 'primeng'), null);
    assert.equal(lastProjectCwd({}, 'primeng'), null);
    assert.equal(lastProjectCwd({ a: { project: 'primeng', ended: null, cwd: 'd:/x' } }, ''), null);
});
