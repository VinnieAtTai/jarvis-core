// Unit tests for missionIdOfCard in console.js -- deciding which mission a board card hangs under,
// which is what makes the mission rail show a hierarchy instead of a flat list.
//
// The bug: the rail matched a card only by `projectContext.missionId`. A PROJECT COORDINATOR carries
// that; a SUB-WORKER never does -- it renders on its own NATO card and carries only `parentProject`
// (a session is one role or the other, never both). So sub-workers matched no mission and were
// invisible in the rail. Three board cards sat queued asking Chris to "verify sub-worker nesting in
// the browser" when the lookup could not possibly have matched them; the code was never written.
//
// console.js is browser script, so the pure function is lifted out of the source by name -- same
// approach as test/richtext.test.mjs, and it fails loudly if the function is renamed.
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
const missionIdOfCard = new Function(lift('missionIdOfCard') + '\nreturn missionIdOfCard;')();

// A realistic /board shape: the primeng coordinator card, two sub-workers hanging off it, and an
// unrelated standalone worker.
const MID = 'm_mqzmh4u8037';
const COORD = { callsign: 'primeng', uid: 's_0339', projectContext: { name: 'primeng', missionId: MID } };
const SUB_A = { callsign: 'bravo', uid: 's_0315', parentProject: 'primeng', projectContext: null };
const SUB_B = { callsign: 'sierra', uid: 's_0320', parentProject: 'PrimeNG' };          // case as typed
const LONER = { callsign: 'delta', uid: 's_0400' };
const BOARDS = [SUB_A, COORD, LONER, SUB_B];

test('missionIdOfCard -- a coordinator answers from its own projectContext', () => {
    assert.equal(missionIdOfCard(COORD, BOARDS), MID);
});

test('missionIdOfCard -- THE FIX: a sub-worker inherits its mission through parentProject', () => {
    assert.equal(missionIdOfCard(SUB_A, BOARDS), MID);
    assert.equal(missionIdOfCard(SUB_B, BOARDS), MID, 'parentProject casing must not matter');
});

test('missionIdOfCard -- a card belonging to nothing stays unnested (it keeps its own board card)', () => {
    assert.equal(missionIdOfCard(LONER, BOARDS), null);
});

test('missionIdOfCard -- a sub-worker of a project with NO mission does not nest', () => {
    // The jarvis project has no missionId, so its sub-workers must not be swallowed into some
    // other mission or crash the rail.
    const boards = [{ callsign: 'jarvis', uid: 's_1', projectContext: { name: 'jarvis', missionId: null } },
                    { callsign: 'hotel', uid: 's_2', parentProject: 'jarvis' }];
    assert.equal(missionIdOfCard(boards[1], boards), null);
});

test('missionIdOfCard -- a sub-worker whose parent card is absent does not throw', () => {
    // The coordinator may have retired while the sub-worker is still live, so its card can be gone.
    assert.equal(missionIdOfCard({ callsign: 'bravo', uid: 's_9', parentProject: 'primeng' }, [LONER]), null);
    assert.equal(missionIdOfCard(SUB_A, []), null);
    assert.equal(missionIdOfCard(SUB_A, null), null);
});

test('missionIdOfCard -- garbage in, null out, never a throw (it runs inside a render loop)', () => {
    for (const bad of [null, undefined, {}, { callsign: null }, { projectContext: {} }, { parentProject: '' }]) {
        assert.equal(missionIdOfCard(bad, BOARDS), null, JSON.stringify(bad));
    }
    assert.equal(missionIdOfCard({ parentProject: 'primeng' }, [null, undefined, COORD]), MID,
        'a malformed row in the board list must not stop the lookup');
});

test('missionIdOfCard -- own projectContext WINS over parentProject if a card somehow carries both', () => {
    // registerSession makes these mutually exclusive; if that ever regresses, the card is a
    // coordinator of its own mission rather than a child of someone else's.
    const other = 'm_other';
    const boards = [{ callsign: 'primeng', uid: 's_1', projectContext: { missionId: other } }];
    const weird = { callsign: 'x', uid: 's_2', parentProject: 'primeng', projectContext: { missionId: MID } };
    assert.equal(missionIdOfCard(weird, boards), MID);
});
