// Unit tests for the two pure helpers behind the CONSOLE SEARCH BOX in console.js.
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
// fmtWhen delegates the clock part to fmtHM, so both come across.
const fmtWhen = new Function(lift('fmtHM') + '\n' + lift('fmtWhen') + '\nreturn fmtWhen;')();

// Timestamps are built from LOCAL components and handed over as ISO, so fmtWhen parses them back to
// the same wall-clock time whatever zone the test runs in. Writing "2026-06-03T14:32:00Z" literally
// would make these assertions pass only in UTC.
const iso = (y, m, d, h, mi) => new Date(y, m, d, h, mi).toISOString();

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
