// FOLDER TRUST: a worker must boot into its job, not into Claude Code's first-run trust dialog.
//
// The bug this pins, 2026-07-29: POST /spawn into d:/code/tms returned ok and a callsign, and the
// worker never registered -- no roster row at all, not ended, not booting, absent, with the pinned
// callsign burned. Three dispatches died that way and the failure was indistinguishable from a spawn
// that simply crashed. The workers were alive the whole time, stopped at "Quick safety check: Is this
// a project you created or one you trust?" in a brand-new worktree directory. That dialog fires before
// the model starts, so the boot prompt never runs; a console-less worker has nobody to press Enter.
//
// WHY IT ONLY BIT NON-JARVIS REPOS, measured with the real claude through node-pty rather than
// reasoned about: trust is inherited from an ANCESTOR directory. d:/claude is trusted, so all eleven
// jarvis worktrees under d:/claude/.jarvis-wt inherited it despite their own hasTrustDialogAccepted
// being false; d:/code is not trusted, so every broker worktree under it prompted. Also measured,
// because it is the plausible wrong answer: --permission-mode bypassPermissions does NOT suppress the
// dialog, so permissionMode was never the variable and giving broker bypassPermissions would not have
// fixed this. The fourth arm validated the cure: the same fresh untrusted directory with
// hasTrustDialogAccepted pre-set on that exact path starts clean, and the minimal one-key entry
// claudeTrustPatch writes is one Claude Code accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeTrustPatch } from '../jarvis-text.mjs';
import { createScratchHub, assertConsolelessPossible } from '../test-support/scratch-hub.mjs';

// A config with unrelated keys at both levels, because the property under test is as much about what
// SURVIVES as about what changes.
const CFG = () => ({
    numStartups: 385,
    mcpServers: { atlassian: { url: 'https://example.invalid' } },
    oauthAccount: { emailAddress: 'chris@example.invalid' },
    projects: {
        'd:/code/tms': { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'], lastCost: 0.64 },
        'd:/claude/.jarvis-wt/jarvis-foxtrot': { hasTrustDialogAccepted: false, exampleFiles: ['a.mjs'] },
    },
});

test('claudeTrustPatch -- THE BUG: a brand-new worktree path becomes trusted, and nothing else in the config moves', () => {
    const before = CFG();
    const after = claudeTrustPatch(before, 'd:/code/.jarvis-wt/broker-alpha-2');
    assert.equal(after.projects['d:/code/.jarvis-wt/broker-alpha-2'].hasTrustDialogAccepted, true);
    // every other key, at both levels, carried through verbatim
    assert.equal(after.numStartups, 385);
    assert.deepEqual(after.mcpServers, { atlassian: { url: 'https://example.invalid' } });
    assert.deepEqual(after.oauthAccount, { emailAddress: 'chris@example.invalid' });
    assert.deepEqual(after.projects['d:/code/tms'], { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'], lastCost: 0.64 });
    // and the input object is not mutated -- the caller still holds the on-disk truth if we bail
    assert.equal(before.projects['d:/code/.jarvis-wt/broker-alpha-2'], undefined);
});

test('claudeTrustPatch -- an EXISTING untrusted entry keeps its own fields; only the flag flips', () => {
    const after = claudeTrustPatch(CFG(), 'd:/claude/.jarvis-wt/jarvis-foxtrot');
    assert.deepEqual(after.projects['d:/claude/.jarvis-wt/jarvis-foxtrot'],
        { hasTrustDialogAccepted: true, exampleFiles: ['a.mjs'] });
});

test('claudeTrustPatch -- already trusted means null, so the hub never rewrites the file for nothing', () => {
    assert.equal(claudeTrustPatch(CFG(), 'd:/code/tms'), null);
});

test('claudeTrustPatch -- the key is spelled the way Claude Code spells it: forward slashes, CASE PRESERVED', () => {
    // Backslashes in, forward slashes out. Case is load-bearing: Claude Code keys projects by the cwd
    // string it was launched with and does NOT case-fold it (measured -- a probe launched in
    // C:/Users/... was recorded under exactly that spelling), so lower-casing here would write a key
    // it never reads and the fix would silently do nothing.
    const a = claudeTrustPatch({}, 'd:\\code\\.jarvis-wt\\broker-echo');
    assert.deepEqual(Object.keys(a.projects), ['d:/code/.jarvis-wt/broker-echo']);
    const b = claudeTrustPatch({}, 'C:/Users/Vinni/AppData/Local/Temp/Probe/');
    assert.deepEqual(Object.keys(b.projects), ['C:/Users/Vinni/AppData/Local/Temp/Probe']);
});

test('claudeTrustPatch -- unusable input is null, never a bogus key', () => {
    for (const bad of ['', '   ', null, undefined, 0]) assert.equal(claudeTrustPatch(CFG(), bad), null);
});

test('claudeTrustPatch -- a config shape it does not recognise is REFUSED, not rewritten', () => {
    // This is the human's live global config. Refusing costs one trust prompt -- the bug we already
    // have -- while guessing at a shape we have never seen costs him the file.
    for (const bad of [null, undefined, 'nope', 42, ['array']]) {
        assert.equal(claudeTrustPatch(bad, 'd:/x/y'), null, 'cfg ' + JSON.stringify(bad));
    }
    assert.equal(claudeTrustPatch({ projects: ['array'] }, 'd:/x/y'), null, 'projects must be an object');
    assert.equal(claudeTrustPatch({ projects: 'nope' }, 'd:/x/y'), null, 'projects must be an object');
    assert.equal(claudeTrustPatch({ projects: { 'd:/x/y': 'nope' } }, 'd:/x/y'), null, 'an entry must be an object');
    // a config with no projects key at all is a shape we DO understand -- claude writes it on first run
    assert.deepEqual(claudeTrustPatch({ numStartups: 1 }, 'd:/x/y'),
        { numStartups: 1, projects: { 'd:/x/y': { hasTrustDialogAccepted: true } } });
});

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (spawns a real hub and a ConPTY; ~25 seconds)';

// The ordering claim needs an observable taken at the moment claude STARTS, not after the dust
// settles -- "trusted eventually" is not the fix, because the dialog is decided at startup. So the
// claude stub snapshots the trust file as its very first act, before it becomes a worker at all. It
// finds the path through JARVIS_CLAUDE_CONFIG, which reaches it because pty-host passes the hub's own
// env down to the child.
function recordTrustSnapshot(hub) {
    writeFileSync(join(hub.BIN, 'trust-snapshot.mjs'), [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const out = { cwd: process.cwd(), trusted: null, err: null };",
        "try {",
        "    const j = JSON.parse(readFileSync(process.env.JARVIS_CLAUDE_CONFIG, 'utf8'));",
        "    out.trusted = Object.keys(j.projects || {}).filter(k => j.projects[k] && j.projects[k].hasTrustDialogAccepted === true);",
        "} catch (e) { out.err = String(e && e.message); }",
        "writeFileSync(join(process.env.JARVIS_DATA, 'trust-' + process.env.JARVIS_CALLSIGN + '.json'), JSON.stringify(out));",
    ].join('\r\n') + '\r\n');
    writeFileSync(join(hub.BIN, 'claude.cmd'), [
        '@echo off',
        'node "%~dp0trust-snapshot.mjs"',
        'node "%~dp0stub-worker.mjs"',
    ].join('\r\n') + '\r\n');
}

const snapshot = (hub, cs) => hub.waitFor('the trust snapshot claude took at startup for ' + cs, () => {
    const p = join(hub.DATA, 'trust-' + cs + '.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}, 60000);

// The worktree the hub actually made, read from the sys line it logs -- so the assertion is about the
// real path rather than one the test re-derives and could get wrong in the same way the code did.
const worktreePath = (hub, cs) => hub.waitFor('the worktree sys line for ' + cs, () => {
    const m = new RegExp('worktree for ' + cs + ':[^"]*? at ([^"\\\\]+)').exec(hub.transcript());
    return m ? m[1] : null;
}, 60000);

// A git repo with one commit, which is the minimum that git worktree add will fork from.
function initRepo(dir) {
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    git('init', '-b', 'main');
    git('-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base');
}

test('FOLDER TRUST: the hub marks the worktree it just created, and claude finds it ALREADY trusted at startup',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        assertConsolelessPossible();
        const home = mkdtempSync(join(tmpdir(), 'jarvis-trust-'));
        const cfgPath = join(home, 'claude.json');
        writeFileSync(cfgPath, JSON.stringify(CFG(), null, 2));
        const hub = await createScratchHub({ worktrees: true, env: { JARVIS_CLAUDE_CONFIG: cfgPath } });
        t.after(() => { hub.dispose(); try { rmSync(home, { recursive: true, force: true }); } catch { } });
        initRepo(hub.REPO);
        recordTrustSnapshot(hub);
        await hub.start();

        // parentProject is what makes this a sub-worker, and sub-workers are the ones that get isolated.
        const cs = await hub.spawnWorker({ cwd: hub.REPO, purpose: 'trust probe build', parentProject: 'probe' });
        const wt = await worktreePath(hub, cs);
        const snap = await snapshot(hub, cs);

        assert.equal(snap.err, null, 'the stub could read the trust config');
        // THE CLAIM: already trusted by the time claude started in there. Exact string, because a key
        // spelled differently is a key Claude Code never reads.
        assert.ok(snap.trusted.includes(wt),
            'claude started in ' + wt + ' with trusted=' + JSON.stringify(snap.trusted));
        // isolation really happened -- otherwise this would be a test of the shared cwd
        assert.notEqual(wt.toLowerCase().replace(/\\/g, '/'), hub.REPO.toLowerCase().replace(/\\/g, '/'));

        // and the rest of the file is intact on disk
        const after = JSON.parse(readFileSync(cfgPath, 'utf8'));
        assert.equal(after.numStartups, 385);
        assert.deepEqual(after.oauthAccount, { emailAddress: 'chris@example.invalid' });
        assert.deepEqual(after.projects['d:/code/tms'], { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'], lastCost: 0.64 });
    });

test('FOLDER TRUST: an UNPARSEABLE config is left exactly as it was, and the spawn still goes through',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        // The stakes are lopsided. A worker that meets the trust prompt costs one dispatch; a hub that
        // overwrites or truncates the human's global config costs him his whole Claude Code setup. So
        // an unreadable file must be left ALONE -- not repaired, not replaced with a minimal one -- and
        // must not take the spawn path down with it.
        assertConsolelessPossible();
        const home = mkdtempSync(join(tmpdir(), 'jarvis-trust-bad-'));
        const cfgPath = join(home, 'claude.json');
        const GARBAGE = '{ "projects": { "d:/code/tms": { truncated mid-write';
        writeFileSync(cfgPath, GARBAGE);
        const hub = await createScratchHub({ worktrees: true, env: { JARVIS_CLAUDE_CONFIG: cfgPath } });
        t.after(() => { hub.dispose(); try { rmSync(home, { recursive: true, force: true }); } catch { } });
        initRepo(hub.REPO);
        await hub.start();

        const cs = await hub.spawnWorker({ cwd: hub.REPO, purpose: 'trust probe build', parentProject: 'probe' });
        const row = await hub.waitFor(cs + ' to register anyway', async () => {
            const r = await hub.live(cs);
            return r && r.alive ? r : null;
        }, 60000);
        assert.ok(row, 'the worker registered, so the spawn path did not throw');
        assert.equal(readFileSync(cfgPath, 'utf8'), GARBAGE, 'the unparseable config was not touched');
    });
