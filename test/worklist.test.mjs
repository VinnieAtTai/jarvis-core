// Unit tests for the pure worklist-shape helpers in jarvis-text.mjs (migrateWork, textOf,
// WORK_VERSION). Run with `npm test` (node --test). No server boot, no I/O — migrateWork is
// injected with stub makeTask/newTaskId so the migration logic is exercised in isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WORK_VERSION, textOf, migrateWork } from '../jarvis-text.mjs';

// Deterministic stubs standing in for jarvis-core's id/time generators.
let _idc = 0;
const newTaskId = () => 't_test_' + (++_idc);
const makeTask = (text) => ({ id: newTaskId(), text: String(text == null ? '' : text), addedAt: 'STAMP' });
const migrate = (w) => migrateWork(w, makeTask, newTaskId);

test('textOf — string, object, and nullish tasks', () => {
    assert.equal(textOf('hello'), 'hello');
    assert.equal(textOf({ text: 'hi' }), 'hi');
    assert.equal(textOf({ text: null }), '');
    assert.equal(textOf(null), '');
    assert.equal(textOf(undefined), '');
});

test('migrateWork — null/undefined yields a fresh v3 default', () => {
    for (const input of [null, undefined, {}, { sessions: 'nope' }]) {
        const { w, changed } = migrate(input);
        assert.equal(changed, true, 'a missing/invalid worklist is a change');
        assert.equal(w.version, WORK_VERSION);
        assert.equal(w.focus, 'jarvis');
        assert.deepEqual(w.sessions.jarvis.working, []);
        assert.deepEqual(w.sessions.jarvis.queued, []);
        assert.deepEqual(w.sessions.jarvis.done, []);
    }
});

test('migrateWork — v1 flat board is wrapped into sessions.jarvis', () => {
    const { w, changed } = migrate({ working: ['build the thing'], queued: [], done: ['old'] });
    assert.equal(changed, true);
    assert.equal(w.version, WORK_VERSION);
    assert.equal(w.focus, 'jarvis');
    const b = w.sessions.jarvis;
    // string tasks are upgraded to task objects
    assert.equal(b.working.length, 1);
    assert.equal(b.working[0].text, 'build the thing');
    assert.ok(b.working[0].id, 'gets an id');
    assert.equal(b.done[0].text, 'old');
    assert.ok(Array.isArray(b.review), 'review lane backfilled');
});

test('migrateWork — v2 string tasks become v3 objects', () => {
    const { w, changed } = migrate({ version: 2, focus: 'jarvis', sessions: { jarvis: { working: ['a', 'b'], queued: [], done: [], review: [] } } });
    assert.equal(changed, true);
    const b = w.sessions.jarvis;
    assert.equal(b.working.length, 2);
    for (const t of b.working) {
        assert.equal(typeof t, 'object');
        assert.ok(t.id);
        assert.equal(typeof t.text, 'string');
        assert.equal(t.addedAt, 'STAMP');
    }
    assert.equal(b.working[0].text, 'a');
    assert.equal(b.working[1].text, 'b');
    assert.equal(w.version, WORK_VERSION);
});

test('migrateWork — existing task ids are preserved (stable across reloads)', () => {
    const keep = { id: 't_keep_me', text: 'persist', addedAt: '2026-01-01T00:00:00.000Z' };
    const { w } = migrate({ version: WORK_VERSION, focus: 'jarvis', sessions: { jarvis: { working: [keep], queued: [], done: [], review: [] } } });
    assert.equal(w.sessions.jarvis.working[0].id, 't_keep_me');
    assert.equal(w.sessions.jarvis.working[0].text, 'persist');
});

test('migrateWork — a fully-current v3 worklist is unchanged (idempotent)', () => {
    const current = {
        version: WORK_VERSION, focus: 'jarvis',
        sessions: { jarvis: { working: [{ id: 't1', text: 'x', addedAt: 'STAMP' }], queued: [], done: [], review: [] } },
    };
    const { w, changed } = migrate(current);
    assert.equal(changed, false, 'no upgrade needed');
    // running again is also a no-op and structurally identical
    const again = migrate(w);
    assert.equal(again.changed, false);
    assert.deepEqual(again.w, w);
});

test('migrateWork — backfills missing fields and bad lanes', () => {
    const { w, changed } = migrate({
        version: WORK_VERSION, focus: 'jarvis',
        sessions: {
            jarvis: { working: [{ text: 'no-id-no-stamp' }], queued: 'not-an-array', done: [], review: [] },
            broken: 'this is not a board',
        },
    });
    assert.equal(changed, true);
    const j = w.sessions.jarvis;
    assert.ok(j.working[0].id, 'missing id backfilled');
    assert.ok(j.working[0].addedAt, 'missing addedAt backfilled');
    assert.deepEqual(j.queued, [], 'non-array lane reset to []');
    // a non-object session board is replaced with empty lanes
    assert.deepEqual(w.sessions.broken, { working: [], queued: [], done: [], review: [] });
});

test('migrateWork — backfills a missing focus', () => {
    const { w, changed } = migrate({ version: WORK_VERSION, sessions: { jarvis: { working: [], queued: [], done: [], review: [] } } });
    assert.equal(changed, true);
    assert.equal(w.focus, 'jarvis');
});
