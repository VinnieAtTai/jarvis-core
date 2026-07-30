// GET /search -- chat search over the transcript. Chris asked for it in one line ("a search for chats
// would be legit"); this pins what that turned out to mean.
//
// WHY THROUGH HTTP rather than a pure helper. Half the decisions here ARE the query string: that a
// blank q is a 400 and not an empty result set, that a typo'd kind name is rejected rather than
// silently matching nothing, that limit clamps instead of being believed. A pure function cannot fail
// those. So one scratch hub is booted for the whole file (a read-only route needs no ConPTY, so this
// costs seconds, not the ~40 the spawning tests do) and every case is a real request.
//
// The transcript is SEEDED on disk before the hub boots, because transcriptCache is loaded once at
// module load -- that is what buys controlled timestamps and kinds, which recording live never would.
//
// The assertion most worth having is the AND pair. A naive OR, and equally a naive "is q a substring
// of the line" implementation, both pass nearly every other case in this file; only the pair below
// separates them (see the test for which mutation each one catches).
//
// SKIPPED by default: it boots a real hub. Run it deliberately:
//
//     npm run test:search
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchHub } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub; a few seconds)';

// The route's own numbers, restated so a change to either side shows up as a failure here.
const LIMIT_DEFAULT = 50, LIMIT_MAX = 200;

const SPEECH_TS = '2026-01-03T00:00:00.000Z';
// `zqx` isolates these lines from anything the hub records at boot, so a count can be exact.
const SEED = [
    // THE AND PAIR: one term each, never a hit for both.
    { ts: '2026-01-01T00:00:00.000Z', kind: 'chat', from: 'jarvis', text: 'zqx alpha on its own' },
    { ts: '2026-01-02T00:00:00.000Z', kind: 'chat', from: 'jarvis', text: 'zqx beta on its own' },
    // Both terms, SEPARATED and in caps -- so a case-sensitive match misses it, and so does one that
    // looks for the whole query as a single substring.
    { ts: SPEECH_TS, kind: 'speech', text: 'zqx ALPHA in between BETA together' },
    { ts: '2026-01-04T00:00:00.000Z', kind: 'tts', from: 'jarvis', text: 'zqx alpha beta spoken' },
    // Machinery. Excluded by default; reachable only when the search is widened.
    { ts: '2026-01-05T00:00:00.000Z', kind: 'sys', text: 'zqx alpha beta machinery' },
    { ts: '2026-01-06T00:00:00.000Z', kind: 'task', from: 'whiskey', text: 'zqx alpha beta card moved' },
    // Newest conversation line, and the only one carrying a mission.
    { ts: '2026-01-07T00:00:00.000Z', kind: 'chat', from: 'india', to: 'whiskey', missionId: 'm_zulu', text: 'zqx alpha beta mission line' },
];
// Filler for the ordering and limit cases, on a token of its own (`wubwub`) so it cannot leak into any
// count above. Deliberately more than LIMIT_MAX, or the cap would never actually be exercised.
const BULK = 250;
const BULK_BASE = Date.UTC(2026, 1, 1);
for (let i = 0; i < BULK; i++) {
    SEED.push({ ts: new Date(BULK_BASE + i * 1000).toISOString(), kind: 'chat', from: 'jarvis', text: 'wubwub filler ' + i });
}

let hub = null;
// Raw, because the status code is the claim in several cases and hub.get() only hands back a body.
const raw = async (path) => {
    const r = await fetch(hub.origin + path);
    return { status: r.status, body: await r.json() };
};
const search = async (qs) => (await raw('/search?' + qs)).body;
const textsOf = (r) => r.results.map(h => h.text);

before(async () => {
    if (SKIP) return;
    hub = await createScratchHub();
    writeFileSync(join(hub.DATA, 'transcript.jsonl'), SEED.map(e => JSON.stringify(e)).join('\n') + '\n');
    await hub.start('search hub');
});
after(() => { if (hub) hub.dispose(); });

test('SEARCH: terms are ANDed -- a line holding only ONE of them is not a hit', { skip: SKIP }, async () => {
    const r = await search('q=zqx%20alpha%20beta');
    // An OR implementation returns these two as well, and nothing else in this file notices.
    assert.deepEqual(textsOf(r).filter(t => /on its own/.test(t)), [],
        'a line with only one of the two terms came back -- the terms are being ORed, not ANDed');
    assert.equal(r.total, 3);
    assert.equal(r.results.length, 3);
});

test('SEARCH: case-insensitive in BOTH directions, and terms need not be adjacent', { skip: SKIP }, async () => {
    // `alpha` is lowercase in the query against ALPHA in the line; `BETWEEN` is the reverse. Because
    // the terms are ANDed, folding only one side of the comparison fails this.
    const r = await search('q=alpha%20BETWEEN');
    assert.equal(r.total, 1);
    assert.equal(r.results[0].ts, SPEECH_TS);
    // And the pair is not adjacent in the line, which is what kills "q as one substring".
    assert.equal((await search('q=zqx%20alpha%20beta')).results.some(h => h.ts === SPEECH_TS), true,
        'the line holding both terms non-adjacently was missed -- q is being matched as one substring');
});

test('SEARCH: substring, not word boundary -- a mid-word fragment hits', { skip: SKIP }, async () => {
    // Anchored on the nonce so the count cannot be disturbed by whatever sys lines the hub logs at boot.
    const r = await search('q=zqx%20machin&kinds=sys');
    assert.equal(r.total, 1);
    assert.match(r.results[0].text, /machinery/);
});

test('SEARCH: sys and task are EXCLUDED by default -- machinery must not bury the conversation', { skip: SKIP }, async () => {
    const r = await search('q=zqx%20alpha%20beta');
    // Widened DELIBERATELY when worker-to-worker /send began recording as kind 'msg' (test/send.test.mjs):
    // that traffic IS conversation, and the incident behind recording it was a coordinator searching the
    // DEFAULT way for a delegate's report. sys and task stay out -- they are the formulaic machinery this
    // test is actually about, and nothing here weakens that half.
    assert.deepEqual(r.kinds, ['speech', 'chat', 'tts', 'msg']);
    assert.deepEqual(r.results.map(h => h.srcKind).sort(), ['chat', 'speech', 'tts']);
});

test('SEARCH: kinds widens -- all reaches the machinery, and a named list reaches only it', { skip: SKIP }, async () => {
    const all = await search('q=zqx%20alpha%20beta&kinds=all');
    assert.equal(all.total, 5, 'kinds=all should add the sys and task lines to the three conversation ones');
    assert.deepEqual(all.results.map(h => h.srcKind), ['chat', 'task', 'sys', 'tts', 'speech']);
    const machinery = await search('q=zqx%20alpha%20beta&kinds=sys,task');
    assert.deepEqual(machinery.results.map(h => h.srcKind), ['task', 'sys']);
});

test('SEARCH: NEWEST FIRST', { skip: SKIP }, async () => {
    const r = await search('q=wubwub%20filler&limit=5');
    assert.deepEqual(textsOf(r), [
        'wubwub filler 249', 'wubwub filler 248', 'wubwub filler 247', 'wubwub filler 246', 'wubwub filler 245',
    ]);
    // The five above are all `chat`, so they cannot show that ordering holds ACROSS kinds -- a walk
    // that grouped by kind would satisfy them. This spans every seeded kind instead. (The first cut of
    // this test restated descending-ts over the same five lines; no mutation could kill that without
    // killing the deepEqual above it, so it was pinning nothing and became this.)
    const mixed = await search('q=zqx%20alpha&kinds=all&limit=' + LIMIT_MAX);
    const ts = mixed.results.map(h => h.ts);
    assert.equal(ts.length, 6, 'expected all six seeded lines holding both zqx and alpha');
    assert.deepEqual(ts, [...ts].sort().reverse(), 'newest-first does not hold once the kinds are mixed');
});

test('SEARCH: limit has a default and a HARD CAP, and says how many it did not show', { skip: SKIP }, async () => {
    const dflt = await search('q=wubwub%20filler');
    assert.equal(dflt.results.length, LIMIT_DEFAULT);
    assert.equal(dflt.total, BULK, 'total must count every match, not just the page returned');
    assert.equal(dflt.truncated, true);

    const over = await search('q=wubwub%20filler&limit=1000');
    assert.equal(over.results.length, LIMIT_MAX, 'a limit above the cap was honoured');
    assert.equal(over.limit, LIMIT_MAX, 'the clamped limit must be reported back, not the one asked for');

    // Under the cap the caller gets what it asked for, and an untruncated page says so.
    const exact = await search('q=zqx%20alpha%20beta&limit=3');
    assert.equal(exact.results.length, 3);
    assert.equal(exact.truncated, false);
});

test('SEARCH: a blank q is a 400, never a confident empty result set', { skip: SKIP }, async () => {
    for (const qs of ['', 'q=', 'q=%20%20%09']) {
        const r = await raw('/search?' + qs);
        assert.equal(r.status, 400, 'GET /search?' + qs + ' should be rejected, not answered with no hits');
        assert.match(r.body.error, /q required/);
    }
});

test('SEARCH: an unknown kind is a 400 -- a typo must not look like "no such chat"', { skip: SKIP }, async () => {
    const r = await raw('/search?q=zqx&kinds=speach');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /unknown kind: speach/);
    // The valid names are in the message, so the caller can fix it without reading the source.
    assert.match(r.body.error, /speech/);
});

test('SEARCH: from and missionId narrow, and from matches the WHO the console shows', { skip: SKIP }, async () => {
    const mine = await search('q=zqx%20alpha%20beta&from=you');
    assert.deepEqual(mine.results.map(h => h.ts), [SPEECH_TS], 'from=you should find his own speech and nothing else');
    const byCallsign = await search('q=zqx%20alpha%20beta&from=india');
    assert.deepEqual(byCallsign.results.map(h => h.srcKind), ['chat']);
    const mission = await search('q=zqx%20alpha%20beta&missionId=m_zulu');
    assert.deepEqual(mission.results.map(h => h.missionId), ['m_zulu']);
});

test('SEARCH: a hit IS /transcript\'s projection, so a console box needs no new rendering code', { skip: SKIP }, async () => {
    const rendered = (await hub.get('/transcript?limit=0')).find(e => e.ts === SPEECH_TS);
    const hit = (await search('q=alpha%20BETWEEN')).results[0];
    const { srcKind, ...common } = hit;
    assert.deepEqual(common, rendered, 'the search projection has drifted from /transcript, so the two now render differently');
    assert.equal(srcKind, 'speech', 'srcKind is the one addition: /transcript collapses non-sys kinds to msg');
});
