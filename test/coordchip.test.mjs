// Unit tests for the mission rail's ROLE decision -- railRole + coordTip in console.js.
//
// The gap: the rail showed HIERARCHY (indent + arrow) but never ROLE or IDENTITY. Chris looked at the
// PrimeNG rail -- PRIMENG with LIMA and XRAY under it -- and asked two questions a minute apart:
// "shouldn't one of them be a coordinator or something?" and "wait isn't oscar the coordinator?".
// Both were rendering gaps over data already on the row. Whether the parent read as the brain depended
// entirely on its doing-line, which at that moment said "working: bulk-operations guard fix" and read
// as a third peer; and the row printed the PROJECT key, so the session driving it (oscar) was nowhere.
//
// console.js is browser script, so the pure functions are lifted out of the source by name -- same
// approach as test/nesting.test.mjs and test/richtext.test.mjs, and it fails loudly if either is
// renamed. What the gate CANNOT see (that the chip reaches the DOM, that its tooltip is escaped, that
// a sub-worker row does not print its callsign twice) is covered in real headless Chrome by
// test-support/verify-coordchip-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../console.js', import.meta.url), 'utf8');
function lift(name) {
    const start = src.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, 'console.js no longer defines ' + name + ' -- update this test');
    let i = src.indexOf('{', start), depth = 0;
    for (let n = i; n < src.length; n++) {
        if (src[n] === '{') depth++;
        else if (src[n] === '}' && --depth === 0) return src.slice(start, n + 1);
    }
    throw new Error('unbalanced braces reading ' + name);
}
const railRole = new Function(lift('railRole') + '\nreturn railRole;')();
const coordTip = new Function(lift('coordTip') + '\nreturn coordTip;')();

// The live shapes, as GET /board actually emits them (measured against a scratch hub, not guessed):
// the project card carries projectContext + `worker` (the NATO session driving it); a sub-worker card
// carries only parentProject.
const MID = 'm_ms6q9pz00fg';
const COORD = { callsign: 'primeng', uid: 's_0001', worker: 'oscar', projectContext: { name: 'primeng', title: 'PrimeNG 17 -> 18', missionId: MID } };
const SUB = { callsign: 'lima', uid: 's_0002', worker: null, parentProject: 'primeng' };
const LONER = { callsign: 'delta', uid: 's_0003', worker: null };

test('railRole -- the project card carrying the mission is the coordinator', () => {
    assert.equal(railRole(COORD), 'coord');
});

test('railRole -- a card carrying only parentProject is a sub-worker', () => {
    assert.equal(railRole(SUB), 'sub');
    assert.equal(railRole({ callsign: 'xray', parentProject: 'PrimeNG' }), 'sub', 'casing is not this function\'s business');
});

test('railRole -- a card bound to nothing is a plain worker', () => {
    assert.equal(railRole(LONER), 'worker');
});

test('railRole -- THE RULE: role is how the session is BOUND, never how many children it has', () => {
    // The judgement call this feature turns on. railRole is given ONE row and no board list, so it
    // structurally cannot consult the children -- a coordinator alone on its mission is still labelled
    // the coordinator. The rejected alternative (chip only when sub-workers exist) would flash the chip
    // on and off as children spawn and retire, and would leave a lone coordinator unlabelled at exactly
    // the moment there is no indentation hinting at a hierarchy either.
    assert.equal(railRole(COORD), 'coord', 'no sub-worker anywhere in sight, still the coordinator');
    assert.equal(coordTip(COORD).includes('COORDINATOR'), true);
    assert.equal(railRole.length, 1, 'a one-argument signature is what makes the rule unbreakable');
});

test('railRole -- own project context WINS over parentProject if a row somehow carries both', () => {
    // registerSession makes these mutually exclusive; if that regresses, the row is a coordinator of
    // its own mission rather than a child of someone else's -- the same priority missionIdOfCard uses,
    // so the rail cannot nest a row one way and label it the other.
    assert.equal(railRole({ callsign: 'x', parentProject: 'primeng', projectContext: { missionId: MID } }), 'coord');
});

test('railRole -- a project card with NO mission is not a rail coordinator', () => {
    // The jarvis project has no missionId, so its card never matches a mission and never reaches the
    // rail (missionIdOfCard returns null). Labelling it 'coord' would be a claim about a row that
    // cannot be there.
    assert.equal(railRole({ callsign: 'jarvis', projectContext: { name: 'jarvis', missionId: null } }), 'worker');
    assert.equal(railRole({ callsign: 'jarvis', projectContext: { name: 'jarvis', missionId: null }, parentProject: 'other' }), 'sub');
});

test('railRole -- sub-ness is the EXACT negation of the old inline flag, over every combination', () => {
    // The rail indents on `sub` and labels on `role`; if those two ever disagree, a row renders
    // indented AND badged as the brain. Pinning railRole against the flag it replaced is what keeps
    // nesting and labelling from drifting apart.
    const oldSub = (b) => !!(b.parentProject && !(b.projectContext && b.projectContext.missionId));
    for (const parentProject of [null, 'primeng']) {
        for (const projectContext of [null, {}, { missionId: null }, { missionId: MID }]) {
            const row = { callsign: 'x', parentProject, projectContext };
            assert.equal(railRole(row) === 'sub', oldSub(row), JSON.stringify(row));
        }
    }
});

test('railRole -- garbage in, plain worker out, never a throw (it runs inside a render loop)', () => {
    for (const bad of [null, undefined, {}, { callsign: null }, { projectContext: {} }, { parentProject: '' }, { projectContext: { missionId: '' } }]) {
        assert.equal(railRole(bad), 'worker', JSON.stringify(bad));
    }
});

test('coordTip -- says the role, names the project, and names the session driving it', () => {
    const tip = coordTip(COORD);
    assert.match(tip, /^COORDINATOR of PrimeNG 17 -> 18/, tip);
    assert.match(tip, /session OSCAR/, 'Chris\'s second question was WHO -- the tooltip has to answer it: ' + tip);
    assert.match(tip, /dispatches the sub-workers/, tip);
});

test('coordTip -- prefers the project TITLE, falls back to its name, then to the row callsign', () => {
    assert.match(coordTip({ callsign: 'primeng', projectContext: { name: 'primeng', title: 'PrimeNG 17 -> 18' } }), /of PrimeNG 17 -> 18/);
    assert.match(coordTip({ callsign: 'primeng', projectContext: { name: 'primeng', title: '' } }), /of primeng/);
    assert.match(coordTip({ callsign: 'primeng' }), /of PRIMENG/, 'no project context at all still reads as a sentence');
});

test('coordTip -- omits the session clause entirely when no worker is bound', () => {
    // b.worker is null when the card's own callsign IS the session, so the clause must not render as
    // "run by session " with nothing after it.
    const tip = coordTip({ callsign: 'primeng', projectContext: { name: 'primeng', title: 'P' }, worker: null });
    assert.equal(/session/.test(tip), false, tip);
    assert.match(tip, /^COORDINATOR of P --/, tip);
});

test('coordTip -- garbage in, a sentence out, never a throw', () => {
    for (const bad of [null, undefined, {}, { projectContext: null }, { worker: '' }]) {
        assert.match(coordTip(bad), /^COORDINATOR of /, JSON.stringify(bad));
    }
});

test('coordTip -- does NOT escape: the caller does, and the browser test proves it', () => {
    // The project title is operator-supplied and lands in a title="" attribute. coordTip is
    // deliberately plain text; escAttr at the call site is the guard. If someone "helpfully" makes
    // coordTip escape too, the attribute double-escapes and Chris reads &quot; in his tooltip -- so
    // this pins the division of labour.
    assert.match(coordTip({ callsign: 'p', projectContext: { title: 'a "quoted" <title>' } }), /a "quoted" <title>/);
});
