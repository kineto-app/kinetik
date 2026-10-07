import { exportArchive, parseArchive } from './archive';
import { memoryChangeKey, memoryKey, saveMemory, undoMemory, type MemoryChange } from './memory';
import { protocolVersion, reloadHint } from './protocol';
import { recentTrace } from './trace';
import type { BackgroundProcess } from './background';
import { ConnectionError, SignInRequired, failureKind, type FailureKind } from './connection-error';
import { Runtime } from './runtime';
import { errorText, type RuntimeEvent } from './types';
import { Store } from '../browser/store';
import { BrowserChatGPT } from '../connections/chatgpt';
import { loadConfiguration, type Configuration } from '../connections/config';
import { customModelAction, customModelKey, type CustomModel } from '../connections/custom-model';
import { Connections } from '../connections/manager';
import { CompatModel } from '../models/compat';
import { MockModel } from '../models/mock';
import { httpTransport, OpenAIModel } from '../models/openai';
import { capabilities, clientPlatform } from '../platform/environment';
import { ModelRouter, provider } from '../models/router';

export interface HostReply {
  ok: boolean;
  result?: unknown;
  error?: string;
  failureKind?: FailureKind;
}

/** Shared agent commands. The host decides lifetime, transport, and update activation. */
export class RuntimeHost {
  runtime!: Runtime;
  connections!: Connections;
  router!: ModelRouter;
  private initialized?: Promise<void>;
  /** Platform alert for finished work; the runtime decides when to call it. */
  notify: Runtime['notify'] = async () => {};
  constructor(
    readonly store: Store,
    readonly scope: URL,
    private changed: (event?: RuntimeEvent) => void,
    private configuration?: Configuration,
    private chatgpt?: BrowserChatGPT,
  ) {}
  initialize(): Promise<void> {
    return (this.initialized ??= this.initializeOnce().catch((error) => {
      this.initialized = undefined;
      throw error;
    }));
  }
  private async initializeOnce() {
    const { store, scope } = this;
    const config = this.configuration ?? (await loadConfiguration(scope, store));
    let chatgpt = this.chatgpt;
    const helper = config.chatgpt?.apiBase;
    if (!chatgpt && config.chatgpt?.mode === 'browser')
      chatgpt = new BrowserChatGPT(
        config.chatgpt.jwksUrl,
        undefined,
        undefined,
        config.chatgpt.modelRelay,
        config.app?.clientName,
      );
    const chatgptModel = chatgpt
      ? new OpenAIModel(
          () => chatgpt!.status(),
          (body, signal) => chatgpt!.responses(body, signal),
          (account, input, signal, pin) => chatgpt!.compact({ account, input, pin }, signal),
        )
      : helper
        ? new OpenAIModel(
            async () => {
              const status = await helperStatus(helper);
              if (!status.connected)
                throw new SignInRequired('Connect ChatGPT in Connections to continue.');
              return { account: status.account ?? 'default', model: status.model };
            },
            httpTransport(new URL('responses', helper).href),
          )
        : undefined;
    // Created below; the router asks it for the models its connection serves.
    let connections: Connections | undefined;
    const router = new ModelRouter(
      store,
      {
        ...provider('chatgpt', chatgptModel ?? new MockModel(), async () =>
          chatgpt ? chatgpt.turnSettings() : {},
        ),
        // Signed in; without ChatGPT here, only the sample model would answer. A helper that
        // cannot be reached counts as signed in, so the turn waits for it as before.
        usable: async () =>
          chatgpt
            ? (await chatgpt.status()).connected
            : Boolean(
                helper &&
                (await helperStatus(helper).catch(() => ({ connected: true })))?.connected,
              ),
      },
      provider(
        'custom',
        new CompatModel(
          async () => (await store.get<CustomModel | null>(customModelKey)) ?? undefined,
        ),
        async () => ({ model: (await store.get<CustomModel | null>(customModelKey))?.model }),
      ),
      // Only while the server lists a model, so nothing else changes when it does not.
      async () => {
        const served = await connections?.modelProvider();
        return served && (await served.list()).length ? [served] : [];
      },
    );
    const runtime = new Runtime(store, this.changed, router);
    runtime.notify = async (alert) => {
      if (await store.get<boolean>('notify')) await this.notify(alert);
    };
    connections = new Connections(store, runtime.plugins, config, scope, () => chatgpt!.status());
    if (!capabilities().linkPlugins) {
      // Plugins from a link do not run, including in saved chats and jobs.
      runtime.plugins.allowed = (plugin) => this.fromApp(plugin.source);
      // Only a confirmed iOS app turns them off for good. An unknown platform may be an older
      // shell on another system, which must keep its plugins for when it can tell.
      if (clientPlatform() === 'ios')
        for (const plugin of await runtime.plugins.list())
          if (plugin.enabledAt !== null && !this.fromApp(plugin.source))
            await runtime.plugins.enable(plugin.manifest.id, false);
    }
    await runtime.recover();
    this.runtime = runtime;
    this.router = router;
    this.connections = connections;
    this.chatgpt = chatgpt;
  }
  async handle(data: Record<string, unknown>, reply: (message: HostReply) => void) {
    const maintenance = ['archiveExport', 'archiveImport'].includes(String(data.op));
    return navigator.locks.request(
      'kinetik-workspace-maintenance',
      { mode: maintenance ? 'exclusive' : 'shared', ifAvailable: maintenance },
      async (lock) => {
        if (!lock) {
          reply({ ok: false, error: 'Wait for current work to finish before transferring data.' });
          return;
        }
        return this.handleRequest(data, reply);
      },
    );
  }
  private async handleRequest(data: Record<string, unknown>, reply: (message: HostReply) => void) {
    if (data.protocol !== protocolVersion) return reply({ ok: false, error: reloadHint });
    await this.initialize();
    const { runtime, connections, chatgpt, store } = this;
    let followup: string | undefined;
    try {
      let result: unknown;
      switch (data.op) {
        case 'archiveExport':
        case 'archiveImport': {
          const busy =
            (await runtime.conversations(() => false)).some((c) =>
              ['running', 'queued', 'waiting'].includes(c.status),
            ) ||
            (await store.entries<BackgroundProcess>('background:')).some(([, job]) =>
              ['running', 'waiting'].includes(job.state),
            );
          if (busy) throw new Error('Wait for current work to finish before transferring data.');
          if (data.op === 'archiveExport') result = await exportArchive(store);
          else {
            const records = await parseArchive(string(data.text));
            await store.replace(
              records,
              (key) => key.startsWith('connection') || key === 'deployment-config',
            );
            this.initialized = undefined;
            result = { ok: true };
          }
          break;
        }
        case 'chatgpt':
          if (!chatgpt) throw new Error('Browser ChatGPT sign-in is not configured.');
          switch (data.action) {
            case 'models':
              result = await chatgpt.models();
              break;
            case 'model':
              result = await chatgpt.chooseModel(string(data.model));
              break;
            case 'reasoning':
              result = await chatgpt.chooseReasoning(string(data.effort));
              break;
            case 'login':
              result = await chatgpt.login(
                this.configuration?.native && data.redirectUri
                  ? string(data.redirectUri)
                  : undefined,
              );
              break;
            case 'callback':
              result = await chatgpt.callback(string(data.url));
              break;
            case 'logout':
              result = await chatgpt.logout();
              break;
            default:
              throw new Error('Unknown ChatGPT action.');
          }
          break;
        case 'setupState':
          result = await connections.state();
          break;
        case 'connectionCanFinish':
          result = await connections.canFinish(string(data.state));
          break;
        case 'connectionPrepare':
        case 'connectionBegin':
        case 'connectionFinish':
        case 'connectionActivate':
        case 'connectionDisconnect':
          result = await navigator.locks.request('kinetik-connection:charms', async () => {
            switch (data.op) {
              case 'connectionPrepare':
                return connections.prepare();
              case 'connectionBegin':
                return connections.begin(
                  data.handoff === true,
                  this.configuration?.native && data.redirectUri
                    ? string(data.redirectUri)
                    : undefined,
                );
              case 'connectionActivate':
                return connections.activate();
              case 'connectionDisconnect':
                return connections.disconnect();
              case 'connectionFinish':
                return connections.finish({
                  state: string(data.state),
                  code: data.code ? string(data.code) : undefined,
                  error: data.error ? string(data.error) : undefined,
                  issuer: data.issuer ? string(data.issuer) : undefined,
                });
            }
          });
          break;
        case 'state':
          result = {
            automations: await runtime.automations.list(),
            background: (await store.entries<BackgroundProcess>('background:'))
              .filter(([, job]) => ['running', 'waiting'].includes(job.state))
              .map(([, { id, conversationId, tool, state, startedAt }]) => ({
                id,
                conversationId,
                tool,
                state,
                startedAt,
              })),
            // A window names the chat it shows; the others come without their messages.
            conversations: (
              await runtime.conversations(
                (id) => data.conversation === undefined || id === data.conversation,
              )
            ).map((c) => ({
              ...c,
              plugins: undefined,
              ...(data.conversation === undefined || c.id === data.conversation
                ? {}
                : { attachments: undefined, draft: undefined }),
            })),
            plugins: (await runtime.plugins.list()).map((p) => ({
              manifest: p.manifest,
              enabledAt: p.enabledAt,
              source: p.source,
              digest: p.digest,
            })),
          };
          break;
        case 'trace':
          result = await recentTrace(store);
          break;
        case 'tick':
        case 'resume':
          break;
        case 'automationCreate':
          result = await runtime.automations.create(data.input as Record<string, unknown>);
          break;
        case 'automationStatus':
          await runtime.automations.setStatus(
            string(data.id),
            data.status as 'active' | 'paused' | 'completed',
          );
          break;
        case 'automationRemove':
          await runtime.automations.remove(string(data.id));
          break;
        case 'event':
          await runtime.automations.emit(
            string(data.name),
            string(data.text),
            data.id as string | undefined,
          );
          break;
        case 'appApproval':
          if (!data.input || typeof data.input !== 'object' || Array.isArray(data.input))
            throw new Error('Invalid tool input.');
          result = await runtime.appNeedsApproval(
            string(data.id),
            string(data.name),
            data.input as Record<string, unknown>,
          );
          break;
        case 'delete':
          await runtime.deleteConversation(string(data.id));
          break;
        case 'appCall':
          if (!data.input || typeof data.input !== 'object' || Array.isArray(data.input))
            throw new Error('Invalid tool input.');
          result = await runtime.appCall(
            string(data.id),
            string(data.name),
            data.input as Record<string, unknown>,
            data.approved === true,
          );
          break;
        case 'create':
          result = await runtime.create();
          break;
        case 'submit':
          followup = string(data.id);
          await runtime.submit(
            followup,
            string(data.text),
            typeof data.messageId === 'string' && /^[\w-]{8,64}$/.test(data.messageId)
              ? data.messageId
              : undefined,
            data.attachments as string[] | undefined,
            data.queue === 'after' ? 'after' : undefined,
          );
          break;
        case 'answer':
          followup = string(data.id);
          await runtime.answer(followup, string(data.value));
          break;
        case 'notifications':
          if (data.enabled !== undefined) await runtime.store.put('notify', data.enabled === true);
          result = (await runtime.store.get<boolean>('notify')) === true;
          break;
        case 'customModel':
          result = await customModelAction(store, data);
          break;
        case 'models': {
          // The models a connection serves. ChatGPT and the custom model keep their own actions.
          const served = await connections.modelProvider();
          if (data.action === 'choose') {
            if (!served || data.provider !== served.id) throw new Error('Unknown model.');
            await served.choose(string(data.model));
            await store.put('model-choice', served.id);
          }
          if (data.action === 'consent') await served?.consent();
          // Only the menu's follow-up asks the server and waits; the rest reads the saved list.
          const models = served
            ? data.action === 'refresh'
              ? await served.refresh(true)
              : await served.current()
            : [];
          result = {
            choice: (await this.router.choice()).id,
            consented: (await served?.consented()) ?? false,
            providers:
              served && (await served.usable())
                ? [{ id: served.id, models, selected: (await served.chosen())?.id }]
                : [],
          };
          break;
        }
        case 'memory':
          if (data.text !== undefined) {
            if (typeof data.text !== 'string' || data.text.length > 4000)
              throw new Error('Memory must be text up to 4,000 characters.');
            await saveMemory(runtime.store, data.text, 'you');
          }
          if (data.undo === true) await undoMemory(runtime.store);
          result = (await runtime.store.get<string>(memoryKey)) ?? '';
          break;
        case 'memoryChange':
          result = (await runtime.store.get<MemoryChange>(memoryChangeKey)) ?? null;
          break;
        case 'attachmentStage':
          if (!(data.bytes instanceof Uint8Array)) throw new Error('Invalid file bytes.');
          if (data.preview !== undefined && !(data.preview instanceof Uint8Array))
            throw new Error('Invalid file preview.');
          result = await runtime.stageAttachment(
            string(data.id),
            string(data.name),
            data.bytes,
            data.preview,
          );
          break;
        case 'attachmentPreview':
          result = (await runtime.attachmentPreview(string(data.attachmentId))) ?? null;
          break;
        case 'attachmentRemove':
          await runtime.removeAttachment(string(data.id), string(data.attachmentId));
          break;
        case 'stop':
          await runtime.stop(string(data.id));
          break;
        case 'resolve':
          followup = string(data.id);
          await runtime.resolve(followup, data.retry === true);
          break;
        case 'install': {
          const settings = JSON.parse(string(data.settings ?? '{}')) as Record<string, unknown>;
          if (
            !settings ||
            Array.isArray(settings) ||
            typeof settings !== 'object' ||
            Object.values(settings).some((v) => typeof v !== 'string')
          )
            throw new Error('Plugin settings must be a JSON object of strings.');
          this.assertPluginSource(string(data.source));
          await runtime.plugins.install(string(data.source), settings as Record<string, string>);
          break;
        }
        case 'enable':
          if (data.id === 'charms')
            await navigator.locks.request('kinetik-connection:charms', () =>
              connections.setEnabled(data.enabled === true),
            );
          else {
            const plugin = (await runtime.plugins.list()).find((p) => p.manifest.id === data.id);
            if (plugin && data.enabled === true) this.assertPluginSource(plugin.source);
            await runtime.plugins.enable(string(data.id), data.enabled === true);
          }
          break;
        case 'update': {
          const plugin = (await runtime.plugins.list()).find((p) => p.manifest.id === data.id);
          if (!plugin) throw new Error('Plugin not found.');
          this.assertPluginSource(plugin.source);
          await runtime.plugins.install(plugin.source, plugin.settings, plugin.manifest.id);
          break;
        }
        case 'import':
          if (!(data.bytes instanceof Uint8Array)) throw new Error('Invalid file bytes.');
          await runtime.importFile(string(data.name), data.bytes);
          break;
        case 'files':
          result = await runtime.files();
          break;
        case 'export-shared':
          result = await runtime.exportSharedFile(string(data.id));
          break;
        case 'export':
          result = await runtime.exportFile(string(data.path));
          break;
        default:
          throw new Error('Unknown request.');
      }
      reply({ ok: true, result });
      if (data.op === 'resume') await runtime.recover();
      if (followup) await runtime.run(followup);
      if (['tick', 'automationCreate', 'automationStatus', 'event'].includes(data.op as string))
        await runtime.automations.tick();
      if (data.op === 'state' || data.op === 'resume')
        await Promise.all(
          (await runtime.conversations(() => false))
            .filter((c) => c.status === 'queued' || c.status === 'running')
            .map((c) => runtime.run(c.id)),
        );
    } catch (error) {
      reply({ ok: false, error: errorText(error), failureKind: failureKind(error) });
    } finally {
      await runtime.background.drain();
    }
  }
  /** Served with the app. A path check, not an origin check: the iOS app's origin is opaque. */
  private fromApp(source: string) {
    try {
      return new URL(source, this.scope).href.startsWith(this.scope.href);
    } catch {
      return false;
    }
  }
  /** Where plugins cannot come from a link, only the ones served with the app may run. */
  private assertPluginSource(source: string) {
    if (!capabilities().linkPlugins && !this.fromApp(source))
      throw new Error('On this device, Kinetik runs only plugins that come with the app.');
  }
}

/** The sign-in helper's ChatGPT status. */
async function helperStatus(
  helper: string,
): Promise<{ connected?: boolean; account?: string; model: string }> {
  const response = await fetch(new URL('status', helper), {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (response.status >= 500 || [408, 429].includes(response.status))
    throw new ConnectionError('The model connection is unavailable.');
  if (!response.ok) return { connected: false, model: '' };
  return response.json();
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string.');
  return value;
}
