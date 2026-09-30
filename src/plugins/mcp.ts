import Ajv from 'ajv';
import { ConnectionError, SignInRequired } from '../core/connection-error';
import type { AppResource, ToolDefinition } from '../core/types';

const clientInfo = { name: 'kinetik-oss', version: '0.1.0' };
const capabilities = {
  extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
};

type Rpc = { id?: string; result?: unknown; error?: { message: string } };
/** Minimal Streamable HTTP client. Managed credentials are read on every request. */
export class McpClient {
  private session?: string;
  private protocol = '2025-11-25';
  private initialized?: Promise<void>;
  constructor(
    private url: string,
    private token?: string | (() => Promise<string>),
    private unauthorized?: (token: string) => Promise<void>,
  ) {}
  private async send(
    method: string,
    params: unknown,
    signal: AbortSignal,
    notification = false,
  ): Promise<unknown> {
    const id = crypto.randomUUID();
    const requestParams = {
      ...(params as Record<string, unknown>),
      _meta: {
        'io.modelcontextprotocol/clientInfo': clientInfo,
        'io.modelcontextprotocol/clientCapabilities': capabilities,
      },
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocol,
    };
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      credentials: 'omit',
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(notification ? {} : { id }),
        method,
        params: requestParams,
      }),
    });
    if (response.status === 401 && token && this.unauthorized) {
      await this.unauthorized(token);
      throw new SignInRequired('Reconnect Charms in Connections to continue.');
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status))
        throw new SignInRequired('Reconnect the service to continue.');
      const text = `MCP ${method}: HTTP ${response.status}`;
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) throw new ConnectionError(text);
      throw new Error(text);
    }
    const session = response.headers.get('Mcp-Session-Id');
    if (session) this.session = session;
    if (notification) {
      await response.body?.cancel();
      return;
    }
    const accept = (rpc: Rpc) => {
      if (rpc.id !== id) throw new Error('MCP response ID mismatch.');
      if (rpc.error) throw new Error(`MCP: ${rpc.error.message}`);
      return rpc.result;
    };
    const reader = response.body?.getReader();
    if (!reader) throw new Error('MCP returned no body.');
    const decoder = new TextDecoder();
    let buffer = '';
    let size = 0;
    const events = response.headers.get('Content-Type')?.includes('text/event-stream');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          size += value.length;
          buffer += decoder.decode(value, { stream: true });
        }
        if (size > 4 * 1024 * 1024) throw new Error('MCP response exceeds 4 MiB.');
        if (events) {
          buffer = buffer.replace(/\r\n/g, '\n');
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data) {
              const rpc = JSON.parse(data) as Rpc;
              if (rpc.id === id) return accept(rpc);
            }
          }
        }
        if (done) {
          if (!events) return accept(JSON.parse(buffer) as Rpc);
          throw new ConnectionError('MCP stream ended before its response.');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  private ready(signal: AbortSignal): Promise<void> {
    return (this.initialized ??= (async () => {
      const result = (await this.send(
        'initialize',
        {
          protocolVersion: '2025-11-25',
          capabilities,
          clientInfo,
        },
        signal,
      )) as { protocolVersion: string };
      if (!['2025-11-25', '2025-06-18'].includes(result.protocolVersion))
        throw new Error('Unsupported MCP protocol: ' + result.protocolVersion);
      this.protocol = result.protocolVersion;
      await this.send('notifications/initialized', {}, signal, true);
    })().catch((error) => {
      this.initialized = undefined;
      throw error;
    }));
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal = AbortSignal.timeout(60000),
  ): Promise<unknown> {
    await this.ready(signal);
    const result = (await this.send('tools/call', { name, arguments: args }, signal)) as {
      isError?: boolean;
      content?: unknown;
    };
    if (result.isError)
      throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.content)}`);
    return result;
  }
  async resource(uri: string, signal: AbortSignal): Promise<AppResource> {
    if (!uri.startsWith('ui://')) throw new Error('MCP App resource must use ui://.');
    await this.ready(signal);
    const result = (await this.send('resources/read', { uri }, signal)) as {
      contents?: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
        _meta?: { ui?: { csp?: Record<string, string[]> } };
      }[];
    };
    const resource = result.contents?.find((item) => item.uri === uri);
    if (!resource || resource.mimeType !== 'text/html;profile=mcp-app')
      throw new Error('MCP App did not return an HTML resource.');
    const html =
      resource.text ??
      (resource.blob
        ? new TextDecoder().decode(Uint8Array.from(atob(resource.blob), (c) => c.charCodeAt(0)))
        : '');
    if (!html || html.length > 2 * 1024 * 1024) throw new Error('Invalid MCP App HTML.');
    return { html, csp: resource._meta?.ui?.csp };
  }
  async tools(): Promise<Record<string, ToolDefinition>> {
    const signal = AbortSignal.timeout(15000);
    await this.ready(signal);
    const tools: Record<string, ToolDefinition> = Object.create(null);
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      const result = (await this.send('tools/list', cursor ? { cursor } : {}, signal)) as {
        tools: {
          name: string;
          description?: string;
          inputSchema: Record<string, unknown>;
          _meta?: {
            ui?: { resourceUri?: string; visibility?: ('model' | 'app')[] };
            'ui/resourceUri'?: string;
          };
        }[];
        nextCursor?: string;
      };
      if (!Array.isArray(result.tools)) throw new Error('Invalid MCP tools list.');
      for (const tool of result.tools) {
        if (Object.keys(tools).length >= 200) throw new Error('MCP tool limit exceeded.');
        tools[tool.name] = {
          description: tool.description ?? tool.name,
          visibility: tool._meta?.ui?.visibility,
          app:
            (tool._meta?.ui?.resourceUri ?? tool._meta?.['ui/resourceUri'])
              ? {
                  resource: (signal) =>
                    this.resource(
                      tool._meta?.ui?.resourceUri ?? tool._meta!['ui/resourceUri']!,
                      signal,
                    ),
                  call: async (name, input, signal) => {
                    if (
                      !tools[name] ||
                      (tools[name].visibility && !tools[name].visibility.includes('app'))
                    )
                      throw new Error('Tool is not available to this app.');
                    const validate = new Ajv({ strict: false }).compile(tools[name].inputSchema);
                    if (!validate(input)) throw new Error('Invalid app tool arguments.');
                    return this.call(name, input, signal);
                  },
                }
              : undefined,
          inputSchema: tool.inputSchema,
          execute: (input, context) => this.call(tool.name, input, context.signal),
        };
      }
      cursor = result.nextCursor;
      if (cursor && visited.has(cursor)) throw new Error('MCP pagination loop.');
      if (cursor) visited.add(cursor);
    } while (cursor);
    return tools;
  }
}
