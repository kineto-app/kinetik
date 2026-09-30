export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  createdAt: number;
  tool?: string;
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
}
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  pending: string[];
  status: RunStatus;
  activeMessage?: string;
  plugins?: InstalledPlugin[];
  call?: ToolCall;
  updatedAt: number;
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
  signal: AbortSignal;
  checkpoint(operationId: string): Promise<void>;
}
export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
  recover?(operationId: string, signal: AbortSignal): Promise<{ done: boolean; result?: unknown }>;
  cancel?(operationId: string): Promise<void>;
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
}
export type ModelStep =
  { type: 'text'; text: string } | { type: 'tool'; name: string; input: Record<string, unknown> };
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
