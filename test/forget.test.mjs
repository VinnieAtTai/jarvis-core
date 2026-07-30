// POST /forget deleted a whole board unconditionally, and the console reached it from a bare X.
//
// The handler retired the session with NO opts -- so shouldSpawnSuccessor never ran -- and then did a
// flat `delete w.sessions[cs]` with no look at what was in it, then saved. No undo. Measured on the
// live board the day this was written: primeng held 500 cards and jarvis 231. The card describing the
// hazard said 469, so the exposure had GROWN by 31 while the card sat in the queue.
//
// THE ORDERING IS THE SUBTLE PART and it is what most of this file is about. The retire happens
// BEFORE the delete, so a guard bolted on after it would kill the session and only then refuse --
// strictly worse than the bug. The test that matters is not "does it return 409", it is "is the
// session still alive after the 409".
//
// done/review are deliberately not counted as work in flight: they are a record of finished work and
// survive in the transcript, and a guard that fires on boards nobody minds clearing is a guard people
// learn to force past. Pinned below so the scope cannot drift either way.
//
//     npm run test:forget
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub on its own port)';

const lanes = (board) => ['working', 'queued', 'review', 'done']
    .reduce((n, l) => n + ((board && board[l]) || []).length, 0);
const boardFor = async (hub, cs) => ((await hub.get('/board')).boards || []).find(b => b.callsign === cs);

test('FORGET: a board with work in flight cannot be deleted by accident',
    { skip: SKIP, timeout: 120000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('forget hub');

        const s = await hub.post('/register', { cwd: hub.REPO, purpose: 'a session with real work on its board' });
        assert.ok(s && s.uid, 'register failed: ' + JSON.stringify(s));
        const CS = String(s.callsign);
        for (const text of ['WORK: first thing', 'WORK: second thing', 'WORK: third thing']) {
            await hub.post('/worklist', { op: 'add', callsign: CS, text });
        }
        await hub.post('/worklist', { op: 'start', callsign: CS, text: 'first thing' });
        assert.equal(lanes(await boardFor(hub, CS)), 3, 'fixture must have three cards or the rest proves nothing');

        // ---- the refusal ------------------------------------------------------------------------
        const refused = await hub.post('/forget', { callsign: CS });
        assert.equal(refused.error, 'board has work in flight', 'forget must refuse: ' + JSON.stringify(refused));
        assert.equal(refused.working, 1, 'and say how much is working');
        assert.equal(refused.queued, 2, 'and how much is queued');
        assert.equal(refused.total, 3, 'and the total it would have destroyed');
        assert.match(String(refused.hint || ''), /successor:true/, 'and name the safe way out');

        // THE ONE THAT MATTERS, and it is checked FIRST on purpose. A guard placed after the retire
        // still returns a perfectly good 409 -- every assertion above it passes -- while having
        // already killed the session. That mutant reads like a fix in review, so the liveness check
        // has to be the thing that speaks when it happens.
        //
        // Measured, not assumed: moving the guard below the retire also takes the BOARD away, because
        // retiring a session with unfinished work hands the board to a successor. So the damage is
        // wider than "the session dies" -- but the roster is the most diagnostic place to say so,
        // which is why it is asserted before the board.
        const roster = await hub.get('/roster');
        assert.ok((roster.live || []).some(r => (r.callsign || r.cs) === CS),
            'THE SESSION WAS RETIRED DESPITE THE REFUSAL -- the guard has been moved below the retire '
            + 'in the handler. It must run before it, or a refused /forget is worse than an allowed one.');
        const after = await boardFor(hub, CS);
        assert.ok(after, 'the board must still exist after a refusal');
        assert.equal(lanes(after), 3, 'with every card still on it');
        assert.notEqual(after.alive, false, 'and the session must still read alive on its card');
    });

test('FORGET: force is the deliberate way through, and it says what it cost',
    { skip: SKIP, timeout: 120000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('forget force hub');

        const s = await hub.post('/register', { cwd: hub.REPO, purpose: 'a session about to be force-forgotten' });
        const CS = String(s.callsign);
        await hub.post('/worklist', { op: 'add', callsign: CS, text: 'WORK: doomed card' });
        await hub.post('/worklist', { op: 'add', callsign: CS, text: 'WORK: also doomed' });

        const forced = await hub.post('/forget', { callsign: CS, force: true });
        assert.equal(forced.ok, true, 'force must still work: ' + JSON.stringify(forced));
        assert.equal(forced.destroyed, 2, 'and report how many cards in flight it destroyed');
        assert.equal(await boardFor(hub, CS), undefined, 'the board is gone');

        // The sys line has to name the cost. "removed X from board" read identically whether the board
        // was empty or held five hundred cards, which is what made this invisible after the fact.
        const found = await hub.get('/search?q=FORCED&kinds=sys');
        const hits = found.results || found.hits || [];
        assert.ok(hits.some(h => String(h.text || '').includes(CS) && /destroyed 2 card/.test(String(h.text || ''))),
            'the forced delete must leave a searchable sys line naming the count: ' + JSON.stringify(hits.slice(0, 3)));
    });

test('FORGET: the guard does not cry wolf on boards nobody minds clearing',
    { skip: SKIP, timeout: 120000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('forget empty hub');

        // An EMPTY board still closes in one call -- that is the case the button was built for.
        const empty = await hub.post('/register', { cwd: hub.REPO, purpose: 'a session with nothing on its board' });
        const EMPTY_CS = String(empty.callsign);
        const goneEmpty = await hub.post('/forget', { callsign: EMPTY_CS });
        assert.equal(goneEmpty.ok, true, 'an empty board must still close without ceremony: ' + JSON.stringify(goneEmpty));
        assert.equal(goneEmpty.destroyed, 0, 'and report nothing destroyed');

        // A board holding only FINISHED work closes too. done/review live in the transcript; treating
        // them as work in flight would fire the guard on every tidy-up and teach people to force past it.
        const fin = await hub.post('/register', { cwd: hub.REPO, purpose: 'a session that finished everything' });
        const FIN_CS = String(fin.callsign);
        await hub.post('/worklist', { op: 'add', callsign: FIN_CS, text: 'WORK: long done' });
        await hub.post('/worklist', { op: 'start', callsign: FIN_CS, text: 'long done' });
        await hub.post('/worklist', { op: 'done', callsign: FIN_CS, text: 'long done' });
        await hub.post('/worklist', { op: 'add', callsign: FIN_CS, text: 'WORK: awaiting an eyeball' });
        await hub.post('/worklist', { op: 'review', callsign: FIN_CS, text: 'awaiting an eyeball' });
        const b = await boardFor(hub, FIN_CS);
        assert.equal(lanes(b), 2, 'fixture must hold two finished cards');
        assert.equal((b.working || []).length + (b.queued || []).length, 0, 'and nothing in flight');

        const goneFin = await hub.post('/forget', { callsign: FIN_CS });
        assert.equal(goneFin.ok, true, 'a board of finished work must still close: ' + JSON.stringify(goneFin));
    });

test('FORGET: the console X no longer reaches the endpoint unguarded', { skip: false }, async () => {
    // The wiring half. The endpoint guard is the real fix, but the button is what Chris actually
    // touches, and a bare post('/forget') here would put a one-click board delete back on his screen.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../console.js', import.meta.url), 'utf8');
    const i = src.indexOf("act === 'close'");
    assert.notEqual(i, -1, 'console.js no longer has a close action -- update this test');
    const body = src.slice(i, i + 1800);

    // Structural, not a keyword sweep. An earlier version of this checked that `close` was not
    // immediately followed by post('/forget'), which a bare call reinserted one line INSIDE the block
    // would have walked straight past. Count them instead: there are exactly two legitimate ones --
    // the empty-board fast path, which must be guarded by !flight, and the forced delete behind the
    // confirm. A third one is someone adding an unguarded path back.
    const forgets = (body.match(/post\('\/forget'/g) || []).length;
    assert.equal(forgets, 2, 'expected exactly two /forget calls in the close handler, found ' + forgets
        + ' -- a new one is an unguarded path back to the one-click delete');
    assert.match(body, /if \(!flight\) \{ post\('\/forget'/,
        'the only unconditional /forget must be the empty-board fast path, guarded by !flight');
    assert.match(body, /uiConfirm\(/, 'a close that can destroy cards must ask first');
    assert.match(body, /successor: true/, 'a LIVE session with work must be offered a hand-off, not a delete');
    assert.match(body, /force: true/, 'and a deliberate delete must say so explicitly to the endpoint');
    assert.match(body, /danger: true/, 'the destructive branch must use the danger styling, like Rebuild does');
});
