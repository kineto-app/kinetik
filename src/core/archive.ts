import Ajv from 'ajv';
import { recentTrace, type TraceEntry } from './trace';
import { Store } from '../browser/store';
import { createFilesystem } from '../browser/filesystem';
import { modelMessageText, type Conversation, type InstalledPlugin } from './types';
import type { Automation } from './automation';

const MAX_ARCHIVE = 32 * 1024 * 1024;
const schema = new Ajv({ strict: false }).compile({
  type: 'object',
  required: ['format', 'version', 'conversations', 'filesystem', 'plugins', 'automations'],
  properties: {
    format: { const: 'kinetik-workspace' },
    version: { const: 1 },
    conversations: {
      type: 'array',
      maxItems: 10000,
      items: {
        type: 'object',
        required: ['id', 'title', 'messages', 'updatedAt'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          title: { type: 'string', maxLength: 10000 },
          updatedAt: { type: 'number' },
          messages: {
            type: 'array',
            maxItems: 100000,
            items: {
              type: 'object',
              required: ['id', 'role', 'text', 'createdAt'],
              properties: {
                id: { type: 'string', maxLength: 200 },
                role: { enum: ['user', 'assistant', 'tool', 'notice'] },
                text: { type: 'string', maxLength: 2000000 },
                createdAt: { type: 'number' },
                durationMs: { type: 'number', minimum: 0 },
                attachments: {
                  type: 'array',
                  maxItems: 10,
                  items: {
                    type: 'object',
                    required: ['id', 'name', 'size', 'path', 'provider'],
                    properties: {
                      id: { type: 'string', maxLength: 100 },
                      name: { type: 'string', maxLength: 255 },
                      size: { type: 'number', minimum: 0 },
                      path: { type: 'string', maxLength: 4096 },
                      provider: { type: 'string', maxLength: 100 },
                    },
                  },
                },
                file: {
                  type: 'object',
                  required: ['path', 'name'],
                  properties: {
                    path: { type: 'string' },
                    name: { type: 'string' },
                    snapshotId: { type: 'string' },
                  },
                },
                app: {
                  type: 'object',
                  required: ['id', 'html', 'input', 'result'],
                  properties: {
                    id: { type: 'string' },
                    html: { type: 'string', maxLength: 2000000 },
                    input: { type: 'object' },
                    csp: {
                      type: 'object',
                      additionalProperties: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
                activity: {
                  type: 'object',
                  required: ['input', 'outcome'],
                  properties: {
                    input: { type: 'object' },
                    outcome: { enum: ['completed', 'failed', 'running', 'started', 'unknown'] },
                    scope: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    filesystem: {
      type: 'object',
      required: ['entries'],
      properties: {
        entries: {
          type: 'array',
          maxItems: 2000,
          items: {
            type: 'object',
            required: ['path', 'kind', 'mode', 'mtime'],
            properties: {
              path: { type: 'string', pattern: '^/', maxLength: 4096 },
              kind: { enum: ['file', 'directory', 'symlink', 'link'] },
              mode: { type: 'integer', minimum: 0, maximum: 65535 },
              mtime: { type: 'string' },
              bytes: { type: 'string', maxLength: 24 * 1024 * 1024 },
              target: { type: 'string', maxLength: 4096 },
            },
          },
        },
      },
    },
    sharedFiles: {
      type: 'object',
      maxProperties: 2000,
      additionalProperties: { type: 'string', maxLength: 24 * 1024 * 1024 },
    },
    plugins: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        required: ['manifest', 'source', 'resolvedSource', 'code', 'digest'],
        properties: {
          manifest: {
            type: 'object',
            required: ['id', 'name', 'version', 'apiVersion', 'entry'],
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
              name: { type: 'string' },
              version: { type: 'string' },
              apiVersion: { const: 1 },
              entry: { type: 'string' },
            },
          },
          source: { type: 'string' },
          resolvedSource: { type: 'string' },
          code: { type: 'string', maxLength: 2 * 1024 * 1024 },
          digest: { type: 'string' },
        },
      },
    },
    automations: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        required: ['id', 'kind', 'prompt', 'maxRuns'],
        properties: {
          id: { type: 'string' },
          kind: { enum: ['task', 'goal', 'job', 'monitor'] },
          prompt: { type: 'string', maxLength: 12000 },
          maxRuns: { type: 'integer', minimum: 1, maximum: 1000 },
          intervalMs: { type: 'integer', minimum: 60000 },
          event: { type: 'string', pattern: '^[\\w.-]{1,100}$' },
          watchPath: { type: 'string', maxLength: 1024 },
        },
      },
    },
  },
});
type FileEntry = {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'link';
  mode: number;
  mtime: Date;
  bytes?: Uint8Array;
  target?: string;
};
type Archive = {
  format: 'kinetik-workspace';
  version: 1;
  conversations: Conversation[];
  filesystem: {
    entries: (Omit<FileEntry, 'mtime' | 'bytes'> & { mtime: string; bytes?: string })[];
  };
  sharedFiles?: Record<string, string>;
  plugins: InstalledPlugin[];
  automations: Automation[];
  trace?: TraceEntry[];
};
const encode = (bytes: Uint8Array) => {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
};
function conversation(value: Conversation): Conversation {
  return {
    id: value.id,
    title: value.title,
    messages: value.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
      ...(m.attachments?.length
        ? {
            attachments: m.attachments.map(({ id, name, size, path, provider }) => ({
              id,
              name,
              size,
              path,
              provider,
            })),
          }
        : {}),
      ...(typeof m.durationMs === 'number' ? { durationMs: m.durationMs } : {}),
      ...(m.visibility === 'internal' ? { visibility: 'internal' as const } : {}),
      ...(m.source === 'background' ? { source: 'background' as const } : {}),
      ...(typeof m.tool === 'string' ? { tool: m.tool } : {}),
      ...(m.activity
        ? {
            activity: {
              input: m.activity.input,
              outcome: m.activity.outcome,
              scope: m.activity.scope,
            },
          }
        : {}),
      ...(m.file
        ? { file: { path: m.file.path, name: m.file.name, snapshotId: m.file.snapshotId } }
        : {}),
      ...(m.app
        ? {
            app: {
              id: m.app.id,
              html: m.app.html,
              csp: m.app.csp,
              input: m.app.input,
              result: m.app.result,
            },
          }
        : {}),
    })),
    pending: [],
    status: 'idle',
    updatedAt: value.updatedAt,
  };
}
function plugin(value: InstalledPlugin): InstalledPlugin {
  // Configuration can contain arbitrary credentials. None of it is portable.
  return {
    manifest: {
      id: value.manifest.id,
      name: value.manifest.name,
      version: value.manifest.version,
      apiVersion: 1,
      entry: value.manifest.entry,
    },
    source: publicURL(value.source),
    resolvedSource: publicURL(value.resolvedSource),
    code: value.code,
    digest: value.digest,
    settings: {},
    enabledAt: null,
  };
}
function publicURL(value: string) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}
function automation(value: Automation): Automation {
  return {
    id: value.id,
    kind: value.kind,
    prompt: value.prompt,
    maxRuns: value.maxRuns,
    intervalMs: value.intervalMs,
    event: value.event,
    watchPath: value.watchPath,
    status: 'paused',
    runs: 0,
    nextAt: Date.now(),
  };
}
export async function exportArchive(store: Store): Promise<string> {
  const filesystem = await store.get<{ entries: FileEntry[] }>('filesystem');
  const sharedFiles = Object.fromEntries(
    (await store.entries<Uint8Array>('shared-file:')).map(([key, bytes]) => [
      key.slice('shared-file:'.length),
      encode(bytes),
    ]),
  );
  const archive: Archive = {
    sharedFiles,
    format: 'kinetik-workspace',
    version: 1,
    conversations: (await store.entries<Conversation>('conversation:')).map(([, c]) =>
      conversation(c),
    ),
    filesystem: {
      entries: (
        filesystem?.entries ?? [
          { path: '/workspace', kind: 'directory' as const, mode: 493, mtime: new Date() },
        ]
      ).map((entry) => ({
        ...entry,
        mtime: entry.mtime.toISOString(),
        bytes: entry.bytes ? encode(entry.bytes) : undefined,
      })),
    },
    plugins: ((await store.get<InstalledPlugin[]>('plugins')) ?? []).map(plugin),
    automations: ((await store.get<{ items: Automation[] }>('automations'))?.items ?? []).map(
      automation,
    ),
    // For diagnosis only: an import ignores it.
    trace: await recentTrace(store, 1000),
  };
  const text = JSON.stringify(archive);
  if (text.length > MAX_ARCHIVE) throw new Error('This workspace is too large to export.');
  return text;
}
export async function parseArchive(text: string): Promise<[string, unknown][]> {
  if (text.length > MAX_ARCHIVE) throw new Error('Choose a workspace export smaller than 32 MB.');
  const value: unknown = JSON.parse(text);
  if (!schema(value)) throw new Error('This is not a supported Kinetik workspace export.');
  const archive = value as Archive;
  let total = 0;
  const paths = new Set<string>();
  const entries = archive.filesystem.entries.map((entry): FileEntry => {
    if (entry.path.split('/').some((part) => ['..', '.'].includes(part)) || paths.has(entry.path))
      throw new Error('Invalid file path in workspace export.');
    paths.add(entry.path);
    const bytes =
      entry.bytes === undefined
        ? undefined
        : Uint8Array.from(atob(entry.bytes), (char) => char.charCodeAt(0));
    total += bytes?.length ?? 0;
    const mtime = new Date(entry.mtime);
    if (
      total > 16 * 1024 * 1024 ||
      !Number.isFinite(mtime.getTime()) ||
      (entry.kind === 'file' && !bytes) ||
      (['link', 'symlink'].includes(entry.kind) && !entry.target)
    )
      throw new Error('Invalid filesystem in workspace export.');
    return {
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      mtime,
      bytes,
      target: entry.target,
    };
  });
  const filesystem = { revision: crypto.randomUUID(), entries };
  // Exercise the real filesystem restore before touching the user's database.
  const scratch = { get: async () => filesystem } as unknown as Store;
  await createFilesystem(scratch);
  const ids = new Set<string>();
  const records: [string, unknown][] = archive.conversations.map((c) => {
    if (ids.has(c.id)) throw new Error('Duplicate chat in workspace export.');
    ids.add(c.id);
    const restored = conversation(c);
    // Rebuild portable dialogue context without replaying provider-specific call IDs
    // or retaining a pending tool execution from the source device.
    restored.modelInput = restored.messages
      .filter((m) => ['user', 'assistant'].includes(m.role) && m.visibility !== 'internal')
      .map((m) => ({ role: m.role, content: modelMessageText(m) }));
    return ['conversation:' + c.id, restored];
  });
  const plugins = archive.plugins.map(plugin);
  for (const item of plugins) {
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.code))),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (item.digest !== hash) throw new Error('A connection in the export has changed.');
  }
  for (const [id, base64] of Object.entries(archive.sharedFiles ?? {})) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    total += bytes.length;
    if (total > 32 * 1024 * 1024) throw new Error('Shared files exceed the export limit.');
    records.push(['shared-file:' + id, bytes]);
  }
  records.push(
    ['filesystem', filesystem],
    ['plugins', plugins],
    ['automations', { items: archive.automations.map(automation), events: [], seen: [] }],
  );
  return records;
}
