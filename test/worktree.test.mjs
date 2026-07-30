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
import { worktreeRoot, worktreeBase, worktreePlan, shouldIsolate, orphanWorktrees, worktreeRemoval } from '../jarvis-text.mjs';

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

// --- orphanWorktrees: the three gates that need no session at all -------------------------------
//
// Every claim above this line is made BY A SESSION -- a live host pid, a pending mint, a heartbeat.
// These cover the case those all miss: a directory in use by something the roster has never heard of,
// which is how the sweep came to delete a manager's live gate out from under a running probe.

const WT = 'd:/claude/.jarvis-wt';
const KEYS = { keys: ['jarvis'] };
// As old and as unclaimed as a directory can be, so nothing but the gates under test is protecting it.
const aged = (path, branch) => ({ path, createdAt: T0 - 3600000, branch });

test('orphanWorktrees -- THE INCIDENT: a manager\'s hand-made verify tree is not the hub\'s to delete', () => {
    // Measured on the live hub 2026-07-30. oscar cut d:/claude/.jarvis-wt/oscar-verify by hand to gate
    // a merge candidate, with a mutation probe running inside it. Nothing claimed it: the hub never
    // minted it (no pendingWorktree entry), a bound coordinator's own roster row carries worktree:null,
    // and there was no host pid for a directory no session had ever named. So the sweep collected it
    // mid-probe and counted it in "collected 4 orphaned worktrees". The house standard guarantees a
    // repeat rather than making this bad luck: gate a merge candidate in a throwaway tree, THEN ask for
    // the restart that deploys it, so every manager aims the boot sweep at the tree its own gate runs
    // in. Two gates catch it here, exactly as they would in life -- foreign name, detached HEAD.
    const verify = WT + '/oscar-verify';
    const dead = WT + '/jarvis-india';
    const dirs = [aged(verify, 'HEAD'), aged(dead, 'jarvis/india')];
    assert.deepEqual(orphanWorktrees(dirs, {}, T0, KEYS), [dead], 'the live tree survives, the dead one still goes');
    // And the behaviour it replaces, so the regression stays visible instead of theoretical: measured
    // the old way -- bare paths, no gates -- that same live tree is collected.
    assert.deepEqual(orphanWorktrees(dirs.map(d => d.path), {}, T0), [verify, dead]);
});

test('orphanWorktrees -- the NAME gate: a foreign name is spared at any age, on any branch', () => {
    // Isolated deliberately: this tree is an hour old and sits on a jarvis/ branch, so the age floor and
    // the branch gate both wave it through and its NAME is the only thing that can save it. worktreePlan
    // mints <repoKey>-<callsign>, so a name that cannot be spelled that way was put there by a human.
    assert.deepEqual(orphanWorktrees([aged(WT + '/oscar-verify', 'jarvis/oscar')], {}, T0, KEYS), []);
    // The gate must not slide into a blanket refusal -- a sweep that collects nothing is its own bug --
    // so every name the hub really does mint stays collectable: the -2/-3 collision suffix, and the two
    // fallback keys worktreePlan uses when a spawn's cwd matches no configured repo.
    for (const base of ['jarvis-india', 'jarvis-romeo-2', 'jarvis-x99', 'adhoc-kilo', 'repo-kilo']) {
        assert.deepEqual(orphanWorktrees([aged(WT + '/' + base, 'jarvis/india')], {}, T0, KEYS), [WT + '/' + base], base);
    }
    // A repo key reaches the directory name the way worktreePlan spells it -- lowercased, stripped to
    // [a-z0-9], truncated at 12 -- so this gate has to spell it identically or it rejects real trees.
    const p = WT + '/jarviscore-kilo';
    assert.deepEqual(orphanWorktrees([aged(p, 'jarvis/kilo')], {}, T0, { keys: ['Jarvis-Core'] }), [p]);
});

test('orphanWorktrees -- the AGE floor: a brand-new tree is spared even when its name is perfect', () => {
    // The case the name gate cannot reach: a manager who names their gate tree exactly like a minted
    // one, which is the likely mistake given the minted siblings sitting next to it in the same folder.
    // The floor is the window in which the hub cannot yet know its OWN mint has failed -- the
    // pendingWorktree TTL, 5 minutes -- so under it nothing is collected whatever it is called.
    const p = WT + '/jarvis-verify';
    const at = (ms, extra) => orphanWorktrees([{ path: p, createdAt: ms, branch: 'jarvis/verify' }], {}, T0, { ...KEYS, ...extra });
    assert.deepEqual(at(T0 - 180000), [], 'three minutes old, the age oscar\'s tree died at');
    assert.deepEqual(at(T0 - 600000), [p], 'ten minutes old is fair game');
    // Exactly on the floor, which is the one input neither of the two above reaches: 3 minutes is
    // comfortably under and 10 comfortably over, so nothing pinned whether the comparison is < or
    // <=. Both spellings pass every other assertion here -- bravo mutation-probed <= and it was the
    // one survivor of nine. The floor is EXCLUSIVE: at the TTL the hub can already know its own mint
    // failed, so the tree is fair game. One millisecond of a 5-minute safety margin either way is not
    // the point; an unpinned boundary that no fixture reaches is.
    assert.deepEqual(at(T0 - 300000), [p], 'exactly at the floor is collected -- the floor is exclusive');
    // Injectable like staleMs, so a caller can tighten or widen the floor without editing this file.
    assert.deepEqual(at(T0 - 180000, { minAgeMs: 60000 }), [p]);
    // Epoch millis or an ISO string: a caller holding a stat has the first, one reading a record has
    // the second, and a floor that silently ignored either shape would be no floor at all.
    assert.deepEqual(at(new Date(T0 - 180000).toISOString()), []);
});

test('orphanWorktrees -- the BRANCH gate: a tree the hub did not mint is not on a jarvis/ branch', () => {
    // The last hole the other two leave between them: a hand-made tree named like a minted one AND older
    // than the floor. A merge-gate tree is cut at a candidate COMMIT, so it reads HEAD -- detached --
    // which is exactly what the incident logged ("branch HEAD kept"). Every tree the hub mints is on a
    // jarvis/ branch (worktreePlan creates one, or continues a predecessor's), so the two separate
    // cleanly, and the caller already reads this branch to name the teardown -- the gate is free.
    const p = WT + '/jarvis-verify';
    assert.deepEqual(orphanWorktrees([aged(p, 'HEAD')], {}, T0, KEYS), []);
    assert.deepEqual(orphanWorktrees([aged(p, 'main')], {}, T0, KEYS), [], 'nor is a hand-made tree on a real branch');
    assert.deepEqual(orphanWorktrees([aged(p, 'jarvis/verify')], {}, T0, KEYS), [p]);
    // The successor case, where the two halves legitimately disagree: a worker continuing its
    // predecessor's branch sits in a directory named for ITSELF, and both readings must still be minted.
    assert.deepEqual(orphanWorktrees([aged(WT + '/jarvis-sierra', 'jarvis/bravo')], {}, T0, KEYS), [WT + '/jarvis-sierra']);
});

test('orphanWorktrees -- an UNMEASURED gate falls through rather than sparing everything', () => {
    // One failed stat must not switch the sweep off. A dead tree still has to be collectable when the
    // filesystem will not say when it was created, or git will not say what it is checked out on; the
    // gates the caller CAN measure still apply.
    const p = WT + '/jarvis-india';
    assert.deepEqual(orphanWorktrees([{ path: p, createdAt: null, branch: '' }], {}, T0, KEYS), [p]);
    assert.deepEqual(orphanWorktrees([{ path: p, createdAt: 'not a date', branch: null }], {}, T0, KEYS), [p]);
    assert.deepEqual(orphanWorktrees([p], {}, T0, KEYS), [p], 'a bare path string, as an older caller passes');
    assert.deepEqual(orphanWorktrees([{ path: p }], {}, T0, { keys: [] }), [p], 'no keys: the name gate is off, not inverted');
    // And a session claim still outranks all three -- these gates are extra protection for the trees no
    // session can vouch for, never a replacement for the claims that already worked.
    assert.deepEqual(orphanWorktrees([aged(p, 'jarvis/india')], {}, T0, { ...KEYS, claimed: [p] }), []);
});

// --- worktreeRemoval: the sys line has to say what actually happened ----------------------------

const REM = { cs: 'oscar', path: 'd:/claude/.jarvis-wt/oscar-verify', branch: 'HEAD' };

test('worktreeRemoval -- THE INCIDENT: a FAILED remove that emptied the directory must not read as kept', () => {
    // Measured on the live hub 2026-07-30: the sweep logged "worktree remove FAILED for a dead session
    // at d:/claude/.jarvis-wt/oscar-verify; branch HEAD kept" while that path on disk was an EMPTY
    // directory -- contents gone, no .git file, absent from `git worktree list`. git deletes the
    // checkout recursively and then drops the administrative .git/worktrees/<id> entry whether or not
    // that delete finished, so a non-zero exit means partly destroyed and deregistered, never
    // untouched. A successor reads "kept" as work still sitting there to recover, which is what makes
    // this worse than logging nothing at all.
    const r = worktreeRemoval({ ok: false, existedBefore: true, exists: true, intact: false, ...REM });
    assert.equal(r.destroyed, true);
    assert.equal(r.litter, true, 'a shell of it is still on disk and somebody has to be told');
    assert.equal(r.state, 'removed', 'kept would send a successor looking for a checkout that is gone');
    assert.match(r.text, /DESTROYED, not kept/);
    assert.doesNotMatch(r.text, /STILL THERE|still a checkout|still registered/);
});

test('worktreeRemoval -- git exiting 0 or non-zero cannot outrank the filesystem, in either direction', () => {
    // ok:true over a gutted tree is the junction case measured 2026-07-27 -- exits 0, deletes every real
    // file, then leaves the directory. ok:false over a gone one is its mirror. Each used to be logged as
    // its opposite, because the old line branched on the exit code before it looked at the disk.
    const junction = worktreeRemoval({ ok: true, existedBefore: true, exists: true, intact: false, ...REM });
    assert.deepEqual([junction.state, junction.destroyed, junction.litter], ['removed', true, true]);
    const goneAnyway = worktreeRemoval({ ok: false, existedBefore: true, exists: false, intact: false, ...REM });
    assert.deepEqual([goneAnyway.state, goneAnyway.destroyed, goneAnyway.litter], ['removed', true, false]);
    assert.match(goneAnyway.text, /ERROR/);
    assert.match(goneAnyway.text, /the directory is gone/);
});

test('worktreeRemoval -- only an intact checkout earns the words that promise one', () => {
    // The single verdict a successor may read as "your predecessor's tree is still waiting for you":
    // the directory is there AND git still resolves it as a worktree. Nothing was collected.
    const failed = worktreeRemoval({ ok: false, existedBefore: true, exists: true, intact: true, ...REM });
    assert.deepEqual([failed.state, failed.destroyed, failed.litter], ['kept', false, false]);
    assert.match(failed.text, /FAILED/);
    assert.match(failed.text, /STILL THERE/);
    // The happy path is by far the most common line in the log, so it is pinned verbatim: this change
    // is about the failures, and churning the wording nobody complained about buys nothing.
    const clean = worktreeRemoval({ ok: true, existedBefore: true, exists: false, intact: false, cs: 'india', path: 'd:/code/.jarvis-wt/broker-india', branch: 'jarvis/india' });
    assert.deepEqual([clean.state, clean.destroyed, clean.litter], ['removed', true, false]);
    assert.equal(clean.text, 'worktree for india removed; branch jarvis/india kept for merge');
});

test('worktreeRemoval -- a directory that was already gone was not destroyed by us', () => {
    // Retire after a tree somebody deleted by hand. Calling that a destruction files a data loss that
    // never happened; calling it "kept" is the original bug. It is neither, so it says so.
    const r = worktreeRemoval({ ok: false, existedBefore: false, exists: false, intact: false, ...REM });
    assert.deepEqual([r.state, r.destroyed, r.litter], ['removed', false, false]);
    assert.match(r.text, /already gone/);
});

test('worktreeRemoval -- THE INVARIANT: no verdict claims survival and destruction at once', () => {
    // The bug was a TEXT that disagreed with the facts, so the text is pinned to the flags across every
    // combination of the four observables rather than trusting four hand-written cases to stay in step
    // with the wording. This is the assertion that fails if someone edits a message carelessly later.
    for (const ok of [true, false]) for (const existedBefore of [true, false]) for (const exists of [true, false]) for (const intact of [true, false]) {
        const r = worktreeRemoval({ ok, existedBefore, exists, intact, ...REM });
        const s = JSON.stringify({ ok, existedBefore, exists, intact });
        assert.ok(r.text.length > 20, s);
        assert.equal(r.state === 'kept', Boolean(exists && intact), s);
        assert.equal(r.litter, Boolean(r.destroyed && exists), s);
        if (r.state === 'kept') assert.equal(r.destroyed, false, s);
        if (r.destroyed) assert.doesNotMatch(r.text, /STILL THERE|nothing was collected/, s);
        else assert.doesNotMatch(r.text, /DESTROYED|destroyed anyway/, s);
        assert.match(r.text, /; branch HEAD kept( for merge)?$/, s + ' -- the branch survives every outcome and the line always names it');
    }
});
