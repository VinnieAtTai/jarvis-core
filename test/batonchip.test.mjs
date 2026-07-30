// Unit tests for the MERGE LANE chips -- batonRole + batonLabel + batonQueue + batonTip in console.js.
//
// The gap they close: the commit baton shipped, was gated, and was DEPLOYED, and `grep -c baton
// console.js` returned 0. Chris could not see the lane at all. The state that matters is the state where
// two sessions are both "committed and ready": one is cleared to merge and the other is queued behind
// it, and until these functions existed the console rendered those two identically.
//
// console.js is browser script, so the pure functions are lifted out of the source by name -- same
// approach as test/coordchip.test.mjs and test/nesting.test.mjs, and it fails loudly if any is renamed.
// What the gate CANNOT see (that a chip reaches the DOM, that a PROJECT card gets one, that the tooltip
// is escaped, that the 1.5s poll does not blow it away) is covered in real headless Chrome by
// test-support/verify-batonchip-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../console.js', import.meta.url), 'utf8');
function lift(name) {
    const start = src.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, 'console.js no longer defines ' + name + ' -- update this test');
    let i = src.indexOf('{', start), depth = 0;
    for (let n = i; n < src.length; n++) {
        if (src[n] === '{') depth++;
        else if (src[n] === '}' && --depth === 0) return src.slice(start, n + 1);
    }
    throw new Error('unbalanced braces reading ' + name);
}
// batonLabel/batonQueue/batonTip all call batonRole, so they are lifted into ONE scope together rather
// than four isolated ones -- lifting them separately would leave each calling an undefined batonRole and
// throw at the first assertion.
const B = new Function(
    lift('batonRole') + lift('batonLabel') + lift('batonQueue') + lift('batonTip')
    + '\nreturn { batonRole, batonLabel, batonQueue, batonTip };')();
const { batonRole, batonLabel, batonQueue, batonTip } = B;

// The live shapes, exactly as GET /board emits them -- jarvis-core.mjs `batonFor` (2990-3000), read off
// the source rather than invented: a holder carries queue[] + takenAt, a queued card carries position +
// the holder's name, and everyone else carries null.
const TAKEN = '2026-07-30T00:11:00.000Z';
const HOLDER = { callsign: 'romeo', uid: 's_0416', baton: { repo: 'jarvis', base: 'main', holding: true, takenAt: TAKEN, waiting: 2, queue: ['kilo', 'golf'] } };
const HOLDER_CLEAR = { callsign: 'romeo', uid: 's_0416', baton: { repo: 'jarvis', base: 'main', holding: true, takenAt: TAKEN, waiting: 0, queue: [] } };
const WAITER = { callsign: 'kilo', uid: 's_0417', baton: { repo: 'jarvis', base: 'main', holding: false, position: 2, waiting: 3, holder: 'charlie' } };
const IDLE = { callsign: 'delta', uid: 's_0418', baton: null };
// THE CASE A NAIVE CHIP GETS WRONG. `batonFor` is keyed on the CARD's uid, and a PROJECT card's uid is
// whichever session is bound to it -- so when the coordinator takes the lane, the lane renders on the
// jarvis project card (worker: 'charlie'), not on a card called 'charlie'. There IS no charlie card.
const PROJECT_HOLDER = {
    callsign: 'jarvis', uid: 's_0411', worker: 'charlie',
    projectContext: { name: 'jarvis', title: 'JARVIS core', missionId: null },
    baton: { repo: 'jarvis', base: 'main', holding: true, takenAt: TAKEN, waiting: 1, queue: ['romeo'] },
};

test('batonRole -- the three states the console has to tell apart', () => {
    assert.equal(batonRole(HOLDER), 'holder');
    assert.equal(batonRole(WAITER), 'waiter');
    assert.equal(batonRole(IDLE), null, 'no lane must render NOTHING, not a third chip');
});

test('batonRole -- A PROJECT CARD IS A FIRST-CLASS HOLDER (the coordinator case)', () => {
    // The bug this pins: a chip that assumed a plain NATO session card would go blank at exactly the
    // moment the MANAGER holds the lane -- the single most common holder there is, since the manager is
    // the one who lands every sub-worker's branch. It renders on the project card by design.
    assert.equal(batonRole(PROJECT_HOLDER), 'holder');
    assert.equal(batonLabel(PROJECT_HOLDER), 'LANE');
    assert.deepEqual(batonQueue(PROJECT_HOLDER), ['ROMEO']);
    assert.match(batonTip(PROJECT_HOLDER), /^HOLDS THE MERGE LANE for jarvis, base main/);
});

test('batonRole -- role comes from `baton` ALONE, never from what kind of card this is', () => {
    // Stated as an invariant rather than a single example, because the project-card case above is only
    // the first way this can go wrong. Every card flavour on the board -- plain worker, sub-worker,
    // project card, focused, dead -- must read identically for the same lane state.
    const flavours = [
        { callsign: 'romeo' },
        { callsign: 'romeo', parentProject: 'jarvis' },
        { callsign: 'jarvis', worker: 'charlie', projectContext: { missionId: 'm_1' } },
        { callsign: 'primeng', worker: null, projectContext: { missionId: null }, alive: false },
    ];
    for (const f of flavours) {
        assert.equal(batonRole({ ...f, baton: HOLDER.baton }), 'holder', JSON.stringify(f));
        assert.equal(batonRole({ ...f, baton: WAITER.baton }), 'waiter', JSON.stringify(f));
        assert.equal(batonRole({ ...f, baton: null }), null, JSON.stringify(f));
    }
});

test('batonRole -- a queue entry with no usable position is NOT a waiter', () => {
    // Both the label and the tooltip quote the position, so a positionless queue row would render
    // "LANE #undefined" on Chris's board. Rendering nothing is the honest failure.
    for (const bad of [undefined, null, 0, -1, 'x', NaN]) {
        assert.equal(batonRole({ callsign: 'k', baton: { repo: 'jarvis', holding: false, position: bad } }), null, String(bad));
    }
    assert.equal(batonRole({ callsign: 'k', baton: { repo: 'jarvis', holding: false, position: 1 } }), 'waiter');
});

test('batonRole -- holding WINS, so a malformed row can never be both', () => {
    // The lane's own invariant is that a uid appears at most once across holder+queue. If a
    // hand-edited batons.json ever breaks it, the card must claim ONE state, and 'cleared to merge' is
    // the one with consequences.
    assert.equal(batonRole({ callsign: 'r', baton: { holding: true, position: 3 } }), 'holder');
});

test('batonLabel -- short face for the holder, position for a waiter, nothing for nobody', () => {
    assert.equal(batonLabel(HOLDER), 'LANE');
    assert.equal(batonLabel(WAITER), 'LANE #2');
    assert.equal(batonLabel(IDLE), '');
});

test('batonQueue -- the waiting strip: FIFO order, upper-cased, holder-only', () => {
    assert.deepEqual(batonQueue(HOLDER), ['KILO', 'GOLF'], 'service order is the whole point -- never sorted');
    assert.deepEqual(batonQueue(HOLDER_CLEAR), [], 'a clear lane has no strip');
    assert.deepEqual(batonQueue(WAITER), [], 'a waiter knows its position, not the queue behind it');
    assert.deepEqual(batonQueue(IDLE), []);
});

test('batonQueue -- junk entries are dropped, not rendered as blanks', () => {
    // A queue entry loses its callsign when a lane row is written without one; the server falls back to
    // the uid, but an empty string would render as a bare comma in the strip.
    const b = { baton: { holding: true, queue: ['kilo', null, '', '   ', undefined, 's_0499'] } };
    assert.deepEqual(batonQueue(b), ['KILO', 'S_0499']);
    assert.deepEqual(batonQueue({ baton: { holding: true, queue: 'not-an-array' } }), []);
});

test('batonTip -- the holder tooltip names the repo, the base, and who is blocked', () => {
    const tip = batonTip(HOLDER);
    assert.match(tip, /^HOLDS THE MERGE LANE for jarvis, base main/, tip);
    assert.match(tip, /only session cleared to merge/, tip);
    assert.match(tip, /2 waiting behind it: KILO, GOLF/, tip);
});

test('batonTip -- a clear lane says so, rather than trailing off', () => {
    assert.match(batonTip(HOLDER_CLEAR), /Nobody is waiting\.$/, batonTip(HOLDER_CLEAR));
    // Singular, because "1 waiting behind it" reads as a count and "1 waiting" of one worker is the
    // most common queue there is.
    assert.match(batonTip({ baton: { repo: 'jarvis', holding: true, queue: ['kilo'] } }), /1 waiting behind it: KILO$/);
});

test('batonTip -- the waiter tooltip says where it stands and who it is waiting on', () => {
    const tip = batonTip(WAITER);
    assert.match(tip, /^WAITING for the jarvis merge lane, base main/, tip);
    assert.match(tip, /position 2 of 3/, tip);
    assert.match(tip, /CHARLIE holds it\.$/, 'the whole reason he asks is WHO: ' + tip);
});

test('batonTip -- a queue with NO holder reads as mid-reap, not as a deadlock', () => {
    // This state is real and transient: the holder died and the 5-minute sweep has not run yet. Saying
    // it should grant on the next sweep is what stops Chris breaking something that is about to fix
    // itself -- and a stuck lane is the failure the whole baton design worried about.
    const tip = batonTip({ baton: { repo: 'jarvis', holding: false, position: 1, waiting: 1, holder: null } });
    assert.match(tip, /No holder recorded, so the lane should grant on the next sweep\.$/, tip);
});

test('batonTip -- degrades one field at a time instead of printing undefined', () => {
    const noRepo = batonTip({ baton: { holding: true, queue: [] } });
    assert.match(noRepo, /for this repo -- /, noRepo);
    assert.equal(/undefined|null|NaN/.test(noRepo), false, noRepo);
    const noBase = batonTip({ baton: { repo: 'jarvis', holding: false, position: 1, holder: 'charlie' } });
    assert.equal(noBase.includes('base'), false, 'no base stamped yet -> the clause vanishes: ' + noBase);
    assert.equal(noBase.includes(' of '), false, 'no queue length -> no "of N" either: ' + noBase);
    assert.match(noBase, /position 1\. CHARLIE holds it\./, noBase);
});

test('every helper -- garbage in, empty out, never a throw (they run inside a render loop)', () => {
    // renderBoards and renderMissions both call these on every 1.5s poll. A throw here does not break a
    // chip, it takes the whole board render down and stops the poll chain -- the one failure mode that
    // breaks everything else on Chris's screen.
    for (const bad of [null, undefined, {}, { baton: undefined }, { baton: 'lane' }, { baton: 42 }, { baton: [] }, { baton: {} }]) {
        assert.equal(batonRole(bad), null, JSON.stringify(bad));
        assert.equal(batonLabel(bad), '', JSON.stringify(bad));
        assert.deepEqual(batonQueue(bad), [], JSON.stringify(bad));
        assert.equal(batonTip(bad), '', JSON.stringify(bad));
    }
});

test('batonTip -- does NOT escape: the caller does, and the browser test proves it', () => {
    // Same division of labour coordTip pins. A repo key comes from repos.json and a queue entry's name
    // comes from a worker's own /baton body, so both are operator-supplied text landing in a title=""
    // attribute -- escAttr at the call site is the guard. If someone "helpfully" makes batonTip escape
    // too, the attribute double-escapes and Chris reads &quot; in his tooltip.
    const tip = batonTip({ baton: { repo: 'a "quoted" <repo>', holding: true, queue: ['<img>'] } });
    assert.match(tip, /a "quoted" <repo>/, tip);
    assert.match(tip, /<IMG>/, tip);
});
