// Unit tests for bubbleText -- the repair of double-escaped line breaks in a chat bubble.
//
// THE BUG, photographed by Chris 2026-07-30 13:35 ("BRICK OF TEXT USE RICH TEXT MAKE NOT SO THIS").
// A worker that double-escapes its JSON body sends the two characters backslash+n instead of a real
// newline. fixEscapedBreaks has repaired that since 42fff0f, and it was in the deployed build. It
// still shipped a brick, because of WHERE it was applied: chatBubble rendered
//
//     richText(g.texts.join('\n'))
//
// and g.texts is a GROUP -- consecutive messages from one sender in a single bubble. The join
// supplies a real newline, and fixEscapedBreaks' guard reads a real newline as "this text already
// has genuine breaks, leave its backslash-n alone" (deliberately, so a regex or code sample is not
// mangled). So the repair switched itself off for exactly the messages that had a neighbour.
//
// That is why only 2 of 14 of oscar's messages broke, and it is why this was so easy to misread as a
// stale browser: the SAME string rendered correctly when it happened to arrive alone.
//
// The lesson worth keeping: the guard was never wrong and the call path was never wrong. It was
// applied at the wrong LAYER -- to a concatenation, by a function that only ever reasoned about one
// message. A per-message guard cannot survive being handed a join.
//
// FIXTURES ARE CAPTURED, NOT INVENTED. The strings below are excerpts of the real transcript entry
// (ts 2026-07-30T13:34:55.559Z: 1806 chars, 0 real newlines, 10 literal backslash-n) including its
// real Windows path, because a fixture that shares an assumption with the code only proves the two
// agree -- diagnoseSpawnLog was pinned for weeks against wording that no real log ever contained.
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
const bubbleText = new Function(
    lift('fixEscapedBreaks') + '\n' + lift('bubbleText') + '\nreturn bubbleText;')();
const fixEscapedBreaks = new Function(lift('fixEscapedBreaks') + '\nreturn fixEscapedBreaks;')();

const BS = String.fromCharCode(92);
// Verbatim opening of the real broken message. Written by escape rather than as a literal so no
// editor, shell or line-ending pass can quietly "helpfully" collapse the backslash-n into a newline
// and turn this fixture into one that proves nothing.
const BROKEN = '**The probe found a better bug than the one it was looking for.**'
    + BS + 'n' + BS + 'n'
    + 'Not a guess - the hub logged it: worktree remove FAILED for a dead session at '
    + 'd:' + BS + 'claude' + BS + '.jarvis-wt' + BS + 'oscar-verify; branch HEAD kept.';
const NEIGHBOUR = 'Re-ran it somewhere the sweep cannot reach.';
const litN = (s) => s.split(BS + 'n').length - 1;
const realN = (s) => s.split('\n').length - 1;

test('the captured fixture is genuinely double-escaped, or every test below is vacuous', () => {
    // The baseline check. If this fixture ever stops carrying literal backslash-n, the assertions
    // that follow would all pass against a string with nothing to repair.
    assert.equal(realN(BROKEN), 0, 'fixture must have NO real newlines');
    assert.equal(litN(BROKEN), 2, 'fixture must carry literal backslash-n');
    assert.ok(BROKEN.includes('d:' + BS + 'claude'), 'fixture must keep its real Windows path');
});

test('bubbleText -- a lone message is repaired (this always worked)', () => {
    const out = bubbleText([BROKEN]);
    assert.equal(litN(out), 0, 'no literal backslash-n survives');
    assert.equal(realN(out), 2, 'and they became real breaks');
});

test('bubbleText -- THE BUG: a message with a neighbour is repaired too', () => {
    // Before the fix this returned the group untouched: the join put a real newline in front of the
    // guard, so it bailed and Chris got a brick. Both orders, because grouping is not ordered.
    for (const group of [[BROKEN, NEIGHBOUR], [NEIGHBOUR, BROKEN]]) {
        const out = bubbleText(group);
        assert.equal(litN(out), 0, 'literal backslash-n survived in group ' + JSON.stringify(group.map(s => s.slice(0, 24))));
        assert.ok(out.includes(NEIGHBOUR), 'the neighbour is still in the bubble');
    }
});

test('bubbleText -- a whole bubble of broken messages is repaired, not just the first', () => {
    // A map() that only fixed [0], or a loop that broke early, would pass the two-message test.
    const out = bubbleText([BROKEN, BROKEN, BROKEN]);
    assert.equal(litN(out), 0, out.slice(0, 120));
    assert.equal(realN(out), 8, '2 breaks per message + 2 joins');
});

test('bubbleText -- messages are still SEPARATED by a newline', () => {
    // The join is load-bearing: drop it and two messages run together into one line. Plain messages
    // with nothing to repair must come through as distinct lines.
    const out = bubbleText(['first line', 'second line']);
    assert.equal(out, 'first line\nsecond line');
});

test('bubbleText -- real content backslashes are NOT touched', () => {
    // The Windows path in the captured message is why this matters: backslash-c, backslash-dot and
    // backslash-o must arrive intact or the repair has corrupted what it was meant to rescue.
    const out = bubbleText([BROKEN]);
    assert.ok(out.includes('d:' + BS + 'claude' + BS + '.jarvis-wt' + BS + 'oscar-verify'),
        'the Windows path was mangled: ' + out.slice(-90));
});

test('bubbleText -- a message with GENUINE line breaks keeps its backslash-n as content', () => {
    // The original guard's whole purpose, and it must survive per-message. A message that already
    // has real breaks is far more likely to carry a backslash-n as content (a regex, a code sample)
    // than as a mistake -- so it is left alone even when it sits in a group.
    const genuine = 'here is the pattern:\n  /' + BS + 'n/g\nuse it as-is';
    const out = bubbleText([genuine, NEIGHBOUR]);
    assert.equal(litN(out), 1, 'the regex sample must survive verbatim');
    assert.ok(out.includes('/' + BS + 'n/g'), out);
});

test('bubbleText -- empty and junk groups cannot throw the whole chat render', () => {
    // chatBubble runs inside the 1.5s poll re-render; a throw here takes the conversation down.
    assert.equal(bubbleText([]), '');
    assert.equal(bubbleText(null), '');
    assert.equal(bubbleText(undefined), '');
    assert.equal(bubbleText([null, 'ok']), '\nok');
});

test('fixEscapedBreaks itself is unchanged -- the fix was the LAYER, not the guard', () => {
    // Pins that this change did not quietly loosen the guard to paper over the layering bug. Handed
    // a joined string it must STILL decline, because that behaviour is correct for a single message.
    assert.equal(fixEscapedBreaks(BROKEN + '\n' + NEIGHBOUR), BROKEN + '\n' + NEIGHBOUR,
        'the guard must still leave already-broken-up text alone');
    assert.equal(litN(fixEscapedBreaks(BROKEN)), 0, 'and still repair a lone message');
});

test('console.js -- chatBubble routes through bubbleText, and joins nowhere else', () => {
    // The wiring. The render and BOTH copy buttons shared the same raw join, so a fix applied to one
    // of the three would have left a bubble that read correctly and copied a brick into an email.
    const body = src.slice(src.indexOf('function chatBubble('), src.indexOf('// ---- Chat search'));
    assert.match(body, /const _md = bubbleText\(g\.texts\)/, 'chatBubble no longer builds its markdown via bubbleText');
    assert.ok(!body.includes("g.texts.join('\\n')"),
        'chatBubble still has a raw g.texts.join -- that path skips the per-message repair');
    assert.equal((body.match(/_md/g) || []).length, 4, 'expected _md defined once and used by render + both copy buttons');
});

// ---- The path hazard ----------------------------------------------------------------------------
// The BROKEN fixture above carries a real Windows path and has always survived the repair -- but by
// LUCK OF SPELLING, not by design: its sequences are backslash-c, backslash-dot and backslash-o, and
// the rewrite only ever touched backslash-n and backslash-t. Point it at a path that does hit them
// and the old code destroyed it. Measured on the live board 2026-07-30: of 2321 strings, one already
// carried a backslash-t (a TMS path), so the corrupting input is present, not hypothetical.
//
// The shape that gets hurt is a SHORT ONE-LINE message naming a path, because the guard bails as soon
// as a message has real line breaks. That is exactly the shape workers were asked to send, so the
// exposure went UP when the house style got terser.
const PATHS_THAT_HIT_IT = [
    ['drive path with backslash-n', 'd:' + BS + 'node' + BS + 'x'],
    ['drive path with backslash-t', 'd:' + BS + 'code' + BS + 'tms'],
    ['both, worst case', 'C:' + BS + 'temp' + BS + 'new' + BS + 'thing'],
    ['UNC share', BS + BS + 'build01' + BS + 'artifacts' + BS + 'nightly'],
];

test('fixEscapedBreaks -- a Windows path is never turned into a line break', () => {
    for (const [label, p] of PATHS_THAT_HIT_IT) {
        const msg = 'log is at ' + p;
        const out = fixEscapedBreaks(msg);
        assert.equal(realN(out), 0, label + ': a path must not produce a real newline -- got ' + JSON.stringify(out));
        assert.ok(!out.includes('\t'), label + ': nor a real tab -- got ' + JSON.stringify(out));
        assert.equal(out, msg, label + ': the path must come through byte-identical');
    }
});

test('fixEscapedBreaks -- and these fixtures really would have been corrupted before', () => {
    // Guards the guard. If a later edit made these paths harmless, the test above would still pass
    // while proving nothing -- the same way the old fixture passed on luck of spelling.
    // Built from BS with split/join instead of regex literals, for exactly the reason the fixtures
    // at the top of this file are: backslash-heavy source is the thing that gets mangled in transit,
    // and a mangled guard would go on passing while guarding nothing. This one already did once.
    const oldBehaviour = (s) => {
        const hadLiteral = s.includes(BS + 'n') || s.includes(BS + 't');
        if (s.includes('\n') || !hadLiteral) return s;
        return s.split(BS + 'n').join('\n').split(BS + 't').join('\t');
    };
    for (const [label, p] of PATHS_THAT_HIT_IT) {
        const msg = 'log is at ' + p;
        assert.notEqual(oldBehaviour(msg), msg, label + ': fixture no longer exercises the hazard');
    }
});

test('fixEscapedBreaks -- a genuine double-escaped message is still repaired', () => {
    // The repair must not have been bought by switching itself off. This is the whole reason the
    // function exists, and a path-masking bug that disabled it would be a silent regression.
    assert.equal(litN(fixEscapedBreaks(BROKEN)), 0, 'still no literal backslash-n');
    assert.equal(realN(fixEscapedBreaks(BROKEN)), 2, 'still two real breaks');
    assert.ok(fixEscapedBreaks(BROKEN).includes('d:' + BS + 'claude' + BS + '.jarvis-wt'),
        'and the path inside it is still intact');
});

test('fixEscapedBreaks -- a path AND a break: the path wins, and that is deliberate', () => {
    // "d:\temp\new.log\nit has the trace" is genuinely ambiguous -- a folder called nit is legal, so
    // there is no way to know the break is a break. The mask is greedy and keeps the path whole,
    // declining to repair that one break. A brick is ugly; a corrupted path is wrong, and only one
    // of those can be undone by the person reading it. Pinned so nobody "fixes" it into corruption.
    const msg = 'log is at d:' + BS + 'temp' + BS + 'new.log' + BS + 'nit has the stack trace';
    const out = fixEscapedBreaks(msg);
    assert.ok(out.includes('d:' + BS + 'temp' + BS + 'new.log'), 'the path survives whole');
    assert.equal(realN(out), 0, 'and the ambiguous break is left alone rather than guessed at');
});

test('fixEscapedBreaks -- a break OUTSIDE a path span is still repaired when a path is present', () => {
    // The masking must be surgical, not a blanket bail-out: one path in a message cannot be allowed
    // to switch the repair off for the rest of it.
    const msg = 'see d:' + BS + 'code' + BS + 'tms for the repo' + BS + 'n' + 'and the log is elsewhere';
    const out = fixEscapedBreaks(msg);
    assert.ok(out.includes('d:' + BS + 'code' + BS + 'tms'), 'path intact');
    assert.equal(realN(out), 1, 'and the break that was not inside a path became real');
});

// ---- The unmask out-of-range guard --------------------------------------------------------------
// Masking parks each path span as NUL-index-NUL and puts it back on the way out. That makes the
// sentinel a piece of SYNTAX living inside the message, so a message that already contains one
// arrives carrying a forged index -- and held[+i] on a forged index is undefined, which
// String.replace stringifies and splices into the chat as the literal word "undefined".
//
// This case is a debt, not a discovery. november mutation-probed the path-masking fix at merge time
// and deleting the range check was its one survivor of three; it judged that a real test gap rather
// than dead code, merged anyway (75ccf67) and handed the assertion on instead of leaving it implicit.
// Nothing in the suite ever fed a sentinel, so the guard was live code no test had reached.
//
// A NUL byte is reachable, not hypothetical: JSON.parse accepts a u-plus-0000 escape inside a
// string, so a worker's /send body carries one through the transcript into this function.
//
// That escape is named in prose on purpose. Typing it as itself put a LITERAL NUL byte into this
// comment on the first attempt -- the same class of accident as the heredoc that ate this file's
// backslashes, and invisible in every diff. Below this line every sentinel comes from
// String.fromCharCode, never a literal, so nothing in transit can normalise one away.
const NUL = String.fromCharCode(0);
const sentinel = (i) => NUL + i + NUL;

// The same function with ONLY the guard removed -- lifted from source and textually mutated rather
// than reimplemented, so it cannot go on "proving" these fixtures are dangerous after the masking
// scheme has changed underneath it. Two things have to hold for that mutant to be worth anything: the
// guard is spelled in console.js exactly once, and removing it really did change the body.
//
// THOSE TWO CHECKS USED TO RUN AT MODULE SCOPE, inside the IIFE that built the mutant, WHICH PUT THEM
// IN FRONT OF EVERY TEST IN THIS FILE. Any edit to the masking scheme threw during IMPORT, so the run
// read "tests 1 pass 0 fail 1" -- one failure, which every fail>0 harness scores as a kill. bravo
// probed four mutants of console.js against this file on 2026-07-30 and all four reported fail=1
// without one targeted assertion ever executing; re-probed with this rig stubbed out they died to the
// assertions they were actually aimed at, so the verdict had been right by luck and worthless as
// evidence. A self-check that guards a test can also stand in front of it.
//
// Hence the shape below. Building the mutant ASSERTS NOTHING and is called from inside tests, the two
// checks live in a test() of their own so a broken rig fails by NAME, and the consumer skips rather
// than piling on a second failure -- one report, and the run still says which surface moved. It does
// not go silent: skipped != 0 fails this project's gate on its own.
const GUARD = '+i < held.length ? held[+i] : m';
const RIG_TEST = 'the rig that removes the unmask guard still has a guard to remove';
function unguardedRig() {
    const body = lift('fixEscapedBreaks');
    const mutated = body.replace(GUARD, 'held[+i]');
    return {
        spellings: body.split(GUARD).length - 1,
        // No mutant at all rather than an unmutated copy: handing the consumer the REAL function would
        // fail it too (the fixtures are not corrupted, which is precisely what the guard is for), and
        // that second failure is the noise this whole rearrangement exists to remove.
        fix: mutated === body ? null : new Function(mutated + '\nreturn fixEscapedBreaks;')(),
    };
}

test(RIG_TEST, () => {
    const rig = unguardedRig();
    assert.equal(rig.spellings, 1,
        'console.js no longer spells the unmask guard exactly once as ' + JSON.stringify(GUARD) + ' -- update this test');
    assert.ok(rig.fix, 'the guard removal did nothing -- the mutant below would prove nothing');
});

const FORGED = [
    // held is EMPTY here -- no path span to mask -- so index 0 is already out of range.
    ['no path, forged index 0', sentinel(0),
        'status ' + sentinel(0) + ' and the log moved' + BS + 'n' + 'to the new host'],
    // A path IS present here, so the mask spends index 0 on it and held.length is 1 while the forged
    // index is 7. That is why the guard has to be a RANGE check: rewritten as `held.length ? ... : m`
    // it satisfies the first row and corrupts this one, so one fixture would not have been enough.
    ['one path held, forged index 7', sentinel(7),
        'see d:' + BS + 'code' + BS + 'tms and ' + sentinel(7) + ' then' + BS + 'n' + 'the trace'],
];

test('fixEscapedBreaks -- a forged mask sentinel is left alone, never resolved', () => {
    for (const [label, tok, msg] of FORGED) {
        const out = fixEscapedBreaks(msg);
        assert.ok(!out.includes('undefined'),
            label + ': the forged index resolved -- ' + JSON.stringify(out));
        assert.ok(out.includes(tok),
            label + ': the sentinel must come through verbatim -- ' + JSON.stringify(out));
        assert.equal(realN(out), 1, label + ': and the genuine break beside it is still repaired');
    }
    assert.ok(fixEscapedBreaks(FORGED[1][2]).includes('d:' + BS + 'code' + BS + 'tms'),
        'a real path must still round-trip through the mask alongside a forged sentinel');
});

test('fixEscapedBreaks -- and without the guard these fixtures really are corrupted', (t) => {
    // Guards the guard, the way the oldBehaviour test above does for the path fixtures. If a later
    // edit made a forged sentinel harmless, the test above would keep passing while reaching nothing
    // -- which is exactly the state this section was written to end.
    const rig = unguardedRig();
    if (!rig.fix) {
        t.skip('no mutant to test with -- "' + RIG_TEST + '" is the failure to read');
        return;
    }
    for (const [label, , msg] of FORGED) {
        assert.match(rig.fix(msg), /undefined/,
            label + ': fixture no longer reaches the guard, so the test above proves nothing');
    }
});
