# Commit baton -- one serialized merge lane per repo

Punchlist #4: "serialize code work: many can research/plan, only 1 worker commits at a time; on
done = button-up branch + merge fresh master + hand baton to next. Board lock indicator +
waiting-fixes queue."

This is **P2 of [worktree isolation](WORKTREE-ISOLATION-DESIGN.md)**. Worktrees isolate the
filesystem so parallel workers stop clobbering each other; the baton decides how their branches
get back into the integration line -- one at a time, in order, with the queue visible.

## Problem

Isolation alone leaves the hard half open. Once N workers each hold a `jarvis/<cs>` branch, they
all want to merge into the same base (`NewBeta2`, `main`, ...). Left unmanaged that is: concurrent
`git merge` on one branch, half-merged states when two land seconds apart, and nobody knowing whose
turn it is. Today there is nothing -- no lock, no queue, no ordering -- because until worktrees
land, every worker shares one dirty tree and the collision happens even earlier.

## Invariant

**At most one holder per repo may merge/push to the integration branch at a time, and the holder is
always visible on the board.** Everything else (research, planning, editing inside your own
worktree, committing to your own branch) is unrestricted and parallel. The baton gates the *merge
lane only* -- it is not a global "one worker works at a time" lock.

## Design

### 1. State -- `batons.json` in `JARVIS_DATA`

One lane per repo key (`resolveRepo().key`), following the `missions.json`/`projects.json` pattern
(atomic write, `backupCorrupt` on parse failure, never a silent reset):

```json
{
  "tms": {
    "base": "NewBeta2",
    "holder": { "uid": "s_0341", "cs": "hotel", "branch": "jarvis/hotel",
                "takenAt": "2026-07-24T18:02:11.402Z", "note": "TMS-19966 fix" },
    "queue": [ { "uid": "s_0344", "cs": "kilo", "branch": "jarvis/kilo",
                 "since": "2026-07-24T18:04:50.114Z", "note": "attach-docs layout" } ],
    "lastHandoff": "2026-07-24T18:02:11.402Z"
  }
}
```

- `holder` is null when the lane is free. `queue` is FIFO -- fairness is the whole point; no
  priority field in P2 (add it only if a real case shows up).
- Keyed by repo, so jarvis-core and tms have independent lanes and never block each other.
- Survives a hub restart. On boot, revalidate: drop a holder/queue entry whose uid is `ended` or
  missing from the roster (see §4).

### 2. Endpoints

| Route | Body / query | Behavior |
| --- | --- | --- |
| `GET /baton` | `?repo=<key>` (omit = all lanes) | Lane state for the console + a worker's own check. |
| `POST /baton` | `{op:"request", uid, repo?, branch?, note?}` | Free lane -> becomes holder (`{granted:true}`). Busy -> appended to queue with its position (`{granted:false, position:N, holder:"hotel"}`). Idempotent: re-requesting while holding or queued returns current state, never a duplicate entry. |
| | `{op:"release", uid, repo?, merged?:bool, note?}` | Holder finished. Pops the queue, grants to the next uid, and notifies it (see §3). Non-holder release is a no-op `{ok:true,held:false}`. |
| | `{op:"cancel", uid, repo?}` | Drop out of the queue without ever holding (worker changed its mind / task dropped). |
| | `{op:"force", cs, repo?}` | Human override from the console: revoke the current holder and grant to `cs` (or free the lane). Announced on the bus -- never silent. |

`repo` defaults to `resolveRepo(session.cwd).key`, so a worker normally sends only
`{op, uid}`. Same body-parse path as every other route (`parseBodyLenient`), same
Origin/Host CSRF check as other mutating endpoints.

### 3. Notification -- the baton is an EVENT, not a poll

When the lane is granted, the hub pushes a `baton` event to the new holder's poll loop
(`busAppend({to: uid, kind:'baton', text:'baton granted: <repo> base <base>'})`). A queued worker
therefore does **not** spin on `GET /baton` -- it parks on its normal poll loop and gets woken, the
same way `speech`/`msg` already work. That keeps a waiting worker at zero token cost, which is the
existing design rule for idle sessions.

Add `baton` to the event-kind list in WORKER.md §2 with the merge recipe the holder runs:

```
git -C <worktree> fetch origin
git -C <worktree> merge origin/<base>     # fresh base FIRST, resolve conflicts here, in your own tree
<run the build/test gate>
git -C <repo.cwd> merge --no-ff jarvis/<cs>   # fast, already-conflict-free
POST /baton {"op":"release","uid":"<uid>","merged":true}
```

Conflict resolution happens in the holder's own worktree against a fresh base, so the integration
branch is only ever touched by an already-clean merge. That is the "button-up branch + merge fresh
master" half of the punchlist card.

### 4. Liveness -- a dead holder must never wedge the lane

Two guards, both reusing what exists:

1. **Retire releases.** `retireSession` calls `releaseBaton(uid)` before it spawns any successor:
   the holder's slot is freed and granted to the next in queue. A successor does NOT inherit the
   baton -- it re-requests, so an unfinished merge goes back into the fair queue rather than being
   handed to a session that has not read the handoff yet.
2. **Stale sweep.** A holder whose `aliveNow(uid)` is false for > `BATON_STALE_MS` (default 5 min,
   longer than the 2-min gone-quiet threshold so a long build turn is not punished) is revoked by
   the same sweep that already runs on the hub interval, with a `sys` record and a spoken line
   ("Merge lane reclaimed from hotel."). This is the [wedged-worker](../WORKER.md) failure mode
   that took primeng down on 2026-07-24 -- the lane must not depend on a worker being healthy.

### 5. Console -- lock indicator + waiting queue

- **Card badge** on the holder's card: a lock chip `BATON tms` (tooltip = base branch + how long
  held). Data comes from `/board` (add a `baton` field per card, mirroring how `parentProject` was
  surfaced in eca1395) so the console needs no extra fetch.
- **Waiting-fixes queue**: the queued callsigns render as a small ordered strip under the holder's
  card (`2 waiting: kilo, mike`), each with the note it requested with. This is the punchlist
  card's "waiting-fixes queue" -- it makes serialization legible instead of mysterious.
- **Human override**: click the lock chip -> confirm -> `POST /baton {op:"force"}`. Chris can always
  break a lane he thinks is stuck without touching a file.
- Voice: "who has the baton" / "release the baton" map onto `GET`/`force` in `handleUtterance`.

### 6. Pure helpers (unit-tested, no I/O)

Mirroring `focusHeldByLiveOther` + `test/focus.test.mjs`, put the decisions in `jarvis-text.mjs`:

- `batonRequest(lane, uid, cs, branch, note, now)` -> `{lane, granted, position}` (idempotent).
- `batonRelease(lane, uid, now)` -> `{lane, grantedTo|null}` (pops FIFO, no-op for a non-holder).
- `batonReap(lane, isAlive, now, staleMs)` -> `{lane, revoked|null}` (dead holder + dead queue
  entries swept in one pass).

The route handlers stay thin: load, call helper, save, push events. That keeps this out of the
risky server-modularization window -- the stateful surface is one small file plus three route arms.

## Non-goals (P2)

- No priority/preemption -- FIFO only.
- No auto-merge by the hub. The hub never runs `git merge` itself; it hands out turns and the
  worker does the work. Keeps the hub free of repo-mutating code paths.
- No cross-repo global lock. Lanes are per repo, always.
- No PR flow. PR-per-worker stays the alternative integration model (worktree spec §5a); a repo can
  choose either -- baton for fast internal iteration, PRs where review is wanted.

## Verify (headless, scratch port -- no live-hub restart)

Per the scratch recipe (`JARVIS_PORT=8199` + scratch `JARVIS_DATA` + `JARVIS_NO_UI=1`):

1. Unit-test the three pure helpers: grant on free lane, queue on busy, idempotent re-request,
   release grants next in FIFO order, release by a non-holder is a no-op, reap revokes a dead holder
   and preserves the queue.
2. Scratch-port HTTP: two fake sessions request the same lane -> first granted, second queued with
   `position:1`; first releases -> second receives a `baton` event on `/poll`.
3. Retire the holder -> lane grants to the queued worker and the retiring session's successor is
   NOT auto-granted.
4. `batons.json` corrupt -> backed up, lane rebuilt empty, hub still boots.

## Status / phasing

Design only. Implementation is a new store + three route arms + a `retireSession` hook, so it is
**restart-gated** and, like the worktree spec, is **not** in the parked pending tree.

- **P1 (worktrees)** must land first -- a baton without isolation still leaves everyone editing one
  dirty tree, so serializing the merge buys much less.
- **P2a** store + `/baton` routes + pure helpers + retire hook + `baton` poll event (server).
- **P2b** WORKER.md protocol section (request before merging, the merge recipe, release on done).
- **P2c** console lock chip + waiting strip + force override.
