// "Who holds the merge lane?" spoken at a REAL hub. The predicate and the sentence are pinned pure in
// test/batonvoice.test.mjs; what only a real hub can show is the part that makes it a feature -- that
// the branch is actually reachable inside handleUtterance's intent ladder, that the answer is SPOKEN,
// and above all that the ladder does not EAT sentences meant for a worker.
//
// That last one is the whole risk of adding any voice intent here. The ladder runs before speech is
// routed to the focused session, so a false positive is silent on both ends: Chris talks to a worker
// that never hears him, and nothing anywhere reports a problem. A unit test can only assert the
// predicate; only a live hub can prove the ROUTING still happens.
//
// SKIPPED by default: it boots a real hub. Run it deliberately:
//
//     npm run test:batonvoice
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub; ~20 seconds)';

const REPO = 'probe';   // the lane key, passed explicitly so nothing here depends on repos.json
const hear = (hub, text) => hub.post('/hear', { text });
// A spoken line is queued by the endpoint and recorded by the main loop's 250ms pump, so it lands
// shortly AFTER the response; asserting inline would be a race. Waiting is not a weakening -- the claim
// is that the hub says it at all, and the timeout still fails a silence.
const spoke = (hub, re) => hub.waitFor('the hub to speak ' + re, () => hub.spoke(re), 15000, 250);
const spokenCount = (hub, re) => hub.transcript().split('\n').filter(l => /"kind":"tts"/.test(l) && re.test(l)).length;

test('BATON VOICE: the hub answers who holds the lane, and never eats a worker\'s sentence',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('baton-voice hub');

        // 1. FREE LANE. The normal state, and the state the question is most often asked in. Silence here
        //    would read to Chris as the hub not having heard him at all.
        await hear(hub, 'who holds the merge lane');
        await spoke(hub, /Nobody holds a merge lane/);

        // 2. HELD, WITH SOMEONE BEHIND IT. Seeded through the real /baton endpoint rather than by writing
        //    batons.json, so the lane the answer describes is one the hub actually granted.
        const a = await hub.post('/register', { cwd: hub.REPO, purpose: 'holds the lane' });
        const b = await hub.post('/register', { cwd: hub.REPO, purpose: 'waits for the lane' });
        const g1 = await hub.post('/baton', { op: 'request', uid: a.uid, repo: REPO, note: 'merging' });
        const g2 = await hub.post('/baton', { op: 'request', uid: b.uid, repo: REPO, note: 'merging next' });
        assert.equal(g1.granted, true, 'first request takes the free lane: ' + JSON.stringify(g1));
        assert.equal(g2.granted, false, 'second is queued: ' + JSON.stringify(g2));

        await hear(hub, 'jarvis, who holds the merge lane');
        await spoke(hub, new RegExp(a.callsign + ' holds the ' + REPO + ' merge lane', 'i'));
        assert.equal(spokenCount(hub, new RegExp(b.callsign + ' is waiting behind it', 'i')), 1,
            'and it names who is blocked -- that is the half that decides whether a slow lane matters');

        // 3. A COMMAND IS NOT A QUESTION. Asserted as a COUNT, not an absence: the sentence below must
        //    not add a second answer, and the question that follows it proves the branch was still live
        //    the whole time. An absence check alone would pass just as well against a branch that had
        //    stopped working entirely.
        const before = spokenCount(hub, /holds the probe merge lane/i);
        await hear(hub, 'hand the baton to ' + b.callsign);
        await hear(hub, 'who has the merge lane');
        await hub.waitFor('the follow-up question to be answered',
            () => spokenCount(hub, /holds the probe merge lane/i) > before, 15000, 250);
        assert.equal(spokenCount(hub, /holds the probe merge lane/i), before + 1,
            'the command was NOT answered as a status report; only the question that followed it was');

        // 4. THE ONE THAT MATTERS: a lane sentence addressed to the FOCUSED session still reaches that
        //    session. Proven from the worker's own poll cursor, which is the only place that can show
        //    the hub really routed it rather than answering on its behalf.
        // /focus takes `callsign`, not `cs`. Asserted rather than assumed: posting the wrong key returns
        // ok-looking JSON and leaves focus where it was, and the only symptom downstream is this test
        // timing out as though the hub had swallowed the sentence -- an instrument bug that reads exactly
        // like the defect it is here to catch.
        const f = await hub.post('/focus', { callsign: b.callsign });
        assert.equal(f.focus, b.callsign, 'focus did not move: ' + JSON.stringify(f));
        const cursor = (await hub.get('/poll?uid=' + b.uid + '&cursor=0')).cursor;
        await hear(hub, 'what is your status on the merge lane');
        const got = await hub.waitFor(b.callsign + ' to receive the utterance', async () => {
            const r = await hub.get('/poll?uid=' + b.uid + '&cursor=' + cursor);
            const sp = (r.events || []).filter(e => e.kind === 'speech');
            return sp.length ? sp : false;
        }, 15000, 250);
        assert.match(got.map(e => e.text).join(' | '), /your status on the merge lane/,
            'the sentence was ROUTED to the worker, not swallowed by the hub');
        assert.equal(spokenCount(hub, /holds the probe merge lane/i), before + 1,
            'and the hub added no answer of its own while doing it');
    });
