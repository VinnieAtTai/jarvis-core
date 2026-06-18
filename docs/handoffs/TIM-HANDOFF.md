# How we implemented the calendar (for Tim)

The hub (plain node, no AI, no Google credentials) just stores and displays a day's
schedule. A Claude session with the claude.ai **Google Calendar connector** is what
actually talks to Google — it pulls the day's events and POSTs them to the hub.

## 1. Getting events

- claude.ai → Settings → Connectors → connect Google Calendar, then `/mcp` inside the
  Claude Code session to authenticate it.
- Gotcha: if a checkbox is missed on Google's consent screen you get
  "insufficient authentication scopes". Fix: revoke Claude at
  myaccount.google.com/connections, reconnect, tick everything.
- The session calls the connector's `list_events` for today and reshapes each event to:
  `{ title, start, end, link, join, joinKind }`
  - `start`/`end`: ISO with offset, e.g. `2026-06-12T15:00:00-05:00`
  - `link`: the event's `htmlLink` (opens the invite)
  - `join`: `conferenceUrl` / `hangoutLink` (or zoom/teams URL found in location/description)
  - `joinKind`: `meet` | `zoom` | `teams` — picks the icon

## 2. Feeding the hub

- `POST /schedule {"events":[...]}` — replaces the day's schedule, persisted to
  `schedule.json` with an `announced` map.
- Fallback with no connector: `POST /schedule {"text":"<raw Google Calendar agenda paste>"}`
  — parser pairs a title line with the `3:00 PM-4:00 PM` line that follows and skips the
  "Going?" / "Awaiting your response" noise. The console has a SCHEDULE button + textarea
  for this.

## 3. What the hub does with it

- `GET /schedule` → `{ events, next, current }` (next = first start > now; schedules from a
  previous date are ignored automatically).
- A 15-second ticker announces each event once at T-5 minutes ("Heads up: X in 5 minutes")
  and once at start — `announced` flags persist across hub restarts so nothing repeats.
- Console (polls every 1.5s): a NEXT MEETING panel above the task boards (NOW/NEXT rows),
  a SCHEDULE panel below them (past events greyed), right-aligned icons per event:
  🎥/🔵/🤮 = join meet/zoom/teams, 📅 = open invite.

## 4. Opening links in the right Chrome profile

Icons are not anchors — a click does `POST /open {"url"}` and the hub spawns
`chrome.exe --profile-directory=<dir> <url>`. The profile dir is resolved by matching an
email (env `JARVIS_LINK_EMAIL`, set in start-jarvis.cmd) against Chrome's
`%LOCALAPPDATA%\Google\Chrome\User Data\Local State` → `profile.info_cache[*].user_name`.
So meeting links always open signed in to the work account, not whatever profile the
console window runs in.
