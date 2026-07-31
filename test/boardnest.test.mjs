// Unit tests for groupBoards in console.js -- nesting sub-worker cards under their coordinator so the
// board reads the way the mission rail already does.
//
// THE DEFECT, in Chris's words: "cards bouncing". renderBoards rendered d.boards FLAT, so every
// sub-worker spawn or retire added or removed a TOP-LEVEL card and everything below it jumped. The
// nastier half was the priority sort: prio() floats a needs-you/pendingPerm card to position 0, so a
// sub-worker raising a permission prompt catapulted itself from wherever it sat to the head of the
// column, shoved every card down, then dropped back when the prompt resolved -- on the panel he watches
// live while working.
//
// console.js is browser script, so the pure function is lifted out of the source by name -- same
// approach as test/nesting.test.mjs, and it fails loudly if it is renamed.
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
const groupBoards = new Function(lift('groupBoards') + '\nreturn groupBoards;')();

// The real prio from renderBoards: perm beats needs-you beats nothing.
const prio = b => b.pendingPerm ? 2 : b.needsYou ? 1 : 0;

// A realistic /board: the jarvis project card with two sub-workers, an unrelated project card, and a
// standalone worker belonging to nobody. Deliberately NOT in nested order -- /board does not promise it.
const JARVIS = { callsign: 'jarvis', uid: 's_1', projectContext: { name: 'jarvis', missionId: null } };
const UNIFORM = { callsign: 'uniform', uid: 's_2', parentProject: 'jarvis' };
const WHISKEY = { callsign: 'whiskey', uid: 's_3', parentProject: 'JARVIS' };            // casing as typed
const PRIMENG = { callsign: 'primeng', uid: 's_4', projectContext: { missionId: 'm_1' } };
const LONER = { callsign: 'delta', uid: 's_5' };
const BOARDS = [UNIFORM, JARVIS, LONER, PRIMENG, WHISKEY];

const tops = gs => gs.map(g => g.card.callsign);
const flat = gs => gs.flatMap(g => [g.card.callsign, ...g.subs.map(s => s.callsign)]);

test('groupBoards -- sub-workers nest under their coordinator, whatever the board order', () => {
    const gs = groupBoards(BOARDS, prio);
    assert.deepEqual(tops(gs), ['jarvis', 'delta', 'primeng'], 'top level is coordinators + unparented');
    const j = gs.find(g => g.card === JARVIS);
    assert.deepEqual(j.subs.map(s => s.callsign), ['uniform', 'whiskey'], 'parentProject casing must not matter');
});

test('groupBoards -- a coordinator always renders ABOVE the cards that hang off it', () => {
    // An indented card sitting above its parent reads as broken, and /board order does not guarantee it
    // (UNIFORM is first in BOARDS).
    const order = flat(groupBoards(BOARDS, prio));
    assert.ok(order.indexOf('jarvis') < order.indexOf('uniform'));
    assert.ok(order.indexOf('jarvis') < order.indexOf('whiskey'));
});

test('THE INVARIANT: every card renders exactly once', () => {
    const order = flat(groupBoards(BOARDS, prio));
    assert.equal(order.length, BOARDS.length);
    assert.equal(new Set(order).size, BOARDS.length, 'no card duplicated, none dropped');
});

test('THE FIX: a sub-worker spawning or retiring does not move the top level', () => {
    // This is the bounce. Same board, once with a third sub-worker and once without: the top-level
    // sequence has to be byte-identical, because that is the column Chris is reading.
    const before = tops(groupBoards(BOARDS, prio));
    const SIERRA = { callsign: 'sierra', uid: 's_6', parentProject: 'jarvis' };
    const after = tops(groupBoards(BOARDS.concat([SIERRA]), prio));
    assert.deepEqual(after, before);
    // Under the old flat render, sierra WAS a top-level card -- prove the fixture would have caught it.
    const flatTop = BOARDS.concat([SIERRA]).slice().sort((a, b) => prio(b) - prio(a)).map(b => b.callsign);
    assert.ok(flatTop.includes('sierra'), 'fixture check: the flat render put sierra at the top level');
});

test('THE FIX: a sub-worker needing Chris pulls its GROUP up instead of leaving it', () => {
    // Both halves matter. It must not be missed (the group floats), and it must not jump out of its
    // parent's neighbourhood to do it (the pairing survives).
    const asking = { ...UNIFORM, pendingPerm: { id: 'p1', tool: 'Bash' } };
    // jarvis is deliberately LAST in board order, so a group priority that ignored its children would
    // leave delta on top and this assertion would prove nothing.
    const boards = [LONER, asking, PRIMENG, WHISKEY, JARVIS];
    const gs = groupBoards(boards, prio);
    assert.equal(gs[0].card.callsign, 'jarvis', 'the group carrying the prompt sorts first');
    assert.deepEqual(gs[0].subs.map(s => s.callsign), ['uniform', 'whiskey'], 'and the sub stays inside it');
    assert.equal(flat(gs)[0], 'jarvis', 'the coordinator, not the sub, is still the first card rendered');
});

test('groupBoards -- within a group, the sub-worker wanting attention floats to the top', () => {
    const asking = { ...WHISKEY, needsYou: true };
    const gs = groupBoards([JARVIS, UNIFORM, asking], prio);
    assert.deepEqual(gs[0].subs.map(s => s.callsign), ['whiskey', 'uniform']);
});

test('groupBoards -- equal priority keeps /board order (the sort must stay stable)', () => {
    assert.deepEqual(tops(groupBoards([LONER, PRIMENG, JARVIS], prio)), ['delta', 'primeng', 'jarvis']);
    assert.deepEqual(tops(groupBoards([JARVIS, PRIMENG, LONER], prio)), ['jarvis', 'primeng', 'delta']);
});

test('groupBoards -- a sub-worker whose parent card is gone stays top-level, never vanishes', () => {
    // Routine: the coordinator retires and Chris closes its card while the sub-worker is still live.
    // Dropping it off the board entirely would be strictly worse than an unindented card.
    const gs = groupBoards([UNIFORM, LONER], prio);
    assert.deepEqual(tops(gs), ['uniform', 'delta']);
    assert.deepEqual(flat(gs).length, 2);
});

test('groupBoards -- only ONE level deep; a parent that is itself nested does not nest its child', () => {
    // parentProject names a PROJECT, and project cards carry no parentProject, so a chain means the data
    // is wrong. Flattening the far end is the safe reading -- and it must not build a cycle either.
    //
    // The grandchild is FIRST in board order on purpose. It is recognised as top-level up front, so it
    // keeps its position; the drop-guard further down would also render it, but only by appending it to
    // the BOTTOM of the column. Same card either way -- different place, which is the whole subject here.
    const GRAND = { callsign: 'tango', uid: 's_7', parentProject: 'uniform' };
    const gs = groupBoards([GRAND, JARVIS, UNIFORM, LONER], prio);
    assert.deepEqual(tops(gs), ['tango', 'jarvis', 'delta'], 'flattened where it stood, not shunted last');
    assert.deepEqual(gs[1].subs.map(s => s.callsign), ['uniform']);
    assert.equal(flat(gs).length, 4);
});

test('groupBoards -- a card parented to itself stays top-level rather than looping', () => {
    const self = { callsign: 'echo', uid: 's_8', parentProject: 'echo' };
    const gs = groupBoards([self, LONER], prio);
    assert.deepEqual(tops(gs), ['echo', 'delta']);
    assert.equal(gs[0].subs.length, 0);
});

test('groupBoards -- a duplicate callsign cannot make a card nest under its own namesake', () => {
    // The callsign index keeps the FIRST card under each name, so without the self-name guard the second
    // 'echo' would hang off the first one -- two unrelated sessions rendered as a hierarchy.
    const first = { callsign: 'echo', uid: 's_11' };
    const second = { callsign: 'echo', uid: 's_12', parentProject: 'echo' };
    const gs = groupBoards([first, second], prio);
    assert.deepEqual(tops(gs), ['echo', 'echo'], 'both stay top-level; neither swallows the other');
    assert.equal(flat(gs).length, 2);
});

test('groupBoards -- a two-card cycle cannot hide either card', () => {
    const a = { callsign: 'foxtrot', uid: 's_9', parentProject: 'golf' };
    const b = { callsign: 'golf', uid: 's_10', parentProject: 'foxtrot' };
    const order = flat(groupBoards([a, b], prio));
    assert.equal(order.length, 2);
    assert.equal(new Set(order).size, 2);
});

test('groupBoards -- garbage in, groups out, never a throw (it runs inside a render loop)', () => {
    assert.deepEqual(groupBoards(null, prio), []);
    assert.deepEqual(groupBoards(undefined, prio), []);
    assert.deepEqual(groupBoards([], prio), []);
    assert.deepEqual(tops(groupBoards([null, undefined, LONER], prio)), ['delta'],
        'a malformed row must not stop the grouping');
    assert.deepEqual(tops(groupBoards([{ callsign: null }, { parentProject: 'jarvis' }], prio)).length, 2);
    // No prio at all: still groups, order untouched.
    assert.deepEqual(tops(groupBoards(BOARDS)), ['jarvis', 'delta', 'primeng']);
});

test('the board render actually uses the grouping, and marks nested cards', () => {
    // groupBoards is only worth anything if renderBoards calls it. The old flat expression is gone and
    // the sub flag has to reach both the card class and the title glyph, or the nesting is invisible.
    assert.doesNotMatch(src, /d\.boards\.slice\(\)\.sort/, 'the flat board render is still there');
    assert.match(src, /groupBoards\(d\.boards, prio\)/);
    assert.match(src, /cardHtml\(g\.card, false\)/);
    assert.match(src, /g\.subs\.map\(s => cardHtml\(s, true\)\)/);
    assert.match(src, /sub \? ' csub' : ''/, 'a nested card must carry the csub class');
    assert.match(src, /csubarrow/, 'a nested card must carry the rail arrow glyph');
});
