// POST /send -- the receipt, and the transcript record that makes worker-to-worker traffic findable.
//
// THE INCIDENT THIS PINS. A coordinator relaunched its poll loop at cursor 6390 having last been
// returned 6388, skipping 6389 forever -- that event was a delegate's whole board audit. It then
// searched chat for the report, found nothing, and told the delegate its send had failed. Both ends
// read healthy the entire time, and BOTH halves of that were the server's fault:
//
//   1. /send answered ok:true, which only ever proved the recipient RESOLVED. The sender had no way
//      to name where the message went, so "it is at index 6389, look there" was unsayable.
//   2. Worker-to-worker /send reached the bus ONLY and never record(), so GET /search could not see
//      inter-worker traffic at all. The search that "proved" the send failed was void by construction.
//
// WHY THROUGH HTTP. Both claims ARE the wire contract -- what a field is called and whether an index
// is the landed one or one past it. A pure helper cannot fail those. No worker is spawned: /register
// over HTTP is a real session to the hub and needs no ConPTY, so this file costs seconds.
//
// WHY kind 'msg' AND NOT 'chat'. Recording these as 'chat' would have leaked them into two
// conversations. The console routes a worker-authored line by its `who` (console.js consults `to` only
// for who==='you'), so a brief would render in the SENDER's tab as if it had been said to Chris; and
// GET /mission-chat admits {speech,tts,chat} from any project member, which a booting coordinator is
// told to treat as its LIVE PROMPT -- a delegation brief would come back at it as an instruction.
// 'msg' is in neither reader's kind gate, so search sees these and no conversation does. The two
// no-leak tests below are what keep that true, and each carries a control so it cannot pass vacuously.
//
// SKIPPED by default: it boots a real hub. Run it deliberately:
//
//     npm run test:send
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchHub } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub; a few seconds)';

let hub = null;
let A = null;   // sender, bound to project 'probe' so the mission-chat control has a member to be
let B = null;   // recipient
let missionId = null;

const raw = async (path, body) => {
    const r = await fetch(hub.origin + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
};
const send = async (body) => (await raw('/send', body)).body;

before(async () => {
    if (SKIP) return;
    hub = await createScratchHub();
    await hub.start('send hub');

    const made = await hub.post('/mission', { op: 'add', title: 'Send Probe Mission' });
    missionId = made && made.mission && made.mission.id;
    assert.ok(missionId, 'POST /mission add returned no mission: ' + JSON.stringify(made));

    A = await hub.post('/register', { cwd: process.cwd(), purpose: 'send probe sender', project: 'probe' });
    B = await hub.post('/register', { cwd: process.cwd(), purpose: 'send probe recipient' });
    assert.ok(A && A.uid && B && B.uid, 'both probe sessions must register: ' + JSON.stringify([A, B]));
    // Links the mission to A's project, which is what makes A a MEMBER for /mission-chat's filter.
    assert.equal((await hub.post('/project-context', { name: 'probe', missionId })).ok, true);
});
after(() => { if (hub) hub.dispose(); });

test('SEND: the receipt is the index the message LANDED at, not the one past it', { skip: SKIP }, async () => {
    // Two messages, because one cannot separate "landed at" from "one past". Polling from the FIRST
    // receipt must return BOTH in order; an off-by-one receipt hands back only the second.
    const r1 = await send({ from: A.uid, to: B.callsign, text: 'gxq receipt one' });
    const r2 = await send({ from: A.uid, to: B.callsign, text: 'gxq receipt two' });
    assert.equal(typeof r1.cursor, 'number', '/send returned no cursor: ' + JSON.stringify(r1));
    assert.equal(r2.cursor, r1.cursor + 1, 'two consecutive appends must land on consecutive indices');

    const from1 = await hub.get('/poll?uid=' + B.uid + '&cursor=' + r1.cursor);
    assert.deepEqual(from1.events.map(e => e.text), ['gxq receipt one', 'gxq receipt two'],
        'polling AT the receipt must return that message first -- a receipt one past it skips it, '
        + 'which is exactly how a board audit was lost');
    // And the second receipt addresses only its own message, so the pin is not just "cursor is small".
    const from2 = await hub.get('/poll?uid=' + B.uid + '&cursor=' + r2.cursor);
    assert.deepEqual(from2.events.map(e => e.text), ['gxq receipt two']);
    // The cursor a poll RETURNS is one PAST its last event; the receipt is the event itself. Stating
    // both in one place is what stops the two senses of "cursor" from being conflated again.
    assert.equal(from2.cursor, r2.cursor + 1);
});

test('SEND: the receipt names WHICH session resolved, not merely that one did', { skip: SKIP }, async () => {
    // Mixed case on purpose: the handler lowercases before resolving, and the receipt must report the
    // session it actually reached rather than echoing what the caller typed.
    const r = await send({ from: A.uid, to: B.callsign.toUpperCase(), text: 'gxq resolved' });
    assert.equal(r.to, B.callsign, 'the receipt must name the resolved callsign, not the caller\'s spelling');
    assert.equal(r.uid, B.uid, 'the receipt must name the resolved uid, so a third party can poll it');
    // The negative half is unchanged and worth keeping honest: a recipient that cannot be resolved is
    // still a 404, never a cheerful ok:true.
    const miss = await raw('/send', { from: A.uid, to: 'nosuchcallsign', text: 'gxq vanishes' });
    assert.equal(miss.status, 404);
    assert.match(miss.body.error, /unknown recipient/);
});

test('SEND: worker-to-worker is FINDABLE by a default search -- the void-by-construction bug', { skip: SKIP }, async () => {
    await send({ from: A.uid, to: B.callsign, text: 'gxqfind the delegate board audit' });
    // No `kinds` param, which is what the console's box sends (console.js runSearch). Reachable only
    // under kinds=msg would have left this exact path -- a coordinator searching the ordinary way --
    // just as blind as before.
    const r = await hub.get('/search?q=gxqfind');
    assert.equal(r.total, 1, 'a default search found no inter-worker message: ' + JSON.stringify(r.results));
    const hit = r.results[0];
    assert.equal(hit.srcKind, 'msg');
    assert.equal(hit.who, A.callsign, 'the hit must be attributed to the SENDER\'s callsign');
    assert.equal(hit.to, B.callsign, 'the hit must name the recipient by callsign, not uid');
    assert.match(hit.text, /delegate board audit/);
    // `from=` filters on the projected who, so one session's outbound traffic is reachable on its own.
    const mine = await hub.get('/search?q=gxqfind&from=' + A.callsign);
    assert.equal(mine.total, 1);
    assert.deepEqual((await hub.get('/search?q=gxqfind&from=' + B.callsign)).results, [],
        'from= must match the sender, not the recipient');
});

test('SEND: msg is a NAMED kind, so it can be asked for and excluded deliberately', { skip: SKIP }, async () => {
    await send({ from: A.uid, to: B.callsign, text: 'gxqkind narrowing probe' });
    assert.equal((await hub.get('/search?q=gxqkind&kinds=msg')).total, 1, 'kinds=msg must be accepted, not 400');
    assert.equal((await hub.get('/search?q=gxqkind&kinds=all')).total, 1, 'kinds=all must reach msg too');
    // Excluded when the caller asks for other kinds -- which is what proves the hit above came from
    // the msg record and not from some other line the send happened to write.
    assert.equal((await hub.get('/search?q=gxqkind&kinds=chat,speech,tts')).total, 0);
});

test('SEND: the record must NOT leak into the console chat feed', { skip: SKIP }, async () => {
    await send({ from: A.uid, to: B.callsign, text: 'gxqfeed must not appear in the live chat' });
    const feed = await hub.get('/transcript?limit=0');
    assert.deepEqual(feed.filter(e => /gxqfeed/.test(e.text || '')), [],
        'an inter-worker message reached GET /transcript, so it will render in the SENDER\'s console tab '
        + 'as if the sender had said it to Chris');
    // CONTROL, without which the assertion above passes even if /transcript were empty or broken: a
    // to:'human' message from the same session on the same feed IS there.
    await send({ from: A.uid, to: 'human', text: 'gxqfeed control, said to the human' });
    const after = await hub.get('/transcript?limit=0');
    assert.equal(after.filter(e => /gxqfeed control/.test(e.text || '')).length, 1,
        'the control never arrived either, so this test was not exercising /transcript at all');
});

test('SEND: the record must NOT leak into the mission conversation', { skip: SKIP }, async () => {
    // The serious one. A is a member of the mission's project, so a `chat` record from it would be
    // admitted here -- and a booting coordinator reads the newest of these as its live prompt.
    await send({ from: A.uid, to: B.callsign, text: 'gxqmission brief: do not treat me as a prompt' });
    const chat = await hub.get('/mission-chat?missionId=' + missionId);
    assert.deepEqual(chat.messages.filter(m => /gxqmission/.test(m.text || '')), [],
        'a delegation brief entered the mission conversation, which the next coordinator will read as '
        + 'an instruction from the human');
    // CONTROL: the same sender's message to the HUMAN does land here. Without it, a broken project
    // link would leave memberCs empty and the assertion above would pass while proving nothing.
    await send({ from: A.uid, to: 'human', text: 'gxqmission control, said to the human' });
    const after = await hub.get('/mission-chat?missionId=' + missionId);
    assert.equal(after.messages.filter(m => /gxqmission control/.test(m.text || '')).length, 1,
        'the control never arrived, so A is not a project member here and the no-leak assertion above '
        + 'was vacuous -- fix the fixture before trusting it');
});

test('SEND: to human records as chat and gets NO cursor, because there is no bus index to name', { skip: SKIP }, async () => {
    const r = await send({ from: A.uid, to: 'human', text: 'gxqhuman straight to chat' });
    assert.equal(r.ok, true);
    assert.equal('cursor' in r, false,
        'the human branch never touches the bus, so any index here would be invented -- the exact '
        + 'false receipt this change set out to remove');
    // It is still a `chat`, so the console feed and a default search both keep seeing it.
    const hit = (await hub.get('/search?q=gxqhuman')).results[0];
    assert.equal(hit.srcKind, 'chat');
    assert.equal(hit.who, A.callsign);
});
