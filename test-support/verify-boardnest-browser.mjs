// Real-browser verification of the two BOARD-ROT fixes Chris actually sees, end to end: a scratch hub
// serving the real console.html/js/css, driven in a real Chrome, asserting what lands in the DOM.
//
//     node test-support/verify-boardnest-browser.mjs        (or: npm run verify:boardnest)
//
// WHY THIS EXISTS. console.js is browser script, so `node --test` can only reach the pure helpers lifted
// out of it by name -- test/boardnest.test.mjs covers groupBoards and test/deadtabs.test.mjs covers
// deadTabsFor + openTab that way. Both defects, though, are only defects in the part the gate cannot
// see: whether a sub-worker's card actually renders INSIDE its coordinator's group, whether the
// top-level column really holds still when one spawns, whether a click still opens a chat tab now that
// a wrapper div sits between the card and #work, and above all whether the tab Chris opened survives a
// REAL retirement arriving on a REAL 1.5s board poll. Two prior sessions diagnosed these from the source
// alone; this is the half that only a browser can answer.
//
// WHY NOT IN test/. `node --test` collects EVERY .mjs under test/, and this needs a system Chrome that
// not every machine has -- in the gate that is a flake, here it is a clean exit 2. Same reasoning, same
// home, as verify-coordchip-browser.mjs next door.
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
// The nesting arrow, as an escape rather than a literal: the repo's encodings are mixed and a mangled
// literal here would fail as a missing arrow and send the next session hunting in console.js for a bug
// that is really in this file.
const ARROW = String.fromCharCode(0x21B3);
// 'waterfall' is a seeded project with NO mission (see seedProjects). That matters twice over: a
// mission would fold its workers into a single mission TAB, and 'jarvis' is special-cased in both
// renderTabs and the board's button logic. waterfall is the plain case both fixes have to handle.
const PROJ = 'waterfall';
const SUB_A_SAID = 'rate grid import is green';
const PROJ_SAID = 'tender pack is assembled and waiting on review';

const hub = await createScratchHub();
try {
    await hub.start('board-nest hub');
    console.log('hub up on ' + hub.origin);

    const co = await hub.post('/register', { cwd: hub.REPO, purpose: 'waterfall coordinator', project: PROJ });
    const subA = await hub.post('/register', { cwd: hub.REPO, purpose: 'PS-23 tender import', parentProject: PROJ });
    const subB = await hub.post('/register', { cwd: hub.REPO, purpose: 'PS-23 rate grid', parentProject: PROJ });
    const loner = await hub.post('/register', { cwd: hub.REPO, purpose: 'standalone worker, no parent' });
    ok(!!co.uid && !!subA.uid && !!subB.uid && !!loner.uid, 'four sessions registered on the scratch hub');
    // subA speaks FIRST, so it is the OLDEST voice in the transcript -- that is what makes it the first
    // callsign the dead-tab ranking evicts, which is the whole of defect 1 (phase 4 below).
    await hub.post('/send', { from: subA.uid, to: 'human', text: SUB_A_SAID });
    for (const s of [co, subB, loner]) await hub.post('/send', { from: s.uid, to: 'human', text: 'checking in' });

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

    // DOM helpers. They ANSWER for a missing element ('' / null / []) rather than throwing: every
    // selector below is something a regression can delete, and a bare textContent() on a deleted
    // element aborts the run at the first casualty instead of reporting everything that broke.
    const card = (cs) => page.locator('#work .card[data-cs="' + cs + '"]');
    // The TOP-LEVEL column: one card per group, the first child of each .cgroup. This list is exactly
    // what must not move when a sub-worker comes or goes.
    const topLevel = () => page.evaluate(() => Array.from(document.querySelectorAll('#work .cgroup'))
        .map(g => { const c = g.querySelector(':scope > .card'); return c ? c.getAttribute('data-cs') : null; }));
    const groupOf = (cs) => page.evaluate((c) => {
        const el = document.querySelector('#work .card[data-cs="' + c + '"]');
        const g = el && el.closest('.cgroup');
        return g ? Array.from(g.querySelectorAll(':scope > .card')).map(x => x.getAttribute('data-cs')) : null;
    }, cs);
    const activeTabId = async () => {
        const l = page.locator('#stabs .stab.active').first();
        return (await l.count()) ? ((await l.getAttribute('data-tab')) || '') : '';
    };
    const activeTabClass = async () => {
        const l = page.locator('#stabs .stab.active').first();
        return (await l.count()) ? ((await l.getAttribute('class')) || '') : '';
    };
    const cssOf = async (sel, prop) => {
        const l = page.locator(sel).first();
        return (await l.count()) ? l.evaluate((el, p) => getComputedStyle(el)[p], prop) : null;
    };
    // A retired session's card either greys out or leaves /board altogether, depending on whether it
    // has any tasks to keep it there. Both are "the retirement has landed in the render", and pinning
    // this to one of them would make the rig fail on hub behaviour that is not the subject.
    const retirementLanded = (cs) => page.waitForFunction((c) => {
        const el = document.querySelector('#work .card[data-cs="' + c + '"]');
        return !el || el.className.includes('cdead');
    }, cs, { timeout: 15000 });
    const settle = () => page.waitForTimeout(1800);   // one full 1.5s board poll, plus slack
    const CO = co.callsign, A = subA.callsign, B = subB.callsign, L = loner.callsign;

    try {
        await page.goto(hub.origin, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#work .card', { timeout: 15000 });
        await page.waitForFunction((cs) => !!document.querySelector('#work .card[data-cs="' + cs + '"]'), A, { timeout: 15000 });
        await page.waitForTimeout(700);   // let a poll or two settle, so a LATE throw is caught too

        // —— 1. The console still loads. renderBoards runs on every 1.5s poll, so a throw in the card
        //       renderer takes the board AND the poll chain down -- the one way this breaks everything.
        ok(pageErrors.length === 0, 'console.js loads with no uncaught page error', pageErrors.join(' | '));
        ok((await page.locator('#work .cgroup').count()) > 0, 'the board renders in groups');
        ok((await page.locator('#work .card').count()) >= 5, 'all four sessions plus the jarvis card render',
            String(await page.locator('#work .card').count()));

        // —— 2. DEFECT 2: sub-worker cards nest under their coordinator instead of sitting flat.
        ok((await groupOf(A) || []).length === 3, 'the project card and BOTH its sub-workers share one group',
            JSON.stringify(await groupOf(A)));
        ok((await groupOf(A) || [])[0] === PROJ, 'and the project card is the FIRST card in that group',
            JSON.stringify(await groupOf(A)));
        ok((await card(A).getAttribute('class') || '').includes('csub'), 'the sub-worker card carries .csub');
        ok((await card(B).getAttribute('class') || '').includes('csub'), 'both of them do');
        ok(!(await card(PROJ).getAttribute('class') || '').includes('csub'), 'the project card does NOT');
        ok(!(await card(L).getAttribute('class') || '').includes('csub'), 'nor does a worker with no parent');
        ok((await groupOf(L) || []).length === 1, 'the unparented worker is its own single-card group',
            JSON.stringify(await groupOf(L)));

        // —— 3. It has to LOOK nested, in the mission rail's own visual language, or the structure is
        //       invisible and Chris is back to reading a flat list.
        const ml = await cssOf('#work .card.csub', 'marginLeft');
        ok(parseFloat(ml) > 0, 'a nested card is indented', String(ml));
        ok((await page.locator('#work .card.csub .csubarrow').count()) === 2, 'each nested card carries the arrow glyph');
        ok(((await card(A).textContent()) || '').includes(ARROW), 'and the arrow really is the rail arrow', ARROW);
        // The indent must not cost a nested card its state colours: .csub is declared after
        // .cfocus/.cneeds, so a border rule there would have outranked both.
        await hub.post('/focus', { callsign: A });
        await page.waitForFunction((cs) => {
            const el = document.querySelector('#work .card[data-cs="' + cs + '"]');
            return !!el && el.className.includes('cfocus');
        }, A, { timeout: 10000 });
        const focusBorder = await cssOf('#work .card.csub.cfocus', 'borderLeftColor');
        const plainBorder = await cssOf('#work .card[data-cs="' + PROJ + '"]', 'borderLeftColor');
        ok(!!focusBorder && focusBorder !== plainBorder,
            'a FOCUSED nested card still shows its focus border (the indent did not outrank .cfocus)',
            focusBorder + ' vs ' + plainBorder);

        // —— 4. THE BOUNCE ITSELF. A third sub-worker spawns: under the old flat render that was a new
        //       TOP-LEVEL card and every card below it jumped. The top-level column must not move.
        const before = await topLevel();
        ok(before.length >= 3 && before.every(Boolean), 'the top-level column reads cleanly', JSON.stringify(before));
        const subC = await hub.post('/register', { cwd: hub.REPO, purpose: 'PS-23 export mapping', parentProject: PROJ });
        await page.waitForFunction((cs) => !!document.querySelector('#work .card[data-cs="' + cs + '"]'), subC.callsign, { timeout: 10000 });
        ok(JSON.stringify(await topLevel()) === JSON.stringify(before),
            'a sub-worker SPAWNING does not change the top-level column', JSON.stringify(await topLevel()) + ' was ' + JSON.stringify(before));
        ok((await card(subC.callsign).getAttribute('class') || '').includes('csub'),
            'the new sub-worker landed INSIDE its coordinator group, not at the top level');
        ok((await groupOf(subC.callsign) || []).length === 4, 'which now holds the project card plus three subs',
            JSON.stringify(await groupOf(subC.callsign)));
        await hub.post('/retire', { uid: subC.uid, summary: 'export mapping done', successor: false });
        await retirementLanded(subC.callsign);
        await settle();
        ok(JSON.stringify(await topLevel()) === JSON.stringify(before),
            'and a sub-worker RETIRING does not change it either', JSON.stringify(await topLevel()));

        // —— 5. A sub-worker wanting Chris pulls its GROUP up rather than jumping out of it. Both halves
        //       matter: it must not be missed, and it must not shove the column to say so.
        // "Need you:" on the spoken channel is what actually raises the flag (see the /say handler) --
        // /health does not carry it, and a rig that only *thinks* it set the flag would have skipped
        // this check while reporting green.
        await hub.post('/say', { from: subB.uid, text: 'Need you: pick between two rate formats.' });
        await page.waitForFunction((cs) => {
            const el = document.querySelector('#work .card[data-cs="' + cs + '"]');
            return !!el && el.className.includes('cneeds');
        }, B, { timeout: 15000 });
        ok(true, 'a sub-worker raised NEEDS YOU (the flag the priority sort acts on)');
        ok((await topLevel())[0] === PROJ, 'it floats its GROUP to the top of the column',
            JSON.stringify(await topLevel()));
        ok((await groupOf(B) || []).includes(PROJ), 'and it stays INSIDE that group rather than being hoisted out',
            JSON.stringify(await groupOf(B)));
        ok((await card(B).getAttribute('class') || '').includes('csub'),
            'still marked nested while it is the reason the group moved');

        // —— 6. The wrapper div must not break click delegation. #work.onclick walks up with closest(),
        //       so a card body click still has to open that session's chat -- this is the regression the
        //       new .cgroup layer could plausibly cause, on the control Chris uses most.
        await page.locator('#work .card[data-cs="' + A + '"] .cpurpose').first().click();
        await page.waitForTimeout(300);
        ok((await activeTabId()) === A, 'clicking a NESTED card body still opens that session chat', await activeTabId());

        // —— 7. DEFECT 1, the everyday case: the tab Chris opened survives its session retiring. Click it
        //       explicitly (that is what makes it sticky), then retire the session behind it for real.
        //
        //       WHICH HALF OF THE FIX THIS MEASURES, because it is not the obvious one: only two sessions
        //       are dead here, so the RAISED CACHE is what keeps the tab, and this passes even with the
        //       sticky retention torn out. Measured, not assumed -- a mutation probe on the retention
        //       failed at phase 8 and sailed through here. The two halves cover different regimes and
        //       phase 8 is the one that isolates the retention, so read them as a pair.
        await page.locator('#stabs .stab[data-tab="' + A + '"]').first().click();
        await page.waitForTimeout(300);
        ok((await activeTabId()) === A, 'the sub-worker tab is open', await activeTabId());
        ok(((await page.locator('#chat').textContent()) || '').includes(SUB_A_SAID), 'and its chat history is showing');
        await hub.post('/retire', { uid: subA.uid, summary: 'tender import done', successor: false });
        await retirementLanded(A);
        await settle();   // a full board poll AFTER the retirement lands -- renderTabs is what bounced him
        ok((await activeTabId()) === A, 'the open tab is STILL open after its session retired', await activeTabId());
        ok((await activeTabId()) !== 'all', 'it was not yanked back to ALL (the defect)');
        ok((await activeTabClass()).includes('dead'), 'it renders greyed, so the retirement is visible rather than silent',
            await activeTabClass());
        ok(((await page.locator('#chat').textContent()) || '').includes(SUB_A_SAID),
            'and it is still showing that session history -- a retired session, not a missing one');

        // —— 8. THE ACTUAL SCALE. 21 sessions retired here in one day, and the dead-tab cache used to
        //       hold FOUR. Fourteen more sessions retire, every one of them heard from more recently
        //       than subA, so ranking alone evicts subA past even the raised cap. Only the sticky
        //       retention can keep the tab Chris is reading, which is exactly the fix under test.
        const fillers = [];
        for (let i = 0; i < 14; i++) {
            const f = await hub.post('/register', { cwd: hub.REPO, purpose: 'filler job ' + i });
            await hub.post('/send', { from: f.uid, to: 'human', text: 'filler ' + i + ' reporting' });
            fillers.push(f);
        }
        for (const f of fillers) await hub.post('/retire', { uid: f.uid, summary: 'filler done', successor: false });
        await page.waitForFunction(() => document.querySelectorAll('#stabs .stab.dead').length >= 5, null, { timeout: 20000 });
        await settle();   // another full board poll, with subA now far down the ranking
        ok((await activeTabId()) === A, 'THE STICKY RETENTION, ISOLATED: 14 later retirements do not evict the tab he is reading',
            await activeTabId());
        ok((await page.locator('#stabs .stab[data-tab="' + A + '"]').count()) === 1,
            'and it appears exactly ONCE in the strip (no duplicate greyed twin)',
            String(await page.locator('#stabs .stab[data-tab="' + A + '"]').count()));

        // —— 9. Clicking away releases it: the retention follows what Chris is reading, it does not
        //       accumulate a graveyard of tabs he is done with.
        await page.locator('#stabs .stab[data-tab="all"]').first().click();
        await settle();
        ok((await activeTabId()) === 'all', 'clicking ALL moves him off it', await activeTabId());

        // —— 10. The project-key / bound-session bridge. WATERFALL is a bound project with no mission and
        //        not named jarvis -- the one shape the old jarvis hardcode plus mission aggregation left
        //        uncovered, so its tab rendered completely empty. Its coordinator posted under its own
        //        NATO callsign, and that is what has to surface here.
        ok((await page.locator('#stabs .stab[data-tab="' + PROJ + '"]').count()) === 1,
            'the bound project has its own tab');
        // A FRESH line from the coordinator. The console reads /transcript?limit=60, and the 14 filler
        // sessions above have long since pushed its opening message out of that window -- asserting on
        // the old one measured the transcript cap, not the bridge.
        await hub.post('/send', { from: co.uid, to: 'human', text: PROJ_SAID });
        await page.waitForTimeout(2000);   // the chat poll is 1.5s, independent of the board poll
        await page.locator('#stabs .stab[data-tab="' + PROJ + '"]').first().click();
        await page.waitForTimeout(400);
        ok((await activeTabId()) === PROJ, 'it opens', await activeTabId());
        const projChat = ((await page.locator('#chat').textContent()) || '').replace(/\s+/g, ' ');
        ok(projChat.includes(PROJ_SAID),
            'and it shows what the session bound to it said -- not an empty tab (the reported hole)',
            projChat.slice(0, 160));
        ok(projChat.toUpperCase().includes(CO.toUpperCase()),
            'attributed to the session that actually spoke', projChat.slice(0, 160));
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
