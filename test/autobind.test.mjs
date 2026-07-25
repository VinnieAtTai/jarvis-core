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
// Run with `npm test` (node --test) -- no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectOwningCwd, lastProjectCwd } from '../jarvis-text.mjs';

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

test('projectOwningCwd -- a repo hosting an active mission-backed project owns the session', () => {
    assert.deepEqual(projectOwningCwd(PROJECTS, SESSIONS, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
    assert.deepEqual(projectOwningCwd(PROJECTS, SESSIONS, 'd:/claude/descartes-macropoint'), { name: 'macropoint', ambiguous: 1 });
});

test('projectOwningCwd -- accepts the raw store object as well as the array', () => {
    // registerSession hands it loadProjects() directly, which is {projects:[...]}.
    assert.deepEqual(projectOwningCwd({ projects: PROJECTS }, SESSIONS, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
});

test('projectOwningCwd -- THE MISSION GATE: a project with no mission never captures a session', () => {
    // This is what keeps a jarvis-core worker its own `jarvis` card instead of being swallowed, and
    // stops an incidental repo that once hosted a plain worker from capturing unrelated sessions.
    assert.equal(projectOwningCwd(PROJECTS, SESSIONS, 'd:\\claude\\jarvis-core'), null);
});

test('projectOwningCwd -- an archived project does not capture, mission or not', () => {
    assert.equal(projectOwningCwd(PROJECTS, SESSIONS, 'd:/code/legacy'), null);
});

test('projectOwningCwd -- an unrelated repo is owned by nobody', () => {
    assert.equal(projectOwningCwd(PROJECTS, SESSIONS, 'd:/code/somewhere-else'), null);
    assert.equal(projectOwningCwd(PROJECTS, SESSIONS, ''), null);
    assert.equal(projectOwningCwd(PROJECTS, SESSIONS, null), null);
});

test('projectOwningCwd -- matches through Windows path spelling (case, slashes, trailing slash)', () => {
    // The whole mechanism is worthless if d:\Code\TMS\ misses a project living in d:/code/tms.
    for (const spelling of ['D:\\Code\\TMS', 'd:\\code\\tms\\', 'D:/CODE/tms/', 'd:/code/tms']) {
        assert.deepEqual(projectOwningCwd(PROJECTS, SESSIONS, spelling), { name: 'primeng', ambiguous: 1 }, spelling);
    }
});

test('projectOwningCwd -- REAL COLLISION: two active missions on one repo, most recent wins', () => {
    // Not hypothetical: on 2026-07-25 both `primeng` and `mycarrierpackets` were active,
    // mission-backed, and last seen in d:/code/tms. The winner must be deterministic and the
    // collision must be reported so the caller can log it instead of silently guessing.
    const projects = [...PROJECTS, { name: 'mycarrierpackets', status: 'active', missionId: 'm_mrf3np7s0dd' }];
    const sessions = { ...SESSIONS, s_0005: { project: 'mycarrierpackets', cwd: 'd:/code/tms', lastSeen: '2026-07-10T16:29:30.149Z' } };
    assert.deepEqual(projectOwningCwd(projects, sessions, 'd:/code/tms'), { name: 'primeng', ambiguous: 2 });
    // ...and it flips when the other project becomes the more recent occupant of the repo.
    sessions.s_0005.lastSeen = '2026-07-26T00:00:00.000Z';
    assert.deepEqual(projectOwningCwd(projects, sessions, 'd:/code/tms'), { name: 'mycarrierpackets', ambiguous: 2 });
});

test('projectOwningCwd -- a project is placed by its NEWEST session, not just any of them', () => {
    // A coordinator that moved repos must not leave the project answering for the old one.
    const sessions = {
        old: { project: 'primeng', cwd: 'd:/code/old-tms', lastSeen: '2026-01-01T00:00:00.000Z' },
        cur: { project: 'primeng', cwd: 'd:/code/tms', lastSeen: '2026-07-25T00:00:00.000Z' },
    };
    assert.deepEqual(projectOwningCwd(PROJECTS, sessions, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
    assert.equal(projectOwningCwd(PROJECTS, sessions, 'd:/code/old-tms'), null);
});

test('projectOwningCwd -- ENDED sessions still place a project (a dead coordinator keeps its repo)', () => {
    // Deliberate: the durable project column outlives its worker, and a hand-started successor in
    // that repo is exactly the session this feature exists to capture.
    const sessions = { s: { project: 'primeng', cwd: 'd:/code/tms', lastSeen: '2026-07-25T00:00:00.000Z', ended: '2026-07-25T01:00:00.000Z' } };
    assert.deepEqual(projectOwningCwd(PROJECTS, sessions, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
});

test('projectOwningCwd -- sessions without a cwd, or with an unparseable lastSeen, are harmless', () => {
    const sessions = {
        a: { project: 'primeng', lastSeen: '2026-07-25T00:00:00.000Z' },       // no cwd at all
        b: { project: 'primeng', cwd: 'd:/code/tms', lastSeen: 'not-a-date' },
        c: null,
    };
    assert.deepEqual(projectOwningCwd(PROJECTS, sessions, 'd:/code/tms'), { name: 'primeng', ambiguous: 1 });
});

test('projectOwningCwd -- a malformed store or session map returns null, never throws', () => {
    for (const p of [null, undefined, {}, 'nonsense', [null, {}, { name: 'x' }]]) {
        assert.equal(projectOwningCwd(p, SESSIONS, 'd:/code/tms'), null, JSON.stringify(p));
    }
    for (const s of [null, undefined, 'nonsense', {}]) {
        assert.equal(projectOwningCwd(PROJECTS, s, 'd:/code/tms'), null);
    }
});

test('lastProjectCwd -- unchanged by the shared scan it now delegates to', () => {
    // Guards the refactor: projectOwningCwd needed the timestamp too, so both callers read one scan.
    assert.equal(lastProjectCwd(SESSIONS, 'primeng'), 'd:/code/tms');
    assert.equal(lastProjectCwd(SESSIONS, 'nope'), null);
    assert.equal(lastProjectCwd(null, 'primeng'), null);
    assert.equal(lastProjectCwd(SESSIONS, ''), null);
});
