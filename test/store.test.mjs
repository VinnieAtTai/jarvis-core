// The proof that the hub WRITES its own history — that db.mjs is on the live event path and not
// just a backfill you have to remember to run.
//
// WHY THIS TEST EXISTS AT ALL. db.mjs was a finished, well-tested module that nothing imported:
// db.test.mjs covers its upserts, its queries and its reconstruction of the JSON state in fine
// detail, and every one of those tests would still pass with the hub completely unwired. That is
// the exact shape of a green suite proving nothing about the thing you care about. What matters
// here is not "can the store hold a row" but "does a register/retire/board op PUT one there",
// which no unit test can see, so this drives a real hub over HTTP and reads the rows back out of
// the file the hub chose for itself.
//
// It also PINS the semantics, because they are a deliberate call somebody will otherwise
// "fix" (see the ready case below): lane is current truth, timestamps are history, and db.mjs's
// COALESCE contract means a timestamp can never be cleared once written.
//
// SKIPPED by default: each case spawns a real hub (no ConPTYs, so it is cheap -- ~2 seconds for all
// three). Run it deliberately:
//
//     npm run test:store
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createScratchHub } from '../test-support/scratch-hub.mjs';
import { init, getSession, listTasks } from '../db.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub per case; ~2 seconds)';

// Open the store, read, close — per read, never a long-lived handle. The hub holds the same file
// open for the whole run, so this leans on the WAL mode db.mjs sets; and leaving a handle open on
// Windows is what stops the scratch dir being deleted at teardown.
function readStore(dbFile, fn) {
    const db = init(dbFile);
    try { return fn(db); } finally { try { db.close(); } catch { } }
}
const taskById = (dbFile, id) => readStore(dbFile, db => listTasks(db).find(t => t.id === id) || null);
const readCrash = (dir) => { try { return readFileSync(join(dir, 'crash.log'), 'utf8'); } catch { return ''; } };

test('STORE: register, retire and every board op write themselves into db.mjs as they happen',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const hub = await createScratchHub();
        t.after(() => hub.dispose());
        await hub.start('store hub');

        // The path is part of the contract: the hub must write the file `node db.mjs backfill` reads,
        // which is defaultDbPath() inside JARVIS_DATA. A hub writing its history somewhere else is
        // indistinguishable from a hub not writing it.
        const dbFile = join(hub.DATA, 'jarvis.db');
        assert.ok(existsSync(dbFile), 'the hub booted without creating ' + dbFile);

        // ---- 1. register -------------------------------------------------------------------------
        const r = await hub.post('/register', {
            cwd: hub.REPO, purpose: 'store probe worker', pin: 'tango', parentProject: 'probe',
        });
        assert.ok(r && r.uid, 'register failed: ' + JSON.stringify(r));

        const born = readStore(dbFile, db => getSession(db, r.uid));
        assert.ok(born, 'a live session left NO row in the store — the register hook is not wired: ' + r.uid);
        assert.equal(born.callsign, 'tango');
        assert.equal(born.cwd, hub.REPO);
        assert.equal(born.purpose, 'store probe worker');
        assert.equal(born.parentProject, 'probe', 'the nesting a sub-worker registered with was not recorded');
        assert.equal(born.project, null, 'a sub-worker was recorded as a project coordinator');
        assert.ok(born.registeredAt, 'the session row has no registeredAt');
        assert.equal(born.retiredAt, null, 'a live session is already recorded as retired');
        assert.equal(born.summary, null);

        // ---- 2. add -> start -> done, with the timestamps the backfill cannot know ---------------
        // These are the whole point of being on the live path: worklist.json stores only addedAt, so a
        // reconstruction can only date a start/finish if the transcript still holds the task event.
        const added = await hub.post('/worklist', { op: 'add', callsign: 'tango', text: 'FEATURE: probe card one' });
        const id = added && added.task && added.task.id;
        assert.ok(id, 'add returned no task id: ' + JSON.stringify(added));

        let row = taskById(dbFile, id);
        assert.ok(row, 'an added task left NO row in the store — the board hook is not wired: ' + id);
        assert.equal(row.lane, 'queued');
        assert.equal(row.callsign, 'tango');
        assert.equal(row.text, 'FEATURE: probe card one', 'the task text did not reach the store');
        assert.equal(row.tag, 'FEATURE', 'the category chip was not parsed out of the text');
        assert.ok(row.addedAt, 'the task row has no addedAt');
        assert.equal(row.startedAt, null, 'a queued task is already recorded as started');
        assert.equal(row.doneAt, null, 'a queued task is already recorded as finished');

        await hub.post('/worklist', { op: 'start', callsign: 'tango', text: 'probe card one' });
        row = taskById(dbFile, id);
        assert.equal(row.lane, 'working', 'start did not move the lane in the store');
        assert.ok(row.startedAt, 'start recorded no startedAt — this is the fact only the live path has');
        assert.equal(row.doneAt, null);
        const startedAt = row.startedAt;

        await hub.post('/worklist', { op: 'done', callsign: 'tango', text: 'probe card one' });
        row = taskById(dbFile, id);
        assert.equal(row.lane, 'done', 'done did not move the lane in the store');
        assert.equal(row.startedAt, startedAt, 'done overwrote the startedAt that was already there');
        assert.ok(row.doneAt, 'done recorded no doneAt');
        const doneAt = row.doneAt;

        // ---- 3. THE SEMANTICS CALL — un-finishing is not time travel ----------------------------
        // `ready` pulls a finished task back to queued. The lane follows, but the doneAt CANNOT be
        // cleared: every column in db.mjs is COALESCE(new, old), which is what makes its backfill
        // idempotent, so passing null would be a no-op and passing anything else would be a lie.
        // So the row deliberately reads lane='queued' WITH a doneAt beside it — the task was in fact
        // finished at that instant, and somebody later decided it was not finished ENOUGH. The bill
        // for that choice: "what got done" is lane='done', never doneAt IS NOT NULL. Asserted so the
        // next reader meets the decision instead of filing it as a bug.
        await hub.post('/worklist', { op: 'ready', callsign: 'tango', text: 'probe card one' });
        row = taskById(dbFile, id);
        assert.equal(row.lane, 'queued', 'ready did not move the lane back in the store');
        assert.equal(row.doneAt, doneAt, 'ready CLEARED a historical doneAt — see the note above; lane is the current truth, timestamps are history');
        assert.equal(row.startedAt, startedAt);

        // ---- 4. drop keeps the row, in a lane the backfill can never produce ---------------------
        // A dropped task vanishes from worklist.json, so reconstruction loses it silently. Here it
        // survives as lane='dropped', which is what lets a report EXCLUDE abandoned work knowingly.
        const two = await hub.post('/worklist', { op: 'add', callsign: 'tango', text: 'BUG: probe card two' });
        const id2 = two && two.task && two.task.id;
        assert.ok(id2, 'add returned no task id: ' + JSON.stringify(two));
        await hub.post('/worklist', { op: 'drop', callsign: 'tango', text: 'probe card two' });
        const gone = taskById(dbFile, id2);
        assert.ok(gone, 'a dropped task left no row at all, so the report cannot tell abandoned from never-existed');
        assert.equal(gone.lane, 'dropped', 'drop left the row in its old lane, where it reads as still-open work');
        assert.equal(gone.tag, 'BUG');
        // ...and it really is off the board, so the store is holding the only record of it.
        const board = (await hub.get('/worklist')).sessions.tango;
        assert.ok(!JSON.stringify(board).includes('probe card two'), 'drop did not remove the task from the board');

        // ---- 5. the row follows the task across BOARDS, and a bump is not a lane change -----------
        // A board op is not confined to the poster's own column: findTaskAll searches every board, so
        // the row's callsign has to be where the task actually LIVES, not who asked. (record() logs the
        // poster's board in the transcript, which is why a reconstruction cannot get this right.)
        const three = await hub.post('/worklist', { op: 'add', callsign: 'tango', text: 'NOTE: probe card three' });
        const id3 = three && three.task && three.task.id;
        assert.ok(id3, 'add returned no task id: ' + JSON.stringify(three));

        // Started by a DIFFERENT board ('jarvis'), so poster and owner disagree.
        await hub.post('/worklist', { op: 'start', callsign: 'jarvis', text: 'probe card three' });
        row = taskById(dbFile, id3);
        assert.equal(row.callsign, 'tango', 'the row was credited to the board that POSTED the op, not the one holding the task');
        assert.equal(row.lane, 'working');

        // A `top` bumps within a lane. It must report the lane the task is in, not the one a reader
        // might assume from the op name.
        await hub.post('/worklist', { op: 'top', callsign: 'tango', text: 'probe card three' });
        row = taskById(dbFile, id3);
        assert.equal(row.lane, 'working', 'top rewrote the lane; a bump reorders within a lane, it does not move one');

        // A `move` hands the task to another board, and the row has to go with it.
        await hub.post('/worklist', { op: 'move', callsign: 'tango', text: 'probe card three', to: 'delta' });
        row = taskById(dbFile, id3);
        assert.equal(row.callsign, 'delta', 'a moved task is still recorded against its old board');
        assert.equal(row.lane, 'queued', 'a moved task lands queued on the new board');

        // ---- 6. retire ---------------------------------------------------------------------------
        const bye = await hub.post('/retire', { uid: r.uid, summary: 'probed the store end to end', successor: false });
        assert.equal(bye.ok, true, 'could not retire: ' + JSON.stringify(bye));

        const dead = readStore(dbFile, db => getSession(db, r.uid));
        assert.ok(dead.retiredAt, 'a retired session has no retiredAt — the retire hook is not wired');
        assert.equal(dead.summary, 'probed the store end to end', 'the epitaph did not reach the store');
        // The retire write carries the identity fields too, read off the same roster row, so they have
        // to land UNCHANGED. Worth asserting rather than assuming: a non-null value does replace what
        // is already there (db.mjs's COALESCE only blocks nulls), so this is the check that stops a
        // retire quietly rewriting when a session started or where it had been working.
        assert.equal(dead.registeredAt, born.registeredAt, 'retire moved the registeredAt');
        assert.equal(dead.callsign, 'tango', 'retire changed the callsign');
        assert.equal(dead.cwd, hub.REPO, 'retire rewrote the cwd');
        assert.equal(dead.parentProject, 'probe', 'retire dropped the project nesting');
    });

test('STORE: a hub whose store cannot be opened boots and serves anyway, and says so',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        // The risk profile of the entire change, in one test. db.mjs statically imports node:sqlite,
        // so these hooks have to be dynamic AND guarded at every step: a runtime without that builtin,
        // or a db file that will not open, must cost the hub NOTHING. Not the boot, not a register, not
        // a board op, not a retire.
        //
        // Forced here by planting a DIRECTORY where jarvis.db has to go, before the hub starts —
        // sqlite cannot open that, so init() throws in exactly the place a missing builtin would.
        const hub = await createScratchHub();
        t.after(() => hub.dispose());
        mkdirSync(join(hub.DATA, 'jarvis.db'), { recursive: true });

        await hub.start('store-off hub');   // must reach JARVIS CORE READY regardless

        const r = await hub.post('/register', { cwd: hub.REPO, purpose: 'store-off probe', pin: 'kilo' });
        assert.ok(r && r.uid, 'a hub with a broken store refused a register: ' + JSON.stringify(r));
        const added = await hub.post('/worklist', { op: 'add', callsign: 'kilo', text: 'WORK: still boards fine' });
        assert.equal(added.ok, true, 'a hub with a broken store refused a board op: ' + JSON.stringify(added));
        const started = await hub.post('/worklist', { op: 'start', callsign: 'kilo', text: 'still boards fine' });
        assert.equal(started.ok, true, 'a hub with a broken store refused a start: ' + JSON.stringify(started));
        // The board is intact, so nothing was half-applied around the failed writes. Checked BEFORE
        // the retire, which deletes the column.
        const board = (await hub.get('/worklist')).sessions.kilo;
        assert.ok(JSON.stringify(board).includes('still boards fine'), 'the board lost work while the store was broken');
        const bye = await hub.post('/retire', { uid: r.uid, summary: 'survived a dead store', successor: false });
        assert.equal(bye.ok, true, 'a hub with a broken store refused a retire: ' + JSON.stringify(bye));

        // And it FAILED LOUDLY somewhere. Every store write is swallowed by design, so crash.log is
        // the only place the outage can surface; without this, "store off" and "store fine" look
        // identical from the outside, which is the mistake this repo keeps paying for.
        const crash = readCrash(hub.DATA);
        assert.match(crash, /reporting-store-unavailable/, 'the store failed with nothing written to crash.log');
    });

test('STORE: a store that opens fine and then FAILS EVERY WRITE still costs the hub nothing',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        // The other half of the risk profile, and the half that is easy to leave unproven. The test
        // above only breaks the OPEN — after which every write is skipped without being attempted, so
        // the try/catch around the writes themselves is never entered. This one makes the writes
        // genuinely throw while the store is otherwise up and working.
        //
        // The lever is db.mjs's own schema step: CREATE TABLE IF NOT EXISTS is a no-op against a table
        // that already exists, so a pre-planted `tasks` of the wrong SHAPE survives init() (its two
        // indexed columns are there, so the indexes build) and then rejects every INSERT. That is not a
        // contrivance either -- it is what a future schema change looks like to an old db file.
        const hub = await createScratchHub();
        t.after(() => hub.dispose());
        const dbFile = join(hub.DATA, 'jarvis.db');
        const planted = new DatabaseSync(dbFile);
        planted.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, callsign TEXT, lane TEXT)');
        planted.close();

        await hub.start('write-fail hub');

        // The control that makes this test mean anything: the store really is ON. `sessions` was created
        // normally, so a register still lands a row -- if it did not, this would just be the previous
        // test again and the failing writes below would prove nothing.
        const r = await hub.post('/register', { cwd: hub.REPO, purpose: 'write-fail probe', pin: 'kilo' });
        assert.ok(r && r.uid, 'register failed: ' + JSON.stringify(r));
        assert.ok(readStore(dbFile, db => getSession(db, r.uid)),
            'the store was not actually up, so a failing WRITE was never exercised');

        // Three board ops, three throwing writes. Every one must still succeed as far as the hub and
        // the worker are concerned.
        for (const op of ['add', 'start', 'done']) {
            const out = await hub.post('/worklist', { op, callsign: 'kilo', text: op === 'add' ? 'WORK: still boards fine' : 'still boards fine' });
            assert.equal(out.ok, true, 'a throwing store write failed the board op ' + op + ': ' + JSON.stringify(out));
        }
        const board = (await hub.get('/worklist')).sessions.kilo;
        assert.equal((board.done || []).length, 1, 'the board lost the card while the store was throwing: ' + JSON.stringify(board));
        assert.equal(readStore(dbFile, db => db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n), 0,
            'the wrong-shaped table somehow accepted a row, so this test is not testing a failing write');

        // Loud on the first failure, and then it stops trying: three consecutive failures turn the
        // store off for the process rather than appending to crash.log once per board op forever.
        const crash = readCrash(hub.DATA);
        assert.match(crash, /reporting-store-write-failed \(worklist add/, 'a failing store write left nothing in crash.log');
        assert.match(crash, /reporting-store-off/, 'three failed writes did not turn the store off');

        // ...which is visible in the store itself: the retire is not recorded, because the store gave
        // up before it. Asserted so the degradation is a documented outcome and not a surprise.
        const bye = await hub.post('/retire', { uid: r.uid, summary: 'retired past a dead store', successor: false });
        assert.equal(bye.ok, true, 'a throwing store write failed the retire: ' + JSON.stringify(bye));
        assert.equal(readStore(dbFile, db => getSession(db, r.uid)).retiredAt, null,
            'the store was switched off, so the retire should not have been recorded');
    });
