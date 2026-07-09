// Unit tests for the pure helper in stt.mjs (cleanText). Run with `npm test` (node --test).
// No server boot, no whisper spawn, no I/O — importing stt.mjs only defines functions; the local
// STT process is spawned lazily by ensureReady(), which these tests never call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, isReady } from '../stt.mjs';

test('cleanText — trims and collapses whitespace', () => {
    assert.equal(cleanText('  hello   there  '), 'hello there');
    assert.equal(cleanText('line one\n line two'), 'line one line two');
});

test('cleanText — strips bracketed non-speech markers', () => {
    assert.equal(cleanText('[BLANK_AUDIO]'), '');
    assert.equal(cleanText(' [ Silence ] '), '');
    assert.equal(cleanText('hello [noise] world'), 'hello world');
});

test('cleanText — strips parenthetical silence/blank markers', () => {
    assert.equal(cleanText('(silence)'), '');
    assert.equal(cleanText('(no speech)'), '');
    assert.equal(cleanText('(BLANK_AUDIO)'), '');
    // A normal parenthetical aside is NOT stripped — only the known non-speech markers are.
    assert.equal(cleanText('call me (please)'), 'call me (please)');
});

test('cleanText — nullish and non-string input yields empty string', () => {
    assert.equal(cleanText(null), '');
    assert.equal(cleanText(undefined), '');
    assert.equal(cleanText(42), '42');
});

test('isReady — false before any ensureReady() (no process spawned)', () => {
    assert.equal(isReady(), false);
});
