/** Transient transport failures are resumable; tool side effects are not retried. */
export class ConnectionError extends Error {}
export class SignInRequired extends Error {}
/** The request no longer fits the model's context or output budget; compaction may help. */
export class ContextOverflow extends Error {}

export function isConnectionError(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) ||
    (error instanceof DOMException && ['NetworkError', 'TimeoutError'].includes(error.name))
  );
}
