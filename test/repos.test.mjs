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
import { matchRepo } from '../jarvis-text.mjs';

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
