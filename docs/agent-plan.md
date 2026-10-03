# Agent runtime plan

Status: **built, not merged** (2026-10-02). Every item below is implemented and tested against the mock model and fixtures in #28 (Phase 1), #29 (Phase 2), #30 (Phase 3) and #31 (the "Later" items and server-side compaction), stacked in that order. Real ChatGPT behaviour, and a real OpenAI-compatible server, are not yet checked by hand. The relay change it relies on is kineto-app/kineto#5128.

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

| Area                                                                     | Status                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Agent loop, tool calls, schema validation (Ajv), abort                   | have                                                                        |
| Steering mid-turn, persisted; stale responses dropped                    | have, stronger than pi                                                      |
| Crash-safe resume mid-tool, no blind replay, review of uncertain effects | have, beyond pi                                                             |
| Background jobs that wake the conversation, routines                     | have                                                                        |
| Plugins, MCP over HTTP, MCP Apps widgets, native skills                  | have                                                                        |
| Transport retry with backoff                                             | have                                                                        |
| Token usage and context-window awareness                                 | built (1.1, #28)                                                            |
| Compaction                                                               | built: ChatGPT compaction first, local summary fallback (1.2, #28, #31)     |
| Overflow recovery                                                        | built (1.3, #28)                                                            |
| Recoverable errors returned to the model                                 | built (1.4, #28)                                                            |
| Follow-up queue (run after the turn ends)                                | built (2.2, #29)                                                            |
| Image input to the model                                                 | built, newest 8 photos within 4 MB per request (2.1, #29, #30)              |
| Structured progress events                                               | built: text, reasoning, step, tool, summarising (3.1, #30)                  |
| Memory across chats, approvals before risky actions, choice questions    | built (2.4–2.6, #29)                                                        |
| Multiple providers, parallel tools, sub-agents                           | built: one hidden OpenAI-compatible model, parallel reads, `delegate` (#31) |

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

All built in #31 except pi-durable, which was re-evaluated and not adopted (see below). More providers were narrowed by decision on 2026-10-02: ChatGPT sign-in stays the main path, and Claude and Gemini through pi-ai (built, then removed) gave way to one OpenAI-compatible model under Settings → ChatGPT → Advanced, through Kinetik's own small Chat Completions adapter rather than pi-ai.

- More providers (Claude, Gemini) through pi-ai behind our `Model` interface. Needs provider-neutral stored history; only local-summary compaction works across providers.
- Running several read-only tools at once.
- Sub-agents for large tasks.
- Re-evaluate pi-durable when it is no longer experimental.

## Rules for every change

- A restart at any point must not repeat a side effect or lose a user message. Each PR adds a worker-kill test for its new state.
- Anything that changes what the model sees (compaction, memory, images) is visible to the user in plain words.
- Tested in the mock model and against fixtures; real ChatGPT behaviour is checked by hand and reported as such.

## pi-durable, re-evaluated 2026-10-02

Not adopted. `@earendil-works/pi-durable` 1.0.0 (2026-10-01) still opens its README with "Experimental. The API changes without notice between releases." Its tool semantics are now close to ours: it commits intent before `execute()`, reruns only tools declared `replay: "safe"`, and gives other interrupted calls an error result (Kinetik asks the user to review instead). It cannot run where our agent runs, though. Its storage is memory, Node SQLite or Node JSONL; the portable cores need a SQLite facade or a file system, and there is no IndexedDB backend. It has no cross-process locking, while our runtime shares one store between the service worker and open windows through Web Locks. Revisit when the Experimental label is gone and a browser storage backend exists.

## Open questions

- ~~Does our ChatGPT sign-in token accept `context_management` or `/responses/compact`?~~ Still unverified live. #31 calls `/responses/compact` only where Kinetik would summarise anyway, falls back to the local summary on any error, and undoes a compaction the next request rejects, so either answer is safe.
- ~~Does the `/models` catalog expose a context window?~~ Yes: `context_window` with `effective_context_window_percent` (272,000 × 95% for the default model). It also lists `input_modalities`.
- Can older reasoning items be dropped safely when replaying the tail? Not needed so far: summaries keep the tail verbatim, and only other providers skip OpenAI's encrypted reasoning.
- Which Charms tools should be marked as needing approval (2.5), and who maintains that list? Open. Approval follows the MCP `destructiveHint` annotation; whether Charms sets it on `files_delete` and publishing tools is unchecked.
- New: the Kineto relay hid every upstream error body, so overflow reported as an HTTP 400 was not recognised. kineto-app/kineto#5128 passes back an allowlisted `error.code` and relays `/responses/compact`.
- New: pi-ai would have added about 670 KB to the web worker bundle and 1.29 MB to the web precache; that is one reason the custom model uses a small adapter of our own instead.
