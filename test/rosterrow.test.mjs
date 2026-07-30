// GET /roster told you WHO a session was and WHERE it ran, and stopped there.
//
// That is not what the endpoint gets asked. A coordinator asking after its own workers wants to know
// what they are DOING, how full they are, which of them are its, and whether they are isolated -- and
// every one of those already sat on the roster row, unprojected. The fields were ABSENT rather than
// empty, which is the worse of the two failures: `has not reported` and `was never projected` render
// identically, so a reader cannot tell a quiet worker from a thin endpoint.
//
// WHAT IT COST, 2026-07-30. A coordinator checked on its sub-worker through /roster, saw no `doing`
// line, and told Chris the worker was idle. The worker had posted /health five times, the most recent
// two minutes earlier. The same coordinator's own row showed no context despite two posts of its own,
// which is what proved the endpoint was the liar rather than the workers. A second session, separately,
// mis-read a sub-worker as sharing the human's checkout because `worktree` was not there either.
//
// No ConPTY in here on purpose: /register is plain HTTP and the defect is entirely in what the route
// PROJECTS, so spawning real workers would add a minute and two unrelated failure modes. Run with:
//
//     npm run test:rosterrow
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub on its own port)';

test('ROSTER ROW: a session that has reported its state does not read as idle',
    { skip: SKIP, timeout: 120000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('roster-row hub');

        const boss = await hub.post('/register', { cwd: hub.REPO, purpose: 'probe coordinator', project: 'probe' });
        const hand = await hub.post('/register', { cwd: hub.REPO, purpose: 'probe sub-worker', parentProject: 'probe' });
        const mute = await hub.post('/register', { cwd: hub.REPO, purpose: 'a session that never reports' });
        const fresh = await hub.post('/register', { cwd: hub.REPO, purpose: 'a just-booted session at zero' });
        for (const r of [boss, hand, mute, fresh]) assert.ok(r && r.uid, 'register failed: ' + JSON.stringify(r));

        // Both report, exactly as the protocol tells every worker to.
        // ZERO is in that list deliberately -- see the assertion it backs, further down.
        for (const [uid, ctx, doing] of [[hand.uid, 42, 'building the thing'], [boss.uid, 7, 'delegating'],
            [fresh.uid, 0, 'just booted']]) {
            const h = await hub.post('/health', { uid, context: ctx, doing });
            assert.equal(h.ok, true, '/health refused a report: ' + JSON.stringify(h));
        }

        const roster = await hub.get('/roster');
        const row = (cs) => (roster.live || []).find(r => r.callsign === cs) || null;
        const sub = row(hand.callsign), lead = row(boss.callsign), quiet = row(mute.callsign);
        const zero = row(fresh.callsign);
        assert.ok(sub && lead && quiet && zero, 'a registered session is missing from /roster live[]: '
            + JSON.stringify((roster.live || []).map(r => r.callsign)));

        // THE DEFECT. Pre-fix both of these were undefined, and that is the whole of what made a
        // working sub-worker readable as an idle one.
        assert.equal(sub.doing, 'building the thing', 'the sub-worker said what it was doing and /roster dropped it');
        assert.equal(sub.context, 42, 'the sub-worker reported its context and /roster dropped it');
        assert.equal(lead.doing, 'delegating', "the coordinator's own row lost its doing line too");
        assert.equal(lead.context, 7);

        // WHICH WORKERS ARE MINE -- the question a coordinator has to answer before any of the above
        // means anything. registerSession keeps these mutually exclusive, so between them one row says
        // coordinator, sub-worker, or standalone with no second fetch.
        assert.equal(sub.parentProject, 'probe', 'a sub-worker row does not say which project it serves');
        assert.equal(sub.project, null, 'a sub-worker must never read as its own coordinator');
        assert.equal(lead.project, 'probe', 'a bound coordinator row does not say what it coordinates');
        assert.equal(lead.parentProject, null);

        // PRESENT, not merely null. This scratch repo is not a git repo so nothing is isolated and null
        // is the honest answer -- but the KEY has to exist, because absent is precisely what let a
        // worktree'd sub-worker read as one sharing the human's checkout. `in` is what separates `the
        // endpoint says no` from `the endpoint does not discuss it`; asserting ===null alone would pass
        // just as happily against the thin row this test exists to outlaw.
        for (const k of ['doing', 'context', 'project', 'parentProject', 'worktree', 'branch']) {
            assert.ok(k in sub, '/roster does not project ' + k + ' at all: ' + JSON.stringify(sub));
        }
        assert.equal(sub.worktree, null);
        assert.equal(sub.branch, null);

        // A session that has genuinely never reported: null and empty, never missing. `has not said`
        // and `was not asked` have to stay distinguishable, or this row goes straight back to being
        // unreadable for the one case it was widened for.
        assert.equal(quiet.context, null, 'a never-reported context must read as null, not as absent');
        assert.equal(quiet.doing, '', 'a never-reported doing must read as empty, not as absent');

        // ...and ZERO is a report, not the absence of one. FOUND BY MUTATION PROBE: with `s.ctx ||
        // null` in the route every assertion above still passed, while a session honestly reporting 0
        // percent -- which is what a just-booted worker reports -- came back indistinguishable from one
        // that has never posted /health at all. That is this card's own bug, one operator further on,
        // and it would have landed inside the fix for it.
        assert.equal(zero.context, 0, 'a reported context of 0 was flattened into never-reported');
        assert.equal(zero.doing, 'just booted');

        // ...and /roster has to AGREE with /board about the same session, fetched as one pair. The two
        // routes keep separate projections of one roster row, which is how they drift apart; and a
        // session that cross-checks them at two different moments instead reads ordinary register/retire
        // churn as a defect, which has already happened and been reported to Chris as a bug.
        const board = await hub.get('/board');
        const card = (board.boards || []).find(b => b.callsign === hand.callsign);
        assert.ok(card, 'the sub-worker has no board card to compare the roster row against');
        assert.equal(card.doing, sub.doing, '/board and /roster disagree about what one session is doing');
        assert.equal(card.context, sub.context, "/board and /roster disagree about one session's context");
        assert.equal(card.parentProject, sub.parentProject, '/board and /roster disagree about who it serves');
    });
