# Worktree isolation for concurrent workers in one repo

Chris, 2026-07-24: "How do we make it so jarvis can work on multiple items in the same
repository so it doesn't f*** up with what I'm working on? ... something with worktrees."

Yes -- git worktrees. This spec makes each code-mutating sub-worker run in its own worktree +
branch so parallel workers never collide with each other OR with Chris's checkout.

## Problem

Every worker the hub spawns runs `claude` with `cwd: repo.cwd` (`spawnWorkerConsoleless`,
jarvis-core.mjs ~L1136). So two workers -- or a worker and Chris -- edit the SAME files in the
SAME working tree: uncommitted WIP clobbers, `git checkout`/branch churn fights, and a worker
can trample whatever Chris has open. There is no isolation today (zero worktree code in the hub).

## Invariant this buys us

**The hub NEVER launches a code-mutating worker in Chris's checkout.** Chris's working tree is
one worktree the hub does not own; every code worker gets a fresh, separate worktree. Workers
physically cannot touch his files. That is the whole point; everything below serves it.

## Design

### 1. Which workers isolate

- **Code-mutating sub-workers** (a `parentProject` worker whose task edits files): isolate.
- **Read-only / research workers**: may share `repo.cwd` read-only (no branch, no worktree) --
  cheap, and they never write. Gate: a spawn flag `isolate` (default true when the task is a
  build task in a git repo; false for research).
- **The coordinator**: does NOT edit code directly -- it delegates to isolated sub-workers
  (aligns with the manager-stays-thin rule). It can keep a normal read checkout. If a coordinator
  ever needs to commit, it takes a worktree too.
- **Non-git cwd** (`git -C cwd rev-parse` fails): fall back to shared cwd + log it. Isolation is
  best-effort, never a hard failure.

### 2. Create the worktree (at spawn, in `spawnWorker`)

Before launching the pty, for an isolating worker:

```
base   = git -C repo.cwd rev-parse --abbrev-ref HEAD      // branch Chris has checked out = integration line (e.g. NewBeta2)
branch = 'jarvis/' + cs                                    // one branch per callsign; unique
wtPath = join(WT_ROOT, repoKey + '-' + cs)                // e.g. d:\code\.jarvis-wt\tms-hotel
git -C repo.cwd worktree add -b <branch> <wtPath> <base>
```

- `WT_ROOT` is a sibling dir OUTSIDE any repo (so worktrees never show up in a repo's own
  `git status`), one level up from the repos, e.g. `d:\code\.jarvis-wt\`. Created on demand.
- Base = the repo's CURRENT branch at spawn time, captured once. Workers branch off the
  integration line, so merge-back is clean. Chris's UNCOMMITTED work is not in the base (worktrees
  fork from committed HEAD) -- exactly right: the worker neither sees nor clobbers his WIP.
- Launch the pty with `cwd: wtPath` instead of `repo.cwd`. Everything else (boot prompt, tier,
  perm settings) is unchanged.
- Persist on the roster session: `{ worktree: wtPath, branch, base }`, so retire + the console can
  find and clean it, and it survives a hub restart.

### 3. Tell the worker where it is

One line appended to the boot prompt when isolated: "You are in a DEDICATED git worktree on
branch `<branch>` (forked from `<base>`). Commit freely here; you cannot see or touch other
worktrees or Chris's checkout. Do NOT switch branches. On retire, commit everything -- your
branch is how your work merges back."

### 4. Retire cleanup (in `retireSession`)

The retire path already kills the pty + unlinks the spawn script; add worktree teardown:

1. If the worktree has uncommitted changes, **commit them to the branch** (WIP commit) -- never
   stash, never drop (per the tms-merge-dance rule: commit in-flight WIP). Nothing is ever lost.
2. `git -C repo.cwd worktree remove <wtPath> --force` (force tolerates leftover build artifacts).
3. **Keep the branch** -- it is the deliverable, awaiting merge (see Integration).
4. On hub boot, `git worktree prune` + sweep `WT_ROOT` for dirs with no live session (a restart
   orphans worktrees whose ptys died) -- remove the worktree but keep its branch.

### 5. Integration -- the one real decision

Worktrees isolate the *filesystem*; they do NOT decide how branches merge back. Isolating is easy;
integration is the work. Two models, and they compose:

- **(a) PR-per-worker** (GitHub flow): each worker pushes `jarvis/<cs>` and opens a PR; Chris or
  the coordinator reviews + merges. Best when work should be reviewed before landing.
- **(b) Commit-baton** (punchlist #4): a single serialized merge lane -- only one worker at a time
  merges its branch into the integration branch (a hub-held lock/token; on `done`, next in line
  gets the baton). Best for fast internal iteration without a PR per change.

Recommend: worktrees + **commit-baton** as the default internal loop (parallel work, serialized
merge), with PR-per-worker available for changes that want review. Worktrees make (b) safe --
without them, "one merges at a time" still leaves everyone editing one dirty tree.

Semantic conflicts (two workers editing the same code) still surface at merge -- worktrees do not
erase those; the baton/coordinator resolves them one at a time instead of live-clobbering.

## Edge cases

- **Windows:** `git worktree` is fully supported; keep names short (`<repoKey>-<cs>`) to dodge
  long-path limits. pty `cwd` = worktree path.
- **Disk:** each worktree is a full checkout. For a big repo (tms) that is real -- cap concurrent
  isolating workers (config, e.g. 4) and prune aggressively. `log()` when the cap defers a spawn.
- **jarvis-core itself:** a punchlist sub-worker gets its own worktree too, so it never collides
  with the LIVE hub's files (the hub runs from the main checkout) -- strictly safer than today.
- **Dirty base / detached HEAD:** if `rev-parse --abbrev-ref HEAD` is `HEAD` (detached), fall back
  to a named base (repo config) or the default branch; log it.
- **Branch already exists** (reborn callsign): suffix with a short counter or the uid tail.
- **Successor of an isolated worker:** inherits the SAME branch (continue the work), fresh
  worktree -- thread `branch`/`base` through the successor spawn like handoff notes already are.

## Verify (headless, scratch port -- no live-hub restart)

Per the scratch recipe (`JARVIS_PORT=8199` + scratch `JARVIS_DATA` + `JARVIS_NO_UI=1`):

1. Pure helpers in jarvis-text.mjs (worktree path + branch naming, base resolution) with unit
   tests, mirroring `focusHeldByLiveOther` + `test/focus.test.mjs`.
2. In a throwaway git repo: spawn an isolating worker, assert a worktree dir + `jarvis/<cs>`
   branch exist and the pty cwd is the worktree; make a change, retire, assert WIP was committed to
   the branch, the worktree was removed, and the branch survived.
3. Assert a read-only/research spawn takes NO worktree (shares cwd).

## Status / phasing

**P1 SHIPPED 2026-07-27.** Pure helpers (`worktreeRoot`, `worktreeBase`, `worktreePlan`,
`shouldIsolate`, `orphanWorktrees`) in jarvis-text.mjs with test/worktree.test.mjs; git calls +
spawn/retire/boot-sweep wiring in jarvis-core.mjs. Isolation is best-effort — any git failure falls
back to the shared cwd — and `JARVIS_WORKTREES=0` turns it off entirely. Two additions the design
did not spell out: a retire-kept branch collides with its own recycled callsign (suffixed), and a
successor CONTINUES its predecessor's branch rather than forking from base. P2/P3 still open.

The rest of this section is the original plan. Implementation is a `spawnWorker` + `retireSession` + roster-shape change, so it is
restart-gated -- but it is NOT in the parked pending tree (that touches `registerSession`/`readBody`/
console), so it lands cleanly on its own. Suggested phasing:

- **P1** worktree create-on-spawn + cwd swap + roster fields + retire teardown (the isolation win).
- **P2** commit-baton merge lane (punchlist #4) on top.
- **P3** console: show a worker's branch/worktree on its card; a "merge" affordance.

Composes with [auto-bind on register](AUTO-BIND-ON-REGISTER.md): auto-bind gets sessions onto the
right project; worktree isolation keeps their file work from colliding once they are there.
