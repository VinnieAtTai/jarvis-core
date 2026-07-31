// The three board writers boardKey() never reached, driven through the REAL routes.
//
// WHY THIS FILE EXISTS AT ALL, and it is the more useful half of the fix. test/boardkey.test.mjs
// already covers boardKeyFor exhaustively -- eleven tests, every degenerate input -- and the card for
// that work sat in REVIEW as a FALSE GREEN for days. A pure helper cannot tell you whether its
// callers call it. Six writers reach ensureBoard with a callsign; three were keyed and three were
// raw, and the raw ones included POST /worklist op:move, three lines under the comment explaining
// that exact bug at the other end of the same route. So these assertions go through /worklist and
// /hear, and the thing asserted is that the CARD LANDS ON THE KEYED BOARD -- the only claim Chris
// can see from the console.
//
// The defect, in his terms: a bound coordinator's NATO callsign mints a SECOND board, so work
// disappears from the column he is looking at. It has happened before (primeng + juliet, 2026-07-27)
// and it is silent -- both cards render, both look healthy, and neither says the other exists.
//
// SKIPPED by default: it boots a real hub. Run it deliberately:
//
//     npm run test:boardwriters
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub } from '../test-support/scratch-hub.mjs';
import { textOf } from '../jarvis-text.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub; ~20 seconds)';

const PROJECT = 'probe';    // the board key a bound coordinator's work belongs on
const BOUND = 'juliet';     // the coordinator's NATO callsign -- the name that used to mint board #2
const PLAIN = 'kilo';       // an unbound worker, so the source board is never the destination

const board = (w, key) => (w.sessions || {})[key] || null;
const holds = (w, key, needle) => {
    const b = board(w, key);
    if (!b) return false;
    return ['queued', 'working', 'review', 'done'].some(l => (b[l] || []).some(t => textOf(t).toLowerCase().includes(needle.toLowerCase())));
};
// The transcript half. `record({kind:'task', board})` is not just a log line: db.mjs keys
// taskTimesFromTranscript as (board, text), so a raw callsign here does not misplace a timestamp, it
// LOSES it -- the same failure credit-the-owner fixed for start/done. record() appends synchronously,
// so by the time the route has answered the line is already on disk.
const taskLine = (hub, op, needle) => hub.transcript().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .find(e => e && e.kind === 'task' && e.op === op && String(e.task || '').toLowerCase().includes(needle.toLowerCase())) || null;

test('BOARD WRITERS: op:move and both voice task paths land work on the KEYED board, not a second one',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('board-writers hub');

        // A bound coordinator, registered through the real route so the roster shape under test is the
        // one the hub builds for itself. registerSession already does ensureBoard(w, proj || cs) -- the
        // one writer that was always right -- so the project column exists and the NATO one does not.
        const co = await hub.post('/register', { cwd: hub.REPO, purpose: 'probe coordinator', project: PROJECT, pin: BOUND });
        assert.equal(co.callsign, BOUND, 'the pin was not honoured, so nothing below is testing a bound callsign: ' + JSON.stringify(co));
        const src = await hub.post('/register', { cwd: hub.REPO, purpose: 'unbound source of cards', pin: PLAIN });
        assert.equal(src.callsign, PLAIN, 'pin not honoured: ' + JSON.stringify(src));

        // The instrument check. If the project board is absent, every "landed on PROJECT" assertion
        // below could pass by creating it, and every "no NATO board" assertion is vacuous.
        const w0 = await hub.get('/worklist');
        assert.ok(board(w0, PROJECT), 'register did not create the ' + PROJECT + ' column, so this rig cannot tell a keyed write from an unkeyed one');
        assert.equal(board(w0, BOUND), null, 'a ' + BOUND + ' board already exists before any write, so the regression assertions below prove nothing');

        // Focus on the UNBOUND worker for the rest of the test. Two reasons, both load-bearing:
        // findTaskAll prefers the focused board (that is where the cards are), and the voice add path
        // speaks "Added." vs "Added to X." by comparing against focus -- with focus elsewhere, the
        // spoken line is deterministic and can be asserted.
        const f = await hub.post('/focus', { callsign: PLAIN });
        assert.equal(f.focus, PLAIN, 'focus did not move: ' + JSON.stringify(f));

        // ---- WRITER 1: POST /worklist op:move -- the DESTINATION ---------------------------------
        // Pre-fix: ensureBoard(w, String(b.to).toLowerCase()). The poster was keyed at the top of the
        // route and the destination three lines further down was not.
        await hub.post('/worklist', { op: 'add', callsign: PLAIN, text: 'HTTP-MOVE card bound for the project column' });
        const mv = await hub.post('/worklist', { op: 'move', callsign: PLAIN, text: 'HTTP-MOVE card', to: BOUND });
        assert.equal(mv.ok, true, 'op:move was rejected: ' + JSON.stringify(mv));

        const w1 = await hub.get('/worklist');
        assert.equal(board(w1, BOUND), null,
            'REGRESSION: op:move to a bound coordinator minted a ' + BOUND + ' board -- work Chris cannot see on the ' + PROJECT + ' column he is watching');
        assert.ok(holds(w1, PROJECT, 'HTTP-MOVE card'), 'the moved card is not on the ' + PROJECT + ' column');
        assert.ok(!holds(w1, PLAIN, 'HTTP-MOVE card'), 'the card is still on the source board too, so the move only copied it');
        // The store-facing half: `owner` feeds both this line and the upsertTask row below it.
        const mvLine = taskLine(hub, 'move', 'HTTP-MOVE card');
        assert.ok(mvLine, 'op:move recorded no task line at all');
        assert.equal(mvLine.board, PROJECT, 'the transcript credits the raw callsign, so db.mjs keys the row on a board the task does not live on');
        assert.equal(mvLine.from, PLAIN, 'the move record lost the source board');

        // ---- WRITER 2: the voice move path ------------------------------------------------------
        // "move the X task to juliet". csFrom() answers a SESSION -- it must, only a live callsign is a
        // legal destination -- which is exactly why the answer needs keying before it reaches a board.
        await hub.post('/worklist', { op: 'add', callsign: PLAIN, text: 'VOICE-MOVE card bound for the project column' });
        await hub.post('/hear', { text: 'move the voice-move card task to ' + BOUND, typed: true });

        const w2 = await hub.get('/worklist');
        assert.equal(board(w2, BOUND), null,
            'REGRESSION: the voice move path minted a ' + BOUND + ' board');
        assert.ok(holds(w2, PROJECT, 'VOICE-MOVE card'), 'the spoken move did not land the card on the ' + PROJECT + ' column');
        assert.equal((taskLine(hub, 'move', 'VOICE-MOVE card') || {}).board, PROJECT, 'the voice move credited the raw callsign in the transcript');
        // And the human is told the truth. "Moved to juliet" while the card sat on the probe column
        // would be the same false green in spoken form -- the board is the thing he is looking at.
        await hub.waitFor('the hub to say it moved the card to ' + PROJECT,
            () => hub.spoke(new RegExp('Moved to ' + PROJECT, 'i')), 15000, 250);

        // ---- WRITER 3: the voice add path -------------------------------------------------------
        // "add task, X for juliet". Note the card text is lowercased: the intent ladder matches against
        // the canon'd lowercase line, so that is what reaches makeTask.
        await hub.post('/hear', { text: 'add task, voice-add card bound for the project column for ' + BOUND, typed: true });

        const w3 = await hub.get('/worklist');
        assert.equal(board(w3, BOUND), null,
            'REGRESSION: the voice add path minted a ' + BOUND + ' board');
        assert.ok(holds(w3, PROJECT, 'voice-add card'), 'the spoken add did not land the card on the ' + PROJECT + ' column');
        assert.equal((taskLine(hub, 'add', 'voice-add card') || {}).board, PROJECT, 'the voice add credited the raw callsign in the transcript');
        await hub.waitFor('the hub to say it added to ' + PROJECT,
            () => hub.spoke(new RegExp('Added to ' + PROJECT, 'i')), 15000, 250);

        // ---- the paths that must NOT be remapped -------------------------------------------------
        // boardKey is not a blanket lowercasing of every destination. An UNBOUND callsign is its own
        // board, and a sub-worker's card nests under a project rather than collapsing onto it (that
        // nesting is the whole point of parentProject). If the fix had keyed on any binding at all
        // instead of `project`, both of these would silently vanish into the project column.
        const sub = await hub.post('/register', { cwd: hub.REPO, purpose: 'probe sub-worker', parentProject: PROJECT, pin: 'xray' });
        assert.equal(sub.callsign, 'xray', 'pin not honoured: ' + JSON.stringify(sub));
        await hub.post('/worklist', { op: 'add', callsign: PLAIN, text: 'SUBWORKER card that must keep its own card' });
        await hub.post('/worklist', { op: 'move', callsign: PLAIN, text: 'SUBWORKER card', to: 'xray' });
        const w4 = await hub.get('/worklist');
        assert.ok(holds(w4, 'xray', 'SUBWORKER card'),
            'a sub-worker card was folded into the ' + PROJECT + ' column -- parentProject must NOT bind a board');
        assert.ok(!holds(w4, PROJECT, 'SUBWORKER card'), 'the sub-worker card landed on the project column instead of its own');
    });
