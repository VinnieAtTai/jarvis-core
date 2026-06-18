# Conversational JARVIS tab — spec

A model-backed chat tab in the console that talks to the **Claude API directly**, with
per-thread memory and a per-message model selector. This is both the requested feature and
the biggest token-usage optimization: it moves "talking to JARVIS" off the flat Claude Code
seat (≈20–40K seat tokens/turn through a worker) onto a metered API wallet (≈2–6K tokens/turn),
≈10× faster, and frees the seat budget for the agentic workers.

## Principles (quality first)
- Match the model to task difficulty; **default up when unsure**. Cost-cut only where a cheaper
  model is *fully* correct, never where it would be worse.
- Core/agentic work stays on Claude Code (seat) at Opus — this tab does NOT touch that.
- The API key is read from `process.env.ANTHROPIC_API_KEY` (or a gitignored local file). It is
  NEVER committed and NEVER sent to the client.

## Model policy
| Surface | Default | Override | Rationale |
|---|---|---|---|
| Conversational tab (this) | `claude-sonnet-4-6` | dropdown: Haiku / Sonnet / Opus | Sonnet is the workhorse; Opus one click away for hard reasoning |
| Quick / trivial asks | `claude-haiku-4-5` | — | no quality ceiling to hit |
| Hub micro-calls (parse, summary) | `claude-haiku-4-5` or no-LLM | — | tiny + frequent |
| Real agentic work (workers) | Claude Code seat, Opus | effort dial | unchanged; flat-rate is the cheap way to do heavy work |

Rates (per Mtok in/out): Haiku $1/$5 · Sonnet $3/$15 · Opus $5/$25.
API params (per claude-api skill): `x-api-key` + `anthropic-version: 2023-06-01`;
`max_tokens` ~2048 (non-stream) / higher if streaming; Opus uses `thinking:{type:"adaptive"}`
+ `output_config:{effort}` (escalate effort for hard prompts); Sonnet/Haiku plain.

## Architecture (fits existing jarvis-core patterns)
- **Persistence**: `ai-threads.json` under `DATA` — `{ threads: { <id>: { title, model, messages:[{role,content,ts}] } } }`.
  Mirrors how worklist.json is loaded/migrated/saved.
- **Routes** (added to the `key === 'METHOD /path'` server switch):
  - `POST /ai/send {threadId?, text, model?}` → append user msg, call Anthropic with the thread's
    message history, append assistant reply, return it (stream later). Creates a thread if none.
  - `GET /ai/threads` → list threads (id, title, model, last ts) for the tab.
  - `GET /ai/thread?id=` → full message history for rendering.
  - `POST /ai/newthread` / `POST /ai/deletethread`.
- **Anthropic call**: global `fetch` to `https://api.anthropic.com/v1/messages` (no npm install —
  fetch is built in). System prompt: short JARVIS persona (a few hundred tokens), NOT the worker
  system prompt. messages = the thread history.
- **UI** (console.js/html/css — served fresh, no rebuild): a dedicated tab (e.g. "ASK") separate
  from the worker chat tabs. Renders thread history, a model dropdown, an input box. Talks to
  `/ai/*`, NOT the speech/worker bus. (This is the chat-v2 dropdown board item, realized.)

## Spend cap (hard guardrail)
- `ai-spend.json` under DATA: `{ month: "YYYY-MM", usd: <running> }`.
- After each call, add `input_tokens*rate_in + output_tokens*rate_out` (rates by model) from the
  response `usage`. Roll over on month change.
- **Cap (default $20/mo, configurable)**: `POST /ai/send` refuses with a clear message when over
  cap; the UI shows the running spend and the cap. No surprise bills, ever.

## Rollout
1. Server: routes + thread store + Anthropic call + spend tracking, key from env. Isolated-boot-verify
   on :8199. (Most of this is verifiable without a key.)
2. UI: the ASK tab + model dropdown + spend readout.
3. Live test WITH Chris once a key is in env; tune the system prompt + default model.
4. Ship behind the cap. `/restart` to deploy the core changes (UI is live on refresh).

## Needs from Chris
- An Anthropic API key (from console.anthropic.com) set as `ANTHROPIC_API_KEY` in the hub's env.
- Confirm the monthly cap ($20 default) and default model (Sonnet).
