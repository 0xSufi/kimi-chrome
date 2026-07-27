import React, { useCallback, useEffect, useRef } from 'react';
import { useMessageStore } from '../stores/messages';
import { HostClient, readHostConfig } from '../services/host-client';
import { MessageBubble } from './MessageBubble';
import { ConnectionStatus } from './ConnectionStatus';

export function ChatView(): React.ReactElement {
  const {
    messages,
    isStreaming,
    inputText,
    pendingSubmit,
    setInputText,
    appendMessage,
    updateMessage,
    setIsStreaming,
    clearMessages,
  } = useMessageStore();

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<HostClient | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const [hasHostConfig, setHasHostConfig] = React.useState<boolean | null>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    const refresh = () => {
      void readHostConfig().then((cfg) => setHasHostConfig(!!cfg));
    };
    refresh();
    const listener = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && (changes.DYSPEL_HOST_URL || changes.DYSPEL_HOST_TOKEN)) refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    const ta = inputRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
  }, [inputText]);

  useEffect(() => () => {
    clientRef.current?.close();
    clientRef.current = null;
  }, []);

  // SW broadcasts AGENT_STOPPED when the on-page Stop button is clicked
  // (or any caller wires that into the runtime). Interrupt the host
  // client and clear local streaming state.
  useEffect(() => {
    const onMessage = (msg: { type?: string }) => {
      if (msg?.type !== 'AGENT_STOPPED') return;
      try { clientRef.current?.sendInterrupt(); } catch {}
      const id = streamingIdRef.current;
      if (id) updateMessage(id, { isStreaming: false, error: 'stopped' });
      streamingIdRef.current = null;
      setIsStreaming(false);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [updateMessage, setIsStreaming]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isStreaming) return;

    const cfg = await readHostConfig();
    if (!cfg) {
      appendMessage({ id: `m_${Date.now()}_u`, role: 'user', content: text, timestamp: Date.now() });
      setInputText('');
      appendMessage({
        id: `m_${Date.now()}_e`,
        role: 'system',
        content: 'Kimi server not configured. Open settings to set the host URL and auth token.',
        timestamp: Date.now(),
        error: 'no host config',
      });
      chrome.runtime.openOptionsPage();
      return;
    }

    appendMessage({ id: `m_${Date.now()}_u`, role: 'user', content: text, timestamp: Date.now() });
    setInputText('');

    const assistantId = `m_${Date.now()}_a`;
    appendMessage({ id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true });
    streamingIdRef.current = assistantId;
    setIsStreaming(true);

    if (!clientRef.current) {
      clientRef.current = new HostClient(cfg, {
        onTextDelta: (delta) => {
          const id = streamingIdRef.current;
          if (!id) return;
          const cur = useMessageStore.getState().messages.find((m) => m.id === id);
          if (!cur) return;
          updateMessage(id, { content: cur.content + delta });
        },
        onToolUse: (block) => {
          const id = streamingIdRef.current;
          if (!id) return;
          updateMessage(id, { toolUse: { name: block.name, input: (block.input as Record<string, unknown>) ?? {} } });
        },
        onResult: () => {
          const id = streamingIdRef.current;
          if (id) updateMessage(id, { isStreaming: false });
          streamingIdRef.current = null;
          setIsStreaming(false);
        },
        onClose: (reason) => {
          const id = streamingIdRef.current;
          if (id) updateMessage(id, { isStreaming: false, error: reason ?? 'connection closed' });
          streamingIdRef.current = null;
          setIsStreaming(false);
        },
        onError: (err) => {
          const id = streamingIdRef.current;
          if (id) updateMessage(id, { isStreaming: false, error: err.message });
          streamingIdRef.current = null;
          setIsStreaming(false);
        },
      });
    }

    try {
      await clientRef.current.sendUserMessage(text);
    } catch (e) {
      const id = streamingIdRef.current;
      if (id) updateMessage(id, { isStreaming: false, error: e instanceof Error ? e.message : String(e) });
      streamingIdRef.current = null;
      setIsStreaming(false);
      clientRef.current?.close();
      clientRef.current = null;
    }
  }, [inputText, isStreaming, appendMessage, updateMessage, setInputText, setIsStreaming]);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  // Auto-submit when something queues a prompt (e.g. a scheduled task
  // alarm fires while the side panel is open). pendingSubmit is a
  // counter so repeated identical prompts each retrigger.
  const lastSubmitRef = useRef(0);
  useEffect(() => {
    if (pendingSubmit === 0 || pendingSubmit === lastSubmitRef.current) return;
    if (!inputText.trim() || isStreaming) return;
    lastSubmitRef.current = pendingSubmit;
    void handleSend();
  }, [pendingSubmit, inputText, isStreaming, handleSend]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      background: 'var(--bg-000, #faf9f5)',
      color: 'var(--text-100, #1a1a1a)',
    }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-200, #e5e7eb)',
        background: 'var(--bg-100, #fff)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Kimi</span>
          <ConnectionStatus />
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => {
              clientRef.current?.close();
              clientRef.current = null;
              clearMessages();
            }}
            title="Clear conversation"
            style={{
              fontSize: 11, padding: '4px 8px', borderRadius: 6,
              border: '1px solid var(--border-300, #d1d5db)',
              background: 'transparent',
              color: 'var(--text-300, #4b5563)',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        )}
      </header>

      <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            flex: 1, color: 'var(--text-400, #9ca3af)', gap: 12, textAlign: 'center', padding: 24,
          }}>
            {hasHostConfig === false ? (
              <>
                <span style={{ fontSize: 14 }}>Host server not configured.</span>
                <button
                  onClick={() => chrome.runtime.openOptionsPage()}
                  style={{
                    fontSize: 13, padding: '6px 14px', borderRadius: 8,
                    background: '#c96442', color: '#fff', border: 'none', cursor: 'pointer',
                  }}
                >
                  Open settings
                </button>
              </>
            ) : (
              <span style={{ fontSize: 14 }}>Start a conversation</span>
            )}
          </div>
        )}
        {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
        <div ref={endRef} />
      </div>

      <div style={{
        padding: '12px 16px 16px',
        borderTop: '1px solid var(--border-200, #e5e7eb)',
        background: 'var(--bg-100, #fff)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 8,
          background: 'var(--bg-000, #faf9f5)',
          borderRadius: 12,
          border: '1px solid var(--border-300, #d1d5db)',
          padding: '8px 12px',
        }}>
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Message Kimi…"
            rows={1}
            style={{
              flex: 1, resize: 'none', border: 'none', outline: 'none',
              background: 'transparent', fontSize: 14, lineHeight: 1.5,
              fontFamily: 'inherit', color: 'inherit', maxHeight: 200,
            }}
          />
          {isStreaming ? (
            <button
              onClick={() => void chrome.runtime.sendMessage({ type: 'STOP_AGENT' }).catch(() => {})}
              title="Stop"
              style={{
                width: 32, height: 32, borderRadius: 8, border: 'none',
                background: '#1a1a1a',
                color: '#fff',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => void handleSend()}
              disabled={!inputText.trim()}
              style={{
                width: 32, height: 32, borderRadius: 8, border: 'none',
                background: inputText.trim() ? '#c96442' : '#d1d5db',
                color: '#fff',
                cursor: inputText.trim() ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16">
                <path d="M3 8L8 3L13 8M8 3V13" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
