// Unit tests for the pure mission helpers in jarvis-text.mjs — the shape coercion (normalizeMission,
// missionProgress) and the voice-gate phrase predicates (close intent, yes/no confirmation, new-
// mission parse, multi-mission targeting) that back the persistent, voice-gated mission tracker. The
// file I/O + endpoints + the state machine live in jarvis-core.mjs and aren't exercised here. Run
// with `npm test` (node --test) — no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeMission, missionProgress,
    isMissionCloseIntent, isMissionConfirm, isMissionCancel,
    parseNewMissionTitle, matchMissionByPhrase,
} from '../jarvis-text.mjs';

// —— normalizeMission ——

test('normalizeMission — a bare {title} backfills the full shape without inventing time', () => {
    const m = normalizeMission({ title: 'PrimeNG 17 → 18' }, 'm_fallback');
    assert.equal(m.id, 'm_fallback');
    assert.equal(m.title, 'PrimeNG 17 → 18');
    assert.deepEqual(m.phases, []);
    assert.deepEqual(m.docs, []);
    assert.equal(m.status, 'active');
    assert.equal(m.createdAt, '');     // pure — never stamps a timestamp (the hub does)
    assert.equal(m.archivedAt, null);
});

test('normalizeMission — returns null only for a non-object (junk row dropped)', () => {
    assert.equal(normalizeMission(null, 'i'), null);
    assert.equal(normalizeMission(undefined, 'i'), null);
    assert.equal(normalizeMission('nope', 'i'), null);
    assert.equal(normalizeMission(42, 'i'), null);
});

test('normalizeMission — stays lenient on an empty title (not null; /mission add 400s instead)', () => {
    assert.equal(normalizeMission({ title: '' }, 'i').title, '');
    assert.equal(normalizeMission({ title: '   ' }, 'i').title, '');
    assert.equal(normalizeMission({ title: null }, 'i').title, '');
    assert.equal(normalizeMission({}, 'i').title, '');
});

test('normalizeMission — trims the title', () => {
    assert.equal(normalizeMission({ title: '  Ship the thing  ' }, 'i').title, 'Ship the thing');
});

test('normalizeMission — keeps an existing id, falls back to the supplied one when blank/absent', () => {
    assert.equal(normalizeMission({ title: 'x', id: 'm_existing' }, 'm_fb').id, 'm_existing');
    assert.equal(normalizeMission({ title: 'x', id: '   ' }, 'm_fb').id, 'm_fb');   // blank id → fallback
    assert.equal(normalizeMission({ title: 'x' }, 'm_fb').id, 'm_fb');
    assert.equal(normalizeMission({ title: 'x' }, null).id, '');                    // no fallback → ''
});

test('normalizeMission — coerces phases (string, object, missing done, non-object)', () => {
    const m = normalizeMission({ title: 'x', phases: ['a', { text: 'b', done: true }, { text: 'c' }, 5] }, 'i');
    assert.deepEqual(m.phases, [
        { text: 'a', done: false },
        { text: 'b', done: true },
        { text: 'c', done: false },
        { text: '5', done: false },
    ]);
});

test('normalizeMission — a non-array phases becomes an empty list', () => {
    assert.deepEqual(normalizeMission({ title: 'x', phases: 'nope' }, 'i').phases, []);
});

test('normalizeMission — normalizes docs (string or {url} or {label,url})', () => {
    const m = normalizeMission({ title: 'x', docs: ['http://d/1', { url: 'http://d/2' }, { label: 'Spec', url: 'http://d/3' }] }, 'i');
    assert.deepEqual(m.docs, [
        { label: 'http://d/1', url: 'http://d/1' },
        { label: 'http://d/2', url: 'http://d/2' },
        { label: 'Spec', url: 'http://d/3' },
    ]);
});

test('normalizeMission — restricts status to active|archived', () => {
    assert.equal(normalizeMission({ title: 'x' }, 'i').status, 'active');
    assert.equal(normalizeMission({ title: 'x', status: 'archived' }, 'i').status, 'archived');
    assert.equal(normalizeMission({ title: 'x', status: 'bogus' }, 'i').status, 'active');
});

test('normalizeMission — preserves stored timestamps as strings, never invents them', () => {
    const m = normalizeMission({ title: 'x', createdAt: 'c', archivedAt: 'a' }, 'i');
    assert.equal(m.createdAt, 'c');
    assert.equal(m.archivedAt, 'a');
});

// —— missionProgress ——

test('missionProgress — no phases reads as 0', () => {
    assert.equal(missionProgress({ phases: [] }), 0);
    assert.equal(missionProgress({}), 0);
    assert.equal(missionProgress(null), 0);       // tolerant of a bad mission
});

test('missionProgress — rounds the done fraction to a percent', () => {
    assert.equal(missionProgress({ phases: [{ done: true }, { done: false }] }), 50);
    assert.equal(missionProgress({ phases: [{ done: true }, { done: true }, { done: true }] }), 100);
    assert.equal(missionProgress({ phases: [{ done: true }, { done: false }, { done: false }] }), 33);   // 33.3 → 33
    assert.equal(missionProgress({ phases: [{ done: true }, { done: true }, { done: false }] }), 67);    // 66.7 → 67
});

// —— voice-gate phrase predicates ——

test('isMissionCloseIntent — arms on "mission accomplished" and close/complete/finish/archive mission', () => {
    assert.equal(isMissionCloseIntent('mission accomplished'), true);
    assert.equal(isMissionCloseIntent('close the mission'), true);
    assert.equal(isMissionCloseIntent('complete this mission'), true);
    assert.equal(isMissionCloseIntent('finish mission'), true);
    assert.equal(isMissionCloseIntent('archive the mission'), true);
});

test('isMissionCloseIntent — does not fire on unrelated mission talk', () => {
    assert.equal(isMissionCloseIntent('what is the mission'), false);
    assert.equal(isMissionCloseIntent('add a phase to the mission'), false);
    assert.equal(isMissionCloseIntent(''), false);
    assert.equal(isMissionCloseIntent(null), false);
});

test('isMissionConfirm — accepts the affirmative variants', () => {
    for (const s of ['yes', 'yeah', 'yep', 'confirm', 'confirmed', 'do it', 'affirmative', "i'm sure", 'absolutely', 'aye']) {
        assert.equal(isMissionConfirm(s), true, s);
    }
    assert.equal(isMissionConfirm('no'), false);
    assert.equal(isMissionConfirm('not yet'), false);
});

test('isMissionCancel — accepts the negative variants', () => {
    for (const s of ['no', 'nope', 'cancel', 'stop', 'never mind', 'nevermind', 'not yet', 'hold on', 'wait']) {
        assert.equal(isMissionCancel(s), true, s);
    }
    assert.equal(isMissionCancel('yes'), false);
    assert.equal(isMissionCancel('absolutely'), false);
});

test('parseNewMissionTitle — pulls the title and keeps its casing', () => {
    assert.equal(parseNewMissionTitle('new mission: PrimeNG 17 to 18'), 'PrimeNG 17 to 18');
    assert.equal(parseNewMissionTitle('jarvis, start a mission: Ship v2'), 'Ship v2');
    assert.equal(parseNewMissionTitle('add mission Cleanup the docs'), 'Cleanup the docs');   // \s in [:\s]+ allows no colon
    assert.equal(parseNewMissionTitle('  begin a mission:  Trailing  '), 'Trailing');
});

test('parseNewMissionTitle — returns null when it is not a mission-create phrase', () => {
    assert.equal(parseNewMissionTitle('what is the mission'), null);
    assert.equal(parseNewMissionTitle('start listening'), null);         // not a mission phrase
    assert.equal(parseNewMissionTitle('mission accomplished'), null);
    assert.equal(parseNewMissionTitle(''), null);
    assert.equal(parseNewMissionTitle(null), null);
});

test('matchMissionByPhrase — a single active mission always wins', () => {
    const only = { id: 'm1', title: 'PrimeNG 17 → 18' };
    assert.equal(matchMissionByPhrase([only], 'anything at all'), only);
});

test('matchMissionByPhrase — with several, matches on the title\'s leading word', () => {
    const a = { id: 'm1', title: 'PrimeNG 17 → 18' };
    const b = { id: 'm2', title: 'Docs revamp' };
    assert.equal(matchMissionByPhrase([a, b], 'close the primeng mission'), a);
    assert.equal(matchMissionByPhrase([a, b], 'finish the docs mission'), b);
});

test('matchMissionByPhrase — null when several are active and none is named', () => {
    const a = { id: 'm1', title: 'PrimeNG 17 → 18' };
    const b = { id: 'm2', title: 'Docs revamp' };
    assert.equal(matchMissionByPhrase([a, b], 'mission accomplished'), null);
    assert.equal(matchMissionByPhrase([], 'mission accomplished'), null);
});
