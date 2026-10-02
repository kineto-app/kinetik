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
