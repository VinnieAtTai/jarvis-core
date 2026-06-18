# JARVIS architecture

A one-page map of the hub: what talks to what, which files own which state, the HTTP
surface, and how a worker session lives and dies. Source of truth is `jarvis-core.mjs`
(single-file Node HTTP server, no framework) plus the static console (`console.html/js/css`).

## Topology

```
   Chris (voice) ──speech──▶ STT front-end ──POST /hear──▶┐
        ▲                                                 │
        │ TTS reads say.txt ◀──enqueueSay()──┐            ▼
        │                                    │   ┌──────────────────────┐
   Browser console ◀── GET /board (1.5s) ────┼───│  HUB  jarvis-core.mjs │
        │   (chat, board, schedule, perms)   │   │  :8124  sole writer   │
        └── POST /send /say /focus /worklist ─┘   │  of all state files   │
                                                  └───────────┬──────────┘
                              spawnWorker (console-less ConPTY; wt tab fallback)
                       routeTo() → bus.jsonl ─────────────────┤
                                                              ▼
                 Worker sessions (Claude Code CLIs): register, GET /poll (long-poll
                 inbox) + GET /heartbeat (liveness), POST /worklist /send /say /retire.
                 Each is a normal session with a NATO callsign; a *project worker*
                 also carries .project and binds to that project's durable card.
```

The hub never runs model inference itself — it is a router + state store + board. The
"intelligence" is the attached Claude Code sessions (workers) and the human.

## State files — the hub is the ONLY writer

All live under `DATA` (`%LOCALAPPDATA%\jarvis`, override with `JARVIS_DATA`; falls back to
the repo dir). Workers and the console touch them only through HTTP. Never hand-edit while
the hub is up.

| File | Holds | Written by |
|------|-------|-----------|
| `sessions.json` | roster: uids, callsigns, cwd, purpose, tier, ctx/doing, handoffs | `saveRoster()` (debounced) |
| `worklist.json` | the board, v3: `{focus, sessions:{<callsign>:{working,queued,review,done}}}` | `saveWork()` |
| `schedule.json` | `{date, events[] (meetings), announced{}, reminders[]}` | `saveSchedule()` |
| `bus.jsonl` | per-recipient event bus; `/poll` reads from here (`bus.base` = dropped-prefix count) | `busAppend()` |
| `transcript.jsonl` | append-only human-facing event log; the hub-driver monitor tails it | `record()` |
| `say.txt` | latest spoken line for the TTS layer to read out | `enqueueSay()` / say queue |
| `commands.txt` | control channel for the voice front-end | hub |
| `repos.json` | known repos (cwd, key, model, tier, permissionMode) for `/spawn` | `POST /repos` |
| `archive/<uid>.json` | full record of a retired session (summary, notes, final board) | `retireSession()` |

## HTTP surface (`:8124`)

Grouped by purpose; all JSON unless noted.

- **Lifecycle:** `POST /register`, `GET /poll` (long-poll inbox), `GET /heartbeat`
  (liveness only), `POST /health` (ctx% + doing), `POST /retire`, `POST/GET /handoff`,
  `POST /describe`, `GET /protocol` (the worker manual).
- **Comms:** `POST /send` (silent text), `POST /say` (TTS headline), `POST /react`,
  `POST /hear` (inbound utterance → `handleUtterance`).
- **Board:** `GET /worklist`, `GET /board` (console poll), `POST /worklist` (add/start/
  done/drop/move/clear-done), `GET /roster`, `GET /archive`.
- **Sessions:** `POST /spawn` (launch a worker — console-less ConPTY by default), `POST /focus`,
  `POST /forget`, `GET/POST /hold` + `POST /unhold` (park/resume), `POST /voicemute`,
  `POST /attach`.
- **Calendar:** `GET/POST /schedule` (meetings), `POST /remind` (reminders), surfaced via
  the 15s scheduler tick + the NEXT banner.
- **Permissions:** `POST /permission` (worker asks), `POST /permission-answer[-all]`
  (human decides) — the perm-hook classifier tags risk.
- **Control / misc:** `POST /mute`, `POST /pause`, `POST /restart` (Rebuild),
  `POST /winddown` (end-of-day: ask all workers to checkpoint+retire, then stop),
  `GET /screen`, `POST /open`, `POST /reveal`, `GET /tokens`, `GET /att`,
  `GET/POST /notify` (+ `/notify-test`) for ntfy push, `POST /voices`, `POST /repos`.

## Session lifecycle

1. **Spawn** — `POST /spawn` (or the console rocket) runs `spawnWorker()`, which launches the
   Claude Code CLI with a boot prompt telling it to GET `/protocol` and register with a
   pre-assigned NATO callsign (`pin`). By default the worker runs **console-less**: an invisible
   ConPTY (`node-pty`) the hub owns, so there is no terminal window for a console combine/close to
   tear down (set `JARVIS_CONSOLELESS=0` to fall back to a Windows Terminal tab). A console-less
   worker is a child of the hub and dies with it — acceptable because the hub is itself
   console-less + crash-surviving (see Resilience). Manual "open a terminal and start Claude"
   works too.
2. **Register** — `POST /register {cwd, purpose, pin?, project?}` → `{uid, callsign}`. A uid
   (`s_NNNN`) is the identity on every later call; the callsign is how the human refers to it
   by voice. If a predecessor on the same cwd/callsign left a handoff, it rides back on the
   register response (and `GET /handoff`).
3. **Run** — the worker keeps two perpetual loops: `GET /poll` (its inbox; long-polls, wakes
   only on real events, relaunch with the returned cursor) and `GET /heartbeat` (every 30s,
   keeps `lastSeen` fresh through long turns). It reports `POST /health {context, doing}` and
   keeps its board column current via `POST /worklist`.
4. **Handoff** — at ~85% context (or post-compaction) it `POST /handoff {notes}` (idempotent,
   latest wins) then retires with a successor.
5. **Retire** — `POST /retire {summary, notes, successor?}`. The session is archived. If the
   board still has open tasks, the hub spawns a **successor** on the same job and hands it the
   summary + notes + unfinished board — work continues with no human re-brief.

**Project workers.** A *project* (e.g. `jarvis`) is a durable board card that hosts ONE live
worker. The worker registers with `project:jarvis`; `projectWorkerUid()` resolves the project
to its live uid. It keeps its own NATO callsign (for the perm-hook + the `JARVIS · XRAY · %`
label) but binds its board + routing to the project card and gets no separate card. On retire
the card persists and the successor re-attaches.

## Routing

`handleUtterance()` parses an inbound utterance: explicit address (`"<callsign>, …"` /
`"on <callsign> …"`), then commands (focus, schedule, reminders, spawn, retire, board ops,
mute/pause, easter eggs), else it falls to the focused session. `routeTo(cs, msg)` resolves
`liveUidOf(cs) || projectWorkerUid(cs)` and drops a `speech` event on that uid's bus (debounced
so rapid sentences batch). Speech with no live target (incl. `focus=jarvis` when no project
worker is up) stays unrouted for the hub driver / solo brain.

## Permissions & safety

Worker actions are gated: read-only + routine build commands (git status/diff/log, ls/cat/grep,
node --check, npm/dotnet build·test·lint) auto-run; risky ones (rm/del, git push/reset/commit,
npm install, killing processes, writing outside cwd) raise a `POST /permission` that the human
answers from the console. A perm-hook classifier tags each request's risk class. Trusted
sessions auto-approve their non-risky actions.

## Deploy ritual

`npm start` boots the hub (`node jarvis-core.mjs`); wait for `JARVIS CORE READY`. Code changes
to `jarvis-core.mjs` / console assets take effect only on restart: `POST /restart` (the console
**Rebuild** button) relaunches the hub with the latest code — live sessions ride it out (their
poll/heartbeat loops retry through the gap). The in-memory token gauge resets on restart.

In production the hub runs under a supervisor that relaunches it on a hard exit:
`spawn-hub-detached.mjs` (a console-less, detached supervisor — preferred) or the older
`start-jarvis-watchdog.cmd` loop. Both log to `%LOCALAPPDATA%\jarvis\watchdog.log`.

## Resilience

The hub is a personal always-on copilot, so uptime is a feature, not a nicety:

- **Console-less.** The hub (and, by default, every worker) runs with no console window.
  Combining or closing a Windows console fires `CTRL_CLOSE`/`SIGHUP` across every process
  attached to it; with no console there is nothing to tear down. `spawn-hub-detached.mjs`
  launches the hub detached for exactly this reason.
- **Survives soft faults.** `uncaughtException` / `unhandledRejection` are logged to
  `crash.log` and swallowed — the realistic offenders (a closed Playwright page, a malformed
  request body, an fs race) don't corrupt on-disk state, so staying up beats dying. The
  watchdog still catches genuine hard exits.
- **Ignores interrupt signals.** `SIGINT` / `SIGBREAK` / `SIGHUP` are ignored so a stray
  Ctrl+C or a reaped parent shell can't kill it. Intentional shutdown goes through WIND DOWN
  (a `STOP` sentinel) or the `commands.txt` stop path.
- **Degrades to headless.** If the console/mic launch fails (locked chrome profile, missing
  Chrome, a Playwright fault) the hub logs it and runs headless rather than taking the HTTP
  server — and every worker's poll loop — down with it.
