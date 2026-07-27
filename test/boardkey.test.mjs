// Unit tests for boardKeyFor in jarvis-text.mjs -- turning a callsign into the BOARD its work
// belongs on.
//
// The bug, found by Chris on screen 2026-07-27: the primeng project card and a juliet card were
// showing as two separate trackers for ONE session, each rendering the same pending permission
// prompt, with the coordinator's 154-card backlog on one and two stray cards on the other. Cause:
// POST /worklist (and both focus paths) called ensureBoard on whatever callsign they were handed, so
// a bound coordinator posting as ITSELF minted a second board. registerSession had always done it
// right -- ensureBoard(w, proj || cs) -- which is what makes the other three sites provably wrong
// rather than a matter of taste. Same class as the phantom-card focus bug (3696440): a raw NATO
// callsign used where a board key was needed.
// Run with `npm test` (node --test) -- no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardKeyFor, nextFocusKey } from '../jarvis-text.mjs';

// The live roster shape at the time of the bug: juliet coordinates the primeng project, xray is a
// jarvis SUB-worker (parentProject, not project), delta coordinates jarvis, and lima is a retired
// former primeng coordinator whose uid still sits in front of nobody.
const SESSIONS = {
    s_0345: { callsign: 'juliet', project: 'primeng', ended: null },
    s_0346: { callsign: 'xray', parentProject: 'jarvis', ended: null },
    s_0344: { callsign: 'delta', project: 'jarvis', ended: null },
    s_0300: { callsign: 'lima', project: 'primeng', ended: '2026-07-24T18:00:00.000Z' },
    s_0200: { callsign: 'bravo', ended: null },
};
const CALLSIGNS = {
    juliet: ['s_0345'],
    xray: ['s_0346'],
    delta: ['s_0344'],
    lima: ['s_0300'],
    bravo: ['s_0200'],
};
const key = cs => boardKeyFor(cs, SESSIONS, CALLSIGNS);

test('boardKeyFor -- THE BUG: a bound coordinator maps to its PROJECT, not its own callsign', () => {
    // This single assertion is the whole fix. Pre-fix, /worklist ensureBoard'd 'juliet' and Chris
    // got a second tracker for a session that already had the primeng card.
    assert.equal(key('juliet'), 'primeng');
    assert.equal(key('delta'), 'jarvis');
});

test('boardKeyFor -- a SUB-worker keeps its own board (that is the card it nests under a project)', () => {
    // parentProject must NOT collapse onto the parent: xray owning its own card is the whole point of
    // the nesting work in 6f08bb2. Only `project` binds.
    assert.equal(key('xray'), 'xray');
});

test('boardKeyFor -- an unbound worker maps to itself', () => {
    assert.equal(key('bravo'), 'bravo');
});

test('boardKeyFor -- a RETIRED coordinator does not bind, so cleanup can still find its own card', () => {
    // /forget and the focus-repair paths operate on dead cards. If a dead coordinator's callsign
    // resolved to the project, forgetting the corpse would target the LIVE project column instead.
    assert.equal(key('lima'), 'lima');
});

test('boardKeyFor -- the solo brain is always itself, never remapped', () => {
    assert.equal(key('jarvis'), 'jarvis');
    // Even if some session somehow claims to be the jarvis project, the brain's own key is reserved.
    assert.equal(boardKeyFor('jarvis', { s_1: { callsign: 'jarvis', project: 'other' } }, { jarvis: ['s_1'] }), 'jarvis');
});

test('boardKeyFor -- a project key passed in resolves to itself (idempotent)', () => {
    // The console posts focus with callsign=<project>. Feeding a board key back in must be a no-op,
    // so callers can apply it without first knowing which kind of name they hold.
    assert.equal(key('primeng'), 'primeng');
    assert.equal(key(key('juliet')), 'primeng');
});

test('boardKeyFor -- normalizes case and surrounding space like every other callsign path', () => {
    assert.equal(key(' JULIET '), 'primeng');
    assert.equal(key('Juliet'), 'primeng');
});

test('boardKeyFor -- newest uid wins when a callsign has been recycled', () => {
    // roster.callsigns[cs] is newest-first. A reborn callsign whose PREDECESSOR was bound must follow
    // the live session's binding, not the corpse's.
    const sessions = {
        s_new: { callsign: 'juliet', ended: null },                       // reborn, unbound
        s_old: { callsign: 'juliet', project: 'primeng', ended: '2026-07-01T00:00:00.000Z' },
    };
    assert.equal(boardKeyFor('juliet', sessions, { juliet: ['s_new', 's_old'] }), 'juliet');
});

test('boardKeyFor -- garbage in never throws, and never invents a board', () => {
    // This runs inside /worklist and both focus paths; a throw here would take down board updates.
    for (const bad of [null, undefined, '', 0, false]) assert.equal(boardKeyFor(bad, SESSIONS, CALLSIGNS), '');
    assert.equal(boardKeyFor('juliet', null, null), 'juliet');
    assert.equal(boardKeyFor('juliet', SESSIONS, {}), 'juliet');
    assert.equal(boardKeyFor('juliet', {}, CALLSIGNS), 'juliet');
    // Half-written roster rows must degrade to the callsign, not crash.
    assert.equal(boardKeyFor('juliet', { s_0345: null }, CALLSIGNS), 'juliet');
    assert.equal(boardKeyFor('juliet', SESSIONS, { juliet: [] }), 'juliet');
    assert.equal(boardKeyFor('juliet', SESSIONS, { juliet: 'not-an-array' }), 'juliet');
    assert.equal(boardKeyFor('juliet', { s_0345: { callsign: 'juliet', project: '   ', ended: null } }, CALLSIGNS), 'juliet');
});

test('boardKeyFor -- pure: does not mutate the roster it reads', () => {
    const before = JSON.stringify({ SESSIONS, CALLSIGNS });
    key('juliet'); key('xray'); key('nobody');
    assert.equal(JSON.stringify({ SESSIONS, CALLSIGNS }), before);
});

test('boardKeyFor agrees with nextFocusKey -- both answer in BOARD KEYS', () => {
    // The two helpers must not disagree, or focus repair and focus assignment fight each other: one
    // would send focus to 'primeng' while the other sent it to 'juliet'.
    const live = [{ callsign: 'juliet', project: 'primeng' }, { callsign: 'xray', project: null }];
    assert.equal(nextFocusKey(live), 'primeng');
    assert.equal(key('juliet'), nextFocusKey(live));
    assert.equal(nextFocusKey(live, 'primeng'), 'xray');
    assert.equal(key('xray'), nextFocusKey(live, 'primeng'));
});
