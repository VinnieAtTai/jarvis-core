// Unit tests for pickProjectWorker — the pure project->worker resolver behind projectWorkerUid in
// jarvis-core.mjs. It backs speech routing + the board's worker binding, so the invisible-coordinator
// regression (a dead, non-ended "ghost" shadowing a live coordinator — the T2 root cause) is exactly
// what these guard. Run with `npm test` (node --test) — no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickProjectWorker } from '../jarvis-text.mjs';

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
