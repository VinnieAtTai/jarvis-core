// Unit tests for deadTabsFor + openTab in console.js -- which retired sessions keep a clickable chat
// tab, and therefore which tab Chris is allowed to keep reading.
//
// THE DEFECT: renderTabs ends with
//     if (!ids.includes(activeTab) && !viewLock) activeTab = 'all'
// and `ids` held only the FOUR most-recently-heard retired callsigns. So the tab Chris had open reset
// itself to ALL the moment the session behind it retired -- and 21 sessions retired here in one day, so
// it fired constantly, mid-read, with no warning. Two things had to change: the tab he opened HIMSELF
// has to survive its session's retirement, and the cache has to be deep enough that the history is
// still there to show when it does.
//
// console.js is browser script, so the pure functions are lifted out of the source by name -- same
// approach as test/nesting.test.mjs, and it fails loudly if either is renamed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../console.js', import.meta.url), 'utf8');
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
const deadTabsFor = new Function(lift('deadTabsFor') + '\nreturn deadTabsFor;')();
// openTab closes over the two module-level lets, so the lift supplies them and reports both back.
const callOpenTab = new Function(
    'let activeTab = "all", stickyTab = "";\n' + lift('openTab')
    + '\nreturn (id) => { openTab(id); return { activeTab, stickyTab }; };')();

// A transcript window that has heard from six retired sessions, oldest first in insertion order so the
// test proves the SORT is doing the work rather than object key order.
const HEARD = {
    alpha: '2026-07-31T10:00:00Z',
    bravo: '2026-07-31T11:00:00Z',
    charlie: '2026-07-31T12:00:00Z',
    delta: '2026-07-31T13:00:00Z',
    echo: '2026-07-31T14:00:00Z',
    foxtrot: '2026-07-31T15:00:00Z',
};
const BASE = ['all', 'general', 'jarvis', 'ask'];

test('deadTabsFor -- most recently heard first, capped', () => {
    assert.deepEqual(deadTabsFor(HEARD, '', 3, BASE), ['foxtrot', 'echo', 'delta']);
    assert.deepEqual(deadTabsFor(HEARD, '', 6, BASE).length, 6);
});

test('THE FIX: a tab Chris opened himself survives falling out of the cache', () => {
    // 'alpha' is the OLDEST, so a cap of 3 evicts it -- exactly the case that used to reset his tab.
    const tabs = deadTabsFor(HEARD, 'alpha', 3, BASE);
    assert.ok(tabs.includes('alpha'), 'the explicitly-opened tab must be retained past the cap');
    // ...and the whole point: the renderTabs fallback now finds it, so activeTab is never rewritten.
    const ids = BASE.concat(tabs);
    assert.ok(ids.includes('alpha'), 'activeTab would still be bounced to "all"');
});

test('THE FIX: an opened tab whose messages have aged out of the transcript is still kept', () => {
    // A retired session is a retired session, not a missing one. Worst case the tab renders empty and
    // Chris clicks away -- his call, not the console's.
    assert.deepEqual(deadTabsFor({}, 'kilo', 12, BASE), ['kilo']);
    assert.ok(deadTabsFor(HEARD, 'kilo', 12, BASE).includes('kilo'));
});

test('deadTabsFor -- a sticky tab is never duplicated by the retention', () => {
    // Once per reason it could already be renderable: it is in the ranked list, it is a base tab, it is
    // a live session, or it is a mission-OWNED identity reachable under its mission tab. A duplicate
    // greyed twin beside the live one is the exact pairing missionChatSets was written to kill.
    const once = (arr, v) => arr.filter(x => x === v).length;
    assert.equal(once(deadTabsFor(HEARD, 'echo', 12, BASE), 'echo'), 1, 'already ranked');
    assert.equal(once(deadTabsFor(HEARD, 'all', 12, BASE), 'all'), 0, 'base tab');
    assert.equal(once(deadTabsFor(HEARD, 'lima', 12, BASE.concat(['lima'])), 'lima'), 0, 'live session');
    assert.equal(once(deadTabsFor(HEARD, 'oscar', 12, BASE.concat(['m:m_1', 'oscar'])), 'oscar'), 0, 'mission-owned');
});

test('deadTabsFor -- a mission tab is not injected as a dead callsign tab', () => {
    // 'm:<id>' has no callsign to render, and a mission is closed deliberately by the voice gate, so
    // its tab going away is intended rather than the bug this fixes.
    assert.deepEqual(deadTabsFor({}, 'm:m_mqzmh4u8037', 12, BASE), []);
});

test('deadTabsFor -- no sticky tab means pure cache behaviour, unchanged', () => {
    for (const empty of ['', null, undefined, 0, false]) {
        assert.deepEqual(deadTabsFor(HEARD, empty, 2, BASE), ['foxtrot', 'echo'], String(empty));
    }
});

test('deadTabsFor -- garbage in, a list out, never a throw (it runs inside a render loop)', () => {
    assert.deepEqual(deadTabsFor(null, '', 4, null), []);
    assert.deepEqual(deadTabsFor(undefined, 'kilo', 4, undefined), ['kilo']);
    assert.deepEqual(deadTabsFor(HEARD, '', 0, BASE), [], 'a zero cap keeps nothing');
    assert.deepEqual(deadTabsFor(HEARD, '', -5, BASE), [], 'a negative cap must not slice from the end');
    assert.deepEqual(deadTabsFor(HEARD, 'kilo', null, BASE), ['kilo'], 'a missing cap still honours sticky');
    // An unparseable/absent timestamp must not drop the callsign or throw on the comparator.
    const ragged = { mike: null, november: 'not-a-date', oscar: '2026-07-31T16:00:00Z' };
    const out = deadTabsFor(ragged, '', 12, BASE);
    assert.equal(out.length, 3);
    assert.equal(out[0], 'oscar', 'a real timestamp still outranks the unparseable ones');
});

test('the dead-tab cache is deep enough to be worth having (regression guard on 4)', () => {
    const m = /const DEAD_TAB_CAP\s*=\s*(\d+)/.exec(src);
    assert.ok(m, 'console.js no longer defines DEAD_TAB_CAP -- update this test');
    assert.ok(Number(m[1]) >= 12, 'DEAD_TAB_CAP fell back to ' + m[1] + '; 4 is what let the history vanish');
});

// —— tabIdentities: the project-key / bound-session bridge ————————————————————————————————————————
// A project card's tab id is the project KEY, but the session bound to it speaks under its NATO
// callsign. eventsForTab matched only `e.who === activeTab`, bridged for 'jarvis' by a hardcode and for
// mission-linked projects by mission aggregation -- so a BOUND project with no mission, not named
// jarvis (e.g. the seeded 'waterfall'), rendered a completely EMPTY chat tab.
const tabIdentities = new Function(lift('tabIdentities') + '\nreturn tabIdentities;')();
const BOARDS = [
    { callsign: 'waterfall', uid: 's_1', worker: 'oscar', projectContext: { name: 'waterfall', missionId: null } },
    { callsign: 'lima', uid: 's_2' },
    { callsign: 'jarvis', uid: 's_3', worker: 'uniform', projectContext: { name: 'jarvis', missionId: null } },
];

test('THE HOLE: a bound project tab answers to its key AND the session driving it', () => {
    assert.deepEqual(tabIdentities('waterfall', BOARDS), ['waterfall', 'oscar']);
    assert.deepEqual(tabIdentities('jarvis', BOARDS), ['jarvis', 'uniform'],
        'the same rule the jarvis hardcode encoded, now general');
});

test('tabIdentities -- a plain worker tab answers to exactly one name', () => {
    assert.deepEqual(tabIdentities('lima', BOARDS), ['lima']);
    assert.deepEqual(tabIdentities('kilo', BOARDS), ['kilo'], 'a retired session has no card left');
});

test('tabIdentities -- an unbound project card does not invent a second identity', () => {
    const idle = [{ callsign: 'waterfall', uid: null, projectContext: { missionId: null } }];
    assert.deepEqual(tabIdentities('waterfall', idle), ['waterfall']);
    assert.deepEqual(tabIdentities('waterfall', [{ callsign: 'waterfall', worker: 'waterfall' }]), ['waterfall'],
        'a card whose worker IS its own callsign must not list it twice');
});

test('tabIdentities -- garbage in, a list out, never a throw (it runs on every chat render)', () => {
    assert.deepEqual(tabIdentities('', BOARDS), []);
    assert.deepEqual(tabIdentities(null, BOARDS), []);
    assert.deepEqual(tabIdentities(undefined, null), []);
    assert.deepEqual(tabIdentities('lima', [null, undefined]), ['lima'], 'a malformed row must not stop the lookup');
});

test('the chat filter actually uses the bridge', () => {
    assert.match(src, /const ids = tabIdentities\(activeTab, \(lastBoard && lastBoard\.boards\) \|\| \[\]\);/);
    assert.match(src, /ids\.includes\(e\.who\) \|\| \(e\.who === 'you' && ids\.includes\(e\.to\)\)/);
});

test('openTab records BOTH halves -- the sticky half is the entire fix', () => {
    assert.deepEqual(callOpenTab('kilo'), { activeTab: 'kilo', stickyTab: 'kilo' });
});

test('every explicit tab open routes through openTab, so none can forget the sticky half', () => {
    // The drift guard. Two places open a tab on a click (the tab strip, and a click on a card body);
    // a third will be added one day. Any assignment to activeTab OTHER than the declaration and the
    // renderTabs fallback means someone set the tab without making it sticky, and the reset defect is
    // quietly back for that path.
    const assigns = src.match(/(?<![.\w])activeTab\s*=(?!=)/g) || [];
    assert.equal(assigns.length, 3,
        'expected exactly 3 `activeTab =` sites (the `let`, openTab, and the renderTabs fallback); found '
        + assigns.length + ' -- a new one must go through openTab');
    assert.ok(/function openTab\(id\)\s*\{\s*activeTab = stickyTab = id;/.test(src),
        'openTab must set both activeTab and stickyTab');
    assert.match(src, /openTab\(t\.getAttribute\('data-tab'\)\)/, 'the tab strip must open through openTab');
    assert.match(src, /openTab\(cs\);\s*renderChat\(\)/, 'a card-body click must open through openTab');
});
