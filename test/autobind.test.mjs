// Unit tests for projectOwningCwd in jarvis-text.mjs -- punchlist #39, the auto-bind backstop that
// decides whether a repo already OWNS a registering session.
//
// The bug it fixes: a session that boots in a repo which already hosts an active mission-backed
// project, but registers with no project/parentProject, used to get its own orphan NATO column --
// two-plus cards for one mission, and the hub cannot tell which is the brain. resolveBinding only
// covers workers the hub SPAWNED with a known intent (test/binding.test.mjs); this covers the rest
// by inferring the owner from repo identity.
//
// Projects carry no repo field, so the repo is inferred from their sessions -- which is why these
// fixtures are session maps, and why the ambiguity case below is real rather than theoretical.
//
// It also covers the gate's SECOND defect, found 2026-07-28: the check was "does this project name a
// mission" when it needed to be "is that mission still live", so two projects pointing at an archived
// mission went on racing a live one for d:/code/tms. And activeProjectsForCwd, the un-gated sibling
// the spawn path asks instead -- a different question ("is a brain already here") with a different
// right answer for the mission-less `jarvis` project.
// Run with `npm test` (node --test) -- no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectOwningCwd, activeProjectsForCwd, lastProjectCwd } from '../jarvis-text.mjs';

const PROJECTS = [
    { name: 'jarvis', status: 'active', missionId: null },                    // active but NO mission
    { name: 'primeng', status: 'active', missionId: 'm_mqzmh4u8037' },
    { name: 'macropoint', status: 'active', missionId: 'm_mrf3np7s0dd' },
    { name: 'oldthing', status: 'archived', missionId: 'm_dead' },            // mission-backed but archived
];
const SESSIONS = {
    s_0001: { project: 'jarvis', cwd: 'd:\\claude\\jarvis-core', lastSeen: '2026-07-25T12:00:00.000Z' },
    s_0002: { project: 'primeng', cwd: 'd:/code/tms', lastSeen: '2026-07-25T00:49:10.768Z' },
    s_0003: { project: 'macropoint', cwd: 'd:/claude/descartes-macropoint', lastSeen: '2026-07-11T21:09:09.170Z' },
    s_0004: { project: 'oldthing', cwd: 'd:/code/legacy', lastSeen: '2026-06-01T00:00:00.000Z' },
};
// The missions those projects point at. Required by projectOwningCwd, because "names a mission" and
// "names a mission that is still alive" only read the same until something is archived.
const MISSIONS = [
    { id: 'm_mqzmh4u8037', title: 'PrimeNG 17 -> 21 upgrade', status: 'active' },
    { id: 'm_mrf3np7s0dd', title: 'Descartes Gap Analysis', status: 'active' },
    { id: 'm_dead', title: 'Long finished', status: 'archived' },
];
// Every case below is about the projects/sessions pair, so the live missions ride along by default;
// the tests that are ABOUT the mission store pass their own.
const owns = (projects, sessions, cwd, missions = MISSIONS) => projectOwningCwd(projects, sessions, cwd, missions);

test('projectOwningCwd -- a repo hosting an active mission-backed project owns the session', () => {
    assert.deepEqual(owns(PROJECTS, SESSIONS, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
    assert.deepEqual(owns(PROJECTS, SESSIONS, 'd:/claude/descartes-macropoint'), { name: 'macropoint', ambiguous: 1 });
});

test('projectOwningCwd -- accepts the raw store object as well as the array', () => {
    // registerSession hands it loadProjects() directly, which is {projects:[...]}.
    assert.deepEqual(owns({ projects: PROJECTS }, SESSIONS, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
});

test('projectOwningCwd -- THE MISSION GATE: a project with no mission never captures a session', () => {
    // This is what keeps a jarvis-core worker its own `jarvis` card instead of being swallowed, and
    // stops an incidental repo that once hosted a plain worker from capturing unrelated sessions.
    assert.equal(owns(PROJECTS, SESSIONS, 'd:\\claude\\jarvis-core'), null);
});

test('projectOwningCwd -- an archived project does not capture, mission or not', () => {
    assert.equal(owns(PROJECTS, SESSIONS, 'd:/code/legacy'), null);
});

test('projectOwningCwd -- an unrelated repo is owned by nobody', () => {
    assert.equal(owns(PROJECTS, SESSIONS, 'd:/code/somewhere-else'), null);
    assert.equal(owns(PROJECTS, SESSIONS, ''), null);
    assert.equal(owns(PROJECTS, SESSIONS, null), null);
});

test('projectOwningCwd -- matches through Windows path spelling (case, slashes, trailing slash)', () => {
    // The whole mechanism is worthless if d:\Code\TMS\ misses a project living in d:/code/tms.
    for (const spelling of ['D:\\Code\\TMS', 'd:\\code\\tms\\', 'D:/CODE/tms/', 'd:/code/tms']) {
        assert.deepEqual(owns(PROJECTS, SESSIONS, spelling), { name: 'primeng', ambiguous: 1 }, spelling);
    }
});

test('projectOwningCwd -- REAL COLLISION: two active missions on one repo, most recent wins', () => {
    // Not hypothetical: on 2026-07-25 both `primeng` and `mycarrierpackets` were active,
    // mission-backed, and last seen in d:/code/tms. The winner must be deterministic and the
    // collision must be reported so the caller can log it instead of silently guessing.
    const projects = [...PROJECTS, { name: 'mycarrierpackets', status: 'active', missionId: 'm_mrf3np7s0dd' }];
    const sessions = { ...SESSIONS, s_0005: { project: 'mycarrierpackets', cwd: 'd:/code/tms', lastSeen: '2026-07-10T16:29:30.149Z' } };
    assert.deepEqual(owns(projects, sessions, 'd:/code/tms'), { name: 'primeng', ambiguous: 2 });
    // ...and it flips when the other project becomes the more recent occupant of the repo.
    sessions.s_0005.lastSeen = '2026-07-26T00:00:00.000Z';
    assert.deepEqual(owns(projects, sessions, 'd:/code/tms'), { name: 'mycarrierpackets', ambiguous: 2 });
});

test('projectOwningCwd -- a project is placed by its NEWEST session, not just any of them', () => {
    // A coordinator that moved repos must not leave the project answering for the old one.
    const sessions = {
        old: { project: 'primeng', cwd: 'd:/code/old-tms', lastSeen: '2026-01-01T00:00:00.000Z' },
        cur: { project: 'primeng', cwd: 'd:/code/tms', lastSeen: '2026-07-25T00:00:00.000Z' },
    };
    assert.deepEqual(owns(PROJECTS, sessions, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
    assert.equal(owns(PROJECTS, sessions, 'd:/code/old-tms'), null);
});

test('projectOwningCwd -- ENDED sessions still place a project (a dead coordinator keeps its repo)', () => {
    // Deliberate: the durable project column outlives its worker, and a hand-started successor in
    // that repo is exactly the session this feature exists to capture.
    const sessions = { s: { project: 'primeng', cwd: 'd:/code/tms', lastSeen: '2026-07-25T00:00:00.000Z', ended: '2026-07-25T01:00:00.000Z' } };
    assert.deepEqual(owns(PROJECTS, sessions, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
});

test('projectOwningCwd -- sessions without a cwd, or with an unparseable lastSeen, are harmless', () => {
    const sessions = {
        a: { project: 'primeng', lastSeen: '2026-07-25T00:00:00.000Z' },       // no cwd at all
        b: { project: 'primeng', cwd: 'd:/code/tms', lastSeen: 'not-a-date' },
        c: null,
    };
    assert.deepEqual(owns(PROJECTS, sessions, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
});

test('projectOwningCwd -- a malformed store or session map returns null, never throws', () => {
    for (const p of [null, undefined, {}, 'nonsense', [null, {}, { name: 'x' }]]) {
        assert.equal(owns(p, SESSIONS, 'd:/code/tms'), null, JSON.stringify(p));
    }
    for (const s of [null, undefined, 'nonsense', {}]) {
        assert.equal(owns(PROJECTS, s, 'd:/code/tms'), null);
    }
});

test('THE INCIDENT: a project pointing at an ARCHIVED mission neither wins the repo nor competes for it', () => {
    // 2026-07-28, reconstructed from the hub's own line: "auto-bind: 2 active missions claim
    // d:/code/tms; picked primeng (most recent)". Three ACTIVE projects claimed that repo and two of
    // them -- macropoint and mycarrierpackets -- still pointed at the Descartes mission, which had
    // been archived. The old gate only asked whether a missionId was present, so the dead pair was
    // eligible; here macropoint is the most recent occupant, which is exactly how a dead mission wins
    // a live repo. Both halves are asserted: the winner flips back to the only live mission, and the
    // reported ambiguity drops from 3 to 1 so the caller stops logging a collision that isn't one.
    const projects = [
        { name: 'primeng', status: 'active', missionId: 'm_primeng' },
        { name: 'macropoint', status: 'active', missionId: 'm_descartes' },
        { name: 'mycarrierpackets', status: 'active', missionId: 'm_descartes' },
    ];
    const sessions = {
        s_a: { project: 'primeng', cwd: 'd:/code/tms', lastSeen: '2026-07-28T14:20:00.000Z' },
        s_b: { project: 'macropoint', cwd: 'd:/code/tms', lastSeen: '2026-07-28T14:39:00.000Z' },   // newest
        s_c: { project: 'mycarrierpackets', cwd: 'd:/code/tms', lastSeen: '2026-07-28T14:30:00.000Z' },
    };
    const missions = [
        { id: 'm_primeng', status: 'active' },
        { id: 'm_descartes', status: 'archived', archivedAt: '2026-07-18T00:00:00.000Z' },
    ];
    assert.deepEqual(owns(projects, sessions, 'd:/code/tms', missions), { name: 'primeng', ambiguous: 1 });
    // Un-archive it and the collision is real again -- proving the gate is reading mission status and
    // not just quietly rejecting these three fixtures for some other reason.
    const revived = [{ id: 'm_primeng', status: 'active' }, { id: 'm_descartes', status: 'active' }];
    assert.deepEqual(owns(projects, sessions, 'd:/code/tms', revived), { name: 'macropoint', ambiguous: 3 });
});

test('projectOwningCwd -- a DANGLING missionId (mission gone from the store) captures nothing either', () => {
    // Same failure with the evidence removed rather than marked dead: nothing can confirm the mission
    // is alive, so the project must not act as though it is.
    const projects = [{ name: 'ghostproj', status: 'active', missionId: 'm_vanished' }];
    const sessions = { s: { project: 'ghostproj', cwd: 'd:/code/tms', lastSeen: '2026-07-28T14:00:00.000Z' } };
    assert.equal(owns(projects, sessions, 'd:/code/tms', MISSIONS), null);
});

test('projectOwningCwd -- no readable mission store STANDS DOWN rather than guessing', () => {
    // Fail-closed on purpose. registerSession always passes loadMissions(), so this is the unreadable
    // -store path: the cost of standing down is an orphan standalone card, which is visible and one
    // command to fix, while the cost of guessing is a session bound to a project whose mission is
    // over -- invisible until someone audits the board.
    for (const m of [undefined, null, [], {}, 'nonsense', { missions: [] }, [null, {}, { status: 'active' }]]) {
        assert.equal(projectOwningCwd(PROJECTS, SESSIONS, 'd:/code/tms', m), null, JSON.stringify(m) || 'undefined');
    }
    // ...and it is the MISSION half doing that, not a broken projects read: same call, live store.
    assert.deepEqual(projectOwningCwd(PROJECTS, SESSIONS, 'd:/code/tms', MISSIONS), { name: 'primeng', ambiguous: 1 });
});

test('projectOwningCwd -- accepts the raw missions store object as well as the array', () => {
    // The caller hands it loadMissions(), which is {missions:[...]}.
    assert.deepEqual(owns(PROJECTS, SESSIONS, 'd:/code/tms', { missions: MISSIONS }), { name: 'primeng', ambiguous: 1 });
});

test('activeProjectsForCwd -- names every active project in a repo, newest occupant first, NO mission gate', () => {
    // The spawn path's question is "is there already a brain in this repo", which is not auto-bind's
    // question. jarvis is the case that matters: mission-less, so projectOwningCwd must skip it, and
    // it is the project that had two coordinators spawned into it 27 seconds apart.
    assert.deepEqual(activeProjectsForCwd(PROJECTS, SESSIONS, 'd:\\claude\\jarvis-core'), ['jarvis']);
    assert.equal(owns(PROJECTS, SESSIONS, 'd:\\claude\\jarvis-core'), null, 'auto-bind must still skip a mission-less project');
    const projects = [...PROJECTS, { name: 'mycarrierpackets', status: 'active', missionId: null }];
    const sessions = { ...SESSIONS, s_0005: { project: 'mycarrierpackets', cwd: 'D:/CODE/TMS/', lastSeen: '2026-07-26T00:00:00.000Z' } };
    assert.deepEqual(activeProjectsForCwd(projects, sessions, 'd:/code/tms'), ['mycarrierpackets', 'primeng']);
});

test('activeProjectsForCwd -- an ARCHIVED project is not in a repo, and a malformed store is empty', () => {
    assert.deepEqual(activeProjectsForCwd(PROJECTS, SESSIONS, 'd:/code/legacy'), []);   // `oldthing` is archived
    assert.deepEqual(activeProjectsForCwd(PROJECTS, SESSIONS, 'd:/code/nowhere'), []);
    for (const p of [null, undefined, {}, 'nonsense', [null, {}]]) {
        assert.deepEqual(activeProjectsForCwd(p, SESSIONS, 'd:/code/tms'), [], JSON.stringify(p) || 'undefined');
    }
    for (const c of ['', null, undefined]) assert.deepEqual(activeProjectsForCwd(PROJECTS, SESSIONS, c), []);
    assert.deepEqual(activeProjectsForCwd(PROJECTS, null, 'd:/code/tms'), []);
});

test('lastProjectCwd -- unchanged by the shared scan it now delegates to', () => {
    // Guards the refactor: projectOwningCwd needed the timestamp too, so both callers read one scan.
    assert.equal(lastProjectCwd(SESSIONS, 'primeng'), 'd:/code/tms');
    assert.equal(lastProjectCwd(SESSIONS, 'nope'), null);
    assert.equal(lastProjectCwd(null, 'primeng'), null);
    assert.equal(lastProjectCwd(SESSIONS, ''), null);
});
