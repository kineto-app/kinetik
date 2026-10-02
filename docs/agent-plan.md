# Agent runtime plan

Status: **plan, not built.** Nothing below exists yet unless marked "have". Agreed direction as of 2026-10-02.

## Goal

Make the Kinetik agent dependable on long, real tasks (carousels, photos, video through Charms) on phone and web, and close the gaps against mature agent frameworks such as pi, without giving up what Kinetik already does better.

## Decision: keep our loop

We evaluated pi (`@earendil-works/pi-agent-core` + `pi-ai`, formerly `@mariozechner/pi-*`), the Vercel AI SDK (`ToolLoopAgent`, and `WorkflowAgent`/Workflow DevKit), the OpenAI Agents SDK for JS, Mastra and LangGraph.js. We keep Kinetik's own loop in `src/core/runtime.ts` and borrow designs, not code:

- **Durability.** Our loop journals each tool call before it runs, marks uncertain effects "needs review", never replays blindly, and persists steering and background wake-ups in IndexedDB. The candidates keep loop state in memory and would re-run a half-finished call after the worker is killed. Vercel's durable `WorkflowAgent` needs a server workflow backend; Mastra is a server framework. Our agent runs on the device.
- **Size.** Our runtime plus Ajv is about 200 KB minified. The candidates add 165 KB (pi's loop) to 1.6 MB (OpenAI Agents JS); the AI SDK adds about 944 KB.
- **Model path.** We call the Responses API with a ChatGPT sign-in token, `store:false`, encrypted reasoning, a namespaced tool wrapper and an optional same-origin relay. Only pi-ai knows this sign-in, and it detects it by base URL, which our relay breaks.
- **Maturity.** pi reached 1.0.0 and was renamed on 2026-10-01; its durable harness (`pi-durable`) is labelled experimental. Revisit it once stable.

What we take from others: pi's compaction algorithm, follow-up queue semantics, tool errors returned as results, and event names; the AI SDK's handling of OpenAI server-side compaction.

## What we have and what is missing

| Area                                                                     | Status                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Agent loop, tool calls, schema validation (Ajv), abort                   | have                                                                      |
| Steering mid-turn, persisted; stale responses dropped                    | have, stronger than pi                                                    |
| Crash-safe resume mid-tool, no blind replay, review of uncertain effects | have, beyond pi                                                           |
| Background jobs that wake the conversation, routines                     | have                                                                      |
| Plugins, MCP over HTTP, MCP Apps widgets, native skills                  | have                                                                      |
| Transport retry with backoff                                             | have                                                                      |
| Token usage and context-window awareness                                 | missing                                                                   |
| Compaction                                                               | missing: `modelInput` only grows; caps are 1,000 messages and 20 steps    |
| Overflow recovery                                                        | missing: a context error stops the turn                                   |
| Recoverable errors returned to the model                                 | missing: invalid arguments stop the turn; every tool error goes to review |
| Follow-up queue (run after the turn ends)                                | missing: every message steers                                             |
| Image input to the model                                                 | missing: attachments reach the model as file paths                        |
| Structured progress events                                               | partial: text drafts only                                                 |
| Memory across chats, approvals before risky actions, choice questions    | missing                                                                   |
| Multiple providers, parallel tools, sub-agents                           | missing, not needed yet                                                   |

## Plan

Each item ships as its own PR with tests. Sizes are rough working days.

### Phase 1: reliability on long tasks (about 1–1.5 weeks)

**1.1 Usage and context accounting** (1–2 days)

- Read `usage` from the final `response.completed` event in `readResponse` (`src/core/openai-model.ts`), return it with the model step and persist the last value on the conversation.
- Context window per model: read it from the `/models` catalog if present (unverified), otherwise a per-model table with a conservative default.
- Done when: usage is stored per turn and visible in step details; a unit test covers the parser.

**1.2 Compaction** (3–4 days)

- First try OpenAI server-side compaction (`context_management` with a `compact_threshold`, documented as working with `store:false`), with our sign-in token, both direct and through the relay. If rejected, try `/responses/compact`. Fallback, always available: a local summary in pi's style.
- Rules: compact only when no tool call is pending; never split a call from its output; keep the recent tail, including encrypted reasoning, verbatim; replace only the model input in one atomic write; archive the older part under its own key. No side effects, so redoing it after a crash is safe.
- Trigger at a share of the context window (for example 75%), and on demand.
- UI: a quiet "Summarised earlier messages" line in the chat.
- Done when: a long scripted conversation stays under the threshold, keeps working after a forced worker restart mid-compaction, and the answer still uses facts from the summarised part.

**1.3 Overflow recovery** (1 day)

- On `context_length_exceeded`, or an incomplete response with reason `max_output_tokens`, compact once and retry the same step. A second failure stops the turn with a clear message.

**1.4 Recoverable errors go back to the model** (1–2 days)

- Invalid arguments, unknown tools, and errors from Kinetik-owned read-only tools (`read`, `list`, `read_skill`) become an error tool result the model can act on.
- Tools with possible side effects keep "needs review". Do not trust a server's `readOnlyHint` for this.
- Done when: a missing-file read or a bad argument leads to a corrected call in the same turn; a failing write still goes to review.

**1.5 Step limit with a repetition guard** (half a day)

- Raise the fixed 20-step cap (for example to 60), and stop early when the same call with the same arguments repeats.

### Phase 2: fits the way Kinetik is used (about 2 weeks)

**2.1 Image input** (2 days). Send image attachments as `input_image` parts (downscaled, using the existing preview pipeline) alongside the file path, so the model can see photos it is asked to use.

**2.2 "Queue after" next to steering** (1–2 days). Messages carry a kind: steer (joins at the next tool boundary, today's behaviour) or follow-up (runs when the turn would end). The composer offers both while the agent works.

**2.3 Notification when long work finishes** (2 days). An Android notification and a web notification (with permission) when a turn or background job completes while the app is not in front.

**2.4 Memory across chats** (2 days). A short user note ("about me and my preferences") added to the instructions of every chat; the agent can propose edits, the user confirms. Editable in Settings.

**2.5 Approval before risky actions** (2–3 days). Tools or plugins mark actions that publish, send, pay or delete. The turn pauses on an approve/cancel card; the decision is journaled so a restart never runs an unapproved action.

**2.6 Choice questions** (1–2 days). A tool that asks the user to pick between options, shown as tappable buttons; the answer returns as the tool result.

### Phase 3: polish and scale (about 1 week)

**3.1 Structured events.** Tool start/end, reasoning-summary deltas and compaction events feed the activity line ("Building slides… step 3") instead of polling for drafts.

**3.2 Smaller saves.** Move `modelInput` and archived history out of the conversation record so each step does not rewrite every encrypted blob.

**3.3 Reasoning summaries.** Show a short live summary of what the model is thinking.

### Later, only if needed

- More providers (Claude, Gemini) through pi-ai behind our `Model` interface. Needs provider-neutral stored history; only local-summary compaction works across providers.
- Running several read-only tools at once.
- Sub-agents for large tasks.
- Re-evaluate pi-durable when it is no longer experimental.

## Rules for every change

- A restart at any point must not repeat a side effect or lose a user message. Each PR adds a worker-kill test for its new state.
- Anything that changes what the model sees (compaction, memory, images) is visible to the user in plain words.
- Tested in the mock model and against fixtures; real ChatGPT behaviour is checked by hand and reported as such.

## Open questions

- Does our ChatGPT sign-in token, direct and through the relay, accept `context_management` or `/responses/compact`? This decides 1.2's implementation.
- Does the `/models` catalog expose a context window?
- Can older reasoning items be dropped safely when replaying the tail?
- Which Charms tools should be marked as needing approval (2.5), and who maintains that list?
