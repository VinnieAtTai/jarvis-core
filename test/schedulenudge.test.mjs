// The wiring behind shouldNudgeSchedulePull: does a real register actually ASK for the day's pull?
//
// The decision is pure and covered in test/text.test.mjs. What that cannot see is the glue, which is
// where this feature would fail silently and look exactly like "nobody needed asking": the schedule
// field it reads (`date`), the directory it compares against (the hub's own HERE, versus a session
// cwd that was remapped out of a worktree), the queue the ask rides on, and the stamp that keeps it
// to once a day. Every one of those is a place a typo produces no error and no nudge.
//
// A fresh scratch hub has no schedule file at all, which is the "never pulled" state -- so the ask is
// due the moment the first worker registers.
//
// SKIPPED by default: it spawns a real hub and real ConPTYs. Run it deliberately:
//
//     npm run test:schedulenudge
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchHub, assertConsolelessPossible, sleep, REPO_ROOT } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub and ConPTYs; ~20 seconds)';

const askLines = (hub) => hub.transcript().split('\n').filter(l => /schedule stale .*; asked /.test(l));
const registered = (hub, cs) => hub.waitFor(cs + ' to register', async () => {
    const row = await hub.live(cs);
    return row && row.alive ? row : null;
}, 60000);

test('SCHEDULE NUDGE: the first brain of the day is asked to pull the calendar, and only the first',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        assertConsolelessPossible();
        // staleSchedule: the rig seeds a schedule dated today for everyone else, precisely so this
        // nudge cannot reach a test that is not about it. This test IS about it, so it opts out.
        const hub = await createScratchHub({ graceMs: 5000, staleSchedule: true });
        t.after(() => hub.dispose());
        await hub.start('nudge hub');
        assert.equal(existsSync(join(hub.DATA, 'schedule.json')), false, 'this rig opted out of the schedule seed, so it must start with no schedule at all');

        // ---- 1. the ask fires at register, on the bus and in the log ------------------------------
        // cwd is REPO_ROOT, not the rig's default scratch repo, and that is the point rather than a
        // convenience: the capability signal IS the hub's own checkout, because those sessions carry
        // the config that gives them Calendar. A worker in the scratch repo is a stand-in for a TMS
        // worker and must not be asked -- the rig's default cwd is deliberately not a brain.
        const A = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'first brain of the day' });
        const a = await registered(hub, A);
        const lines = askLines(hub);
        assert.equal(lines.length, 1, 'no ask was recorded for a hub that has never pulled a schedule: ' + JSON.stringify(lines));
        assert.match(lines[0], new RegExp('asked ' + A + ' to pull today'));

        // It has to REACH the session, not just be logged at it. /poll is the worker's inbox, so read
        // it the way a worker would -- this is the half that a wrong `to` would break invisibly.
        const inbox = await hub.get('/poll?uid=' + a.uid + '&cursor=0');
        const msg = (inbox.events || []).find(e => e.kind === 'msg' && /schedule is stale/.test(e.text || ''));
        assert.ok(msg, 'the ask never arrived on the session inbox: ' + JSON.stringify(inbox.events));
        assert.match(msg.text, /POST \/schedule/, 'the ask does not say what to do with the events');

        // ---- 2. and the day is STAMPED, so the next register is not asked again -------------------
        // Persisted rather than held in memory, because a hub restart would otherwise re-ask.
        const sch = JSON.parse(readFileSync(join(hub.DATA, 'schedule.json'), 'utf8'));
        assert.equal(sch.nudgedFor, new Date().toDateString(), 'the ask was not stamped: ' + JSON.stringify(sch));

        const B = await hub.spawnWorker({ cwd: REPO_ROOT, purpose: 'second brain, same day' });
        await registered(hub, B);
        await sleep(500);
        assert.deepEqual(askLines(hub).map(l => l.includes(B)), [false],
            'a second session was asked the same chore: ' + JSON.stringify(askLines(hub)));

        // ---- 3. and a worker OUTSIDE the hub checkout is not a candidate in the first place --------
        // Proven against a hub that has already stamped the day, so this is about the cwd test alone:
        // clear the stamp, then register a scratch-repo worker. It stays unasked, and the ask is still
        // available for a brain -- otherwise the once-a-day budget could be spent by a session that
        // could never have done the job.
        const stamped = JSON.parse(readFileSync(join(hub.DATA, 'schedule.json'), 'utf8'));
        delete stamped.nudgedFor;
        writeFileSync(join(hub.DATA, 'schedule.json'), JSON.stringify(stamped));
        const C = await hub.spawnWorker({ purpose: 'a worker in another repo' });
        await registered(hub, C);
        await sleep(500);
        assert.equal(askLines(hub).length, 1, 'a worker outside the hub checkout was asked: ' + JSON.stringify(askLines(hub)));
        assert.equal(JSON.parse(readFileSync(join(hub.DATA, 'schedule.json'), 'utf8')).nudgedFor, undefined,
            'a session that could not do the job still spent the day budget');
    });
