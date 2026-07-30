// Real-browser verification of the MISSION RAIL's COORD chip + bound-session name, end to end: a
// scratch hub serving the real console.html/js/css, driven in a real Chrome, asserting what actually
// lands in the DOM.
//
//     node test-support/verify-coordchip-browser.mjs        (or: npm run verify:coordchip)
//
// WHY THIS EXISTS. console.js is browser script, so `node --test` can only reach the pure helpers
// lifted out of it by name (test/coordchip.test.mjs covers railRole + coordTip that way). Everything
// that makes this a FEATURE lives in the part the gate cannot see: that the chip reaches the row at
// all, that a sub-worker row does NOT get one, that a sub-worker's callsign is not printed twice, that
// an operator-supplied project title cannot break out of a title="" attribute, and that the 1.5s board
// poll does not blow any of it away. That gap is why the board keeps accumulating "needs Chris in the
// browser" cards; victor closed it for the search box, and this closes it for the rail.
//
// WHY NOT IN test/. `node --test` collects EVERY .mjs under test/, and this needs a system Chrome that
// not every machine has -- in the gate that is a flake, here it is a clean exit 2. It also costs ~40s.
// Same reasoning, same home, as verify-searchbox-browser.mjs next door.
//
// EXIT CODES: 0 all checks passed, 1 a check failed, 2 skipped (no usable Chrome).
import { createScratchHub } from './scratch-hub.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fails = [], notes = [];
let checks = 0;
const ok = (cond, label, detail) => {
    checks++;
    if (cond) console.log('  PASS  ' + label);
    else { console.log('  FAIL  ' + label + (detail ? '  -- ' + detail : '')); fails.push(label + (detail ? ' :: ' + detail : '')); }
};

// The doing-line from Chris's screenshot. It is the whole defect: the coordinator typed a line that
// reads exactly like a peer worker's, and the rail had nothing else to say it was the brain.
const PEER_DOING = 'working: bulk-operations guard fix';
// The rail's hierarchy arrow, as an escape rather than a literal: this file is read as UTF-8 but the
// repo's line endings and encodings are mixed, and a mangled literal here would fail as a missing
// arrow and send the next session hunting in console.js for a bug that is really in this test.
const ARROW = String.fromCharCode(0x21B3);

const hub = await createScratchHub();
try {
    await hub.start('coord-chip hub');
    console.log('hub up on ' + hub.origin);

    // A fresh data dir seeds the PrimeNG mission and the primeng project bound to it, so this is the
    // real shape Chris was looking at: a project card carrying the mission, two sub-workers under it.
    const co = await hub.post('/register', { cwd: hub.REPO, purpose: 'primeng coordinator', project: 'primeng' });
    const subA = await hub.post('/register', { cwd: hub.REPO, purpose: 'p-fileUpload API migration', parentProject: 'primeng' });
    const subB = await hub.post('/register', { cwd: hub.REPO, purpose: 'dialog visual QA', parentProject: 'primeng' });
    const CO_CS = String(co.callsign || '').toUpperCase();          // the session driving the project card
    const SUB_CS = [subA, subB].map(s => String(s.callsign || '').toUpperCase());
    ok(!!co.project && !!co.project.missionId, 'the coordinator registered onto a mission-linked project', JSON.stringify(co.project || null));
    await hub.post('/health', { uid: co.uid, context: 40, doing: PEER_DOING });
    await hub.post('/health', { uid: subA.uid, context: 20, doing: 'working: fileUpload' });
    await hub.post('/health', { uid: subB.uid, context: 20, doing: 'working: dialogs' });

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

    // Helpers over the rail's DOM. They ANSWER FOR A MISSING ELEMENT ('' / null) instead of throwing,
    // which matters more than it looks: every one of these selectors is a thing a regression can delete,
    // and a bare page.textContent() on a deleted element aborts the whole run at the first casualty. Six
    // mutation probes did exactly that, reporting one FAIL where five assertions were waiting to speak.
    // A broken build should tell Chris everything that broke, not just the first thing.
    const rows = () => page.locator('#mission .mworker');
    const rowText = async (i) => {
        const l = rows().nth(i);
        return (await l.count()) ? ((await l.textContent()) || '').replace(/\s+/g, ' ').trim() : '';
    };
    const chipCount = () => page.locator('#mission .coordchip').count();
    const txt = async (sel) => {
        const l = page.locator(sel).first();
        return (await l.count()) ? ((await l.textContent()) || '') : '';
    };
    const attr = async (sel, name) => {
        const l = page.locator(sel).first();
        return (await l.count()) ? ((await l.getAttribute(name)) || '') : '';
    };
    const cssOf = async (sel, prop) => {
        const l = page.locator(sel).first();
        return (await l.count()) ? l.evaluate((el, p) => getComputedStyle(el)[p], prop) : null;
    };

    try {
        await page.goto(hub.origin, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#mission .mitem', { timeout: 15000 });
        await page.waitForFunction(() => document.querySelectorAll('#mission .mworker').length === 3, null, { timeout: 15000 });
        await page.waitForTimeout(600);   // let a poll or two settle, so a LATE throw is caught too

        // 1. The console still loads. renderMissions runs on every board poll, so a throw in the row
        //    renderer takes the whole rail (and the poll chain) down -- the one way this breaks everything.
        ok(pageErrors.length === 0, 'console.js loads with no uncaught page error', pageErrors.join(' | '));
        ok(await page.isVisible('#mission'), 'the mission rail is visible');
        ok((await page.locator('#mission .mitem').count()) === 1, 'one mission renders on the rail');

        // 2. The chip exists, exactly once, on the coordinator row -- Chris's first question.
        ok((await chipCount()) === 1, 'exactly ONE COORD chip on the rail', String(await chipCount()));
        ok((await txt('#mission .coordchip')).trim() === 'COORD', 'it reads COORD', await txt('#mission .coordchip'));
        ok((await page.locator('#mission .mworker.coord .coordchip').count()) === 1, 'and it sits on the row classed .coord');
        ok((await rowText(0)).startsWith('PRIMENG'), 'the coordinator row is the PROJECT row (PRIMENG)', await rowText(0));

        // 3. WHO is driving it -- Chris's second question ("wait isn't oscar the coordinator?").
        ok((await page.locator('#mission .mworker.coord .cworker').count()) === 1, 'the coordinator row names its bound session');
        ok((await txt('#mission .mworker.coord .cworker')).includes(CO_CS),
            'and that name is the session actually registered (' + CO_CS + ')', await txt('#mission .mworker.coord .cworker'));
        ok(new RegExp('^PRIMENG\\s*.\\s*' + CO_CS + '\\s*COORD').test(await rowText(0)),
            'so the row reads PROJECT . SESSION COORD, in that order', await rowText(0));

        // 4. THE DEFECT ITSELF: the role no longer depends on the doing-line. Same text as his
        //    screenshot, still chipped.
        ok((await rowText(0)).includes(PEER_DOING), 'the coordinator still shows its doing-line', await rowText(0));
        ok((await page.locator('#mission .mworker.coord .coordchip').count()) === 1,
            'a doing-line that reads like a peer worker does NOT cost it the chip (the original bug)');

        // 5. The coordinator renders ABOVE its sub-workers. /board order does not guarantee it, and an
        //    indented row above the row it hangs under reads as broken.
        ok((await attr('#mission .mworker', 'class')).includes('coord'),
            'the coordinator is the FIRST row on the mission', await attr('#mission .mworker', 'class'));

        // 6. Sub-workers: indented, arrowed, and NOT labelled the brain.
        const subs = page.locator('#mission .mworker.sub');
        ok((await subs.count()) === 2, 'both sub-workers render as .sub rows', String(await subs.count()));
        ok((await page.locator('#mission .mworker.sub .coordchip').count()) === 0, 'NO sub-worker carries a COORD chip');
        ok((await page.locator('#mission .mworker.sub .cworker').count()) === 0,
            'and no sub-worker prints a second callsign (its own callsign IS the row -- printing b.worker there would render it twice)');
        const subTexts = await subs.allTextContents();
        ok(SUB_CS.every(cs => subTexts.some(t => t.includes(cs))), 'each sub-worker is named by its own callsign', subTexts.join(' | '));
        ok(subTexts.every(t => t.includes(ARROW)), 'each sub row keeps its hierarchy arrow', JSON.stringify(subTexts));
        const padL = await cssOf('#mission .mworker.sub', 'paddingLeft');
        ok(padL === '12px', 'and its indent survived the change', String(padL));

        // 7. The tooltip answers both questions in words, for the row Chris hovers.
        const tip = await attr('#mission .coordchip', 'title');
        ok(/^COORDINATOR of /.test(tip || ''), 'the chip tooltip states the role', String(tip));
        ok((tip || '').includes('PrimeNG'), 'names the project it coordinates', String(tip));
        ok((tip || '').includes(CO_CS), 'and names the session running it', String(tip));

        // 8. Rail-only scope: the board cards in #work were not touched.
        // Counted page-wide AND on the rail: `equal` alone would pass vacuously at 0 === 0 if the chip
        // stopped rendering at all, which a mutation probe caught this asserting nothing.
        const pageWide = await page.locator('.coordchip').count();
        ok(pageWide === 1 && (await chipCount()) === 1,
            'the chip appears ONCE, ONLY on the rail -- no leakage into the #work board cards', 'page-wide ' + pageWide);

        // 9. renderMissions is called by the 1.5s board poll, which rebuilds innerHTML wholesale.
        await page.waitForTimeout(3500);
        ok((await chipCount()) === 1, 'the chip survives the 1.5s board poll re-render');
        ok((await page.locator('#mission .mworker.coord .cworker').count()) === 1, 'so does the session name');

        // 9b. Chris's rail is a NARROW pinned panel (#right is 2/5 of the window) and the row is a flex
        //     line. The chip and the session name have to hold their size and let the doing-line
        //     ellipsise instead of being squeezed themselves. Only .cworker needs flex:none for that --
        //     "COORD" is one unbreakable word, so min-content already floors the chip (measured).
        const geoAt = async (w) => {
            await page.setViewportSize({ width: w, height: 900 });
            await page.waitForTimeout(250);
            const l = page.locator('#mission .mworker.coord').first();
            if (!(await l.count())) return { missing: 'no coordinator row' };
            return l.evaluate(el => {
                const box = (n) => n ? +n.getBoundingClientRect().width.toFixed(1) : null;
                const right = (n) => n ? +n.getBoundingClientRect().right.toFixed(1) : null;
                const chip = el.querySelector('.coordchip'), who = el.querySelector('.cworker'), last = el.lastElementChild;
                return {
                    chipW: box(chip), whoW: box(who), chipRight: right(chip),
                    rowRight: right(el),
                    rowOverflow: el.scrollWidth - el.clientWidth,
                    doingClipped: last ? last.scrollWidth > last.clientWidth : null,
                };
            });
        };
        const wide = await geoAt(1280), narrow = await geoAt(800);
        ok(narrow.doingClipped && !wide.doingClipped,
            'narrowing the window really does squeeze the row (so the checks below are not vacuous)', JSON.stringify({ wide, narrow }));
        ok(narrow.chipW === wide.chipW, 'the chip keeps its full width when the rail is narrow', JSON.stringify({ wide, narrow }));
        ok(narrow.whoW === wide.whoW, 'so does the session name', JSON.stringify({ wide, narrow }));
        ok(narrow.chipRight <= narrow.rowRight, 'the chip stays inside its row', JSON.stringify(narrow));
        ok(narrow.rowOverflow <= 0, 'and the row does not overflow horizontally -- the doing-line ellipsises instead', JSON.stringify(narrow));
        await page.setViewportSize({ width: 1280, height: 900 });

        // 10. A project TITLE is operator-supplied text (a coordinator can PATCH it) and it lands in a
        //     title="" attribute. The hub is not the attacker here -- the point is that the console's own
        //     escaping is asserted rather than assumed, so the response is intercepted to inject the
        //     hostile shape directly.
        const HOSTILE = 'a "quoted" <img src=x onerror="window.__XSS=1"> title';
        await page.route('**/board', async (route) => {
            const resp = await route.fetch();
            const body = await resp.json();
            for (const b of body.boards || []) {
                if (b.projectContext && b.projectContext.missionId) b.projectContext.title = HOSTILE;
            }
            await route.fulfill({ response: resp, body: JSON.stringify(body), headers: { ...resp.headers(), 'content-type': 'application/json' } });
        });
        // Wait on the POLL, not on the tooltip. Waiting for the hostile text to appear in the title
        // would be waiting for the very thing a broken build fails to do: a mutation probe that removed
        // the escaping aborted this run here instead of failing the three checks below, so the checks
        // proved nothing. Two poll cycles (1.5s each) guarantee the injected body has rendered.
        await page.waitForTimeout(3300);
        ok(await page.evaluate(() => window.__XSS === undefined), 'a hostile project title in the tooltip does not execute');
        ok((await attr('#mission .coordchip', 'title')).includes(HOSTILE), 'and survives as literal text in the attribute',
            await attr('#mission .coordchip', 'title'));
        ok((await page.locator('#mission .coordchip').count()) === 1, 'the chip still renders alongside it');
        ok((await page.locator('#mission img').count()) === 0, 'no element was injected into the rail');

        // 11. A coordinator whose heartbeat has gone stale greys with its row -- the role is still true,
        //     but a dead brain must not read as the authoritative one. `alive` is a 2-minute server-side
        //     window, so this state is injected rather than waited out.
        const bright = await cssOf('#mission .coordchip', 'color');
        await page.unroute('**/board');
        await page.route('**/board', async (route) => {
            const resp = await route.fetch();
            const body = await resp.json();
            for (const b of body.boards || []) if (b.projectContext && b.projectContext.missionId) b.alive = false;
            await route.fulfill({ response: resp, body: JSON.stringify(body), headers: { ...resp.headers(), 'content-type': 'application/json' } });
        });
        // Wait on `.actidle` -- the activity indicator's zzz glyph, which is PRE-EXISTING code and flips
        // on `alive` all by itself. Waiting on my own `.idle` class would again be waiting for the thing
        // under test, so dropping that class aborted the run rather than failing these checks.
        await page.waitForSelector('#mission .mworkers > div:first-child .actidle', { timeout: 8000 });
        ok((await page.locator('#mission .mworker.coord.idle').count()) === 1, 'the quiet coordinator row is marked idle');
        ok((await page.locator('#mission .mworker.idle .coordchip').count()) === 1, 'a quiet coordinator KEEPS its chip (the role did not stop being true)');
        const dim = await cssOf('#mission .coordchip', 'color');
        ok(dim !== bright, 'but the chip dims with the row rather than staying bright', bright + ' -> ' + dim);
        await page.unroute('**/board');
        // Recovery waits on `.actspin` -- the spinner the PRE-EXISTING activity indicator swaps back in
        // once the row is alive with a doing-line. Waiting for my own `.idle` class to disappear made a
        // sticky-dim mutation abort the run rather than fail the check below.
        await page.waitForSelector('#mission .mworkers > div:first-child .actspin', { timeout: 8000 });
        ok((await cssOf('#mission .coordchip', 'color')) === bright,
            'and comes back to full strength when it checks in again', bright + ' -> ' + (await cssOf('#mission .coordchip', 'color')));

        // 12. No coordinator live -> no chip. Retiring one nulls the project card's uid, so the row
        //     leaves the rail entirely; the sub-workers stay nested (they inherit through the card, which
        //     survives). Honest: nothing claims to be the brain when nothing is.
        await hub.post('/retire', { uid: co.uid, summary: 'coordinator stood down', successor: false });
        await page.waitForFunction(() => document.querySelectorAll('#mission .mworker').length === 2, null, { timeout: 10000 });
        ok((await chipCount()) === 0, 'with no coordinator session live, NOTHING on the rail is chipped');
        ok((await page.locator('#mission .mworker.sub').count()) === 2, 'and its sub-workers stay nested under the mission');
        ok((await page.locator('#mission .cworker').count()) === 0, 'no orphan session name is left behind');

        // 13. THE RULE, live: the chip tracks how a session is BOUND, not whether it has children. A
        //     lone coordinator -- every sub-worker retired -- is still the coordinator.
        const co2 = await hub.post('/register', { cwd: hub.REPO, purpose: 'primeng coordinator, second shift', project: 'primeng' });
        await hub.post('/retire', { uid: subA.uid, summary: 'fileUpload done', successor: false });
        await hub.post('/retire', { uid: subB.uid, summary: 'dialogs done', successor: false });
        await page.waitForFunction(() => document.querySelectorAll('#mission .mworker').length === 1, null, { timeout: 10000 });
        ok((await chipCount()) === 1, 'a coordinator with ZERO sub-workers still carries the chip (the rule, not an accident)');
        ok((await page.locator('#mission .mworker.sub').count()) === 0, 'with no indented rows left to imply it');
        ok((await txt('#mission .mworker.coord .cworker')).includes(String(co2.callsign).toUpperCase()),
            'and it names the NEW session driving the project', await txt('#mission .mworker.coord'));

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
