// The commit baton over HTTP, against a real hub (docs/COMMIT-BATON-DESIGN.md, "Verify"). The pure
// decisions are pinned in test/baton.test.mjs; what only a real hub can show is the wiring around
// them -- the store on disk, the grant arriving as a POLL EVENT rather than something a worker spins
// on, the retire hook, and the sweep that fires when nobody is asking.
//
// Each case here is a way the merge lane WEDGES, which is the failure that matters: a lane nobody can
// enter blocks every merge in the repo while looking exactly like a lane that is legitimately busy.
//   1. two workers, one lane      -- and the waiter is WOKEN, not left polling /baton
//   2. the holder retires         -- and its SUCCESSOR does not inherit the turn
//   3. the holder dies quietly    -- the sweep reclaims it with nobody watching
//   4. batons.json is corrupt     -- backed up, never silently overwritten
//
// SKIPPED by default: it boots a real hub (and case 2 spawns a real ConPTY). Run it deliberately:
//
//     npm run test:baton
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchHub, assertConsolelessPossible, sleep } from '../test-support/scratch-hub.mjs';

const SKIP = process.env.JARVIS_INTEGRATION
    ? false
    : 'set JARVIS_INTEGRATION=1 to run (boots a real hub and one ConPTY; ~40 seconds)';

const REPO = 'probe';   // the lane key, passed explicitly so nothing here depends on repos.json
// Register a session the way a worker does. Direct, not spawned: these cases are about the lane, and
// a real ConPTY per participant would add a minute of boot to prove nothing extra.
const enlist = (hub, purpose) => hub.post('/register', { cwd: hub.REPO, purpose });
const laneOf = (hub) => hub.get('/baton?repo=' + REPO);
const holderOf = async (hub) => { const l = await laneOf(hub); return l.holder ? (l.holder.cs || l.holder.uid) : null; };
// What this uid has actually been TOLD, read off its poll cursor from the start of the bus. Polling as
// the worker is the only way to prove the grant is an event: reading the lane back would pass just as
// well if the hub never woke anybody.
const eventsOf = async (hub, uid) => (await hub.get('/poll?uid=' + uid + '&cursor=0')).events || [];
const sysLines = (hub, re) => hub.transcript().split('\n').filter(l => /"kind":"sys"/.test(l) && re.test(l));
// A spoken line is queued by the endpoint and recorded by the main loop's 250ms pump, so it lands
// shortly AFTER the response -- asserting on it inline is a race, not a check. Waiting is not a
// weakening: the claim is that the hub says it out loud at all, and the timeout still fails a silence.
const spoke = (hub, re) => hub.waitFor('the hub to speak ' + re, () => hub.spoke(re), 15000, 250);

test('BATON: one merge lane, FIFO, and the waiter is woken by an event',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('baton hub');

        const a = await enlist(hub, 'baton holder');
        const b = await enlist(hub, 'baton waiter');

        // ---- 1. the lane is exclusive ------------------------------------------------------------
        const first = await hub.post('/baton', { op: 'request', uid: a.uid, repo: REPO, note: 'first merge' });
        assert.equal(first.granted, true, 'a free lane refused the first request: ' + JSON.stringify(first));
        assert.equal(first.position, 0);

        const second = await hub.post('/baton', { op: 'request', uid: b.uid, repo: REPO, note: 'second merge' });
        assert.equal(second.granted, false, 'TWO workers hold the same merge lane: ' + JSON.stringify(second));
        assert.equal(second.position, 1, 'the waiter was not told where it stands');
        assert.equal(second.holder, a.callsign, 'the waiter was not told who holds the lane');

        // Idempotence over the wire: a worker that retries after a timeout must not queue twice.
        const retry = await hub.post('/baton', { op: 'request', uid: b.uid, repo: REPO });
        assert.equal(retry.position, 1, 'a retry moved the waiter: ' + JSON.stringify(retry));
        assert.equal(retry.already, true);
        assert.equal((await laneOf(hub)).waiting, 1, 'a retry duplicated the queue entry');

        // The store is on disk under JARVIS_DATA, keyed by repo, and survives being read back.
        const lane = await laneOf(hub);
        assert.equal(lane.holder.cs, a.callsign);
        assert.equal(lane.queue[0].cs, b.callsign);
        assert.equal(lane.queue[0].position, 1);
        assert.ok(readdirSync(hub.DATA).includes('batons.json'), 'the lane was never persisted');

        // ---- 2. the waiter is WOKEN, it does not poll /baton -------------------------------------
        // Before the release, b has been told nothing: a queued worker parks on its ordinary poll loop
        // at zero token cost. If this is non-empty the hub is chattering at waiters.
        assert.deepEqual((await eventsOf(hub, b.uid)).filter(e => e.kind === 'baton'), [],
            'a queued worker was woken before its turn');
        // ...and neither was a: it learned it holds the lane from the response, so an event there would
        // be a wasted turn.
        assert.deepEqual((await eventsOf(hub, a.uid)).filter(e => e.kind === 'baton'), [],
            'the synchronous grant also fired an event');

        const rel = await hub.post('/baton', { op: 'release', uid: a.uid, repo: REPO, merged: true });
        assert.equal(rel.held, true);
        assert.equal(rel.grantedTo, b.callsign, 'release did not hand the lane to the waiter');
        assert.equal(await holderOf(hub), b.callsign);
        assert.equal((await laneOf(hub)).waiting, 0);

        const woken = (await eventsOf(hub, b.uid)).filter(e => e.kind === 'baton');
        assert.equal(woken.length, 1, 'the new holder was never woken: ' + JSON.stringify(woken));
        assert.match(woken[0].text, /baton granted: probe/, 'the grant event does not name the lane');
        assert.match(woken[0].text, /op":"release/, 'the grant event does not carry the release recipe');
        assert.equal(sysLines(hub, /merge lane probe released by .* \(merged\)/).length, 1,
            'whether the merge LANDED was not recorded');

        // A release by someone who does not hold it is a no-op, not an eviction -- otherwise anyone
        // could take the lane off the holder by calling the wrong verb.
        const notHolder = await hub.post('/baton', { op: 'release', uid: a.uid, repo: REPO });
        assert.equal(notHolder.held, false);
        assert.equal(await holderOf(hub), b.callsign, 'a non-holder release evicted the holder');

        // ---- 3. cancel leaves the queue; the holder is refused it --------------------------------
        const c = await enlist(hub, 'baton quitter');
        await hub.post('/baton', { op: 'request', uid: c.uid, repo: REPO });
        assert.equal((await laneOf(hub)).waiting, 1);
        assert.equal((await hub.post('/baton', { op: 'cancel', uid: c.uid, repo: REPO })).dropped, true);
        assert.equal((await laneOf(hub)).waiting, 0, 'cancel left the entry in the queue');
        // Cancelling while holding would leave the lane shut by a worker that believes it let go.
        const byHolder = await hub.post('/baton', { op: 'cancel', uid: b.uid, repo: REPO });
        assert.match(String(byHolder.error || ''), /use op:release/, 'the holder was allowed to "cancel"');
        assert.equal(await holderOf(hub), b.callsign);

        // ---- 4. the human override, and it is never silent ---------------------------------------
        const forced = await hub.post('/baton', { op: 'force', repo: REPO, cs: c.callsign });
        assert.equal(forced.revoked, b.callsign, 'force did not revoke the incumbent');
        assert.equal(forced.grantedTo, c.callsign);
        assert.equal(await holderOf(hub), c.callsign);
        await spoke(hub, /Merge lane probe handed to/).catch(() => assert.fail('a forced handover was silent'));
        assert.equal((await eventsOf(hub, c.uid)).filter(e => e.kind === 'baton').length, 1,
            'the forced holder was not woken');

        // Lanes are PER REPO and never block each other -- the whole reason the store is keyed.
        const other = await hub.post('/baton', { op: 'request', uid: a.uid, repo: 'otherrepo' });
        assert.equal(other.granted, true, 'a second repo was blocked by the first lane');
        assert.equal(await holderOf(hub), c.callsign, 'requesting another lane disturbed this one');
    });

test('BATON: a retire hands the lane on, and the successor does NOT inherit it',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        // The rule this pins: an unfinished merge goes back into the FAIR QUEUE rather than to a
        // session that has not read the handoff yet. So a successor is deliberately spawned here --
        // without one, "the successor was not granted the lane" would pass for want of a successor.
        assertConsolelessPossible();
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('baton retire hub');

        const a = await enlist(hub, 'baton retiring holder');
        const b = await enlist(hub, 'baton patient waiter');
        assert.equal((await hub.post('/baton', { op: 'request', uid: a.uid, repo: REPO })).granted, true);
        assert.equal((await hub.post('/baton', { op: 'request', uid: b.uid, repo: REPO })).position, 1);

        const out = await hub.post('/retire', { uid: a.uid, summary: 'mid-merge', successor: true });
        assert.equal(out.ok, true);
        assert.equal(out.successor, true, 'no successor was spawned, so this proves nothing');

        assert.equal(await holderOf(hub), b.callsign, 'the lane did not pass to the waiter on retire');
        assert.equal(sysLines(hub, /merge lane probe released by .* on retire/).length, 1,
            'the retire release was not recorded');
        assert.equal((await eventsOf(hub, b.uid)).filter(e => e.kind === 'baton').length, 1,
            'the waiter was not woken when the holder retired');

        // Wait for the successor to actually come up, then check it is nowhere in the lane. It has to
        // re-request like anybody else.
        const succ = await hub.waitFor('a successor to register', async () => {
            const live = (await hub.get('/roster')).live.filter(r => r.callsign !== b.callsign && r.alive);
            return live.length ? live[0] : null;
        }, 90000);
        const lane = await laneOf(hub);
        assert.equal(lane.holder.uid, b.uid, 'the successor was handed the merge lane');
        assert.equal(lane.queue.length, 0, 'the successor was queued for a lane it never asked for');
        assert.notEqual(succ.uid, b.uid);

        // And the retiree is gone from the lane entirely -- including from the queue, which is the
        // other half of the hook (a worker can hold one lane while queued on another).
        const q = await enlist(hub, 'baton queue leaver');
        await hub.post('/baton', { op: 'request', uid: q.uid, repo: REPO });
        assert.equal((await laneOf(hub)).waiting, 1);
        await hub.post('/retire', { uid: q.uid, summary: 'left the queue', successor: false });
        assert.equal((await laneOf(hub)).waiting, 0, 'a retired worker kept its place in the merge queue');
        assert.equal(sysLines(hub, /left the probe merge queue on retire/).length, 1);
    });

// Two mechanisms reclaim a lane from a holder that died quietly, and they answer different questions:
// the TIMER means nobody has to ask, and reaping ON READ means a lane is never SERVED as busy when its
// holder is already gone. Testing them together proves only that one of them works -- which is how a
// redundant pair quietly becomes a single point of failure. So each gets its own hub and an observable
// the other cannot satisfy.
//
// JARVIS_BATON_STALE_MS shrinks the window the design calls a DEFAULT; waiting out five real minutes is
// how a sweep goes untested forever. The sweep PERIOD follows that window (clamped to a 5s floor),
// which is what makes the two cases separable: at 2.6s the timer provably has not fired yet.
const staleHub = async (t, label) => {
    const hub = await createScratchHub({ graceMs: 5000, env: { JARVIS_BATON_STALE_MS: '2000' } });
    t.after(() => hub.dispose());
    await hub.start(label);
    const dead = await enlist(hub, 'baton holder about to go quiet');
    const alive = await enlist(hub, 'baton waiter that keeps breathing');
    assert.equal((await hub.post('/baton', { op: 'request', uid: dead.uid, repo: REPO })).granted, true);
    assert.equal((await hub.post('/baton', { op: 'request', uid: alive.uid, repo: REPO })).position, 1);
    // `dead` never checks in again. `alive` keeps its heartbeat up, and that is the ONLY difference
    // between them -- if the sweep judged on anything other than having been SEEN, it would take both.
    const breathe = setInterval(() => { hub.get('/heartbeat?uid=' + alive.uid).catch(() => { }); }, 400);
    t.after(() => clearInterval(breathe));
    return { hub, dead, alive };
};

test('BATON: a dead holder is reclaimed with NOBODY ASKING (the timer)',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const { hub, dead, alive } = await staleHub(t, 'baton timer hub');
        assert.equal((await laneOf(hub)).staleMs, 2000, 'the override did not reach the hub');

        // From here on nothing asks about the lane until the assertion is already satisfied: the
        // transcript is the observable, so only the timer can produce it. A reap-on-read would prove
        // nothing here because no read happens.
        // 12s, and the bound is load-bearing: this hub's window is 2s so its sweep period is the 5s
        // floor, meaning at least two ticks fall inside. A period that ignored the window (the old
        // fixed 30s) could not land here at all -- which is the difference between "the timer fires"
        // and "the timer fires anywhere near when the window says it should".
        await hub.waitFor('the timer to reclaim the lane unprompted', () =>
            sysLines(hub, new RegExp('merge lane probe reclaimed from ' + dead.callsign)).length === 1, 12000);
        await spoke(hub, /Merge lane reclaimed from/).catch(() => assert.fail('the reclaim was silent -- silence there was the bug'));

        const lane = await laneOf(hub);
        assert.equal(lane.holder.cs, alive.callsign, 'the lane was freed but never handed on');
        assert.equal(lane.waiting, 0);
        assert.equal((await eventsOf(hub, alive.uid)).filter(e => e.kind === 'baton').length, 1,
            'the new holder was not woken by the sweep');
    });

test('BATON: a lane is never SERVED with a dead holder on it (reap on read)',
    { skip: SKIP, timeout: 180000 }, async (t) => {
        const { hub, dead, alive } = await staleHub(t, 'baton read hub');

        // Just past the 2s window and well inside the 5s sweep floor, so the timer cannot have fired.
        // The FIRST read after the holder goes stale must already show the lane reclaimed -- no
        // waitFor, because "eventually" is exactly what this half is not allowed to be.
        await sleep(2600);
        const lane = await laneOf(hub);
        assert.equal(lane.holder.cs, alive.callsign,
            'a lane was served with a dead holder still on it: ' + JSON.stringify(lane.holder));
        assert.equal(sysLines(hub, new RegExp('merge lane probe reclaimed from ' + dead.callsign)).length, 1,
            'the reclaim was not recorded');
        assert.equal((await eventsOf(hub, alive.uid)).filter(e => e.kind === 'baton').length, 1,
            'the new holder was not woken');
    });

test('BATON: a lane survives a restart -- kept by a survivor, taken off a corpse',
    { skip: SKIP, timeout: 300000 }, async (t) => {
        // The lane is persisted state, so a restart is the case where it can be wrong in BOTH
        // directions, and the two errors look nothing alike:
        //   rob a survivor  -> a worker mid-merge is told nothing and quietly loses its turn
        //   keep a corpse   -> the lane comes back up shut, with nobody alive to release it
        // Right after a restart every survivor's lastSeen is frozen at pre-restart, which is exactly
        // what makes the naive "unseen for 5 minutes" test wrong here -- hence the boot rule being
        // ended/missing ONLY, and hence this test.
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('baton restart hub 1');

        const a = await enlist(hub, 'baton restart survivor');
        const b = await enlist(hub, 'baton restart waiter');
        assert.equal((await hub.post('/baton', { op: 'request', uid: a.uid, repo: REPO })).granted, true);
        assert.equal((await hub.post('/baton', { op: 'request', uid: b.uid, repo: REPO })).position, 1);

        // Both keep breathing across the bounce, which is what a live worker's 30s ping does. The
        // request errors while the hub is down are the point of the catch, not an accident.
        const beat = (uid) => setInterval(() => { hub.get('/heartbeat?uid=' + uid).catch(() => { }); }, 400);
        let beatA = beat(a.uid);
        const beatB = beat(b.uid);
        t.after(() => { clearInterval(beatA); clearInterval(beatB); });

        // ---- 1. a survivor KEEPS the lane -------------------------------------------------------
        assert.ok(hub.killHubs() > 0, 'nothing was killed, so nothing restarted');
        await hub.waitHubDown();
        await hub.start('baton restart hub 2');
        await sleep(7000);   // past graceMs, so the LATE reconcile pass has judged everyone

        assert.equal(await holderOf(hub), a.callsign,
            'the restart robbed a surviving holder of the merge lane');
        assert.equal((await laneOf(hub)).waiting, 1, 'the restart dropped a surviving queue entry');

        // ---- 2. a holder that is not in the roster AT ALL loses it ------------------------------
        // This is the case boot revalidation uniquely covers. Every path that BURIES a session goes
        // through retireSession, which releases the lane on the way past -- so the interesting corpse
        // is not a buried session but a holder the roster has never heard of: a store left by an
        // earlier roster, a hand-edited file, a lane that outlived the sessions.json beside it.
        // Nothing else would ever clear it, and the lane would come back up shut forever.
        clearInterval(beatA);
        assert.ok(hub.killHubs() > 0);
        await hub.waitHubDown();
        // Written while the hub is DOWN so the periodic sweep cannot race the setup.
        writeFileSync(join(hub.DATA, 'batons.json'), JSON.stringify({
            [REPO]: {
                base: null,
                holder: { uid: 's_9999', cs: 'ghost', branch: 'jarvis/ghost', note: 'from a roster that is gone' },
                queue: [{ uid: b.uid, cs: b.callsign, branch: null, note: 'still here', since: null }],
                lastHandoff: null,
            },
        }));
        await hub.start('baton restart hub 3');

        // Read the TRANSCRIPT, not the lane: the claim is that the hub clears this at boot on its own.
        // Asking /baton would reap on access and pass even if the boot path did nothing at all.
        //
        // The 15s bound is the assertion, not just impatience. This hub sweeps on the default 30s
        // timer, so anything the timer would have caught cannot land inside this window -- only the
        // boot revalidation can. Loosen it past 30s and this test silently starts passing for the
        // timer's reasons instead.
        await hub.waitFor('the boot revalidation to clear a holder the roster never heard of', () =>
            hub.transcript().split('\n').some(l => /"kind":"sys"/.test(l)
                && /merge lane probe reclaimed from ghost/.test(l)), 15000);
        assert.equal(await holderOf(hub), b.callsign, 'the lane was not handed to the live waiter');
        assert.equal((await eventsOf(hub, b.uid)).filter(e => e.kind === 'baton').length, 1,
            'the new holder was never woken after the restart');
    });

test('BATON: a corrupt batons.json is preserved, never silently overwritten',
    { skip: SKIP, timeout: 120000 }, async (t) => {
        const hub = await createScratchHub({ graceMs: 5000 });
        t.after(() => hub.dispose());
        await hub.start('baton corrupt hub');

        const a = await enlist(hub, 'baton corrupt-store probe');
        assert.equal((await hub.post('/baton', { op: 'request', uid: a.uid, repo: REPO })).granted, true);

        // Truncated mid-write: unparseable.
        writeFileSync(join(hub.DATA, 'batons.json'), '{ "probe": { "holder": ');
        const after = await laneOf(hub);
        assert.equal(after.holder, null, 'the lane did not rebuild empty after a corrupt read');
        assert.ok(readdirSync(hub.DATA).some(f => /^batons\.json\.corrupt-/.test(f)),
            'the corrupt file was not backed up -- the only copy would have been overwritten');
        assert.equal(sysLines(hub, /CORRUPT batons\.json/).length, 1, 'the corruption was not recorded');

        // Valid JSON of the WRONG SHAPE is the same hazard: falling through to an empty store would let
        // the next save overwrite it. An array is not a lane map.
        writeFileSync(join(hub.DATA, 'batons.json'), '["probe"]');
        assert.equal((await laneOf(hub)).holder, null);
        assert.equal(readdirSync(hub.DATA).filter(f => /^batons\.json\.corrupt-/.test(f)).length, 2,
            'a wrong-shaped store was discarded without a backup');

        // And the lane still works afterwards -- a corrupt store costs the lane, not the feature.
        const again = await hub.post('/baton', { op: 'request', uid: a.uid, repo: REPO });
        assert.equal(again.granted, true, 'the lane never recovered: ' + JSON.stringify(again));
        assert.equal(await holderOf(hub), a.callsign);

        // The board carries the lane so the console needs no second fetch (the P2c data feed).
        const card = (await hub.get('/board')).boards.find(x => x.callsign === a.callsign);
        assert.ok(card, 'no board card for the holder');
        assert.equal(card.baton.repo, REPO, 'the holder card carries no baton: ' + JSON.stringify(card.baton));
        assert.equal(card.baton.holding, true);
    });
