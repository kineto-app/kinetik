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

The factory receives `host.settings`, `host.baseURL`, and `host.mcp(url, token?)`. It may return a promise. Export all tools you provide in `tools`; they become `plugin-id__tool-name`. Optional replacements map `exec`, `read`, `write`, `edit`, and `list` to one of the plugin's own tools. Mapping replaces description, input schema, and implementation together. `read_skill` always belongs to the native catalog.

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

The helper supports the initialize handshake, protocol/session headers, paginated tools/list, JSON or SSE tool results, cancellation through fetch abort, and tool error propagation. It requests `2025-11-25` and accepts `2025-06-18`. It does not implement OAuth, legacy SSE transport, automatic side-effect retries, resources, Apps, or background notifications. A remote server needs suitable CORS, including exposed MCP session headers.

Charms can eventually use a dedicated plugin to map workspace tools and synchronize its installed skill catalog. That provider-specific implementation is intentionally deferred until its browser connectivity is verified. The generic MCP helper is not a claim that all Charms workflows work.
