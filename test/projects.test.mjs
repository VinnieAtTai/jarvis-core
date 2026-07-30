// Unit tests for the pure project-store helpers in jarvis-text.mjs (normalizeProject, pushCapped).
// These back the persistent project-manager store; the file I/O + endpoints live in jarvis-core.mjs
// and aren't exercised here. Run with `npm test` (node --test) — no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject, pushCapped, subworkerBrief, PROJECT_LOG_CAP, BRIEF_THREADS_MAX, BRIEF_THREADS_CHARS, CMD_LINE_MAX } from '../jarvis-text.mjs';

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

// —— the brief is BOUNDED, and says so. This string is pasted verbatim into a Windows command line,
// so its length is a launch failure waiting to happen: on 2026-07-30 the store reached 46 open threads,
// the brief reached 31822 chars against CreateProcess's 32767 ceiling, and dispatch died outright --
// workers that never registered and left an empty log. The DATA was trimmed by hand; these pin the code
// half, which is that the brief no longer grows with the store however big the store gets. ——

const threads = (n, len) => Array.from({ length: n }, (_, i) => ('T' + i + ' ').padEnd(len, 'x'));
const storeOf = (openThreads) => ({ name: 'jarvis', title: 'JARVIS core', context: { openThreads } });

test('BRIEF CAP — the store may hold any number of threads; only BRIEF_THREADS_MAX reach a sub-worker', () => {
    // The COUNT cap on its own: 40 threads well inside the char budget, so nothing but the count can
    // be doing the work here.
    const b = subworkerBrief(storeOf(threads(40, 60)), null);
    assert.match(b, new RegExp('Open threads \\(' + BRIEF_THREADS_MAX + ' of 40 shown'));
    assert.equal((b.match(/T\d+ x/g) || []).length, BRIEF_THREADS_MAX, 'a different number of threads actually made it in: ' + b);
    assert.match(b, /T0 /, 'the slice is not taken from the top of the curated list');
    assert.doesNotMatch(b, new RegExp('T' + BRIEF_THREADS_MAX + ' '), 'a thread past the cap was included');
});

test('BRIEF CAP — a handful of ENORMOUS threads is capped by chars, not by the count', () => {
    // The CHAR budget on its own: 8 threads is under BRIEF_THREADS_MAX, so if only the count were
    // enforced this store would paste 24000 chars into the command line and brick the spawn.
    const b = subworkerBrief(storeOf(threads(8, 3000)), null);
    assert.ok(b.length <= BRIEF_THREADS_CHARS + 400, 'the brief blew the char budget: ' + b.length);
    assert.match(b, /Open threads \(3 of 8 shown/, 'the char budget did not bind: ' + b.slice(0, 120));
});

test('BRIEF CAP — a bounded list NEVER passes itself off as the whole list', () => {
    // THE POINT OF THE WHOLE THING. A quietly short list is indistinguishable from a project with few
    // threads, and a sub-worker would act as if the missing ones did not exist -- swapping an invisible
    // brick for an invisible blind spot. It has to name both numbers and say where the rest is.
    const b = subworkerBrief(storeOf(threads(40, 60)), null);
    assert.match(b, /Open threads \(\d+ of 40 shown/, 'the brief does not say it is a slice: ' + b.slice(0, 200));
    assert.match(b, /GET \/project for the rest/, 'the brief drops context without saying where to get it');
    // ...and the un-capped case is left exactly as it was, so no board or boot text churns for stores
    // that were never a problem.
    assert.match(subworkerBrief(storeOf(['a', 'b']), null), /Open threads: a; b\.$/);
});

test('BRIEF CAP — one thread longer than the entire budget yields its HEAD, marked, not an empty list', () => {
    // A store that is one monster entry must still tell a sub-worker something, and must not claim the
    // fragment is the whole thread. Both halves matter: dropping it silently reads as "no open threads".
    const b = subworkerBrief(storeOf([('MONSTER ').padEnd(40000, 'x')]), null);
    assert.match(b, /Open threads \(1 of 1 shown, and that one cut short/, 'the fragment is passed off as whole: ' + b.slice(0, 200));
    assert.match(b, /MONSTER/, 'the head of the only thread was dropped entirely');
    assert.match(b, / \.\.\./, 'the cut is not marked in the text');
    assert.ok(b.length <= BRIEF_THREADS_CHARS + 400, 'the monster escaped the budget: ' + b.length);
});

test('BRIEF CAP — the caps are what bind, not the shape of any one fixture', () => {
    // Driven through the opts override so the LOGIC is pinned independently of the constants' values,
    // and so a later re-tune of the defaults cannot quietly turn the tests above into no-ops.
    const b = subworkerBrief(storeOf(['aaa', 'bbb', 'ccc', 'ddd']), null, { maxThreads: 2 });
    assert.match(b, /Open threads \(2 of 4 shown/);
    assert.match(b, /aaa; bbb\./);
    const c = subworkerBrief(storeOf(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']), null, { maxChars: 22 });
    assert.match(c, /Open threads \(2 of 3 shown/, 'the char budget did not bind at 22: ' + c);
    assert.ok(c.indexOf('cccccccccc') < 0, 'a thread past the char budget was included: ' + c);
    // ...and the budget counts the '; ' that joins them. FOUND BY MUTATION PROBE: dropping the +2 from
    // the per-entry cost survived every other fixture here, because none of them sat within two chars of
    // its own budget. At 21 the two ten-char threads plus their separator are 22, so the second one no
    // longer fits -- and an accounting error puts a body over the budget while still reporting "2 of 3".
    const d = subworkerBrief(storeOf(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']), null, { maxChars: 21 });
    assert.match(d, /Open threads \(1 of 3 shown/, 'the separator is not counted against the budget: ' + d);
    assert.ok(d.slice(d.indexOf('): ') + 3, -1).length <= 21, 'the threads body is over its own budget: ' + d);
});

test('BRIEF CAP — THE 2026-07-30 STORE: the configuration that actually bricked dispatch now fits', () => {
    // The measured shape of the live store the morning it died: 46 threads averaging ~660 chars, which
    // composed a 31822-char brief against a 32767-char ceiling. This is the regression, stated as the
    // thing that went wrong rather than as a property -- and it runs on the SHIPPING defaults, so it is
    // the one test here that would notice the constants being raised back into danger.
    const b = subworkerBrief({
        name: 'jarvis', title: 'JARVIS core',
        context: { summary: 'x'.repeat(467), currentFocus: 'y'.repeat(221), openThreads: threads(46, 660) },
    }, { title: 'A mission', phases: [{ done: true }, { done: false }] });
    assert.ok(b.length < 12000, 'the brief is back to scaling with the store: ' + b.length + ' chars');
    assert.ok(b.length * 2 < CMD_LINE_MAX, 'the brief alone is within a factor of two of the command-line ceiling: ' + b.length);
    // And it is still a BRIEF: the parts a sub-worker cannot get anywhere cheaply are all present.
    assert.match(b, /the jarvis project \("JARVIS core"\)/);
    assert.match(b, /serving the mission "A mission" \(1 of 2 phases done\)/);
    assert.match(b, /Where it stands: x{467}/);
    assert.match(b, /Current focus: y{221}\./);
    assert.match(b, /Open threads \(\d+ of 46 shown/);
});
