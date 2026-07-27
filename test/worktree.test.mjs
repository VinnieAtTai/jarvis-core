// Unit tests for the pure half of per-worker git worktree isolation (jarvis-text.mjs).
//
// The problem, Chris 2026-07-24: every worker the hub spawned ran `claude` with cwd = repo.cwd, so
// two workers -- or a worker and Chris -- edited the SAME working tree. Uncommitted WIP clobbers,
// branch churn, and a worker trampling whatever he had open in d:/code/tms. The fix gives each
// code-mutating sub-worker its own `git worktree` + `jarvis/<callsign>` branch; these helpers decide
// where it goes, what it forks from, who gets one, and what is safe to sweep.
//
// Everything here is naming and policy, which is exactly the part that fails SILENTLY: a bad path
// puts a worktree inside a repo, a missed collision drops a worker back into the shared checkout
// with no error anywhere. Run with `npm test` (node --test) -- no server boot, no git, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worktreeRoot, worktreeBase, worktreePlan, shouldIsolate, orphanWorktrees } from '../jarvis-text.mjs';

// --- worktreeRoot: worktrees must live OUTSIDE every repo --------------------------------------

test('worktreeRoot -- THE INVARIANT: the root is a sibling of the repo, never inside it', () => {
    // A worktree under d:/code/tms would show up as untracked noise in `git status` in exactly the
    // checkout this feature exists to keep clean.
    assert.equal(worktreeRoot('d:/code/tms'), 'd:/code/.jarvis-wt');
    assert.equal(worktreeRoot('d:/claude/jarvis-core'), 'd:/claude/.jarvis-wt');
    for (const r of ['d:/code/tms', 'd:/claude/jarvis-core']) {
        assert.equal(worktreeRoot(r).startsWith(r + '/'), false, r + ' worktrees must not nest in the repo');
    }
});

test('worktreeRoot -- every spelling of a cwd lands on the same root', () => {
    // Roster cwds are Windows paths (backslashes, sometimes trailing); repos.json is forward-slashed.
    // The same repo resolving to two roots would hide half its worktrees from the boot sweep.
    const want = 'd:/claude/.jarvis-wt';
    for (const spelling of [
        'd:/claude/jarvis-core',
        String.raw`d:\claude\jarvis-core`,
        'd:/claude/jarvis-core/',
        'd:\\claude\\jarvis-core\\',      // trailing separator, as a shell or paste can produce
    ]) assert.equal(worktreeRoot(spelling), want, spelling);
});

test('worktreeRoot -- a drive root or garbage has no safe sibling, so: null (share the cwd)', () => {
    // Returning something here would put worktrees at the filesystem root, or worse next to it.
    for (const bad of ['d:', 'd:/', '', null, undefined, '/', 42]) assert.equal(worktreeRoot(bad), null, String(bad));
});

test('worktreeRoot -- JARVIS_WT_ROOT wins, so worktrees can be parked on another disk', () => {
    assert.equal(worktreeRoot('d:/code/tms', 'e:/wt'), 'e:/wt');
    assert.equal(worktreeRoot('d:/code/tms', 'e:\\wt\\'), 'e:/wt');
});

// --- worktreeBase: what the worker's branch forks from ------------------------------------------

test('worktreeBase -- THE BUG IT PREVENTS: a DETACHED HEAD is not a branch name', () => {
    // `rev-parse --abbrev-ref HEAD` literally answers "HEAD" when detached. Forking from that string
    // creates a branch off a nameless commit (or fails), so fall through to the configured base.
    assert.equal(worktreeBase('HEAD', 'NewBeta2', 'main'), 'NewBeta2');
    assert.equal(worktreeBase('HEAD', '', 'main'), 'main');
    assert.equal(worktreeBase('HEAD', '', ''), null, 'no nameable base -> no isolation, not a bad one');
});

test('worktreeBase -- the repo\'s current branch is the integration line and wins', () => {
    // Workers fork off whatever Chris has checked out (NewBeta2 in tms), so merge-back is clean.
    assert.equal(worktreeBase('NewBeta2', 'main', 'master'), 'NewBeta2');
    assert.equal(worktreeBase('feature/TMS-19966', '', 'main'), 'feature/TMS-19966');
});

test('worktreeBase -- an empty or junk head falls back instead of naming a bogus branch', () => {
    assert.equal(worktreeBase('', 'main', ''), 'main');
    assert.equal(worktreeBase(null, null, 'main'), 'main');
    assert.equal(worktreeBase('  ', '', 'main'), 'main');
    // git failure surfaces as null; a name with whitespace is not a branch we should trust.
    assert.equal(worktreeBase('two words', '', 'main'), 'main');
    assert.equal(worktreeBase(undefined, undefined, undefined), null);
});

// --- worktreePlan: the path + branch a spawn actually uses --------------------------------------

test('worktreePlan -- the ordinary spawn: jarvis/<cs> in <root>/<repoKey>-<cs>', () => {
    const p = worktreePlan('broker', 'hotel', 'd:/code/tms', 'NewBeta2');
    assert.deepEqual(p, {
        root: 'd:/code/.jarvis-wt',
        path: 'd:/code/.jarvis-wt/broker-hotel',
        branch: 'jarvis/hotel',
        base: 'NewBeta2',
        create: true,
    });
});

test('worktreePlan -- THE BUG: a RECYCLED callsign must not collide with its own kept branch', () => {
    // Retire keeps the branch (it is the deliverable). Callsigns are recycled. So the second `xray`
    // ever spawned in a repo meets an existing jarvis/xray, `worktree add -b` fails, and isolation
    // silently stops happening -- the worker lands back in Chris's checkout with no error anywhere.
    const p = worktreePlan('jarvis', 'xray', 'd:/claude/jarvis-core', 'main', { taken: ['jarvis/xray'] });
    assert.equal(p.branch, 'jarvis/xray-2');
    assert.equal(p.path, 'd:/claude/.jarvis-wt/jarvis-xray-2', 'the directory tracks the branch suffix');
    // ...and it keeps counting, however many laps of the alphabet the hub has done.
    assert.equal(worktreePlan('jarvis', 'xray', 'd:/claude/jarvis-core', 'main',
        { taken: ['jarvis/xray', 'JARVIS/XRAY-2', 'jarvis/xray-3'] }).branch, 'jarvis/xray-4');
});

test('worktreePlan -- a leftover DIRECTORY blocks the slot too, not just a branch', () => {
    // A hub crash can leave the directory behind after the branch was already pruned; `worktree add`
    // refuses a non-empty target, so the path has to be free on its own account.
    const p = worktreePlan('broker', 'hotel', 'd:/code/tms', 'NewBeta2',
        { paths: [String.raw`D:\code\.jarvis-wt\broker-hotel`] });
    assert.equal(p.path, 'd:/code/.jarvis-wt/broker-hotel-2', 'path match is case- and separator-insensitive');
    assert.equal(p.branch, 'jarvis/hotel-2');
});

test('worktreePlan -- the SUCCESSOR continues its predecessor\'s branch (fresh dir, no -b)', () => {
    // A worker that hands off leaves its work committed on jarvis/hotel. Forking the successor from
    // base instead would strand every one of those commits on an abandoned branch.
    const p = worktreePlan('broker', 'india', 'd:/code/tms', 'NewBeta2', { inherit: 'jarvis/hotel' });
    assert.equal(p.branch, 'jarvis/hotel');
    assert.equal(p.create, false, 'checkout the existing branch; -b would fail on it');
    assert.equal(p.path, 'd:/code/.jarvis-wt/broker-india', 'but in ITS OWN directory');
    // The inherited branch is `taken` by definition -- that must not push it to a suffix.
    const q = worktreePlan('broker', 'india', 'd:/code/tms', 'NewBeta2',
        { inherit: 'jarvis/hotel', taken: ['jarvis/hotel', 'jarvis/india'] });
    assert.equal(q.branch, 'jarvis/hotel');
});

test('worktreePlan -- names stay short and filesystem-safe (Windows MAX_PATH)', () => {
    // A worktree is a full checkout; long paths are a real failure mode on Windows.
    const p = worktreePlan('some/very-long_repo KEY', 'HOTEL', 'd:/code/tms', 'main');
    assert.equal(p.path, 'd:/code/.jarvis-wt/someverylong-hotel');
    assert.equal(p.branch, 'jarvis/hotel');
});

test('worktreePlan -- unusable inputs return null so the caller shares the cwd', () => {
    assert.equal(worktreePlan('broker', 'hotel', 'd:/code/tms', ''), null, 'no base -> no fork point');
    assert.equal(worktreePlan('broker', '', 'd:/code/tms', 'main'), null);
    assert.equal(worktreePlan('broker', 'hotel', 'd:', 'main'), null, 'drive root has no worktree root');
    assert.equal(worktreePlan(null, null, null, null), null);
    // A malformed opts bag must not throw inside spawnWorker.
    assert.equal(worktreePlan('broker', 'hotel', 'd:/code/tms', 'main', null).create, true);
    assert.equal(worktreePlan('broker', 'hotel', 'd:/code/tms', 'main', 'nonsense').create, true);
});

// --- shouldIsolate: who gets a worktree ---------------------------------------------------------

test('shouldIsolate -- THE POINT: a code-mutating sub-worker never runs in the human\'s checkout', () => {
    assert.equal(shouldIsolate({ parentProject: 'jarvis', purpose: 'worktree isolation P1 build' }), true);
    assert.equal(shouldIsolate({ parentProject: 'primeng', purpose: 'TMS-19966 phase B fixes' }), true);
});

test('shouldIsolate -- the coordinator stays in the real checkout', () => {
    // It delegates instead of editing (manager-stays-thin), and it answers questions about the repo
    // the human is actually looking at -- a private fork would make it describe the wrong tree.
    assert.equal(shouldIsolate({ project: 'jarvis', purpose: 'jarvis hub development' }), false);
    // project + parentProject can never both be set, but if they were, coordinator wins.
    assert.equal(shouldIsolate({ project: 'jarvis', parentProject: 'jarvis', purpose: 'x' }), false);
});

test('shouldIsolate -- a NON-GIT cwd shares, because there is nothing to fork', () => {
    // Isolation is best-effort by design; a scratch directory must still spawn a worker.
    assert.equal(shouldIsolate({ parentProject: 'jarvis', purpose: 'build', git: false }), false);
    assert.equal(shouldIsolate({ isolate: true, purpose: 'build', git: false }), false, 'not even on request');
});

test('shouldIsolate -- an explicit flag wins in both directions', () => {
    assert.equal(shouldIsolate({ isolate: true, purpose: 'ad-hoc worker with no project' }), true);
    assert.equal(shouldIsolate({ isolate: false, parentProject: 'jarvis', purpose: 'build' }), false);
});

test('shouldIsolate -- meeting, plain and unclassified workers keep today\'s behaviour', () => {
    // Nothing that used to share a cwd starts taking a checkout by surprise.
    assert.equal(shouldIsolate({ parentProject: 'jarvis', meeting: { title: 'standup' }, purpose: 'notes' }), false);
    assert.equal(shouldIsolate({ purpose: 'TMS broker work' }), false, 'a plain /spawn worker');
    assert.equal(shouldIsolate({}), false);
    assert.equal(shouldIsolate(null), false, 'a malformed spec must not throw in the spawn path');
});

test('shouldIsolate -- read-only wording opts out, and the list is deliberately TIGHT', () => {
    // Guessing "share" wrong can clobber Chris's tree; guessing "isolate" wrong costs a directory.
    // So only unambiguously read-only words opt out -- review/verify/QA still get a worktree.
    for (const p of ['research the PrimeNG 18 breaking changes', 'read-only audit of the API',
        'investigate the timeout', 'watch the #jarvis slack channel', 'triage QA reports']) {
        assert.equal(shouldIsolate({ parentProject: 'jarvis', purpose: p }), false, p);
    }
    for (const p of ['code review of the diff', 'verify the deploy', 'phase B visual QA', 'fix the copy button']) {
        assert.equal(shouldIsolate({ parentProject: 'jarvis', purpose: p }), true, p);
    }
});

// --- orphanWorktrees: the boot sweep ------------------------------------------------------------

const T0 = Date.parse('2026-07-27T12:00:00Z');
const ago = (ms) => new Date(T0 - ms).toISOString();

test('orphanWorktrees -- THE CASE IT EXISTS FOR: after a restart, only the DEAD worker\'s tree is collected', () => {
    // This test used to assert the opposite -- that a restart orphans EVERY console-less worktree,
    // because workers were hub children and all died with it. Workers now outlive the hub (they run
    // in their own pty-host process), so that premise is dead, and the honest successor of the
    // assertion is this one: a survivor's tree is off limits and only the corpse's is collectable.
    //
    // Inverted rather than softened or deleted on purpose. Both worker rows below look equally cold
    // -- lastSeen is frozen at whatever it was before the hub went down, so it cannot tell them
    // apart -- and the ONLY thing separating them is the caller's proof of a live host. Weaken this
    // and the sweep quietly goes back to deleting the files a live worker is editing right now.
    const alive = 'd:/code/.jarvis-wt/broker-hotel';
    const dead = 'd:/code/.jarvis-wt/broker-india';
    const sessions = {
        s_1: { worktree: alive, ended: null, lastSeen: ago(3600000) },
        s_2: { worktree: dead, ended: null, lastSeen: ago(90 * 60000) },
    };
    assert.deepEqual(orphanWorktrees([alive, dead], sessions, T0, { claimed: [alive] }), [dead]);
    // And with nothing claimed -- every worker really did die -- the old expectation still holds.
    assert.deepEqual(orphanWorktrees([alive, dead], sessions, T0), [alive, dead]);
});

test('orphanWorktrees -- a beating worker keeps its worktree, without the caller proving anything', () => {
    const mine = 'd:/code/.jarvis-wt/broker-hotel';
    const dead = 'd:/code/.jarvis-wt/broker-india';
    // The heartbeat path, which is the fallback for any worker the caller holds no pid for -- a wt
    // tab, or a session Chris started by hand. It is trustworthy in steady state and worthless
    // immediately after a restart; the test above covers that second case.
    const sessions = {
        s_1: { worktree: mine, ended: null, lastSeen: ago(10000) },        // beating
        s_2: { worktree: dead, ended: null, lastSeen: ago(600000) },       // stale
    };
    assert.deepEqual(orphanWorktrees([mine, dead], sessions, T0), [dead]);
    // Sweeping a live worker's tree would delete the files it is editing right now.
    assert.equal(orphanWorktrees([mine], sessions, T0).length, 0);
});

test('orphanWorktrees -- a RETIRED session never protects a directory', () => {
    // Retire already tore its worktree down; if the directory survived, the teardown failed and the
    // leftover is exactly what the sweep is for.
    const p = 'd:/code/.jarvis-wt/broker-hotel';
    const sessions = { s_1: { worktree: p, ended: ago(1000), lastSeen: ago(1000) } };
    assert.deepEqual(orphanWorktrees([p], sessions, T0), [p]);
});

test('orphanWorktrees -- path spellings must match, or a live tree gets swept', () => {
    // The roster stores what the worker booted with (Windows, backslashes); readdir gives us the
    // forward-slashed join. A literal compare would call a live worktree an orphan.
    const sessions = { s_1: { worktree: String.raw`D:\code\.jarvis-wt\Broker-Hotel`, ended: null, lastSeen: ago(5000) } };
    assert.deepEqual(orphanWorktrees(['d:/code/.jarvis-wt/broker-hotel'], sessions, T0), []);
});

test('orphanWorktrees -- sessions without a worktree are irrelevant, and junk cannot throw', () => {
    const p = 'd:/code/.jarvis-wt/broker-hotel';
    const sessions = {
        s_1: { ended: null, lastSeen: ago(1000) },                          // shared-cwd worker
        s_2: null,
        s_3: { worktree: p, ended: null, lastSeen: 'not a date' },          // unparseable -> not live
    };
    assert.deepEqual(orphanWorktrees([p], sessions, T0), [p]);
    assert.deepEqual(orphanWorktrees([], null, T0), []);
    assert.deepEqual(orphanWorktrees(null, null, T0), []);
    assert.deepEqual(orphanWorktrees([p, '', null], {}, T0), [p]);
});

test('orphanWorktrees -- the staleness window is injectable (same 2-minute default as gone-quiet)', () => {
    const p = 'd:/code/.jarvis-wt/broker-hotel';
    const sessions = { s_1: { worktree: p, ended: null, lastSeen: ago(60000) } };
    assert.deepEqual(orphanWorktrees([p], sessions, T0), [], 'one minute old is still live');
    assert.deepEqual(orphanWorktrees([p], sessions, T0, { staleMs: 30000 }), [p]);
});
