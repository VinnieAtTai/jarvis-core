// Unit tests for parseBodyLenient — the JSON request-body parser behind readBody in jarvis-core.mjs.
// It backs EVERY POST endpoint, and its lenient repair pass is what saves a worker that pastes a
// Windows cwd into `curl -d` with un-escaped backslashes (the register-escape bug: a body like
// {"cwd":"d:\claude\jarvis-core"} is invalid JSON — \c/\j are not valid escapes — so a strict
// JSON.parse throws, readBody swallowed it to {}, and /register surfaced the misleading "purpose and
// cwd are required" even though both were sent. Nearly every fresh Windows worker hit it on boot.).
// Run with `npm test` (node --test) — no server boot, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBodyLenient } from '../jarvis-text.mjs';

test('parseBodyLenient — valid JSON parses on the first try, untouched', () => {
    assert.deepEqual(parseBodyLenient('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
});

test('parseBodyLenient — the register-escape bug: un-escaped Windows backslashes are repaired', () => {
    // In this JS source '\\' is ONE backslash, so `raw` holds single backslashes -> invalid JSON,
    // i.e. exactly the bytes a naive worker's `curl -d '{"cwd":"d:\claude\jarvis-core"}'` sends.
    const raw = '{"cwd":"d:\\claude\\jarvis-core","purpose":"JARVIS punchlist","pin":"hotel"}';
    const out = parseBodyLenient(raw);
    assert.equal(out.cwd, 'd:\\claude\\jarvis-core');   // path round-trips intact (JS literal = d:\claude\jarvis-core)
    assert.equal(out.purpose, 'JARVIS punchlist');
    assert.equal(out.pin, 'hotel');
});

test('parseBodyLenient — repairs \\U (C:\\Users) and lowercase \\u not followed by 4 hex', () => {
    assert.equal(parseBodyLenient('{"cwd":"C:\\Users\\vinni"}').cwd, 'C:\\Users\\vinni');
    assert.equal(parseBodyLenient('{"cwd":"c:\\users\\bob"}').cwd, 'c:\\users\\bob');
});

test('parseBodyLenient — a genuine \\uXXXX escape is preserved (valid body, never touches repair)', () => {
    // '\\u00e9' in JS source is the two-char sequence backslash-u-00e9 -> valid JSON unicode escape.
    assert.equal(parseBodyLenient('{"e":"\\u00e9"}').e, 'é');   // decodes to é, not doubled
});

test('parseBodyLenient — once repair triggers, b/f/n/r/t path segments recover as literal', () => {
    // \c makes the body invalid -> repair runs -> the sibling \b and \t (which alone look like valid
    // escapes) are doubled too, so common path prefixes (bin, temp) survive instead of becoming
    // control chars. This is the register-escape case for a deeper path.
    assert.equal(parseBodyLenient('{"cwd":"d:\\claude\\bin\\temp"}').cwd, 'd:\\claude\\bin\\temp');
});

test('parseBodyLenient — KNOWN LIMIT: a path that is coincidentally valid JSON cannot be recovered', () => {
    // c:\bin\node -> \b (backspace) + \n (newline) are BOTH valid escapes, so the strict parse
    // SUCCEEDS on the wrong value and repair never runs. Server-side repair can only fix bodies that
    // actually fail to parse; this case needs the client to send a forward-slash cwd. Documented, not
    // a regression — asserting the boundary so a future change to the heuristic is a deliberate one.
    assert.notEqual(parseBodyLenient('{"cwd":"c:\\bin\\node"}').cwd, 'c:\\bin\\node');
});

test('parseBodyLenient — during repair, structural escapes (\\\\, \\") are preserved as units', () => {
    // Body fails first parse on the lone \c, but the already-escaped pair and quote must survive.
    // JS source: '{"a":"x\\\\y","q":"say \\"hi\\"","cwd":"d:\\code"}' holds  x\\y , say "hi" , d:\code
    const out = parseBodyLenient('{"a":"x\\\\y","q":"say \\"hi\\"","cwd":"d:\\code"}');
    assert.equal(out.a, 'x\\y');       // escaped-backslash pair -> single backslash, intact
    assert.equal(out.q, 'say "hi"');   // escaped quotes intact (not corrupted by doubling)
    assert.equal(out.cwd, 'd:\\code'); // lone backslash repaired
});

test('parseBodyLenient — empty / whitespace / un-repairable bodies fall back to {}', () => {
    assert.deepEqual(parseBodyLenient(''), {});
    assert.deepEqual(parseBodyLenient(undefined), {});
    assert.deepEqual(parseBodyLenient('{not json at all'), {});
    assert.deepEqual(parseBodyLenient('garbage'), {});
});
