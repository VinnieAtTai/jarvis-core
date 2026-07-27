// Unit tests for matchRepo in jarvis-text.mjs -- resolving a working directory to its configured
// repo row (repos.json).
//
// The bug it fixes, found live on 2026-07-25: repos.json marks the jarvis repo
// `permissionMode: "bypassPermissions"` and stores its path with forward slashes, but a session's cwd
// is the Windows path it booted in. resolveRepo compared the two case-insensitively and NOT
// separator-insensitively, so d:\claude\jarvis-core missed d:/claude/jarvis-core and every worker
// spawned there fell through to the `adhoc` repo -- silently losing permissionMode and tier. Chris
// had granted full permissions and was still being woken to approve routine commits.
// Run with `npm test` (node --test) -- no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRepo, repoRow } from '../jarvis-text.mjs';

// The live repos.json shape at the time of the fix.
const REPOS = {
    broker: { cwd: 'd:/code/tms', defaultPurpose: 'TMS broker work' },
    scratch: { cwd: 'd:/claude', defaultPurpose: 'scratch work' },
    jarvis: { cwd: 'd:/claude/jarvis-core', defaultPurpose: 'jarvis hub development', permissionMode: 'bypassPermissions' },
};

test('matchRepo -- THE BUG: a Windows backslash cwd resolves to its configured repo', () => {
    // What retireSession actually passes (s.cwd, as stored). Pre-fix this returned null -> adhoc.
    const r = matchRepo(REPOS, String.raw`d:\claude\jarvis-core`);
    assert.equal(r.key, 'jarvis');
    assert.equal(r.permissionMode, 'bypassPermissions', 'losing this is what woke Chris for every commit');
});

test('matchRepo -- the same repo resolves through every spelling of its path', () => {
    for (const spelling of [
        'd:/claude/jarvis-core',
        String.raw`d:\claude\jarvis-core`,
        String.raw`D:\Claude\Jarvis-Core`,
        'D:/CLAUDE/JARVIS-CORE/',
        'd:\\claude\\jarvis-core\\',      // trailing separator, as a shell or paste can produce
    ]) {
        assert.equal(matchRepo(REPOS, spelling).key, 'jarvis', spelling);
    }
});

test('matchRepo -- the broker repo was missing its backslash callers too', () => {
    assert.equal(matchRepo(REPOS, String.raw`d:\code\tms`).key, 'broker');
    assert.equal(matchRepo(REPOS, 'd:/code/tms').key, 'broker');
});

test('matchRepo -- a nested path is NOT its parent repo (exact directory only)', () => {
    // d:/claude is the `scratch` repo; jarvis-core lives inside it but is its own repo. Prefix
    // matching here would hand a jarvis worker scratch's config (and vice versa).
    assert.equal(matchRepo(REPOS, 'd:/claude/jarvis-core').key, 'jarvis');
    assert.equal(matchRepo(REPOS, 'd:/claude').key, 'scratch');
    assert.equal(matchRepo(REPOS, 'd:/claude/some-other-thing'), null);
});

test('matchRepo -- carries the whole row, key first, without mutating the store', () => {
    const before = JSON.stringify(REPOS);
    const r = matchRepo(REPOS, 'd:/code/tms');
    assert.deepEqual(r, { key: 'broker', cwd: 'd:/code/tms', defaultPurpose: 'TMS broker work' });
    assert.equal(JSON.stringify(REPOS), before);
});

test('matchRepo -- an unknown cwd returns null so the caller can fall back to adhoc', () => {
    assert.equal(matchRepo(REPOS, 'd:/somewhere/unconfigured'), null);
    assert.equal(matchRepo(REPOS, ''), null);
    assert.equal(matchRepo(REPOS, null), null);
    assert.equal(matchRepo(REPOS, undefined), null);
});

test('matchRepo -- a missing or malformed store returns null, never throws', () => {
    assert.equal(matchRepo(null, 'd:/code/tms'), null);
    assert.equal(matchRepo(undefined, 'd:/code/tms'), null);
    assert.equal(matchRepo({}, 'd:/code/tms'), null);
    // A half-written row must not take down a register or a spawn.
    assert.equal(matchRepo({ bad: null, worse: 'string', empty: {} }, 'd:/code/tms'), null);
    assert.equal(matchRepo({ bad: null, ok: { cwd: 'd:/code/tms' } }, String.raw`D:\Code\TMS`).key, 'ok');
});

// --- repoRow: writing a repos.json row through POST /repos -------------------------------------
// Found 2026-07-27 while probing whether a757af9 had deployed. The probe was "does a jarvis-core
// session read tier == trusted"; it read `guarded`, which looks exactly like a failed deploy. The
// actual cause: the jarvis row has NO tier field, and there was no way to give it one -- POST /repos
// never wrote tier, and hand-editing repos.json is forbidden (the hub is the only writer).

test('repoRow -- THE BUG: tier is settable at all, and only `trusted` counts', () => {
    // resolveRepo(cwd).tier feeds registerSession (session trust) and spawnWorker (effTier). Before
    // this, the field was live-read but unwritable through the API.
    const r = repoRow(REPOS.jarvis, { tier: 'trusted' });
    assert.equal(r.tier, 'trusted');
    assert.equal(r.permissionMode, 'bypassPermissions', 'the merge must not drop what it did not touch');
    // Guarded IS the absence of the field, and a typo must never persist as config.
    assert.equal('tier' in repoRow(r, { tier: 'guarded' }), false);
    assert.equal('tier' in repoRow(r, { tier: 'trused' }), false);
    assert.equal('tier' in repoRow(r, { tier: '' }), false);
});

test('repoRow -- THE OTHER BUG: a partial update keeps the fields it omits', () => {
    // Pre-fix the row was rebuilt from the body, so re-registering a repo to change one thing
    // silently erased the rest -- the same "config present in the file, dropped in transit" class of
    // bug as the slash mismatch above.
    const withTier = { ...REPOS.jarvis, tier: 'trusted', model: 'opus' };
    const r = repoRow(withTier, { name: 'jarvis', defaultPurpose: 'jarvis hub work' });
    assert.deepEqual(r, {
        cwd: 'd:/claude/jarvis-core',
        defaultPurpose: 'jarvis hub work',
        permissionMode: 'bypassPermissions',
        tier: 'trusted',
        model: 'opus',
    });
});

test('repoRow -- an empty value CLEARS an optional field, so bypass can be revoked', () => {
    const start = { ...REPOS.jarvis, tier: 'trusted', model: 'opus' };
    const off = repoRow(start, { permissionMode: '', model: null });
    assert.equal('permissionMode' in off, false, 'a repo must be removable from bypassPermissions');
    assert.equal('model' in off, false);
    assert.equal(off.tier, 'trusted', 'clearing one field must not clear the others');
    // Omitting a field is NOT clearing it -- that distinction is the whole point of the merge.
    assert.equal(repoRow(start, {}).permissionMode, 'bypassPermissions');
});

test('repoRow -- creating a brand new row from nothing', () => {
    assert.deepEqual(repoRow(undefined, { cwd: 'd:/code/other', tier: 'trusted' }), {
        cwd: 'd:/code/other', defaultPurpose: '', tier: 'trusted',
    });
    // defaultPurpose is always present so the console never renders `undefined`.
    assert.deepEqual(repoRow(null, { cwd: 'd:/code/other' }), { cwd: 'd:/code/other', defaultPurpose: '' });
});

test('repoRow -- pure: never mutates the row it was handed', () => {
    const prev = { ...REPOS.jarvis, tier: 'trusted' };
    const before = JSON.stringify(prev);
    repoRow(prev, { tier: 'guarded', permissionMode: '', cwd: 'd:/elsewhere' });
    assert.equal(JSON.stringify(prev), before);
});

test('repoRow -- a malformed body cannot corrupt or wipe an existing row', () => {
    const prev = { ...REPOS.jarvis, tier: 'trusted' };
    for (const bad of [null, undefined, 'string', 42]) {
        assert.deepEqual(repoRow(prev, bad), prev, String(bad));
    }
    // A non-string defaultPurpose is ignored rather than stringified into the board.
    assert.equal(repoRow(prev, { defaultPurpose: { oops: 1 } }).defaultPurpose, 'jarvis hub development');
});

test('repoRow -- the round trip a session actually makes: set tier, then resolve it back', () => {
    // The end-to-end point of the fix: POST /repos {name, tier} -> the row -> matchRepo -> the tier a
    // register reads. Pre-fix this chain had no way to produce anything but guarded.
    const repos = { ...REPOS, jarvis: repoRow(REPOS.jarvis, { tier: 'trusted' }) };
    assert.equal(matchRepo(repos, String.raw`d:\claude\jarvis-core`).tier, 'trusted');
    assert.equal(matchRepo(repos, String.raw`d:\code\tms`).tier, undefined, 'other repos stay guarded');
});
