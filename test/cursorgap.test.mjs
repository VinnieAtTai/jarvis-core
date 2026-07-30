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
    A = await hub.post('/register', { cwd: process.cwd(), purpose: 'cursor gap probe' });
    B = await hub.post('/register', { cwd: process.cwd(), purpose: 'cursor gap bystander' });
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
