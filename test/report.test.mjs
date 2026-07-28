// The proof that the history the hub records can actually be ASKED FOR — that GET /report is a real
// read surface over db.mjs and not a shape that happens to return 200.
//
// WHY THIS TEST EXISTS. store.test.mjs proves the hub WRITES the store; db.test.mjs proves db.mjs's
// queries are right. Neither can see whether the hub serves any of it, and between them they would
// stay green with the endpoint deleted. What is checked here is the part only the endpoint decides:
// which of db.mjs's answers it hands back, what it says when the store is OFF, and whether it
// repeats the one arithmetic mistake the semantics invite.
//
// THE ASSERTION THAT MATTERS MOST is the `ready` case in test one. lane is current truth and
// startedAt/doneAt are history, and db.mjs's COALESCE means a doneAt can never be cleared — so a
// finished card pulled back to queued keeps its doneAt forever. An endpoint that reports finished
// work by timestamp therefore over-reports and never recovers, and a confidently wrong throughput
// figure is worse than no figure. That case is the difference, and it is the reason `finished` is
// pinned to lane='done' here rather than left to the caller.
//
// SKIPPED by default: each case spawns a real hub. Run it deliberately:
//
//     npm run test:report
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createScratchHub } from '../test-support/scratch-hub.mjs';
import { init, backfill } from '../db.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub per case; ~2 seconds)';

// scratch-hub's get() throws the status away, and here the status IS half the answer — a 503 saying
// "history is off" and a 200 saying "nothing happened" are the same body-shaped nothing otherwise.
async function getRaw(hub, path) {
    const r = await fetch(hub.origin + path);
    return { status: r.status, body: await r.json() };
}
const readCrash = (dir) => { try { return readFileSync(join(dir, 'crash.log'), 'utf8'); } catch { return ''; } };
const report = async (hub, qs = '') => {
    const { status, body } = await getRaw(hub, '/report' + qs);
    assert.equal(status, 200, 'GET /report' + qs + ' answered ' + status + ': ' + JSON.stringify(body));
    return body;
};

test('REPORT: the hub serves the history it records, and counts finished work by LANE not by timestamp',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const hub = await createScratchHub();
        t.after(() => hub.dispose());
        await hub.start('report hub');

        // The path is part of the answer: a report served out of some other file than the one
        // `node db.mjs backfill` maintains is a report about a different history.
        const dbFile = join(hub.DATA, 'jarvis.db');

        const r = await hub.post('/register', {
            cwd: hub.REPO, purpose: 'report probe worker', pin: 'tango', parentProject: 'probe',
        });
        assert.ok(r && r.uid, 'register failed: ' + JSON.stringify(r));

        let rep = await report(hub);
        assert.equal(rep.store, dbFile, 'the report is served from a different db than the hub writes');
        assert.equal(rep.view, 'work', 'view=work is the default');
        assert.equal(rep.finished, 0, 'a hub with no finished cards reported finished work');

        // ---- 1. a card through its whole life, seen from the outside -----------------------------
        await hub.post('/worklist', { op: 'add', callsign: 'tango', text: 'FEATURE: report card one' });
        rep = await report(hub);
        assert.equal(rep.counts.queued, 1, 'an added card is not in the lane counts: ' + JSON.stringify(rep.counts));
        assert.equal(rep.finished, 0, 'a queued card was counted as finished');

        await hub.post('/worklist', { op: 'start', callsign: 'tango', text: 'report card one' });
        rep = await report(hub);
        assert.equal(rep.counts.working, 1, 'a started card is not counted as working: ' + JSON.stringify(rep.counts));
        assert.ok(!rep.counts.queued, 'the card is counted in two lanes at once: ' + JSON.stringify(rep.counts));

        await hub.post('/worklist', { op: 'done', callsign: 'tango', text: 'report card one' });
        rep = await report(hub);
        assert.equal(rep.finished, 1, 'a finished card was not reported as finished');
        assert.equal(rep.counts.done, 1);
        assert.equal(rep.finished, rep.counts.done, 'finished and counts.done disagree — they must be ONE number');

        // The headline view answers "what did this worker do": its purpose, and how much it finished.
        const mine = rep.items.find(i => i.callsign === 'tango');
        assert.ok(mine, 'the working session is missing from view=work: ' + JSON.stringify(rep.items));
        assert.equal(mine.purpose, 'report probe worker', 'the session purpose did not reach the report');
        assert.equal(mine.parentProject, 'probe', 'the sub-worker nesting did not reach the report');
        assert.equal(mine.doneCount, 1, 'the report credits the session with the wrong number of finished cards');

        // ---- 2. THE TRAP — un-finishing must take the credit back --------------------------------
        // `ready` pulls the finished card back to queued. Its doneAt CANNOT be cleared (every column
        // in db.mjs is COALESCE(new, old), which is what makes the backfill idempotent), so the row
        // now reads lane='queued' with a doneAt standing beside it. An endpoint that answered "how
        // much got done" with `doneAt IS NOT NULL` would still say 1 here, and would keep saying 1
        // forever. Only lane can go back down.
        await hub.post('/worklist', { op: 'ready', callsign: 'tango', text: 'report card one' });
        rep = await report(hub);
        assert.equal(rep.finished, 0, 'an UN-finished card is still being reported as finished — finished work is lane=done, never a doneAt count');
        assert.equal(rep.counts.queued, 1, 'ready did not move the lane in the report');
        assert.ok(!rep.counts.done, 'the done lane still holds a card that was pulled back: ' + JSON.stringify(rep.counts));
        // ...and the timestamp really is still there, so the endpoint is reading lane deliberately
        // rather than being saved by a doneAt that got wiped. Without this the assertion above would
        // pass for the wrong reason.
        const pulled = (await report(hub, '?view=tasks&callsign=tango')).items.find(x => x.text.includes('report card one'));
        assert.ok(pulled.doneAt, 'the doneAt was cleared, so the lane-vs-timestamp distinction was never exercised here');
        assert.equal(pulled.lane, 'queued');

        await hub.post('/worklist', { op: 'done', callsign: 'tango', text: 'report card one' });
        assert.equal((await report(hub)).finished, 1, 'a re-finished card did not come back into the finished figure');

        // ---- 3. abandoned work is present as its own lane, not swept in or vanished ---------------
        // A dropped card is gone from worklist.json, so the backfill can never produce this lane; the
        // report is the only place it is visible. It must be excludable KNOWINGLY — which means it is
        // neither counted as finished nor silently filtered away.
        await hub.post('/worklist', { op: 'add', callsign: 'tango', text: 'BUG: report card two' });
        await hub.post('/worklist', { op: 'drop', callsign: 'tango', text: 'report card two' });
        rep = await report(hub);
        assert.equal(rep.counts.dropped, 1, 'a dropped card is not visible in the report at all: ' + JSON.stringify(rep.counts));
        assert.equal(rep.finished, 1, 'a dropped card was counted as finished work');

        const dropped = await report(hub, '?view=tasks&lane=dropped');
        assert.equal(dropped.count, 1, 'lane=dropped returned the wrong set: ' + JSON.stringify(dropped.items));
        assert.equal(dropped.items[0].tag, 'BUG', 'the category chip did not reach the report');

        // ---- 4. the two filtered views ------------------------------------------------------------
        const byCs = await report(hub, '?view=tasks&callsign=tango');
        assert.equal(byCs.count, 2, 'view=tasks by callsign returned the wrong count: ' + JSON.stringify(byCs.items));
        assert.equal((await report(hub, '?view=tasks&callsign=nobody')).count, 0, 'a callsign with no cards returned somebody elses');

        const sess = await report(hub, '?view=sessions&parentProject=probe');
        assert.equal(sess.count, 1, 'view=sessions by parentProject returned the wrong set: ' + JSON.stringify(sess.items));
        assert.equal(sess.items[0].uid, r.uid);
        assert.equal((await report(hub, '?view=sessions&parentProject=elsewhere')).count, 0, 'the parentProject filter is not filtering');
        assert.equal((await report(hub, '?view=sessions&activeOnly=1')).count, 1, 'a live session is missing from activeOnly');

        // ---- 5. a capped list says it was capped --------------------------------------------------
        // A truncated list that looks complete is its own wrong answer, so `total` has to survive the
        // slice. (`work` reports no total by design — recentWork caps in SQL and its HAVING clause
        // means the reportable count is not a plain table count.)
        const capped = await report(hub, '?view=tasks&limit=1');
        assert.equal(capped.count, 1, 'limit was ignored');
        assert.equal(capped.total, 2, 'a truncated report did not say how much it left out');
        assert.equal(capped.limit, 1);
        assert.equal((await report(hub, '?view=tasks')).total, undefined, 'an un-truncated report claims a total it did not need');

        // ---- 6. a view that does not exist is refused, not silently defaulted --------------------
        // Defaulting a typo'd view to `work` would answer a question nobody asked, which is how a
        // caller comes to believe it is reading tasks.
        const bogus = await getRaw(hub, '/report?view=nonsense');
        assert.equal(bogus.status, 400, 'an unknown view was served instead of refused: ' + JSON.stringify(bogus.body));

        // ---- 7. the retire epitaph lands in the report -------------------------------------------
        // This is the line the human hears months later when they ask what the old session did, so
        // the report exists largely to carry it.
        await hub.post('/retire', { uid: r.uid, summary: 'probed the report end to end', successor: false });
        const after = await report(hub);
        const dead = after.items.find(i => i.uid === r.uid);
        assert.equal(dead.summary, 'probed the report end to end', 'the retire summary never reached the report');
        assert.ok(dead.retiredAt, 'a retired session is still reported as live');
        assert.equal((await report(hub, '?view=sessions&activeOnly=1')).count, 0, 'a retired session is still in activeOnly');
    });

test('REPORT: a hub whose store is OFF says so, instead of answering that nothing ever happened',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        // The whole risk of adding a reader. The store is off whenever db.mjs will not load or its
        // file will not open, and by design the hub boots and serves anyway with every write
        // swallowed. So the ONE thing this endpoint must not do is succeed emptily: an empty 200 is
        // indistinguishable from a real "no work has ever been recorded", and a PM report is exactly
        // where that lie does damage. Forced the same way store.test.mjs forces it — a DIRECTORY where
        // jarvis.db has to go, which sqlite cannot open, standing in for a missing node:sqlite.
        const hub = await createScratchHub();
        t.after(() => hub.dispose());
        mkdirSync(join(hub.DATA, 'jarvis.db'), { recursive: true });

        await hub.start('report store-off hub');

        const { status, body } = await getRaw(hub, '/report');
        assert.equal(status, 503, 'a hub with no history served a report anyway: ' + JSON.stringify(body));
        assert.equal(body.store, 'off', 'the report did not say the store was off: ' + JSON.stringify(body));
        assert.match(body.error, /unavailable/, 'the outage was not explained: ' + JSON.stringify(body));
        // The trap, asserted directly: no empty success dressed up as an answer.
        assert.equal(body.items, undefined, 'an unavailable store returned an empty item list, which reads as "nothing ever happened"');
        assert.equal(body.counts, undefined, 'an unavailable store returned counts');
        assert.equal(body.finished, undefined, 'an unavailable store reported a finished figure');

        // And the hub is otherwise completely unharmed — the reader is a bystander exactly like the
        // writes. Without this the test above could pass on a hub that had fallen over.
        const roster = await hub.get('/roster');
        assert.ok(roster && roster.build, 'the hub stopped serving once the store was unavailable');
        const reg = await hub.post('/register', { cwd: hub.REPO, purpose: 'store-off report probe', pin: 'kilo' });
        assert.ok(reg && reg.uid, 'a hub with no history refused a register: ' + JSON.stringify(reg));
        const added = await hub.post('/worklist', { op: 'add', callsign: 'kilo', text: 'WORK: still boards fine' });
        assert.equal(added.ok, true, 'a hub with no history refused a board op: ' + JSON.stringify(added));
        // Asking for the report must not be a way to turn anything off either: still 503, same answer,
        // and the board op above still worked AFTER the first read. storeFails belongs to the record.
        assert.equal((await getRaw(hub, '/report')).status, 503, 'a second read changed the answer');
    });

test('REPORT: the reader serves a db built ONLY by the backfill, with no live write path involved',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        // Why this is not the same test as the first one. The live hooks are new (b5be7e2); every db
        // that predates them — including the live hub's, until it is rebuilt — holds nothing but what
        // `node db.mjs backfill` reconstructed from the JSON state. Those rows differ in ways a reader
        // could accidentally depend on: ids are synthetic (`wl_<cs>_<hash>`, not `t_...`), and a task
        // has no startedAt/doneAt at all unless the transcript still held its event. A reader that
        // needs a live-path row would serve an empty report against every existing db and look right.
        const hub = await createScratchHub();
        t.after(() => hub.dispose());

        // A history with no hub in it: one retired session and a board with a finished card, written
        // straight into the scratch data dir, then reconstructed by the backfill BEFORE the hub boots.
        writeFileSync(join(hub.DATA, 'sessions.json'), JSON.stringify({
            sessions: {
                s_9001: {
                    callsign: 'echo', cwd: 'd:/old/repo', purpose: 'the session before the hooks existed',
                    parentProject: 'legacy', started: '2026-07-01T10:00:00.000Z',
                    ended: '2026-07-01T12:00:00.000Z', summary: 'shipped it before anything recorded itself',
                },
                // A COORDINATOR, so the other of the two nesting filters has something to find. project
                // and parentProject are different columns and a report that confuses them credits a
                // sub-worker's output to the project it was nested under, or the reverse.
                s_9002: {
                    callsign: 'foxtrot', cwd: 'd:/old/repo2', purpose: 'the coordinator of the old project',
                    project: 'oldproj', started: '2026-07-01T09:00:00.000Z',
                    ended: '2026-07-01T11:00:00.000Z', summary: 'ran the old project',
                },
            },
        }));
        writeFileSync(join(hub.DATA, 'worklist.json'), JSON.stringify({
            focus: 'jarvis',
            sessions: {
                echo: {
                    working: [], review: [], queued: [{ text: 'NOTE: never got to it', addedAt: '2026-07-01T10:30:00.000Z' }],
                    done: [{ text: 'FEATURE: the old finished card', addedAt: '2026-07-01T10:05:00.000Z' }],
                },
            },
        }));
        const seeded = init(join(hub.DATA, 'jarvis.db'));
        const counts = backfill(seeded, hub.DATA);
        seeded.close();
        assert.ok(counts.tasks >= 2 && counts.sessions >= 1, 'the backfill seeded nothing, so this proves nothing: ' + JSON.stringify(counts));

        await hub.start('report backfill hub');

        const rep = await report(hub);
        const old = rep.items.find(i => i.uid === 's_9001');
        assert.ok(old, 'a backfilled session is missing from the report: ' + JSON.stringify(rep.items));
        assert.equal(old.summary, 'shipped it before anything recorded itself', 'the backfilled epitaph did not reach the report');
        assert.equal(old.doneCount, 1, 'the backfilled finished card was not credited to its session');
        assert.equal(rep.finished, 1, 'a report over a backfill-only db reported no finished work');

        const tasks = await report(hub, '?view=tasks&callsign=echo');
        assert.equal(tasks.count, 2, 'the backfilled cards are not readable through the report: ' + JSON.stringify(tasks.items));
        const oldDone = tasks.items.find(x => x.lane === 'done');
        assert.match(oldDone.id, /^wl_echo_/, 'this row did not come from the backfill, so the case under test never happened');
        assert.equal(oldDone.doneAt, null, 'a reconstructed card somehow has a finish time; the backfill could not have known it');
        assert.equal(oldDone.tag, 'FEATURE', 'the chip was not parsed out of a backfilled row');

        // project and parentProject are separate columns, and separate filters.
        const proj = await report(hub, '?view=sessions&project=oldproj');
        assert.equal(proj.count, 1, 'the project filter returned the wrong set: ' + JSON.stringify(proj.items));
        assert.equal(proj.items[0].uid, 's_9002', 'the project filter matched on parentProject instead');
        assert.equal((await report(hub, '?view=sessions&parentProject=oldproj')).count, 0, 'a project was found under parentProject — the two columns are being conflated');

        // The cap reaches view=work too, which caps in SQL rather than here. Both planted sessions are
        // reportable (each has a summary), so a limit that was not passed through would return both.
        assert.equal((await report(hub, '?view=work')).count, 2, 'both recorded sessions should be reportable');
        const oneWork = await report(hub, '?view=work&limit=1');
        assert.equal(oneWork.count, 1, 'limit is not reaching recentWork');
        // ...and it reached it in SQL, not by being sliced afterwards. Both would leave count at 1, so
        // the ABSENCE of `total` is the only thing that tells them apart: the slice is what sets it.
        // Without this the assertion above passes whatever recentWork was handed, which is how a dead
        // argument survives a green run.
        assert.equal(oneWork.total, undefined, 'view=work was capped by the slice, so recentWork was handed the wrong limit');
    });

test('REPORT: a FAILING read cannot switch the record off — the reader is not allowed to cost the writer',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        // The one way adding a reader could damage what already worked. Every store WRITE is counted:
        // three consecutive failures turn the store off for the life of the process, deliberately, so
        // an unwritable db cannot append to crash.log once per board op forever. If a failing READ were
        // counted the same way, then ASKING for the history would be a way to stop the history being
        // recorded — and the endpoint is the thing a console polls. Hence the read's catch is separate
        // and touches neither storeFails nor storeOff. That is invisible in the code's behaviour until
        // reads actually fail, so make them fail.
        //
        // The lever: plant a `sessions` table missing most of its columns. CREATE TABLE IF NOT EXISTS
        // leaves it alone and both indexed columns are present, so init() succeeds and the store comes
        // up ON — but listSessions ORDERs BY columns that are not there, so view=sessions throws on
        // every call. `tasks` is created normally, which is what makes the writes an independent
        // observable: they keep working unless something turns them off.
        const hub = await createScratchHub();
        t.after(() => hub.dispose());
        const dbFile = join(hub.DATA, 'jarvis.db');
        const planted = new DatabaseSync(dbFile);
        planted.exec('CREATE TABLE sessions (uid TEXT PRIMARY KEY, callsign TEXT, project TEXT, parentProject TEXT)');
        planted.close();

        await hub.start('report read-fail hub');

        const r = await hub.post('/register', { cwd: hub.REPO, purpose: 'read-fail probe', pin: 'tango' });
        assert.ok(r && r.uid, 'register failed: ' + JSON.stringify(r));

        // The control: task writes really are working, so a missing row later means something stopped
        // them rather than them never having worked. (This also resets the write-failure counter that
        // the register's own failed session write just incremented.)
        await hub.post('/worklist', { op: 'add', callsign: 'tango', text: 'WORK: before the failing reads' });
        assert.equal((await report(hub, '?view=tasks')).count, 1, 'the store was not actually recording, so this test proves nothing');

        // Three failing reads — one more than the write path tolerates. Each must be a clean 500.
        for (let i = 0; i < 3; i++) {
            const bad = await getRaw(hub, '/report?view=sessions');
            assert.equal(bad.status, 500, 'a throwing read did not answer 500 on attempt ' + (i + 1) + ': ' + JSON.stringify(bad.body));
            assert.equal(bad.body.store, 'on', 'a throwing read blamed an unavailable store: ' + JSON.stringify(bad.body));
        }

        // THE ASSERTION, checked here rather than after the write below because it names the invariant
        // directly: three failures is exactly what turns the WRITE path off, and these were reads, so
        // that must not have happened. Checked first because a store that HAS been switched off makes
        // every later read answer 503 too, and then the test fails somewhere that does not explain why.
        const crash = readCrash(hub.DATA);
        assert.ok(!/reporting-store-off/.test(crash), 'the failing READS tripped the write path kill-switch: ' + crash.slice(-400));
        // Loud, though. A swallowed read failure is as invisible as a swallowed write, which is the
        // mistake this repo keeps paying for.
        assert.match(crash, /reporting-store-read-failed \(GET \/report view=sessions/, 'a failing read left nothing in crash.log');

        // And the behavioural half: the record really is still being kept, not merely un-flagged.
        await hub.post('/worklist', { op: 'add', callsign: 'tango', text: 'WORK: after the failing reads' });
        const tasks = await report(hub, '?view=tasks');
        assert.equal(tasks.count, 2, 'a write after the failing reads did not land: ' + JSON.stringify(tasks.items));
        assert.ok(tasks.items.some(x => x.text.includes('after the failing reads')), 'the write after the failing reads was dropped');
    });
