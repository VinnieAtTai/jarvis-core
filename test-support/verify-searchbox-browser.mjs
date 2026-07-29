// Real-browser verification of the CONSOLE SEARCH BOX, end to end: a scratch hub serving the real
// console.html/js/css, driven in a real Chrome, asserting what actually lands in the DOM.
//
//     node test-support/verify-searchbox-browser.mjs        (or: npm run verify:searchbox)
//
// WHY THIS EXISTS. console.js is browser script, so `node --test` can only ever reach the handful of
// pure helpers lifted out of it by name (test/searchbox.test.mjs, test/richtext.test.mjs,
// test/nesting.test.mjs). Everything that makes the search box a FEATURE -- that the count says
// "newest 50 of 60" rather than implying 50 was everything, that a hit is labelled with who and when,
// that the 1.5s board poll does not blow the results away -- lives in the part the gate cannot see.
// That gap is why the board keeps accumulating "needs Chris in the browser" cards. This closes it for
// this one feature, repeatably, instead of once by hand.
//
// WHY NOT IN test/. Two reasons, and both matter:
//   1. `node --test` matches EVERY .mjs under test/, so a file there joins the gate. This needs a
//      system Chrome, which not every machine has -- in the gate that is a flake, here it is a skip.
//   2. It costs ~40s. The gate is run constantly; this is run when the search box changes.
//   test-support/ is already the home for exactly this (see scratch-hub.mjs's own note).
//
// WHY channel:'chrome'. No playwright-managed browser is installed on this machine
// (%LOCALAPPDATA%\ms-playwright is empty), so the bundled chromium cannot launch. The hub itself only
// ever opens the SYSTEM Chrome (jarvis-core.mjs: channel:'chrome'), so that is both available and the
// closest thing to what Chris actually looks at.
//
// EXIT CODES: 0 all checks passed, 1 a check failed, 2 skipped (no usable Chrome).
import { createScratchHub } from './scratch-hub.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fails = [], notes = [];
let checks = 0;
const ok = (cond, label, detail) => {
    checks++;
    if (cond) console.log('  PASS  ' + label);
    else { console.log('  FAIL  ' + label + (detail ? '  -- ' + detail : '')); fails.push(label + (detail ? ' :: ' + detail : '')); }
};

const hub = await createScratchHub();
try {
    // ---- Seed the transcript BEFORE start: transcriptCache is built once, at module load. --------
    const lines = [];
    const iso = (d) => d.toISOString();
    const now = new Date();
    // Built from LOCAL components so the rendered wall-clock time is zone-independent.
    const daysAgo = (n, h = 14, mi = 32) => { const d = new Date(now); d.setDate(d.getDate() - n); d.setHours(h, mi, 0, 0); return d; };

    // 60 matches, against a server limit of 50 -- the only way to exercise truncation for real.
    for (let i = 0; i < 60; i++) {
        lines.push({ ts: iso(daysAgo(40, 9, (i % 50) + 1)), kind: 'chat', from: 'alpha', text: 'widget number ' + i + ' reported' });
    }
    // One "zephyr" hit per identity the projection produces, and per age band fmtWhen distinguishes.
    lines.push({ ts: iso(daysAgo(0, 11, 5)), kind: 'speech', text: 'what happened to the zephyr build' });        // who -> you
    lines.push({ ts: iso(daysAgo(0, 11, 6)), kind: 'tts', from: 'jarvis', text: 'the zephyr build is green' });   // who -> jarvis
    lines.push({ ts: iso(daysAgo(2, 16, 45)), kind: 'chat', from: 'bravo', text: 'zephyr needed a rebase' });      // dated
    lines.push({ ts: iso(daysAgo(400, 8, 15)), kind: 'chat', from: 'charlie', text: 'zephyr first landed here' }); // dated + year
    // sys and task are machinery, excluded by the server's DEFAULT_KINDS. Seeded so their absence is
    // an assertion rather than an assumption.
    lines.push({ ts: iso(daysAgo(1, 10, 0)), kind: 'sys', text: 'zephyr sys line that must NOT show' });
    lines.push({ ts: iso(daysAgo(1, 10, 1)), kind: 'task', from: 'alpha', text: 'zephyr task line that must NOT show' });
    // Three lines carrying "commit" and/or "baton"; exactly ONE carries both.
    lines.push({ ts: iso(daysAgo(3, 12, 0)), kind: 'chat', from: 'delta', text: 'the commit baton serializes merges' });
    lines.push({ ts: iso(daysAgo(3, 12, 1)), kind: 'chat', from: 'delta', text: 'baton alone on this line' });
    lines.push({ ts: iso(daysAgo(3, 12, 2)), kind: 'chat', from: 'delta', text: 'a lonely commit on this line' });
    // Hostile text: chat history is attacker-influenced the moment a worker echoes anything.
    lines.push({ ts: iso(daysAgo(4, 12, 0)), kind: 'chat', from: 'echo', text: 'pwntest <img src=x onerror="window.__XSS=1">' });
    writeFileSync(join(hub.DATA, 'transcript.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    await hub.start('search-box hub');
    console.log('hub up on ' + hub.origin);

    const api = await hub.get('/search?q=zephyr');
    ok(Array.isArray(api.results), 'GET /search answers JSON from this build', JSON.stringify(api).slice(0, 120));

    // playwright's index.js is CJS: the browser types hang off `default`, not the namespace.
    const pwmod = await import(pathToFileURL(join(hub.nodeModules, 'playwright', 'index.js')).href);
    const pw = pwmod.default || pwmod;
    let browser;
    try {
        browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
    } catch (e) {
        console.log('\nSKIP: no usable system Chrome -- ' + String(e.message).split('\n')[0]);
        process.exit(2);
    }
    const page = await browser.newPage();
    const pageErrors = [], consoleErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e.message)));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    try {
        await page.goto(hub.origin, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#qbox', { timeout: 15000 });
        await page.waitForTimeout(1200);   // let the polls settle, so a LATE throw is caught too

        // 1. The console still loads. `qboxEl` is resolved at script load, so a missing id here would
        //    throw and take the whole console down -- the one way this change could break everything.
        ok(pageErrors.length === 0, 'console.js loads with no uncaught page error', pageErrors.join(' | '));
        ok(await page.isVisible('#qbox'), 'the search box is visible in #bar');
        ok(!(await page.isVisible('#qexit')), 'the EXIT SEARCH chip is hidden until a search runs');

        // 2. Truncation stated honestly -- the whole reason the server returns `total`.
        await page.fill('#qbox', 'widget');
        await page.press('#qbox', 'Enter');
        await page.waitForSelector('.shead', { timeout: 8000 });
        const count = (await page.textContent('.scount')).trim();
        ok(count === 'newest 50 of 60', 'a truncated search says "newest 50 of 60", not "50"', count);
        ok((await page.locator('#chat .row').count()) === 50, '50 hit rows render (the server cap)');
        ok(await page.isVisible('#qexit'), 'the EXIT SEARCH chip appears once results are up');

        // 3. Every hit labelled with who + when.
        await page.fill('#qbox', 'zephyr');
        await page.press('#qbox', 'Enter');
        await page.waitForFunction(() => /4 matches/.test(document.querySelector('.scount')?.textContent || ''), null, { timeout: 8000 });
        ok(true, 'default kinds exclude sys and task (4 matches, not 6)');
        ok(!(await page.textContent('#chat')).includes('must NOT show'), 'the sys and task lines are absent from the DOM');

        const whos = (await page.locator('#chat .row .chip').allTextContents()).map(s => s.replace(/[^A-Z]/g, ''));
        ok(whos.includes('JARVIS'), 'a jarvis hit is labelled JARVIS (the chat suppresses this chip; search must not)', whos.join(','));
        ok(whos.includes('BRAVO') && whos.includes('CHARLIE'), 'worker hits are labelled by callsign', whos.join(','));
        ok((await page.locator('#chat .row.me').count()) === 1, 'your own speech hit renders as yours (right-aligned .me)');

        const stamps = await page.locator('#chat .row .t').allTextContents();
        ok(stamps.some(s => /^\d\d:\d\d$/.test(s.trim())), "today's hit shows a bare time", stamps.join(' | '));
        ok(stamps.some(s => /^[A-Z][a-z]{2} \d+ \d\d:\d\d$/.test(s.trim())), 'an older hit shows a date', stamps.join(' | '));
        ok(stamps.some(s => /^[A-Z][a-z]{2} \d+ \d{4} \d\d:\d\d$/.test(s.trim())), 'a hit from another year shows the year', stamps.join(' | '));

        // 4. Terms are ANDed within one line.
        await page.fill('#qbox', 'commit baton');
        await page.press('#qbox', 'Enter');
        await page.waitForFunction(() => /1 match\b/.test(document.querySelector('.scount')?.textContent || ''), null, { timeout: 8000 });
        const andTxt = await page.textContent('#chat');
        ok(andTxt.includes('serializes merges'), 'a line with BOTH terms matches');
        ok(!andTxt.includes('baton alone') && !andTxt.includes('a lonely commit'), 'terms are ANDed within one line, not ORed');
        ok((await page.locator('#chat .row').count()) === 1, 'so exactly one row renders for "commit baton"');

        // 5. Hostile text renders as text. Hits reuse richText, same as the chat -- assert, don't assume.
        await page.fill('#qbox', 'pwntest');
        await page.press('#qbox', 'Enter');
        await page.waitForFunction(() => /1 match\b/.test(document.querySelector('.scount')?.textContent || ''), null, { timeout: 8000 });
        ok(await page.evaluate(() => window.__XSS === undefined), 'a hit containing an <img onerror> does not execute');
        ok((await page.textContent('#chat')).includes('onerror'), 'that hit is still shown, as literal text');

        // 6. An empty result set is honest, never a silently blank pane.
        await page.fill('#qbox', 'zzzznothingmatchesthis');
        await page.press('#qbox', 'Enter');
        await page.waitForSelector('.snote', { timeout: 8000 });
        ok((await page.textContent('.scount')).trim() === 'no matches', 'zero hits says "no matches"');
        ok((await page.textContent('.snote')).includes('No matches'), 'and explains, instead of showing an empty pane');

        // 7. Every way back out to the live chat.
        const search = async (q) => { await page.fill('#qbox', q); await page.press('#qbox', 'Enter'); await page.waitForSelector('.shead', { timeout: 8000 }); };
        const gone = async () => { await page.waitForTimeout(400); return (await page.locator('.shead').count()) === 0; };
        await search('widget'); await page.click('.sexit');
        ok(await gone(), '"back to chat" in the header exits search');
        ok((await page.inputValue('#qbox')) === '', 'and clears the box');
        ok(!(await page.isVisible('#qexit')), 'and hides the EXIT SEARCH chip');
        await search('widget'); await page.press('#qbox', 'Escape');
        ok(await gone(), 'Escape in the box exits search');
        await search('widget'); await page.click('#qexit');
        ok(await gone(), 'the EXIT SEARCH chip in #bar exits search');

        // 8. renderChat is called every 1.5s by the board poll. Rebuilding innerHTML resets scrollTop,
        //    so results must survive it AND not jump the reading position.
        await search('widget');
        await page.evaluate(() => { document.getElementById('chat').scrollTop = 400; });
        const before = await page.evaluate(() => document.getElementById('chat').scrollTop);
        await page.waitForTimeout(3500);
        const after = await page.evaluate(() => document.getElementById('chat').scrollTop);
        ok((await page.locator('.shead').count()) === 1, 'results survive the 1.5s poll re-render');
        ok(after === before, 'and the poll does not reset the scroll position', before + ' -> ' + after);

        // 9. 't' and 'r' are global view hotkeys with no focus guard of their own, so the box must
        //    stop the event itself -- otherwise typing a query flips the pane to RAW mid-word.
        await page.fill('#qbox', '');
        await page.click('#qbox');
        await page.keyboard.type('rt');
        ok(await page.isVisible('#chat'), "typing 'r' in the box does not flip to RAW view");
        ok((await page.inputValue('#qbox')) === 'rt', 'and the characters land in the box');

        // 10. archive.capped -- `total` is a floor, so the box must admit partial reach. foxtrot's
        //     archive change is on a separate branch, so the response is intercepted here rather than
        //     waiting on a merge: this asserts MY rendering against the envelope shape it agreed to.
        await search('widget');
        ok((await page.locator('.scap').count()) === 0, 'no partial-reach warning when the hub sends no archive block');
        await page.route('**/search?*', async (route) => {
            const resp = await route.fetch();
            const body = await resp.json();
            body.archive = { searched: true, capped: true, oldestScannedTs: '2025-06-03T08:15:00.000Z' };
            await route.fulfill({ response: resp, body: JSON.stringify(body), headers: { ...resp.headers(), 'content-type': 'application/json' } });
        });
        await page.fill('#qbox', 'widget');
        await page.press('#qbox', 'Enter');
        await page.waitForSelector('.scap', { timeout: 8000 });
        ok(true, 'a capped archive scan renders the partial-reach warning');
        const tip = await page.getAttribute('.scap', 'title');
        ok(/2025-06-03/.test(tip || ''), 'and its tooltip names where the scan stopped', String(tip));
        ok((await page.textContent('.scount')).trim() === 'newest 50 of 60', 'the count still renders alongside it');
        await page.unroute('**/search?*');
        await page.fill('#qbox', 'widget');
        await page.press('#qbox', 'Enter');
        await page.waitForFunction(() => document.querySelectorAll('.scap').length === 0, null, { timeout: 8000 });
        ok(true, 'and the warning clears once the hub stops reporting a cap');

        // 11. A tab click means "show me that chat", not "stay in results".
        await search('widget');
        const tab = page.locator('#stabs [data-tab]').first();
        if (await tab.count()) { await tab.click(); ok(await gone(), 'switching tabs leaves search'); }
        else notes.push('no session tabs in the scratch hub -- tab-exit not exercised here');

        ok(pageErrors.length === 0, 'still no uncaught page errors after the whole walkthrough', pageErrors.join(' | '));
        if (consoleErrors.length) notes.push('console.error output (may be pre-existing): ' + consoleErrors.slice(0, 4).join(' | '));
    } finally {
        await browser.close();
    }
} finally {
    hub.dispose();
}
console.log('\n' + checks + ' checks: ' + (fails.length ? 'FAILURES (' + fails.length + '):\n  ' + fails.join('\n  ') : 'ALL PASSED'));
for (const n of notes) console.log('NOTE: ' + n);
process.exit(fails.length ? 1 : 0);
