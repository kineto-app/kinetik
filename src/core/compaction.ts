/** Context limits and the summary that replaces older model input. */
export const defaultContextWindow = 200_000;
/** Compact once the latest request used this share of the usable window. */
export const compactAt = 0.75;
export const summaryPrefix = 'Summary of the earlier conversation:\n';
export const compactPrompt =
  'Summarise the conversation so far for your own future reference. Keep the user’s goals and preferences, decisions, facts and names, file paths and URLs, what was done and what remains. Write plain notes, at most 400 words. Do not call tools.';

/** Rough size for requests that report no usage; JSON overstates encrypted blobs, which is safe. */
export const estimateTokens = (input: unknown) => Math.ceil(JSON.stringify(input ?? []).length / 4);

/**
 * Where the kept tail starts: the latest user item, so the current request and every call
 * made for it stay verbatim and no function call is separated from its output.
 */
export function splitPoint(input: Record<string, unknown>[]): number {
  for (let i = input.length - 1; i > 0; i--) if (input[i].role === 'user') return i;
  return 0;
}
