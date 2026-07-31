// An exact cwd+purpose hit must NOT outrank a newer handoff on the same cwd.
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
// The rule now: recency is a TIE-BREAKER, not a last resort. Newest-on-cwd wins whenever it is
// STRICTLY newer than the exact hit, and the served key travels with the record so a successor can
// SEE which one it got. Both halves are pinned below -- pure, then through the two real read paths,
// because the pure rule being right is what the un-tested boardKey card taught us not to trust on its
// own (see test/boardwriters.test.mjs).
//
// The pure tests run under plain `npm test`. The route half is SKIPPED unless JARVIS_INTEGRATION=1:
//
//     npm run test:handoffrecency
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickHandoff, handoffKey } from '../jarvis-text.mjs';
import { createScratchHub, sleep } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub; ~15 seconds)';

// The live shape at the time of the bug, with the timestamps that produced it.
const CWD = 'D:/Claude';
const GOLF_PURPOSE = 'JARVIS punchlist and the console board-rot fixes';
const QUEBEC_PURPOSE = 'JARVIS punchlist - project coordinator';
const STALE = { from: 'papa', cwd: CWD, purpose: GOLF_PURPOSE, notes: 'a different job, a day old', ts: '2026-07-29T09:00:00.000Z' };
const FRESH = { from: 'quebec', cwd: CWD, purpose: QUEBEC_PURPOSE, notes: 'the notes golf should have been given', ts: '2026-07-30T21:40:00.000Z' };
const STORE = () => ({
    [handoffKey(CWD, GOLF_PURPOSE)]: { ...STALE },
    [handoffKey(CWD, QUEBEC_PURPOSE)]: { ...FRESH },
});

test('pickHandoff -- THE BUG: a stale EXACT hit loses to a newer record on the same cwd', () => {
    const p = pickHandoff(STORE(), CWD, GOLF_PURPOSE);
    assert.equal(p.rec.from, 'quebec', 'served the stale exact hit -- this is the golf failure, verbatim');
    assert.equal(p.servedKey, handoffKey(CWD, QUEBEC_PURPOSE), 'the served key must NAME the record, or the misfire stays invisible');
    assert.equal(p.viaRecency, true);
});

test('pickHandoff -- an exact hit that IS the newest keeps its own key, and is not labelled', () => {
    // The negative control, and the one that stops "always return newest" from passing the test above.
    const p = pickHandoff(STORE(), CWD, QUEBEC_PURPOSE);
    assert.equal(p.rec.from, 'quebec');
    assert.equal(p.servedKey, handoffKey(CWD, QUEBEC_PURPOSE));
    assert.equal(p.viaRecency, false, 'a record served under its own key must not claim it came from another');
});

test('pickHandoff -- STRICTLY newer: an equal timestamp does not displace the exact hit', () => {
    // Whole-second or same-millisecond ties are real (two retires in one pump), and iteration order
    // must not be what decides the answer.
    const s = STORE();
    s[handoffKey(CWD, QUEBEC_PURPOSE)].ts = STALE.ts;
    const p = pickHandoff(s, CWD, GOLF_PURPOSE);
    assert.equal(p.rec.from, 'papa', 'a tie flipped the answer, so key order is deciding whose notes a successor reads');
    assert.equal(p.viaRecency, false);
});

test('pickHandoff -- no exact hit at all still resolves to the newest on the cwd, and says so', () => {
    // The legacy bare GET /handoff?cwd=... path. It used to be the ONLY case recency covered; it stays
    // covered, and now it is labelled too, because a record filed under someone else's purpose is
    // exactly as surprising here as it is above.
    const s = STORE();
    delete s[handoffKey(CWD, GOLF_PURPOSE)];
    const p = pickHandoff(s, CWD, GOLF_PURPOSE);
    assert.equal(p.rec.from, 'quebec');
    assert.equal(p.viaRecency, true);
    // And with no purpose at all, which is how the old-style call arrives.
    assert.equal(pickHandoff(s, CWD, null).rec.from, 'quebec');
    assert.equal(pickHandoff(s, CWD).rec.from, 'quebec');
});

test('pickHandoff -- a cs: stash is never a recency candidate', () => {
    // Those are one-shot records addressed to a callsign and consumed on read. Letting one win here
    // would hand a spawn's private briefing to an unrelated session on the same cwd, and delete it.
    const s = STORE();
    s['cs:tango'] = { from: 'zulu', cwd: CWD, purpose: 'someone else entirely', ts: '2099-01-01T00:00:00.000Z' };
    const p = pickHandoff(s, CWD, GOLF_PURPOSE);
    assert.equal(p.rec.from, 'quebec');
    assert.ok(!p.servedKey.startsWith('cs:'));
});

test('pickHandoff -- another cwd never leaks in, however new it is', () => {
    const s = STORE();
    s[handoffKey('D:/code/tms', 'a TMS job')] = { from: 'zulu', cwd: 'D:/code/tms', purpose: 'a TMS job', ts: '2099-01-01T00:00:00.000Z' };
    assert.equal(pickHandoff(s, CWD, GOLF_PURPOSE).rec.from, 'quebec');
    // Separator and case are not a difference: cwdKey normalizes both, the same as the key itself.
    assert.equal(pickHandoff(s, 'd:\\claude', GOLF_PURPOSE).rec.from, 'quebec');
});

test('pickHandoff -- nothing on this cwd returns null, never an unrelated record', () => {
    assert.equal(pickHandoff(STORE(), 'D:/somewhere/else', 'any job'), null);
    assert.equal(pickHandoff({}, CWD, GOLF_PURPOSE), null);
});

test('pickHandoff -- a broken clock can lose but never win', () => {
    // Ordering on Date.parse means an unparseable ts has to sort SOMEWHERE. -Infinity is the safe end:
    // a record nobody can date must not outrank one that can be dated.
    const undated = { from: 'undated', cwd: CWD, purpose: 'undated job', notes: 'no ts at all' };
    const s = STORE();
    s[handoffKey(CWD, 'undated job')] = undated;
    assert.equal(pickHandoff(s, CWD, GOLF_PURPOSE).rec.from, 'quebec', 'an undated record beat a dated one');
    // ...and asked for BY key it is still served: losing the recency contest is not being unreachable.
    const only = { [handoffKey(CWD, 'undated job')]: undated };
    assert.equal(pickHandoff(only, CWD, 'undated job').rec.from, 'undated');
    assert.equal(pickHandoff(only, CWD, GOLF_PURPOSE).rec.from, 'undated', 'with nothing dated on the cwd, the one record on it is still the answer');
});

test('pickHandoff -- garbage in never throws: this runs on every register', () => {
    // A throw here would take down the register path itself, which is a worse outcome than any wrong
    // record: the session never boots.
    for (const bad of [null, undefined, '', 0, false, 'not-an-object', []]) {
        assert.doesNotThrow(() => pickHandoff(bad, CWD, GOLF_PURPOSE));
        assert.doesNotThrow(() => pickHandoff(STORE(), bad, GOLF_PURPOSE));
    }
    assert.equal(pickHandoff(STORE(), null, GOLF_PURPOSE), null);
    // Half-written rows must be skipped, not crash the scan or become the answer.
    const s = STORE();
    s[handoffKey(CWD, 'junk a')] = null;
    s[handoffKey(CWD, 'junk b')] = 'a string';
    s[handoffKey(CWD, 'junk c')] = { from: 'nocwd', ts: '2099-01-01T00:00:00.000Z' };   // no cwd -> not on any cwd
    assert.equal(pickHandoff(s, CWD, GOLF_PURPOSE).rec.from, 'quebec');
    // An exact slot holding junk is the same as an empty one, and must not shadow a real record.
    const s2 = STORE();
    s2[handoffKey(CWD, GOLF_PURPOSE)] = 'corrupt';
    assert.equal(pickHandoff(s2, CWD, GOLF_PURPOSE).rec.from, 'quebec');
});

test('pickHandoff -- pure: does not mutate the store it reads', () => {
    const s = STORE();
    const before = JSON.stringify(s);
    pickHandoff(s, CWD, GOLF_PURPOSE);
    pickHandoff(s, CWD, QUEBEC_PURPOSE);
    pickHandoff(s, 'D:/nowhere', 'nothing');
    assert.equal(JSON.stringify(s), before);
});

// ---- the two read paths, at a real hub ---------------------------------------------------------
// What the pure tests cannot show: that BOTH readers consult the rule, and that they agree. The
// register hint and GET /handoff resolved the record independently before this, which is how one of
// them could have been fixed and the other left behind -- the shape of the boardKey card exactly.
test('HANDOFF RECENCY: register and GET /handoff both serve the NEWER record, and name its key',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('handoff-recency hub');

        const file = async (purpose, notes) => {
            const r = await hub.post('/register', { cwd: hub.REPO, purpose });
            assert.ok(r.uid, 'register failed: ' + JSON.stringify(r));
            const h = await hub.post('/handoff', { uid: r.uid, summary: 'summary from ' + r.callsign, notes });
            assert.equal(h.ok, true, '/handoff was refused: ' + JSON.stringify(h));
            return r;
        };

        // 1. The WRONG record lands in the successor's slot first -- a different session that happened
        //    to carry the purpose golf would later boot with. This is the whole setup: it has to be
        //    filed BEFORE the real predecessor's, because staleness is the only thing being tested.
        const wrong = await file(GOLF_PURPOSE, 'notes belonging to another job entirely');
        // Strictly newer, deterministically. Two HTTP round trips are usually more than a millisecond
        // apart, and "usually" is where flakes come from -- an equal ts is a legitimate exact-hit win.
        await sleep(50);
        const right = await file(QUEBEC_PURPOSE, 'THE NOTES THE SUCCESSOR NEEDS');

        // 2. The register hint. Pre-fix this handed back `wrong`, and nothing in the response hinted
        //    that a fresher record on the same cwd existed.
        const succ = await hub.post('/register', { cwd: hub.REPO, purpose: GOLF_PURPOSE });
        assert.ok(succ.handoff, 'register offered no handoff at all: ' + JSON.stringify(succ));
        assert.equal(succ.handoff.from, right.callsign,
            'REGRESSION: register served the STALE exact hit (' + succ.handoff.from + ') instead of the newer record from ' + right.callsign);
        assert.equal(succ.handoff.servedKey, handoffKey(hub.REPO, QUEBEC_PURPOSE),
            'the hint does not name the key it came from, so the successor cannot see it got another job\'s notes');
        assert.equal(succ.handoff.servedViaRecency, true);
        assert.match(succ.handoff.note || '', new RegExp(QUEBEC_PURPOSE.slice(0, 20), 'i'), 'the note does not name the purpose the record was filed under');

        // 3. GET /handoff, with the very purpose the hint carries. The two readers must land on the
        //    same record -- a hint pointing at a URL that resolves differently is its own defect.
        const got = await hub.get('/handoff?cwd=' + encodeURIComponent(hub.REPO) + '&purpose=' + encodeURIComponent(GOLF_PURPOSE));
        assert.equal(got.from, right.callsign, 'REGRESSION: GET /handoff served the stale exact hit');
        assert.equal(got.notes, 'THE NOTES THE SUCCESSOR NEEDS');
        assert.equal(got.servedKey, handoffKey(hub.REPO, QUEBEC_PURPOSE));
        assert.equal(got.servedViaRecency, true);
        assert.ok(got.auto, 'the auto block is a stated invariant of every handoff record and is missing');

        // 4. Asked for BY its own purpose, the same record comes back UNLABELLED. Two claims in one:
        //    the exact-hit path still works, and the annotation above was written onto a COPY -- these
        //    records are roster state, and a field written onto the original would be persisted by the
        //    next saveRoster and leak into every later read.
        const direct = await hub.get('/handoff?cwd=' + encodeURIComponent(hub.REPO) + '&purpose=' + encodeURIComponent(QUEBEC_PURPOSE));
        assert.equal(direct.from, right.callsign);
        assert.equal(direct.servedKey, handoffKey(hub.REPO, QUEBEC_PURPOSE));
        assert.equal(direct.servedViaRecency, undefined, 'the stored record was MUTATED by the annotated read above');

        // 5. THE COST, pinned rather than discovered later. Once a newer record exists on a cwd, the
        //    older one is SHADOWED for every reader of this route -- including a session asking for it
        //    by its own exact purpose. That is what "recency outranks the exact hit" means, and it is
        //    a partial walk-back of what handoffKey was built for: one cwd hosting several unrelated
        //    jobs (d:/code/tms is the standing example). The mitigation is servedKey, not avoidance:
        //    the record now says which slot it came out of, so a session handed someone else's notes
        //    can tell. Asserted because a future reader must find this stated, not infer it from a
        //    surprise in production.
        const shadowed = await hub.get('/handoff?cwd=' + encodeURIComponent(hub.REPO) + '&purpose=' + encodeURIComponent(GOLF_PURPOSE));
        assert.equal(shadowed.from, right.callsign, 'expected the newer record to shadow the older exact hit');
        assert.notEqual(wrong.callsign, right.callsign, 'the rig gave both records the same author, so nothing above distinguishes them');
        // An unknown purpose on a known cwd resolves to the newest rather than 404ing, which is the
        // legacy fallback still doing its original job.
        const unknown = await hub.get('/handoff?cwd=' + encodeURIComponent(hub.REPO) + '&purpose=' + encodeURIComponent('a purpose nobody ever filed under'));
        assert.equal(unknown.from, right.callsign);
        assert.equal(unknown.servedViaRecency, true);
    });
