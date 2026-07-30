// Integration tests for the WEDGE ANNOUNCE -- the spoken warning that a session is not reading its
// inbox. The unit tests in wedge.test.mjs pin the detector; these pin the two things that decide
// whether the human ever hears it, and both were broken in ways no unit test could see.
//
// 1. A MISSION-BOUND COORDINATOR. routeTo asks the detector only in its direct branch. A project
//    name never matches liveUidOf (that map is NATO callsigns), so a project carrying a missionId is
//    handed to routeToMission -- which never asked at all. primeng is the only project driving a
//    mission, so the warning was dead for the only coordinator that has ever needed it: on
//    2026-07-30 its coordinator sat deaf for sixteen minutes with the human talking into it, three
//    sub-workers idle behind it, and the hub said nothing. No grace value would have changed that,
//    which is why the fix is a call site and not a threshold. THIS is the assertion whose absence
//    hid the bug.
// 2. THE SWEEP. The announce used to hang entirely off the human speaking, so it could only fire
//    while he was still talking into the void. The moment he gave up and asked someone else, the hub
//    went quiet about the outage too.
//
// Run under npm run test:integration (JARVIS_INTEGRATION=1). Read the PASS count, not fail=0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub, waitFor, sleep } from '../test-support/scratch-hub.mjs';

const INTEGRATION = process.env.JARVIS_INTEGRATION === '1';
// The whole rig is built on making the real thresholds small rather than faking clocks: the
// coordinator grace is DERIVED from the poll hold (3.6x), so a 200ms hold buys a 720ms grace and the
// test exercises the real derivation instead of a number smuggled in beside it.
const HOLD_MS = 200;
const COORD_GRACE_MS = Math.round(HOLD_MS * 3.6);
const PROJ = 'scratchproj';

// Bring up a hub with one PROJECT-BOUND coordinator that is green but deaf: heartbeat sent, poll loop
// stopped after exactly one poll. That is the shape both signals must disagree about.
async function deafCoordinator(hub) {
    const reg = await hub.post('/register', { cwd: hub.REPO, purpose: 'scratch coordinator', project: PROJ });
    assert.ok(reg.uid, 'coordinator registered');
    // ONE poll, then never again -- this is the wedge. It also stamps pollCursor, without which
    // pendingFor returns 0 for a session that has never told us where it is.
    await hub.get('/poll?uid=' + reg.uid + '&cursor=0');
    // The heartbeat is what makes it look healthy; a stale one is the ordinary gone-quiet path.
    await hub.get('/heartbeat?uid=' + reg.uid);
    return reg;
}

test('a MISSION-BOUND coordinator produces the wedge announce', { skip: !INTEGRATION && 'JARVIS_INTEGRATION!=1' }, async () => {
    const hub = await createScratchHub({
        env: {
            JARVIS_POLL_HOLD_MS: String(HOLD_MS),
            JARVIS_SPEECH_DEBOUNCE: '1',
            JARVIS_WEDGE_SWEEP_MS: '3600000',   // off: this test must prove the ROUTE fires, not the sweep
        },
    });
    try {
        await hub.start();
        const reg = await deafCoordinator(hub);

        // Give the project a mission, which is what moves its traffic onto the branch that never asked.
        const m = await hub.post('/mission', { op: 'add', title: 'Scratch mission' });
        assert.ok(m.mission && m.mission.id, 'mission created');
        const patched = await hub.post('/project-context', { name: PROJ, missionId: m.mission.id });
        assert.ok(patched, 'project patched');
        const projRow = (await hub.get('/projects')).projects.find(p => p.name === PROJ);
        assert.equal(projRow.missionId, m.mission.id, 'the project is mission-bound -- the precondition for the bug');

        // Focus the PROJECT and just talk, which is how the human actually drives it: plain speech with
        // focus on a project goes to routeTo(<project>) and straight into the mission branch.
        await hub.post('/focus', { callsign: PROJ });
        await sleep(COORD_GRACE_MS + 150);
        await hub.post('/hear', { text: 'are you still there' });

        await waitFor('the hub to say the coordinator is not hearing him', async () =>
            hub.spoke(/is not hearing you/i), 8000);

        // It must name the LEVER, because the remedy existed all night and nobody was told it -- and it
        // must never name /forget, which retires with no opts (so no successor) and deletes the board.
        const chat = hub.transcript().split('\n').filter(l => /"kind":"chat"/.test(l) && /not reading its inbox/.test(l));
        assert.equal(chat.length, 1, 'exactly one chat detail line');
        assert.match(chat[0], /successor/, 'the chat line names the successor handover');
        assert.match(chat[0], /forget/, 'and warns off /forget explicitly');
        assert.match(chat[0], new RegExp(reg.uid), 'and carries the uid the human would POST');
    } finally { await hub.dispose(); }
});

test('the SWEEP escalates a deaf coordinator with nobody speaking to it', { skip: !INTEGRATION && 'JARVIS_INTEGRATION!=1' }, async () => {
    const hub = await createScratchHub({
        env: {
            JARVIS_POLL_HOLD_MS: String(HOLD_MS),
            JARVIS_SPEECH_DEBOUNCE: '1',
            JARVIS_WEDGE_SWEEP_MS: '150',
        },
    });
    try {
        await hub.start();
        const reg = await deafCoordinator(hub);
        // Queue traffic WITHOUT the human speaking: a sibling session messages the coordinator. Nothing
        // in this test ever calls /hear, so only the sweep can produce the warning.
        const other = await hub.post('/register', { cwd: hub.REPO, purpose: 'scratch sibling' });
        const receipt = await hub.post('/send', { from: other.uid, to: reg.callsign, text: 'are you awake' });
        assert.ok(Number.isFinite(receipt.cursor), 'the message is on the bus');

        await waitFor('the sweep to announce the outage unprompted', async () =>
            hub.spoke(/is not hearing you/i), 8000);
        assert.ok(!/"kind":"speech"/.test(hub.transcript()), 'and it did so with no human speech at all');
    } finally { await hub.dispose(); }
});
