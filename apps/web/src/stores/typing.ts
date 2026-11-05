import { create } from 'zustand';

/** How long a typing signal stays visible without a new one (the sender throttles to 1.5s). */
export const TYPING_VISIBLE_MS = 3_500;

interface TypingState {
  /** conversationId → when the other participant last signalled typing. */
  at: Record<string, number>;
  mark: (conversationId: string) => void;
  clear: (conversationId: string) => void;
}

const expiry = new Map<string, ReturnType<typeof setTimeout>>();

/** Typing signals expire on their own, so components only read a flag. */
export const useTyping = create<TypingState>((set) => {
  const clear = (conversationId: string) => {
    clearTimeout(expiry.get(conversationId));
    expiry.delete(conversationId);
    set((state) => {
      const { [conversationId]: _removed, ...rest } = state.at;
      return { at: rest };
    });
  };
  return {
    at: {},
    mark: (conversationId) => {
      clearTimeout(expiry.get(conversationId));
      expiry.set(
        conversationId,
        setTimeout(() => clear(conversationId), TYPING_VISIBLE_MS),
      );
      set((state) => ({ at: { ...state.at, [conversationId]: Date.now() } }));
    },
    clear,
  };
});

/** The conversation open on screen, so arriving messages there don't count as unread. */
export const useActiveConversation = create<{
  id: string | null;
  set: (id: string | null) => void;
}>((set) => ({ id: null, set: (id) => set({ id }) }));
