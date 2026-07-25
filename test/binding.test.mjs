// Unit tests for resolveBinding in jarvis-text.mjs -- deciding whether a registering session
// coordinates a project, nests under one as a sub-worker, or stands alone.
//
// The bug it fixes: the hub asks a spawned worker to echo `project`/`parentProject` back on
// /register, and workers drop the field. A dropped field used to mean an orphan standalone card
// instead of nesting under the project -- the recurring board fragmentation. The spawner now
// stashes what it intended (`bind`), so nesting no longer depends on the worker obeying.
// Run with `npm test` (node --test) -- no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBinding } from '../jarvis-text.mjs';

test('resolveBinding -- nothing anywhere is a standalone card', () => {
    assert.deepEqual(resolveBinding(null, null, null), { project: null, parentProject: null });
    assert.deepEqual(resolveBinding(undefined, undefined, undefined), { project: null, parentProject: null });
});

test('resolveBinding -- the worker echoing its fields is honoured', () => {
    assert.deepEqual(resolveBinding('jarvis', null, null), { project: 'jarvis', parentProject: null });
    assert.deepEqual(resolveBinding(null, 'primeng', null), { project: null, parentProject: 'primeng' });
});

test('resolveBinding -- THE FIX: a worker that forgets still nests, from the spawn stash', () => {
    assert.deepEqual(resolveBinding(null, null, { project: 'jarvis' }), { project: 'jarvis', parentProject: null });
    assert.deepEqual(resolveBinding(null, null, { parentProject: 'primeng' }), { project: null, parentProject: 'primeng' });
});

test('resolveBinding -- an explicit field from the worker beats the stash', () => {
    // It may have been re-tasked since it was spawned, so its own claim wins.
    assert.deepEqual(resolveBinding('tms', null, { project: 'jarvis' }), { project: 'tms', parentProject: null });
    assert.deepEqual(resolveBinding(null, 'tms', { parentProject: 'primeng' }), { project: null, parentProject: 'tms' });
});

test('resolveBinding -- project always beats parentProject; a session is one role, never both', () => {
    assert.deepEqual(resolveBinding('jarvis', 'primeng', null), { project: 'jarvis', parentProject: null });
    assert.deepEqual(resolveBinding('jarvis', null, { parentProject: 'primeng' }), { project: 'jarvis', parentProject: null });
    assert.deepEqual(resolveBinding(null, 'primeng', { project: 'jarvis' }), { project: 'jarvis', parentProject: null });
});

test('resolveBinding -- values are lowercased and trimmed from either source', () => {
    assert.deepEqual(resolveBinding('  JARVIS  ', null, null), { project: 'jarvis', parentProject: null });
    assert.deepEqual(resolveBinding(null, ' PrimeNG ', null), { project: null, parentProject: 'primeng' });
    assert.deepEqual(resolveBinding(null, null, { project: ' Jarvis ' }), { project: 'jarvis', parentProject: null });
});

test('resolveBinding -- blank and whitespace-only fields fall through to the stash', () => {
    // '' and '   ' are "the worker sent nothing useful", not "the worker meant standalone".
    assert.deepEqual(resolveBinding('', null, { project: 'jarvis' }), { project: 'jarvis', parentProject: null });
    assert.deepEqual(resolveBinding('   ', null, { project: 'jarvis' }), { project: 'jarvis', parentProject: null });
    assert.deepEqual(resolveBinding(null, '  ', { parentProject: 'primeng' }), { project: null, parentProject: 'primeng' });
});

test('resolveBinding -- an empty or malformed stash is harmless', () => {
    assert.deepEqual(resolveBinding(null, null, {}), { project: null, parentProject: null });
    assert.deepEqual(resolveBinding('jarvis', null, {}), { project: 'jarvis', parentProject: null });
    assert.deepEqual(resolveBinding(null, null, { project: null, parentProject: null }), { project: null, parentProject: null });
});

test('resolveBinding -- never returns both roles at once, whatever the inputs', () => {
    const vals = [null, '', 'jarvis', 'primeng'];
    for (const p of vals) for (const pp of vals) for (const bp of vals) for (const bpp of vals) {
        const r = resolveBinding(p, pp, { project: bp, parentProject: bpp });
        assert.ok(!(r.project && r.parentProject), 'both roles set for ' + JSON.stringify([p, pp, bp, bpp]));
    }
});
