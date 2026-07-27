import { create } from 'zustand';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  toolUse?: { name: string; input: Record<string, unknown> };
  error?: string;
}

interface MessageStore {
  messages: ChatMessage[];
  isStreaming: boolean;
  inputText: string;
  pendingSubmit: number; // bumped each time something queues an auto-submit
  sessionId: string;
  hydrated: boolean;
  appendMessage: (msg: ChatMessage) => void;
  updateMessage: (id: string, changes: Partial<ChatMessage>) => void;
  setIsStreaming: (v: boolean) => void;
  setInputText: (t: string) => void;
  queuePrompt: (text: string) => void;
  clearMessages: () => void;
}

const STORAGE_KEY = 'chatHistory';
const MAX_PERSISTED = 100;
const PERSIST_DEBOUNCE_MS = 250;

interface PersistedShape {
  messages: ChatMessage[];
  sessionId: string;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(snapshot: PersistedShape): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const trimmed: PersistedShape = {
      sessionId: snapshot.sessionId,
      // Drop any in-flight streaming flag so a refresh doesn't show a
      // ghost spinner on a message whose stream we'll never see again.
      messages: snapshot.messages
        .slice(-MAX_PERSISTED)
        .map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)),
    };
    void chrome.storage.local.set({ [STORAGE_KEY]: trimmed }).catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
}

export const useMessageStore = create<MessageStore>((set, get) => ({
  messages: [],
  isStreaming: false,
  inputText: '',
  pendingSubmit: 0,
  sessionId: `session_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
  hydrated: false,
  appendMessage: (msg) => {
    set((s) => ({ messages: [...s.messages, msg] }));
    schedulePersist({ messages: get().messages, sessionId: get().sessionId });
  },
  updateMessage: (id, changes) => {
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...changes } : m)) }));
    schedulePersist({ messages: get().messages, sessionId: get().sessionId });
  },
  setIsStreaming: (isStreaming) => set({ isStreaming }),
  setInputText: (inputText) => set({ inputText }),
  queuePrompt: (text) => set((s) => ({ inputText: text, pendingSubmit: s.pendingSubmit + 1 })),
  clearMessages: () => {
    set({ messages: [] });
    void chrome.storage.local.remove(STORAGE_KEY).catch(() => {});
  },
}));

export async function hydrateChatHistory(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY]);
    const data = stored[STORAGE_KEY] as PersistedShape | undefined;
    if (data && Array.isArray(data.messages)) {
      useMessageStore.setState({
        messages: data.messages,
        sessionId: data.sessionId ?? useMessageStore.getState().sessionId,
        hydrated: true,
      });
      return;
    }
  } catch {}
  useMessageStore.setState({ hydrated: true });
}
