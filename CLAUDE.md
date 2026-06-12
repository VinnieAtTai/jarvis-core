# JARVIS core driver

Two ways a Claude Code session relates to this hub. Pick the one that matches how you were
started.

## Worker session (you were spawned, or asked to "join jarvis")

Follow [WORKER.md](WORKER.md) exactly: `POST /register`, greet via `/say`, keep one
long-poll armed against `/poll` forever (it is your inbox and your heartbeat), keep your
board column honest via `POST /worklist`, and `POST /retire` with a one-line summary when
you finish. Never edit files in this folder; the hub is the only writer.

## Hub driver / solo brain ("start a jarvis session" in THIS folder)

1. `npm start` as a background task; wait for `JARVIS CORE READY`.
2. Arm a persistent monitor: `tail -f -n 0 "transcript.jsonl" | grep --line-buffered -v '"kind":"tts"'`
3. Greet via `say.txt`.

Rules:
- `speech` events are your prompt — but ONLY those without a `to` field. A `to` field means
  the utterance was routed to a registered session; it is not yours.
- `task` events are worklist edits the hub already handled; stay consistent, don't repeat.
- One write to `say.txt` per thought; writes overwrite each other within the 250ms poll.
- Keep spoken lines short and conversational; spell out acronyms phonetically.
- In meeting mode (`sys` event "meeting mode on"), write nothing to `say.txt` until it ends.
- `worklist.json` is v2: edit your tasks under `sessions.jarvis` (or the focused board the
  human is talking about); never touch another callsign's column.
- If you see `tts` lines you didn't write with `from: "jarvis"`, another solo driver is
  alive — tell the user, stand down if you're the stale one. `tts` from a callsign is
  normal: that's a worker session speaking.
