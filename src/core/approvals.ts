import type { Store } from './ports';

export const approvalsKey = 'ask-before-actions';
/**
 * Kinetik acts without asking by default. Approval cards come back only for someone who opted in
 * under this key; a tool's `approval` then decides which calls ask.
 */
export const approvalsOn = async (store: Store) =>
  (await store.get<boolean>(approvalsKey)) === true;
