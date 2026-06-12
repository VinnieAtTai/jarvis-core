# JARVIS core — handoff notes for Tim

## If you're on the early version

The early zips were the SOLO design: one brain session driving everything through files
(`say.txt` to speak, tail `transcript.jsonl` to hear, edit `worklist.json` directly).
Everything below replaced that. The big shift: the hub is now a **multi-session HTTP server**
— any number of Claude sessions register over `:8124`, get NATO callsigns, route voice by
name, and never touch the hub's files (the HTTP API is the contract; the file protocol only
survives for a hubless solo driver). Added since your version: per-session task boards,
session spawning from voice, context-health + token gauges in the console, schedule/calendar
panels with meeting reminders, instant voice-gated screenshots, barge-in, and text-first
speech etiquette. Easiest way to sync: grab the repo itself (it's small) rather than diffing
your copy.

The hub is plain node (`jarvis-core.mjs`, no AI in the process) listening on
`http://127.0.0.1:8124`. Voice in/out is a Chrome app window the hub launches via
Playwright: Web Speech API for the open mic, speechSynthesis for the voice. Everything
else — Claude sessions, the calendar feeder, your own app — talks to it over local HTTP.
Repo: `d:\claude\jarvis-core` (git; backed up to a OneDrive bare repo). `npm install`,
then `start-jarvis.cmd`.

## Connecting a session (or any program)

Full worker protocol: `GET /protocol` (serves WORKER.md). Short version:

1. `POST /register {"cwd":"<dir>","purpose":"<one speakable line>"}` → `{"uid","callsign"}`.
2. Long-poll `GET /poll?uid=<uid>&cursor=<n>` in a shell wrapper loop that only exits when
   events arrive — an idle session costs zero tokens. Event kinds: `speech`, `screenshot`,
   `msg`, `retire-request`, `retired`. Re-arm the loop BEFORE handling events.
3. Output: `POST /send {"from":uid,"to":"human","text":...}` = silent console chat (the
   default channel); `POST /say` = spoken, one short headline only; lead with "Need you:"
   when blocked on the human (renders a red NEEDS YOU badge).
4. `POST /worklist` (add/start/done/drop/move) keeps your column on the board.
5. `POST /health {"uid","context":0-100,"doing":"<short phrase>"}` — context fullness +
   current state, shown on the board; hub warns the human at 80%.
6. `POST /retire {"uid","summary"}` archives you.

Spawning: the hub launches Claude Code workers itself ("start a session in <repo>") —
it pre-assigns the callsign, titles the terminal tab `<callsign> - <purpose>`
(`wt new-tab --suppressApplicationTitle`), and the worker registers with that pin.

## How the calendar integration works

The hub never touches Google credentials. The flow is:

1. **A Claude session with the claude.ai Google Calendar connector pulls the events.**
   Setup: claude.ai → Settings → Connectors → Google Calendar, then `/mcp` in Claude Code
   to auth the session. Gotcha that bit us: if you miss a checkbox on Google's consent
   screen you get "insufficient authentication scopes" — revoke Claude's access at
   myaccount.google.com/connections and reconnect so the consent screen comes back fresh.
2. **The session reshapes events and POSTs them to the hub:**
   `POST /schedule {"events":[{"title","start","end","link","join","joinKind"}]}`
   - `start`/`end`: ISO timestamps with offset (e.g. `2026-06-12T15:00:00-05:00`)
   - `link`: the calendar `htmlLink` (opens the invite)
   - `join`: the `conferenceUrl`/`hangoutLink`, or a zoom/teams URL fished out of
     location/description
   - `joinKind`: `meet` | `zoom` | `teams` (drives the icon; teams renders 🤮)
3. **Hub side** (`schedule.json`, gitignored state):
   - `GET /schedule` returns events + computed `next` and `current`; schedules from a
     previous day are ignored automatically.
   - A 15s ticker speaks a heads-up at T-5 minutes and announces at start, once each
     (announced flags persist across restarts).
   - Console renders a NEXT MEETING panel above the task boards and a SCHEDULE panel
     below them; past events grey out and drop their icons.
4. **Link clicks target a specific Chrome profile.** Icons don't use anchors — they
   `POST /open {"url"}` and the hub spawns
   `chrome.exe --profile-directory=<dir> <url>`. The profile dir is resolved at call time
   by matching `JARVIS_LINK_EMAIL` (set in start-jarvis.cmd) against
   `%LOCALAPPDATA%\Google\Chrome\User Data\Local State` → `profile.info_cache[*].user_name`,
   so work links open signed in to the work account regardless of profile reshuffles.
5. **Paste fallback** for days without the connector: the console SCHEDULE button takes a
   raw Google Calendar agenda copy (title lines + `3:00 PM-4:00 PM` lines; the Going?/
   Awaiting noise is filtered) via `POST /schedule {"text":...}`.

## Other pieces worth stealing

- **Instant voice-gated screenshots**: saying "take a screenshot" makes the HUB capture
  within ~0.3s (PowerShell CopyFromScreen, DPI-aware), say "Snap.", and push the PNG path
  to the focused session as a `screenshot` event bundled with the asking speech. Sessions
  can never capture on their own (one voice-armed grant per ask, 403 otherwise). Captures
  auto-prune to the last 20.
- **Barge-in**: the mic stays hot during TTS; novel speech (echo-filtered by word overlap
  against the line being spoken) cancels speech instantly.
- **Exact token usage**: hub reads `~/.claude/projects/**/*.jsonl` usage fields for an
  hourly burn gauge, and (opt-in, `JARVIS_REAL_USAGE=1`) calls the official OAuth usage
  endpoint with the local Claude credential — token never enters any model context — for
  exact session/week percentages in the header.
- Your mute button is being ported in the other direction right now (plus auto-mute when
  a scheduled meeting starts).
