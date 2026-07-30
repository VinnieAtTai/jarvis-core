// Real-browser verification of BOARD READABILITY: headline on the card, detail behind a click.
//
//     node test-support/verify-headline-browser.mjs        (or: npm run verify:headline)
//
// WHY THIS EXISTS. test/headline.test.mjs pins the splitter and the HTML builder by lifting them out
// of console.js, and it pins that the four render sites call them. What it structurally CANNOT see is
// the half that decides whether Chris is actually better off:
//   - that the caret REACHES the DOM on a real card, and that clicking it opens anything at all. The
//     mission rail is the sharp case: it has its OWN click handler (missionEl.onclick) which knew
//     only about phase toggles, so a caret rendered there would have been visible, inviting and inert
//     -- a defect that looks like working software in every screenshot.
//   - that expanding survives the 1.5s board poll, which re-renders the whole board from scratch.
//   - that the long card is actually SHORTER on screen, which is the entire ask.
//
// It also pins the hard constraint that came with the job: NO MIGRATION. The card text on /board must
// come back byte-identical to what the session posted. Chris watches this board live and card churn
// jumps his view, so a "readability" change that quietly rewrote his cards would be a worse bug than
// the one it fixed. That is asserted against the API, not the DOM, because that is where it is real.
//
// WHY NOT IN test/. `node --test` collects EVERY .mjs under test/, and this needs a system Chrome that
// not every machine has -- in the gate that is a flake, here it is a clean exit 2. Same reasoning,
// same home, as verify-coordchip-browser.mjs next door.
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

// Three cards in the shapes that actually exist on the board today.
//  SEPARATED  -- the house separator, what sessions are asked to write from now on.
//  RUNON      -- no separator at all, which is the MAJORITY of what is on the board right now and the
//                whole reason the renderer had to adapt rather than the cards being migrated.
//  SHORT      -- already readable; it must come out completely untouched, caret and all.
const SEPARATED = 'FEATURE: Board cards show a headline only -- split card text on the first space-dash-dash-space separator; the pure splitter lives in jarvis-text.mjs at line 139 and is mirrored in console.js, sha 59bf780.';
const SEP_HEAD = 'Board cards show a headline only';
const SEP_TAIL = 'space-dash-dash-space separator';
const RUNON = 'BUG: audited the queued lane against the code and found five shipped cards still sitting in queued, which means the board has been lying about what is actually left to build tonight';
const RUNON_TAIL = 'left to build tonight';
const SHORT = 'NOTE: merge lane is clear';
// The doing-line: one of the two worst offenders in Chris's screenshot, on the rail especially,
// because that row is a single nowrap flex line sharing its width with the callsign, the COORD chip,
// the lane chip and the activity glyph -- so even a short line got chopped mid-word by CSS with no
// way to read the rest.
//
// MEASURED, and it caught a bad fixture here: the hub CAPS doing at 80 characters on ingest
// (jarvis-core.mjs:3988, `s.doing = String(b.doing || '').slice(0, 80)`). The first version of this
// fixture was 118 chars, so its tail was cut off SERVER-SIDE and never reached the browser at all --
// which read exactly like the rail's caret being wired to nothing. Keep this under 80 or the test is
// asserting against text the console was never sent.
const LONG_DOING = 'working: merging zulu wedge -- gate 516/516 green, 8 probes, then whiskey';
const DOING_HEAD = 'working: merging zulu wedge';
const DOING_TAIL = 'then whiskey';

const hub = await createScratchHub();
try {
    await hub.start('headline hub');
    console.log('hub up on ' + hub.origin);

    // 'primeng' rather than 'jarvis': a fresh scratch data dir seeds the PrimeNG mission with the
    // primeng project bound to it, and the rail only renders rows for cards that resolve to a live
    // mission. Registering onto an unseeded project leaves #mission empty and the rail half of this
    // file has nothing to assert against. Same seeding verify-coordchip-browser.mjs relies on.
    const co = await hub.post('/register', { cwd: hub.REPO, purpose: 'primeng coordinator', project: 'primeng' });
    const sub = await hub.post('/register', { cwd: hub.REPO, purpose: 'board readability', parentProject: 'primeng' });
    const SUB_CS = String(sub.callsign || '');
    await hub.post('/health', { uid: sub.uid, context: 30, doing: LONG_DOING });
    await hub.post('/health', { uid: co.uid, context: 20, doing: 'coordinating' });
    for (const text of [SEPARATED, RUNON, SHORT]) await hub.post('/worklist', { op: 'add', callsign: SUB_CS, text });
    // Working, so the card renders its lanes expanded rather than collapsed behind "show N tasks".
    await hub.post('/worklist', { op: 'start', callsign: SUB_CS, text: SEP_HEAD });

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

    // Every helper ANSWERS for a missing element instead of throwing. Each selector below is something
    // a regression can delete, and a bare textContent() on a deleted node aborts the run at the first
    // casualty -- reporting one FAIL where a dozen assertions were still waiting to speak.
    const CARD = '.card[data-cs="' + SUB_CS + '"] ';
    const bodyText = () => page.evaluate(() => document.body.innerText);
    const count = (sel) => page.locator(sel).count();
    const txt = async (sel) => {
        const l = page.locator(sel).first();
        return (await l.count()) ? ((await l.textContent()) || '') : '';
    };
    // The row whose visible text starts with a given headline, as the board renders it.
    const rowFor = (head) => page.locator(CARD + '.witem').filter({ hasText: head }).first();

    try {
        await page.goto(hub.origin, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(CARD + '.witem', { timeout: 15000 });
        await page.waitForFunction((c) => document.querySelectorAll(c + '.witem').length >= 3, CARD, { timeout: 15000 });
        await page.waitForTimeout(600);   // let a poll or two settle, so a LATE throw is caught too

        // 1. The console still loads. renderBoards runs on every 1.5s poll, so a throw in the row
        //    renderer takes the whole board AND the poll chain down -- the one way this breaks all of it.
        ok(pageErrors.length === 0, 'console.js loads with no uncaught page error', pageErrors.join(' | '));
        ok((await count(CARD)) === 1, 'the sub-worker card renders');

        // 2. THE ASK: the long cards are SHORTER on screen than what was stored.
        let page1 = await bodyText();
        ok(!page1.includes(SEP_TAIL), 'a separated card shows only its headline -- the detail is not on the board', SEP_TAIL);
        ok(page1.includes(SEP_HEAD), 'and the headline it shows is the first clause', SEP_HEAD);
        ok(!page1.includes(RUNON_TAIL), 'a card with NO separator is truncated too (this is most of the board)', RUNON_TAIL);
        ok(page1.includes('audited the queued lane'), 'and it still leads with its own opening words');

        // 3. An already-readable card is left completely alone -- no caret, nothing to click. A caret
        //    there would be an affordance that opens onto a copy of the line above it.
        const shortRow = rowFor('merge lane is clear');
        ok((await shortRow.count()) === 1, 'the short card renders');
        ok((await shortRow.locator('.hlmore').count()) === 0, 'a short card gets NO caret');
        ok((await count(CARD + '.witem .hlmore')) === 2, 'exactly the two long TASK rows carry one',
            String(await count(CARD + '.witem .hlmore')));
        // Scoped to .witem deliberately: the card's own doing-line is a separate wired surface and
        // carries its own caret, so a card-wide count is 3 and says nothing about which surface is
        // which. Assert that one on its own rather than folding it into the row count.
        ok((await count(CARD + '.bdoing .hlmore')) === 1, 'and the card doing-line carries its own',
            String(await count(CARD + '.bdoing .hlmore')));
        ok(!(await txt(CARD + '.bdoing')).includes(DOING_TAIL), 'with its paragraph collapsed away', DOING_TAIL);

        // 4. THE PROMISE: clicking the caret reveals the detail. This is the check that cannot be
        //    faked in node -- it needs a real listener on a real element.
        const sepRow = rowFor(SEP_HEAD);
        await sepRow.locator('.hlmore').click();
        await page.waitForTimeout(300);
        ok((await bodyText()).includes(SEP_TAIL), 'clicking the caret opens the detail', SEP_TAIL);
        ok((await count(CARD + '.hldetail')) === 1, 'exactly one detail block opened -- the carets are keyed per row',
            String(await count(CARD + '.hldetail')));
        ok((await txt(CARD + '.hldetail')).includes(SEP_HEAD),
            'and it shows the FULL stored string, headline included, not just the tail');

        // 5. It survives the board poll. renderBoards rebuilds this card from scratch every 1.5s, so
        //    expander state living anywhere but boardExpand would blink shut while Chris was reading.
        await page.waitForTimeout(2200);
        ok((await bodyText()).includes(SEP_TAIL), 'the detail stays open across a board poll (state is not lost on re-render)');
        ok(pageErrors.length === 0, 'and the re-render threw nothing', pageErrors.join(' | '));

        // 6. Clicking again closes it, and the detail leaves the DOM rather than merely hiding.
        await rowFor(SEP_HEAD).locator('.hlmore').click();
        await page.waitForTimeout(300);
        ok(!(await bodyText()).includes(SEP_TAIL), 'clicking again collapses it');
        ok((await count(CARD + '.hldetail')) === 0, 'and the paragraph leaves the DOM, not just the view');

        // 7. The un-separated card expands to the WHOLE text. It has no "detail" to show, so a
        //    renderer that showed only the part after a separator would open onto nothing here -- and
        //    this is the shape most of today's cards have.
        await rowFor('audited the queued lane').locator('.hlmore').click();
        await page.waitForTimeout(300);
        ok((await bodyText()).includes(RUNON_TAIL), 'an unseparated card expands to its full text', RUNON_TAIL);
        await rowFor('audited the queued lane').locator('.hlmore').click();
        await page.waitForTimeout(300);

        // 8. The category chip still works, and the headline is the PROSE -- not "FEATURE:" plus a
        //    clause. Splitting before stripping the tag would eat the chip's own words.
        ok((await count(CARD + '.tchip')) >= 2, 'category chips still render on the rows', String(await count(CARD + '.tchip')));
        ok(!(await txt(CARD + '.wtext')).includes('FEATURE:'), 'the tag is a chip, not part of the headline');

        // 9. THE RAIL. Its doing-line was the worst offender in the screenshot, and it is served by a
        //    DIFFERENT click handler than the board -- the one that only knew about phase toggles.
        await page.waitForSelector('#mission .mworker', { timeout: 15000 });
        const railRow = page.locator('#mission .mworker').filter({ hasText: SUB_CS.toUpperCase() }).first();
        ok((await railRow.count()) === 1, 'the sub-worker has a rail row');
        const railTextBefore = await txt('#mission');
        ok(railTextBefore.includes(DOING_HEAD), 'the rail shows the doing-line headline', DOING_HEAD);
        ok(!railTextBefore.includes(DOING_TAIL), 'and NOT the paragraph behind it', DOING_TAIL);
        ok((await page.locator('#mission .hlmore').count()) >= 1, 'the rail row carries a caret');

        // 10. ...and that caret is not inert. A rail caret that renders but does nothing on click is
        //     the exact failure this project keeps shipping: visible, inviting, dead.
        await page.locator('#mission .hlmore').first().click();
        await page.waitForTimeout(300);
        ok((await txt('#mission')).includes(DOING_TAIL), 'clicking the RAIL caret opens its detail (its handler is wired)', DOING_TAIL);
        await page.waitForTimeout(2000);
        ok((await txt('#mission')).includes(DOING_TAIL), 'and the rail keeps it open across a poll too');
        await page.locator('#mission .hlmore').first().click();
        await page.waitForTimeout(300);
        ok(!(await txt('#mission')).includes(DOING_TAIL), 'and it closes again');

        // 11. The rail's phase toggles still work. The new data-x branch runs BEFORE the phase branch
        //     in the same handler, so a selector that matched too much would silently eat every phase
        //     click -- breaking a working feature to add a new one.
        const phase = page.locator('#mission .mphase').first();
        if (await phase.count()) {
            const wasDone = (await phase.getAttribute('class') || '').includes('done');
            await phase.click();
            await page.waitForTimeout(700);
            const nowDone = (await page.locator('#mission .mphase').first().getAttribute('class') || '').includes('done');
            ok(wasDone !== nowDone, 'mission phase toggles still work (the new expander branch did not eat their clicks)');
        } else {
            notes.push('no mission phases seeded -- phase-toggle regression check skipped');
        }

        // 12. THE HARD CONSTRAINT: no migration. What the session posted is what the hub still stores.
        //     This is the one Chris would feel immediately, because he is reading this board live.
        const board = await hub.get('/board');
        const mine = (board.boards || []).find(b => b.callsign === SUB_CS) || {};
        const stored = [...(mine.working || []), ...(mine.queued || []), ...(mine.done || []), ...(mine.review || [])]
            .map(t => (t && typeof t === 'object') ? t.text : t);
        ok(stored.includes(SEPARATED), 'the separated card text is stored byte-identical -- nothing was rewritten');
        ok(stored.includes(RUNON), 'and so is the un-separated one (NO MIGRATION -- the renderer adapted, the cards did not)');
        ok(stored.includes(SHORT), 'and the short one');

        // 13. THE CARET IS BIG ENOUGH TO HIT, AND COST NOTHING TO MAKE SO. Measured, because a CSS
        //     padding change has no unit test that can honestly fail -- assert the rendered geometry
        //     or admit there is no pin at all. Before the fix the carets were 12.6x18 on the rail and
        //     a task row and 12.6x14 on the doing-line (177 sq px, the smallest interactive target on
        //     the card -- the copy chip is 315 and the speaker button 349). Reverting the padding pair
        //     in console.css puts them back under 300 and fails the first check here.
        //
        //     The second check is the one that matters more. The enlargement is only free if the glyph
        //     does not move: padding grows the hit box, the equal negative margin hands the space back
        //     to layout. If someone later drops the margin and keeps the padding, the carets stay
        //     comfortable and every row silently grows -- which is why the footprint is pinned too, and
        //     pinned against the ROW, not against a remembered number that would rot.
        const caretGeom = await page.evaluate((c) => {
            const one = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const r = el.getBoundingClientRect(), st = getComputedStyle(el);
                const n = (v) => parseFloat(v) || 0;
                return {
                    area: r.width * r.height,
                    // margin box -- what actually occupies space in the row
                    mw: r.width + n(st.marginLeft) + n(st.marginRight),
                    mh: r.height + n(st.marginTop) + n(st.marginBottom),
                };
            };
            // A row that HAS a caret, and a row that does not, as the layout-shift control. Measuring
            // the caret against its own row cannot work: the caret is a flex item, so a taller caret
            // makes its row taller and the comparison passes no matter what. The caret-less short card
            // is the only honest reference on the page.
            const rowsWith = [...document.querySelectorAll(c + '.witem')].filter(r => r.querySelector('.hlmore'));
            const rowsWithout = [...document.querySelectorAll(c + '.witem')].filter(r => !r.querySelector('.hlmore'));
            const h = (el) => el ? el.getBoundingClientRect().height : 0;
            return {
                rail: one('#mission .hlmore'),
                row: one(c + '.witem .hlmore'),
                doing: one(c + '.bdoing .hlmore'),
                // the SHORTEST row that carries a caret, so a legitimately wrapped row cannot mask a shift
                withCaretH: rowsWith.length ? Math.min(...rowsWith.map(h)) : 0,
                withoutCaretH: rowsWithout.length ? Math.min(...rowsWithout.map(h)) : 0,
            };
        }, CARD);
        for (const [where, g] of Object.entries({ rail: caretGeom.rail, 'task row': caretGeom.row, 'doing-line': caretGeom.doing })) {
            ok(g && g.area >= 300, 'the ' + where + ' caret is a comfortable click target',
                g ? Math.round(g.area) + ' sq px, want >= 300' : 'caret not found');
        }
        // A row carrying a caret must be exactly as tall as one that carries none. Written this way
        // after the first version SURVIVED its mutant: it compared the caret to its own row, and since
        // the caret is a flex item its row grows with it, so the check could not fail. Dropping the
        // negative margin and keeping the padding now fails here -- which is the whole point, because
        // that mutant leaves the carets comfortable and silently inflates every row on the board.
        ok(caretGeom.withCaretH > 0 && caretGeom.withoutCaretH > 0
            && Math.abs(caretGeom.withCaretH - caretGeom.withoutCaretH) <= 0.5,
            'and it costs the row no height -- a row with a caret is as tall as one without',
            'with ' + caretGeom.withCaretH.toFixed(1) + 'px vs without ' + caretGeom.withoutCaretH.toFixed(1) + 'px');

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
