// POST /health clamps the `doing` line, and until now it clamped it to 80 characters.
//
// WHY THAT NUMBER EXISTED, and why it stopped being right. 80 was the width the OLD rail could render:
// one nowrap flex line sharing its row with the callsign, the COORD chip, the lane chip and the
// activity glyph. Storing more was pointless, so the route cut it -- server-side, before the console
// ever saw it. The readability work (Chris, voice + screenshot 2026-07-30: "I can not understand half
// of whats in there") replaced that renderer: every site that shows this string now shows a HEADLINE
// with the full text one click down, and the house shape for agent-written prose became
// `headline -- detail`. A cap of 80 cannot hold that shape, so the cap was the constraint.
//
// WHAT THIS FILE PINS, and it is deliberately both halves, because raising a cap is only safe if the
// screen is protected by something else:
//   1. a real `headline -- detail` report longer than the old 80 now survives ingest byte-identical,
//   2. the cap is still a cap -- a runaway paste is cut at 400, not stored whole,
//   3. and a 400-character value still cannot blow out the rail, because the SPLITTER bounds what
//      renders. Asserted against the real exported splitHeadline at the real per-site widths, so the
//      claim in the route's comment is measured here rather than believed.
//
// The cap matters beyond the board: reconstructHandoff quotes this string verbatim into the handoff
// record every successor reads, so an unbounded one would follow a session's whole lineage.
//
// Run with:  npm run test:doingcap
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitHeadline } from '../jarvis-text.mjs';
import { createScratchHub } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub on its own port)';

const CAP = 400;
// The per-site headline widths, from the two console.js call sites: the rail passes 60, the board card
// takes splitHeadline's default. Named here so the display-bound assertion below reads as the geometry
// it actually is instead of two bare numbers.
const RAIL_MAX = 60, CARD_MAX = 80;

// A REAL report in the house shape, and every part of it load-bearing: the headline is short enough to
// render whole on the 60-char rail, and the whole line is comfortably past 80 so the old cap would
// have eaten the detail. Written as one string rather than assembled from a repeat() so what the test
// sends is what a session would actually send.
const HEAD = 'working: the doing-line cap';
const TAIL = 'this is the tail the old 80-character clamp ate';
const REPORT = HEAD + ' -- raised it to 400 so a report can carry its detail; '
    + 'the renderer already truncates for display, and ' + TAIL;

test('DOING CAP: a headline--detail report longer than the old 80 chars survives ingest whole',
    { skip: SKIP, timeout: 120000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('doing-cap hub');

        assert.ok(REPORT.length > 80 && REPORT.length < CAP,
            'fixture must sit between the old cap and the new one or it proves nothing: ' + REPORT.length);

        const me = await hub.post('/register', { cwd: hub.REPO, purpose: 'doing-cap probe' });
        assert.ok(me && me.uid, 'register failed: ' + JSON.stringify(me));
        assert.equal((await hub.post('/health', { uid: me.uid, context: 30, doing: REPORT })).ok, true);

        // BOTH projections, because a coordinator reads /roster and the console reads /board, and the
        // two have disagreed about this exact field before (test/rosterrow.test.mjs).
        const row = ((await hub.get('/roster')).live || []).find(r => r.callsign === me.callsign) || {};
        const card = ((await hub.get('/board')).boards || []).find(b => b.callsign === me.callsign) || {};
        assert.equal(row.doing, REPORT, '/roster truncated the report: ' + JSON.stringify(row.doing));
        assert.equal(card.doing, REPORT, '/board truncated the report: ' + JSON.stringify(card.doing));
        // Named separately from the equality above: this is the clause the old cap destroyed, so a
        // failure here should say so in words rather than as a diff of two long strings.
        assert.ok(String(row.doing).includes(TAIL), 'the tail past the old 80-char cut is gone again');

        // 2. STILL BOUNDED. A session that pastes a log tail into its status line gets cut at the cap
        //    -- the number moved, it did not stop existing. Removing the clamp altogether passes every
        //    assertion above and fails here, which is the point of testing both halves.
        const RUNAWAY = HEAD + ' -- ' + 'stack frame at jarvis-core.mjs; '.repeat(60);
        assert.ok(RUNAWAY.length > CAP * 2, 'the runaway fixture must be well past the cap');
        assert.equal((await hub.post('/health', { uid: me.uid, context: 31, doing: RUNAWAY })).ok, true);
        const cut = (((await hub.get('/roster')).live || []).find(r => r.callsign === me.callsign) || {}).doing;
        assert.equal(cut.length, CAP, 'the doing line is no longer bounded at ' + CAP + ' -- got ' + cut.length);
        assert.equal(cut, RUNAWAY.slice(0, CAP), 'it is bounded, but not by taking the first ' + CAP + ' characters');
    });

// No integration gate on this one: it is pure, so it runs in a plain `node --test` too.
test('DOING CAP: a stored line at the cap still renders as a bounded headline', () => {
    // The half that makes raising the cap safe, and the reason it is asserted in the gate rather than
    // left to the browser: the ONLY thing standing between a 400-character status line and Chris's
    // rail is the splitter. No hub needed -- splitHeadline is pure and exported, and this is the same
    // function console.js mirrors.
    //
    // The worst case is NOT the house shape. A `headline -- detail` line is cut at the separator, so
    // its headline is short by construction; the shape that can flood a row is the one with no
    // separator anywhere, which the browser verifier notes is still most of what is on the board.
    const runOn = 'working ' + 'and on and on '.repeat(40);
    const stored = runOn.slice(0, CAP);
    assert.equal(stored.length, CAP, 'this fixture must be exactly a capped value');

    for (const max of [RAIL_MAX, CARD_MAX]) {
        const p = splitHeadline(stored, max);
        // lim + 3: splitHeadline cuts at or before the limit and appends an ellipsis.
        assert.ok(p.headline.length <= max + 3,
            'a capped doing line renders ' + p.headline.length + ' chars at max ' + max);
        assert.equal(p.truncated, true, 'and it must report itself truncated at max ' + max);
        assert.ok(p.hasMore, 'so the caret is offered and the rest is reachable at max ' + max);
    }

    // And the house shape reaches the rail intact -- the actual improvement being bought here. HEAD is
    // under the rail width, so a session writing `headline -- detail` gets its whole headline shown and
    // its detail behind the caret, at the exact width the rail passes.
    const p = splitHeadline(REPORT, RAIL_MAX);
    assert.equal(p.headline, HEAD, 'the rail should show the headline verbatim, not a cut of it');
    assert.equal(p.truncated, false, 'a headline that fits must not be ellipsised');
    assert.ok(p.detail.includes(TAIL), 'and the detail behind the caret carries the rest');
});

test('DOING CAP: the instruction workers actually read matches the cap the hub enforces',
    { skip: SKIP, timeout: 120000 }, async (t) => {
        // A raised cap nobody is told about is inert: every worker was being instructed to send "one
        // short phrase", so the space would never have been used. This asserts the instruction exists
        // AND that the number in it is the number the code enforces -- a documented constant drifting
        // from its implementation is the rot this repo keeps rediscovering, and a doc cannot fail a
        // test on its own.
        //
        // Fetched from a LIVE HUB rather than read off disk, deliberately: GET /protocol serves
        // WORKER.md verbatim, and that being ONE file rather than two is precisely the kind of fact
        // that rots. If the route is ever rewired to a second copy, this stops proving anything about
        // what a worker reads -- so read it the way a worker does.
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('protocol-doc hub');

        const proto = await (await fetch(hub.origin + '/protocol')).text();
        assert.ok(proto.includes('POST /health'), 'GET /protocol is not serving the worker doc at all');
        assert.match(proto, /headline -- detail/,
            'the protocol never tells a worker the long doing-line shape, so the cap is unusable');
        assert.match(proto, /needs the separator/,
            'and it must say the separator is REQUIRED for the long form -- an unseparated 400-char'
            + ' line is just a truncated one, which is the complaint this all came from');

        // The two numbers, each measured from its own source.
        const doc = proto.match(/stores (\d+) characters/);
        assert.ok(doc, 'the protocol no longer states the stored length, so nothing pins it to the code');
        const code = readFileSync(new URL('../jarvis-core.mjs', import.meta.url), 'utf8')
            .match(/s\.doing = String\(b\.doing \|\| ''\)\.slice\(0, (\d+)\)/);
        assert.ok(code, 'the /health clamp is no longer spelled the way this test looks for it -- update it');
        assert.equal(Number(doc[1]), Number(code[1]),
            'the protocol promises ' + doc[1] + ' characters and the hub stores ' + code[1]);
        assert.equal(Number(code[1]), CAP, 'and both should be the cap this file pins');
    });
