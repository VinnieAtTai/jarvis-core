# Auto-bind a session to its repo's active project+mission on `/register`

Punchlist #39. Root-cause fix for the recurring "standalone card outside the mission"
fragmentation -- the scenario Chris called "the bug that keeps getting the hub confused."

## The bug, concretely

A session that starts in a repo which already owns an active project+mission, but registers
WITHOUT `project` or `parentProject` in its body, gets its own standalone NATO board column.
You then have two-plus cards for one mission and the hub cannot tell which is the brain:

- `primeng` -- the real project column (coordinator role, mission-linked).
- `bravo` / `uniform` / `sierra` -- de-facto primeng workers sitting OUTSIDE the primeng card.

Observed twice on 2026-07-23/24 in `d:\code\tms`: a fresh `bravo` (s_0315) booted as a
standalone card; after it was hand-bound into `project:primeng` and handed off to `juliet`, a
new stray `bravo` row appeared again. The fragmentation regenerates on its own.

### Why the existing fixes do not cover it

- **#25/#27 spawn-nesting** (stash `project`/`parentProject` per-callsign at `spawnWorker`, apply
  in `registerSession`, mirroring `pendingTier`): fixes workers the HUB spawns WITH an intended
  binding. It cannot help when there is nothing to stash -- e.g. the auto-successor of a
  *standalone* session (`retireSession` threads `s.parentProject`, which is `undefined` for a
  standalone), or a session a human starts by hand in the repo. Those still land unbound.
- Auto-bind is the complementary safety net: it infers the binding from the CWD at register
  time, so it catches every path spawn-stash misses.

The two compose: spawn-stash is the precise intent when the hub knows it; auto-bind is the
backstop from repo identity when it does not. Ship spawn-stash first if landing separately;
auto-bind is correct with or without it.

## The fix

In `registerSession(cwd, purpose, pin, project, parentProject)`, when BOTH `project` and
`parentProject` are absent, try to resolve the CWD to an owning project and auto-assign a role:

```
if (!proj && !pproj && cwd) {
    const owner = projectOwningCwd(cwd);            // active project whose repo == this cwd, with a mission
    if (owner) {
        if (!liveProjectManager(owner.name)) proj = owner.name;      // no live coordinator -> become it
        else pproj = owner.name;                                     // coordinator already live -> nest as sub-worker
    }
}
```

Everything downstream is unchanged: `proj` set routes through the existing coordinator path
(binds to the project column, claims the manager slot, rehydrates context); `pproj` set routes
through the existing sub-worker path (nested card, story-seeded, NOT the coordinator).

### `projectOwningCwd(cwd)` -- the one real design decision

Projects do not store a repo path today; the CWD of a project is INFERRED from its sessions
(`lastProjectCwd(sessions, name)`). So resolution is:

1. Normalize the incoming `cwd` (`cwdKey` -- already used for handoff keying; case-fold + trim
   trailing slash so `d:\code\tms` and `d:\code\tms\` match).
2. Find an ACTIVE project (`status === 'active'`) WITH a mission (`missionId`) whose
   `lastProjectCwd` normalizes to the same key.
3. Prefer the project whose most-recent session is newest if more than one repo matches (should
   be rare; log a `sys` line if it happens).

Gate on `missionId` deliberately: only mission-backed projects auto-capture sessions, so an
incidental repo that once hosted a plain worker never starts swallowing unrelated sessions.

Alternative considered: add an explicit `repo`/`cwd` field to the project row (set on first
bind, migrated on `rename`). Cleaner long-term and removes the inference, but it is a store
migration; the inference path ships with zero migration and can be hardened later. Recommend
inference now, explicit field as a follow-up if false matches ever show up.

### `liveProjectManager(name)`

`projectWorkerUid(name)` resolved to a session that `aliveNow(...)` -- reuse the exact liveness
test `routeToMission` uses to decide coordinator-vs-revive, so binding and routing never
disagree about whether a coordinator is live.

## Edge cases

- **Explicit flags always win.** Auto-bind only fires when both are absent; a caller that passes
  `project`/`parentProject` (or the #25/#27 stash) is untouched.
- **The `jarvis` project itself.** It has no `missionId`, so the mission gate means a jarvis-core
  worker in `d:\claude\jarvis-core` is never auto-captured -- it stays its own `jarvis` card, as
  today. (Confirm before ship: `jarvis` project row has `missionId: null`.)
- **Race: two sessions register before either is live.** First wins the coordinator slot
  (`liveProjectManager` false for both, but `setProjectManager` on the first makes the second see
  a manager); if they truly register in the same tick, the existing `pendingPins`/manager-slot
  logic already serializes. Worst case both briefly think coordinator -- self-heals on next
  heartbeat. Acceptable; note it.
- **Successor of a standalone in a mission repo** (the bravo case): its `spawnWorker` passes no
  project, register sees the tms repo owns active `primeng`+mission, binds it -- coordinator if
  none live, else nested. The stray card never forms.

## Verify (headless, scratch port -- no live-hub restart)

Per the scratch-port recipe (`JARVIS_PORT=8199` + a scratch `JARVIS_DATA` + `JARVIS_NO_UI=1`):

1. `node --check jarvis-core.mjs jarvis-text.mjs`
2. New unit tests for `projectOwningCwd` (match / no-mission / no-match / trailing-slash) as a
   pure helper in `jarvis-text.mjs`, mirroring `focusHeldByLiveOther` + `test/focus.test.mjs`.
3. Boot on 8199, seed an active mission-backed project with a known cwd, `POST /register` with
   that cwd and NO flags, assert the card binds to the project column (coordinator first, nested
   second) and NO standalone column appears.

## Status

Design only. Implementation is restart-gated AND touches `registerSession`, which the parked
pending tree (focus-steal guard) also edits -- so it lands cleanly only after that tree is
committed + deployed. Do not implement onto the dirty tree.
