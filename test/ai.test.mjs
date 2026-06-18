// Unit tests for the pure conversational-tab (/ai) helpers in jarvis-text.mjs (aiCost,
// monthKey, rollSpend, capExceeded, AI_MODELS, AI_DEFAULT_MODEL). Run with `npm test`
// (node --test). No server boot, no I/O, no Anthropic call — the API fetch stays in
// jarvis-core; only the deterministic cost math / rollover / cap predicate are tested here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiCost, monthKey, rollSpend, capExceeded, AI_MODELS, AI_DEFAULT_MODEL } from '../jarvis-text.mjs';

test('AI_MODELS — the three allowed models with documented rates', () => {
    assert.deepEqual(Object.keys(AI_MODELS).sort(), ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6']);
    assert.equal(AI_DEFAULT_MODEL, 'claude-sonnet-4-6');
    // rates are USD per token (per-Mtok / 1e6)
    assert.equal(AI_MODELS['claude-haiku-4-5'].in, 1 / 1e6);
    assert.equal(AI_MODELS['claude-haiku-4-5'].out, 5 / 1e6);
    assert.equal(AI_MODELS['claude-sonnet-4-6'].in, 3 / 1e6);
    assert.equal(AI_MODELS['claude-sonnet-4-6'].out, 15 / 1e6);
    assert.equal(AI_MODELS['claude-opus-4-8'].in, 5 / 1e6);
    assert.equal(AI_MODELS['claude-opus-4-8'].out, 25 / 1e6);
});

test('aiCost — Haiku: $1 in / $5 out per Mtok', () => {
    // 1,000,000 input + 1,000,000 output = $1 + $5 = $6
    assert.equal(aiCost('claude-haiku-4-5', 1e6, 1e6), 6);
    // a small concrete call: 1000 in, 200 out = 0.001 + 0.001 = 0.002
    assert.equal(aiCost('claude-haiku-4-5', 1000, 200), 0.001 + 0.001);
});

test('aiCost — Sonnet: $3 in / $15 out per Mtok', () => {
    assert.equal(aiCost('claude-sonnet-4-6', 1e6, 1e6), 18);
    // 2000 in, 500 out = 0.006 + 0.0075 = 0.0135
    assert.equal(aiCost('claude-sonnet-4-6', 2000, 500), 2000 * 3 / 1e6 + 500 * 15 / 1e6);
});

test('aiCost — Opus: $5 in / $25 out per Mtok', () => {
    assert.equal(aiCost('claude-opus-4-8', 1e6, 1e6), 30);
    assert.equal(aiCost('claude-opus-4-8', 4000, 800), 4000 * 5 / 1e6 + 800 * 25 / 1e6);
});

test('aiCost — unknown model throws (never silently $0)', () => {
    assert.throws(() => aiCost('gpt-4', 100, 100), /unknown model/);
    assert.throws(() => aiCost('', 100, 100), /unknown model/);
    assert.throws(() => aiCost(undefined, 100, 100), /unknown model/);
});

test('aiCost — missing/negative token counts clamp to 0', () => {
    assert.equal(aiCost('claude-sonnet-4-6', 0, 0), 0);
    assert.equal(aiCost('claude-sonnet-4-6', undefined, undefined), 0);
    assert.equal(aiCost('claude-sonnet-4-6', -100, -100), 0);
    // only output reported
    assert.equal(aiCost('claude-sonnet-4-6', null, 100), 100 * 15 / 1e6);
});

test('monthKey — YYYY-MM, zero-padded month', () => {
    assert.equal(monthKey(new Date('2026-06-18T12:00:00Z')), '2026-06');
    assert.equal(monthKey(new Date('2026-01-01T00:00:00')), '2026-01');
    assert.equal(monthKey(new Date('2026-12-31T23:00:00')), '2026-12');
});

test('rollSpend — same month keeps the running usd', () => {
    const out = rollSpend({ month: '2026-06', usd: 4.25 }, '2026-06');
    assert.deepEqual(out, { month: '2026-06', usd: 4.25 });
});

test('rollSpend — month change resets usd to 0', () => {
    const out = rollSpend({ month: '2026-05', usd: 19.99 }, '2026-06');
    assert.deepEqual(out, { month: '2026-06', usd: 0 });
});

test('rollSpend — missing/invalid spend initializes for the current month', () => {
    assert.deepEqual(rollSpend(null, '2026-06'), { month: '2026-06', usd: 0 });
    assert.deepEqual(rollSpend(undefined, '2026-06'), { month: '2026-06', usd: 0 });
    assert.deepEqual(rollSpend({}, '2026-06'), { month: '2026-06', usd: 0 });
    // garbage usd in the right month coerces to 0
    assert.deepEqual(rollSpend({ month: '2026-06', usd: 'oops' }, '2026-06'), { month: '2026-06', usd: 0 });
});

test('rollSpend — does not mutate the input', () => {
    const input = { month: '2026-05', usd: 5 };
    const snap = JSON.parse(JSON.stringify(input));
    rollSpend(input, '2026-06');
    assert.deepEqual(input, snap, 'source spend object is left untouched');
});

test('capExceeded — boundary: at-or-over the cap is over, under is not', () => {
    assert.equal(capExceeded(19.99, 20), false);
    assert.equal(capExceeded(20, 20), true, 'exactly at the cap is over');
    assert.equal(capExceeded(20.01, 20), true);
    assert.equal(capExceeded(0, 20), false);
});

test('capExceeded — non-positive/invalid cap means no cap', () => {
    assert.equal(capExceeded(100, 0), false);
    assert.equal(capExceeded(100, -5), false);
    assert.equal(capExceeded(100, NaN), false);
});

test('capExceeded — non-finite spend reads as 0', () => {
    assert.equal(capExceeded(undefined, 20), false);
    assert.equal(capExceeded(null, 20), false);
    assert.equal(capExceeded('oops', 20), false);
});
