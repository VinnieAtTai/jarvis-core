// The proof that a board op is credited to the board HOLDING the task, not the one that posted it —
// in the transcript, which is a SOURCE and not just a log.
//
// WHY THIS TEST EXISTS. POST /worklist resolves its needle with findTaskAll, which searches every
// board, so the callsign in the request is only the POSTER and the task can live somewhere else
// entirely. The live store write has read the holder off `hit.cs` since b5be7e2; the transcript line
// beside it recorded the poster. That is not a cosmetic disagreement, because db.mjs reads the
// transcript back: taskTimesFromTranscript keys its start/done times as (board, text) and has to
// match task rows keyed on the board the task actually lives on. A poster's callsign produces a key
// that matches NOTHING, so a cross-board start or done did not misplace its timestamp -- the
// reconstruction lost it, silently, and looked complete while doing so.
//
// So the assertion that matters is not "the line says tango". It is that the BACKFILL, reading only
// the files, arrives at the same times the live path recorded. A test that only inspected the
// transcript field would pass on a fix that spelled the callsign differently from the worklist.
//
// SKIPPED by default: spawns a real hub. Run it deliberately:
//
//     npm run test:credit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createScratchHub } from '../test-support/scratch-hub.mjs';
import { init, backfill, listTasks } from '../db.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub; ~2 seconds)';

// The task lines the hub appended, in order. Parsed out of the file rather than an endpoint because
// the file is what db.mjs reads.
function taskLines(hub, needle) {
    return hub.transcript().split(/\r?\n/).map(l => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(e => e && e.kind === 'task' && String(e.task || '').includes(needle));
}
const lineFor = (hub, needle, op) => taskLines(hub, needle).find(e => e.op === op) || null;

test('CREDIT: a cross-board op is recorded against the board holding the task, so the reconstruction agrees with the live path',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const hub = await createScratchHub();
        t.after(() => hub.dispose());
        await hub.start('credit hub');

        const r = await hub.post('/register', { cwd: hub.REPO, purpose: 'credit probe worker', pin: 'tango' });
        assert.ok(r && r.uid, 'register failed: ' + JSON.stringify(r));

        // ---- the control: tango works its own card, which was never in doubt ----------------------
        // Here to show the machinery below is sound. If the backfill produced no times for ANY card,
        // the cross-board assertions would fail for a reason that has nothing to do with crediting.
        await hub.post('/worklist', { op: 'add', callsign: 'tango', text: 'WORK: own card' });
        await hub.post('/worklist', { op: 'start', callsign: 'tango', text: 'own card' });
        await hub.post('/worklist', { op: 'done', callsign: 'tango', text: 'own card' });
        assert.equal(lineFor(hub, 'own card', 'add').board, 'tango', 'an op on the poster-s own board was credited elsewhere');

        // ---- the case that was broken: another board drives tango's card -------------------------
        const added = await hub.post('/worklist', { op: 'add', callsign: 'tango', text: 'FEATURE: cross-board card' });
        const id = added && added.task && added.task.id;
        assert.ok(id, 'add returned no task id: ' + JSON.stringify(added));
        // Posted as 'jarvis'. findTaskAll finds it on tango, so poster and holder disagree.
        await hub.post('/worklist', { op: 'start', callsign: 'jarvis', text: 'cross-board card' });
        await hub.post('/worklist', { op: 'done', callsign: 'jarvis', text: 'cross-board card' });

        const started = lineFor(hub, 'cross-board card', 'start');
        const finished = lineFor(hub, 'cross-board card', 'done');
        assert.ok(started && finished, 'the cross-board ops were not recorded at all: ' + JSON.stringify(taskLines(hub, 'cross-board card')));
        assert.equal(started.board, 'tango', 'the start was credited to the board that POSTED it, not the one holding the task');
        assert.equal(finished.board, 'tango', 'the done was credited to the board that POSTED it, not the one holding the task');

        // ---- THE CONSEQUENCE: the two records now agree -------------------------------------------
        // Reconstruct from the files alone, into a db of its own so the LIVE rows cannot supply the
        // answer. This is what a report over any pre-b5be7e2 database is made of, and before the fix
        // the two lines above keyed to a board that holds no such task, so both times came back null.
        //
        // Honest note on what these assertions are worth. They and the two `started.board`/
        // `finished.board` checks above are ONE fact seen at two distances: the reconstruction matches
        // on (board, text), so any transcript board other than the holder's breaks it, and there is no
        // mutation that moves one without the other. Restoring the bug therefore trips the closer pair
        // first. What proves this block is genuinely consulted is the SAME-board control below: keying
        // the match on a board that holds nothing (a mutation of db.mjs) fires it. So read the pair
        // above as the statement of the fix and this block as the statement of the damage.
        const recon = init(join(hub.root, 'recon.db'));
        let rows;
        try {
            const counts = backfill(recon, hub.DATA);
            assert.ok(counts.tasks >= 2, 'the backfill reconstructed nothing, so this proves nothing: ' + JSON.stringify(counts));
            rows = listTasks(recon);
        } finally { try { recon.close(); } catch { } }

        const own = rows.find(x => x.text.includes('own card'));
        assert.ok(own && own.startedAt && own.doneAt, 'the reconstruction lost the times for a SAME-board card, so the rig is broken, not the credit');

        const cross = rows.find(x => x.id === id);
        assert.ok(cross, 'the cross-board card is missing from the reconstruction entirely: ' + JSON.stringify(rows.map(x => x.text)));
        assert.equal(cross.callsign, 'tango', 'the reconstructed card belongs to the wrong board');
        assert.ok(cross.startedAt, 'the reconstruction LOST the start time of a cross-board card -- the transcript credited a board that does not hold it');
        assert.ok(cross.doneAt, 'the reconstruction LOST the finish time of a cross-board card -- the transcript credited a board that does not hold it');
        assert.equal(cross.lane, 'done', 'the reconstructed card is in the wrong lane');

        // ---- a move names both ends -------------------------------------------------------------
        // Deliberately AFTER the reconstruction above, and worth knowing why. A moved card is the one
        // case the backfill still cannot date: it keys times to the board a task was on when the event
        // happened, while worklist.json only knows where the task is NOW, so the destination board
        // matches neither start nor done line. That is db.mjs's reconstruction being unable to see a
        // move at all, not this fix -- it was equally true when `board` was the poster -- and db.mjs is
        // left untouched here. Recording `from` is what gives a later fix something to work from.
        // `board` is the destination (the row follows the task), which leaves the source board with
        // nowhere to go unless it is recorded too. The voice handler for "give X task to Y" has always
        // written both; this half wrote neither correctly -- its `board` was the poster, which on a
        // move is not even one of the two boards involved.
        await hub.post('/worklist', { op: 'move', callsign: 'jarvis', text: 'cross-board card', to: 'delta' });
        const moved = lineFor(hub, 'cross-board card', 'move');
        assert.ok(moved, 'the move was not recorded');
        assert.equal(moved.board, 'delta', 'the move line does not name the board the task went TO');
        assert.equal(moved.from, 'tango', 'the move line does not name the board the task came FROM');
    });
