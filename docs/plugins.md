# Plugin contract, prototype API 1

Plugins consist of `plugin.json` and one self-contained JavaScript **factory body**. This is intentionally not ESM: service workers cannot dynamically import installed modules. Authors can bundle TypeScript ahead of time. No runtime imports or build service are required by the host.

```json
{ "id": "example", "name": "Example", "version": "1.0.0", "apiVersion": 1, "entry": "plugin.js" }
```

```js
return {
  tools: {
    remote: {
      description: 'Describe the real execution environment',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false,
      },
      async execute(input, context) {
        context.signal.throwIfAborted();
        return `Received ${input.command}`;
      },
    },
  },
  replacements: { exec: 'remote' },
};
```

The factory receives `host.settings`, `host.baseURL`, `host.mcp(url, token?)`, and `host.emit(name, text, uniqueId?)`. It may return a promise. Export all tools you provide in `tools`; they become `plugin-id__tool-name`. Optional replacements map `exec`, `read`, `write`, `edit`, and `list` to one of the plugin's own tools. Mapping replaces description, input schema, and implementation together. `read_skill` always belongs to the native catalog.

Tool inputs are validated against their JSON Schema by Ajv before dispatch. `execute(input, context)` receives an abort signal and `await context.checkpoint(operationId)`. Save a remote operation ID as soon as it exists. When invoked through `background`, `context.background` is true and the context signal is independent of the originating agent turn. Optional `wait(operationId, signal)` resolves with the **final** result of an asynchronous operation. If `execute` checkpoints an ID and `wait` exists, the runtime waits for that ID before delivering the completion event. A plugin that returns a running receipt must provide this hook; otherwise the return value is treated as the completed result. After worker restart, `recover` checks the saved operation first, then `wait` reconnects if it is still running. Neither path reissues `execute`. A network failure while waiting on a saved operation pauses that wait until the app reconnects. Recovery checks the existing operation even after the original deadline, so a result completed while the browser was asleep can still be delivered; an operation still running after its deadline is interrupted.

Optional `recover(operationId, signal)` returns `{done, result}`; optional `cancel(operationId)` requests remote cancellation. If the browser dies before an ID is saved, the operation is uncertain and needs manual resolution. No host can make that gap exactly-once without server cooperation.

For native skills, return `skills.sync(previous, signal)` with a complete snapshot:

```js
{
  revision: "catalog-version",
  skills: [{
    name: "example",
    description: "When the agent should use this skill",
    path: "example/SKILL.md",
    content: "# Example\nComplete instructions here."
  }]
}
```

A native path becomes `skills/<plugin-id>/<path>`. Keep paths relative and unique. The host replaces snapshots atomically and retains the last good snapshot if synchronization fails. Each message, including steering, gets a sync attempt before model processing. Removing a skill from a successful complete snapshot removes it from the next catalog; incomplete listings must not be returned as complete snapshots.

The current implementation stores complete skill text. Supporting files can be represented as additional entries, but a richer resource API is not implemented. Never claim a remote script exists in the local filesystem. Plugin settings and code revisions partition cached skills. Managed Charms sign-ins also assign an opaque credential revision, so a new login gets a separate skill cache and old background jobs cannot use its credentials.

Enabled plugin code is pinned through an active turn, including steering. New turns see app-wide configuration changes. Plugins should keep durable state in their own origin storage or remote service; factory-local state can vanish at any time. No lifecycle scheduler or permission sandbox is provided.

## HTTP MCP

Install the bundled `plugins/mcp/plugin.json` using its full hosted/local URL, with settings such as:

```json
{ "url": "https://example.org/mcp", "token": "optional-bearer-token" }
```

The helper supports the initialize handshake, protocol/session headers, paginated tools/list, JSON or SSE tool results, cancellation through fetch abort, and tool error propagation. It requests `2025-11-25` and accepts `2025-06-18`. It also reads `ui://` resources, negotiates MCP Apps, respects model/app tool visibility, and forwards app tool calls only to the originating server. The generic MCP plugin uses a supplied token; the bundled Charms setup also supports OAuth with PKCE. Legacy SSE transport and automatic side-effect retries are not implemented. A remote server needs suitable CORS, including exposed MCP session headers.

The bundled `public/plugins/charms` adapter maps the five workspace tools together and imports installed Charms as native skills. Discovery calls do not appear as model tools. It reads both inline and separate-text MCP skill bodies, follows paginated catalogs and versioned instruction reads; dynamic `kineto.connections` and `kineto.agents` refresh on every message. Supporting files stay in the sandbox. When a plugin replaces workspace tools, the built-in local workspace skill is omitted; command capabilities come from the active provider. Charms runs native sandbox commands rather than the browser shell. Live connectivity still requires credentials and CORS support; fixture tests do not establish that all live Charms workflows work.

## MCP Apps

The host loads `text/html;profile=mcp-app` resources advertised by `_meta.ui.resourceUri`, with compatibility for `_meta["ui/resourceUri"]`. It sends initialization, input and result messages and supports `tools/call`, `ui/message`, inline sizing, and inline display mode. Unsupported requests receive a JSON-RPC error. App-only tools never enter the model's tool list; model-only tools cannot be invoked by the view. Tool schemas are checked in both paths.

Views run inside a nested iframe with an opaque sandbox origin, without access to the PWA DOM or storage. The proxy response enforces `Content-Security-Policy: sandbox allow-scripts`, so both frames have opaque origins. The initial same-origin navigation lets the service worker serve the proxy offline before the response sandbox takes effect. The host checks that this security header is present before embedding the proxy. No persistent app-origin storage, camera, microphone, or geolocation permissions are granted. Resource CSP metadata restricts HTTPS resource/network/frame/base-URI origins; undeclared origins are blocked. App tool calls are journaled before execution and are never automatically retried. UI resources and their initial result are stored with the conversation, so an already-loaded view can reopen offline.

Expose only features your server can run in this environment. Native desktop SDK capabilities and arbitrary host filesystem access are not provided. The frontend's app bridge implements the listed protocol subset; it is not a claim of conformance to every MCP Apps extension.

## Managed Charms connection

A deployment may configure a known Charms preset in `config.json`. Opening `?connect=charms` prepares the bundled plugin without executing it. OAuth consent, tool discovery, and the first successful native skill sync precede activation. Reopening the link preserves a disabled plugin and its pinned code. Explicit activation refreshes the host-bundled adapter before loading skills; it keeps the saved sign-in and does not update custom plugins. Unknown connection IDs never install code. See [the deployment configuration](deployment.md#connections-and-guided-setup).

Managed credentials live separately from plugin settings, conversations, and job snapshots in the app’s IndexedDB. Trusted executable plugins share origin privileges, so this is separation from model context, not a security boundary against installed code. A rejected, expired, or unverified credential blocks remote operations with a reconnect message. It never silently substitutes the local filesystem. Deliberately disabling or disconnecting the plugin restores the ordinary local tools for new turns.

Tool definitions may set `timeoutMs` for foreground requests. The runtime defaults to
30 seconds and clamps overrides to 1–60 seconds. The bundled Charms adapter uses
60 seconds and requests background execution when a job is launched in the background.
