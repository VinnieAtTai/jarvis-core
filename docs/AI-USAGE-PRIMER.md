# A working primer on getting good results from Claude (and what it costs)

_Draft by xray (jarvis punchlist worker), 2026-06-24, for Chris's review. Aimed at the
high/medium level — how to prompt well and how to reason about cost — not an API manual.
Model IDs and prices below are current as of June 2026; re-check the model table when they
move. Written from general knowledge of the tools, not from a specific GENERAL-chat thread,
so tighten anything that doesn't match what you had in mind._

---

## 1. The one mental model that explains everything

A model only ever does one thing: it reads a pile of text (the **context**) and writes the
next pile of text (the **output**). Everything else — prompting, cost, caching, model choice —
is a consequence of that.

- **Tokens** are the unit. Roughly **1 token ≈ 4 characters ≈ ¾ of a word**. A page of text
  is ~500–800 tokens; this primer is a few thousand.
- Every turn, the model **re-reads the entire context from scratch.** It has no memory between
  calls — a long chat is just the whole transcript being re-sent each time. That's why long
  sessions get slower and pricier as they grow, and why a fresh session is cheap.
- You pay separately for **input** (what it reads) and **output** (what it writes), and
  **output is ~5× more expensive than input.** Reading a big document is cheap; generating a
  big document is not.

If you only remember one thing: **context is the budget.** Keep it focused and you get faster,
cheaper, better answers.

---

## 2. Cost intuition (the numbers that matter)

Prices are per **million tokens** (MTok), input / output:

| Model | ID | Input $/M | Output $/M | Use it for |
|---|---|---|---|---|
| Haiku 4.5 | `claude-haiku-4-5` | $1 | $5 | Fast, cheap, simple: classification, extraction, short replies |
| Sonnet 4.6 | `claude-sonnet-4-6` | $3 | $15 | The balanced workhorse — most everyday tasks |
| Opus 4.8 | `claude-opus-4-8` | $5 | $25 | Hard reasoning, big refactors, long agentic runs (the JARVIS default) |
| Fable 5 | `claude-fable-5` | $10 | $50 | The ceiling — only for the genuinely hardest, long-horizon work |

Back-of-envelope: a chunky request — say 20K tokens of context in, 2K tokens out — costs about
**10¢ on Opus, 6¢ on Sonnet, 2¢ on Haiku.** Individual calls are cheap; the spend adds up in
**volume and in long agentic loops** (an agent that runs 50 turns re-reads its growing context
50 times). That re-reading is exactly what prompt caching (§4) attacks.

**Three levers that move cost the most, in order:**
1. **Model tier.** Don't run Opus on a job Haiku can do. A 5× price gap is a big lever.
2. **Output length.** Output is the expensive side. "Give me the answer, not an essay" is a
   real cost control, not just a style note.
3. **Context size.** Smaller, focused context is cheaper *and* gives better answers (see §3).

---

## 3. How to prompt well (the part that actually changes output quality)

Good prompting is mostly about **removing ambiguity and supplying the right context** — not
magic words. In rough order of impact:

- **Say what "done" looks like.** "A CSV with a numeric `price` column per SKU" beats "clean up
  the data." The model optimizes for what you specify; vague targets get vague results.
- **Give the intent, not just the task.** "I'm prepping the v18 release notes for customers, so
  flag anything that changes the public API" lets it make judgment calls you'd otherwise have to
  spell out. Newer models use the *why* to connect the dots.
- **Front-load the context it needs, leave out what it doesn't.** Paste the relevant code/spec;
  don't paste the whole repo. More irrelevant context = worse answers *and* higher cost.
- **Show, don't just tell.** One or two examples of the format/style you want is worth a
  paragraph of description.
- **State the boundaries.** "Only change the file I named; don't refactor the rest" or "ask
  before deleting anything." Current models are literal and will respect explicit limits.
- **Let it work.** For multi-step tasks, give the full goal up front and let it run, rather than
  drip-feeding one instruction at a time — it plans better and wastes fewer tokens with the
  whole picture in hand.
- **Iterate, don't wrestle.** If the first answer misses, it's almost always a context/spec gap.
  Add the missing piece rather than repeating the same ask louder ("CRITICAL: YOU MUST…" tends
  to backfire — it over-triggers).

**For JARVIS workers specifically:** the brief you send over `/send` is the worker's whole
world. Send goals, paths, and constraints — never file contents or logs the worker can read off
disk itself. A tight brief is the difference between a worker that nails it and one that flails.

---

## 4. Prompt caching — the biggest cost win for repeated context

When you send the same big chunk of context across many requests (a system prompt, a large
spec, a codebase preamble), the model can **cache** it: the first request pays a small premium
to write the cache, and every later request that reuses that exact prefix reads it at **~10% of
the normal input price.**

- **Cache read ≈ 0.1× input cost. Cache write ≈ 1.25×.** So it pays off from the **second**
  reuse onward. For anything reused a lot, it's a 5–10× saving on the repeated part.
- **It's a prefix match — order matters.** Put the *stable* stuff first (frozen instructions,
  the big document) and the *changing* stuff (today's question, a timestamp) last. A single
  changed byte early in the prompt throws away the cache for everything after it.
- **The classic mistake:** interpolating something volatile (the current time, a session ID)
  into the top of an otherwise-stable prompt. That silently breaks caching on every request.

You mostly don't hand-manage this in Claude Code — but it's why **keeping a session's framing
stable** and **not constantly reshuffling context** keeps things fast and cheap.

---

## 5. Picking a model — a 10-second decision

- **Simple, high-volume, latency-sensitive** (tagging, extraction, a quick rewrite) → **Haiku**.
- **Most real work** (everyday coding, analysis, drafting) → **Sonnet**.
- **Hard reasoning, long autonomous runs, big refactors** → **Opus** (the JARVIS default).
- **Only when Opus genuinely isn't enough** → **Fable** — it's double Opus's price; reach for it
  deliberately, not by reflex.

Two depth knobs worth knowing exist (Claude Code exposes these; you rarely set them by hand):
- **Effort** — how hard the model thinks before acting. Higher = smarter and slower/pricier.
  `high`/`xhigh` for coding and agentic work; lower for routine stuff.
- **Fast mode** — same Opus model, ~2.5× faster output at a premium price. Good when you're
  watching it work and want responsiveness; toggle with `/fast`.

---

## 6. Habits that compound

- **Start fresh for a new task.** Don't pile a new problem onto a 200-message session — you'll
  pay to re-read all of it every turn and the model gets distracted by stale context.
- **Be specific about output length.** It's the expensive side and the easiest to control.
- **Match the model to the job.** The single biggest cost lever you control.
- **Spend words on context and constraints, not on incantations.** Clear intent beats clever
  phrasing every time.
- **When an answer's wrong, fix the context.** Nine times out of ten the model did exactly what
  the prompt said — the prompt was just missing a piece.
