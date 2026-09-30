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

Tool inputs are validated against their JSON Schema by Ajv before dispatch. `execute(input, context)` receives an abort signal and `await context.checkpoint(operationId)`. Save a remote operation ID as soon as it exists. Optional `recover(operationId, signal)` returns `{done, result}`; optional `cancel(operationId)` requests remote cancellation. If the browser dies before an ID is saved, the operation is uncertain and needs manual resolution. No host can make that gap exactly-once without server cooperation.

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

The current implementation stores complete skill text. Supporting files can be represented as additional entries, but a richer resource API is not implemented. Never claim a remote script exists in the local filesystem. Plugin settings and code revisions partition cached skills; the host does not reuse one account's cache for another configuration.

Enabled plugin code is pinned through an active turn, including steering. New turns see app-wide configuration changes. Plugins should keep durable state in their own origin storage or remote service; factory-local state can vanish at any time. No lifecycle scheduler or permission sandbox is provided.

## HTTP MCP

Install the bundled `plugins/mcp/plugin.json` using its full hosted/local URL, with settings such as:

```json
{ "url": "https://example.org/mcp", "token": "optional-bearer-token" }
```

The helper supports the initialize handshake, protocol/session headers, paginated tools/list, JSON or SSE tool results, cancellation through fetch abort, and tool error propagation. It requests `2025-11-25` and accepts `2025-06-18`. It also reads `ui://` resources, negotiates MCP Apps, respects model/app tool visibility, and forwards app tool calls only to the originating server. It does not implement OAuth, legacy SSE transport, or automatic side-effect retries. A remote server needs suitable CORS, including exposed MCP session headers.

The bundled `public/plugins/charms` adapter maps the five workspace tools together and imports installed Charms as native skills. Discovery calls do not appear as model tools. It follows paginated catalogs and versioned instruction reads; dynamic `kineto.connections` and `kineto.agents` refresh on every message. Supporting files stay in the sandbox. Live connectivity still requires credentials and CORS support; fixture tests do not establish that all live Charms workflows work.

## MCP Apps

The host loads `text/html;profile=mcp-app` resources advertised by `_meta.ui.resourceUri`, with compatibility for `_meta["ui/resourceUri"]`. It sends initialization, input and result messages and supports `tools/call`, `ui/message`, inline sizing, and inline display mode. Unsupported requests receive a JSON-RPC error. App-only tools never enter the model's tool list; model-only tools cannot be invoked by the view. Tool schemas are checked in both paths.

Views run inside a nested iframe with an opaque sandbox origin, without access to the PWA DOM or storage. The proxy response enforces `Content-Security-Policy: sandbox allow-scripts`, so both frames have opaque origins. The initial same-origin navigation lets the service worker serve the proxy offline before the response sandbox takes effect. The host checks that this security header is present before embedding the proxy. No persistent app-origin storage, camera, microphone, or geolocation permissions are granted. Resource CSP metadata restricts HTTPS resource/network/frame/base-URI origins; undeclared origins are blocked. App tool calls are journaled before execution and are never automatically retried. UI resources and their initial result are stored with the conversation, so an already-loaded view can reopen offline.

Expose only features your server can run in this environment. Native desktop SDK capabilities and arbitrary host filesystem access are not provided. The frontend's app bridge implements the listed protocol subset; it is not a claim of conformance to every MCP Apps extension.
