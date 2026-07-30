// Unit tests for the board-readability split: HEADLINE on the card, DETAIL behind a click.
//
// The defect this closes is not a crash, it is that Chris could not read his own board -- "I can not
// understand half of whats in there" (voice + screenshot, 2026-07-30). Cards are written by agents
// for the next agent: paragraphs carrying shas, line numbers and parentheticals. The fix is a
// RENDERER change and explicitly NOT a migration, so the two things worth pinning are (a) the split
// rules, because they have to do something sensible with the cards that ALREADY exist and were never
// written with a separator in mind, and (b) that the renderer actually calls the splitter.
//
// (b) is the half that has burned this project before. A pure helper that nothing calls is the
// "where is the search" failure -- the plumbing is proven and the human still sees no change. So
// these tests do not stop at the pure function: they lift the real HTML builder out of console.js
// and assert on its output, then assert the four render sites still route through it.
//
// console.js is a classic browser script (console.html loads it with <script src>), so it cannot
// import jarvis-text.mjs and carries a MIRROR of splitHeadline. That duplication is the standing
// hazard here, so the parity test below runs both copies over one fixture table -- a change to
// either that is not made to the other fails loudly rather than drifting.
//
// Lifting by name follows test/wedgechip.test.mjs and test/coordchip.test.mjs; it fails loudly if a
// function is renamed. What a node gate structurally cannot see -- that the caret lands where a
// mouse can hit it at Chris's real window size, that the detail block does not blow the card's
// layout out -- is his eyeball, and that is called out in the handoff rather than faked here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitHeadline } from '../jarvis-text.mjs';

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
// headlineHtml escapes through esc/escAttr; lifting them too keeps the escaping under test rather
// than stubbed, because card text is agent-authored and lands in both a title="" and a text node.
const consoleSplit = new Function(lift('splitHeadline') + '\nreturn splitHeadline;')();
// fixEscapedBreaks joined this list when headlineHtml started repairing double-escaped card text
// before splitting it. Lifted rather than stubbed for the same reason as esc: it is the thing under
// test on the brick fixtures below, and a stub would let the repair rot without failing anything.
const headlineHtml = new Function(
    lift('esc') + '\n' + lift('escAttr') + '\n' + lift('fixEscapedBreaks') + '\n'
    + lift('splitHeadline') + '\n' + lift('headlineHtml')
    + '\nreturn headlineHtml;')();

// ---- the split rules -------------------------------------------------------------------------

test('splitHeadline -- nothing to say renders nothing, and never offers an expander', () => {
    for (const v of ['', '   ', null, undefined]) {
        assert.deepEqual(splitHeadline(v), { headline: '', detail: '', truncated: false, hasMore: false }, JSON.stringify(v));
    }
});

test('splitHeadline -- a short unseparated line is left completely alone', () => {
    const r = splitHeadline('Merging the zulu wedge work');
    assert.equal(r.headline, 'Merging the zulu wedge work');
    assert.equal(r.detail, '');
    // The whole point of the no-migration rule: a card that is already readable must not sprout a
    // caret that opens onto a copy of itself.
    assert.equal(r.hasMore, false);
});

test('splitHeadline -- the house separator splits, and only the FIRST one does', () => {
    const r = splitHeadline('Board cards show a headline -- split on space-dash-dash-space -- detail follows');
    assert.equal(r.headline, 'Board cards show a headline');
    assert.equal(r.detail, 'split on space-dash-dash-space -- detail follows', 'later separators belong to the detail');
    assert.equal(r.hasMore, true);
});

test('splitHeadline -- a dash that is not the house separator is NOT a split point', () => {
    // Hyphenated words and negative/ranged numbers are everywhere in these cards; requiring spaces on
    // both sides is what keeps "sub-worker" and "2026-07-30" intact.
    for (const s of ['a sub-worker went quiet', 'the 2026-07-30 sweep', 'exit code -- 1'.replace(' -- ', '--')]) {
        assert.equal(splitHeadline(s).detail, '', s);
    }
});

test('splitHeadline -- a line break splits too, because a three-line headline IS the defect', () => {
    const r = splitHeadline('Gate is green\n516/516, skipped 0\nprobes still running');
    assert.equal(r.headline, 'Gate is green');
    assert.equal(r.detail, '516/516, skipped 0\nprobes still running');
});

test('splitHeadline -- whichever separator comes FIRST wins, in both orders', () => {
    assert.equal(splitHeadline('head -- detail\nmore').headline, 'head', 'separator before newline');
    assert.equal(splitHeadline('head\ndetail -- more').headline, 'head', 'newline before separator');
    assert.equal(splitHeadline('head\ndetail -- more').detail, 'detail -- more');
});

test('splitHeadline -- a separator with nothing after it offers no expander', () => {
    // Trailing separators happen when a session edits a card down. An expander opening onto an empty
    // panel is worse than no expander, so `hasMore` has to be false here.
    const r = splitHeadline('Board readability -- ');
    assert.equal(r.headline, 'Board readability');
    assert.equal(r.detail, '');
    assert.equal(r.hasMore, false);
});

test('splitHeadline -- a long unseparated card truncates on a word boundary and offers the expander', () => {
    // This is the case that makes the no-migration rule work: nearly every card on the board today
    // has no separator at all, so if this path did not truncate, nothing would visibly improve.
    const long = 'Audited the queued lane against the code and found five shipped cards still sitting in queued which means the board has been lying about what is left to build';
    const r = splitHeadline(long);
    assert.ok(r.headline.length <= 83, 'headline is ' + r.headline.length + ' chars: ' + r.headline);
    assert.ok(r.headline.endsWith('...'), r.headline);
    assert.ok(!/\s\.\.\.$/.test(r.headline), 'no dangling space before the ellipsis: ' + r.headline);
    // Word boundary, not a mid-word chop. Asserting only "is a prefix of the original" does NOT
    // check this -- a hard cut at the character budget is a prefix too -- so pin that the character
    // immediately after the kept text is a space in the original.
    const kept = r.headline.slice(0, -3);
    assert.ok(long.startsWith(kept), 'headline must be a prefix of the original');
    assert.equal(long[kept.length], ' ', 'cut mid-word: ...' + long.slice(Math.max(0, kept.length - 14), kept.length + 8));
    assert.equal(r.truncated, true);
    assert.equal(r.hasMore, true, 'truncation alone must raise hasMore -- there is no detail to key off');
    assert.equal(r.detail, '', 'nothing was after a separator, because there was no separator');
});

test('splitHeadline -- one enormous token still yields a headline instead of a stub', () => {
    // A leading path or sha with no space inside the budget would collapse a word-boundary cut to
    // almost nothing, so the cut falls back to a hard one.
    const r = splitHeadline('C:/Users/vinni/AppData/Local/Temp/claude/deadspawn-probe/hotel-trust-prompt-capture-file.log is where it is', 40);
    assert.ok(r.headline.length >= 40, 'refused to collapse to a stub: ' + r.headline);
    assert.equal(r.truncated, true);
});

test('splitHeadline -- a SHORT word before a huge token still yields a headline, not two letters', () => {
    // oscar's mutation probe found the gap this closes: `sp > max * 0.6` mutated to `sp > 0` killed
    // nothing. The case above cannot reach that floor -- its path contains no space at all, so
    // lastIndexOf returns -1 and BOTH the real floor and a broken one fall through to the hard cut.
    //
    // Reaching the floor needs a space that exists but lands early: a short leading word followed by
    // one enormous token. Here lastIndexOf(' ', 40) is 3, so without the floor the whole headline
    // collapses to "see..." -- and "BUG: see d:/some/very/long/path" is a shape half the real board
    // already has, so this is live rather than theoretical.
    const s = 'see d:/claude/.jarvis-wt/jarvis-bravo/test-support/verify-headline-browser.mjs for it';
    assert.equal(s.lastIndexOf(' ', 40), 3, 'fixture must put the only early space at 3, or it proves nothing');
    const r = splitHeadline(s, 40);
    assert.ok(r.headline.length >= 40, 'collapsed to a stub: ' + JSON.stringify(r.headline));
    assert.ok(!/^see\.\.\.$/.test(r.headline), 'the word-boundary floor is gone: ' + r.headline);
    assert.equal(r.truncated, true);
});

test('splitHeadline -- a separated card whose FIRST clause is itself a paragraph still truncates', () => {
    // Both conditions at once: there is real detail AND the headline overflows. Neither may mask the
    // other -- the caret must appear and the headline must still be one readable line.
    const r = splitHeadline('This first clause was written for the next session and rambles well past any sensible headline budget -- and then the actual detail');
    assert.equal(r.truncated, true);
    assert.equal(r.detail, 'and then the actual detail');
    assert.ok(r.headline.endsWith('...'));
});

test('splitHeadline -- CRLF text splits the same as LF, because every file here is CRLF', () => {
    // Mutation probing caught this one under-fed. A TWO-line fixture cannot see the carriage-return
    // strip at all: the split point is then the only line break, and trim() cleans the stray \r off
    // both halves by itself, so deleting the strip changed nothing and the mutant survived. It takes
    // a detail that is itself multi-line to reach a \r INTERIOR to the detail -- which is exactly the
    // one a caller doing detail.split('\n') would trip over.
    const r = splitHeadline('Gate is green\r\n516/516, skipped 0\r\nprobes still running');
    assert.equal(r.headline, 'Gate is green');
    assert.equal(r.detail, '516/516, skipped 0\nprobes still running');
    assert.ok(!r.detail.includes('\r'), 'a carriage return survived into the detail: ' + JSON.stringify(r.detail));
});

test('splitHeadline -- max is honoured when a caller asks for a tighter budget', () => {
    // The mission rail passes 60: its rows are a single squeezed flex line, far narrower than a card.
    const s = 'a fairly long line of text that runs past sixty characters without any separator at all';
    assert.ok(splitHeadline(s, 60).headline.length < splitHeadline(s, 80).headline.length);
});

// ---- the mirror in console.js ------------------------------------------------------------------

test('splitHeadline -- the console.js mirror agrees with jarvis-text.mjs on every fixture', () => {
    const fixtures = [
        '', '   ', null, undefined,
        'short and readable',
        'head -- detail',
        'head -- detail -- more detail',
        'head\ndetail',
        'head -- detail\nmore',
        'head\ndetail -- more',
        'trailing separator -- ',
        'a sub-worker went quiet on 2026-07-30',
        'Gate is green\r\n516/516, skipped 0',
        'Audited the queued lane against the code and found five shipped cards still sitting in queued which means the board has been lying',
        'This first clause rambles well past any sensible headline budget before it ever reaches one -- and then the detail',
        'C:/Users/vinni/AppData/Local/Temp/claude/deadspawn-probe/hotel-trust-prompt-capture.log is where it is',
        // The word-boundary floor (oscar's survivor). In the SHARED table deliberately: the whole
        // value of this table is that a floor fixed in one copy and not the other fails here.
        'see d:/claude/.jarvis-wt/jarvis-bravo/test-support/verify-headline-browser.mjs for it',
    ];
    for (const f of fixtures) {
        assert.deepEqual(consoleSplit(f), splitHeadline(f), 'MIRROR DRIFT on ' + JSON.stringify(f)
            + ' -- console.js and jarvis-text.mjs must be kept in step');
        assert.deepEqual(consoleSplit(f, 40), splitHeadline(f, 40), 'MIRROR DRIFT at max=40 on ' + JSON.stringify(f));
    }
});

// ---- the HTML the board actually renders -------------------------------------------------------

test('headlineHtml -- a short line renders bare: no caret, no detail block', () => {
    const h = headlineHtml('standing by', 'doing:bravo', false);
    assert.equal(h.text, 'standing by');
    assert.equal(h.caret, '', 'a readable line must not sprout an affordance');
    assert.equal(h.body, '');
    assert.equal(h.hasMore, false);
});

test('headlineHtml -- collapsed, the detail is NOT in the markup', () => {
    // Not merely hidden: the whole point is that the board stops carrying the paragraph. If the
    // detail shipped in the DOM behind display:none this assertion would pass while the card still
    // rendered it, so assert on the returned pieces the card is built from.
    const h = headlineHtml('Merged the wedge work -- gate 516/516 verified, 8 probes running, sha 59bf780', 'hl:t_1', false);
    assert.equal(h.text, 'Merged the wedge work');
    assert.equal(h.body, '', 'collapsed rows carry no detail');
    assert.match(h.caret, /data-x="hl:t_1"/, 'the caret must carry the expander key');
    assert.match(h.caret, /class="hlmore"/);
    assert.match(h.caret, /show the full text/, 'closed caret invites opening');
});

test('headlineHtml -- expanded, the FULL stored string is shown, not just the tail', () => {
    // One rule for every surface. A long unseparated card has no "detail" to show, so showing only
    // the part after the separator would open onto nothing on the majority of today's cards.
    const txt = 'Merged the wedge work -- gate 516/516 verified, 8 probes running';
    const h = headlineHtml(txt, 'hl:t_1', true);
    assert.ok(h.body.includes('gate 516/516 verified'), h.body);
    assert.ok(h.body.includes('Merged the wedge work'), 'the headline half is part of the stored string too');
    assert.match(h.body, /class="hldetail"/);
    assert.match(h.caret, /hide the detail/, 'open caret invites closing');
});

test('headlineHtml -- a truncated unseparated line still gets a caret onto the whole text', () => {
    const long = 'Audited the queued lane against the code and found five shipped cards still sitting in queued, which means the board has been lying';
    const closed = headlineHtml(long, 'hl:t_2', false);
    assert.notEqual(closed.caret, '', 'truncation alone must offer the expander');
    const open = headlineHtml(long, 'hl:t_2', true);
    assert.ok(open.body.includes('the board has been lying'), 'the tail is reachable: ' + open.body);
});

test('headlineHtml -- agent text cannot inject markup into the card', () => {
    // Card text is written by sessions, and it lands in a text node AND in a data-x attribute.
    const h = headlineHtml('<img src=x onerror=alert(1)> -- <b>detail</b>', 'hl:"><script>', true);
    assert.ok(!h.text.includes('<img'), h.text);
    assert.ok(!h.body.includes('<b>'), h.body);
    assert.ok(!h.caret.includes('<script'), h.caret);
    assert.match(h.text, /&lt;img/);
});

test('headlineHtml -- newlines in the detail render as line breaks, not as one run-on line', () => {
    const h = headlineHtml('Gate green\n516/516\nskipped 0', 'hl:t_3', true);
    assert.match(h.body, /516\/516<br>skipped 0/, h.body);
    assert.ok(!h.body.includes('\r'), 'no carriage return survives into the markup');
});

// ---- the wiring ---------------------------------------------------------------------------------

test('console.js -- all four prose surfaces route through headlineHtml', () => {
    // The point of the whole change. Each of these is a surface Chris reads; a helper wired into
    // three of the four is a half-fixed board, and the rail's doing-line was the WORST offender in
    // his screenshot, so it is named individually rather than trusting a bare call count.
    const calls = (src.match(/headlineHtml\(/g) || []).length;
    assert.equal(calls, 5, 'expected 1 definition + 4 call sites, found ' + calls + ' occurrences');
    const site = (label, re) => assert.match(src, re, 'the ' + label + ' no longer routes through headlineHtml');
    site('task row', /const hl = headlineHtml\(tc\.rest,/);
    site('card doing-line', /const dh = headlineHtml\(b\.doing \|\| '',/);
    site('mission-rail doing-line', /const dh = headlineHtml\(doing, 'rdoing:'/);
    site('project current-focus line', /const fh = headlineHtml\(pc\.currentFocus \|\| '',/);
});

test('console.js -- no surface still prints the raw un-split prose', () => {
    // The regression this guards is a revert-by-accident: someone edits one of these lines back to
    // esc(...) and the board quietly starts printing paragraphs again, with every test above still
    // green because the pure function is untouched.
    for (const dead of ['esc(tc.rest)', "esc(b.doing || '')", 'esc(pc.currentFocus)']) {
        assert.ok(!src.includes(dead), 'console.js still renders ' + dead + ' -- that surface was un-wired');
    }
    // esc(doing) was the mission rail. It is the one needle here that is NOT unique by construction:
    // `doing` is a common local name, so pin the rail's own row markup instead of the bare call.
    assert.ok(!/nowrap">' \+ esc\(doing\)/.test(src), 'the mission rail row still prints esc(doing)');
});

// ---- A double-escaped CARD ----------------------------------------------------------------------
// splitHeadline looks for a REAL newline, so a card posted with literal backslash-n was invisible to
// it: the whole brick became one 80-character headline with the backslash-n showing, and because the
// truncation set hasMore, the caret opened onto the same brick. headlineHtml now repairs before it
// splits. Written with BS rather than a literal backslash so no editor or shell can collapse the
// fixture into a real newline and leave these assertions proving nothing.
const BS = String.fromCharCode(92);
const BRICK = 'BUG: chat renders a brick' + BS + 'n'
    + 'the repair runs after the join' + BS + 'n' + 'so it disables itself';

test('headlineHtml -- a double-escaped card gets a real headline, not a brick', () => {
    const r = headlineHtml(BRICK, 'k', false);
    assert.equal(r.text, 'BUG: chat renders a brick', 'the first line becomes the headline');
    assert.ok(!r.text.includes(BS + 'n'), 'and no literal backslash-n is left on screen');
    assert.ok(r.hasMore, 'the rest is still reachable behind the caret');
});

test('headlineHtml -- and expanding it shows real lines rather than the same brick', () => {
    const r = headlineHtml(BRICK, 'k', true);
    assert.ok(!r.body.includes(BS + 'n'), 'the detail block carries no literal backslash-n');
    assert.equal((r.body.match(/<br>/g) || []).length, 2, 'the two breaks became real line breaks');
    assert.ok(r.body.includes('so it disables itself'), 'and the whole stored text is still shown');
});

test('headlineHtml -- a card naming a Windows path keeps the path', () => {
    // The reason the repair could not simply be bolted on: the obvious version corrupts a path, and
    // the board is where paths get quoted. d:\node\x has to survive being rendered.
    const card = 'NOTE: the worktree is at d:' + BS + 'node' + BS + 'x';
    const r = headlineHtml(card, 'k', false);
    assert.ok(r.text.includes('d:' + BS + 'node' + BS + 'x'), 'path intact in the headline -- got ' + r.text);
    assert.ok(!r.hasMore, 'and a short card still offers no expander');
});

test('splitHeadline itself stayed pure -- the repair went in the LAYER above it', () => {
    // Deliberate: splitHeadline is the MIRRORED function, so putting fixEscapedBreaks inside it would
    // drag the repair into jarvis-text.mjs too, for no gain. Both copies must stay blind to a literal
    // backslash-n, and headlineHtml is what hands them repaired text.
    assert.equal(splitHeadline(BRICK).detail, '', 'the exported splitter must NOT repair');
    assert.equal(consoleSplit(BRICK).detail, '', 'and neither must the console mirror');
    assert.ok(!lift('splitHeadline').includes('fixEscapedBreaks'), 'the repair leaked into splitHeadline');
});

test('console.js -- the rail can actually open its expander', () => {
    // The rail has its own click handler (missionEl.onclick) which knew only about phase toggles, so
    // a caret rendered there would have been dead on click -- visible, inviting, and inert. The board
    // panel's handler is a separate one and already handled data-x.
    const h = src.slice(src.indexOf('missionEl.onclick'), src.indexOf('missionEl.onclick') + 600);
    assert.match(h, /closest\('\[data-x\]'\)/, 'the rail handler does not pick up data-x expanders');
    assert.match(h, /boardExpand/, 'the rail must share the board-wide expander state');
});
