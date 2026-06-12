# JARVIS core — voice hub + multi-session task board

The heart of a voice copilot: you talk, it transcribes complete thoughts; any number of
"brain" sessions (Claude Code in different repos, scripts, whatever) register with the hub
over HTTP, get a NATO callsign, and you address them by voice. The console shows a chat
view of the conversation and a per-session task board. Standalone (no sessions) it is still
a voice todo board with a file protocol any program can drive.

## What it does

- **Speech in** — Chrome's Web Speech API, open mic, no wake word. Utterances buffer until
  ~2.5s of silence so brains get complete thoughts.
- **Speech out** — sessions `POST /say` (or the solo brain writes `say.txt`); the focused
  session speaks unprefixed, everyone else gets "xray says: ...".
- **Multi-session hub** — sessions register over HTTP and get a callsign (`alpha`...`zulu`)
  plus a permanent uid. Voice routes to them; their messages queue while they work.
- **Task board** — `worklist.json` v2: one column per callsign plus the hub's own `jarvis`
  board, rendered live, editable by voice or HTTP.
- **Conversation view** — chat bubbles (you right, brains left), last 10 messages, expand
  toggle (`t`), raw protocol view (`r`), auto-pinned to bottom with a jump-to-latest chip.
- **Session spawning** — "jarvis, start a session in broker" launches Claude Code in a
  registered repo's terminal; it checks in by itself. "start a cheap session in ..." spawns
  it on haiku; a `model` field on the repo entry sets a per-repo default.
- **Meeting mode / pause** — gate or discard the mic without shutting down.
- **Screen look (voice-gated)** — saying "take a screenshot" arms exactly one desktop
  capture; a session then fetches `GET /screen` for the PNG path. Without that spoken
  grant the endpoint refuses — sessions cannot watch the screen on their own.

## Setup

1. Node 18+, Google Chrome installed.
2. `npm install`
3. `npm start` — the console window opens. Talk.

Headless (no Chrome, no mic — protocol testing): `JARVIS_NO_UI=1 npm start`, then drive it
with `POST /hear {"text":"..."}`. `JARVIS_DATA=<dir>` redirects all state files;
`JARVIS_PORT` changes the port (default 8124).

## Voice commands

### Solo / board (work on whichever board is focused)

| Say | Does |
|---|---|
| `add task <text>` (`... for <callsign>`) | adds to QUEUED |
| `start task <text>` / `done with <text>` / `scratch task <text>` | moves it (substring match, focused board first) |
| `clear done` / `read my list` / `read everyone's list` | board housekeeping |
| `pause listening` / `resume listening` / `meeting mode` / `end meeting` | mic gating |
| `jarvis shutdown` / `end session` | clean stop |

### Sessions

| Say | Does |
|---|---|
| `focus on <callsign>` (also `switch to` / `talk to`) | sticky focus; plain speech now routes there |
| `on <callsign>, <anything>` | route one utterance, focus unchanged |
| `jarvis, <anything>` | always the hub / solo brain, regardless of focus |
| `who's running` / `who is <callsign>` | roster |
| `give the <x> task to <callsign>` | cross-board move |
| `call this one <callsign>` | rename the focused session |
| `retire <callsign>` (`... anyway` to force) | retirement; guard if tasks are WORKING |
| `what did the old <callsign> do` / `the one before that` | retired-session history |
| `start a session in <repo> [for <purpose>]` | spawn Claude Code in a registered repo |

## HTTP protocol (port 8124)

Workers follow [WORKER.md](WORKER.md) (served live at `GET /protocol`).

| Endpoint | Does |
|---|---|
| `POST /register {cwd, purpose, pin?}` | mint uid, assign callsign (pin a free one to choose) |
| `GET /poll?uid=&cursor=` | long-poll inbox (25s hold); doubles as heartbeat |
| `POST /send {from, to, text}` | message a session by callsign/uid, or `"to":"human"` for silent chat |
| `POST /say {from, text}` | speak aloud (etiquette prefix applied automatically) |
| `POST /worklist {op, callsign, text, to?}` | `add` / `start` / `done` / `drop` / `move` / `clear-done` |
| `POST /retire {uid, summary}` | end of life; summary becomes the session's epitaph |
| `POST /repos {name, cwd, defaultPurpose?, permissionMode?}` | register a spawnable workspace |
| `POST /hear {text}` | inject an utterance as if spoken (testing / typing) |
| `GET /roster` / `GET /board` / `GET /worklist` / `GET /transcript?limit=` | state reads |

## Files (all in `JARVIS_DATA`, default this folder)

| File | Contract |
|---|---|
| `transcript.jsonl` | append-only: `speech`, `tts`, `chat`, `task`, `sys` events. The solo brain's inbox (speech events with a `to` field belong to sessions — skip them). |
| `bus.jsonl` | append-only session messages; sessions read their slice via `/poll`, never the file |
| `worklist.json` | `{"focus":"...","sessions":{"<callsign>":{"working":[],"queued":[],"done":[]}}}` |
| `sessions.json` | roster: callsign → uid history, per-uid record (purpose, cwd, ended, summary) |
| `repos.json` | spawnable workspaces: name → `{cwd, defaultPurpose, permissionMode?}` |
| `archive/<uid>.json` | retired session's final board + summary; nothing is ever deleted |
| `say.txt` / `commands.txt` | legacy solo protocol: lines spoken then cleared / `stop` |

## Sessions: lifecycle in one paragraph

A session registers and gets a callsign; the first live session is auto-focused. The hub
announces it. Its long-poll is its heartbeat — quiet for 2 minutes and the board greys it
out, and anything you say to it queues with a spoken heads-up. Retiring (by voice or its own
`POST /retire`) archives its board, stores its one-line summary on the permanent uid record,
and frees the callsign back into a least-recently-retired pool, so handles stay cold as long
as possible before reuse; a reborn callsign is announced aloud.

## Privacy

Open mic streams audio to **Google's speech servers** whenever it is listening, including
meeting mode. `jarvis shutdown` is the only true mute. All state persists on disk.

## Notes

- Windows-tested; pure Node + Playwright, Chrome must be installed (`channel: 'chrome'`).
- Spawning uses Windows Terminal (`wt`), falling back to `cmd start powershell`.
- Closing the console window kills the ears; the hub keeps running — restart with `npm start`.
- Design history and decisions: [DESIGN.md](DESIGN.md).
