// Unit tests for the pure retire/handoff helpers in jarvis-text.mjs (cwdKey,
// shouldSpawnSuccessor, boardHasWork, transferBoard). Run with `npm test` (node --test).
// No server boot, no I/O, no worker spawn — these import the real functions the hub uses, so the
// successor decision and board-transfer accounting are exercised exactly as retireSession sees them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cwdKey, shouldSpawnSuccessor, boardHasWork, transferBoard } from '../jarvis-text.mjs';

// A v3 task object, shaped like the ones on the board.
const task = (id, text) => ({ id, text, addedAt: 'STAMP' });

test('cwdKey — case/separator/trailing-slash insensitive', () => {
    assert.equal(cwdKey('D:\\claude\\jarvis-core'), 'd:/claude/jarvis-core');
    assert.equal(cwdKey('D:/Claude/Jarvis-Core/'), 'd:/claude/jarvis-core');
    assert.equal(cwdKey('d:/claude/jarvis-core///'), 'd:/claude/jarvis-core');
    // mixed separators and a trailing backslash normalize to the same key
    assert.equal(cwdKey('D:\\claude\\jarvis-core\\'), cwdKey('d:/claude/jarvis-core'));
});

test('cwdKey — nullish/empty', () => {
    assert.equal(cwdKey(null), '');
    assert.equal(cwdKey(undefined), '');
    assert.equal(cwdKey(''), '');
});

test('shouldSpawnSuccessor — explicit true always spawns (even with no work)', () => {
    assert.equal(shouldSpawnSuccessor(true, false), true);
    assert.equal(shouldSpawnSuccessor(true, true), true);
});

test('shouldSpawnSuccessor — explicit false never spawns (even with work)', () => {
    assert.equal(shouldSpawnSuccessor(false, true), false);
    assert.equal(shouldSpawnSuccessor(false, false), false);
});

test('shouldSpawnSuccessor — omitted: auto-spawn iff work remains', () => {
    assert.equal(shouldSpawnSuccessor(undefined, true), true);
    assert.equal(shouldSpawnSuccessor(undefined, false), false);
    // any non-boolean (e.g. a truthy/falsy non-true value) behaves like "omitted": work decides
    assert.equal(shouldSpawnSuccessor(null, true), true);
    assert.equal(shouldSpawnSuccessor(null, false), false);
    assert.equal(shouldSpawnSuccessor(1, false), false, 'a truthy non-true value is NOT an explicit yes');
});

test('boardHasWork — working or queued counts; review/done do not', () => {
    assert.equal(boardHasWork({ working: [task('w1', 'a')], queued: [] }), true);
    assert.equal(boardHasWork({ working: [], queued: [task('q1', 'b')] }), true);
    assert.equal(boardHasWork({ working: [], queued: [] }), false);
    // review/done alone is NOT unfinished work
    assert.equal(boardHasWork({ working: [], queued: [], review: [task('r1', 'c')], done: [task('d1', 'e')] }), false);
});

test('boardHasWork — missing/odd lanes are treated as empty', () => {
    assert.equal(boardHasWork({}), false);
    assert.equal(boardHasWork(null), false);
    assert.equal(boardHasWork(undefined), false);
    assert.equal(boardHasWork({ working: 'nope', queued: 'nope' }), false);
});

test('transferBoard — working+queued land at the FRONT of a fresh successor queue', () => {
    const from = {
        working: [task('w1', 'in progress')],
        queued: [task('q1', 'next'), task('q2', 'later')],
        review: [task('r1', 'review me')],
        done: [task('d1', 'done')],
    };
    const fresh = { working: [], queued: [], review: [], done: [] };
    const { board, moved, total, dropped } = transferBoard(from, fresh);
    // unfinished = working ++ queued, in that order, at the front of queue
    assert.deepEqual(board.queued.map(t => t.id), ['w1', 'q1', 'q2']);
    assert.deepEqual(board.review.map(t => t.id), ['r1']);
    assert.deepEqual(board.done.map(t => t.id), ['d1']);
    assert.deepEqual(board.working, [], 'successor starts with nothing in progress');
    // total counts predecessor tasks (unfinished+review+done = 3+1+1 = 5); a fresh successor
    // means moved == total and nothing dropped
    assert.equal(total, 5);
    assert.equal(moved, 5);
    assert.equal(dropped, false);
});

test('transferBoard — preserves a successor queue, prepending the inherited work', () => {
    const from = { working: [task('w1', 'a')], queued: [task('q1', 'b')], review: [], done: [] };
    const existing = { working: [], queued: [task('pre', 'already here')], review: [], done: [] };
    const { board, moved, total, dropped } = transferBoard(from, existing);
    // inherited work goes to the front, the successor's own queued item stays behind it
    assert.deepEqual(board.queued.map(t => t.id), ['w1', 'q1', 'pre']);
    assert.equal(total, 2, 'total counts only the predecessor tasks');
    assert.equal(moved, 3, 'moved counts the whole resulting board (incl. the pre-existing item)');
    // moved >= total -> nothing reported dropped
    assert.equal(dropped, false);
});

test('transferBoard — review and done carry over at the front of their lanes', () => {
    const from = { working: [], queued: [], review: [task('r1', 'a')], done: [task('d1', 'x'), task('d2', 'y')] };
    const existing = { working: [], queued: [], review: [task('er', 'old review')], done: [task('ed', 'old done')] };
    const { board } = transferBoard(from, existing);
    assert.deepEqual(board.review.map(t => t.id), ['r1', 'er']);
    assert.deepEqual(board.done.map(t => t.id), ['d1', 'd2', 'ed']);
});

test('transferBoard — empty predecessor board moves nothing', () => {
    const { board, moved, total, dropped } = transferBoard(
        { working: [], queued: [], review: [], done: [] },
        { working: [], queued: [], review: [], done: [] },
    );
    assert.deepEqual(board, { working: [], queued: [], review: [], done: [] });
    assert.equal(total, 0);
    assert.equal(moved, 0);
    assert.equal(dropped, false);
});

test('transferBoard — missing lanes default to empty (no crash, no phantom tasks)', () => {
    // predecessor with only working; successor totally empty object
    const { board, moved, total } = transferBoard({ working: [task('w1', 'a')] }, {});
    assert.deepEqual(board.queued.map(t => t.id), ['w1']);
    assert.deepEqual(board.working, []);
    assert.deepEqual(board.review, []);
    assert.deepEqual(board.done, []);
    assert.equal(total, 1);
    assert.equal(moved, 1);
});

test('transferBoard — nullish inputs yield an empty board', () => {
    const { board, moved, total, dropped } = transferBoard(null, null);
    assert.deepEqual(board, { working: [], queued: [], review: [], done: [] });
    assert.equal(total, 0);
    assert.equal(moved, 0);
    assert.equal(dropped, false);
});

test('transferBoard — does not mutate the predecessor board', () => {
    const from = { working: [task('w1', 'a')], queued: [task('q1', 'b')], review: [], done: [] };
    const snapshot = JSON.parse(JSON.stringify(from));
    transferBoard(from, { working: [], queued: [], review: [], done: [] });
    assert.deepEqual(from, snapshot, 'source board is left untouched');
});
