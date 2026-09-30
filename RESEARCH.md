# Kinetik OSS: feasibility findings

Checked 2026-09-30. This replaces the initial broad proposal with research against the accepted [v1 design](DESIGN.md). A local prototype now implements the browser runtime; [README.md](README.md) describes the tested scope. Findings distinguish documentation, checkout inspection, HTTP observations, and browser experiments.

## Result

The local TypeScript agent, virtual filesystem, just-bash, native skills, and runtime-installed plugins have a credible browser implementation path. The exact requested product cannot yet be described as officially supported end to end.

| Requirement                                     | Finding                                                                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launcher exits; PWA retains ChatGPT credentials | Conflicts with OpenAI's documented instruction to keep tokens out of browser storage. Encryption has no stated exception.                                                                                   |
| Direct OpenAI requests                          | Tested preflights allow hosted and localhost origins. A separate Node helper verified authenticated subscription streams; browser authentication and refresh remain untested.                               |
| Hosted PWA to Charms                            | Same-origin endpoint avoids CORS. Authentication and real tool execution remain untested.                                                                                                                   |
| Localhost PWA to Charms                         | Tested preflights reject localhost; current source has no MCP CORS allowance. Requires a targeted backend change or changed architecture.                                                                   |
| Runtime plugins in a service worker             | ESM dynamic import is unavailable. A trusted factory evaluated from cached source worked in Chromium, including worker restart.                                                                             |
| Continuous closed-browser execution             | Not guaranteed. Persist/recover at available wakes, as accepted.                                                                                                                                            |
| Native Charms skill refresh                     | Catalog and per-skill versions exist. Two live inventory skills need refresh independent of versions.                                                                                                       |
| Local static server exits completely            | App shell must first be cached at a stable local origin. Automated Chromium tests now confirm the process exits and a new tab reopens the app without a server. OS-level PWA installation remains untested. |

## 1. Official ChatGPT plan access

OpenAI documents dynamic registration for OSS clients, a callback on HTTP `127.0.0.1`, PKCE, state/nonce validation, an issued client ID, and protected credential persistence. A phone's loopback does not reach a launcher on another machine. The official remote-VM procedure uses local authorization and secure credential transfer to a protected runtime; it does not establish a browser-storage flow. [Registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).

The credential guidance explicitly says, "Keep tokens out of browser storage" and covers access, refresh, and retained ID tokens. The documented implementation uses protected local or self-hosted runtime storage, without an encrypted IndexedDB/OPFS exception. Persistent PWA credentials, no surviving helper, and documented official support are therefore incompatible under the currently documented design. This is a documentation conflict, not a claim that browser encryption is technically impossible. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#credential-security).

The new official cookbook does not resolve this: its Electron example keeps authentication, storage, and API requests in the main process; the UI bridge does not receive tokens. Its devkit may simplify a native launcher, but adoption would not satisfy the selected process-exit requirement. No devkit dependency was installed or adopted, and its license has not been reviewed for reuse. [Official cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).

Use the public `/v1/responses` API and the account's model catalog. This flow requires streaming, `store: false`, and client-owned history; hosted MCP and several ordinary Responses parameters are unsupported. Encode its documented tool format and handle terminal failures even after text arrives. OpenAI's OSS/local availability statements are not specific approval of this browser credential architecture or the paid Charms combination. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [overview](https://developers.openai.com/siwc/token-sharing-open-source).

**Required next evidence:** official clarification or a documented flow allowing this PWA to retain and renew credentials after the launcher exits. Otherwise the product requirements must change explicitly. No persistent bridge, private ChatGPT endpoint, alternate billing provider, or native wrapper is silently substituted.

### Live subscription check

On 2026-09-30, an explicitly authorized temporary Node helper completed the official OAuth flow, verified the ID token signature/issuer/audience/nonce, checked the granted `chatgpt.tokens.use.direct` scope, and listed the account's models. With the returned OAuth access token, `gpt-6-astra` produced `KINETIK_SUBSCRIPTION_OK` through the public Responses API. No API key or alternate billing path was used.

The same temporary connection exercised this repository's `Runtime` and `OpenAIModel`, with ephemeral IndexedDB emulation in Node. The model used local file tools and returned `KINETIK_LIVE_TOOL_OK`. In a separate live background run, it started `exec` through the `background` tool, ended its turn, and left the conversation idle. Process completion then woke that conversation once and the model returned `KINETIK_LIVE_BACKGROUND_OK`. No model polling was needed. The helper revoked its temporary renewable session and exited; tokens were kept in process memory, never browser storage or source control.

The live stream exposed a parser defect: complete output items arrived in `response.output_item.done`, while `response.completed.output` was empty. The adapter now retains those completed items in output order and still requires the terminal success event. Regression tests cover text, tool calls, reasoning items and incomplete output. An intermediate background diagnostic hit the helper's request cap; the final run passed after increasing the test allowance.

This verifies subscription access and selected core-runtime behavior, **not an authenticated PWA**. The PWA still uses the mock model under the mandatory launcher-exit requirement. Token refresh, browser subscription requests, live Charms access, and continuous mobile execution are not established by this check.

## 2. Direct network access

Unauthenticated OPTIONS probes used `Origin: https://kineto.app` and `Origin: http://127.0.0.1:4173`. No credentials, token exchanges, inference, or MCP tool calls were used. [Recorded requests and headers](research/http-probes-2026-09-30.json).

| Endpoint                          | Hosted origin                            | Localhost origin | Interpretation                                                           |
| --------------------------------- | ---------------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| OpenAI `/v1/responses`            | 200, ACAO `*`, requested headers allowed | Same             | Preflight allows proposed JSON/bearer request.                           |
| OpenAI `/v1/models`               | 200, ACAO `*`, authorization allowed     | Same             | Preflight allows model-list request.                                     |
| OpenAI OAuth token endpoint       | 200, ACAO `*`                            | Same             | No observed preflight obstacle.                                          |
| `kineto.app/api/charms/mcp`       | 200, no ACAO                             | 403, no ACAO     | Hosted same-origin calls need no CORS; local cross-origin calls blocked. |
| `kineto.app/mcpoauth/token`       | 200, no ACAO                             | 403, no ACAO     | Local Charms authentication also affected.                               |
| Charms authorization metadata GET | 200, no ACAO                             | 200, no ACAO     | Shell can read it; cross-origin browser JS cannot.                       |

ACAO means `Access-Control-Allow-Origin`. Preflights do not prove authenticated success/error responses, SSE, renewal, or all required headers work. A form-encoded token request may not require a preflight at all, but its actual response still needs the applicable CORS headers. Wildcard CORS is not sufficient for requests including cookies. [CORS rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

Public Charms metadata currently advertises `https://kineto.app/mcpoauth` and endpoints on that host. The selected hosted PWA can therefore call them same-origin. Use discovery rather than assuming every deployment has that base URL.

Localhost support needs deliberate CORS on MCP and the relevant OAuth/discovery endpoints, permitted protocol/bearer headers and methods, and exposed session/challenge headers. Test error responses and streams. Keep this separate from cookie-based Kineto authentication; do not simply enable arbitrary credentialed origins. No backend change or deployment was performed.

## 3. Current Charms code

Inspected `kineto-app/kineto` at commit `abfb798cbfacd5d74b7985faf1a736298bce181e` in the current task worktree. The earlier research used an older checkout. These are code observations, not verification that the same commit is deployed.

- CORS is deliberately limited to widget paths; MCP remains same-origin. [Security configuration](https://github.com/kineto-app/kineto/blob/abfb798cbfacd5d74b7985faf1a736298bce181e/cloud/backend/src/main/kotlin/com/jetbrains/matterhorn/charms/security/CharmsSecurityConfiguration.kt#L95).
- `server/discover` supports revision `2026-07-28`; `initialize` retains `2025-11-25` and `2025-06-18`. Home-file resources and subscriptions now exist, but are not a general agent scheduler. Pin/negotiate a compatible MCP client. [MCP controller](https://github.com/kineto-app/kineto/blob/abfb798cbfacd5d74b7985faf1a736298bce181e/cloud/backend/src/main/kotlin/com/jetbrains/matterhorn/charms/controllers/CharmsMcpController.kt#L894).
- OAuth advertises public-client authorization code with S256 and no refresh grant. Keep Charms and OpenAI credentials separate. [OAuth metadata](https://github.com/kineto-app/kineto/blob/abfb798cbfacd5d74b7985faf1a736298bce181e/cloud/backend/src/main/kotlin/com/jetbrains/matterhorn/controllers/agents/ExternalOAuthMetadataController.kt#L58).
- Workspace tool names support the intended replacement group. Aliases alone do not adapt argument/result schemas, continuation reads, or provider constraints. [Tool descriptors](https://github.com/kineto-app/kineto/blob/abfb798cbfacd5d74b7985faf1a736298bce181e/cloud/backend/src/main/kotlin/com/jetbrains/matterhorn/charms/controllers/CharmsServerDescriptors.kt#L123).

### Native skill refresh

`charms_skill_find` returns the installed set, `catalog_version`, and each skill's name, description, `charm_version`, and sandbox path. Follow every page before treating an absent skill as removed. If the catalog changes mid-pagination, restart rather than mixing generations. [Catalog listing](https://github.com/kineto-app/kineto/blob/abfb798cbfacd5d74b7985faf1a736298bce181e/cloud/backend/src/main/kotlin/com/jetbrains/matterhorn/charms/services/CharmsCatalogTools.kt#L34), [pagination](https://github.com/kineto-app/kineto/blob/abfb798cbfacd5d74b7985faf1a736298bce181e/cloud/backend/src/main/kotlin/com/jetbrains/matterhorn/charms/services/CharmsToolPages.kt#L60).

`charms_skill_load` returns instructions and metadata, sometimes requiring continuation reads. Import complete text and preserve source path/revision. Remote skill scripts do not become runnable in browser just-bash by copying their instructions. Materialization/read paths can wake the remote sandbox. [Skill loading](https://github.com/kineto-app/kineto/blob/abfb798cbfacd5d74b7985faf1a736298bce181e/cloud/backend/src/main/kotlin/com/jetbrains/matterhorn/charms/services/CharmsCatalogTools.kt#L181).

`kineto.agents` and `kineto.connections` generate user-specific inventories at load time while keeping the generic package version. A version-only cache misses changes: reload those two per message independently. [Versioning and dynamic bodies](https://github.com/kineto-app/kineto/blob/abfb798cbfacd5d74b7985faf1a736298bce181e/cloud/backend/src/main/kotlin/com/jetbrains/matterhorn/charms/services/CharmsCatalogService.kt#L172).

Keep discovery/loading internal to plugin synchronization. The model sees the native skill index and uses `read_skill`. Existing skill text can still reference `charms_*` tools and remote paths; preserve usable aliases or supply explicit environment mapping.

Some skills depend on `charms_render` and interactive connection UIs. Importing all skills alone does not implement MCP Apps. The browser runtime now implements a tested subset of MCP Apps; live Charms rendering remains unverified. Make unavailable capabilities visible rather than silently expanding v1 or claiming all skill workflows function.

## 4. Plugin loading and background execution

A GitHub blob page is HTML, not an executable module. The tested raw JS endpoint returned `text/plain` plus `nosniff` and CORS `*`; the contents API returned CORS-readable JSON. Resolve repo links to one commit, fetch source bytes as data, cache them, and execute the installed representation. An arbitrary HTTPS host must also permit fetching its content. [Contents API](https://docs.github.com/en/rest/repos/contents), [module MIME rules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules#troubleshooting).

Service workers reject ESM dynamic `import()`. After installation, `importScripts()` cannot add a new script URL to its fixed script-resource map. Blob import is not a workaround: `URL.createObjectURL` is also unavailable there. [Dynamic import](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import), [service-worker import algorithm](https://www.w3.org/TR/service-workers/#importscripts), [createObjectURL](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static).

**The factory alternative worked in a narrow browser experiment.** An activated HeadlessChrome 154 service worker fetched and cached a self-contained factory body, evaluated it with `Function`, and ran its asynchronous tool. After forced worker termination and removal of the plugin source from the server, a new worker instance executed the cached factory successfully. Standard ESM and late importScripts failed as expected. [Reproduction and evidence](research/service-worker-plugin-probe/README.md).

This approach requires worker CSP permission for string compilation, such as `script-src 'self' 'unsafe-eval'`. It matches the accepted trusted-plugin model but is now used by the prototype. Scope the policy to the worker response; do not silently weaken the main site's CSP. Authors prebundle imports into the factory; the PWA does not build TypeScript/npm projects. [CSP compilation rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src#unsafe_eval_expressions), [worker CSP](https://www.w3.org/TR/service-workers/#content-security-policy).

The experiment proves neither Safari/Firefox compatibility nor natural mobile background behavior. Service workers can terminate despite `waitUntil`; dedicated workers do not guarantee headless execution either. Persist/recover at available wakes. Web Locks can coordinate ownership but cannot determine whether an interrupted external side effect completed. [Worker lifecycle](https://web.dev/learn/pwa/service-workers), [worker overview](https://web.dev/articles/workers-overview), [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API).

The `Worker` constructor is not exposed to service workers. Consequently, a headless service-worker loop cannot create a dedicated child worker to hard-cancel a CPU-bound shell command independently. Bounded/cooperative tool execution needs testing there; a page-owned dedicated worker is a different execution arrangement. [HTML worker interface](https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface).

## 5. Filesystem and app delivery

The current just-bash browser core supports shell-like file/text commands, with a nonpersistent default filesystem. Its asynchronous filesystem adapter is a candidate for IndexedDB; concurrency and filesystem semantics require implementation. Python, SQLite, js-exec, and native filesystem backends are Node-specific in the current documentation. The subsequent prototype bundles just-bash 3.4.2 with an IndexedDB-backed operation wrapper and exercises it in unit and browser tests. Compression commands are excluded; the browser bundle substitutes an explicit unavailable stub for the upstream static node:zlib import. [README](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md), [filesystem interface](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/src/fs/interface.ts).

A shared transactional filesystem avoids whole-snapshot overwrite between parallel conversations. Operation-level atomicity does not make a compound shell command transactional. Browser storage is origin-scoped and can be cleared/evicted; localhost and the hosted PWA have different data. OPFS does not grant unrestricted host filesystem access. [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API), [storage durability](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).

A `/kinetik-oss/` worker scope does not isolate storage or trusted plugin privileges from `kineto.app`. Actual main-site CSP and service-worker routing need checking before deployment; the owner accepted this shared origin for now. [Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).

Localhost is a potentially trustworthy context for service workers; plain HTTP on another machine's LAN address is not equivalent. Remote self-hosting needs HTTPS. For the entire local launcher to exit, finish caching the app shell first and keep the local origin stable. Test actual reopening with the server stopped, not only the still-open page. [Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), [offline/background operation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation).

## Recommended sequence and limits

1. Resolve official permission/design for browser credential storage before advertising subscription support.
2. Confirm the factory plugin format/CSP in other target browsers. Retain the Chromium proof as narrow evidence.
3. Build the smallest local slice with a mock model transport: chat, loop, shared persistent filesystem, just-bash, steering, Stop, recovery. No real model auth is implied.
4. Add plugin install/update and native skill sync; verify Charms mappings and dynamic inventory using a controlled account.
5. Make the reviewed Charms CORS changes needed for localhost, then test OAuth/tool streams in-browser.
6. Validate mobile suspension, offline reopening after complete process exit, and shared-origin deployment.

Initial feasibility probes used no account credentials. The subsequent live subscription check above used authorized OAuth tokens only in a temporary Node process and then revoked its session. No live MCP tool command or deployment was performed. The local prototype has been built and tested. Temporary probe processes were stopped. The repository uses its existing MIT license and the unpublished package name kinetik-oss. The final model SDK, broader browser support matrix, and credential architecture remain unresolved.

## 7. A simple interface for everyday tasks

Reviewed current first-party agent UI guidance on 2026-09-30. These are design references, not evidence that Kinetik has their model capabilities.

- [Claude Cowork’s getting-started flow](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) centers on describing a task, following progress, steering mid-task, and receiving usable results. Kinetik adopts plain task starters, unobtrusive progress, and file cards with Open/Download actions. Its preview starters are explicitly fixed examples.
- [OpenAI’s UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines) favor focused inline cards for actions and results. Kinetik keeps files and interactive MCP results in the conversation; verbose tool output sits behind an expandable step.
- [Microsoft’s agent design foundations](https://learn.microsoft.com/en-us/agents/design-guidelines/design-foundations) cover the whole interaction, including first use, control, and recovery. [HAX guidance](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/) emphasizes making capabilities and limits clear. Kinetik labels the preview and pending ChatGPT connection, keeps Stop and recovery actions available, and puts connection configuration under Settings.

The UI/UX Pro Max skill’s AI-native UI and loading-feedback guidance informed the minimal chrome, visible composer, and accessible progress indicators. Existing Charms design tokens, action rows, panels, and light/dark themes remain the visual source. These changes have automated accessibility and interaction coverage; they have not yet been usability-tested with nontechnical participants or on physical mobile devices.
