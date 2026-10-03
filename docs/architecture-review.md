# Agent architecture review

Review of 2026-10-02 at commit `5d6fb24` (the agent stack #28–#31), by seven independent reviewers: three on Claude Opus 5.5 and four on Claude Fable. Each rated one aspect from 0 to 10 and proposed changes. The goal they rated against: simple, maintainable, scalable, platformized and production-ready, following KISS, DRY and SOLID. References below name files and functions rather than line numbers, because the first step of this plan moved most of the code.

## Verdict

About **5 / 10**. The ideas are good. They were packed into too few files, and a handful of real bugs must be fixed before production. The core design choices are right, and every reviewer said to keep them.

| Aspect                                   | Reviewer | Score | In one line                                                                                                                             |
| ---------------------------------------- | -------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Core loop                                | Opus     | 4     | `Runtime.run` was one 525-line method; `Runtime` held about 20 responsibilities; the result-recording shape was copied about nine times |
| Overall structure                        | Fable    | 5     | Layers existed in spirit, but the core imports concrete browser storage and `plugins` and `connections` depend on each other            |
| Tests, operations, UI                    | Fable    | 5     | Tests are strong (7); there is no logging at all (2); `main.ts` mixes imperative DOM and Solid (4)                                      |
| Tools and safety                         | Fable    | 5.5   | "Is this tool safe" is decided in five places                                                                                           |
| Durability and storage                   | Fable    | 5.5   | Crash safety 8; storage growth 3; no schema versioning                                                                                  |
| Model layer                              | Opus     | 5.5   | The `Model` interface is the right seam; the adapters duplicate code; ChatGPT is wired through a fake `fetch`                           |
| Against pi-mono and the DeepSeek harness | Opus     | 6.5   | Ahead on crash safety and remote-job recovery; behind on loop structure, events and compaction                                          |

## Keep

- Journal-before-execute: a tool call is saved as pending before it runs, a remote operation checkpoints its id, and an uncertain outcome becomes "needs review" instead of a blind replay.
- Steering only at step boundaries, and the persisted follow-up queue.
- The small `Store` (key-value with transactional `update` / `updateMany`) and the small `Model` interface (`next`, `pin`, `compact`).
- Model input stored in append-only segments, with the update detecting an append by array identity.
- One `RuntimeHost` serving both the service worker and the Tauri WebView.
- The PWA update protocol: build-id cache namespace, no activation while work runs, the old worker fenced off.
- Worker-kill tests for each new persisted state; the mock model, fake IndexedDB and Playwright fixtures.
- Narrow interfaces between `Runtime` and its parts (`AutomationHost`, `BackgroundHost`).

## Bugs found

Each was traced in the code. All seven are fixed in step 1 (#33), each with a regression test that failed before the fix. What the fixes leave on purpose is listed under Status.

1. **Approval bypass (security).** `background` start (`core/background.ts`) never checks `tool.approval`, so a tool that needs approval, such as `charms_files_delete`, runs without a card when the model starts it as a background job. A widget's `tools/call` (`AppCalls.call`) has the same gap.
2. **Widgets can speak as the user.** An MCP App's `ui/message` (`ui/mcp-app.ts`) is submitted as a user message straight away. A compromised widget could ask the agent to run a command in the sandbox, and `charms_exec` needs no approval. Put the text in the composer instead.
3. **A turn does not fully keep its model.** `ModelRouter.pin` returns only the provider choice. The ChatGPT model and reasoning effort are read again from the session on every request, so switching mid-turn changes the model mid-turn. `no-server-compact:` is keyed by provider, not by model.
4. **Stop strands queued messages.** `Runtime.stop` clears `pending` but leaves `message.queue = 'after'`; the message shows "Queued" forever and never runs.
5. **Full scans of the whole database.** `Store.entries(prefix)` opens a cursor over every record and filters by prefix in JavaScript. It runs on every `state` request, every 15-second tick and every background sync, decoding attachments and archives each time. Use `IDBKeyRange.bound(prefix, prefix + '￿')`.
6. **Unbounded growth.** Nothing deletes `model-archive:`, `app:`, `app-call:`, `background:`, `shared-file:`, `skills:` caches or sent `attachment-preview:` records, and there is no way to delete a chat. `app:` and `background:` records each store a full copy of every pinned plugin's code.
7. **No schema version.** The database is opened at version 1 with no record version. Old shapes are handled forever in hot paths: the inline `modelInput` move in `ConversationStore.update`, and a notice-text match in `recoverWork`.

Smaller findings:

- A missing model-input segment makes `ConversationStore.load` retry with no bound. (Fixed in step 5.)
- `OpenAIModel` does not wrap its own `fetch` failures, unlike `CompatModel`. (Step 4 wraps them as `ConnectionError`; the runtime already treated them as one.)
- Any plain `Error` undoes a ChatGPT compaction and switches it off for good, including a malformed tool argument. (Fixed in step 4.)
- `selectModel` fails sign-in when the catalog lacks `gpt-6.1-sol`. (Fixed in step 4.)
- The helper and parallel reads only accept `provider === 'local'` tools, so with Charms active the helper has only `read_skill`. (Fixed in step 2.)

## Comparison with pi-mono and the DeepSeek harness

**pi-mono** ([earendil-works/pi](https://github.com/earendil-works/pi), all packages 1.0.0 since 2026-10-01):

- `pi-agent-core` is an in-memory loop of about 1,100 lines, with hooks: `transformContext`, `beforeToolCall` / `afterToolCall`, steering and follow-up queues.
- Tools return `{content, details, isError}`, can stream updates, and declare `executionMode` and `replay`.
- `pi-ai` covers about 40 providers under one message model.
- `pi-durable`, still marked Experimental, commits each step and reruns only tools declared `replay: "safe"`. It stores to memory, Node SQLite or JSONL.

**DeepSeek Harness, "dsh"** ([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), MIT, developer preview; [InfoQ, 2026-08-20](https://www.infoq.com/news/2026/08/deep-seek-harness/)):

- A Cordis microkernel with about 80 plugin packages; only `dsh-agent-loop` holds loop logic.
- The session is an append-only event log, and model history is a view built from it. Compaction appends replacement events and keeps the originals.
- After a crash the model is told `TOOL_NOT_STARTED` or `TOOL_OUTCOME_UNKNOWN`.
- Tools pass through pre-execute (allow, deny or ask), a guard, execute, then post-execute. They run in parallel only when `isConcurrencySafe(args)` says so.
- Compaction first shortens old tool results to their head and tail, saving the full text to a file, and only then summarises.

**Kinetik is ahead on:** crash safety in a browser worker (journal plus "needs review" instead of telling the model "unknown", and Web Locks across the worker and windows), reattaching to remote jobs (`checkpoint` / `recover` / `wait` / `cancel`), and size (about 200 KB with Ajv).

**Kinetik is behind on:** a small loop with explicit hooks, tools declaring their own safety, typed lifecycle events with streamed tool output, compaction inside one long turn, and storing chat messages append-only.

**Adopt (designs, not code):**

1. Shorten old tool results and cut by token budget, so one long turn can be compacted. Today `splitPoint` keeps everything after the latest user message, so a single 60-step task cannot shrink.
2. Tools declare their own effects, and the name sets in the runtime go away.
3. A tool pipeline with named steps: validate → ask → execute → classify → record.
4. Typed `turn_*` and `tool_*` events with streamed tool output.
5. Store chat messages append-only, like model input.
6. Mark a call "started" separately from "pending", so a call that never began isn't sent for review. Honor `Retry-After` on 429.

**Do not copy:** the microkernel and 80-plugin layout; pi-ai or pi-durable as dependencies (bundle size, no IndexedDB backend, Experimental); telling the model "outcome unknown" for actions that send, pay or delete; saving every stream chunk; session trees and branching; dropping the step cap or approvals.

## pi-durable, from its announcement

[The pi-durable post](https://earendil.com/posts/pi-durable/) describes the following design:

- Every step runs as a task that commits a checkpoint before moving on.
- Transcript and typed state change in one commit.
- After a crash, model requests rerun, and interrupted answers are kept and marked aborted.
- Tools declared `replay: "safe"` rerun; other tools report the interruption to the model with their partial output.
- A `requestId` makes each submission exactly-once.
- Sub-agents are conversations owned by a tool call. They keep their own checkpoints and are found again after a restart.
- Compaction runs in the background and blocks only when the next request would not fit.
- Watchers get the committed state once, then only changes.
- Conversations store tool and extension names, never code.
- The post marks the project as experimental.

What Kinetik takes from it:

- **Idempotent submit.** Let `submit` honour a client-chosen message id, which it already accepts, as a dedupe key. A retried send after a worker restart then never posts twice. (Step 5.)
- **Background compaction.** Start summarising at the threshold without blocking the turn, and wait only when the next request would overflow. (Step 6, with long-turn compaction.)
- **Changes, not snapshots, to windows.** Send the state once, then only changes. This is the same as step 5's lighter `state`.
- **Owned sub-agents.** Persist the `delegate` helper's progress as a child conversation, so a restart continues it instead of starting over. (Step 6.)
- **Keep aborted partial answers, marked as aborted,** instead of dropping the draft. (Step 6, with typed events.)

What it does not take:

- Telling the model "interrupted" for side-effecting tools. Kinetik keeps the user review.
- Storing tool names instead of code. Kinetik pins code per turn by digest (step 1), so a plugin update cannot change a running turn.

## Structure after this change

```
src/
  core/                      agent core
    runtime.ts               turn loop, steering and queue, one tool call in named steps, asks, stop (1,029 lines, from 1,845)
    turn.ts                  the Turn record: endTurn, withTurn, withCall, openCall
    recovery.ts              what a restart does with work a dead worker left behind
    migrations.ts, cleanup.ts  schema versions; the startup sweep and chat deletion
    trace.ts                 the local activity log of model requests and tool calls
    protocol.ts              RPC op names and the window–worker protocol version
    ports.ts, memory-store.ts  the Store the core needs; an in-memory one for Node and evals
    conversation-store.ts    conversation records; model input in append-only segments
    attachments.ts           staged files, uploads, photo previews for the model
    compaction.ts            context limits, local summaries, ChatGPT compaction and its undo
    read-only.ts             read-only tools, parallel calls, the delegate helper agent
    apps.ts                  MCP App widget tool calls and their journal
    workspace-files.ts       files browser, import and export
    prompt.ts                system instructions, built-in skill, tool definitions for the model
    model-input.ts           function_call_output items, printable tool results
    abortable.ts             promise that rejects when a signal aborts
    tools.ts, background.ts, automation.ts, archive.ts, skills.ts, types.ts, host.ts
  models/                    model adapters behind the Model interface
    model-http.ts            shared by both adapters: SSE events, HTTP errors, tool names, step shaping, images
    openai.ts                Responses API over an injected transport (ChatGPT sign-in, helper)
    compat.ts                OpenAI-compatible Chat Completions
    router.ts                per-turn choice between ChatGPT and the custom model
    mock.ts                  deterministic test model
  connections/               sign-ins and settings: chatgpt.ts, custom-model.ts, manager.ts, config.ts
  plugins/                   plugin loader and MCP client
  browser/, platform/        IndexedDB store, filesystem, service-worker client, Tauri adapters
  ui/                        Solid components and the imperative main.ts
```

## Plan

Each step is small enough for one PR. The order puts risk first.

1. **Fix the bugs above.** S–M. Gate every execution path through the approval check (background start and widget calls). Widget messages fill the composer. Pin `{provider, model, effort}` per turn and key `no-server-compact:` by it. Stop clears the queue flags. `Store.entries` uses a key range. A schema version `meta:schema` with a migrations list run once at startup, a startup sweep, a delete-chat op, and plugin code stored once by digest.
2. **One place for tool safety.** S–M. Add `readOnly` and `command` to `ToolDefinition` next to `approval`, set them in `localTools`, the MCP mapping and the Charms adapter, and delete the `readOnlyLocal`, `parallelSafe` and `rerunnable` sets and the `__charms_exec` suffix test. Replay safety still comes only from `provider === 'local' && readOnly`, never from a server's `readOnlyHint`. No `host` field: the binding's provider already says where a tool runs.
3. **Finish splitting the turn.** M.
   - **Turn state:** one `Turn` object on the conversation instead of about ten flat optional fields, and one `endTurn()` that every exit and `stop` use.
   - **Call states:** explicit `proposed | approved | started | completed | unknown | awaiting` instead of the two-meaning `approved` flag.
   - **Tool pipeline:** move it out of `run` into named steps.
   - **Recovery:** move `recoverWork` to `recovery.ts`.

   This changes the persisted shape, so it ships a migration on step 1's schema version.

4. **Model layer hygiene.** S–M. Inject a `ResponsesTransport` instead of the fake `fetch`, and let `OpenAIModel` own the request body. Share one `model-http.ts` (SSE events, HTTP errors, tool-name encoding, step shaping) between both adapters. Add `ModelRejected` so only a real rejection undoes compaction.
5. **Production readiness.** S–M.
   - **Trace log:** a local per-turn trace (step, tool, model, status, ms, error), shown in Settings → Advanced and included in exports.
   - **Lighter `state` op:** returns summaries, and changes name the conversation, so windows refresh one chat.
   - **Typed RPC:** a shared op union with a protocol version.
   - **Idempotent submit:** a client message id dedupes a retried send.
6. **Later.** M–L.
   - Compaction for one long turn (adopt idea 1), started in the background.
   - Typed events with streamed tool output; an aborted partial answer is kept and marked.
   - Chat messages stored append-only.
   - Ports (`Store`, `Workspace`, `Locks`) so the core runs in Node for evals.
   - `main.ts` split by screen.
   - The `delegate` helper persisted as an owned child conversation.

**Do not:** add a state-machine library, a DI container, a middleware chain, a plugin microkernel or a rewrite. Five to eight focused modules are enough.

## Status

- **Done:**
  - Step 0, the structure move above (#32). It is a pure move with no behaviour change.
  - Step 1, all seven bugs (#33):
    - every execution path checks approval, and widgets ask before an approval-gated call;
    - widget messages fill the composer;
    - a turn pins provider, model and effort;
    - Stop clears queue flags;
    - prefix reads use key ranges;
    - a schema version with migrations;
    - a startup sweep at most once a day, chat deletion, and plugin code stored once by digest;
    - a finished background job whose chat is gone is marked delivered instead of blocking startup.
  - Left on purpose by step 1:
    - `app:` records stay while their chat exists, because a widget re-renders from them; deleting the chat removes them.
    - `ConversationStore.update` still reads inline `modelInput`, because migration 1 moves old chats through it instead of copying that logic.
    - The helper-mode ChatGPT session pins only the provider; the helper picks model and effort on its side.
    - A pinned model name is checked for shape, not against the catalog.
    - An older build opening a newer schema runs no migrations and does not warn.
  - Step 2, tool safety in one place (#34):
    - tools declare `readOnly` and `command`; the three name sets and the `__charms_exec` suffix test are gone;
    - parallel batches and the helper accept remote read-only tools, so with Charms on the helper can read files and jobs;
    - a read that needs approval, a widget tool and a model-hidden tool never run in a batch or the helper;
    - a lost connection in a batch or in the helper pauses the turn instead of failing the reads or asking for review;
    - the Charms adapter keeps sharing a file and rendering out of reads, because both publish a link.
  - Left on purpose by step 2:
    - An existing Charms install keeps its pinned adapter until the next Connect, because a link never replaces pinned code. Until then a failed Charms command shows as done in the activity list (the model still sees the exit code), and `charms_files_read` with `share` counts as a read.
    - Error-as-result and replay stay local-only, as the plan says.
  - Step 3, the turn (#35):
    - one `turn` record holds the message, kind, start time, model, usage and current call; `endTurn` clears it on every exit;
    - call states are `proposed`, `awaiting`, `approved`, `started`, `completed` and `unknown`. A call recorded but never started now runs once after a restart instead of going to review;
    - `callTool` runs one call as check, journal, ask, start, execute, record; `recovery.ts` holds restart recovery;
    - migration 5 maps old calls: `pending` + `approved` to `approved`, plain `pending` to `started` (it may have run, so it goes to review), the rest unchanged;
    - a message queued during a turn uses the model chosen when it starts, not the previous turn's.
  - Left on purpose by step 3: plugins pinned for a run and the connection-wait fields (`waitingFor`, `retryAt`, `retryAttempts`) stay on the conversation, because they outlive one turn or belong to the status.
  - Step 4, the model layer (#36):
    - `OpenAIModel` builds its request and sends it through a `ResponsesTransport`: the browser session or `httpTransport` for the helper. The fake `fetch` in `host.ts` is gone;
    - `model-http.ts` holds what both adapters share, so the Responses and Chat Completions readers differ only in their event shapes;
    - `ModelRejected` marks a request the provider refused; only it undoes a ChatGPT compaction. A malformed tool call or an unfinished answer no longer turns server compaction off, and a busy provider (`server_error`, rate limits) is a connection wait;
    - a network failure reaching ChatGPT is a `ConnectionError`;
    - a first sign-in whose catalog lacks GPT-6.1 Sol starts on the first listed model. An existing login still never switches silently.
  - Step 5, production readiness (#37):
    - every model request and tool call is recorded per chat (`trace:<id>`, last 200): kind, name, ok, time, error. Settings → Advanced → Activity log shows the newest and copies them; Export includes them, Import ignores them;
    - `state` takes the open chat's id and sends the other chats without their messages;
    - RPC ops are one shared union, and every request carries a protocol version; a window from another build is told to reload;
    - the composer sends one message id per draft, so a send retried after a failure is saved once;
    - a missing history part in an unchanged chat is reported instead of retried forever.
  - Left on purpose by step 5: change events still do not name the conversation. A refresh is now cheap, and no window would use the name; a second refresh path is not worth it.
- **Open:** step 6.
