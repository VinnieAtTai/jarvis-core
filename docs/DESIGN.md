# Multi-session hub: design spec

Status: IMPLEMENTED 2026-06-11 (drafted 2026-06-10). The spec below is the design of record;
see "Decisions made at implementation" at the bottom for how the open questions were settled.
Goal: jarvis-core grows from a single-brain voice loop into a hub that tracks and routes
between multiple concurrent Claude Code (or other) sessions, addressable by voice.

## Concepts

- **Hub**: the existing harness (`jarvis-core.mjs`). Owns the mic, the speakers, the console
  board, all files, and the HTTP server on 8124. The only writer of shared state.
- **Session**: any brain that registers with the hub: a Claude Code instance in some repo,
  a script, whatever. Sessions never touch the jarvis folder directly; they talk HTTP to
  `localhost:8124`.
- **Callsign**: NATO phonetic word (alpha, bravo, ... xray, zulu) assigned by the hub at
  registration. The voice handle. Chosen because the NATO alphabet is engineered to survive
  a noisy channel: Chrome speech-rec nails these words where repo names fail.
- **UID**: `s_NNNN`, minted per registration. The identity. A callsign points at its latest
  UID; older incarnations remain as read-only history.

## Roster — `sessions.json` (hub-owned)

```json
{
  "callsigns": {
    "xray": ["s_0042", "s_0017"]
  },
  "sessions": {
    "s_0042": { "callsign": "xray", "cwd": "d:\\trading", "purpose": "signal backtest",
                "started": "...", "ended": null, "lastSeen": "..." },
    "s_0017": { "callsign": "xray", "cwd": "d:\\claude\\postman", "purpose": "haulpay extraction",
                "started": "...", "ended": "...", "summary": "Extracted 14 endpoints, collection pushed." }
  }
}
```

- Per-callsign list is newest-first; "on xray" always resolves to the head.
- Callsign assignment: least-recently-retired free callsign (not alphabetical), so a retired
  handle sits cold as long as possible before reuse. When a callsign is reborn the hub
  announces it aloud ("xray is now the postman extraction work").
- Manual pin: "jarvis, call this one whiskey" overrides assignment for long-lived sessions.
- Presence: the session's long-poll IS the heartbeat (`lastSeen`). No separate ping. Board
  greys a session that has not polled in ~2 minutes.

## Worklist — `worklist.json` v2

```json
{
  "focus": "xray",
  "sessions": {
    "jarvis": { "working": [], "queued": [], "done": [] },
    "xray":   { "working": ["backtest"], "queued": [], "done": [] }
  }
}
```

- Keys are callsigns (live incarnation only). `jarvis` is the hub's own board: unrouted
  tasks land there; "give the backtest task to xray" is a cross-board move using the same
  substring matching as today's task commands.
- Optional later: `owner` per task if tasks ever need finer attribution than the column.
- Single-writer rule: with multiple sessions, all worklist edits go through the hub
  (HTTP), which serializes them. Direct file edit remains a legacy path for the solo case.

## Message bus — `bus.jsonl` (append-only)

One event per line: `{ts, from, to, kind, text}`. Voice input is just another message with
`from: "human"`, `to` resolved by the routing grammar. Replies are `from: "<uid>"`.
Messages to a dead or busy session sit in the log until its next poll; nothing is lost,
the hub says so aloud ("xray hasn't checked in for four minutes, I'll queue it").

## HTTP endpoints (extend the existing 8124 server)

| Endpoint | Who calls | Does |
|---|---|---|
| `POST /register {cwd, purpose, pin?}` | session | mint UID, assign callsign, return both |
| `GET /poll?uid=&cursor=` | session | long-poll its inbox slice of the bus; doubles as heartbeat |
| `POST /send {from, to, text}` | session | append to bus |
| `POST /say {from, text}` | session | enqueue speech (replaces clobber-prone say.txt overwrite) |
| `POST /worklist {op, callsign, text}` | session | serialized task ops |
| `POST /retire {uid, summary}` | session/hub | end-of-life (see Retirement) |
| `GET /roster` | anyone | callsigns, purposes, presence |

## Voice grammar (additions to the existing command set)

| Say | Does |
|---|---|
| `focus on <callsign>` | set sticky focus; spoken ack includes purpose ("focused on xray, trading") |
| `on <callsign>, <utterance>` | route one utterance, focus unchanged |
| `jarvis, <utterance>` | always the hub, regardless of focus |
| `jarvis, who's running` / `who's <callsign>` | read the roster |
| `add task <x> for <callsign>` | board op with explicit target |
| `give the <x> task to <callsign>` | cross-board move |
| `call this one <callsign>` | pin a callsign |
| `retire <callsign>` | retirement flow |
| `what did the old <callsign> do` | read previous incarnation's summary; "the one before that" walks deeper |

- Routing default: plain speech goes to the focused session. Scoped commands ("clear done",
  "read my list") default to the focused board; "read everyone's list" is the global form.
- Parser safety: `^on (alpha|bravo|...)\b` matches only currently registered callsigns, so
  "on second thought" can't misroute.
- Single live session = auto-focus.

## Speech-out etiquette

Hub speech queue (fed by `POST /say`). The focused session speaks unprefixed; any other
session gets a speaker prefix ("xray says: backtest finished"). Keeps the audio channel
from becoming a party line.

## Retirement

On `retire <callsign>` or clean shutdown:
1. Guard: if WORKING is non-empty, push back aloud ("echo still has two tasks working,
   retire anyway?").
2. Hub asks the session for a one-line summary as its final act; stored on the UID record.
   This is what makes old incarnations useful later.
3. Live board column archived to `archive/<uid>.json`, removed from the console.
4. UID marked ended; callsign freed (LRU pool).

Nothing is deleted: live worklist = dashboard, sessions ledger + archive = journal.

## Worker-session protocol (for the session-side CLAUDE.md)

1. `POST /register` with cwd + one-line purpose; remember the returned uid + callsign.
2. Arm one background long-poll against `/poll`; restart it each time it returns. The
   returning poll is the wake-up (same role tail -f plays today).
3. Reply via `POST /send` (to the human/hub) or `POST /say` (speak it); move your own tasks
   via `POST /worklist`.
4. On wrap-up, `POST /retire` with a one-line summary.

## Session spawning ("jarvis, start a session in trading")

The hub can launch sessions itself; the loop closes when the spawned session registers
and the hub announces its callsign.

- **`repos.json`**: speakable workspace name → `{cwd, defaultPurpose}`. Paths cannot be
  dictated by voice, so spawn targets must be pre-registered. Unknown name = spoken
  pushback. Sessions can add entries ("jarvis, register this folder as postman").
- **Spawn shape**: visible terminal, not headless: `wt -d <cwd> claude "<bootstrap>"`.
  Interactive mode is required: the long-poll wake-loop is what keeps a session alive
  indefinitely; headless `claude -p` is one-shot and dies after the first turn. A visible
  window also lets the human glance at it or type if needed.
- **Bootstrap prompt**: minimal, defers to the protocol doc: "You're a jarvis worker.
  Read WORKER.md (or GET /protocol), register with purpose '<as spoken>', greet via /say,
  await instructions."
- **Grammar**: "jarvis, start a session in <repo> [for <purpose>]".
- **Teardown**: after `POST /retire` the worker ends its turn; terminal stays open for
  inspection (or the hub could close it, reviewer's call).

## Conversation view (console UI; independent of the hub, could ship first)

Replace the raw transcript pane with a chat view. Source is `transcript.jsonl` filtered to
`speech` + `tts` events; everything else stays out of the conversation (task ops are already
visible on the board; `sys` events render as small centered divider lines, e.g. "meeting
mode on").

```
                                  ┌──────────────────────────────┐
                                  │ on xray, send a summary       │
                                  │ comment                  9:14 │
                                  └──────────────────────────────┘
  ┌──────────────────────────────┐
  │ xray says: summary posted    │
  │ to the ticket           9:15 │
  └──────────────────────────────┘
                                  ┌──────────────────────────────┐
                                  │ focus on echo            9:16 │
                                  └──────────────────────────────┘
            ── meeting mode on ──
```

- **Alignment**: human right, brain left. Distinct bubble colors (human accent, brain
  neutral), max-width ~70%, small timestamp in the corner. No avatars, no names needed in
  solo mode.
- **Window**: last 10 messages, pinned to bottom, auto-scroll on new events. Scrolling up
  pauses auto-scroll and shows a "jump to latest" chip.
- **Expand**: one toggle (click or `t` key) switches 10-message view <-> full scrollback
  (reads the whole transcript.jsonl). Default stays collapsed; no paging UI, just scroll.
- **Grouping**: consecutive same-speaker events within ~5s merge into one bubble (say.txt
  multi-line writes arrive as separate tts events; they read as one thought).
- **Raw mode**: keep the old raw transcript behind a debug toggle (`r` key) for protocol
  debugging; chat view is the default.
- **Hub-aware later**: when multi-session lands, left bubbles get a callsign chip with a
  per-callsign accent color; the focused session renders unchipped, matching the speech
  etiquette rule (focused speaks unprefixed).

## Open questions for review

- Bare "`<callsign>`" as a focus switch (no "focus on" prefix): convenient or too trigger-happy?
- Confirm-back on routing within N minutes of a callsign's rebirth: worth it, or is the
  rebirth announcement enough?
- Permission posture for spawned sessions: an unattended worker will eventually hit a
  permission prompt, and voice cannot answer it. Per-repo allowlists in
  `.claude/settings.json`, spawn with `--permission-mode acceptEdits`, or accept the
  occasional walk-over-and-press-y. Could be a per-entry setting in `repos.json`.
- Does the solo (no registered sessions) mode stay 100% file-protocol for backward compat
  with the QA-harness sibling, or does that fork migrate too?
- Bus growth: rotate `bus.jsonl` on retire, or just let it grow like transcript.jsonl?

## Decisions made at implementation (2026-06-11)

- Bare "`<callsign>`" focus switch: NO. Requires "focus on / switch to / talk to". Bare
  single words misfire too easily with an open mic.
- Confirm-back after callsign rebirth: NO. The spoken rebirth announcement is the guard.
- QA-harness sibling: untouched. The solo file protocol (say.txt, transcript tail,
  worklist) still works; worklist v1 files migrate to v2 on first load.
- Bus growth: `bus.jsonl` grows forever, like transcript.jsonl. Revisit if it ever matters.
- Spawn permissions: optional `permissionMode` per entry in `repos.json`, passed to claude
  as `--permission-mode`. Default is none (visible terminal, human can answer prompts).
- Extras that fell out of the build: `POST /hear` (inject an utterance over HTTP — testing
  and a future type-to-jarvis box), `JARVIS_NO_UI=1` headless mode, `JARVIS_DATA=<dir>`
  state-dir override, and the etiquette prefix is speak-time only so the transcript stores
  clean text.

## Estimated effort

Estimate was 150–250 lines; actual came to roughly 450 added lines including the chat-view
console rewrite. Smoke-tested headless end to end: register/pin, routing (focused + "on
<callsign>"), task targeting, long-poll wake, say etiquette, retire guard, retire-request,
archive + summary, history query, pin rebirth, repo registration, restart persistence.
