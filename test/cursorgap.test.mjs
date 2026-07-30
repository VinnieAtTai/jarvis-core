// The poll cursor gap: a skipped message must not stay unreachable, and the hub must not be the one
// doing the skipping.
//
// THE INCIDENT. A coordinator relaunched its poll loop at cursor 6390 having last been RETURNED 6388.
// Index 6389 -- a delegate's entire board audit -- went behind its cursor, and /poll will never hand
// back an index it has already passed. It then searched chat, found nothing, and told the delegate its
// send had failed. Both ends read healthy the whole time. send.test.mjs pins the RECOVERY half (the
// receipt that names an index). This file pins the DETECTION half, and one thing detection alone
// cannot fix.
//
// WHAT DETECTION CANNOT FIX, and it is why this file is not only about cursorGap. The detector's whole
// baseline is "the cursor the hub last handed you", so it is structurally blind to a cursor the HUB
// got wrong. /poll's idle timeout used to answer with the bus HEAD while delivering no events, and
// human speech is bused with a 4s debounce -- so an event addressed to that very waiter can sit at the
// head un-released when the hold expires. The worker then advanced past the human's own words, on the
// hub's instruction, with nothing anywhere able to notice. THE TIMEOUT NOW ANSWERS WITH THE WAITER'S
// OWN CURSOR, and 'the human's words survive an idle timeout' below is that fix. It fails against the
// old one-line version, which is the only reason to believe it checks anything.
//
// WHY THE FALSE-ALARM TESTS OUTNUMBER THE DETECTION ONES. A detector that cries skip at a worker that
// skipped nothing is worse than the silence it replaces: the worker chases a message nobody lost and
// its manager acts on the phantom. The baseline is stamped at FOUR exits (the immediate return, the
// idle timeout, releaseWaiters outside the handler, and the shutdown flush) and going stale LOW at any
// one of them reads exactly like a jump. Three of those four are exercised here through the wire.
//
// The unit tests run always. The HTTP tests boot a real hub and are SKIPPED by default:
//
//     npm run test:cursorgap
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cursorGap } from '../jarvis-text.mjs';
import { createScratchHub, sleep } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub; a few seconds)';

// --- the pure detector ------------------------------------------------------------------------

test('cursorGap -- relaunching with the cursor you were given is the healthy case, and says nothing', () => {
    assert.equal(cursorGap(6388, 6388), null);
});

test('cursorGap -- THE INCIDENT: the off-by-two jump is caught, and names the window', () => {
    assert.deepEqual(cursorGap(6388, 6390), { from: 6388, to: 6390 });
});

test('cursorGap -- one index skipped is still a skip (off-by-one is the likely typo)', () => {
    assert.deepEqual(cursorGap(6388, 6389), { from: 6388, to: 6389 });
});

test('cursorGap -- re-reading an OLDER index is the documented recovery, never an alarm', () => {
    // GET /poll?cursor=<missed> is exactly how a worker recovers a skipped event. If that tripped the
    // detector, following the advice in the notice would produce another notice.
    assert.equal(cursorGap(6390, 6389), null);
    assert.equal(cursorGap(6390, 0), null);
});

test('cursorGap -- NO BASELINE means silence, which is what makes a hub restart safe', () => {
    // The baseline lives in memory and dies with the process, so every worker that rides out a restart
    // arrives with none. Inventing one here would false-alarm the entire fleet on every deploy.
    for (const none of [undefined, null, NaN, '6388', Infinity, -Infinity, {}]) {
        assert.equal(cursorGap(none, 6390), null, 'baseline ' + String(none) + ' must not alarm');
    }
});

test('cursorGap -- a junk cursor cannot alarm and cannot throw', () => {
    for (const bad of [undefined, null, NaN, 'abc', Infinity, {}]) {
        assert.equal(cursorGap(6388, bad), null, 'cursor ' + String(bad) + ' must not alarm');
    }
});

test('cursorGap -- zero is a real baseline, not a missing one', () => {
    // A worker's first poll is at 0, so 0 must behave as a number rather than falsy-as-absent.
    assert.deepEqual(cursorGap(0, 2), { from: 0, to: 2 });
    assert.equal(cursorGap(0, 0), null);
});

// --- the wire --------------------------------------------------------------------------------

let hub = null;
let A = null;   // the session under test
let B = null;   // a bystander, so "addressed to someone else" has an owner

const poll = (uid, cursor) => hub.get('/poll?uid=' + uid + '&cursor=' + cursor);
const gapsIn = (r) => (r.events || []).filter(e => e.kind === 'gap');

before(async () => {
    if (SKIP) return;
    // A short hold makes the idle-timeout exit testable in a second rather than 25, and a debounce
    // LONGER than the hold is what pins the speech race deterministically instead of 16% of the time.
    hub = await createScratchHub({ env: { JARVIS_POLL_HOLD_MS: '700', JARVIS_SPEECH_DEBOUNCE: '4000' } });
    await hub.start('cursorgap hub');
    A = await hub.post('/register', { cwd: hub.REPO, purpose: 'cursor gap probe' });
    B = await hub.post('/register', { cwd: hub.REPO, purpose: 'cursor gap bystander' });
    assert.ok(A && A.uid && B && B.uid, 'both probe sessions must register: ' + JSON.stringify([A, B]));
});
after(() => { if (hub) hub.dispose(); });

test('GAP: a message jumped over is reported, and the notice names an index that really has it',
    { skip: SKIP }, async () => {
    const base = await poll(A.uid, 0);                      // baseline: the cursor the hub handed us
    const r = await hub.post('/send', { from: B.uid, to: A.callsign, text: 'wsk jumped payload' });
    assert.equal(r.cursor, base.cursor, 'the send should land exactly at the cursor A was just given');

    const jumped = await poll(A.uid, r.cursor + 1);         // the 6390-for-6388 mistake, in miniature
    const [gap] = gapsIn(jumped);
    assert.ok(gap, 'no gap event on a cursor that skipped a message: ' + JSON.stringify(jumped));
    assert.match(gap.text, new RegExp('GET /poll\\?cursor=' + r.cursor + '\\b'),
        'the notice must name the recoverable index, not just say something was lost: ' + gap.text);

    // The notice is only worth anything if the index it names actually produces the message. Follow
    // its own advice and check.
    const recovered = await poll(A.uid, r.cursor);
    assert.ok((recovered.events || []).some(e => e.text === 'wsk jumped payload'),
        'the index the notice pointed at did not return the skipped message: ' + JSON.stringify(recovered));
});

test('GAP: the notice arrives as an EVENT, because the documented poll loop sees nothing else',
    { skip: SKIP }, async () => {
    // WORKER.md's wrapper loop re-polls on `"events":[]` and exits only on a non-empty array. A gap
    // reported as a side field on the response would be swallowed by every worker running it -- the
    // silence this whole file is about, reintroduced one layer up.
    const base = await poll(A.uid, 0);
    const r = await hub.post('/send', { from: B.uid, to: A.callsign, text: 'wsk must be an event' });
    const jumped = await poll(A.uid, r.cursor + 1);
    assert.ok(jumped.events.length > 0, 'a detected gap must make events non-empty: ' + JSON.stringify(jumped));
    assert.equal(jumped.events[0].kind, 'gap', 'the notice should lead the batch: ' + JSON.stringify(jumped.events));
    assert.ok(base.cursor <= r.cursor, 'sanity: the send landed at or after the baseline');
});

test('GAP: skipping over OTHER sessions traffic is silent -- the bus is shared', { skip: SKIP }, async () => {
    // An absolute-index gap on its own is meaningless. If this alarmed, every worker would be told it
    // had lost something every time anyone else got a message, and the real notice would be noise.
    const base = await poll(A.uid, 0);
    const r = await hub.post('/send', { from: A.uid, to: B.callsign, text: 'wsk not for A' });
    assert.ok(r.cursor >= base.cursor, 'sanity: the bystander message landed at or after A baseline');

    const jumped = await poll(A.uid, r.cursor + 1);
    assert.deepEqual(gapsIn(jumped), [], 'A was told it skipped something that was never addressed to it');
    // Control: the same jump over A's OWN traffic does alarm, so the silence above is the filter
    // working and not the detector being switched off.
    const mine = await hub.post('/send', { from: B.uid, to: A.callsign, text: 'wsk is for A' });
    assert.equal(gapsIn(await poll(A.uid, mine.cursor + 1)).length, 1,
        'the control jump must alarm, or the test above proves nothing');
});

test('GAP: no false alarm when the cursor came from the IMMEDIATE return', { skip: SKIP }, async () => {
    const r = await hub.post('/send', { from: B.uid, to: A.callsign, text: 'wsk immediate' });
    const got = await poll(A.uid, r.cursor);                // returns at once, events waiting
    assert.ok(got.events.some(e => e.text === 'wsk immediate'), 'setup: the message should arrive here');
    assert.deepEqual(gapsIn(await poll(A.uid, got.cursor)), [],
        'relaunching with the cursor the immediate return printed must be silent');
});

test('GAP: no false alarm when the cursor came from releaseWaiters, OUTSIDE the handler',
    { skip: SKIP }, async () => {
    // The exit the original design nearly missed: this response is written by releaseWaiters, not by
    // the /poll handler, so a baseline stamped only inside the handler goes stale low right here.
    const base = await poll(A.uid, 0);
    const waiting = poll(A.uid, base.cursor);               // parks as a waiter
    await sleep(120);
    await hub.post('/send', { from: B.uid, to: A.callsign, text: 'wsk released' });
    const got = await waiting;
    assert.ok(got.events.some(e => e.text === 'wsk released'), 'setup: releaseWaiters should have answered');
    assert.deepEqual(gapsIn(await poll(A.uid, got.cursor)), [],
        'relaunching with the cursor releaseWaiters printed must be silent');
});

test('GAP: no false alarm when the cursor came from the IDLE TIMEOUT', { skip: SKIP }, async () => {
    const base = await poll(A.uid, 0);
    const timedOut = await poll(A.uid, base.cursor);        // parks, then the hold expires
    assert.deepEqual(timedOut.events, [], 'setup: an idle timeout returns no events');
    assert.deepEqual(gapsIn(await poll(A.uid, timedOut.cursor)), [],
        'relaunching with the cursor the timeout printed must be silent');
});

test('GAP: the human words survive an idle timeout -- the hub must not hand out a cursor past them',
    { skip: SKIP }, async () => {
    // THE RACE, made deterministic: speech is bused with a 4s debounce and the hold is 700ms, so the
    // waiter's timeout ALWAYS fires while the speech sits at the head un-released. Answering with the
    // bus head here tells the worker to step over the human's own words -- and because the hub itself
    // issued that cursor, the gap detector's baseline matches and nothing can ever report it.
    const base = await poll(A.uid, 0);
    const waiting = poll(A.uid, base.cursor);
    await sleep(120);
    await hub.post('/hear', { text: 'on ' + A.callsign + ', wsk do not lose this sentence', typed: true });
    const timedOut = await waiting;
    assert.deepEqual(timedOut.events, [], 'setup: the debounce must outlast the hold, so nothing is released');

    // Whatever cursor we were handed, polling with it must still produce the speech.
    const next = await poll(A.uid, timedOut.cursor);
    assert.ok((next.events || []).some(e => e.kind === 'speech' && /do not lose this sentence/.test(e.text)),
        'the timeout handed out a cursor PAST the human speech, which is now unreachable: '
        + JSON.stringify({ base: base.cursor, timedOut: timedOut.cursor, next }));
});

test('GAP: the SHUTDOWN flush keeps each waiter at its own cursor, so a restart cannot skip it',
    { skip: SKIP, timeout: 120000 }, async (t) => {
    // The fourth exit, and the one the design brief did not count. It answers every parked waiter on
    // the way down, delivering nothing -- so handing back the bus head here is the same fault as the
    // idle timeout, and WORSE: the worker rides the restart out and comes back with whatever we said,
    // and the in-memory baseline that would have caught it died with the process.
    //
    // Its own hub, because the subject is the hub STOPPING. A long hold so the waiter cannot time out
    // first and answer through the exit next door.
    const sHub = await createScratchHub({ env: { JARVIS_POLL_HOLD_MS: '25000' } });
    t.after(() => sHub.dispose());
    await sHub.start('shutdown hub');
    const W = await sHub.post('/register', { cwd: sHub.REPO, purpose: 'shutdown waiter' });
    const O = await sHub.post('/register', { cwd: sHub.REPO, purpose: 'shutdown bystander' });
    assert.ok(W && W.uid && O && O.uid, 'both sessions must register: ' + JSON.stringify([W, O]));

    // Park at 0 so the expected answer is a single unambiguous number, then move the head with
    // traffic for someone ELSE -- W stays parked (releaseWaiters only answers waiters with events),
    // so head and W's cursor are provably different when the flush runs.
    const parked = sHub.get('/poll?uid=' + W.uid + '&cursor=0');
    await sleep(200);
    const r = await sHub.post('/send', { from: W.uid, to: O.callsign, text: 'wsk advance the head' });
    assert.equal(typeof r.cursor, 'number', 'setup: the bystander send must land on the bus: ' + JSON.stringify(r));

    writeFileSync(join(sHub.DATA, 'commands.txt'), 'stop\n');   // the graceful path, not a tree-kill
    const flushed = await parked;
    assert.deepEqual(flushed.events, [], 'the shutdown flush delivers nothing, by definition');
    assert.equal(flushed.cursor, 0,
        'the flush handed out the bus head instead of the waiter own cursor, so this worker would come '
        + 'back from the restart past an event it was never given: ' + JSON.stringify(flushed));
});

// --- the trimmed window ------------------------------------------------------------------------
//
// busBase is what keeps a cursor absolute across a trim, and trimBus REWRITES bus.jsonl to only the
// retained events -- so indices below busBase are gone from disk too. They cannot be counted and must
// not be offered as recoverable. Reaching that state honestly needs 5000+ events; the hub reads
// busBase from DATA/bus.base at boot, so seeding it is the identical state for a hundredth of the cost.
//
// Getting a BASELINE below busBase is the part worth noticing: every other exit stamps the bus head,
// so the idle timeout -- which now hands back the waiter's own cursor -- is the only way a session's
// baseline can sit below the retained window. That is also exactly how a real worker gets there.
const TRIM_BASE = 1000;
let tHub = null;
const pollT = (uid, cursor) => tHub.get('/poll?uid=' + uid + '&cursor=' + cursor);
const newT = (purpose) => tHub.post('/register', { cwd: tHub.REPO, purpose });

before(async () => {
    if (SKIP) return;
    tHub = await createScratchHub({ env: { JARVIS_POLL_HOLD_MS: '700' } });
    writeFileSync(join(tHub.DATA, 'bus.base'), String(TRIM_BASE));
    // Addressed to a uid no session will ever be assigned, so these seeds can never release a waiter
    // or be counted as somebody's lost traffic.
    writeFileSync(join(tHub.DATA, 'bus.jsonl'), [0, 1, 2].map(i => JSON.stringify({
        from: 'jarvis', to: 's_nobody', kind: 'msg', text: 'seed ' + i, ts: '2026-07-30T00:00:00.000Z',
    })).join('\n') + '\n');
    await tHub.start('trimmed-bus hub');
});
after(() => { if (tHub) tHub.dispose(); });

test('GAP: a window already TRIMMED away is still reported, and offers no index to re-read',
    { skip: SKIP }, async () => {
    const S = await newT('trimmed window probe');
    const parked = await pollT(S.uid, TRIM_BASE - 10);
    assert.equal(parked.cursor, TRIM_BASE - 10,
        'setup: the idle timeout must hand back our own cursor, or there is no sub-busBase baseline');

    const jumped = await pollT(S.uid, TRIM_BASE - 5);
    const [gap] = gapsIn(jumped);
    // Nothing addressed to S is countable here -- the whole window is below busBase -- so a detector
    // that only asks "was any of MY traffic in it" goes silent on the one case where the loss is
    // permanent. Staying quiet would be the worst possible place to stay quiet.
    assert.ok(gap, 'a gap entirely below busBase was not reported at all: ' + JSON.stringify(jumped));
    assert.match(gap.text, /gone for good/, 'the notice must say the indices are unrecoverable: ' + gap.text);
    assert.doesNotMatch(gap.text, /GET \/poll\?cursor=/,
        'nothing in this window is fetchable, so naming an index to re-read would be a lie: ' + gap.text);
});

test('GAP: `gone` counts the indices actually in the window, not the distance to busBase',
    { skip: SKIP }, async () => {
    // The clamp, min(gap.to, busBase). Only a window ENDING below busBase can catch a missing one:
    // when the window straddles the boundary both spellings agree, which is why the straddle test
    // below cannot substitute for this one.
    const S = await newT('trim clamp probe');
    const parked = await pollT(S.uid, TRIM_BASE - 10);            // baseline 990
    assert.equal(parked.cursor, TRIM_BASE - 10, 'setup: baseline must be below busBase');
    const jumped = await pollT(S.uid, TRIM_BASE - 5);             // window 990..995 -- FIVE indices
    const [gap] = gapsIn(jumped);
    assert.ok(gap, 'setup: the jump must be reported: ' + JSON.stringify(jumped));
    assert.match(gap.text, new RegExp('\\b5 index\\(es\\) from ' + (TRIM_BASE - 10) + '\\b'),
        'gone was measured to busBase (10) instead of to the end of the window (5): ' + gap.text);
});

test('GAP: a window straddling the trim boundary reports BOTH halves -- what is lost and what is not',
    { skip: SKIP }, async () => {
    // The realistic shape: a worker skips over the boundary, so part of what it missed is still on the
    // bus and part is not. Both clauses have to appear, or the notice tells half the truth.
    const S = await newT('straddle probe');
    const P = await newT('straddle sender');
    const parked = await pollT(S.uid, TRIM_BASE - 5);             // baseline 995
    assert.equal(parked.cursor, TRIM_BASE - 5, 'setup: baseline must be below busBase');

    const r = await tHub.post('/send', { from: P.uid, to: S.callsign, text: 'wsk straddle payload' });
    assert.ok(r.cursor >= TRIM_BASE, 'setup: the send must land in the RETAINED part of the bus: ' + JSON.stringify(r));

    const jumped = await pollT(S.uid, r.cursor + 1);              // window 995 .. past the message
    const [gap] = gapsIn(jumped);
    assert.ok(gap, 'the straddling jump was not reported: ' + JSON.stringify(jumped));
    assert.match(gap.text, new RegExp('GET /poll\\?cursor=' + (TRIM_BASE - 5) + '\\b'),
        'the recoverable half must still name an index: ' + gap.text);
    assert.match(gap.text, new RegExp('\\b5 index\\(es\\) from ' + (TRIM_BASE - 5) + '\\b'),
        'the trimmed half must still be counted: ' + gap.text);
    // And the index it names really does produce the message, trimmed prefix or not.
    const recovered = await pollT(S.uid, TRIM_BASE - 5);
    assert.ok((recovered.events || []).some(e => e.text === 'wsk straddle payload'),
        'the index the notice named did not return the message: ' + JSON.stringify(recovered));
});
