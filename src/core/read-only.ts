import Ajv from 'ajv';
import { abortable } from './abortable';
import type { ConversationStore } from './conversation-store';
import { functionOutput, printable } from './model-input';
import { toolOutcome } from './tool-outcome';
import {
  addUsage,
  errorText,
  message,
  type Binding,
  type LiveProgress,
  type ModelRequest,
  type ModelStep,
} from './types';

type Item = Record<string, unknown>;
type ReadOnlyResult = { text: string; response?: unknown; failed?: boolean };
/** Kinetik's own read-only tools: their errors are facts the model can act on, not uncertain effects. */
export const readOnlyLocal = new Set(['read', 'list', 'read_skill']);
/** Kinetik's own tools that change nothing, so several may run at once. */
const parallelSafe = readOnlyLocal;
/** Local calls that change nothing, so a restart runs them again instead of asking for review. */
export const rerunnable = new Set([...readOnlyLocal, 'delegate']);
const helperSteps = 20;
const helperInstructions =
  'You are a helper for Kinetik, the main agent. Complete the task using only the read-only tools, then reply with concise findings the main agent needs: facts, file paths and short quotes. Do not ask questions; if something is missing, say so.';

type ReadOnlyDeps = {
  chats: ConversationStore;
  ask: (id: string, request: ModelRequest, signal: AbortSignal) => Promise<ModelStep>;
  live: Map<string, LiveProgress>;
  progress: (id: string, live: LiveProgress) => void;
};

/** Tools that change nothing: parallel batches and the helper sub-agent. */
export class ReadOnlyTools {
  private ajv = new Ajv({ strict: false });
  constructor(private deps: ReadOnlyDeps) {}
  /**
   * Runs several read-only calls at once. Nothing is journaled before they run: they change
   * nothing, so a crash simply asks the model again. Calls, outputs and messages are saved in one
   * write. A batch with any other tool runs nothing and every call gets an error to retry singly.
   */
  async runParallel(
    id: string,
    output: Extract<ModelStep, { type: 'tools' }>,
    bindings: Record<string, Binding>,
    signal: AbortSignal,
    backgroundTurn: boolean,
  ): Promise<string> {
    const allowed = output.calls.every(
      (call) => bindings[call.name]?.provider === 'local' && parallelSafe.has(call.name),
    );
    const results: ReadOnlyResult[] = allowed
      ? await Promise.all(output.calls.map((call) => this.runReadOnly(bindings, call, signal)))
      : output.calls.map(() => ({
          text: `Error: Only read-only tools (${[...parallelSafe].join(', ')}) may run in parallel. Nothing ran; call these one at a time.`,
          failed: true,
        }));
    await this.deps.chats.update(id, (value) => ({
      ...value,
      retryAt: undefined,
      retryAttempts: undefined,
      modelInput: [
        ...(value.modelInput ?? []),
        ...(output.items ?? []),
        ...output.calls.map((call, i) => functionOutput(call.callId, results[i].text)),
      ],
      messages: [
        ...value.messages,
        ...(output.narration
          ? [
              {
                ...message('assistant', output.narration),
                visibility: backgroundTurn ? ('internal' as const) : undefined,
              },
            ]
          : []),
        ...output.calls.map((call, i) => {
          const failed = results[i].failed === true;
          return {
            ...message(
              'tool',
              results[i].text,
              `${call.name} · ${bindings[call.name]?.provider ?? 'unknown'}`,
            ),
            activity: {
              input: call.input,
              outcome: failed ? ('failed' as const) : toolOutcome(results[i].response),
              returned: failed ? true : undefined,
            },
            visibility: backgroundTurn ? ('internal' as const) : undefined,
          };
        }),
      ],
    }));
    return results.map((r, i) => `${output.calls[i].name}: ${r.text}`).join('\n\n');
  }
  /** Runs one call to a tool that changes nothing; its errors become results. */
  async runReadOnly(
    bindings: Record<string, Binding>,
    call: { name: string; input: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ReadOnlyResult> {
    const binding = bindings[call.name];
    if (binding?.provider !== 'local' || !parallelSafe.has(call.name))
      return { text: `Error: There is no read-only tool named ${call.name}.`, failed: true };
    const validate = this.ajv.compile(binding.tool.inputSchema);
    if (!validate(call.input))
      return {
        text: 'Error: Invalid tool arguments: ' + this.ajv.errorsText(validate.errors),
        failed: true,
      };
    try {
      const timeout = AbortSignal.any([
        signal,
        AbortSignal.timeout(binding.tool.timeoutMs ?? 30000),
      ]);
      const response = await abortable(
        binding.tool.execute(call.input, { signal: timeout, checkpoint: async () => {} }),
        timeout,
      );
      return { text: printable(response), response };
    } catch (error) {
      if (signal.aborted) throw error;
      return { text: 'Error: ' + errorText(error), failed: true };
    }
  }
  /**
   * A helper agent with a fresh history and only read-only tools. It changes nothing, so a
   * restart may run it again. Its token use counts toward the turn.
   */
  async helper(
    id: string,
    task: string,
    bindings: Record<string, Binding>,
    signal: AbortSignal,
  ): Promise<string> {
    const tools = Object.fromEntries(
      Object.entries(bindings).filter(
        ([name, binding]) => binding.provider === 'local' && parallelSafe.has(name),
      ),
    );
    const definitions = Object.fromEntries(
      Object.entries(tools).map(([name, b]) => [
        name,
        { description: b.tool.description, inputSchema: b.tool.inputSchema },
      ]),
    );
    const history: Item[] = [{ role: 'user', content: task }];
    let result: string | undefined;
    for (let step = 1; step <= helperSteps; step++) {
      this.deps.progress(id, {
        step: this.deps.live.get(id)?.step ?? 1,
        tool: 'delegate',
        helperStep: step,
      });
      const output = await abortable(
        this.deps.ask(
          id,
          {
            message: task,
            instructions: helperInstructions,
            tools: Object.keys(tools),
            definitions,
            history: [...history],
            result,
          },
          signal,
        ),
        signal,
      );
      if (output.usage)
        await this.deps.chats.update(id, (value) => ({
          ...value,
          turnUsage: addUsage(value.turnUsage, output.usage),
        }));
      if (output.type === 'text') return output.text;
      const calls =
        output.type === 'tools'
          ? output.calls
          : [
              {
                name: output.name,
                input: output.input,
                callId: output.callId ?? crypto.randomUUID(),
              },
            ];
      history.push(
        ...(output.items ??
          calls.map((call) => ({
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: JSON.stringify(call.input),
          }))),
      );
      const outputs = await Promise.all(calls.map((call) => this.runReadOnly(tools, call, signal)));
      calls.forEach((call, i) => history.push(functionOutput(call.callId, outputs[i].text)));
      result = outputs.map((o) => o.text).join('\n\n');
    }
    return `The helper stopped after ${helperSteps} steps without a final answer.`;
  }
}
