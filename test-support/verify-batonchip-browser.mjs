// Real-browser verification of the MERGE LANE chips + waiting strip, end to end: a scratch hub serving
// the real console.html/js/css, a lane the hub actually granted, driven in a real Chrome, asserting what
// lands in the DOM.
//
//     node test-support/verify-batonchip-browser.mjs        (or: npm run verify:batonchip)
//
// WHY THIS EXISTS. console.js is browser script, so `node --test` can only reach the pure helpers lifted
// out by name (test/batonchip.test.mjs covers batonRole/batonLabel/batonQueue/batonTip that way).
// Everything that makes this a FEATURE lives in the part the gate cannot see: that a chip reaches the
// card at all, that it reaches the PROJECT card when the coordinator is the holder, that the waiting
// strip lists the queue in service order, that a repo key cannot break out of a title="" attribute, and
// that the 1.5s board poll does not blow any of it away.
//
// AND IT SEEDS THE LANE ITSELF. The live lane is free almost all the time, and a chip verified only in
// the free state is a chip verified in the one state that renders nothing -- so this drives the real
// POST /baton to grant a lane and queue two workers behind it.
//
// WHY NOT IN test/. `node --test` collects EVERY .mjs under test/, and this needs a system Chrome that
// not every machine has -- in the gate that is a flake, here it is a clean exit 2. Same reasoning, same
// home, as verify-coordchip-browser.mjs and verify-searchbox-browser.mjs next door.
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

// The lane key, passed explicitly on every request so nothing here depends on repos.json resolving the
// scratch repo dir to anything in particular.
const REPO = 'probe';
// The rail's hierarchy arrow, as an escape rather than a literal: this file is read as UTF-8 but the
// repo's line endings and encodings are mixed, and a mangled literal would fail as a missing arrow and
// send the next session hunting in console.js for a bug that is really in this test.
const ARROW = String.fromCharCode(0x21B3);

const hub = await createScratchHub();
try {
    await hub.start('baton-chip hub');
    console.log('hub up on ' + hub.origin);

    // The real shape: a project card carrying the mission, two sub-workers nested under it. The
    // COORDINATOR takes the lane, because that is both the commonest holder (it lands every sub-worker's
    // branch) and the case a naive chip gets wrong -- it renders on the PROJECT card, and there is no
    // card under the coordinator's own callsign at all.
    const co = await hub.post('/register', { cwd: hub.REPO, purpose: 'primeng coordinator', project: 'primeng' });
    const subA = await hub.post('/register', { cwd: hub.REPO, purpose: 'p-fileUpload API migration', parentProject: 'primeng' });
    const subB = await hub.post('/register', { cwd: hub.REPO, purpose: 'dialog visual QA', parentProject: 'primeng' });
    const CO_CS = String(co.callsign || '').toUpperCase();
    const A_CS = String(subA.callsign || '').toUpperCase(), B_CS = String(subB.callsign || '').toUpperCase();
    // Long doing-lines on purpose. The narrow-window checks below are only meaningful if the row
    // ACTUALLY squeezes at Chris's width, and a short "working: dialogs" fits at 800px -- which made the
    // whole geometry section pass vacuously the first time this rig ran.
    const LONG_DOING = 'working: p-fileUpload API migration, then the dialog visual QA sweep across both histories';
    await hub.post('/health', { uid: co.uid, context: 40, doing: 'landing every sub-worker branch behind the gate' });
    await hub.post('/health', { uid: subA.uid, context: 20, doing: LONG_DOING });
    await hub.post('/health', { uid: subB.uid, context: 20, doing: LONG_DOING });

    // Grant the lane for real, through the endpoint a worker uses. FIFO order is asserted from the
    // responses first, so the DOM checks below are comparing against a lane the hub agrees with.
    const g0 = await hub.post('/baton', { op: 'request', uid: co.uid, repo: REPO, note: 'landing subworker branches' });
    const g1 = await hub.post('/baton', { op: 'request', uid: subA.uid, repo: REPO, note: 'fileUpload branch' });
    const g2 = await hub.post('/baton', { op: 'request', uid: subB.uid, repo: REPO, note: 'dialog branch' });
    ok(g0.granted === true, 'the coordinator was granted the lane', JSON.stringify(g0));
    ok(g1.granted === false && g1.position === 1, 'first sub-worker queued at 1', JSON.stringify(g1));
    ok(g2.granted === false && g2.position === 2, 'second sub-worker queued at 2', JSON.stringify(g2));

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

    // Helpers that ANSWER FOR A MISSING ELEMENT ('' / null / 0) instead of throwing. Every selector here
    // is something a regression can delete, and a bare page.textContent() on a deleted element aborts
    // the whole run at the first casualty -- a broken build should tell Chris everything that broke.
    const count = (sel) => page.locator(sel).count();
    const txt = async (sel) => {
        const l = page.locator(sel).first();
        return (await l.count()) ? (((await l.textContent()) || '').replace(/\s+/g, ' ').trim()) : '';
    };
    const attr = async (sel, name) => {
        const l = page.locator(sel).first();
        return (await l.count()) ? ((await l.getAttribute(name)) || '') : '';
    };
    const cssOf = async (sel, prop) => {
        const l = page.locator(sel).first();
        return (await l.count()) ? l.evaluate((el, p) => getComputedStyle(el)[p], prop) : null;
    };
    const card = (cs) => '.card[data-cs="' + cs.toLowerCase() + '"]';
    // Wait for a DOM condition WITHOUT letting a timeout abort the run. Same reasoning as the
    // answer-for-a-missing-element helpers above, and it was a mutation probe that made the case: deleting
    // the card chip left a later waitForFunction to time out and throw, so the rig died with no summary
    // line at all instead of reporting the five checks that were ready to fail. A broken build has to tell
    // Chris everything that broke.
    const settle = async (fn, arg, label, timeoutMs = 10000) => {
        try { await page.waitForFunction(fn, arg, { timeout: timeoutMs }); return true; }
        catch { notes.push('timed out waiting for ' + label + ' (checks below report what that cost)'); return false; }
    };

    try {
        await page.goto(hub.origin, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.card', { timeout: 15000 });
        await page.waitForSelector('.batonchip', { timeout: 15000 });
        await page.waitForTimeout(600);   // let a poll or two settle, so a LATE throw is caught too

        // 1. The console still loads. renderBoards runs on every 1.5s poll, so a throw in the chip
        //    renderer takes the whole board (and the poll chain) down -- the one way this breaks
        //    everything else on his screen.
        ok(pageErrors.length === 0, 'console.js loads with no uncaught page error', pageErrors.join(' | '));

        // 2. THE CASE A NAIVE CHIP GETS WRONG. batonFor is keyed on the CARD's uid and a project card's
        //    uid is its bound session, so the coordinator's lane renders on the PROJECT card. There is no
        //    card under its own callsign to put it on -- which is exactly why a chip written for plain
        //    session cards would go blank at the commonest holder there is.
        ok((await count(card('primeng') + ' .batonchip.holder')) === 1,
            'the holder chip lands on the PRIMENG PROJECT card (the coordinator case)', String(await count('.batonchip.holder')));
        ok((await count(card(CO_CS))) === 0,
            'and there is no card under the coordinator\'s own callsign at all -- so a session-card-only chip would show NOTHING', CO_CS);
        ok((await txt(card('primeng') + ' .batonchip')) === 'LANE', 'it reads LANE', await txt(card('primeng') + ' .batonchip'));
        // Counted PER SURFACE, not page-wide. The chip renders on the board card AND on the rail row by
        // design, so a page-wide "=== 1" is simply wrong -- it fails on a working build and would have to
        // be loosened to a range, at which point it stops catching a duplicated chip on either surface.
        // One per surface is the claim worth making, and it is the stricter one.
        ok((await count('.card .batonchip.holder')) === 1, 'exactly ONE holder chip across the board cards', String(await count('.card .batonchip.holder')));
        ok((await count('#mission .batonchip.holder')) === 1, 'and exactly ONE on the rail', String(await count('#mission .batonchip.holder')));

        // 3. The waiters. Each says where IT stands, which is the question a queued worker's card has to
        //    answer on its own -- Chris should not have to read the holder's tooltip to place it.
        ok((await count('.card .batonchip.waiter')) === 2, 'both queued sessions carry a waiter chip on their cards', String(await count('.card .batonchip.waiter')));
        ok((await txt(card(A_CS) + ' .batonchip.waiter')) === 'LANE #1', A_CS + ' reads LANE #1', await txt(card(A_CS) + ' .batonchip.waiter'));
        ok((await txt(card(B_CS) + ' .batonchip.waiter')) === 'LANE #2', B_CS + ' reads LANE #2', await txt(card(B_CS) + ' .batonchip.waiter'));
        ok((await count(card(A_CS) + ' .batonchip.holder')) === 0, 'and a waiter is never chipped as the holder');

        // 4. The waiting strip: who is BLOCKED, in the order they will be served. On the holder's card
        //    only -- it is the holder's queue.
        const strip = await txt(card('primeng') + ' .blane');
        ok(/lane queue:/.test(strip), 'the holder card carries a waiting strip', strip);
        ok(strip.indexOf(A_CS) > 0 && strip.indexOf(A_CS) < strip.indexOf(B_CS),
            'listing the queue in SERVICE order, not sorted', strip);
        ok((await count(card(A_CS) + ' .blane')) === 0 && (await count(card(B_CS) + ' .blane')) === 0,
            'and no waiter card carries a strip of its own');
        ok((await count('.blane')) === 1, 'exactly one strip on the page', String(await count('.blane')));

        // 5. The tooltips answer, in words, what the two-character chips cannot.
        const htip = await attr(card('primeng') + ' .batonchip', 'title');
        ok(/^HOLDS THE MERGE LANE for probe/.test(htip), 'the holder tooltip names the repo', htip);
        // The base is a GIT READ against the holder's cwd (laneBase), and the scratch repo dir is not a
        // git repo -- so this rig legitimately has no base to show. Assert whichever case is true rather
        // than skipping: "no base stamped -> the clause vanishes entirely" is itself a property worth
        // pinning, because the alternative is Chris reading "base undefined" in a tooltip.
        ok(g0.base ? htip.includes('base ' + g0.base) : !/base/.test(htip),
            g0.base ? 'and the base it will merge into' : 'and with no base resolvable, the base clause vanishes rather than printing undefined', htip);
        ok(htip.includes(A_CS) && htip.includes(B_CS), 'and everyone blocked behind it', htip);
        const wtip = await attr(card(B_CS) + ' .batonchip', 'title');
        ok(/position 2 of 2/.test(wtip), 'the waiter tooltip says where it stands', wtip);
        ok(wtip.includes(CO_CS), 'and names who it is waiting on -- the whole question', wtip);

        // 6. The MISSION RAIL, which is the panel Chris actually keeps pinned. A lane visible only on the
        //    cards is still invisible at the moment two sub-workers under one mission both claim to be
        //    ready to land.
        ok((await count('#mission .mworker.coord .batonchip.holder')) === 1,
            'the rail\'s coordinator row carries the holder chip too');
        ok((await count('#mission .mworker.sub .batonchip.waiter')) === 2, 'and both sub rows carry their waiter chips',
            String(await count('#mission .mworker.sub .batonchip.waiter')));
        ok((await count('#mission .blane')) === 0, 'the rail carries NO waiting strip (one squeezed flex line; the queue is in the tooltip)');
        const railRow = await txt('#mission .mworker.coord');
        ok(railRow.includes('COORD') && railRow.includes('LANE'),
            'so a rail row says both what it IS and what it HOLDS', railRow);
        ok((await txt('#mission .mworker.sub')).includes(ARROW), 'and the sub rows keep their hierarchy arrow', await txt('#mission .mworker.sub'));

        // 7. Chris's rail is a NARROW pinned panel (#right is 2/5 of the window) and the row is a flex
        //    line, so a half-rendered chip ("LANE" with the "#2" squeezed off) would be a WRONG answer to
        //    "who holds the lane". These checks assert that OUTCOME.
        //
        //    Be clear about what holds it up, because it is not this feature's CSS: the doing-line's
        //    pre-existing overflow:hidden gives it a flex minimum of zero, so it absorbs all the pressure
        //    and the chip is never squeezed. Mutation probes confirmed that at 1280/800/600px -- which is
        //    why a `flex:none` rule written on a guess was deleted rather than kept. So these are a guard
        //    on the ROW's layout contract (delete that overflow:hidden and they fail), not proof of a rule
        //    of mine. Worth keeping for exactly that reason.
        const geoAt = async (w) => {
            await page.setViewportSize({ width: w, height: 900 });
            await page.waitForTimeout(250);
            const l = page.locator('#mission .mworker.sub').first();
            if (!(await l.count())) return { missing: 'no sub row' };
            return l.evaluate(el => {
                const box = (n) => n ? +n.getBoundingClientRect().width.toFixed(1) : null;
                const right = (n) => n ? +n.getBoundingClientRect().right.toFixed(1) : null;
                const chip = el.querySelector('.batonchip'), last = el.lastElementChild;
                return {
                    chipW: box(chip), chipRight: right(chip), chipText: chip ? chip.textContent : null,
                    rowRight: right(el), rowOverflow: el.scrollWidth - el.clientWidth,
                    doingW: last ? last.clientWidth : null,
                    doingClipped: last ? last.scrollWidth > last.clientWidth : null,
                };
            });
        };
        // Three widths, and the third is the one that matters. The doing-line carries overflow:hidden, so
        // its automatic minimum size is ZERO and it absorbs every pixel of pressure on its own -- at 800px
        // the chip is never squeezed at all, which two mutation probes proved by showing that removing
        // BOTH candidate CSS rules changed nothing there. 600px is where the doing-line is exhausted and
        // the chip itself starts being asked to give up width; Chris's rail is 2/5 of the window, so a
        // 1024-wide window puts him around there for real.
        const wide = await geoAt(1280), narrow = await geoAt(800), tight = await geoAt(600);
        // Non-vacuity, measured as a SHRINK rather than as clipped-vs-unclipped. Whether a given doing-line
        // happens to fit at 1280px depends on the font the machine has, so "clips only when narrowed" is a
        // machine-dependent claim; "the doing-line gave up width when the window did" is not, and it is the
        // same guarantee -- if the row were not under pressure, the checks below would prove nothing.
        ok(narrow.doingClipped && narrow.doingW < wide.doingW,
            'narrowing the window really does squeeze the row (so the checks below are not vacuous)', JSON.stringify({ wide, narrow }));
        ok(narrow.chipW === wide.chipW, 'the lane chip keeps its full width when the rail is narrow', JSON.stringify({ wide, narrow }));
        ok(narrow.chipText === wide.chipText, 'and its whole face, "#2" included', JSON.stringify({ wide, narrow }));
        ok(narrow.chipRight <= narrow.rowRight, 'the chip stays inside its row', JSON.stringify(narrow));
        ok(narrow.rowOverflow <= 0, 'and the row does not overflow horizontally -- the doing-line ellipsises instead', JSON.stringify(narrow));
        // At the TIGHT width the doing-line has nothing left to give, so this is the check that actually
        // tests the chip's own floor rather than the doing-line's willingness to vanish.
        ok(tight.doingW < narrow.doingW, 'at 600px the doing-line has given up still more width (so the next two are not vacuous either)',
            JSON.stringify({ narrow, tight }));
        ok(tight.chipW === wide.chipW, 'and the chip STILL holds its full width, "#2" and all', JSON.stringify({ wide, tight }));
        ok(tight.rowOverflow <= 0, 'with the row still not overflowing', JSON.stringify(tight));
        await page.setViewportSize({ width: 1280, height: 900 });

        // 8. It survives the 1.5s board poll, which rebuilds innerHTML wholesale.
        await page.waitForTimeout(3500);
        ok((await count('.card .batonchip.holder')) === 1 && (await count('.card .batonchip.waiter')) === 2
            && (await count('#mission .batonchip')) === 3,
            'every chip survives the 1.5s board re-render, on both surfaces',
            (await count('.card .batonchip')) + ' card, ' + (await count('#mission .batonchip')) + ' rail');
        ok((await count('.blane')) === 1, 'so does the waiting strip');

        // 9. A repo key comes from repos.json and a queue name from a worker's own /baton body, so both
        //    are operator-supplied text landing in a title="" attribute. The hub is not the attacker
        //    here -- the point is that the console's own escaping is ASSERTED rather than assumed, so the
        //    response is intercepted to inject the hostile shape directly.
        const HOSTILE = 'a "quoted" <img src=x onerror="window.__XSS=1"> repo';
        await page.route('**/board', async (route) => {
            const resp = await route.fetch();
            const body = await resp.json();
            for (const b of body.boards || []) if (b.baton) { b.baton.repo = HOSTILE; if (b.baton.queue) b.baton.queue = [HOSTILE]; }
            await route.fulfill({ response: resp, body: JSON.stringify(body), headers: { ...resp.headers(), 'content-type': 'application/json' } });
        });
        // Wait on the POLL, not on the tooltip: waiting for the hostile text to appear would be waiting
        // for the very thing a broken build fails to do, so a missing-escape regression would abort here
        // instead of failing the checks below.
        await page.waitForTimeout(3300);
        ok(await page.evaluate(() => window.__XSS === undefined), 'a hostile repo key does not execute');
        ok((await attr(card('primeng') + ' .batonchip', 'title')).includes(HOSTILE),
            'and survives as literal text in the attribute', await attr(card('primeng') + ' .batonchip', 'title'));
        ok((await count('.card img')) === 0, 'no element was injected into a card');
        ok((await txt(card('primeng') + ' .blane')).includes('<IMG SRC=X'), 'a hostile queue NAME renders as text in the strip too',
            await txt(card('primeng') + ' .blane'));
        await page.unroute('**/board');
        await page.waitForTimeout(3300);

        // 10. RELEASE. The chip must be as honest about a free lane as about a held one: nothing claims to
        //     be merging when nothing is, and the lane moves ON to the next in line rather than vanishing.
        await hub.post('/baton', { op: 'release', uid: co.uid, repo: REPO, merged: true });
        await settle((cs) => !!document.querySelector('.card[data-cs="' + cs + '"] .batonchip.holder'),
            A_CS.toLowerCase(), 'the lane to move to ' + A_CS);
        ok((await count(card(A_CS) + ' .batonchip.holder')) === 1, 'releasing hands the chip to the next in line', A_CS);
        ok((await count(card('primeng') + ' .batonchip')) === 0, 'and the old holder\'s card is left with no chip at all');
        ok((await txt(card(B_CS) + ' .batonchip.waiter')) === 'LANE #1', 'the remaining waiter moves up to #1', await txt(card(B_CS) + ' .batonchip.waiter'));

        // 11. Lane fully free -> NOTHING anywhere. The state the live hub is in most of the time, and the
        //     one a chip must not invent something to say about.
        await hub.post('/baton', { op: 'release', uid: subA.uid, repo: REPO, merged: true });
        await hub.post('/baton', { op: 'release', uid: subB.uid, repo: REPO, merged: true });
        await settle(() => document.querySelectorAll('.batonchip').length === 0, null, 'every chip to clear');
        ok((await count('.batonchip')) === 0, 'with the lane free, NOTHING on the page claims a merge lane');
        ok((await count('.blane')) === 0, 'and no waiting strip is left behind');
        ok((await count('#mission .mworker')) === 3, 'while the rail rows themselves are untouched', String(await count('#mission .mworker')));

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
