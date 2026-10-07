/** Transient transport failures are resumable; tool side effects are not retried. */
export class ConnectionError extends Error {}
export class SignInRequired extends Error {}
/** The provider asks to wait; the request is sent again after `retryAfterMs` when it says how long. */
export class RateLimited extends ConnectionError {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
/** The user has not yet been told where messages to this model go; the turn waits for that. */
export class ConsentRequired extends SignInRequired {}
/** The account has no credits left for the provider's model. Retrying does not help until it has. */
export class OutOfCredits extends Error {}
/** The request no longer fits the model's context or output budget; compaction may help. */
export class ContextOverflow extends Error {}
/** The provider refused this request as sent, so a ChatGPT compaction just before it is undone. */
export class ModelRejected extends Error {}

export function isConnectionError(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) ||
    (error instanceof DOMException && ['NetworkError', 'TimeoutError'].includes(error.name))
  );
}

/** An invalid provider response, distinct from local application failures. */
export class ModelFailure extends Error {}
export type FailureKind = 'app' | 'network' | 'model';
export class OperationFailure extends Error {
  constructor(
    message: string | undefined,
    readonly failureKind: FailureKind = 'app',
  ) {
    super(message);
  }
}
export function failureKind(error: unknown): FailureKind {
  if (error instanceof OperationFailure) return error.failureKind;
  if (isConnectionError(error)) return 'network';
  if (
    error instanceof SignInRequired ||
    error instanceof OutOfCredits ||
    error instanceof ContextOverflow ||
    error instanceof ModelRejected ||
    error instanceof ModelFailure
  )
    return 'model';
  return 'app';
}
