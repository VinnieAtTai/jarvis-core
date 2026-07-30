// THE BOOT PROMPT'S LENGTH IS A LAUNCH FAILURE, and the most expensive kind: a silent one.
//
// spawnWorker assembles a paragraph and hands it to claude, but not as a string to a function --
// node-pty runs claude through cmd.exe (it resolves to a .cmd) and the wt-new-tab fallback writes the
// prompt inline into a batch file, so either way the whole thing is re-parsed as a WINDOWS COMMAND
// LINE. CreateProcess refuses one longer than 32767 chars. Past that the spawn does not error: the
// worker never registers and leaves a completely EMPTY log, indistinguishable from every other launch
// failure. That is exactly what happened on 2026-07-30 -- the jarvis project store grew to 46 open
// threads, subworkerBrief pasted all 30570 chars of them into a 31822-char prompt, and dispatch was
// dead. Two sessions were lost before quebec found the mechanism.
//
// Trimming the store fixed that morning. These pin the general fix, which is that no store, purpose or
// paragraph added later can do it again:
//   - the STORY is bounded before it ever reaches the prompt   (test/projects.test.mjs, BRIEF CAP)
//   - the FINISHED PROMPT is bounded once, for every launch branch                  (capBootPrompt)
//   - a prompt that had to be cut SAYS SO on the bus                    (the source guards at the end)
// The third is not a nicety. The entire cost of the original bug was that nothing said anything, and a
// silent cap would trade an invisible brick for an invisible blind spot -- a worker acting confidently
// on instructions it never received.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capBootPrompt, subworkerBrief, CMD_LINE_MAX, CMD_BATCH_EXPANSION_MAX, BOOT_PROMPT_MAX, BOOT_PROMPT_TAIL_KEEP, BOOT_CUT_MARKER } from '../jarvis-text.mjs';

const CORE = readFileSync(fileURLToPath(new URL('../jarvis-core.mjs', import.meta.url)), 'utf8');

// The two paragraphs that really are at the end of every boot prompt, quoted in shape from
// spawnWorker: which worktree you are in, and which commands are pre-approved.
const TAIL = ' You are in a DEDICATED git worktree at d:/claude/.jarvis-wt/jarvis-romeo-3 on branch'
    + ' jarvis/romeo-3 (forked from main). Do NOT switch branches and do not go looking for the main'
    + ' checkout. Permissions: read-only and routine build commands run WITHOUT asking the human; only'
    + ' risky or out-of-repo actions prompt.';
const promptOf = (storyChars) => 'You are a JARVIS worker session. Fetch /protocol and follow it exactly.'
    + ' You are a SUB-WORKER under ' + 'S'.repeat(storyChars) + '.' + TAIL;

// --- the ceiling ---------------------------------------------------------------------------------

test('BOOT LEN: the enforced cap leaves real room under the ceiling CreateProcess actually enforces', () => {
    // The gap is the launcher's own chrome, which is NOT part of the string measured here: the quoted
    // claude.exe path, --permission-mode, --model, --settings plus its DATA path, and cmd.exe's wrapper.
    // A cap set AT the ceiling would pass every test in this file and still brick a spawn.
    assert.ok(BOOT_PROMPT_MAX < CMD_LINE_MAX, 'the cap does not sit under the ceiling');
    assert.ok(CMD_LINE_MAX - BOOT_PROMPT_MAX >= 2000, 'too little headroom for the launcher chrome');
    assert.equal(CMD_LINE_MAX, 32767, 'CMD_LINE_MAX is no longer the Windows command-line limit');
});

// --- capBootPrompt -------------------------------------------------------------------------------

test('BOOT LEN: a prompt that fits is passed through untouched', () => {
    // The ordinary path, and the one that must not churn: today a fully-briefed sub-worker measures
    // ~12k, so this is what happens on every real spawn.
    const p = promptOf(11000);
    const r = capBootPrompt(p);
    assert.equal(r.truncated, false);
    assert.equal(r.text, p, 'a prompt inside the cap was modified');
    assert.equal(r.cut, 0);
    assert.equal(r.length, p.length);
    assert.equal(r.original, p.length);
});

test('BOOT LEN: a prompt over the cap comes back AT the cap, with the numbers to report it', () => {
    const p = promptOf(40000);
    const r = capBootPrompt(p);
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, BOOT_PROMPT_MAX, 'the cut prompt is not exactly the cap: ' + r.text.length);
    assert.equal(r.length, r.text.length);
    assert.equal(r.original, p.length, 'the original length was lost, so nothing can report what happened');
    assert.equal(r.cut, p.length - (r.length - BOOT_CUT_MARKER.length), 'the reported cut does not account for the bytes');
    assert.ok(r.cut > 0);
});

test('BOOT LEN: a cut keeps the HEAD and the TAIL -- the safety paragraphs are not what gets dropped', () => {
    // THE ASSERTION THIS FUNCTION EXISTS FOR. Cutting from the end is the obvious implementation and it
    // is the dangerous one: the tail is where "you are in worktree X", "do not switch branches" and the
    // permission rules live. A worker that lost those is not a worker with less context, it is one that
    // goes looking for the main checkout. The story in the middle it can fetch back from /project; those
    // it cannot fetch from anywhere.
    const r = capBootPrompt(promptOf(40000));
    assert.match(r.text, /^You are a JARVIS worker session\./, 'the head of the prompt was dropped');
    assert.ok(r.text.endsWith('risky or out-of-repo actions prompt.'), 'the cut ate the tail of the prompt');
    assert.match(r.text, /Do NOT switch branches/, 'the worktree instruction was cut');
    assert.match(r.text, /read-only and routine build commands/, 'the permissions paragraph was cut');
    assert.ok(r.text.length - r.text.lastIndexOf(BOOT_CUT_MARKER) >= BOOT_PROMPT_TAIL_KEEP,
        'less than the promised tail survived the cut');
});

test('BOOT LEN: the worker is TOLD, in the prompt itself, that what it holds is incomplete', () => {
    // A model handed a truncated brief with no marker reads it as a complete one. The marker is the only
    // channel that reaches the party actually acting on the missing instructions.
    const r = capBootPrompt(promptOf(40000));
    assert.match(r.text, /PROMPT CUT BY THE HUB/);
    assert.match(r.text, /INCOMPLETE/, 'the marker does not say the brief is incomplete');
    assert.match(r.text, /GET \/project/, 'the marker does not say where the rest is');
    assert.equal(r.text.split('PROMPT CUT BY THE HUB').length - 1, 1, 'the prompt was cut in more than one place');
});

test('BOOT LEN: the marker itself cannot break the command line it is inserted into', () => {
    // It travels in the same cmd.exe command line as everything else, where `<` and `>` are REDIRECTIONS
    // that kill a spawn outright (charlie, 2026-07-29) and a non-ASCII byte comes out as tofu.
    assert.ok(!/[<>%|&^]/.test(BOOT_CUT_MARKER), 'the marker carries a cmd.exe metacharacter: ' + BOOT_CUT_MARKER);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x20-\x7e]/.test(BOOT_CUT_MARKER), 'the marker is not plain ASCII');
    assert.ok(BOOT_CUT_MARKER.length < 400, 'the marker is eating the budget it is meant to protect');
});

test('BOOT LEN: the cap is never exceeded, whatever it is set to and whatever it is fed', () => {
    // The one invariant everything else rests on, over the whole degenerate range -- including a cap
    // smaller than the marker, where there is no room to explain the cut and a bare slice is the only
    // honest answer. If any of these returns something longer than the cap, the guard is decorative.
    for (const cap of [1, 40, BOOT_CUT_MARKER.length, BOOT_CUT_MARKER.length + 1, 500, 5000, 24000]) {
        const r = capBootPrompt(promptOf(40000), cap);
        assert.ok(r.text.length <= cap, 'cap ' + cap + ' produced ' + r.text.length + ' chars');
        assert.equal(r.truncated, true);
        assert.equal(r.length, r.text.length);
    }
});

test('BOOT LEN: tailKeep 0 cuts from the end, and a tail bigger than the budget cannot squeeze the head out', () => {
    const none = capBootPrompt(promptOf(40000), 5000, 0);
    assert.ok(none.text.length <= 5000);
    assert.match(none.text, /^You are a JARVIS worker session\./);
    assert.ok(none.text.endsWith(BOOT_CUT_MARKER), 'with no tail kept, the marker must be the last thing in the prompt');
    const greedy = capBootPrompt(promptOf(40000), 5000, 99999);
    assert.ok(greedy.text.length <= 5000, 'an oversized tailKeep blew the cap');
    assert.ok(greedy.text.indexOf(BOOT_CUT_MARKER) > 0, 'an oversized tailKeep left no head at all');
});

test('BOOT LEN: junk in does not throw and does not invent a prompt', () => {
    for (const junk of [null, undefined, 0, {}]) {
        const r = capBootPrompt(junk);
        assert.equal(typeof r.text, 'string');
        assert.equal(r.truncated, false);
    }
    assert.equal(capBootPrompt(null).text, '');
    // A nonsense cap falls back to the default rather than to "no cap" or to zero.
    assert.equal(capBootPrompt(promptOf(40000), -5).text.length, BOOT_PROMPT_MAX);
    assert.equal(capBootPrompt(promptOf(40000), 'nope').text.length, BOOT_PROMPT_MAX);
});

test('BOOT LEN: THE 2026-07-30 SPAWN: a 46-thread store composes a prompt that launches, uncut', () => {
    // End to end through the two caps, on the shipping defaults, from the store shape that actually
    // killed dispatch. Pre-fix this composed 31822 chars and the worker never came up. The prompt must
    // now fit -- and it must fit WITHOUT the backstop firing, because a cap that trips on a routine
    // spawn would quietly degrade every worker instead of one.
    const story = subworkerBrief({
        name: 'jarvis', title: 'JARVIS core',
        context: {
            summary: 'x'.repeat(467), currentFocus: 'y'.repeat(221),
            openThreads: Array.from({ length: 46 }, (_, i) => ('T' + i + ' ').padEnd(660, 'z')),
        },
    }, null);
    const boot = 'You are a JARVIS worker session. Fetch /protocol and follow it exactly. Register with pin: romeo.'
        + ' You are a SUB-WORKER under ' + story + ' ' + 'P'.repeat(2500) + TAIL;   // + the standing paragraphs
    const r = capBootPrompt(boot);
    assert.equal(r.truncated, false, 'the backstop fired on an ordinary sub-worker spawn (' + r.original + ' chars)');
    assert.ok(r.text.length < CMD_LINE_MAX, 'the prompt still exceeds the Windows command-line limit: ' + r.text.length);
    assert.ok(r.text.length < BOOT_PROMPT_MAX, 'the prompt is over the enforced cap: ' + r.text.length);
});

// --- the wiring: one site, before both launches, and never silent --------------------------------
//
// Source-level on purpose, and for the same reason the dispatch guard in deadspawn.test.mjs is: what
// went wrong was never a wrong value, it was a decision that some code path did not go through. The
// wt-new-tab branch shells out to wt.exe and no test can reach it, so "the cap happens before anything
// can launch" is only provable by reading the file.

test('BOOT LEN: the prompt is capped ONCE, before either launch branch can carry it', () => {
    const capAt = CORE.indexOf('capBootPrompt(boot');
    assert.ok(capAt > 0, 'jarvis-core.mjs never caps the boot prompt');
    assert.equal(CORE.split('capBootPrompt(').length - 1, 1, 'the cap is applied at more than one site');
    // No local override. The call site passing its own limit is how a cap gets quietly raised back over
    // the ceiling while every unit test above still passes -- they test the function, not the caller.
    assert.match(CORE, /capBootPrompt\(boot\)/, 'the wiring passes its own cap instead of the enforced default');
    assert.ok(CORE.indexOf('boot = capped.text') > capAt, 'the capped text is never put back into `boot`');
    for (const launch of ['spawnWorkerConsoleless(cs, runRepo, boot', 'writeFileSync(scriptPath']) {
        const at = CORE.indexOf(launch);
        assert.ok(at > 0, 'this launch branch has moved or been renamed: ' + launch);
        assert.ok(at > capAt, 'a launch branch carries the prompt BEFORE it is capped: ' + launch);
    }
});

test('BOOT LEN: a prompt that had to be cut is announced, never swallowed', () => {
    // The rule the original bug is made of. A cut that only the code knows about is the same silence in
    // a new place: the next session sees a worker behaving oddly and no cause anywhere.
    const branch = /if \(capped\.truncated\) \{([\s\S]*?)\n {4}\}/.exec(CORE);
    assert.ok(branch, 'the truncation branch has gone from jarvis-core.mjs');
    assert.match(branch[1], /record\(\{ kind: 'sys'/, 'a cut prompt leaves no sys line on the bus');
    assert.match(branch[1], /enqueueSay\(/, 'a cut prompt is never spoken about');
    assert.match(branch[1], /\+ cs \+/, 'the announcement does not name the callsign');
    assert.match(branch[1], /capped\.original/, 'the announcement does not say how long the prompt was');
});

test('BOOT LEN: the .cmd launch line expands nothing, which is what keeps its budget 32767 and not 8191', () => {
    // MEASURED, 2026-07-30 on this box, because "cmd.exe caps a line at 8191" is the half-truth that
    // would otherwise get the cap above slashed by two thirds -- or leave the wt fallback quietly broken
    // if it were true and ignored. A batch line with NOTHING to expand carried 32700 chars fine; the same
    // line carrying a %~dp0 died at ~8191 chars of EXPANDED text with "The input line is too long."
    //
    // So the .cmd branch gets the full CreateProcess budget only as long as its claude line stays
    // literal. Put a %VAR% or a %~dp0 on it -- or stop stripping % out of the spoken purpose -- and the
    // real limit drops to 8191 while every length test in this file still passes, which is precisely how
    // this class of bug keeps arriving.
    const block = /writeFileSync\(scriptPath, \[([\s\S]*?)\]\.join/.exec(CORE);
    assert.ok(block, 'the .cmd launch block has moved or been renamed');
    const claudeLine = block[1].split('\n').find(l => /resolveClaude\(\)/.test(l));
    assert.ok(claudeLine, 'the .cmd block no longer launches claude');
    assert.ok(claudeLine.indexOf('%') < 0,
        'the .cmd launch line now expands a variable, which caps the whole prompt at 8191: ' + claudeLine.trim());
    assert.match(CORE, /safePurpose = purpose\.replace\([^)]*%[^)]*\)/,
        'the purpose no longer has % stripped, so a spoken purpose can put an expansion on that line');
    assert.ok(BOOT_PROMPT_MAX > CMD_BATCH_EXPANSION_MAX,
        'the cap has been cut to the expansion limit; if that was deliberate, this test is what to read first');
});

test('BOOT LEN: the sub-worker is told where the context it was NOT given lives', () => {
    // The compensating control for the cap, and it is load-bearing: bounding the story is only safe
    // because the boot text says how to fetch the rest. Source-level because that paragraph is prose in
    // spawnWorker that no unit test can reach -- and prose is exactly what gets "tidied" away later.
    const para = /if \(subOf\) \{([\s\S]*?)\n {4}\}/.exec(CORE);
    assert.ok(para, 'the sub-worker paragraph has gone from spawnWorker');
    assert.match(para[1], /\/project\?name=' \+ subOf/, 'a capped brief no longer points at the full store');
    assert.match(para[1], /bounded slice/, 'the boot text does not admit the story is a slice');
    assert.match(para[1], /docs\/PROJECT-THREADS\.md/, 'the boot text no longer names the thread archive');
});
