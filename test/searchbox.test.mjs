// Gate-level tests for the CONSOLE SEARCH BOX in console.js: the two pure helpers behind it, plus a
// source-level pin on the one structural claim the feature rests on (see THE REUSE PIN below).
//
// GET /search shipped without a UI and Chris's reaction was "Where's the search?!", so the box is
// the half that matters. Almost all of it is DOM work the test suite cannot reach; these two are the
// pieces that are pure, and both encode a claim that is easy to get quietly wrong:
//
//   searchCountLabel -- the server keeps counting past `limit` and hands back `total` precisely so
//     the UI can say "newest 50 of 347". Rendering 50 rows and captioning them "50" would imply 50
//     was everything there was, which is the one thing a search box must never do.
//   fmtWhen -- the chat's own stamp is fmtHM, time only, which is right when everything on screen
//     is minutes old. A search reaches back months, and there a bare "14:32" reads as TODAY.
//
// console.js is browser script (top-level document.getElementById), so the functions are lifted out
// of the source by name -- same approach as test/richtext.test.mjs and test/nesting.test.mjs, and it
// fails loudly if either is renamed.
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
const searchCountLabel = new Function(lift('searchCountLabel') + '\nreturn searchCountLabel;')();
const searchReachNote = new Function(lift('searchReachNote') + '\nreturn searchReachNote;')();
// fmtWhen delegates the clock part to fmtHM, so both come across.
const fmtWhen = new Function(lift('fmtHM') + '\n' + lift('fmtWhen') + '\nreturn fmtWhen;')();

// Timestamps are built from LOCAL components and handed over as ISO, so fmtWhen parses them back to
// the same wall-clock time whatever zone the test runs in. Writing "2026-06-03T14:32:00Z" literally
// would make these assertions pass only in UTC.
const iso = (y, m, d, h, mi) => new Date(y, m, d, h, mi).toISOString();

// ---------------------------------------------------------------------------------------------
// THE REUSE PIN. Found by tango at merge review, and worth spelling out because the gap was
// invisible: the headline claim about this feature is that search renders hits with the CHAT's own
// bubble markup, so the two cannot drift. tango repointed renderSearch's call at a function that does
// not exist and the ENTIRE GATE STAYED GREEN -- the claim was load-bearing and completely unpinned.
// test-support/verify-searchbox-browser.mjs does cover it, but that needs a system Chrome and sits
// outside test/ on purpose, so it is not the gate. These four assertions put the claim in the gate.
//
// Structural assertions over source text are usually a smell. Here the thing being protected IS
// structure, and there is no runtime hook for it: console.js cannot be imported, only lifted from.
const RENDER_SEARCH = lift('renderSearch');
const RENDER_CHAT = lift('renderChat');
const CHAT_BUBBLE = lift('chatBubble');   // lift() asserts, so a renamed DEFINITION fails right here

test('reuse -- the search view builds its hits with chatBubble, not markup of its own', () => {
    assert.match(RENDER_SEARCH, /\bchatBubble\s*\(/,
        'renderSearch must call chatBubble -- if that call is renamed or repointed, search and chat drift apart silently');
});

test('reuse -- the live chat goes through the SAME builder, so there is only one to maintain', () => {
    assert.match(RENDER_CHAT, /\bchatBubble\s*\(/,
        'renderChat must call chatBubble too; re-inlining the markup here is exactly what drift looks like');
});

test('reuse -- chatBubble is the one place bubble markup lives', () => {
    assert.match(CHAT_BUBBLE, /class="bubble/, 'chatBubble is meant to own the bubble markup');
    assert.match(CHAT_BUBBLE, /class="row /, 'and the row wrapper with it');
});

test('reuse -- neither caller hand-rolls a bubble of its own', () => {
    for (const [name, body] of [['renderSearch', RENDER_SEARCH], ['renderChat', RENDER_CHAT]]) {
        assert.doesNotMatch(body, /class="bubble/, name + ' must not build bubble markup itself -- that is the drift this pins');
        assert.doesNotMatch(body, /class="row /, name + ' must not build the row wrapper itself either');
    }
});

test('searchCountLabel -- an untruncated result set states its own size', () => {
    assert.equal(searchCountLabel(2, 2, false), '2 matches');
    assert.equal(searchCountLabel(12, 12, false), '12 matches');
});

test('searchCountLabel -- singular reads as English, not "1 matches"', () => {
    assert.equal(searchCountLabel(1, 1, false), '1 match');
});

test('searchCountLabel -- THE POINT: a truncated set never implies it was everything', () => {
    // 50 rows on screen, 347 in the transcript. The label must surface BOTH numbers.
    const label = searchCountLabel(50, 347, true);
    assert.equal(label, 'newest 50 of 347');
    assert.match(label, /347/, 'the true total must be visible, or 50 reads as all there is');
});

test('searchCountLabel -- zero matches says so instead of "0 matches"', () => {
    assert.equal(searchCountLabel(0, 0, false), 'no matches');
});

// searchReachNote covers the same honesty rule one level deeper. GET /search scans the transcript
// archive under a byte bound (foxtrot's change), so archive.capped means `total` is a FLOOR, not a
// total -- there is history the server never opened. Silence there would have the box report "23
// matches" over a corpus it only partly read, which is exactly what the endpoint refuses to do when it
// 400s a blank q.
test('searchReachNote -- an uncapped scan says nothing at all', () => {
    assert.equal(searchReachNote(false, '2025-06-03T08:15:00.000Z'), '');
    assert.equal(searchReachNote(undefined, undefined), '', 'a hub with no archive block is silent, not alarming');
});

test('searchReachNote -- THE POINT: a capped scan admits there may be more, and says where it stopped', () => {
    const note = searchReachNote(true, '2025-06-03T08:15:00.000Z');
    assert.match(note, /not searched/, 'it must say the history was not searched');
    assert.match(note, /2025-06-03/, 'and name the boundary, or "partial reach" is unactionable');
    assert.match(note, /more matches/, 'and warn that the count is a floor');
});

test('searchReachNote -- capped with an unusable boundary still warns, minus the date', () => {
    for (const bad of [null, undefined, '', 'garbage', 12345, {}, '2025-6-3']) {
        const note = searchReachNote(true, bad);
        assert.match(note, /not searched/, 'still warns for boundary ' + JSON.stringify(bad));
        // "contains no well-formed date" is TOO WEAK -- it lets through "stopped at ." and "stopped at
        // 12345". A probe removing the shape guard survived that version. The real claim is that an
        // untrustworthy boundary takes the DATELESS wording, so pin that branch directly.
        assert.doesNotMatch(note, /stopped at/, 'must not quote a boundary it cannot trust: ' + JSON.stringify(bad));
        assert.doesNotMatch(note, /\d{4}-\d{2}-\d{2}/, 'and invents no date for ' + JSON.stringify(bad));
    }
});

test('fmtWhen -- a hit from today is just the time, exactly as the chat shows it', () => {
    const now = iso(2026, 6, 29, 18, 5);          // Jul 29 2026
    assert.equal(fmtWhen(iso(2026, 6, 29, 14, 32), now), '14:32');
    assert.equal(fmtWhen(iso(2026, 6, 29, 9, 7), now), '09:07', 'zero-padded, same as fmtHM');
});

test('fmtWhen -- THE POINT: an older hit is dated, so it cannot be misread as today', () => {
    const now = iso(2026, 6, 29, 18, 5);
    // Same month, yesterday -- still not today, so it must carry a date.
    assert.equal(fmtWhen(iso(2026, 6, 28, 14, 32), now), 'Jul 28 14:32');
    assert.equal(fmtWhen(iso(2026, 5, 3, 14, 32), now), 'Jun 3 14:32');
});

test('fmtWhen -- a hit from another year carries the year too', () => {
    const now = iso(2026, 6, 29, 18, 5);
    assert.equal(fmtWhen(iso(2025, 5, 3, 14, 32), now), 'Jun 3 2025 14:32');
    // Same month and day, different year: the year is the ONLY thing distinguishing these two.
    assert.notEqual(fmtWhen(iso(2025, 6, 29, 14, 32), now), fmtWhen(iso(2026, 6, 29, 14, 32), now));
});

test('fmtWhen -- a missing or unparseable ts renders empty, never "NaN:NaN"', () => {
    assert.equal(fmtWhen('', iso(2026, 6, 29, 18, 5)), '');
    assert.equal(fmtWhen(null, iso(2026, 6, 29, 18, 5)), '');
    assert.equal(fmtWhen('not a date', iso(2026, 6, 29, 18, 5)), '');
});
