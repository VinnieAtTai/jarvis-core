// The transcript ARCHIVE -- what trimTranscript() does with the lines it takes off the front of the
// display cache, and whether GET /search can still find them.
//
// WHY THIS FILE EXISTS. trimTranscript() rewrote transcript.jsonl from the trimmed cache, so every line
// past CACHE_CAP was DELETED. Harmless while the transcript was a scroll-back buffer; the day GET
// /search shipped it became the searchable record of every conversation, and the cap measured out at
// seven days (5510 lines, oldest 2026-07-22, on the live hub). A search sold as covering months could
// only ever see the last week. These tests pin the fix: nothing is dropped, and what was dropped is
// still findable.
//
// WHY THROUGH HTTP AND THROUGH A REAL BOOT rather than calling trimTranscript() directly. The trim is
// not exported, and more to the point the interesting behaviour IS the boot: the cache is loaded from
// disk once at module load and trimmed immediately, so seeding an oversized transcript and starting a
// hub exercises the real ordering (archive first, transcript rewrite second) end to end. A unit test of
// a hand-called helper would have missed the boot-time TDZ that the first cut of this fix shipped with.
//
// SKIPPED by default: it boots real hubs. Run it deliberately:
//
//     npm run test:archive
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchHub } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots real hubs; ~15s)';

// jarvis-core's own numbers, restated so a change to either side shows up as a failure here.
const CACHE_CAP = 5000, CACHE_SLACK = 1000;
const ARCHIVE_CHUNK_BYTES = 1024 * 1024;
const LIMIT_DEFAULT = 50, LIMIT_MAX = 200;

const ARCHIVE_FILE = 'transcript-archive.jsonl';
const ser = (e) => JSON.stringify(e);
// Nonce tokens, so a count can be exact: nothing the hub records at boot can contain these.
const ARC = 'arcnonce', CACHED = 'cachenonce', SEAM = 'seamnonce', DEEP = 'zzdeepline';
// Pad every line out to ~180 bytes. The point is BYTES, not lines: the archived half has to exceed
// ARCHIVE_CHUNK_BYTES or the backward reader never stitches a second slice and the seam it is most
// likely to lose a line at is never exercised.
const PAD = 'x'.repeat(110);

// 9000 archived + 5000 cached = 14000 seeded lines, so the boot trim drops exactly 9000 (~1.6 MB).
const ARC_N = 9000, CACHE_N = CACHE_CAP;
const ARC_BASE = Date.UTC(2026, 0, 1), CACHE_BASE = Date.UTC(2026, 1, 1);

const arcSeed = [];
for (let i = 0; i < ARC_N; i++) {
    arcSeed.push({ ts: new Date(ARC_BASE + i * 1000).toISOString(), kind: 'chat', from: 'jarvis', text: ARC + ' ' + i + ' ' + PAD });
}
// One line buried deep in the archive, on a token of its own, and `speech` rather than `chat` so the
// archive walk's projection (who: 'you') is under test too and not just its filtering.
arcSeed[100] = { ts: new Date(ARC_BASE + 100 * 1000).toISOString(), kind: 'speech', text: ARC + ' ' + DEEP + ' only in the archive ' + PAD };

const cacheSeed = [];
for (let j = 0; j < CACHE_N; j++) {
    cacheSeed.push({ ts: new Date(CACHE_BASE + j * 1000).toISOString(), kind: 'chat', from: 'jarvis', text: CACHED + ' ' + j + ' ' + PAD });
}
// Six SEAM lines: the three newest archived and the three oldest cached. Straddling the boundary is the
// whole point -- it is the one arrangement that can tell "cache walk then archive walk" apart from the
// reverse, which every other ordering assertion in here would accept.
const seamTs = [];
for (const k of [ARC_N - 3, ARC_N - 2, ARC_N - 1]) { arcSeed[k].text = SEAM + ' archived ' + k + ' ' + PAD; seamTs.push(arcSeed[k].ts); }
for (const k of [0, 1, 2]) { cacheSeed[k].text = SEAM + ' cached ' + k + ' ' + PAD; seamTs.push(cacheSeed[k].ts); }
const SEAM_EXPECTED = [...seamTs].sort().reverse();   // newest first, cached three then archived three
// The three newest archived lines had their text replaced above, so they no longer carry ARC. Every
// archived line is still READ (archive.lines), but only these many MATCH -- two different claims, and
// keeping them separate is what makes the counts below able to tell a lost line from a filtered one.
const ARC_MATCHES = ARC_N - 3;

const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);

describe('the boot trim archives instead of deleting, and search reads what it archived', () => {
    let hub = null;
    before(async () => {
        if (SKIP) return;
        hub = await createScratchHub();
        writeFileSync(join(hub.DATA, 'transcript.jsonl'), [...arcSeed, ...cacheSeed].map(ser).join('\n') + '\n');
        await hub.start('archive hub');
    });
    after(() => { if (hub) hub.dispose(); });

    test('ARCHIVE: the trim MOVES the front of the transcript, byte for byte -- it does not delete it', { skip: SKIP }, async () => {
        // The pre-fix behaviour is a passing transcript assertion and an archive that does not exist, so
        // the archive is checked first and by content, not by "is it non-empty".
        const arch = lines(join(hub.DATA, ARCHIVE_FILE));
        assert.equal(arch.length, ARC_N, 'the archive should hold exactly the ' + ARC_N + ' lines the trim dropped');
        assert.deepEqual(arch, arcSeed.map(ser), 'archived lines differ from the seeded ones -- the trim is not round-tripping them');

        // The cache is still capped (that half was never the bug), and the boot's own sys lines sit on
        // top of it, so the assertion is on the FRONT of the file rather than its length.
        const tr = lines(join(hub.DATA, 'transcript.jsonl'));
        assert.ok(tr.length >= CACHE_CAP, 'transcript fell below the cap: ' + tr.length);
        assert.ok(tr.length < CACHE_CAP + CACHE_SLACK, 'transcript was not trimmed to the cap: ' + tr.length);
        assert.deepEqual(tr.slice(0, CACHE_N), cacheSeed.map(ser), 'the retained lines are not the newest ' + CACHE_N);

        // And the two halves together are still the whole thing: no line lost, none duplicated, order kept.
        assert.deepEqual([...arch, ...tr.slice(0, CACHE_N)], [...arcSeed, ...cacheSeed].map(ser));
    });

    test('ARCHIVE: /search finds a line that is NO LONGER IN THE CACHE', { skip: SKIP }, async () => {
        // The bug, stated as a test. Before the fix this line did not exist anywhere to be found.
        const r = await hub.get('/search?q=' + DEEP);
        assert.equal(r.total, 1, 'the archived line was not found -- search is still cache-only');
        assert.match(r.results[0].text, new RegExp(DEEP));
        assert.equal(r.results[0].ts, arcSeed[100].ts);
        assert.equal(r.results[0].who, 'you', 'an archived speech line must project the same as a cached one');
        assert.equal(r.results[0].srcKind, 'speech');
        assert.equal(r.archive.searched, true);

        // It really is gone from the cache -- otherwise the hit above proves nothing about the archive.
        const shown = await hub.get('/transcript?limit=0');
        assert.equal(shown.some(e => new RegExp(DEEP).test(e.text || '')), false,
            'the line is still in the display cache, so this test is not exercising the archive at all');
    });

    test('ARCHIVE: every archived line is reachable -- nothing is lost at a slice boundary', { skip: SKIP }, async () => {
        const r = await hub.get('/search?q=' + ARC + '&limit=' + LIMIT_MAX);
        // Off-by-one at the stitch loses one line per slice, silently. An exact count is the only
        // assertion that catches it; "did we get some results" would not. archive.lines is the sharper
        // of the two -- it counts what was READ, so it cannot be satisfied by a filter change.
        assert.equal(r.archive.lines, ARC_N, 'the reader saw ' + r.archive.lines + ' of ' + ARC_N + ' archived lines -- it is dropping lines at a slice boundary');
        assert.equal(r.total, ARC_MATCHES, 'every archived line carrying the term should be a hit');
        assert.ok(r.archive.bytes > ARCHIVE_CHUNK_BYTES,
            'the archive fixture (' + r.archive.bytes + 'B) fits in one slice, so no boundary was ever crossed and this test is vacuous');
        assert.equal(r.archive.capped, false, 'the fixture should be well under the scan cap');
        assert.equal(r.results.length, LIMIT_MAX);
    });

    test('ARCHIVE: newest-first holds ACROSS the cache/archive seam', { skip: SKIP }, async () => {
        const r = await hub.get('/search?q=' + SEAM);
        const ts = r.results.map(h => h.ts);
        assert.equal(r.total, 6);
        assert.deepEqual(ts, SEAM_EXPECTED, 'results are not newest-first across the seam -- the archive walk is being concatenated on the wrong side of the cache walk');
        // Said the other way too, so a fixture edit cannot quietly make the deepEqual above tautological.
        assert.deepEqual(r.results.slice(0, 3).map(h => /cached/.test(h.text)), [true, true, true]);
        assert.deepEqual(r.results.slice(3).map(h => /archived/.test(h.text)), [true, true, true]);
    });

    test('ARCHIVE: total counts archived hits past the page, so "50 of N" stays honest', { skip: SKIP }, async () => {
        const r = await hub.get('/search?q=' + ARC);
        assert.equal(r.results.length, LIMIT_DEFAULT);
        assert.equal(r.total, ARC_MATCHES, 'total must count matches in the archive, not just the ones it returned');
        assert.equal(r.truncated, true);
        // A cache-only total would be 0 here, which is the specific lie this pins.
        assert.ok(r.total > LIMIT_DEFAULT);
    });

    test('ARCHIVE: an archived hit has the SAME shape as a cached one', { skip: SKIP }, async () => {
        // /transcript cannot be the reference for an archived line (it is not in the cache), so a cached
        // hit is -- and search.test.mjs already pins the cached hit against /transcript.
        const cached = (await hub.get('/search?q=' + CACHED + '&limit=1')).results[0];
        const archived = (await hub.get('/search?q=' + DEEP)).results[0];
        assert.deepEqual(Object.keys(archived).sort(), Object.keys(cached).sort(),
            'the archive walk projects different fields from the cache walk, so results render inconsistently');
    });
});

describe('the scan is bounded, and says so', () => {
    let hub = null;
    // ~72 KB of archive against an 8 KB cap: capped, and capped by a wide enough margin that the oldest
    // lines are unambiguously out of reach.
    const CAP = 8192, N = 400;
    const seed = [];
    for (let i = 0; i < N; i++) {
        seed.push({ ts: new Date(Date.UTC(2025, 0, 1) + i * 1000).toISOString(), kind: 'chat', from: 'jarvis', text: 'capnonce ' + i + ' ' + PAD });
    }
    before(async () => {
        if (SKIP) return;
        hub = await createScratchHub({ env: { JARVIS_ARCHIVE_SCAN_CAP: String(CAP) } });
        // Seeded DIRECTLY: this is the reader's contract, not the trim's, and a fixture big enough to
        // need trimming would drown the numbers being asserted.
        writeFileSync(join(hub.DATA, ARCHIVE_FILE), seed.map(ser).join('\n') + '\n');
        await hub.start('capped hub');
    });
    after(() => { if (hub) hub.dispose(); });

    test('ARCHIVE: the byte cap is REAL and REPORTED, and it keeps the NEWEST end', { skip: SKIP }, async () => {
        const r = await hub.get('/search?q=capnonce&limit=' + LIMIT_MAX);
        assert.equal(r.archive.capped, true, 'a 72 KB archive against an 8 KB cap should report capped');
        assert.equal(r.archive.cap, CAP, 'the cap in force must be reported, not the default');
        assert.ok(r.archive.bytes <= CAP, 'the scan read ' + r.archive.bytes + 'B against a ' + CAP + 'B cap -- the bound is decorative');
        assert.ok(r.total > 0 && r.total < N, 'expected a partial answer, got ' + r.total + ' of ' + N);
        assert.ok(r.archive.oldestScannedTs, 'a capped scan must say how far back it actually got');

        // Backwards, not forwards: the newest line is in reach and the oldest is not. A reader that
        // capped from the FRONT of the file passes every assertion above and fails these two.
        const texts = r.results.map(h => h.text);
        assert.ok(texts.some(t => t.startsWith('capnonce ' + (N - 1) + ' ')), 'the newest archived line was not reachable');
        assert.equal(texts.some(t => t.startsWith('capnonce 0 ')), false, 'the oldest line came back from beyond the cap');
        assert.equal(r.archive.oldestScannedTs, seed[N - r.total].ts, 'oldestScannedTs does not line up with the oldest line actually returned');
    });
});

describe('a crash between the archive append and the transcript rewrite', () => {
    let hub = null;
    // The exact crash: the archive took the batch, the transcript was never rewritten. On the next boot
    // the same splice recomputes the same batch, and appending it again would DOUBLE it.
    const TOTAL = CACHE_CAP + CACHE_SLACK + 500;      // 6500 -> the boot trim drops 1500
    const CUT = TOTAL - CACHE_CAP;
    const seed = [];
    for (let i = 0; i < TOTAL; i++) {
        seed.push({ ts: new Date(Date.UTC(2025, 5, 1) + i * 1000).toISOString(), kind: 'chat', from: 'jarvis', text: 'replaynonce ' + i + ' ' + PAD });
    }
    before(async () => {
        if (SKIP) return;
        hub = await createScratchHub();
        writeFileSync(join(hub.DATA, 'transcript.jsonl'), seed.map(ser).join('\n') + '\n');
        writeFileSync(join(hub.DATA, ARCHIVE_FILE), seed.slice(0, CUT).map(ser).join('\n') + '\n');
        await hub.start('replay hub');
    });
    after(() => { if (hub) hub.dispose(); });

    test('ARCHIVE: an already-archived batch is not appended twice', { skip: SKIP }, async () => {
        const arch = lines(join(hub.DATA, ARCHIVE_FILE));
        assert.equal(arch.length, CUT, 'the batch was archived twice: ' + arch.length + ' lines instead of ' + CUT);
        assert.deepEqual(arch, seed.slice(0, CUT).map(ser));

        // Through the search too, because a duplicated archive is a duplicated result list -- which is
        // what the human would actually see.
        const r = await hub.get('/search?q=replaynonce&limit=1');
        assert.equal(r.total, TOTAL, 'expected each seeded line once across cache + archive, got ' + r.total);

        // The skip has to be the REASON, not a coincidence: without this the test also passes if the trim
        // never ran at all.
        const crash = existsSync(join(hub.DATA, 'crash.log')) ? readFileSync(join(hub.DATA, 'crash.log'), 'utf8') : '';
        assert.match(crash, /transcript-archive-replay/, 'the replay guard never fired, so something else explains the count');
        const tr = lines(join(hub.DATA, 'transcript.jsonl'));
        assert.deepEqual(tr.slice(0, CACHE_CAP), seed.slice(CUT).map(ser), 'the transcript was not trimmed on this boot');
    });
});

describe('the RUNTIME trim, which is the one that actually happens', () => {
    let hub = null;
    // Every other suite here seeds an oversized transcript and lets the boot trim fire. That is the rare
    // path -- it only happens after a run that predates the cap. In production the trim fires from
    // record(), mid-conversation, once the cache drifts CACHE_SLACK past the cap. Same function, but
    // "same function" is an inference, and the whole reason this bug survived a review is that the
    // dangerous line looked safe in isolation.
    //
    // Seeded 100 short of the trigger so the boot canNOT trim (the hub records a handful of sys lines of
    // its own on the way up, which is also why the margin is 100 and not 1), then driven over the line
    // one recorded chat at a time.
    const SEEDED = CACHE_CAP + CACHE_SLACK - 100;
    const seed = [];
    for (let i = 0; i < SEEDED; i++) {
        seed.push({ ts: new Date(Date.UTC(2025, 10, 1) + i * 1000).toISOString(), kind: 'chat', from: 'jarvis', text: 'livenonce ' + i + ' ' + PAD });
    }
    before(async () => {
        if (SKIP) return;
        hub = await createScratchHub();
        writeFileSync(join(hub.DATA, 'transcript.jsonl'), seed.map(ser).join('\n') + '\n');
        await hub.start('runtime trim hub');
    });
    after(() => { if (hub) hub.dispose(); });

    test('ARCHIVE: a trim triggered by record() archives too, and loses nothing', { skip: SKIP }, async () => {
        const archPath = join(hub.DATA, ARCHIVE_FILE);
        assert.equal(existsSync(archPath), false,
            'the boot trim already fired, so this suite is retesting the boot path instead of the runtime one');

        // POST /send to human is the cheapest thing that reaches record(): it needs no registered
        // session, and an unknown `from` is simply labelled jarvis.
        let posts = 0;
        for (; posts < 400 && !existsSync(archPath); posts++) {
            await hub.post('/send', { from: 'probe', to: 'human', text: 'drive the cache over the cap ' + posts });
        }
        assert.ok(existsSync(archPath), 'recorded ' + posts + ' lines past the cap and the archive was never created');
        assert.ok(posts > 1, 'the archive appeared before any line was recorded, so the boot trim did this');

        // Byte-identical, oldest-first, in order -- and a PREFIX of the seed, which is the shape that
        // says "the front was moved" rather than "something was written".
        const arch = lines(archPath);
        assert.deepEqual(arch, seed.slice(0, arch.length).map(ser), 'the runtime trim archived something other than the oldest lines, in order');
        assert.ok(arch.length > CACHE_SLACK, 'expected the trim to drop the slack in one go, got ' + arch.length);

        // The claim that matters: after a runtime trim, every seeded line is STILL findable -- some from
        // the cache, the rest from the archive. Before the fix this number would be arch.length short.
        const r = await hub.get('/search?q=livenonce&limit=1');
        assert.equal(r.total, SEEDED, 'lines went missing across a runtime trim: found ' + r.total + ' of ' + SEEDED);
        assert.ok(r.archive.lines >= arch.length, 'the search did not read the archive the runtime trim just wrote');

        // And the cache really did shrink, so the total above is genuinely spanning both halves.
        const shown = await hub.get('/transcript?limit=0');
        assert.ok(shown.length <= CACHE_CAP, 'the cache was not capped: ' + shown.length);
    });
});

describe('an archive that cannot be written', () => {
    let hub = null;
    const TOTAL = CACHE_CAP + CACHE_SLACK + 200;
    const seed = [];
    for (let i = 0; i < TOTAL; i++) {
        seed.push({ ts: new Date(Date.UTC(2025, 8, 1) + i * 1000).toISOString(), kind: 'chat', from: 'jarvis', text: 'unwritable ' + i + ' ' + PAD });
    }
    before(async () => {
        if (SKIP) return;
        hub = await createScratchHub();
        writeFileSync(join(hub.DATA, 'transcript.jsonl'), seed.map(ser).join('\n') + '\n');
        // A DIRECTORY where the archive file belongs: every append to it throws, deterministically, with
        // no need to fake a full disk or revoke an ACL.
        mkdirSync(join(hub.DATA, ARCHIVE_FILE), { recursive: true });
        await hub.start('unwritable hub');
    });
    after(() => { if (hub) hub.dispose(); });

    test('ARCHIVE: if the archive refuses the batch, the trim is ABANDONED rather than completed lossily', { skip: SKIP }, async () => {
        // The whole point of the fix is that no line leaves the transcript without a home. An over-cap
        // cache is bounded and retried; a trim that completed after a failed append is the old bug.
        const tr = lines(join(hub.DATA, 'transcript.jsonl'));
        assert.ok(tr.length >= TOTAL, 'the transcript was trimmed anyway -- ' + tr.length + ' lines, expected at least ' + TOTAL);
        assert.deepEqual(tr.slice(0, TOTAL), seed.map(ser), 'lines were dropped despite the archive being unwritable');

        const crash = readFileSync(join(hub.DATA, 'crash.log'), 'utf8');
        assert.match(crash, /transcript-archive-append-failed/, 'the failure was swallowed silently');

        // And the search says the archive is unreadable rather than quietly answering from the cache as
        // if that were all of history.
        const r = await hub.get('/search?q=unwritable&limit=1');
        assert.ok(r.archive.error, 'a search over an unreadable archive must report the error, not imply completeness');
        assert.equal(r.total, TOTAL, 'every line is still in the cache, so every one should be a hit');
    });
});
