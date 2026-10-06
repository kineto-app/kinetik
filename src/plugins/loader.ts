import { clientPlatform, isNative } from '../platform/environment';
import type { Store } from '../core/ports';
import {
  errorText,
  type Binding,
  type InstalledPlugin,
  type Plugin,
  type PluginManifest,
  type Skill,
  type SkillSnapshot,
} from '../core/types';
import { McpClient } from './mcp';
import { connectionToken, invalidateToken } from '../connections/credentials';

const safeName = /^[a-z][a-z0-9_-]{0,63}$/i;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function allowedURL(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password) throw new Error('URLs must not contain credentials.');
  if (
    url.protocol !== 'https:' &&
    !(isNative && url.protocol === 'tauri:' && url.hostname === 'localhost') &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use HTTPS, or HTTP on localhost.');
  return url;
}
export async function fetchText(url: string, limit = 2 * 1024 * 1024): Promise<string> {
  const response = await fetch(allowedURL(url), {
    signal: AbortSignal.timeout(15000),
    cache: 'no-store',
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  allowedURL(response.url || url);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response.');
  let size = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Download is too large.');
    }
    parts.push(value);
  }
  return new TextDecoder().decode(await new Blob(parts as BlobPart[]).arrayBuffer());
}
const getJSON = async (url: string) =>
  JSON.parse(await fetchText(url, 1024 * 1024)) as Record<string, unknown>;
export async function manifestURL(source: string): Promise<string> {
  let url = allowedURL(source);
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [owner, repo, view, ...rest] = parts;
    if (!owner || !repo || (view && !['tree', 'blob'].includes(view)))
      throw new Error('Use a GitHub repository, folder, or file link.');
    const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    let sha = '';
    let path: string[] = [];
    if (!view) {
      const info = await getJSON(api);
      const commit = await getJSON(
        `${api}/commits/${encodeURIComponent(String(info.default_branch))}`,
      );
      sha = String(commit.sha);
    } else {
      // Ref names may themselves contain slashes. Resolve the longest valid ref.
      for (let n = Math.min(rest.length, 12); n > 0; n--) {
        try {
          const commit = await getJSON(
            `${api}/commits/${encodeURIComponent(rest.slice(0, n).join('/'))}`,
          );
          sha = String(commit.sha);
          path = rest.slice(n);
          break;
        } catch (error) {
          if (!errorText(error).includes('HTTP 404') && !errorText(error).includes('HTTP 422'))
            throw error;
        }
      }
    }
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Could not resolve the GitHub revision.');
    if (view === 'blob') path.pop();
    url = new URL(
      `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}/${path.map(encodeURIComponent).join('/')}${path.length ? '/' : ''}plugin.json`,
    );
  } else if (!url.pathname.endsWith('.json')) {
    url = new URL(
      url.pathname.endsWith('/')
        ? 'plugin.json'
        : /\.[cm]?js$/.test(url.pathname)
          ? 'plugin.json'
          : `${url.pathname.split('/').pop()}/plugin.json`,
      url,
    );
  }
  return url.href;
}
export function validateManifest(value: unknown): PluginManifest {
  const m = value as PluginManifest;
  if (
    !m ||
    typeof m !== 'object' ||
    typeof m.id !== 'string' ||
    !safeName.test(m.id) ||
    forbidden.has(m.id) ||
    typeof m.name !== 'string' ||
    m.name.length > 100 ||
    typeof m.version !== 'string' ||
    m.apiVersion !== 1 ||
    typeof m.entry !== 'string' ||
    !/^[\w./-]+\.js$/.test(m.entry) ||
    m.entry.split('/').includes('..') ||
    m.entry.startsWith('/')
  )
    throw new Error(
      'Invalid plugin manifest. Expected id, name, version, apiVersion: 1, and a relative .js entry.',
    );
  return m;
}
export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export class Plugins {
  /** Whether a plugin may run here; snapshots leave out the others, even in saved chats. */
  allowed: (plugin: InstalledPlugin) => boolean = () => true;
  constructor(
    private store: Store,
    private emit?: (name: string, text: string, id?: string) => Promise<void>,
  ) {}
  async list(): Promise<InstalledPlugin[]> {
    return (await this.store.get<InstalledPlugin[]>('plugins')) ?? [];
  }
  async install(
    source: string,
    settings: Record<string, string> = {},
    updateId?: string,
  ): Promise<void> {
    const resolved = await manifestURL(source);
    const manifest = validateManifest(JSON.parse(await fetchText(resolved, 32768)));
    if (updateId && manifest.id !== updateId)
      throw new Error('An update cannot change the plugin ID.');
    const code = await fetchText(new URL(manifest.entry, resolved).href);
    const installed: InstalledPlugin = {
      manifest,
      source,
      resolvedSource: resolved,
      code,
      digest: await digest(code),
      settings,
      enabledAt: null,
    };
    // Syntax check only. Installation does not execute the factory before explicit enable.
    new Function('host', '"use strict";\n' + code);
    await this.store.update<InstalledPlugin[]>('plugins', (previous) => {
      const list = previous ?? [];
      const old = list.find((p) => p.manifest.id === manifest.id);
      if (old && !updateId) throw new Error('Plugin already installed. Use Update.');
      installed.enabledAt = old?.enabledAt ?? null;
      return [...list.filter((p) => p.manifest.id !== manifest.id), installed];
    });
  }
  async enable(id: string, enabled: boolean): Promise<void> {
    await this.store.update<InstalledPlugin[]>('plugins', (previous) => {
      if (!previous?.some((p) => p.manifest.id === id)) throw new Error('Unknown plugin.');
      const order = Math.max(0, ...previous.map((p) => p.enabledAt ?? 0)) + 1;
      return previous.map((p) =>
        p.manifest.id === id ? { ...p, enabledAt: enabled ? order : null } : p,
      );
    });
  }
  async configure(id: string, settings: Record<string, string>): Promise<void> {
    await this.store.update<InstalledPlugin[]>('plugins', (previous) => {
      if (!previous?.some((p) => p.manifest.id === id)) throw new Error('Unknown plugin.');
      return previous.map((p) => (p.manifest.id === id ? { ...p, settings } : p));
    });
  }
  /** Records that pin plugins keep each plugin's code once, under its digest. */
  async pin(records: InstalledPlugin[]): Promise<InstalledPlugin[]> {
    for (const { code, digest } of records)
      if (code)
        await this.store.update<string>('plugin-code:' + digest, (stored) => stored ?? code);
    return records.map((record) => ({ ...record, code: '' }));
  }
  async instantiate(installed: InstalledPlugin, validatingConnection = false): Promise<Plugin> {
    const code =
      installed.code || (await this.store.get<string>('plugin-code:' + installed.digest));
    if (!code) throw new Error(`${installed.manifest.name} needs to be updated.`);
    const plugin: Plugin = await new Function('host', '"use strict";\n' + code)({
      emit: this.emit,
      settings: Object.freeze({ ...installed.settings }),
      baseURL: new URL('.', installed.resolvedSource).href,
      mcp: (url: string, token?: string) => {
        const address = allowedURL(url).href;
        const managed =
          installed.settings.connection === installed.manifest.id &&
          address === installed.settings.url;
        return new McpClient(
          address,
          managed
            ? () =>
                connectionToken(
                  this.store,
                  installed.manifest.id,
                  installed.settings.connectionRevision,
                  validatingConnection,
                )
            : token,
          managed
            ? (value) => invalidateToken(this.store, installed.manifest.id, value)
            : undefined,
          managed && clientPlatform() !== 'unknown'
            ? { 'X-Client-Platform': clientPlatform() }
            : undefined,
        );
      },
    });
    if (!plugin || typeof plugin !== 'object')
      throw new Error(`${installed.manifest.id}: factory must return a plugin object.`);
    for (const [name, tool] of Object.entries(plugin.tools ?? {})) {
      if (
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(name) ||
        forbidden.has(name) ||
        !tool ||
        typeof tool.execute !== 'function' ||
        typeof tool.description !== 'string' ||
        typeof tool.inputSchema !== 'object'
      )
        throw new Error('Invalid plugin tool: ' + name);
    }
    for (const [target, name] of Object.entries(plugin.replacements ?? {})) {
      if (
        !['exec', 'read', 'write', 'edit', 'list', 'show_file'].includes(target) ||
        (name !== null && (typeof name !== 'string' || !Object.hasOwn(plugin.tools ?? {}, name)))
      )
        throw new Error('Invalid replacement: ' + target);
    }
    if (plugin.skills && typeof plugin.skills.sync !== 'function')
      throw new Error('Invalid skill source.');
    if (plugin.files && typeof plugin.files.upload !== 'function')
      throw new Error('Invalid file upload provider.');
    return plugin;
  }
  async snapshot(
    builtins: Record<string, Binding>,
    records?: InstalledPlugin[],
  ): Promise<{
    bindings: Record<string, Binding>;
    sources: { installed: InstalledPlugin; plugin: Plugin }[];
  }> {
    const bindings = Object.assign(Object.create(null) as Record<string, Binding>, builtins);
    const sources = [];
    for (const installed of (records ?? (await this.list()))
      .filter((p) => p.enabledAt !== null && this.allowed(p))
      .sort((a, b) => a.enabledAt! - b.enabledAt!)) {
      const plugin = await this.instantiate(installed);
      const provider = installed.manifest.id;
      for (const [name, tool] of Object.entries(plugin.tools ?? {}))
        bindings[`${provider}__${name}`] = { provider, tool };
      for (const [target, name] of Object.entries(plugin.replacements ?? {})) {
        if (name === null) delete bindings[target];
        else bindings[target] = { provider, tool: plugin.tools![name!] };
      }
      sources.push({ installed, plugin });
    }
    return { bindings, sources };
  }
  async sync(
    sources: { installed: InstalledPlugin; plugin: Plugin }[],
    signal: AbortSignal,
  ): Promise<{ skills: Skill[]; warnings: string[] }> {
    const skills: Skill[] = [];
    const warnings: string[] = [];
    for (const { installed, plugin } of sources) {
      if (!plugin.skills) continue;
      const key = `skills:${installed.manifest.id}:${installed.digest}:${await digest(JSON.stringify(installed.settings))}`;
      const sync = async () => {
        let cached = await this.store.get<SkillSnapshot>(key);
        try {
          const next = await plugin.skills!.sync(
            cached,
            AbortSignal.any([signal, AbortSignal.timeout(cached ? 15000 : 60000)]),
          );
          if (
            !next ||
            typeof next.revision !== 'string' ||
            !Array.isArray(next.skills) ||
            next.skills.length > 500
          )
            throw new Error('Invalid skill snapshot.');
          const paths = new Set<string>();
          for (const skill of next.skills) {
            if (
              !skill ||
              typeof skill.name !== 'string' ||
              typeof skill.description !== 'string' ||
              typeof skill.path !== 'string' ||
              typeof skill.content !== 'string' ||
              skill.path.startsWith('/') ||
              skill.path.split('/').includes('..') ||
              paths.has(skill.path)
            )
              throw new Error('Invalid or duplicate skill path.');
            paths.add(skill.path);
          }
          if (JSON.stringify(next).length > 2 * 1024 * 1024)
            throw new Error('Skill snapshot exceeds 2 MiB.');
          await this.store.put(key, next);
          cached = next;
        } catch (error) {
          signal.throwIfAborted();
          warnings.push(
            `${installed.manifest.name}: skill sync failed; ${cached ? 'using cached skills' : 'no cached skills'}. ${errorText(error)}`,
          );
        }
        if (cached)
          skills.push(
            ...cached.skills.map((s) => ({
              ...s,
              path: `skills/${installed.manifest.id}/${s.path}`,
            })),
          );
      };
      if (globalThis.navigator?.locks) await navigator.locks.request(key, { signal }, sync);
      else await sync();
    }
    return { skills, warnings };
  }
}
