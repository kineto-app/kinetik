export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  createdAt: number;
  visibility?: 'internal';
  source?: 'background';
  tool?: string;
  app?: AppView;
  file?: { path: string; name: string };
}
export type RunStatus = 'idle' | 'running' | 'stopped' | 'needs_review' | 'queued';
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  provider: string;
  state: 'pending' | 'completed' | 'unknown';
  result?: string;
  operationId?: string;
  callId?: string;
}
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  pending: string[];
  status: RunStatus;
  activeMessage?: string;
  turn?: 'foreground' | 'background';
  plugins?: InstalledPlugin[];
  call?: ToolCall;
  updatedAt: number;
  modelInput?: Record<string, unknown>[];
  draft?: string;
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
  tools?: Record<string, ToolDefinition>;
  replacements?: Partial<Record<'exec' | 'read' | 'write' | 'edit' | 'list', string>>;
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
}
export type ModelStep =
  | { type: 'text'; text: string; items?: Record<string, unknown>[] }
  | {
      type: 'tool';
      name: string;
      input: Record<string, unknown>;
      callId?: string;
      items?: Record<string, unknown>[];
    };
export interface Model {
  next(request: ModelRequest, signal: AbortSignal): Promise<ModelStep>;
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
