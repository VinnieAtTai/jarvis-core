# Meeting-worker mode for the "+" — design draft

_Draft by foxtrot (jarvis punchlist worker), 2026-06-23, while Chris was in PRD Planning.
For Chris's review — nothing built yet._

## Intent (Chris, 2026-06-23)

> "The 'add a worker' +, we need to be able to spin up a worker to focus on a call, so I can
> use it during the meeting — think working meetings. That's what I intended that to do on meetings."

The `+` should let Chris spin up a worker **focused on a specific meeting** that he can use
**during the call** — capture decisions/action items, draft Jira items, pull up the meeting's
notes doc, answer questions — not just a repo-bound code worker.

**Interaction is TYPING-primary, not voice** (Chris, 2026-06-23, re #14): "for the new-session
stuff I don't really want to be voice — most likely I'll want it for typing." This makes sense in
a live meeting (you don't talk to the assistant out loud while others are on the call). It also
means the feature mostly **already has its input channel**: the console's per-message **send-to
dropdown** (shipped in 466dc8f) lets Chris type to any session without leaving the tab he's
reading. So the meeting worker is driven by typing in chat; voice routing (below) drops to
optional.

## Current behavior

- The `+` tab opens a small form: a **repo** picker (`#nsrepo`, from `repos.json`) + a free-text
  **purpose** (`#nspurpose`), then `spawnNewSession()` → `POST /spawn {cwd, purpose}`.
- `spawnWorker()` builds the worker's boot prompt from `purpose` (+ optional `project`, `handoff`,
  `tier`) and launches a console-less ConPTY worker that registers, greets, and polls.
- **Meeting mode** (`meetingMode`, toggled by saying "meeting mode" / "end meeting") currently
  **suppresses everything except "jarvis …"** — it's a "stop listening to the room" mode. It does
  **not** route speech to any worker.
- The hub already holds **today's schedule** (`GET /schedule`: title, start/end, Meet `join`,
  calendar `link`) once it's been pulled.

## Gap

1. The `+` only knows repos, not meetings — no way to seed a worker from a calendar event.
2. A meeting worker needs **meeting context** (title, time, Meet link, attendees, the attached
   notes doc, agenda) in its boot prompt to be useful from minute one.
3. Existing meeting mode **blocks** talking to a worker — the opposite of a working meeting, where
   Chris wants his speech to **reach the meeting worker**.

## Proposed UX

Add a **"Meeting" path** to the `+` panel (a small toggle: "Repo | Meeting"):

- **Meeting** lists **today's schedule events** (from `GET /schedule`), each a one-click row:
  `9:00 PRD Planning`, `1:00 SCRUM`, … plus a "now / next" hint. The current/next event is
  pre-selected.
- Picking one pre-fills purpose `Meeting: <title>` and spawns a **meeting worker** seeded with that
  event's context. A "blank meeting" option (no calendar event) is also available for ad-hoc calls.
- Optional checkbox **"enter working-meeting mode"** (see below).

## How it spawns

Extend `POST /spawn` to accept an optional `meeting` object and pass it through `spawnWorker`:

```
POST /spawn {
  cwd: "<workspace>",                 // see "Which cwd" below
  purpose: "Meeting: PRD Planning",
  meeting: {
    title, start, end,
    join: "https://meet.google.com/…",   // Meet link from the event
    link: "https://www.google.com/calendar/event?…",
    attendees: ["tim.lucas@…", …],        // optional
    notesDoc: "https://docs.google.com/document/d/…",  // event attachment, if any
    agenda: "<event description>"          // optional
  }
}
```

`spawnWorker` appends a **meeting-assistant boot block** when `meeting` is present, e.g.:

> You are a MEETING worker for "{title}" ({start}–{end}). Your job is to assist Chris live during
> this call: capture decisions and action items, draft Jira items when asked, and pull up
> references. Meet link: {join}. Agenda: {agenda}. If a notes doc is attached ({notesDoc}), read it
> for context. You have Google Calendar / Drive / Jira MCP tools — use them. Keep spoken lines to
> headlines; put notes, drafts, and lists in chat. When the meeting ends, post a concise summary
> (decisions + action items + any drafted Jira items) and retire with that as your handoff.

### Which cwd?

A meeting worker isn't primarily editing code. Options, in order of preference:
1. A dedicated **`meetings`** workspace dir (new `repos.json` entry) so notes/scratch land in one
   place and don't pollute a code repo.
2. The relevant **project repo** if the meeting is about one (Chris picks, or we infer from title).
3. Fallback to **`scratch`** (`d:/claude`).
Recommend #1.

## Interaction during the meeting — typing first

Chris drives the meeting worker by **typing**, using the **send-to dropdown** (shipped 466dc8f):
pick the meeting worker's callsign, type, and its replies land in that session's chat tab — all
without leaving whatever he's reading and without saying a word out loud. The worker keeps `/say`
to true headlines only (it shouldn't be talking over a live call); everything substantive —
notes, action items, drafted Jira items — goes to **chat**.

This means **plain meeting mode stays useful as-is**: turn it on to keep the room quiet (the hub
stops reacting to ambient speech), and still type to the meeting worker the whole time. No new
speech-routing fork is required for the core feature.

### Optional later: voice routing

If Chris ever does want to *talk* to a meeting worker, a "working-meeting mode" bound to the
worker's callsign could route his speech there (with "jarvis …" still reaching the hub, "end
meeting" retiring the worker with a summary). Deprioritized given the typing-first preference —
listed only so it isn't lost.

## Phasing

- **P1 (small):** Meeting path in the `+` that lists schedule events, pre-fills purpose, and spawns
  a worker with the `meeting` context block. Chris drives it by **typing** via the send-to dropdown
  (already shipped). No mode change. Delivers most of the value.
- **P2:** "end meeting → retire the worker with a notes/action-item summary" + auto-write that
  summary into the meeting's Google Doc.
- **P3:** Auto-offer to spin a meeting worker a few minutes before a calendar meeting starts (ties
  into the existing NEXT banner / reminders). Optional voice routing if ever wanted.

## Open questions for Chris

1. Dedicated `meetings` workspace dir, or spawn in the related code repo?
2. Should the meeting worker **auto-read the attached notes doc** and **draft Jira items**
   unprompted, or only when asked?
3. ~~Voice routing~~ — decided 2026-06-23: typing-first via the send-to dropdown; voice deprioritized.
4. Auto-offer before meetings (P3), or always manual via the `+`?
