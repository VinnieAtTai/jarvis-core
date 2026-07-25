// Unit tests for the console-focus resolver + the successor focus-steal guard in jarvis-text.mjs.
// focusHeldByLiveOther is the fix for the recurring bug where registering a new session (a jarvis
// successor, or a fresh sub-worker) yanked the human's voice onto itself mid-conversation with a
// DIFFERENT live worker — e.g. it misrouted ~3.5min of Chris's PrimeNG walkthrough (sierra) onto
// jarvis. The guard: a project worker grabs focus on register ONLY when focus is idle, never when a
// different live worker already holds it. Run with `npm test` (node --test) — no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { focusHolderUid, focusHeldByLiveOther } from '../jarvis-text.mjs';

const NOW = 10_000_000;
const iso = ms => new Date(ms).toISOString();
const fresh = iso(NOW - 1_000);     // seen 1s ago -> live
const stale = iso(NOW - 300_000);   // seen 5min ago -> gone quiet (past the 2min window)

// —— focusHolderUid — resolve the session currently holding focus ——

test('focusHolderUid — jarvis / empty / null focus holds nobody', () => {
    assert.equal(focusHolderUid('jarvis', {}, {}), null);
    assert.equal(focusHolderUid('', {}, {}), null);
    assert.equal(focusHolderUid(null, {}, {}), null);
});

test('focusHolderUid — a NATO callsign resolves to its newest non-ended session', () => {
    const sessions = { s5: { callsign: 'sierra', ended: null, lastSeen: fresh } };
    assert.equal(focusHolderUid('sierra', sessions, { sierra: ['s5'] }), 's5');
});

test('focusHolderUid — a retired callsign holds nobody', () => {
    const sessions = { s5: { callsign: 'sierra', ended: iso(NOW - 5000), lastSeen: fresh } };
    assert.equal(focusHolderUid('sierra', sessions, { sierra: ['s5'] }), null);
});

test('focusHolderUid — a project name resolves via pickProjectWorker', () => {
    const sessions = { s9: { project: 'primeng', ended: null, lastSeen: fresh } };
    assert.equal(focusHolderUid('primeng', sessions, {}), 's9');
});

// —— focusHeldByLiveOther — the successor/sub-worker focus-steal guard ——

test('does NOT steal: focus on a live DIFFERENT worker (the sierra-walkthrough bug)', () => {
    // charlie (jarvis project) registers while Chris is mid-walkthrough talking to sierra.
    const sessions = {
        s_sierra: { callsign: 'sierra', ended: null, lastSeen: fresh },
        s_charlie: { callsign: 'charlie', project: 'jarvis', ended: null, lastSeen: fresh },
    };
    const callsigns = { sierra: ['s_sierra'], charlie: ['s_charlie'] };
    assert.equal(focusHeldByLiveOther('sierra', sessions, callsigns, 's_charlie', NOW), true);
});

test('does NOT steal: focus on a live DIFFERENT project coordinator', () => {
    const sessions = {
        s_primeng: { callsign: 'sierra', project: 'primeng', ended: null, lastSeen: fresh },
        s_charlie: { callsign: 'charlie', project: 'jarvis', ended: null, lastSeen: fresh },
    };
    const callsigns = { sierra: ['s_primeng'], charlie: ['s_charlie'] };
    assert.equal(focusHeldByLiveOther('primeng', sessions, callsigns, 's_charlie', NOW), true);
});

test('grabs focus: nobody holds it (focus idle on jarvis)', () => {
    const sessions = { s_charlie: { callsign: 'charlie', project: 'jarvis', ended: null, lastSeen: fresh } };
    assert.equal(focusHeldByLiveOther('jarvis', sessions, { charlie: ['s_charlie'] }, 's_charlie', NOW), false);
});

test('grabs focus: the current holder has gone quiet (stale > 2min)', () => {
    const sessions = {
        s_old: { callsign: 'sierra', ended: null, lastSeen: stale },
        s_charlie: { callsign: 'charlie', project: 'jarvis', ended: null, lastSeen: fresh },
    };
    const callsigns = { sierra: ['s_old'], charlie: ['s_charlie'] };
    assert.equal(focusHeldByLiveOther('sierra', sessions, callsigns, 's_charlie', NOW), false);
});

test('grabs focus: the current holder retired', () => {
    const sessions = {
        s_old: { callsign: 'sierra', ended: iso(NOW - 1000), lastSeen: fresh },
        s_charlie: { callsign: 'charlie', project: 'jarvis', ended: null, lastSeen: fresh },
    };
    const callsigns = { sierra: ['s_old'], charlie: ['s_charlie'] };
    assert.equal(focusHeldByLiveOther('sierra', sessions, callsigns, 's_charlie', NOW), false);
});

test('not a steal: a project successor re-grabbing its OWN project focus', () => {
    // focus already on the primeng project; the newly-registered primeng coordinator IS its holder.
    const sessions = { s_new: { callsign: 'sierra', project: 'primeng', ended: null, lastSeen: fresh } };
    assert.equal(focusHeldByLiveOther('primeng', sessions, { sierra: ['s_new'] }, 's_new', NOW), false);
});
