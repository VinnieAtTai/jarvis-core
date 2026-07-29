// Unit tests for the local SQLite reporting store (db.mjs). Run with `npm test` (node --test).
// Everything uses an in-memory database (':memory:'), so no file, no live data dir, and no hub boot
// is touched. The backfill is exercised against small INLINE fixtures written to a scratch dir under
// the OS temp folder — never JARVIS_DATA — so the live hub's files are never read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    init, upsertSession, upsertTask, getSession, listSessions, listTasks, recentWork, taskCounts,
    tagOf, sessionsFromTranscript, taskTimesFromTranscript, taskTimeKey, tasksFromWorklist, backfill,
} from '../db.mjs';

test('tagOf — extracts a leading category tag, else null', () => {
    assert.equal(tagOf('BUG: copy button denied'), 'BUG');
    assert.equal(tagOf('FEATURE: db.mjs store'), 'FEATURE');
    assert.equal(tagOf('  ROBUST: trimmed then matched'), 'ROBUST');
    assert.equal(tagOf('no tag here'), null);
    assert.equal(tagOf('lowercase: not a tag'), null);
    assert.equal(tagOf(''), null);
    assert.equal(tagOf(null), null);
});

test('init — creates both tables and they start empty', () => {
    const db = init(':memory:');
    assert.deepEqual(listSessions(db), []);
    assert.deepEqual(listTasks(db), []);
    assert.deepEqual(taskCounts(db), {});
    db.close();
});

test('upsertSession + getSession — insert then read back', () => {
    const db = init(':memory:');
    upsertSession(db, {
        uid: 's_1', callsign: 'juliet', cwd: 'd:/x', purpose: 'reporting store',
        parentProject: 'jarvis', registeredAt: '2026-07-21T00:00:00.000Z', summary: 'shipped db.mjs',
    });
    const s = getSession(db, 's_1');
    assert.equal(s.callsign, 'juliet');
    assert.equal(s.parentProject, 'jarvis');
    assert.equal(s.summary, 'shipped db.mjs');
    assert.equal(s.cwd, 'd:/x');
    assert.equal(s.retiredAt, null, 'unset field is null, not ""');
    assert.equal(getSession(db, 'nope'), null);
    db.close();
});

test('upsertSession — COALESCE never clobbers a value with null; new value wins', () => {
    const db = init(':memory:');
    upsertSession(db, { uid: 's_1', callsign: 'juliet', summary: 'first pass' });
    // A second source knows only the retire time — must NOT wipe callsign/summary.
    upsertSession(db, { uid: 's_1', retiredAt: '2026-07-21T02:00:00.000Z' });
    let s = getSession(db, 's_1');
    assert.equal(s.callsign, 'juliet', 'callsign survived a null-bearing upsert');
    assert.equal(s.summary, 'first pass');
    assert.equal(s.retiredAt, '2026-07-21T02:00:00.000Z');
    // A real new value DOES win.
    upsertSession(db, { uid: 's_1', summary: 'final summary' });
    s = getSession(db, 's_1');
    assert.equal(s.summary, 'final summary');
    // Idempotent: only ever one row for the uid.
    assert.equal(listSessions(db).length, 1);
    db.close();
});

test('upsertTask — derives tag from text when not supplied', () => {
    const db = init(':memory:');
    upsertTask(db, { id: 't_1', callsign: 'juliet', text: 'FEATURE: backfill', lane: 'working', addedAt: 'A' });
    const [t] = listTasks(db, { callsign: 'juliet' });
    assert.equal(t.tag, 'FEATURE');
    assert.equal(t.lane, 'working');
    // startedAt/doneAt can be filled by a later source without disturbing the rest.
    upsertTask(db, { id: 't_1', doneAt: 'Z' });
    const [t2] = listTasks(db);
    assert.equal(t2.doneAt, 'Z');
    assert.equal(t2.text, 'FEATURE: backfill', 'text preserved through the enrichment upsert');
    assert.equal(t2.tag, 'FEATURE');
    db.close();
});

test('listSessions / listTasks — filters', () => {
    const db = init(':memory:');
    upsertSession(db, { uid: 's_1', callsign: 'juliet', parentProject: 'jarvis', registeredAt: '2026-07-21T03:00:00Z' });
    upsertSession(db, { uid: 's_2', callsign: 'kilo', project: 'jarvis', registeredAt: '2026-07-21T04:00:00Z' });
    upsertSession(db, { uid: 's_3', callsign: 'mike', registeredAt: '2026-07-21T05:00:00Z', retiredAt: null });
    assert.equal(listSessions(db, { parentProject: 'jarvis' }).length, 1);
    assert.equal(listSessions(db, { project: 'jarvis' }).length, 1);
    assert.equal(listSessions(db, { activeOnly: true }).length, 3, 'none retired yet');
    // newest-registered sorts first
    assert.equal(listSessions(db)[0].uid, 's_3');

    upsertTask(db, { id: 't_1', callsign: 'juliet', text: 'a', lane: 'done', addedAt: '1' });
    upsertTask(db, { id: 't_2', callsign: 'juliet', text: 'b', lane: 'working', addedAt: '2' });
    upsertTask(db, { id: 't_3', callsign: 'kilo', text: 'c', lane: 'done', addedAt: '3' });
    assert.equal(listTasks(db, { callsign: 'juliet' }).length, 2);
    assert.equal(listTasks(db, { lane: 'done' }).length, 2);
    assert.equal(listTasks(db, { callsign: 'juliet', lane: 'done' }).length, 1);
    assert.deepEqual(taskCounts(db), { done: 2, working: 1 });
    db.close();
});

test('recentWork — joins sessions to their done tasks and skips empty sessions', () => {
    const db = init(':memory:');
    upsertSession(db, { uid: 's_1', callsign: 'juliet', parentProject: 'jarvis', registeredAt: '2026-07-21T01:00:00Z', retiredAt: '2026-07-21T02:00:00Z', summary: 'built the store' });
    upsertSession(db, { uid: 's_2', callsign: 'kilo', registeredAt: '2026-07-21T03:00:00Z' }); // no summary, no done tasks -> omitted
    upsertTask(db, { id: 't_1', callsign: 'juliet', text: 'x', lane: 'done', addedAt: '1' });
    upsertTask(db, { id: 't_2', callsign: 'juliet', text: 'y', lane: 'done', addedAt: '2' });
    upsertTask(db, { id: 't_3', callsign: 'juliet', text: 'z', lane: 'working', addedAt: '3' });
    const rows = recentWork(db, 10);
    assert.equal(rows.length, 1, 'the summary-less, task-less session is omitted');
    assert.equal(rows[0].callsign, 'juliet');
    assert.equal(rows[0].summary, 'built the store');
    assert.equal(rows[0].doneCount, 2, 'counts only the two done tasks, not the working one');
    db.close();
});

// ---- transcript / worklist parsers (pure, no db) -------------------------------------------

test('sessionsFromTranscript — parses register/retire sys lines + tts summary', () => {
    const events = [
        { kind: 'sys', text: 'registered s_0003 as bravo: token optimization of the hub', ts: 'T1' },
        { kind: 'sys', text: 'registered s_0009 as jarvis worker (india): phase B QA', ts: 'T2' },
        { kind: 'sys', text: 'bravo retired (s_0003) -> successor charlie; board transferred (3/3 tasks)', ts: 'T3' },
        { kind: 'tts', text: 'bravo retired. Token audit started, poll loop landed.', from: 'jarvis', ts: 'T3b' },
        { kind: 'sys', text: 'india (jarvis worker) retired (s_0009)', ts: 'T4' },
        { kind: 'tts', text: 'india retired. Shipped the QA sweep.', from: 'jarvis', ts: 'T4b' },
    ];
    const m = sessionsFromTranscript(events);
    assert.equal(m.s_0003.callsign, 'bravo');
    assert.equal(m.s_0003.purpose, 'token optimization of the hub');
    assert.equal(m.s_0003.registeredAt, 'T1');
    assert.equal(m.s_0003.retiredAt, 'T3');
    assert.equal(m.s_0003.summary, 'Token audit started, poll loop landed.');
    assert.equal(m.s_0009.project, 'jarvis', 'coordinator register line records project');
    assert.equal(m.s_0009.callsign, 'india');
    assert.equal(m.s_0009.retiredAt, 'T4');
    assert.equal(m.s_0009.summary, 'Shipped the QA sweep.');
});

test('taskTimesFromTranscript — earliest start, latest done, keyed by board+text', () => {
    const events = [
        { kind: 'task', op: 'add', board: 'juliet', task: 'build db', ts: '1' },
        { kind: 'task', op: 'start', board: 'juliet', task: 'build db', ts: '2' },
        { kind: 'task', op: 'start', board: 'juliet', task: 'build db', ts: '2b' }, // later start ignored
        { kind: 'task', op: 'done', board: 'juliet', task: 'build db', ts: '5' },
        { kind: 'chat', text: 'noise' },
    ];
    const map = taskTimesFromTranscript(events);
    const t = map.get(taskTimeKey('juliet', 'build db'));
    assert.equal(t.startedAt, '2');
    assert.equal(t.doneAt, '5');
});

test('taskTimesFromTranscript — THE MOVED CARD: a move carries its history to the board it lands on', () => {
    // The hole this closes: the times are keyed (board, text) but the rows they enrich come from
    // worklist.json, which knows only where a card is NOW. Started on alpha, moved to bravo, finished
    // there -- pre-fix the lookup for bravo found the done time and no start time at all, so the
    // backfill reported a finished card that was never begun.
    const events = [
        { kind: 'task', op: 'add', board: 'alpha', task: 'ship it', ts: '1' },
        { kind: 'task', op: 'start', board: 'alpha', task: 'ship it', ts: '2' },
        { kind: 'task', op: 'move', board: 'bravo', from: 'alpha', task: 'ship it', ts: '3' },
        { kind: 'task', op: 'done', board: 'bravo', task: 'ship it', ts: '4' },
    ];
    const map = taskTimesFromTranscript(events);
    assert.deepEqual(map.get(taskTimeKey('bravo', 'ship it')), { startedAt: '2', doneAt: '4' });
    // And the board it LEFT stops answering for it, or a card that moved away still dates work on a
    // board that no longer holds it.
    assert.equal(map.get(taskTimeKey('alpha', 'ship it')), undefined);
});

test('taskTimesFromTranscript — history survives more than one hop, in any arrival order', () => {
    const events = [
        { kind: 'task', op: 'start', board: 'alpha', task: 'ship it', ts: '2' },
        { kind: 'task', op: 'move', board: 'bravo', from: 'alpha', task: 'ship it', ts: '3' },
        { kind: 'task', op: 'move', board: 'delta', from: 'bravo', task: 'ship it', ts: '4' },
        { kind: 'task', op: 'done', board: 'delta', task: 'ship it', ts: '5' },
    ];
    assert.deepEqual(taskTimesFromTranscript(events).get(taskTimeKey('delta', 'ship it')), { startedAt: '2', doneAt: '5' });
    // Order-independent: the replay reads chronologically, so a caller's hand-built array does not
    // have to be pre-sorted for the chain to hold. (The live transcript is append-only anyway.)
    const shuffled = [events[3], events[1], events[0], events[2]];
    assert.deepEqual(taskTimesFromTranscript(shuffled).get(taskTimeKey('delta', 'ship it')), { startedAt: '2', doneAt: '5' });
});

test('taskTimesFromTranscript — a move with no `from` leaves the times where they were', () => {
    // Lines written before 7b34183 carry no source board. The fallback is the OLD behaviour on
    // purpose: a stranded start time is recoverable, an invented source board is not.
    const events = [
        { kind: 'task', op: 'start', board: 'alpha', task: 'ship it', ts: '2' },
        { kind: 'task', op: 'move', board: 'bravo', task: 'ship it', ts: '3' },
        { kind: 'task', op: 'done', board: 'bravo', task: 'ship it', ts: '4' },
    ];
    const map = taskTimesFromTranscript(events);
    assert.deepEqual(map.get(taskTimeKey('alpha', 'ship it')), { startedAt: '2' });
    assert.deepEqual(map.get(taskTimeKey('bravo', 'ship it')), { doneAt: '4' });
});

test('taskTimesFromTranscript — moving onto a board that already has that text merges, never overwrites', () => {
    // Two boards really do carry cards with identical text. Once one lands on the other they are no
    // more separable than two same-text cards on one board always were, so the merge keeps the
    // earliest start and the latest done rather than dropping either side.
    const events = [
        { kind: 'task', op: 'start', board: 'bravo', task: 'ship it', ts: '1' },
        { kind: 'task', op: 'done', board: 'bravo', task: 'ship it', ts: '2' },
        { kind: 'task', op: 'start', board: 'alpha', task: 'ship it', ts: '3' },
        { kind: 'task', op: 'done', board: 'alpha', task: 'ship it', ts: '4' },
        { kind: 'task', op: 'move', board: 'bravo', from: 'alpha', task: 'ship it', ts: '5' },
    ];
    assert.deepEqual(taskTimesFromTranscript(events).get(taskTimeKey('bravo', 'ship it')), { startedAt: '1', doneAt: '4' });
});

test('tasksFromWorklist — flattens v3 board into lane-tagged rows; synthesizes id when missing', () => {
    const wl = {
        version: 3, focus: 'jarvis',
        sessions: {
            juliet: {
                working: [{ id: 't_a', text: 'FEATURE: db.mjs', addedAt: 'A' }],
                queued: [{ id: 't_b', text: 'write tests', addedAt: 'B' }],
                done: ['bare string task'], // pre-v3 shape -> synthetic id
                review: [],
            },
            broken: 'not a board',
        },
    };
    const rows = tasksFromWorklist(wl);
    assert.equal(rows.length, 3);
    const working = rows.find(r => r.lane === 'working');
    assert.equal(working.id, 't_a');
    assert.equal(working.tag, 'FEATURE');
    assert.equal(working.callsign, 'juliet');
    const bare = rows.find(r => r.text === 'bare string task');
    assert.ok(bare.id.startsWith('wl_juliet_'), 'a task with no id gets a deterministic synthetic one');
    // deterministic: re-flattening yields the same synthetic id
    assert.equal(tasksFromWorklist(wl).find(r => r.text === 'bare string task').id, bare.id);
});

// ---- end-to-end backfill against inline fixtures -------------------------------------------

test('backfill — parses a small fixture data dir and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvisdb-'));
    try {
        writeFileSync(join(dir, 'transcript.jsonl'), [
            JSON.stringify({ kind: 'sys', text: 'registered s_0003 as bravo: token work', ts: '2026-07-21T01:00:00Z' }),
            // the transcript task log stores the SAME text the worklist does (tag included)
            JSON.stringify({ kind: 'task', op: 'start', board: 'bravo', task: 'WORK: audit tokens', ts: '2026-07-21T01:05:00Z' }),
            JSON.stringify({ kind: 'task', op: 'done', board: 'bravo', task: 'WORK: audit tokens', ts: '2026-07-21T01:30:00Z' }),
            JSON.stringify({ kind: 'sys', text: 'bravo retired (s_0003)', ts: '2026-07-21T02:00:00Z' }),
            JSON.stringify({ kind: 'tts', text: 'bravo retired. Token audit done.', from: 'jarvis', ts: '2026-07-21T02:00:01Z' }),
            'this is a torn half-written line {', // must be skipped, not fatal
        ].join('\n') + '\n');
        writeFileSync(join(dir, 'bus.jsonl'),
            JSON.stringify({ from: 'jarvis', to: 's_0003', kind: 'retired', text: 'retired', ts: '2026-07-21T02:00:00Z' }) + '\n');
        writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
            sessions: {
                s_0003: { callsign: 'bravo', cwd: 'd:/claude/jarvis-core', purpose: 'token work', started: '2026-07-21T01:00:00Z', ended: '2026-07-21T02:00:00Z', summary: 'Token audit done; poll loop landed.' },
            },
        }));
        writeFileSync(join(dir, 'worklist.json'), JSON.stringify({
            version: 3, focus: 'jarvis',
            sessions: { bravo: { working: [], queued: [], review: [], done: [{ id: 't_x', text: 'WORK: audit tokens', addedAt: '2026-07-21T01:02:00Z' }] } },
        }));

        const db = init(':memory:');
        const counts = backfill(db, dir);
        assert.equal(counts.sessions, 1);
        assert.equal(counts.tasks, 1);

        const s = getSession(db, 's_0003');
        assert.equal(s.callsign, 'bravo');
        assert.equal(s.cwd, 'd:/claude/jarvis-core', 'cwd came from the roster (not in the logs)');
        assert.equal(s.summary, 'Token audit done; poll loop landed.', 'roster summary wins over the shorter tts one');
        assert.equal(s.registeredAt, '2026-07-21T01:00:00Z');
        assert.equal(s.retiredAt, '2026-07-21T02:00:00Z');

        const [t] = listTasks(db, { callsign: 'bravo' });
        assert.equal(t.id, 't_x');
        assert.equal(t.tag, 'WORK');
        assert.equal(t.lane, 'done');
        assert.equal(t.startedAt, '2026-07-21T01:05:00Z', 'startedAt enriched from the transcript task events');
        assert.equal(t.doneAt, '2026-07-21T01:30:00Z');

        const rw = recentWork(db);
        assert.equal(rw.length, 1);
        assert.equal(rw[0].summary, 'Token audit done; poll loop landed.');
        assert.equal(rw[0].doneCount, 1);

        // Idempotent: a second backfill changes nothing (same one session, one task).
        backfill(db, dir);
        assert.equal(listSessions(db).length, 1);
        assert.equal(listTasks(db).length, 1);
        db.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('backfill — a card that changed boards is dated on the board it now sits on', () => {
    // The pure test above proves the replay; this proves the JOIN, which is where the symptom showed.
    // worklist.json holds the card on bravo -- the only place it has ever been, as far as the board
    // knows -- while the whole first half of its life is logged against alpha.
    const dir = mkdtempSync(join(tmpdir(), 'jarvisdb-moved-'));
    try {
        writeFileSync(join(dir, 'transcript.jsonl'), [
            JSON.stringify({ kind: 'task', op: 'add', board: 'alpha', task: 'BUG: dated on the wrong board', ts: '2026-07-28T01:00:00Z' }),
            JSON.stringify({ kind: 'task', op: 'start', board: 'alpha', task: 'BUG: dated on the wrong board', ts: '2026-07-28T01:05:00Z' }),
            JSON.stringify({ kind: 'task', op: 'move', board: 'bravo', from: 'alpha', task: 'BUG: dated on the wrong board', ts: '2026-07-28T01:20:00Z' }),
            JSON.stringify({ kind: 'task', op: 'done', board: 'bravo', task: 'BUG: dated on the wrong board', ts: '2026-07-28T01:40:00Z' }),
        ].join('\n') + '\n');
        writeFileSync(join(dir, 'worklist.json'), JSON.stringify({
            version: 3, focus: 'jarvis',
            sessions: { bravo: { working: [], queued: [], review: [], done: [{ id: 't_moved', text: 'BUG: dated on the wrong board', addedAt: '2026-07-28T01:00:00Z' }] } },
        }));

        const db = init(':memory:');
        backfill(db, dir);
        const [t] = listTasks(db, { callsign: 'bravo' });
        assert.equal(t.doneAt, '2026-07-28T01:40:00Z', 'the done time was already reachable -- it happened after the move');
        assert.equal(t.startedAt, '2026-07-28T01:05:00Z',
            'a moved card came back with no start time at all: finished work that looks like it never began');
        db.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('backfill — missing files degrade to empty, never throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvisdb-empty-'));
    try {
        const db = init(':memory:');
        const counts = backfill(db, dir); // no files at all
        assert.deepEqual(counts, { sessions: 0, tasks: 0 });
        db.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
