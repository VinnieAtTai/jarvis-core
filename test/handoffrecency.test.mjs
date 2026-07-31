// WHICH handoff a session is served, and the freshness window that keeps the rule from misfiring the
// other way.
//
// THE MEASURED BUG, 2026-07-30. golf booted with purpose "JARVIS punchlist and the console board-rot
// fixes". Its real predecessor quebec had checkpointed under "JARVIS punchlist - project
// coordinator". Same job by any human reading, but handoffKey folds the purpose into the key, so they
// are two slots -- and golf's own slot still held a DIFFERENT session's record from the day before.
// That is what golf was handed. quebec's notes were filed, intact, and unreachable.
//
// Two things made it invisible, which is why it needs a test rather than a careful reader. The
// successor cannot tell it got the wrong notes -- a handoff record is just prose, and a plausible one
// reads like your own job. And the recency fallback that would have saved it fired ONLY when the
// purpose was absent, so the near-miss case had no path to the right record at all.
//
// THE RULE, in three arms, all pinned below:
//   1. a RECENT exact hit is trusted outright -- recency may not displace it;
//   2. a STALE exact hit loses to a strictly newer record on the same cwd;
//   3. when arm 1 suppresses an override, the newer record's key is STILL reported.
// Arm 3 exists because silence is what cost the session. Unbounded recency (the first cut of this
// fix) reproduced the same bug mirrored: on a cwd hosting several unrelated jobs -- d:/code/tms, which
// is Chris's daily repo -- a job's own record was shadowed by whatever another job filed last.
//
// The pure tests run under plain `npm test`. The route half is SKIPPED unless JARVIS_INTEGRATION=1:
//
//     npm run test:handoffrecency
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickHandoff, handoffKey, purposeOfHandoffKey, HANDOFF_EXACT_FRESH_MS } from '../jarvis-text.mjs';
import { createScratchHub, sleep } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub; ~15 seconds)';

// The live shape at the time of the bug, with the timestamps that produced it. NOW is injected into
// every pure call so nothing here turns on the wall clock -- a freshness rule tested against real time
// is a test whose meaning changes overnight.
const CWD = 'D:/Claude';
const NOW = Date.parse('2026-07-30T22:00:00.000Z');
const GOLF_PURPOSE = 'JARVIS punchlist and the console board-rot fixes';
const QUEBEC_PURPOSE = 'JARVIS punchlist - project coordinator';
const STALE = { from: 'papa', cwd: CWD, purpose: GOLF_PURPOSE, notes: 'a different job, a day old', ts: '2026-07-29T09:00:00.000Z' };
const FRESH = { from: 'quebec', cwd: CWD, purpose: QUEBEC_PURPOSE, notes: 'the notes golf should have been given', ts: '2026-07-30T21:40:00.000Z' };
const STORE = () => ({
    [handoffKey(CWD, GOLF_PURPOSE)]: { ...STALE },
    [handoffKey(CWD, QUEBEC_PURPOSE)]: { ...FRESH },
});
const pick = (store, purpose, now = NOW) => pickHandoff(store, CWD, purpose, now);
const iso = (ms) => new Date(ms).toISOString();

test('pickHandoff -- THE BUG: a stale EXACT hit loses to a newer record on the same cwd', () => {
    // 37 hours old, so the window cannot save it -- the arm the whole fix exists for.
    const p = pick(STORE(), GOLF_PURPOSE);
    assert.equal(p.rec.from, 'quebec', 'served the stale exact hit -- this is the golf failure, verbatim');
    assert.equal(p.servedKey, handoffKey(CWD, QUEBEC_PURPOSE), 'the served key must NAME the record, or the misfire stays invisible');
    assert.equal(p.viaRecency, true);
    assert.equal(p.newerKey, undefined, 'nothing was suppressed here -- the newest record IS what was served');
});

test('pickHandoff -- an exact hit that IS the newest keeps its own key, and is not labelled', () => {
    // The negative control, and the one that stops "always return newest" from passing the test above.
    const p = pick(STORE(), QUEBEC_PURPOSE);
    assert.equal(p.rec.from, 'quebec');
    assert.equal(p.servedKey, handoffKey(CWD, QUEBEC_PURPOSE));
    assert.equal(p.viaRecency, false, 'a record served under its own key must not claim it came from another');
    assert.equal(p.newerKey, undefined);
});

// ---- the freshness window, all three arms ------------------------------------------------------

test('THE WINDOW: a RECENT exact hit is not displaced, and the newer record is still NAMED', () => {
    // Arms 1 and 3 together, which is the point -- keeping the record and reporting the alternative
    // are one decision, not two. This is the d:/code/tms shape: my own checkpoint an hour ago, and
    // some unrelated job on the same repo checkpointed ten minutes ago.
    //
    // BOTH INSERTION ORDERS. The strictly-newer guard already had a probe survive on exactly this
    // laziness (see the tie test below), and a window rule under-feeds the same way: with the exact
    // record first in key order it wins the scan regardless of whether the window ran at all.
    const mine = { from: 'mine', cwd: CWD, purpose: GOLF_PURPOSE, notes: 'my own, recent', ts: iso(NOW - 3600000) };
    const theirs = { from: 'theirs', cwd: CWD, purpose: QUEBEC_PURPOSE, notes: 'another job, newer', ts: iso(NOW - 600000) };
    const exactFirst = { [handoffKey(CWD, GOLF_PURPOSE)]: mine, [handoffKey(CWD, QUEBEC_PURPOSE)]: theirs };
    const otherFirst = { [handoffKey(CWD, QUEBEC_PURPOSE)]: theirs, [handoffKey(CWD, GOLF_PURPOSE)]: mine };
    for (const [label, s] of [['exact first', exactFirst], ['other first', otherFirst]]) {
        const p = pick(s, GOLF_PURPOSE);
        assert.equal(p.rec.from, 'mine', 'a RECENT exact hit was displaced (' + label + ') -- that is the mirrored bug, a successor served another job\'s notes');
        assert.equal(p.servedKey, handoffKey(CWD, GOLF_PURPOSE));
        assert.equal(p.viaRecency, false);
        // Arm 3. Suppressing the override silently is the failure mode that cost golf a session.
        assert.equal(p.newerKey, handoffKey(CWD, QUEBEC_PURPOSE),
            'the suppressed newer record was not reported (' + label + '), so this branch of the rule is silent');
        assert.equal(purposeOfHandoffKey(p.newerKey), QUEBEC_PURPOSE.toLowerCase(), 'the reported key does not name a readable purpose');
    }
});

test('THE WINDOW: it is the EXACT hit that must be fresh, not the candidate', () => {
    // The distinction bravo called out. A newer candidate is never disqualified by its own age -- what
    // decides is whether MY record is recent. Here both records are ancient, so the override stands:
    // the same store as the arm above with only the timestamps shifted back past the window.
    const mine = { from: 'mine', cwd: CWD, purpose: GOLF_PURPOSE, notes: 'my own, but old', ts: iso(NOW - HANDOFF_EXACT_FRESH_MS - 3600000) };
    const theirs = { from: 'theirs', cwd: CWD, purpose: QUEBEC_PURPOSE, notes: 'another job, newer but also old', ts: iso(NOW - HANDOFF_EXACT_FRESH_MS - 600000) };
    for (const [label, s] of [
        ['exact first', { [handoffKey(CWD, GOLF_PURPOSE)]: mine, [handoffKey(CWD, QUEBEC_PURPOSE)]: theirs }],
        ['other first', { [handoffKey(CWD, QUEBEC_PURPOSE)]: theirs, [handoffKey(CWD, GOLF_PURPOSE)]: mine }],
    ]) {
        const p = pick(s, GOLF_PURPOSE);
        assert.equal(p.rec.from, 'theirs', 'a STALE exact hit survived (' + label + '), so the window is being applied to the wrong record');
        assert.equal(p.viaRecency, true);
        assert.equal(p.newerKey, undefined);
    }
});

test('THE WINDOW: the boundary is strict, and stated in one constant', () => {
    // Pinned because a window is exactly the kind of rule that gets an off-by-one and never shows it.
    // 12h is a judgement call and may be tuned; that it is a SINGLE constant, and that the comparison
    // is `<`, are not.
    assert.equal(HANDOFF_EXACT_FRESH_MS, 43200000, 'the window changed -- intentional? then say so here and in pickHandoff');
    const theirs = { from: 'theirs', cwd: CWD, purpose: QUEBEC_PURPOSE, notes: 'newer', ts: iso(NOW) };
    const at = (ageMs) => {
        const mine = { from: 'mine', cwd: CWD, purpose: GOLF_PURPOSE, notes: 'mine', ts: iso(NOW - ageMs) };
        return pick({ [handoffKey(CWD, QUEBEC_PURPOSE)]: theirs, [handoffKey(CWD, GOLF_PURPOSE)]: mine }, GOLF_PURPOSE);
    };
    assert.equal(at(HANDOFF_EXACT_FRESH_MS - 1).rec.from, 'mine', 'one millisecond inside the window is still fresh');
    assert.equal(at(HANDOFF_EXACT_FRESH_MS).rec.from, 'theirs', 'exactly AT the window must be stale -- the comparison is strict');
    assert.equal(at(HANDOFF_EXACT_FRESH_MS + 1).rec.from, 'theirs');
});

test('THE WINDOW: an UNDATEABLE exact hit is never fresh', () => {
    // A record that cannot prove its age must not inherit the benefit of the doubt: freshness is a
    // demonstrated property here, and the whole window rests on it.
    const mine = { from: 'mine', cwd: CWD, purpose: GOLF_PURPOSE, notes: 'no ts at all' };
    const theirs = { from: 'theirs', cwd: CWD, purpose: QUEBEC_PURPOSE, notes: 'dated and newer', ts: iso(NOW - 600000) };
    for (const [label, s] of [
        ['exact first', { [handoffKey(CWD, GOLF_PURPOSE)]: mine, [handoffKey(CWD, QUEBEC_PURPOSE)]: theirs }],
        ['other first', { [handoffKey(CWD, QUEBEC_PURPOSE)]: theirs, [handoffKey(CWD, GOLF_PURPOSE)]: mine }],
    ]) {
        const p = pick(s, GOLF_PURPOSE);
        assert.equal(p.rec.from, 'theirs', 'an undated exact hit was treated as fresh (' + label + ')');
        assert.equal(p.viaRecency, true);
    }
});

test('THE WINDOW: a stale exact hit with NOTHING newer beside it is still served, unlabelled', () => {
    // Staleness alone is not a disqualification -- there has to be somewhere better to go. A lone old
    // record on a cwd is still that job's handoff.
    const only = { [handoffKey(CWD, GOLF_PURPOSE)]: { ...STALE } };
    const p = pick(only, GOLF_PURPOSE);
    assert.equal(p.rec.from, 'papa');
    assert.equal(p.viaRecency, false);
    assert.equal(p.newerKey, undefined, 'reported a newer record when there is none');
});

// ---- the ordering rule underneath it ------------------------------------------------------------

test('pickHandoff -- STRICTLY newer: an equal timestamp does not displace the exact hit', () => {
    // Whole-second or same-millisecond ties are real (two retires in one pump), and iteration order
    // must not be what decides the answer.
    //
    // BOTH INSERTION ORDERS, and the second one is the whole test. A mutation probe killed the
    // first-order-only version of this: with the exact record inserted FIRST it wins the scan anyway,
    // so dropping the `strictly newer` guard entirely still passed. The fixture never reached the
    // guard -- it was under-fed, not passing. Only the tied record sitting EARLIER in key order
    // distinguishes "the guard held" from "the loop happened to see the right one first".
    const exactFirst = {
        [handoffKey(CWD, GOLF_PURPOSE)]: { ...STALE },
        [handoffKey(CWD, QUEBEC_PURPOSE)]: { ...FRESH, ts: STALE.ts },
    };
    const otherFirst = {
        [handoffKey(CWD, QUEBEC_PURPOSE)]: { ...FRESH, ts: STALE.ts },
        [handoffKey(CWD, GOLF_PURPOSE)]: { ...STALE },
    };
    for (const [label, s] of [['exact first', exactFirst], ['other first', otherFirst]]) {
        const p = pick(s, GOLF_PURPOSE);
        assert.equal(p.rec.from, 'papa', 'a tie flipped the answer (' + label + '), so key order is deciding whose notes a successor reads');
        assert.equal(p.servedKey, handoffKey(CWD, GOLF_PURPOSE), 'the tie was served under the wrong key (' + label + ')');
        assert.equal(p.viaRecency, false);
        assert.equal(p.newerKey, undefined, 'a tie is not "newer", so there is nothing to report');
    }
});

test('pickHandoff -- an exact record that is not a cwd candidate still beats an OLDER one', () => {
    // The other input class that reaches the strictly-newer guard. A record with no `cwd` field is
    // excluded from the recency scan (it is not on any cwd), so `best` can be genuinely OLDER than
    // the exact hit -- the one arrangement where the comparison, not the scan, decides. Legacy and
    // half-written records really do lack cwd; the exact slot is still this job's own answer.
    const s = {
        [handoffKey(CWD, GOLF_PURPOSE)]: { from: 'papa', purpose: GOLF_PURPOSE, notes: 'mine, and newer', ts: iso(NOW - 1000) },
        [handoffKey(CWD, QUEBEC_PURPOSE)]: { ...FRESH },
    };
    const p = pick(s, GOLF_PURPOSE);
    assert.equal(p.rec.from, 'papa', 'an OLDER record on the cwd displaced a NEWER exact hit');
    assert.equal(p.viaRecency, false);
    assert.equal(p.newerKey, undefined);
});

test('pickHandoff -- no exact hit at all still resolves to the newest on the cwd, and says so', () => {
    // The legacy bare GET /handoff?cwd=... path. It used to be the ONLY case recency covered; it stays
    // covered, and now it is labelled too, because a record filed under someone else's purpose is
    // exactly as surprising here as it is above. The window has no opinion here -- there is no exact
    // hit to be fresh.
    const s = STORE();
    delete s[handoffKey(CWD, GOLF_PURPOSE)];
    const p = pick(s, GOLF_PURPOSE);
    assert.equal(p.rec.from, 'quebec');
    assert.equal(p.viaRecency, true);
    // Even when the only record on the cwd is minutes old, so freshness cannot be what let it through.
    const recent = { [handoffKey(CWD, QUEBEC_PURPOSE)]: { ...FRESH, ts: iso(NOW - 60000) } };
    assert.equal(pick(recent, GOLF_PURPOSE).rec.from, 'quebec');
    // And with no purpose at all, which is how the old-style call arrives.
    assert.equal(pick(s, null).rec.from, 'quebec');
    assert.equal(pick(s, undefined).rec.from, 'quebec');
});

test('pickHandoff -- a cs: stash is never a recency candidate', () => {
    // Those are one-shot records addressed to a callsign and consumed on read. Letting one win here
    // would hand a spawn's private briefing to an unrelated session on the same cwd, and delete it.
    const s = STORE();
    s['cs:tango'] = { from: 'zulu', cwd: CWD, purpose: 'someone else entirely', ts: iso(NOW - 1000) };
    const p = pick(s, GOLF_PURPOSE);
    assert.equal(p.rec.from, 'quebec');
    assert.ok(!p.servedKey.startsWith('cs:'));
    // Nor may it be reported as the suppressed alternative -- that would send a successor to a record
    // that is not addressed to it.
    assert.ok(!(p.newerKey || '').startsWith('cs:'));
});

test('pickHandoff -- another cwd never leaks in, however new it is', () => {
    const s = STORE();
    s[handoffKey('D:/code/tms', 'a TMS job')] = { from: 'zulu', cwd: 'D:/code/tms', purpose: 'a TMS job', ts: iso(NOW - 1000) };
    assert.equal(pick(s, GOLF_PURPOSE).rec.from, 'quebec');
    // Separator and case are not a difference: cwdKey normalizes both, the same as the key itself.
    assert.equal(pickHandoff(s, 'd:\\claude', GOLF_PURPOSE, NOW).rec.from, 'quebec');
});

test('pickHandoff -- nothing on this cwd returns null, never an unrelated record', () => {
    assert.equal(pickHandoff(STORE(), 'D:/somewhere/else', 'any job', NOW), null);
    assert.equal(pick({}, GOLF_PURPOSE), null);
});

test('pickHandoff -- a broken clock can lose but never win', () => {
    // Ordering on Date.parse means an unparseable ts has to sort SOMEWHERE. -Infinity is the safe end:
    // a record nobody can date must not outrank one that can be dated.
    const undated = { from: 'undated', cwd: CWD, purpose: 'undated job', notes: 'no ts at all' };
    const s = STORE();
    s[handoffKey(CWD, 'undated job')] = undated;
    assert.equal(pick(s, GOLF_PURPOSE).rec.from, 'quebec', 'an undated record beat a dated one');
    // ...and asked for BY key it is still served: losing the recency contest is not being unreachable.
    const only = { [handoffKey(CWD, 'undated job')]: undated };
    assert.equal(pick(only, 'undated job').rec.from, 'undated');
    assert.equal(pick(only, GOLF_PURPOSE).rec.from, 'undated', 'with nothing dated on the cwd, the one record on it is still the answer');
});

test('pickHandoff -- garbage in never throws: this runs on every register', () => {
    // A throw here would take down the register path itself, which is a worse outcome than any wrong
    // record: the session never boots.
    for (const bad of [null, undefined, '', 0, false, 'not-an-object', []]) {
        assert.doesNotThrow(() => pick(bad, GOLF_PURPOSE));
        assert.doesNotThrow(() => pickHandoff(STORE(), bad, GOLF_PURPOSE, NOW));
    }
    assert.equal(pickHandoff(STORE(), null, GOLF_PURPOSE, NOW), null);
    // A junk `now` must fall back to the real clock, not silently switch the window off.
    for (const bad of [undefined, null, NaN, 'not-a-number']) {
        assert.doesNotThrow(() => pickHandoff(STORE(), CWD, GOLF_PURPOSE, bad));
    }
    // Half-written rows must be skipped, not crash the scan or become the answer.
    const s = STORE();
    s[handoffKey(CWD, 'junk a')] = null;
    s[handoffKey(CWD, 'junk b')] = 'a string';
    s[handoffKey(CWD, 'junk c')] = { from: 'nocwd', ts: iso(NOW - 1000) };   // no cwd -> not on any cwd
    assert.equal(pick(s, GOLF_PURPOSE).rec.from, 'quebec');
    // An exact slot holding junk is the same as an empty one, and must not shadow a real record.
    const s2 = STORE();
    s2[handoffKey(CWD, GOLF_PURPOSE)] = 'corrupt';
    assert.equal(pick(s2, GOLF_PURPOSE).rec.from, 'quebec');
});

test('pickHandoff -- pure: does not mutate the store it reads', () => {
    const s = STORE();
    const before = JSON.stringify(s);
    pick(s, GOLF_PURPOSE);
    pick(s, QUEBEC_PURPOSE);
    pickHandoff(s, 'D:/nowhere', 'nothing', NOW);
    assert.equal(JSON.stringify(s), before);
});

test('purposeOfHandoffKey -- names the job a reported key belongs to, and never throws', () => {
    // It exists for one prose message, but that message is the whole visibility promise, so an empty
    // or malformed key must read as something rather than as nothing.
    assert.equal(purposeOfHandoffKey(handoffKey(CWD, QUEBEC_PURPOSE)), QUEBEC_PURPOSE.toLowerCase());
    assert.equal(purposeOfHandoffKey(handoffKey(CWD, '')), '(no purpose)');
    for (const bad of [null, undefined, '', 0, 'no-separator-at-all', {}]) {
        assert.equal(purposeOfHandoffKey(bad), '(no purpose)');
    }
});

// ---- the two read paths, at a real hub ---------------------------------------------------------
// What the pure tests cannot show: that BOTH readers consult the rule, and that they agree. The
// register hint and GET /handoff resolved the record independently before this, which is how one of
// them could have been fixed and the other left behind -- the shape of the boardKey card exactly.
//
// A live hub can only ever file records that are seconds old, so the STALE arm is unreachable through
// /handoff alone. Hence the seeded sessions.json below: the stale record is planted on disk before
// boot and read by the hub's own loadRoster, so the route -- not a stub -- is what resolves it.
test('HANDOFF RECENCY: both read paths apply the window, and neither branch is silent',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());

        // Two days old: comfortably past the 12h window, the same shape as golf's day-old record.
        const staleTs = iso(Date.now() - 48 * 3600 * 1000);
        writeFileSync(join(hub.DATA, 'sessions.json'), JSON.stringify({
            callsigns: {}, sessions: {}, nextUid: 900,
            handoffs: {
                [handoffKey(hub.REPO, GOLF_PURPOSE)]: {
                    summary: 'a different job, two days ago', notes: 'NOTES THAT BELONG TO ANOTHER JOB',
                    from: 'papa', cwd: hub.REPO, purpose: GOLF_PURPOSE, ts: staleTs,
                },
            },
        }, null, 1));
        await hub.start('handoff-recency hub');

        const file = async (purpose, notes) => {
            const r = await hub.post('/register', { cwd: hub.REPO, purpose });
            assert.ok(r.uid, 'register failed: ' + JSON.stringify(r));
            const h = await hub.post('/handoff', { uid: r.uid, summary: 'summary from ' + r.callsign, notes });
            assert.equal(h.ok, true, '/handoff was refused: ' + JSON.stringify(h));
            return r;
        };
        const getHandoff = (purpose) => hub.get('/handoff?cwd=' + encodeURIComponent(hub.REPO)
            + '&purpose=' + encodeURIComponent(purpose));

        // The rig only proves anything if the seed survived boot. A silently-reset roster would make
        // every assertion below pass for the wrong reason.
        const seeded = await getHandoff(GOLF_PURPOSE);
        assert.equal(seeded.from, 'papa', 'the seeded stale record did not survive boot, so the STALE arm is untested: ' + JSON.stringify(seeded));

        // ---- ARM 2: a STALE exact hit loses to a newer record -----------------------------------
        const right = await file(QUEBEC_PURPOSE, 'THE NOTES THE SUCCESSOR NEEDS');

        const succ = await hub.post('/register', { cwd: hub.REPO, purpose: GOLF_PURPOSE });
        assert.ok(succ.handoff, 'register offered no handoff at all: ' + JSON.stringify(succ));
        assert.equal(succ.handoff.from, right.callsign,
            'REGRESSION: register served the STALE exact hit (' + succ.handoff.from + ') instead of the newer record from ' + right.callsign);
        assert.equal(succ.handoff.servedKey, handoffKey(hub.REPO, QUEBEC_PURPOSE),
            'the hint does not name the key it came from, so the successor cannot see it got another job\'s notes');
        assert.equal(succ.handoff.servedViaRecency, true);
        assert.match(succ.handoff.note || '', new RegExp(QUEBEC_PURPOSE.slice(0, 20), 'i'), 'the note does not name the purpose the record was filed under');

        // The same question through the other reader. A hint pointing at a URL that resolves
        // differently is its own defect.
        const got = await getHandoff(GOLF_PURPOSE);
        assert.equal(got.from, right.callsign, 'REGRESSION: GET /handoff served the stale exact hit');
        assert.equal(got.notes, 'THE NOTES THE SUCCESSOR NEEDS');
        assert.equal(got.servedKey, handoffKey(hub.REPO, QUEBEC_PURPOSE));
        assert.equal(got.servedViaRecency, true);
        assert.ok(got.auto, 'the auto block is a stated invariant of every handoff record and is missing');

        // ---- ARMS 1 + 3: a RECENT exact hit is kept, and the newer record is NAMED --------------
        const MINE = 'the job whose own checkpoint is recent';
        const THEIRS = 'an unrelated job sharing this repo';
        const mine = await file(MINE, 'MY OWN NOTES, FILED MOMENTS AGO');
        // Strictly newer, deterministically. Two HTTP round trips are usually more than a millisecond
        // apart, and "usually" is where flakes come from -- an equal ts is a legitimate exact-hit win.
        await sleep(50);
        const theirs = await file(THEIRS, 'notes from a different job on the same repo');
        assert.notEqual(mine.callsign, theirs.callsign, 'the rig gave both records the same author, so nothing below distinguishes them');

        const kept = await hub.post('/register', { cwd: hub.REPO, purpose: MINE });
        assert.ok(kept.handoff, 'register offered no handoff for a job that has one');
        assert.equal(kept.handoff.from, mine.callsign,
            'REGRESSION: a RECENT exact hit was displaced by a newer record from another job -- the mirrored bug');
        assert.equal(kept.handoff.servedKey, handoffKey(hub.REPO, MINE));
        assert.equal(kept.handoff.servedViaRecency, undefined);
        // Arm 3, the half bravo cared most about: suppressing the override must never be silent.
        assert.equal(kept.handoff.newerKey, handoffKey(hub.REPO, THEIRS),
            'the window kept my record and said NOTHING about the newer one beside it');
        assert.match(kept.handoff.note || '', new RegExp(THEIRS.slice(0, 20), 'i'), 'the note does not name the newer job');

        const keptGet = await getHandoff(MINE);
        assert.equal(keptGet.from, mine.callsign, 'the two readers disagree about a recent exact hit');
        assert.equal(keptGet.notes, 'MY OWN NOTES, FILED MOMENTS AGO');
        assert.equal(keptGet.newerKey, handoffKey(hub.REPO, THEIRS), 'GET /handoff dropped the suppressed-newer report');
        assert.equal(keptGet.servedViaRecency, undefined);

        // ---- the annotation is written onto a COPY ----------------------------------------------
        // These records are roster state. A field written onto the original would be persisted by the
        // next saveRoster and leak into every later read -- including this one.
        const theirsGet = await getHandoff(THEIRS);
        assert.equal(theirsGet.from, theirs.callsign);
        assert.equal(theirsGet.servedKey, handoffKey(hub.REPO, THEIRS));
        assert.equal(theirsGet.servedViaRecency, undefined, 'the stored record was MUTATED by an annotated read above');
        assert.equal(theirsGet.newerKey, undefined, 'the newest record on the cwd reported something newer than itself');

        // An unknown purpose on a known cwd resolves to the newest rather than 404ing, which is the
        // legacy fallback still doing its original job.
        const unknown = await getHandoff('a purpose nobody ever filed under');
        assert.equal(unknown.from, theirs.callsign);
        assert.equal(unknown.servedViaRecency, true);
    });
