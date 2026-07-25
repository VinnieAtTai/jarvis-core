// Unit tests for nextFocusKey in jarvis-text.mjs -- where console focus lands when the focused
// board is torn down (a retire, a /forget).
//
// The bug it fixes, hit for real on 2026-07-24: Chris forgot a dead card and focus jumped to
// "charlie" -- a worker bound to the jarvis PROJECT -- which both stole his focus and made a
// phantom standalone CHARLIE card appear on the board. A project worker renders on its project's
// card; its NATO callsign has no card at all, so focusing it invents one.
// Run with `npm test` (node --test) -- no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFocusKey } from '../jarvis-text.mjs';

const plain = cs => ({ callsign: cs, project: null });
const bound = (cs, project) => ({ callsign: cs, project });

test('nextFocusKey -- a plain worker is focused by its own callsign', () => {
    assert.equal(nextFocusKey([plain('sierra')]), 'sierra');
});

test('nextFocusKey -- THE REPRO: a project worker is focused by its PROJECT, not its callsign', () => {
    // charlie is bound to the jarvis project -> focus must land on 'jarvis', never 'charlie'.
    assert.equal(nextFocusKey([bound('charlie', 'jarvis')]), 'jarvis');
});

test('nextFocusKey -- no live sessions falls back to the solo brain', () => {
    assert.equal(nextFocusKey([]), 'jarvis');
    assert.equal(nextFocusKey(null), 'jarvis');
    assert.equal(nextFocusKey(undefined), 'jarvis');
});

test('nextFocusKey -- takes the first candidate in the order given', () => {
    assert.equal(nextFocusKey([plain('sierra'), plain('tango')]), 'sierra');
});

test('nextFocusKey -- skips the board being torn down', () => {
    assert.equal(nextFocusKey([plain('sierra'), plain('tango')], 'sierra'), 'tango');
});

test('nextFocusKey -- exclude matches on the BOARD KEY, so a project card is skipped by project name', () => {
    // Retiring the jarvis project card must not hand focus straight back to a jarvis-bound worker.
    assert.equal(nextFocusKey([bound('charlie', 'jarvis'), plain('sierra')], 'jarvis'), 'sierra');
});

test('nextFocusKey -- excluding the last candidate falls back to the solo brain', () => {
    assert.equal(nextFocusKey([plain('sierra')], 'sierra'), 'jarvis');
});

test('nextFocusKey -- a mixed roster prefers whichever board key comes first', () => {
    assert.equal(nextFocusKey([bound('lima', 'primeng'), plain('sierra')]), 'primeng');
    assert.equal(nextFocusKey([plain('sierra'), bound('lima', 'primeng')]), 'sierra');
});

test('nextFocusKey -- never returns a raw callsign for ANY project-bound candidate', () => {
    const live = [bound('charlie', 'jarvis'), bound('lima', 'primeng'), bound('mike', 'jarvis')];
    for (const ex of [null, 'jarvis', 'primeng']) {
        const got = nextFocusKey(live, ex);
        assert.ok(!['charlie', 'lima', 'mike'].includes(got), 'leaked a raw project-worker callsign: ' + got);
    }
});

test('nextFocusKey -- malformed candidates are skipped, not thrown on', () => {
    assert.equal(nextFocusKey([null, undefined, {}, plain('sierra')]), 'sierra');
    assert.equal(nextFocusKey([null, {}]), 'jarvis');
});
