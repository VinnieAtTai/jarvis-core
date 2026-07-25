// Unit tests for the chat markdown renderer in console.js -- the first tests over console code.
//
// console.js is browser script (top-level document.getElementById), so it cannot simply be
// imported. Instead we lift the handful of PURE renderer functions out of the source by name and
// evaluate just those. Brittle by nature, so the extractor fails loudly rather than silently
// testing nothing if a function is renamed.
//
// What it guards (punchlist #38, seen from kilo on PS-1995): a worker's message arriving as one
// undifferentiated blob with visible \n, and a stray ``` swallowing the rest of the message. The
// unclosed-fence case also has to keep the block loop ADVANCING -- an earlier shape of this fix
// matched neither a block nor a paragraph and hung the console on that message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../console.js', import.meta.url), 'utf8');

// Slice `function name(...) { ... }` out of the source by brace counting (the bodies contain
// braces inside strings/regexes only in balanced pairs, which holds for these five).
function lift(name) {
    const start = src.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, 'console.js no longer defines ' + name + ' -- update this test');
    let i = src.indexOf('{', start), depth = 0;
    for (let n = i; n < src.length; n++) {
        if (src[n] === '{') depth++;
        else if (src[n] === '}' && --depth === 0) return src.slice(start, n + 1);
    }
    throw new Error('unbalanced braces reading ' + name);
}

const NAMES = ['esc', 'linkify', 'b64', 'inlineMd', 'fixEscapedBreaks', 'richText'];
const richText = new Function(
    'btoa', 'encodeURIComponent', 'unescape',
    NAMES.map(lift).join('\n') + '\nreturn richText;'
)(s => Buffer.from(s, 'binary').toString('base64'), encodeURIComponent, unescape);

// —— literal \n from a double-escaped worker body ——

test('richText -- a blob with literal backslash-n is split into real lines', () => {
    const html = richText('first line\\nsecond line');
    assert.ok(!html.includes('\\n'), 'visible \\n survived into the output: ' + html);
    assert.ok(html.includes('<br>'), 'expected a line break, got: ' + html);
});

test('richText -- literal \\n lets markdown structure work again', () => {
    // The real PS-1995 symptom: bullets arrived on one line, so nothing rendered as a list.
    const html = richText('- one\\n- two');
    assert.match(html, /<ul[^>]*>.*<li>one<\/li>.*<li>two<\/li>.*<\/ul>/s);
});

test('richText -- text that already has REAL newlines is left alone', () => {
    // Here a \n is much more likely to be genuine content than a mistake, so do not touch it.
    const html = richText('a real break\nand a literal \\n inside');
    assert.ok(html.includes('\\n'), 'a legitimate literal \\n should survive: ' + html);
});

test('richText -- messages with no escapes are unaffected', () => {
    assert.equal(richText('plain'), 'plain');
});

// —— stray / unclosed fences ——

test('richText -- an UNCLOSED fence does not swallow the rest of the message', () => {
    const html = richText('intro line\n```\nstray fence, never closed\n**still bold**');
    assert.ok(html.includes('<b>still bold</b>'), 'formatting after a stray fence was lost: ' + html);
});

test('richText -- a properly closed fence still renders as a code block', () => {
    const html = richText('before\n```\ncode here\n```\nafter');
    assert.match(html, /<pre class="cb">code here<\/pre>/);
    assert.ok(html.includes('before') && html.includes('after'));
});

test('richText -- three fences: the first pair closes, the trailing one is just text', () => {
    const html = richText('```\nreal code\n```\ntail\n```');
    assert.match(html, /<pre class="cb">real code<\/pre>/);
    assert.ok(html.includes('tail'));
});

test('richText -- a lone fence as the entire message terminates', () => {
    // Regression guard for the hang: this must return, not loop forever.
    assert.equal(typeof richText('```'), 'string');
});

test('richText -- a fence directly against other blocks still terminates', () => {
    for (const s of ['```\n# head', '- item\n```', '```\n\n```\n```', '```\n|a|b|\n|-|-|']) {
        assert.equal(typeof richText(s), 'string', 'did not terminate for: ' + JSON.stringify(s));
    }
});

// —— the existing subset still works ——

test('richText -- headings, bold, inline code and tables are unchanged', () => {
    assert.match(richText('## Title'), /<div class="mdh">Title<\/div>/);
    assert.match(richText('**bold**'), /<b>bold<\/b>/);
    assert.match(richText('use `npm test` now'), /<code[^>]*>npm test<\/code>/);
    assert.match(richText('|a|b|\n|-|-|\n|1|2|'), /<table class="mdt">/);
});

test('richText -- HTML in a message is escaped, never injected', () => {
    // esc escapes & and < only; that is enough, since a tag cannot open without <.
    const html = richText('<script>alert(1)</script>');
    assert.ok(!html.includes('<script>'), 'raw script tag survived: ' + html);
    assert.ok(html.includes('&lt;script>'));
    assert.ok(!/<\/?script/i.test(html), 'an unescaped script tag survived: ' + html);
});
