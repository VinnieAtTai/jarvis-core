// Unit tests for wedgeIndicator in console.js -- the chip on the board card that tells Chris a
// session is not hearing him.
//
// The gap this closes: the detector (wedge.test.mjs) and the announce (wedgeannounce.test.mjs) were
// both pinned, and the SURFACE HE ACTUALLY LOOKS AT was not pinned at all. The chip was rewritten in
// the same change that added the seconds field and the permission path -- two shapes now instead of
// one -- and nothing asserted that either renders. That is the same shape as shipping an endpoint
// with no console box: the plumbing is proven and the human still cannot see it.
//
// Two of these assertions exist because of the specific way this chip can go wrong:
//  - `DEAF 0m`. The permission path reports in SECONDS with no grace window at all, and minutes is
//    floored, so a 45-second outage renders as zero minutes -- a new threshold shipping an old bug.
//  - The hub and the console are deployed separately and reload on their own schedules, so the chip
//    is fed /board payloads from a hub that predates `seconds`. It must degrade to minutes rather
//    than render `DEAF undefineds`.
//
// console.js is browser script, so the pure function is lifted out of the source by name -- same
// approach as test/coordchip.test.mjs and test/nesting.test.mjs, and it fails loudly if it is
// renamed. What the gate cannot see (that the chip reaches the DOM, that the tooltip renders as a
// tooltip) belongs in a headless-Chrome verify alongside verify-coordchip-browser.mjs.
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
// wedgeIndicator calls escAttr, which calls esc. Lifting all three keeps the escaping under test
// rather than stubbed -- the tooltip carries hub-authored text into a title="" attribute.
const wedgeIndicator = new Function(
    lift('esc') + '\n' + lift('escAttr') + '\n' + lift('wedgeIndicator') + '\nreturn wedgeIndicator;')();

// The live shapes, exactly as GET /board emits them: jarvis-core.mjs projects the wedgeState result
// straight onto the card, so `wedged` is null or {minutes, seconds, pending, pendingPerms, reason}.
const deaf = { minutes: 6, seconds: 372, pending: 3, pendingPerms: 0, reason: 'deaf' };
const perm = { minutes: 0, seconds: 4, pending: 2, pendingPerms: 1, reason: 'perm' };

test('wedgeIndicator -- a healthy card renders NOTHING, not an empty chip', () => {
    for (const row of [{}, { wedged: null }, { wedged: undefined }]) {
        assert.equal(wedgeIndicator(row), '', JSON.stringify(row));
    }
});

test('wedgeIndicator -- the poll-age shape renders DEAF with the duration', () => {
    const html = wedgeIndicator({ wedged: deaf });
    assert.match(html, /class="wedgechip hot"/, '3 queued messages is hot');
    assert.match(html, />DEAF 6m</, html);
    assert.match(html, /no poll in 6m/, 'the tooltip carries the duration too');
    assert.match(html, /3 events queued and unread/, html);
});

test('wedgeIndicator -- the permission shape is a DIFFERENT chip, because it is a certainty', () => {
    // Poll age is an inference and carries a duration; a pending permission prompt is provably
    // blocking, so the chip states the condition instead of a stopwatch reading.
    const html = wedgeIndicator({ wedged: perm });
    assert.match(html, />NEEDS OK</, html);
    assert.equal(/DEAF/.test(html), false, 'a permission block is not a deaf poll loop: ' + html);
    assert.match(html, /permission approval it cannot answer/, html);
    assert.match(html, /Approve it on this card/, 'the remedy is one click, so say so: ' + html);
});

test('wedgeIndicator -- NEVER renders "DEAF 0m": a sub-minute outage reports in seconds', () => {
    // The bug a seconds-scale threshold ships if the chip is left on minutes. floor(45s) is 0.
    const html = wedgeIndicator({ wedged: { minutes: 0, seconds: 45, pending: 1, reason: 'deaf' } });
    assert.match(html, />DEAF 45s</, html);
    assert.equal(/DEAF 0m/.test(html), false, html);
});

test('wedgeIndicator -- switches from seconds to minutes at 90, matching the spoken line', () => {
    // deafFor() in jarvis-core.mjs uses the same 90-second boundary. If these two drift, the chip and
    // the voice describe one outage with two different numbers.
    const at = s => wedgeIndicator({ wedged: { minutes: Math.floor(s / 60), seconds: s, pending: 1, reason: 'deaf' } });
    assert.match(at(89), />DEAF 89s</);
    assert.match(at(90), />DEAF 1m</);
    assert.match(at(600), />DEAF 10m</);
});

test('wedgeIndicator -- an OLDER hub with no seconds field degrades to minutes, never undefined', () => {
    // The hub and the console reload separately. Before the seconds field existed /board emitted
    // {minutes, pending} only, and that payload must not render "DEAF undefineds".
    //
    // BOTH spellings on purpose, and the second is the one carrying its weight. An ABSENT seconds is
    // the real-world payload, but it needs no guarding: `undefined < 90` is already false, so it falls
    // to minutes whether or not Number.isFinite is there. A seconds of NULL is what makes that guard
    // load-bearing -- `null < 90` coerces to `0 < 90`, true, and the chip would render "DEAF nulls".
    // Without this line, deleting the isFinite check passes every assertion in this file.
    assert.match(wedgeIndicator({ wedged: { minutes: 6, pending: 3 } }), />DEAF 6m</, 'seconds absent');
    assert.match(wedgeIndicator({ wedged: { minutes: 6, seconds: null, pending: 3 } }), />DEAF 6m</, 'seconds null');
    for (const seconds of [undefined, null, NaN, 'soon']) {
        const html = wedgeIndicator({ wedged: { minutes: 6, seconds, pending: 3 } });
        assert.equal(/undefined|NaN|null|soon/.test(html), false, JSON.stringify(seconds) + ' leaked: ' + html);
    }
});

test('wedgeIndicator -- nothing queued is stated explicitly and is NOT hot', () => {
    // Zero queued is the whole difference between "act now" and "just note it", so the tooltip has to
    // say which one it is rather than leaving the clause off and reading as truncated.
    const html = wedgeIndicator({ wedged: { ...deaf, pending: 0 } });
    assert.match(html, /nothing queued/, html);
    assert.equal(/wedgechip hot/.test(html), false, 'no queued traffic must not pulse red: ' + html);
});

test('wedgeIndicator -- pluralises one queued message correctly', () => {
    assert.match(wedgeIndicator({ wedged: { ...deaf, pending: 1 } }), /1 event queued/);
    assert.match(wedgeIndicator({ wedged: { ...deaf, pending: 2 } }), /2 events queued/);
});

test('wedgeIndicator -- BOTH shapes name the lever, and mention /forget ONLY to warn it off', () => {
    // The remedy existed all night and nobody was told it. POST /retire successor:true transfers the
    // whole board; POST /forget retires with no opts (so shouldSpawnSuccessor never runs) and then
    // DELETES the board -- pressed on a coordinator to "clear" it, it destroys every card the project
    // had. So the chip must name the safe lever, and it must name the dangerous one only in the
    // negative: a bare mention beside a wedge warning reads as a second option.
    for (const w of [deaf, perm]) {
        const html = wedgeIndicator({ wedged: w });
        assert.match(html, /successor:true/, w.reason + ' must name the safe lever: ' + html);
        for (const m of html.matchAll(/.{0,8}\/forget/g)) {
            assert.match(m[0], /never /, w.reason + ' mentions /forget without warning it off: ' + m[0]);
        }
    }
});

test('wedgeIndicator -- the chip label and its tooltip quote the SAME duration', () => {
    // The duration is interpolated twice, into the label and into the tooltip. If the tooltip is ever
    // switched back to w.minutes while the label keeps the seconds-aware value, a 45-second outage
    // reads "DEAF 45s" on the card and "no poll in 0m" on hover -- the sub-minute bug surviving in the
    // half of the chip nobody re-reads.
    //
    // Deliberately NOT asserting that the tooltip is attribute-escaped: nothing variable reaches it.
    // Only numbers and fixed clauses are interpolated, so escAttr here is unreachable defence and an
    // assertion about it would pass with escAttr removed -- a test that cannot fail, which is worse
    // than no test because it reads as coverage.
    for (const s of [45, 89, 90, 372]) {
        const html = wedgeIndicator({ wedged: { minutes: Math.floor(s / 60), seconds: s, pending: 1, reason: 'deaf' } });
        const label = html.match(/>DEAF ([^<]+)</);
        assert.ok(label, s + 's did not render a DEAF label at all: ' + html);
        assert.match(html, new RegExp('no poll in ' + label[1] + '\\b'),
            s + 's: the label says "' + label[1] + '" and the tooltip disagrees: ' + html);
    }
});

test('wedgeIndicator -- garbage in, no throw: it runs inside the board render loop', () => {
    // A render loop that throws blanks the whole board, so an unexpected payload must degrade to a
    // chip rather than take the pane down with it.
    for (const bad of [{ wedged: {} }, { wedged: { reason: 'perm' } }, { wedged: { minutes: null, seconds: null } }, { wedged: { reason: 'something-new' } }]) {
        assert.doesNotThrow(() => wedgeIndicator(bad), JSON.stringify(bad));
    }
});
