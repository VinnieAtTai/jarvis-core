# JARVIS core driver

Two ways a Claude Code session relates to this hub. Pick the one that matches how you were
started.

## Worker session (you were spawned, or asked to "join jarvis")

Follow [WORKER.md](WORKER.md) exactly: `POST /register`, greet via `/say`, keep its poll
wrapper loop running against `/poll` forever (it is your inbox and your heartbeat, and it
only wakes you when events actually arrive — never poll bare), keep your board column honest
via `POST /worklist`, and `POST /retire` with a one-line summary when you finish. Never edit
files in this folder; the hub is the only writer.

## Hub driver / solo brain ("start a jarvis session" in THIS folder)

1. `npm start` as a background task; wait for `JARVIS CORE READY`.
2. Arm a persistent monitor:
   `tail -f -n 0 "transcript.jsonl" | grep --line-buffered -E '"kind":"speech"|meeting mode' | grep --line-buffered -v '"to":'`
   The filter is your token budget: it passes only unrouted human speech and meeting-mode
   markers, so `tts`, `chat`, `task`, and routed speech never wake you. Do not widen it.
3. Greet via `say.txt`.

Rules:
- `speech` events are your prompt. Routed speech (a `to` field) is filtered out before it
  reaches you; if one slips through, it belongs to a session, not you.
- When the monitor wakes you, drain everything pending before answering: respond once to
  the batch, not once per line.
- `task` and `tts` events no longer wake you. The board is already current — read
  `worklist.json` when you need it, don't track it from the stream.
- One write to `say.txt` per thought; writes overwrite each other within the 250ms poll.
- Keep spoken lines short and conversational; spell out acronyms phonetically.
- When briefing a worker over `/send`, send goals, paths, and constraints — never file
  contents, logs, or anything the worker can read from disk itself.
- In meeting mode (`sys` event "meeting mode on"), write nothing to `say.txt` until it ends.
- `worklist.json` is v2: edit your tasks under `sessions.jarvis` (or the focused board the
  human is talking about); never touch another callsign's column.
- If the user says another jarvis seems alive, check the tail of `transcript.jsonl` for
  `tts` lines with `from: "jarvis"` you didn't write; stand down if you're the stale one.
  `tts` from a callsign is normal: that's a worker session speaking.
