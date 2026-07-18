// Unit tests for the pure project-store helpers in jarvis-text.mjs (normalizeProject, pushCapped).
// These back the persistent project-manager store; the file I/O + endpoints live in jarvis-core.mjs
// and aren't exercised here. Run with `npm test` (node --test) — no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject, pushCapped, subworkerBrief, PROJECT_LOG_CAP } from '../jarvis-text.mjs';

test('normalizeProject — a bare {name} backfills the full shape', () => {
    const p = normalizeProject({ name: 'PrimeNG' });
    assert.equal(p.name, 'primeng');            // lowercased
    assert.equal(p.title, 'primeng');           // defaults to the name
    assert.equal(p.status, 'active');
    assert.equal(p.missionId, null);
    assert.equal(p.managerUid, null);
    assert.deepEqual(p.context, { summary: '', currentFocus: '', openThreads: [], recentLog: [], docs: [] });
    assert.deepEqual(p.workers, []);
    assert.equal(p.createdAt, '');              // pure — never invents a timestamp
    assert.equal(p.updatedAt, '');
});

test('normalizeProject — drops a row with no usable name', () => {
    assert.equal(normalizeProject({}), null);
    assert.equal(normalizeProject({ name: '   ' }), null);
    assert.equal(normalizeProject(null), null);
    assert.equal(normalizeProject('nope'), null);
});

test('normalizeProject — coerces a bad status to active and trims the title', () => {
    assert.equal(normalizeProject({ name: 'x', status: 'bogus' }).status, 'active');
    assert.equal(normalizeProject({ name: 'x', status: 'paused' }).status, 'paused');
    assert.equal(normalizeProject({ name: 'x', title: '  Waterfall Tendering PS-23  ' }).title, 'Waterfall Tendering PS-23');
});

test('normalizeProject — cleans open threads (strings, trimmed, no blanks)', () => {
    const p = normalizeProject({ name: 'x', context: { openThreads: ['  a ', '', 'b', 3] } });
    assert.deepEqual(p.context.openThreads, ['a', 'b', '3']);
});

test('normalizeProject — normalizes docs (string or {label,url}) and drops junk log entries', () => {
    const p = normalizeProject({ name: 'x', context: {
        docs: ['http://d/1', { url: 'http://d/2' }, { label: 'Spec', url: 'http://d/3' }],
        recentLog: [{ note: 'ok', from: 'mike', ts: 't' }, null, 'junk', { note: 42 }],
    } });
    assert.deepEqual(p.context.docs, [
        { label: 'http://d/1', url: 'http://d/1' },
        { label: 'http://d/2', url: 'http://d/2' },
        { label: 'Spec', url: 'http://d/3' },
    ]);
    // only object entries survive; note is coerced to a string
    assert.deepEqual(p.context.recentLog, [
        { ts: 't', from: 'mike', note: 'ok' },
        { ts: '', from: '', note: '42' },
    ]);
});

test('normalizeProject — clamps an over-long stored log to the cap', () => {
    const big = Array.from({ length: PROJECT_LOG_CAP + 20 }, (_, i) => ({ note: 'n' + i }));
    const p = normalizeProject({ name: 'x', context: { recentLog: big } });
    assert.equal(p.context.recentLog.length, PROJECT_LOG_CAP);
    assert.equal(p.context.recentLog[0].note, 'n20');                       // oldest 20 dropped
    assert.equal(p.context.recentLog.at(-1).note, 'n' + (PROJECT_LOG_CAP + 19));
});

test('normalizeProject — preserves existing timestamps and manager binding', () => {
    const p = normalizeProject({ name: 'x', managerUid: 's_0007', createdAt: 'c', updatedAt: 'u' });
    assert.equal(p.managerUid, 's_0007');
    assert.equal(p.createdAt, 'c');
    assert.equal(p.updatedAt, 'u');
});

test('pushCapped — appends and returns a NEW array (no mutation)', () => {
    const arr = [1, 2];
    const out = pushCapped(arr, 3, 10);
    assert.deepEqual(out, [1, 2, 3]);
    assert.deepEqual(arr, [1, 2]);   // input untouched
});

test('pushCapped — keeps only the most recent `cap` entries', () => {
    let log = [];
    for (let i = 0; i < 5; i++) log = pushCapped(log, i, 3);
    assert.deepEqual(log, [2, 3, 4]);
});

test('pushCapped — tolerates a non-array seed and defaults to PROJECT_LOG_CAP', () => {
    assert.deepEqual(pushCapped(null, 'a', 2), ['a']);
    assert.deepEqual(pushCapped(undefined, 'a'), ['a']);
    const many = Array.from({ length: PROJECT_LOG_CAP + 5 }, (_, i) => i);
    let out = many;
    out = pushCapped(out, 'last');
    assert.equal(out.length, PROJECT_LOG_CAP);
    assert.equal(out.at(-1), 'last');
});

// —— subworkerBrief — the read-only STORY a parentProject sub-worker is seeded with on boot. It is
// what makes "workers get their context from the mission" real, so the composition is worth pinning. ——

test('subworkerBrief — full: project + mission (phases) + summary + focus + threads', () => {
    const project = {
        name: 'primeng', title: 'PrimeNG 17 → 18',
        context: { summary: 'Bump done, theming migrated.', currentFocus: 'p-fileUpload API', openThreads: ['dialog focus trap', 'styled-mode tokens'] },
    };
    const mission = { title: 'PrimeNG 17 → 18 upgrade', phases: [{ done: true }, { done: true }, { done: false }, { done: false }, { done: false }] };
    const b = subworkerBrief(project, mission);
    assert.match(b, /the primeng project \("PrimeNG 17 → 18"\)/);
    assert.match(b, /serving the mission "PrimeNG 17 → 18 upgrade" \(2 of 5 phases done\)/);
    assert.match(b, /Where it stands: Bump done, theming migrated\./);
    assert.match(b, /Current focus: p-fileUpload API\./);
    assert.match(b, /Open threads: dialog focus trap; styled-mode tokens\./);
});

test('subworkerBrief — project without a mission omits the mission clause', () => {
    const b = subworkerBrief({ name: 'jarvis', title: 'JARVIS core', context: { summary: 'Hub is healthy.' } }, null);
    assert.match(b, /the jarvis project \("JARVIS core"\)\. Where it stands: Hub is healthy\./);
    assert.doesNotMatch(b, /mission/i);
    assert.doesNotMatch(b, /phases done/);
});

test('subworkerBrief — mission with no phases omits the progress count', () => {
    const b = subworkerBrief({ name: 'x', title: 'X', context: {} }, { title: 'Some Mission', phases: [] });
    assert.match(b, /serving the mission "Some Mission"\./);
    assert.doesNotMatch(b, /phases done/);
});

test('subworkerBrief — empty context yields just the heading sentence', () => {
    assert.equal(subworkerBrief({ name: 'x', title: 'X', context: {} }, null), 'the x project ("X").');
    assert.equal(subworkerBrief({ name: 'x' }, null), 'the x project ("x").');   // title defaults to name
});

test('subworkerBrief — trims/drops blank open threads', () => {
    const b = subworkerBrief({ name: 'x', title: 'X', context: { openThreads: ['  a ', '', '  ', 'b'] } }, null);
    assert.match(b, /Open threads: a; b\./);
});

test('subworkerBrief — guards a missing project', () => {
    assert.equal(subworkerBrief(null, { title: 'M' }), '');
    assert.equal(subworkerBrief(undefined, null), '');
    assert.equal(subworkerBrief('nope', null), '');
});
