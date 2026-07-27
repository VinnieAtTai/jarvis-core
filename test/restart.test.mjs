// Restart resilience: a hub restart must leave live workers running and reachable, and must not
// leave the roster listing sessions with no process behind them.
//
// These cover the two pure decisions the boot path makes. Both are decisions where being wrong is
// silent and expensive -- bury a live worker and its board and uncommitted work go with it; spare a
// dead one and the ghost keeps taking focus and keeps its cards on the board forever -- and neither
// is practical to exercise by hand, which is why they live out here rather than inside the hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRoster, orphanWorktrees, buildIdentity } from '../jarvis-text.mjs';

const NOW = Date.parse('2026-07-27T15:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// A console-less worker: its host writes the pidfile before claude ever starts, so `launch:'pty'`
// plus no live host is proof of death rather than an inference from silence.
const pty = (callsign, seenMsAgo) => ({ callsign, launch: 'pty', ended: null, lastSeen: ago(seenMsAgo) });
// A wt-tab worker or one Chris started by hand: outlives the hub legitimately, never had a pidfile.
const tab = (callsign, seenMsAgo) => ({ callsign, launch: 'wt', ended: null, lastSeen: ago(seenMsAgo) });

test('reconcileRoster -- THE CASE IT EXISTS FOR: a survivor is re-adopted, not buried', () => {
    const sessions = { s_1: pty('alpha', 5 * 60000) };   // heartbeat is COLD: the hub was down
    const r = reconcileRoster(sessions, new Set(['alpha']), NOW, { provableOnly: true });
    assert.deepEqual(r.readopt, [{ uid: 's_1', cs: 'alpha' }]);
    assert.deepEqual(r.ghosts, []);
    // A live host outranks the heartbeat entirely. This is the whole point: after a restart every
    // survivor's lastSeen is frozen at pre-restart, so judging on it would bury the entire fleet.
});

test('reconcileRoster -- a console-less session with no host is buried IMMEDIATELY, however warm', () => {
    const sessions = { s_1: pty('bravo', 1000) };        // heartbeat seconds old, but no host exists
    const r = reconcileRoster(sessions, new Set(), NOW, { provableOnly: true });
    assert.deepEqual(r.ghosts, [{ uid: 's_1', cs: 'bravo', provable: true }]);
    // No grace window for this one: the pidfile is written before claude starts, so its absence is
    // proof, and waiting 90s would just leave a corpse holding focus for 90s.
});

test('reconcileRoster -- a wt-tab session is NOT buried on the provable-only pass', () => {
    const sessions = { s_1: tab('charlie', 10 * 60000) };  // stone cold, but it may just not have polled yet
    assert.deepEqual(reconcileRoster(sessions, new Set(), NOW, { provableOnly: true }).ghosts, []);
    // ...and IS buried on the second pass, once it has had the grace window to check in and hasn't.
    assert.deepEqual(reconcileRoster(sessions, new Set(), NOW, {}).ghosts,
        [{ uid: 's_1', cs: 'charlie', provable: false }]);
});

test('reconcileRoster -- a wt-tab session that checked in during the grace window survives it', () => {
    const sessions = { s_1: tab('delta', 3000) };
    assert.deepEqual(reconcileRoster(sessions, new Set(), NOW, {}).ghosts, []);
});

test('reconcileRoster -- an already-retired row is never touched twice', () => {
    const sessions = { s_1: { ...pty('echo', 9e6), ended: ago(60000) } };
    const r = reconcileRoster(sessions, new Set(), NOW, {});
    assert.deepEqual(r.ghosts, []);
    assert.deepEqual(r.readopt, []);
});

test('reconcileRoster -- a legacy row with no launch field gets the benefit of the doubt', () => {
    // Rows written by a hub that predates this change carry no `launch`. Treating unknown as
    // console-less would bury Chris's own hand-started sessions on the first boot after deploy.
    const sessions = { s_1: { callsign: 'foxtrot', ended: null, lastSeen: ago(4000) } };
    assert.deepEqual(reconcileRoster(sessions, new Set(), NOW, { provableOnly: true }).ghosts, []);
});

test('reconcileRoster -- the staleness window is injectable, and junk cannot throw', () => {
    const sessions = { s_1: tab('golf', 30000), s_2: null, s_3: { callsign: 'hotel' } };
    assert.deepEqual(reconcileRoster(sessions, new Set(), NOW, { staleMs: 10000 }).ghosts.map(g => g.cs),
        ['golf', 'hotel']);            // 30s old vs a 10s window -> cold; and an unparseable lastSeen is cold
    assert.deepEqual(reconcileRoster(null, null, NOW, {}), { readopt: [], ghosts: [] });
});

test('reconcileRoster -- accepts a plain array of callsigns, not only a Set', () => {
    const sessions = { s_1: pty('india', 9e6) };
    assert.deepEqual(reconcileRoster(sessions, ['india'], NOW, { provableOnly: true }).ghosts, []);
});

test('orphanWorktrees -- THE TRAP: a live worker keeps its tree even when its heartbeat is cold', () => {
    // The sweep used to run at boot on the assumption that a restart had killed every console-less
    // worker. Once they survive, that assumption deletes a live worker's working directory and its
    // uncommitted work. A proven claim has to outrank the heartbeat.
    const dirs = ['d:/code/.jarvis-wt/tms-alpha'];
    const sessions = { s_1: { callsign: 'alpha', ended: null, lastSeen: ago(10 * 60000), worktree: 'd:/code/.jarvis-wt/tms-alpha' } };
    assert.deepEqual(orphanWorktrees(dirs, sessions, NOW), dirs, 'unclaimed + cold still sweeps');
    assert.deepEqual(orphanWorktrees(dirs, sessions, NOW, { claimed: ['d:/code/.jarvis-wt/tms-alpha'] }), []);
});

test('orphanWorktrees -- a claim protects a tree with NO session row at all', () => {
    // A worktree cut for a worker that has not registered yet is mentioned by no session anywhere,
    // so the heartbeat test cannot see it. Before the restore, a restart in that window swept the
    // directory out from under a worker that was still booting into it.
    const dirs = ['d:/code/.jarvis-wt/tms-kilo'];
    assert.deepEqual(orphanWorktrees(dirs, {}, NOW), dirs);
    assert.deepEqual(orphanWorktrees(dirs, {}, NOW, { claimed: dirs }), []);
});

test('orphanWorktrees -- claims are matched on path SPELLING, like the heartbeat test', () => {
    const dirs = ['D:\\code\\.jarvis-wt\\tms-lima'];
    assert.deepEqual(orphanWorktrees(dirs, {}, NOW, { claimed: ['d:/code/.jarvis-wt/tms-lima'] }), []);
});

test('orphanWorktrees -- an empty or absent claim list changes nothing', () => {
    const dirs = ['d:/code/.jarvis-wt/tms-mike'];
    assert.deepEqual(orphanWorktrees(dirs, {}, NOW, { claimed: [] }), dirs);
    assert.deepEqual(orphanWorktrees(dirs, {}, NOW, {}), dirs);
});

// ---- what code is actually running -----------------------------------------------------------
// The failure these guard against is not a crash, it is a confident wrong answer. On 2026-07-27 a
// session read the roster, saw workers retire and successors spawn, concluded the hub had bounced,
// and verified four fixes against a hub that had never loaded them. buildIdentity is the observable
// that makes that mistake impossible to repeat, so its edge cases matter more than its happy path.
test('buildIdentity -- reports the commit the hub was started from, short form included', () => {
    const b = buildIdentity({
        rev: '810da66b9285bb987bdfbf2b1c1c13058ab24552\n',
        status: '',
        bootedAt: '2026-07-27T14:54:16.000Z',
        pid: 55116,
    });
    assert.equal(b.commit, '810da66b9285bb987bdfbf2b1c1c13058ab24552');
    assert.equal(b.short, '810da66');
    assert.equal(b.dirty, false);
    assert.equal(b.bootedAt, '2026-07-27T14:54:16.000Z');
    assert.equal(b.pid, 55116);
});

test('buildIdentity -- an uncommitted tree is flagged, because no sha describes what is running', () => {
    const b = buildIdentity({ rev: 'a'.repeat(40), status: ' M jarvis-core.mjs\n?? scratch.mjs\n' });
    assert.equal(b.dirty, true);
});

// Unknown must not read as clean. A hub that could not run git cannot promise its tree matched the
// sha, and a caller doing `merge-base --is-ancestor` on a false-clean build gets a confident lie --
// the exact shape of the bug this whole block exists to prevent.
test('buildIdentity -- unreadable git status is null, never a silent false', () => {
    assert.equal(buildIdentity({ rev: 'b'.repeat(40), status: null }).dirty, null);
    assert.equal(buildIdentity({ rev: 'b'.repeat(40) }).dirty, null);
});

// Anything that is not a full sha is no identity at all. Rejecting it beats publishing 'HEAD' or a
// git error string as though it were a commit a worker could look up.
test('buildIdentity -- refuses junk rather than publishing an unusable commit', () => {
    for (const rev of [null, undefined, '', 'HEAD', 'fatal: not a git repository', '810da66', 'z'.repeat(40)]) {
        const b = buildIdentity({ rev });
        assert.equal(b.commit, null, 'rev ' + JSON.stringify(rev) + ' should not become a commit');
        assert.equal(b.short, null);
    }
});

test('buildIdentity -- a missing pid is null, not NaN, so it survives JSON', () => {
    const b = buildIdentity({ rev: 'c'.repeat(40), status: '', pid: undefined });
    assert.equal(b.pid, null);
    assert.equal(JSON.parse(JSON.stringify(b)).pid, null);
});
