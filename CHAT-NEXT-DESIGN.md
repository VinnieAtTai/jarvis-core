# Console chat v2 — design notes (Chris, 2026-06-12 ~16:10)

Requested for a later session ("later tonight maybe or tomorrow"). Builds on the typed-input bar added 2026-06-12 (input + SEND under #chat, POST /hear {text, typed:true}, typed bypasses pause/mute/meeting gates).

## 1. Image attachments in messages

Chris wants to paste images into the chat (e.g. screenshots of Slack threads) and have them reach a session.

Implementation sketch:
- Paste handler on #typebox (clipboardData.items image/*) + drag-drop on the chat panel.
- New `POST /attach` (base64 body) -> hub writes to `DATA/attachments/<ts>-<n>.png`, returns the path.
- The outgoing message carries the attachment path(s); workers receive them like `screenshot` events (a path they Read as an image) — same consumption pattern WORKER.md already documents, so no worker-side changes.
- Chat render: thumbnail in the bubble, click -> /open or full size.

## 2. Target selector on the input bar

A dropdown next to SEND:
- One entry per live callsign (populate from the board poll that already feeds renderBoards — callsigns + alive flag are in the payload).
- Plus **"General"** — explicitly NOT targeted at any session.

Routing semantics:
- Callsign selected -> deliver straight to that session's inbox WITHOUT moving the hub focus (direct busAppend, not the focus-follow pipeline). Typing "kilo, do x" in General mode still works the old way.
- **OPEN QUESTION for Chris:** what should General do exactly — (a) current behavior (handleUtterance pipeline: commands work, message follows hub focus), or (b) ambient note recorded to transcript/chat only, routed to no one? His phrasing "really isn't targeted" suggests (b), confirm before building.

## Context for the builder

- All current chat plumbing lives in jarvis-core.mjs: console HTML (~line 86 input bar), client JS (sendTyped near the __setPause block), POST /hear (~line 1399, `typed` flag), handleUtterance (~line 822, `typed` bypasses muted/meeting/discard guards).
- Pause/mute flags are in-memory and reset on hub restart — persisting them is a known nice-to-have, could ride along in this change.
- Restart safety: sessions/worklist/repos persist to disk; only pause/mute state is lost. Restart procedure: kill the jarvis-core node PID, `Start-Process node jarvis-core.mjs` in this dir.
