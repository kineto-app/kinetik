type Item = Record<string, unknown>;

export const functionOutput = (callId: string, output: string): Item => ({
  type: 'function_call_output',
  call_id: callId,
  output,
});

/** Spreads rather than rebuilds, so the conversation store writes it as an append. */
export const withOutput = (
  input: Item[] | undefined,
  callId: string | undefined,
  output: string,
) => (callId ? [...(input ?? []), functionOutput(callId, output)] : input);

/** A tool result as model-visible text, capped at 64 KB. */
export const printable = (value: unknown) =>
  (typeof value === 'string'
    ? value
    : (JSON.stringify(value, (key, value) => (key === '_meta' ? undefined : value), 2) ?? 'Done.')
  ).slice(0, 65536);
