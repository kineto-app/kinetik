export interface Attachment {
  id: string;
  name: string;
  size: number;
  path: string;
  provider: string;
}
export interface StagedAttachment {
  id: string;
  name: string;
  size: number;
  uploaded?: Attachment;
  uploadRevision?: string;
}
export function modelMessageText(value: Message): string {
  return (
    value.text +
    (value.attachments?.length
      ? '\n\nAttached files (already uploaded; use the named workspace provider to read them):\n' +
        value.attachments
          .map(({ name, path, provider }) => JSON.stringify({ name, path, provider }))
          .join('\n')
      : '')
  );
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  createdAt: number;
  /** Elapsed time for the completed agent turn, including connection waits. */
  durationMs?: number;
  /** Tokens the completed turn used across its model requests. */
  usage?: Usage;
  /** Marks the notice that replaced earlier model input with a summary. */
  compaction?: { items: number; tokens: number };
  attachments?: Attachment[];
  /** Queued to run after the current work instead of steering it; cleared once it starts. */
  queue?: 'after';
  /** Stopped before the model saw it. */
  unsent?: boolean;
  visibility?: 'internal';
  source?: 'background';
  tool?: string;
  activity?: {
    /** Keeps calls from separate widget instances independent. */
    scope?: string;
    input: Record<string, unknown>;
    outcome: 'completed' | 'failed' | 'running' | 'started' | 'unknown';
    /** The error went back to the model, which could act on it; not an unresolved failure. */
    returned?: boolean;
  };
  app?: AppView;
  file?: { path: string; name: string; snapshotId?: string };
}
export type Ask =
  | { kind: 'approval'; question: string }
  | { kind: 'choice'; question: string; options: string[] }
  | { kind: 'memory'; question: string; text: string };
export type LiveProgress = {
  step: number;
  tool?: string;
  reasoning?: string;
  activity?: 'summarising';
  /** Step of a helper agent started by `delegate`. */
  helperStep?: number;
};
/**
 * Pushed to open windows as hints. A window applies text and progress itself and reloads
 * state for anything else; persisted changes always arrive as a plain change.
 */
export type RuntimeEvent =
  | { type: 'text'; conversationId: string; text: string }
  | { type: 'reasoning'; conversationId: string; text: string }
  | ({ type: 'progress'; conversationId: string } & LiveProgress);
/** Segment `i` of generation `g` lives at `model-input:<conversation>:<g>:<i>`. */
export type InputSegments = { generation: string; segments: number };
export type TurnPin = { provider: 'chatgpt' | 'custom'; model?: string; effort?: string };
export type RunStatus =
  | 'idle'
  | 'running'
  | 'stopped'
  | 'needs_review'
  | 'queued'
  | 'waiting'
  /** Paused on a question to the user: an approval, a choice, or a memory edit. */
  | 'asking';
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  provider: string;
  state: 'pending' | 'completed' | 'unknown' | 'awaiting';
  /** What the user is asked while the call waits; set only in the awaiting state. */
  ask?: Ask;
  /** The user approved this call; it may now run. */
  approved?: boolean;
  result?: string;
  operationId?: string;
  callId?: string;
}
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  pending: string[];
  attachments?: StagedAttachment[];
  status: RunStatus;
  waitingFor?: 'connection' | 'signin';
  retryAt?: number;
  retryAttempts?: number;
  activeMessage?: string;
  turn?: 'foreground' | 'background';
  plugins?: InstalledPlugin[];
  call?: ToolCall;
  updatedAt: number;
  /** Persisted across steering and recovery; cleared when this turn ends. */
  workStartedAt?: number;
  /** A provider-side compaction not yet accepted by a request; undone if the next one fails. */
  serverCompaction?: { n: number; head: number };
  /** The model this turn uses; meaningful while `workStartedAt` is set. */
  turnModel?: TurnPin;
  /**
   * Model input as Runtime.update sees it. It is stored in append-only segments under
   * `input`, so a step writes only its new items; older builds stored it inline here.
   */
  modelInput?: Record<string, unknown>[];
  input?: InputSegments;
  /** Input tokens of the latest model request and the model's usable context. */
  context?: { tokens: number; window: number };
  /** Number of earlier model-input segments archived by compaction. */
  compactions?: number;
  /** Tokens used so far by the running turn. */
  turnUsage?: Usage;
  draft?: string;
  /** In-memory progress of the running turn, served with state so a reload shows it. */
  live?: LiveProgress;
}
export interface Skill {
  name: string;
  description: string;
  path: string;
  content: string;
}
export interface SkillSnapshot {
  revision: string;
  skills: Skill[];
}
export interface ToolContext {
  background?: boolean;
  signal: AbortSignal;
  checkpoint(operationId: string): Promise<void>;
}
export interface AppResource {
  html: string;
  csp?: Record<string, string[]>;
}
export interface AppView extends AppResource {
  id: string;
  input: Record<string, unknown>;
  result: unknown;
}
export interface ToolDefinition {
  /** Foreground request budget, clamped to 1–60 seconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  visibility?: ('model' | 'app')[];
  /** Ask the user before running: for actions that publish, send, pay or delete. */
  approval?: boolean | ((input: Record<string, unknown>) => boolean);
  app?: {
    resource(signal: AbortSignal): Promise<AppResource>;
    call(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  };
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
  recover?(operationId: string, signal: AbortSignal): Promise<{ done: boolean; result?: unknown }>;
  cancel?(operationId: string): Promise<void>;
  wait?(operationId: string, signal: AbortSignal): Promise<unknown>;
}
export interface Plugin {
  files?: {
    upload(
      file: { id: string; name: string; bytes: Uint8Array },
      signal: AbortSignal,
    ): Promise<{ path: string }>;
  };
  tools?: Record<string, ToolDefinition>;
  replacements?: Partial<
    Record<'exec' | 'read' | 'write' | 'edit' | 'list' | 'show_file', string | null>
  >;
  skills?: {
    sync(previous: SkillSnapshot | undefined, signal: AbortSignal): Promise<SkillSnapshot>;
  };
}
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  entry: string;
}
export interface InstalledPlugin {
  manifest: PluginManifest;
  source: string;
  resolvedSource: string;
  code: string;
  digest: string;
  enabledAt: number | null;
  settings: Record<string, string>;
}
export interface Binding {
  provider: string;
  tool: ToolDefinition;
}
export interface ModelRequest {
  message: string;
  instructions: string;
  tools: string[];
  result?: string;
  history?: Record<string, unknown>[];
  definitions?: Record<string, Pick<ToolDefinition, 'description' | 'inputSchema'>>;
  onText?: (text: string) => void;
  /** The model's reasoning summary so far, when the provider streams one. */
  onReasoning?: (text: string) => void;
  /** The model this turn uses, fixed when the turn starts. */
  pin?: TurnPin;
}
export interface Usage {
  input: number;
  output: number;
  cached?: number;
}
export type ModelStep = (
  | { type: 'text'; text: string; items?: Record<string, unknown>[] }
  | {
      type: 'tool';
      name: string;
      input: Record<string, unknown>;
      callId?: string;
      narration?: string;
      items?: Record<string, unknown>[];
    }
  | {
      /** Several calls in one response; only read-only tools may run this way. */
      type: 'tools';
      calls: { name: string; input: Record<string, unknown>; callId: string }[];
      narration?: string;
      items?: Record<string, unknown>[];
    }
) & { usage?: Usage; contextWindow?: number };
export interface Model {
  next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep>;
  /** The provider and model a new turn should use, when there is a choice. */
  pin?(): Promise<TurnPin | undefined>;
  /** Provider-side compaction of older input into opaque items, when the provider has it. */
  compact?(
    input: Record<string, unknown>[],
    pin: TurnPin | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[] | undefined>;
}
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const message = (role: Message['role'], text: string, tool?: string): Message => ({
  id: crypto.randomUUID(),
  role,
  text,
  tool,
  createdAt: Date.now(),
});

export const addUsage = (a: Usage | undefined, b: Usage | undefined): Usage | undefined =>
  !a ? b : !b ? a : { input: a.input + b.input, output: a.output + b.output };

export const needsApproval = (tool: ToolDefinition, input: Record<string, unknown>) =>
  tool.approval === true || (typeof tool.approval === 'function' && tool.approval(input));
