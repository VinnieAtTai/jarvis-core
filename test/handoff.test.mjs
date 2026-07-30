// Unit tests for the pure retire/handoff helpers in jarvis-text.mjs (cwdKey,
// shouldSpawnSuccessor, boardHasWork, transferBoard). Run with `npm test` (node --test).
// No server boot, no I/O, no worker spawn — these import the real functions the hub uses, so the
// successor decision and board-transfer accounting are exercised exactly as retireSession sees them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cwdKey, handoffKey, shouldSpawnSuccessor, boardHasWork, transferBoard, reconstructHandoff } from '../jarvis-text.mjs';
import { createScratchHub, assertConsolelessPossible, treeKill, recordBootPrompts, bootPrompt } from '../test-support/scratch-hub.mjs';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// The integration half at the bottom boots a real hub and spawns one real successor. SKIPPED by
// default, same gate as every other rig in this suite:  npm run test:integration
const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub and spawns a successor)';

// A v3 task object, shaped like the ones on the board.
const task = (id, text) => ({ id, text, addedAt: 'STAMP' });

test('cwdKey — case/separator/trailing-slash insensitive', () => {
    assert.equal(cwdKey('D:\\claude\\jarvis-core'), 'd:/claude/jarvis-core');
    assert.equal(cwdKey('D:/Claude/Jarvis-Core/'), 'd:/claude/jarvis-core');
    assert.equal(cwdKey('d:/claude/jarvis-core///'), 'd:/claude/jarvis-core');
    // mixed separators and a trailing backslash normalize to the same key
    assert.equal(cwdKey('D:\\claude\\jarvis-core\\'), cwdKey('d:/claude/jarvis-core'));
});

test('cwdKey — nullish/empty', () => {
    assert.equal(cwdKey(null), '');
    assert.equal(cwdKey(undefined), '');
    assert.equal(cwdKey(''), '');
});

test('handoffKey — same cwd, different purposes -> different keys (the bug fix)', () => {
    // The regression: d:/code/tms hosted both a PrimeNG-QA worker and a TMS-20018 mileage worker.
    // Keyed by cwd alone they collided; scoped by purpose they must not.
    const a = handoffKey('d:/code/tms', 'PrimeNG 17->18 visual QA of modals/forms');
    const b = handoffKey('d:/code/tms', 'TMS-20018 multi-stop/round-trip mileage bug');
    assert.notEqual(a, b, 'two unrelated jobs on one cwd must get distinct handoff keys');
});

test('handoffKey — same cwd + same purpose -> same key (a restart finds its own handoff)', () => {
    assert.equal(
        handoffKey('D:\\code\\tms', 'PrimeNG visual QA'),
        handoffKey('d:/code/tms/', 'PrimeNG visual QA'),
        'a manual restart of the same job re-derives the same key',
    );
});

test('handoffKey — purpose is normalized (case, surrounding + collapsed whitespace)', () => {
    assert.equal(
        handoffKey('d:/code/tms', '  PrimeNG   visual   QA '),
        handoffKey('d:/code/tms', 'primeng visual qa'),
        'trivial re-typings of the purpose still match',
    );
});

test('handoffKey — cwd component is cwdKey-normalized', () => {
    // The cwd half of the key normalizes exactly like cwdKey (case/separator/trailing-slash).
    assert.ok(handoffKey('D:/Code/TMS/', 'x').startsWith(cwdKey('d:\\code\\tms')));
});

test('handoffKey — no boundary collision between (cwd, purpose) pairs', () => {
    // A path can contain spaces and a purpose is free text, so a plain-space joiner could let
    // ("c:/a", "b c") and ("c:/a b", "c") collide. The newline joiner makes that impossible.
    assert.notEqual(handoffKey('c:/a', 'b c'), handoffKey('c:/a b', 'c'));
});

test('handoffKey — nullish/empty purpose is stable', () => {
    assert.equal(handoffKey('d:/code/tms', null), handoffKey('d:/code/tms', undefined));
    assert.equal(handoffKey('d:/code/tms', ''), handoffKey('d:/code/tms', null));
});

test('shouldSpawnSuccessor — explicit true always spawns (even with no work)', () => {
    assert.equal(shouldSpawnSuccessor(true, false), true);
    assert.equal(shouldSpawnSuccessor(true, true), true);
});

test('shouldSpawnSuccessor — explicit false never spawns (even with work)', () => {
    assert.equal(shouldSpawnSuccessor(false, true), false);
    assert.equal(shouldSpawnSuccessor(false, false), false);
});

test('shouldSpawnSuccessor — omitted: auto-spawn iff work remains', () => {
    assert.equal(shouldSpawnSuccessor(undefined, true), true);
    assert.equal(shouldSpawnSuccessor(undefined, false), false);
    // any non-boolean (e.g. a truthy/falsy non-true value) behaves like "omitted": work decides
    assert.equal(shouldSpawnSuccessor(null, true), true);
    assert.equal(shouldSpawnSuccessor(null, false), false);
    assert.equal(shouldSpawnSuccessor(1, false), false, 'a truthy non-true value is NOT an explicit yes');
});

test('boardHasWork — working or queued counts; review/done do not', () => {
    assert.equal(boardHasWork({ working: [task('w1', 'a')], queued: [] }), true);
    assert.equal(boardHasWork({ working: [], queued: [task('q1', 'b')] }), true);
    assert.equal(boardHasWork({ working: [], queued: [] }), false);
    // review/done alone is NOT unfinished work
    assert.equal(boardHasWork({ working: [], queued: [], review: [task('r1', 'c')], done: [task('d1', 'e')] }), false);
});

test('boardHasWork — missing/odd lanes are treated as empty', () => {
    assert.equal(boardHasWork({}), false);
    assert.equal(boardHasWork(null), false);
    assert.equal(boardHasWork(undefined), false);
    assert.equal(boardHasWork({ working: 'nope', queued: 'nope' }), false);
});

test('transferBoard — working+queued land at the FRONT of a fresh successor queue', () => {
    const from = {
        working: [task('w1', 'in progress')],
        queued: [task('q1', 'next'), task('q2', 'later')],
        review: [task('r1', 'review me')],
        done: [task('d1', 'done')],
    };
    const fresh = { working: [], queued: [], review: [], done: [] };
    const { board, moved, total, dropped } = transferBoard(from, fresh);
    // unfinished = working ++ queued, in that order, at the front of queue
    assert.deepEqual(board.queued.map(t => t.id), ['w1', 'q1', 'q2']);
    assert.deepEqual(board.review.map(t => t.id), ['r1']);
    assert.deepEqual(board.done.map(t => t.id), ['d1']);
    assert.deepEqual(board.working, [], 'successor starts with nothing in progress');
    // total counts predecessor tasks (unfinished+review+done = 3+1+1 = 5); a fresh successor
    // means moved == total and nothing dropped
    assert.equal(total, 5);
    assert.equal(moved, 5);
    assert.equal(dropped, false);
});

test('transferBoard — preserves a successor queue, prepending the inherited work', () => {
    const from = { working: [task('w1', 'a')], queued: [task('q1', 'b')], review: [], done: [] };
    const existing = { working: [], queued: [task('pre', 'already here')], review: [], done: [] };
    const { board, moved, total, dropped } = transferBoard(from, existing);
    // inherited work goes to the front, the successor's own queued item stays behind it
    assert.deepEqual(board.queued.map(t => t.id), ['w1', 'q1', 'pre']);
    assert.equal(total, 2, 'total counts only the predecessor tasks');
    assert.equal(moved, 3, 'moved counts the whole resulting board (incl. the pre-existing item)');
    // moved >= total -> nothing reported dropped
    assert.equal(dropped, false);
});

test('transferBoard — review and done carry over at the front of their lanes', () => {
    const from = { working: [], queued: [], review: [task('r1', 'a')], done: [task('d1', 'x'), task('d2', 'y')] };
    const existing = { working: [], queued: [], review: [task('er', 'old review')], done: [task('ed', 'old done')] };
    const { board } = transferBoard(from, existing);
    assert.deepEqual(board.review.map(t => t.id), ['r1', 'er']);
    assert.deepEqual(board.done.map(t => t.id), ['d1', 'd2', 'ed']);
});

test('transferBoard — empty predecessor board moves nothing', () => {
    const { board, moved, total, dropped } = transferBoard(
        { working: [], queued: [], review: [], done: [] },
        { working: [], queued: [], review: [], done: [] },
    );
    assert.deepEqual(board, { working: [], queued: [], review: [], done: [] });
    assert.equal(total, 0);
    assert.equal(moved, 0);
    assert.equal(dropped, false);
});

test('transferBoard — missing lanes default to empty (no crash, no phantom tasks)', () => {
    // predecessor with only working; successor totally empty object
    const { board, moved, total } = transferBoard({ working: [task('w1', 'a')] }, {});
    assert.deepEqual(board.queued.map(t => t.id), ['w1']);
    assert.deepEqual(board.working, []);
    assert.deepEqual(board.review, []);
    assert.deepEqual(board.done, []);
    assert.equal(total, 1);
    assert.equal(moved, 1);
});

test('transferBoard — nullish inputs yield an empty board', () => {
    const { board, moved, total, dropped } = transferBoard(null, null);
    assert.deepEqual(board, { working: [], queued: [], review: [], done: [] });
    assert.equal(total, 0);
    assert.equal(moved, 0);
    assert.equal(dropped, false);
});

test('transferBoard — does not mutate the predecessor board', () => {
    const from = { working: [task('w1', 'a')], queued: [task('q1', 'b')], review: [], done: [] };
    const snapshot = JSON.parse(JSON.stringify(from));
    transferBoard(from, { working: [], queued: [], review: [], done: [] });
    assert.deepEqual(from, snapshot, 'source board is left untouched');
});
// --- reconstructHandoff: the handoff a predecessor never wrote -----------------------------------
//
// THE INCIDENT. The console's relaunch button is POST /retire {successor:true} carrying a fixed
// summary and nothing else, so the record filed for the successor had notes:"" -- and the successor's
// boot prompt sent it to GET /handoff for a briefing that was empty. Measured 2026-07-30: tango was
// relaunched, and zulu inherited a board card plus a WIP commit on an inherited branch with nothing
// anywhere pointing at either of them. Every fact it needed was already on the session row.

// tango's row as it actually looked, and the board it left behind.
const TANGO = {
    callsign: 'tango', cwd: 'd:/claude/jarvis-core', purpose: 'wedge chip + escalation guard',
    started: '2026-07-30T09:12:04.000Z', ended: '2026-07-30T13:40:11.000Z',
    doing: 'working: wedge chip render', ctx: 62,
    worktree: 'd:/claude/.jarvis-wt/jarvis-tango', branch: 'jarvis/tango', base: 'main',
    summary: 'Worker relaunched from console (hub untouched).', handoff: '',
};
const TANGO_BOARD = { working: [task('w1', 'a')], queued: [task('q1', 'b'), task('q2', 'c')], review: [task('r1', 'd')], done: [task('d1', 'e')] };

test('reconstructHandoff -- THE BUG: a relaunch that left no notes still hands over the branch and the diff', () => {
    const auto = reconstructHandoff(TANGO, TANGO_BOARD, { uid: 's_0412', wip: 'committed' });
    // The two facts zulu did not have and could not have guessed.
    assert.match(auto, /jarvis\/tango/, 'the inherited branch is not named, which is the whole defect');
    assert.match(auto, /FIRST MOVE: git log --oneline main\.\.jarvis\/tango/,
        'nothing sends the successor to the commits that stand in for the notes');
    assert.match(auto, /committed to jarvis\/tango as a WIP commit/, 'the WIP commit is not mentioned');
});

test('reconstructHandoff -- it says the HUB assembled it, in-band, whether or not notes exist', () => {
    // The reader is a model. A successor that mistakes reconstructed facts for a predecessor's
    // judgement trusts them further than they deserve, and the field name alone does not survive the
    // block being quoted or truncated -- so the provenance is the first line of the text itself.
    for (const handoff of ['', 'I checkpointed properly, here is where I was.']) {
        const auto = reconstructHandoff({ ...TANGO, handoff }, TANGO_BOARD, { uid: 's_0412', wip: 'none' });
        assert.match(auto.split('\n')[0], /^ASSEMBLED BY THE HUB FROM OBSERVABLE FACTS/,
            'the first line does not say who wrote this (handoff=' + JSON.stringify(handoff) + ')');
        assert.match(auto.split('\n')[0], /not written by your predecessor/);
    }
});

test('reconstructHandoff -- a session that DID checkpoint still gets the facts its notes cannot know', () => {
    // Computed for every record, not only the noteless ones: a checkpoint is written mid-flight, so it
    // predates the teardown and can never mention the WIP commit that carries the last of the work.
    const auto = reconstructHandoff({ ...TANGO, handoff: 'notes I wrote an hour ago' }, TANGO_BOARD,
        { uid: 's_0412', wip: 'committed' });
    assert.match(auto, /Read it alongside the notes it did leave/);
    assert.match(auto, /WIP commit/, 'a checkpointed predecessor lost the WIP verdict its notes predate');
});

test('reconstructHandoff -- the branch line and the diff range come from the RECORDED base, not a guess', () => {
    // FOUND BY MUTATION PROBE, and it is the trap this project already wrote a rule about: the first cut
    // asserted 'main..jarvis/tango' against a fixture whose base WAS 'main' -- which is also the
    // fallback -- so hardcoding the fallback passed. A needle unique only by accident proves nothing.
    const auto = reconstructHandoff({ ...TANGO, base: 'release/2026-07' }, TANGO_BOARD, { uid: 's_0412', wip: 'none' });
    assert.match(auto, /FIRST MOVE: git log --oneline release\/2026-07\.\.jarvis\/tango/);
    // ...and the branch line has to stand on its OWN. Deleting it outright ALSO survived the first cut,
    // because FIRST MOVE happens to repeat the branch name -- so the one sentence that tells a successor
    // WHY that branch is already beneath it was pinned by nothing at all.
    assert.match(auto, /^branch: jarvis\/tango \(forked from release\/2026-07\) -- you continue ON IT in a fresh worktree/m);
});

test('reconstructHandoff -- a missing doing line is REPORTED, not omitted', () => {
    // Silence would read as "it was doing nothing". What is true is narrower and more useful: no
    // self-report exists anywhere, so the successor should not spend a turn hunting for one.
    const auto = reconstructHandoff({ ...TANGO, doing: '', ctx: null }, TANGO_BOARD, { uid: 's_0412' });
    assert.match(auto, /never posted a doing line/);
    assert.ok(!/last said it was doing/.test(auto), 'it claimed a doing line it does not have');
});

test('reconstructHandoff -- every WIP verdict is stated POSITIVELY, and unknown never reads as none', () => {
    // The distinction that matters: 'none' means the hub looked and the tree was clean; 'unknown' means
    // the tree was already gone and NOBODY looked. Collapsing the second into silence -- or into the
    // first -- tells a successor there is no in-flight work when there may be plenty.
    const of = wip => reconstructHandoff(TANGO, TANGO_BOARD, { uid: 's_0412', wip });
    assert.match(of('committed'), /UNCOMMITTED changes at retire and they were committed/);
    assert.match(of('stranded'), /would NOT commit.*KEPT at d:\/claude\/\.jarvis-wt\/jarvis-tango/);
    assert.match(of('none'), /in-flight work: none -- its worktree was clean/);
    assert.match(of('unknown'), /in-flight work: UNKNOWN/);
    assert.match(of(undefined), /in-flight work: UNKNOWN/, 'an absent verdict must not be silent');
    for (const wip of ['unknown', undefined]) {
        assert.ok(!/in-flight work: none/.test(of(wip)), 'nobody-looked was reported as nothing-to-look-at');
    }
});

test('reconstructHandoff -- a shared-cwd worker has no branch, so it is pointed at the checkout instead', () => {
    // No worktree means no branch to inherit and no WIP verdict that could mean anything -- the
    // in-flight line would be a claim about a tree that never existed.
    const auto = reconstructHandoff(
        { callsign: 'yankee', cwd: 'd:/code/tms', purpose: 'PrimeNG QA', started: TANGO.started, ended: TANGO.ended },
        {}, { uid: 's_0500' });
    assert.match(auto, /FIRST MOVE: git log --oneline -20 and git status in d:\/code\/tms/);
    assert.ok(!/in-flight work/.test(auto), 'it made an in-flight claim about a worktree that never existed');
    assert.ok(!/branch:/.test(auto), 'it named a branch for a worker that shared the checkout');
});

test('reconstructHandoff -- the board counts come from the snapshot, all four lanes', () => {
    assert.match(reconstructHandoff(TANGO, TANGO_BOARD, {}),
        /board carried over: 1 working \+ 2 queued \(and 1 in review, 1 done\)/);
    // An empty board still says so rather than dropping the line: "0 working + 0 queued" is the answer
    // to "what did I inherit", and its absence is not.
    assert.match(reconstructHandoff(TANGO, { working: [], queued: [] }, {}),
        /board carried over: 0 working \+ 0 queued/);
});

test('reconstructHandoff -- an unusable span is a MISSING line, never a wrong one', () => {
    // A clock-skewed or half-open pair must not print a negative duration, and must not invent one.
    for (const [started, ended] of [[TANGO.started, null], [null, TANGO.ended], [TANGO.ended, TANGO.started], ['junk', 'junk']]) {
        const auto = reconstructHandoff({ ...TANGO, started, ended }, TANGO_BOARD, { uid: 's_0412' });
        assert.match(auto, /^predecessor: tango \(s_0412\)$/m,
            'the span line is wrong rather than absent for ' + JSON.stringify([started, ended]));
    }
    assert.match(reconstructHandoff(TANGO, TANGO_BOARD, {}), /^predecessor: tango, on the job 4h 28m /m);
});

test('reconstructHandoff -- ASCII only: curl.exe mangles anything else into tofu', () => {
    const auto = reconstructHandoff(TANGO, TANGO_BOARD, { uid: 's_0412', wip: 'committed' });
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x20-\x7e\n]/.test(auto), 'the block carries non-ASCII, which arrives as replacement glyphs');
});

test('reconstructHandoff -- junk in, a usable block out (it runs inside retire and must never throw)', () => {
    for (const [s, b] of [[null, null], [undefined, undefined], [{}, {}], [{ callsign: 'x' }, { working: 'nope' }]]) {
        const auto = reconstructHandoff(s, b, null);
        assert.match(auto, /^ASSEMBLED BY THE HUB/, 'a junk session produced an unusable block');
        assert.match(auto, /board carried over: 0 working \+ 0 queued/);
    }
});

// --- the real thing -----------------------------------------------------------------------------

test('HANDOFF: a console relaunch hands its successor a record that is not empty',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        // The end-to-end shape of the bug, through the real HTTP path: a session that never checkpoints
        // is retired exactly the way the console's relaunch button retires it -- a fixed summary,
        // successor:true, no notes -- and the successor must find something worth reading.
        assertConsolelessPossible();
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        recordBootPrompts(hub);          // before start(): the stub is read at spawn time, not at boot
        await hub.start('handoff hub');

        const PURPOSE = 'the job nobody wrote down';
        const me = await hub.post('/register', { cwd: hub.REPO, purpose: PURPOSE });
        assert.ok(me && me.uid, '/register failed: ' + JSON.stringify(me));
        // The only state it ever reports about itself -- and until now the only place it went was a
        // roster row that dies with the session.
        await hub.post('/health', { uid: me.uid, context: 71, doing: 'working: the thing nobody wrote down' });
        await hub.post('/worklist', { op: 'add', callsign: me.callsign, text: 'WORK: unfinished when the human hit relaunch' });

        // VERBATIM the console's relaunch: console.js posts this summary, successor:true, and no notes.
        const bye = await hub.post('/retire', {
            uid: me.uid, summary: 'Worker relaunched from console (hub untouched).', successor: true,
        });
        assert.equal(bye.successor, true, 'the relaunch did not spawn a successor: ' + JSON.stringify(bye));

        // The stash the successor reads is keyed on ITS callsign, and the sys line is where the hub says
        // which callsign that is.
        const succ = await hub.waitFor('the successor to be named in the transcript', () => {
            const m = /-> successor ([a-z]+);/.exec(hub.transcript());
            return m ? m[1] : null;
        }, 60000);

        // GET /handoff?cs= is exactly what the successor's boot prompt tells it to fetch.
        const rec = await hub.get('/handoff?cs=' + succ);
        assert.ok(rec && !rec.none, 'the successor has no handoff record at all: ' + JSON.stringify(rec));

        // THE DEFECT IS STILL VISIBLE, and that is deliberate: `notes` remains what the predecessor
        // WROTE, which here is nothing. The fix is a second field beside it, not a fuller `notes` --
        // a successor has to be able to tell a reconstruction from a judgement.
        assert.equal(rec.notes, '', 'notes was back-filled; reconstructed facts must not pose as written ones');

        // ...and the successor is no longer holding an empty briefing.
        assert.ok(rec.auto && rec.auto.trim(), 'the relaunched successor still gets nothing: ' + JSON.stringify(rec));
        assert.match(rec.auto, /^ASSEMBLED BY THE HUB FROM OBSERVABLE FACTS/);
        assert.match(rec.auto, new RegExp('predecessor: ' + me.callsign), 'it does not say who it succeeded');
        assert.match(rec.auto, /working: the thing nobody wrote down/, 'the doing line did not survive the retire');
        assert.match(rec.auto, /its purpose: the job nobody wrote down/);
        assert.match(rec.auto, /FIRST MOVE:/, 'it does not tell the successor where to start looking');
        // The board really did come with it (1 queued card, nothing in progress after the transfer).
        assert.match(rec.auto, /board carried over: 0 working \+ 1 queued/);

        // ...AND THE SUCCESSOR IS TOLD TO READ IT. Filing a good record is half the fix: the boot prompt
        // is the only thing that ever points a successor at /handoff, and "read its notes" plus an empty
        // string is what a relaunched worker concluded meant "no context". FOUND BY MUTATION PROBE --
        // deleting this wording from the prompt killed nothing until this assertion existed, because no
        // test read a boot prompt on a handoff spawn at all.
        const boot = await bootPrompt(hub, succ);
        assert.match(boot, /MAY BE EMPTY/, 'the successor is not warned that notes can be empty');
        assert.match(boot, /"auto"/, 'the successor is never told the auto block exists: ' + boot.slice(-400));

        // ---- the OTHER call site: a live checkpoint files a record too -----------------------------
        // reconstructHandoff is called from two places, and until this ran only the retire path had a
        // test. A checkpoint knows strictly less than a retire does -- no span, and the worktree has not
        // been torn down -- so the point here is that the block still comes out usable and still says
        // UNKNOWN about in-flight work rather than implying there is nothing to look at.
        const other = await hub.post('/register', { cwd: hub.REPO, purpose: 'a session that checkpoints properly' });
        await hub.post('/health', { uid: other.uid, context: 40, doing: 'working: mid-flight' });
        const cp = await hub.post('/handoff', { uid: other.uid, summary: 'halfway', notes: 'I wrote real notes.' });
        assert.ok(cp && cp.ok, 'POST /handoff refused: ' + JSON.stringify(cp));
        const durable = await hub.get('/handoff?cwd=' + encodeURIComponent(hub.REPO)
            + '&purpose=' + encodeURIComponent('a session that checkpoints properly'));
        assert.equal(durable.notes, 'I wrote real notes.', 'the checkpoint lost its own notes');
        assert.match(durable.auto || '', /^ASSEMBLED BY THE HUB FROM OBSERVABLE FACTS/,
            'the checkpoint path files no auto block: ' + JSON.stringify(durable.auto));
        assert.match(durable.auto, /working: mid-flight/);
    });
// A git repo with one commit, the minimum `git worktree add` will fork from. Same helper the trust rig
// uses; kept local because promoting it is a change to shared test-support nobody asked for.
function initRepo(dir) {
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    git('init', '-b', 'main');
    git('-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base');
}
// The path the hub really made, read out of its own sys line rather than re-derived here -- a test that
// recomputes the path can get it wrong in exactly the way the code did.
const worktreePath = (hub, cs) => hub.waitFor('the worktree sys line for ' + cs, () => {
    const m = new RegExp('worktree for ' + cs + ':[^"]*? at ([^"\\\\]+)').exec(hub.transcript());
    return m ? m[1] : null;
}, 60000);

test('HANDOFF: what happened to the in-flight work is stated in the RECORD, not just in a sys line',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        // THE TANGO->ZULU ORPHAN, end to end. teardownWorktree has always committed a dying worker's
        // uncommitted changes to its branch and said so -- in a sys line, which is a channel the
        // SUCCESSOR never reads. So zulu inherited tango's branch with a WIP commit on it and nothing
        // anywhere told it to look. Three sub-workers, three worktree states, one hub:
        //   A  dirty at retire   -> the WIP commit is named, with the branch it landed on
        //   B  clean at retire   -> positively "none", so nobody re-reads a clean branch for lost work
        //   C  tree already gone -> "UNKNOWN", because nobody looked, which is NOT the same as none
        // FOUND BY MUTATION PROBE: without C, defaulting the verdict to 'none' survives, and that
        // mutant turns "nobody looked" into "nothing to look at" -- the more dangerous of the two.
        assertConsolelessPossible();
        const hub = await createScratchHub({ worktrees: true, graceMs: 5000 });
        t.after(() => hub.dispose());
        initRepo(hub.REPO);
        await hub.start('handoff worktree hub');

        const JOBS = {
            A: 'the job that was mid-edit',
            B: 'the job that had committed everything',
            C: 'the job whose tree went missing',
        };
        const started = {};
        for (const [k, purpose] of Object.entries(JOBS)) {
            // parentProject is what makes a sub-worker, and sub-workers are the ones that get isolated.
            const cs = await hub.spawnWorker({ cwd: hub.REPO, purpose, parentProject: 'probe' });
            const wt = await worktreePath(hub, cs);
            const row = await hub.waitFor(cs + ' to register', async () => {
                const r = await hub.live(cs);
                return r && r.alive ? r : null;
            }, 60000);
            started[k] = { cs, wt, uid: row.uid, purpose };
        }

        // A is mid-edit: uncommitted work the human never saw.
        writeFileSync(join(started.A.wt, 'in-flight.txt'), 'the work nobody described\n');

        // C's tree has to be GONE before the hub goes to look. Its host has to die first: on Windows a
        // live process cwd'd into a directory makes it undeletable (measured -- rmSync threw EPERM), and
        // that constraint is why the real-world version of this case is always a dead worker whose tree
        // was collected afterwards rather than a tree that vanished under a running one.
        const host = JSON.parse(readFileSync(hub.pidfile(started.C.cs), 'utf8'));
        treeKill(host.hostPid, 'worker host for C');
        await hub.waitFor('C\'s worktree to be removable once its host is gone', () => {
            try { rmSync(started.C.wt, { recursive: true, force: true }); } catch { return false; }
            return !existsSync(started.C.wt);
        }, 30000);

        // Retire one at a time and read each record BEFORE the next retire lands. The rig's stub worker
        // registers with its OWN fixed purpose, so all three sessions share one handoffKey(cwd, purpose)
        // and the durable slot is overwritten on every retire -- read them all at the end and only the
        // last one exists. (Not a defect in the key: three real jobs carry three purposes.)
        const recs = {};
        for (const k of ['A', 'B', 'C']) {
            const bye = await hub.post('/retire', {
                uid: started[k].uid, summary: 'Worker relaunched from console (hub untouched).', successor: false,
            });
            assert.ok(bye && bye.ok, 'retire refused for ' + k + ': ' + JSON.stringify(bye));
            recs[k] = await hub.get('/handoff?cs=' + started[k].cs);
            assert.ok(recs[k] && !recs[k].none, 'no handoff record filed for ' + k + ': ' + JSON.stringify(recs[k]));
        }
        const [a, b, c] = [recs.A, recs.B, recs.C];

        // A: the WIP commit is named, and so is the branch it is sitting on.
        assert.match(a.auto, new RegExp('committed to jarvis/' + started.A.cs + ' as a WIP commit'),
            'the WIP commit is invisible to the successor again: ' + JSON.stringify(a.auto));
        assert.match(a.auto, new RegExp('^branch: jarvis/' + started.A.cs, 'm'));
        assert.match(a.auto, new RegExp('FIRST MOVE: git log --oneline main\\.\\.jarvis/' + started.A.cs));

        // B: clean, and it SAYS clean. Silence here would send a successor hunting a branch with
        // nothing on it, which is the same wasted turn in the other direction.
        assert.match(b.auto, /in-flight work: none -- its worktree was clean at retire/);

        // C: nobody looked, and it says exactly that.
        assert.match(c.auto, /in-flight work: UNKNOWN -- its worktree was already gone/);
        assert.ok(!/in-flight work: none/.test(c.auto),
            'a tree nobody could look at was reported as having no in-flight work: ' + JSON.stringify(c.auto));

        // None of the three wrote notes, which is the condition that made all of this necessary.
        for (const k of ['A', 'B', 'C']) {
            assert.equal(recs[k].notes, '', k + ' has notes it never wrote');
        }
    });
