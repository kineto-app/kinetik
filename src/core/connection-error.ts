/** Transient transport failures are resumable; tool side effects are not retried. */
export class ConnectionError extends Error {}
export class SignInRequired extends Error {}

export function isConnectionError(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) ||
    (error instanceof DOMException && ['NetworkError', 'TimeoutError'].includes(error.name))
  );
}
