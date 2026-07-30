// Unit tests for the SPOKEN half of the merge lane -- isBatonQuestion + speakBaton in jarvis-text.mjs,
// wired into handleSpeech's intent ladder in jarvis-core.mjs.
//
// Why a spoken answer at all, when the console now chips the lane: Chris asks this question hands-off,
// usually while reading something else, and "who holds the merge lane" is the exact sentence he says. A
// board he has to look at answers it only when he is already looking.
//
// The half worth testing hardest is NOT the sentence, it is the GATE. handleSpeech runs its intent
// ladder before routing speech on to the focused worker, so every false positive silently eats a
// sentence meant for a session -- no error on either end, which is the family of bug this project keeps
// getting burned by.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBatonQuestion, speakBaton } from '../jarvis-text.mjs';

const T0 = Date.parse('2026-07-30T00:30:00.000Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();

test('isBatonQuestion -- the sentences Chris actually says', () => {
    for (const s of [
        'who holds the merge lane',
        'who holds the merge lane?',
        'jarvis, who holds the merge lane',
        'hey jarvis who has the merge lane',
        "who's got the baton",
        'who has the commit baton',
        'whose merge lane is it',
        'what is the merge lane doing',
        "what's happening with the merge lane",
        'is anyone waiting on the merge lane',
        'is the merge lane free',
        'anyone in the merge queue',
        'how many are waiting on the merge lane',
        'where is the baton',
        'merge lane',
        'jarvis, merge lane',
        'the merge lane',
        'merge lane status',
        'baton status',
    ]) assert.equal(isBatonQuestion(s), true, s);
});

test('isBatonQuestion -- a COMMAND about the lane is not a question about it', () => {
    // These belong to whoever handles them (today: nobody, so they fall through to the focused worker,
    // which is the right destination). Answering them with a status report would be actively wrong.
    for (const s of [
        'take the merge lane',
        'grab the baton',
        'release the merge lane',
        'hand the baton to kilo',
        'give romeo the merge lane',
        'force the baton over to charlie',
        'cancel my merge lane request',
        'reclaim the merge lane',
        'romeo, request the merge lane when you are ready',
    ]) assert.equal(isBatonQuestion(s), false, s);
});

test('isBatonQuestion -- a command PHRASED as a question is still a command', () => {
    // FOUND BY A MUTATION PROBE. With the command-verb veto deleted, the test above still passed --
    // every sentence in it leads with a verb, so the leading-interrogative anchor was rejecting them all
    // and the veto was doing nothing measurable. It is only load-bearing for the polite forms, which
    // DO lead with an interrogative and reach the veto as the last line of defence. Those are also the
    // ones Chris is most likely to say, so the veto is not redundant -- the coverage was.
    for (const s of [
        'can you take the merge lane',
        'could you release the merge lane',
        'would you hand the baton to kilo',
        'who should take the merge lane next',
        'do you want to grab the merge lane',
    ]) assert.equal(isBatonQuestion(s), false, s);
});

test('isBatonQuestion -- THE ONE THAT MATTERS: it never eats a sentence aimed at a worker', () => {
    // This is the whole reason the interrogative has to LEAD. Every line here mentions the lane and is
    // addressed to a session; swallowing any of them would leave Chris talking to a worker that never
    // heard him, with nothing on any channel to say so.
    for (const s of [
        'romeo, what is your status on the merge lane',
        "kilo, what's left before you take the merge lane",
        'charlie, who should get the merge lane next',
        'golf, are you ready for the merge lane',
        'tell romeo the merge lane is his',
        'ask charlie who holds the merge lane',
        // No callsign at all, so anchoring alone cannot save this one: with a session focused, "your"
        // is the only thing distinguishing a question to that worker from a question to the hub.
        'what is your status on the merge lane',
        "what's your position in the merge queue",
    ]) assert.equal(isBatonQuestion(s), false, s);
});

test('isBatonQuestion -- the "your" veto is narrow: a bare "you" is still a hub question', () => {
    // A false negative costs nothing (the sentence falls through to the focused session, which is where
    // it was probably going anyway); a false positive eats it. But the veto must not be so wide that the
    // polite phrasings stop working, because those are the ones Chris actually uses.
    for (const s of ['do you know who has the baton', 'can you tell me who holds the merge lane']) {
        assert.equal(isBatonQuestion(s), true, s);
    }
});

test('isBatonQuestion -- an unrelated sentence with no lane noun never matches', () => {
    for (const s of [
        'who is running',
        'what is next',
        'merge your branch when the gate is green',
        'did the merge land',
        'context check',
        '',
        'jarvis',
    ]) assert.equal(isBatonQuestion(s), false, JSON.stringify(s));
});

test('isBatonQuestion -- garbage in, false out, never a throw', () => {
    for (const bad of [null, undefined, 42, {}, []]) assert.equal(isBatonQuestion(bad), false, String(bad));
});

test('speakBaton -- the plain answer: who holds it, for how long, who is behind', () => {
    const said = speakBaton({
        jarvis: { base: 'main', holder: { uid: 's_0411', cs: 'charlie', takenAt: at(-4) }, queue: [{ uid: 's_0416', cs: 'romeo', since: at(-2) }] },
    }, T0);
    assert.equal(said, 'Charlie holds the jarvis merge lane, for 4 minutes. Romeo is waiting behind it.', said);
});

test('speakBaton -- a lane nobody is waiting on says so, and does not trail off', () => {
    const said = speakBaton({ jarvis: { base: 'main', holder: { uid: 's_0411', cs: 'charlie', takenAt: at(-1) }, queue: [] } }, T0);
    assert.equal(said, 'Charlie holds the jarvis merge lane, for a minute. Nobody is waiting.', said);
});

test('speakBaton -- more than one waiting is read as a count THEN the names', () => {
    // Headline first: the number is what he needs, the names are the detail. Reading three names with no
    // count in front is exactly the list-instead-of-headline the voice channel is supposed to avoid.
    const said = speakBaton({
        jarvis: { base: 'main', holder: { uid: 's_1', cs: 'charlie', takenAt: at(-11) }, queue: [{ uid: 's_2', cs: 'romeo' }, { uid: 's_3', cs: 'kilo' }, { uid: 's_4', cs: 'golf' }] },
    }, T0);
    assert.match(said, /^Charlie holds the jarvis merge lane, for 11 minutes\. 3 are waiting: romeo, kilo, golf\.$/, said);
});

test('speakBaton -- a fresh grant says "just now" rather than "for 0 minutes"', () => {
    const said = speakBaton({ jarvis: { holder: { uid: 's_1', cs: 'charlie', takenAt: at(0) }, queue: [] } }, T0);
    assert.match(said, /^Charlie holds the jarvis merge lane, just now\./, said);
});

test('speakBaton -- an unreadable or future takenAt drops the duration, it does not invent one', () => {
    for (const takenAt of [null, undefined, '', 'not-a-date', at(+5)]) {
        const said = speakBaton({ jarvis: { holder: { uid: 's_1', cs: 'charlie', takenAt }, queue: [] } }, T0);
        assert.equal(said, 'Charlie holds the jarvis merge lane. Nobody is waiting.', String(takenAt));
    }
});

test('speakBaton -- EVERY LANE FREE is an answer, and gets said', () => {
    // The normal state, and the one the question is most often asked in. Staying silent here would read
    // as the hub not having heard him.
    const clear = 'Nobody holds a merge lane. Everyone is clear to merge.';
    assert.equal(speakBaton({}, T0), clear);
    assert.equal(speakBaton({ jarvis: { base: 'main', holder: null, queue: [] } }, T0), clear, 'a lane row with nobody in it is still free');
    for (const bad of [null, undefined, 'lanes', 42]) assert.equal(speakBaton(bad, T0), clear, String(bad));
});

test('speakBaton -- a queue with NO holder reads as mid-reap, not as a deadlock', () => {
    // Real and transient: the holder died and the 5-minute sweep has not run. Naming it stops Chris
    // intervening in something that fixes itself -- and a wedged lane is the failure the baton design
    // itself flagged as the dangerous one.
    const said = speakBaton({ jarvis: { base: 'main', holder: null, queue: [{ uid: 's_2', cs: 'romeo' }] } }, T0);
    assert.equal(said, 'The jarvis merge lane is free with one worker queued. It should grant on the next sweep.', said);
    const two = speakBaton({ jarvis: { holder: null, queue: [{ uid: 's_2', cs: 'romeo' }, { uid: 's_3', cs: 'kilo' }] } }, T0);
    assert.match(two, /free with 2 workers queued/, two);
});

test('speakBaton -- lanes are PER REPO, and a busy one never hides another', () => {
    // The lane is per repo by design (jarvis merging must not block TMS), so the spoken answer has to
    // cover every repo in play -- reporting only the first would answer "who holds the merge lane" with
    // one true sentence and one silent omission. Sorted by key so the sentence is stable to hear.
    const said = speakBaton({
        primeng: { base: 'NewBeta2', holder: { uid: 's_9', cs: 'quebec', takenAt: at(-2) }, queue: [] },
        jarvis: { base: 'main', holder: { uid: 's_1', cs: 'charlie', takenAt: at(-2) }, queue: [{ uid: 's_2', cs: 'romeo' }] },
    }, T0);
    assert.equal(said,
        'Charlie holds the jarvis merge lane, for 2 minutes. Romeo is waiting behind it. '
        + 'Quebec holds the primeng merge lane, for 2 minutes. Nobody is waiting.', said);
});

test('speakBaton -- an idle lane is SKIPPED, so a headline never becomes a list', () => {
    // batons.json accumulates a row per repo that has ever been used. Reading out "and the broker lane
    // is free, and the adhoc lane is free" is how a one-sentence answer turns into something he stops
    // asking for.
    const said = speakBaton({
        adhoc: { holder: null, queue: [] },
        broker: { base: 'master', holder: null, queue: [] },
        jarvis: { base: 'main', holder: { uid: 's_1', cs: 'charlie', takenAt: at(-3) }, queue: [] },
    }, T0);
    assert.equal(said, 'Charlie holds the jarvis merge lane, for 3 minutes. Nobody is waiting.', said);
});

test('speakBaton -- a lane entry that lost its callsign reads out the raw uid', () => {
    // Deliberately NOT prettified. If a uid is ever spoken it means a lane row was written without a
    // callsign, and hearing "ess zero four one six" is the signal that something upstream is wrong.
    const said = speakBaton({ jarvis: { holder: { uid: 's_0411', takenAt: at(-1) }, queue: [{ uid: 's_0416' }] } }, T0);
    assert.equal(said, 'S_0411 holds the jarvis merge lane, for a minute. S_0416 is waiting behind it.', said);
});

test('speakBaton -- it is spoken text, so it carries NO markup and no non-ASCII', () => {
    // /say goes to TTS and through curl.exe on Windows, where non-ASCII bytes come out as tofu. A
    // sentence built for the ear must not pick up the console's chips, arrows or dashes.
    const said = speakBaton({
        jarvis: { base: 'main', holder: { uid: 's_1', cs: 'charlie', takenAt: at(-7) }, queue: [{ uid: 's_2', cs: 'romeo' }, { uid: 's_3', cs: 'kilo' }] },
    }, T0);
    assert.equal(/[^\x20-\x7e]/.test(said), false, said);
    assert.equal(/[<>&#]/.test(said), false, said);
    assert.match(said, /\.$/, 'it ends as a sentence: ' + said);
});

test('speakBaton -- normalizeLane still guards it: one uid cannot be seated twice', () => {
    // The lane invariant (a uid appears at most once across holder+queue) is enforced by normalizeLane,
    // which speakBaton routes every lane through. Without that, a hand-edited batons.json would have the
    // holder announced as waiting behind itself.
    const said = speakBaton({
        jarvis: { holder: { uid: 's_1', cs: 'charlie', takenAt: at(-1) }, queue: [{ uid: 's_1', cs: 'charlie' }, { uid: 's_2', cs: 'romeo' }] },
    }, T0);
    assert.equal(said, 'Charlie holds the jarvis merge lane, for a minute. Romeo is waiting behind it.', said);
});
