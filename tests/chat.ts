import { ConversationStore } from '../src/core/conversation-store';
import type { Store } from '../src/core/ports';
import type { Conversation } from '../src/core/types';

/** A chat as the runtime sees it, with messages and model input joined from their segments. */
export const loadChat = async (store: Store, id: string) =>
  (await new ConversationStore(store, () => {}).load(id))!;
/** Changes a chat the way the runtime does, so its messages stay in segments. */
export const updateChat = (store: Store, id: string, update: (c: Conversation) => Conversation) =>
  new ConversationStore(store, () => {}).update(id, update);
