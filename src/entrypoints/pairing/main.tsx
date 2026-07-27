import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InternalMessage } from '../../core/protocol';

function closeSelf(): void {
  chrome.tabs.getCurrent((tab) => {
    if (tab?.id != null) void chrome.tabs.remove(tab.id);
  });
}

function PairingPrompt({ requestId, clientType, currentName }: {
  requestId: string;
  clientType: string;
  currentName?: string;
}): React.ReactElement {
  const [name, setName] = useState(currentName ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const confirm = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    chrome.runtime.sendMessage({ type: InternalMessage.PAIRING_CONFIRMED, request_id: requestId, name: trimmed });
    setTimeout(closeSelf, 100);
  }, [name, requestId]);

  const dismiss = useCallback(() => {
    chrome.runtime.sendMessage({ type: InternalMessage.PAIRING_DISMISSED, request_id: requestId });
    setTimeout(closeSelf, 100);
  }, [requestId]);

  const label = clientType === 'claude-code' ? 'Dyspel CLI' : 'Dyspel Desktop';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 16, padding: 20,
      background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
      boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxWidth: 400, width: '100%',
    }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>{label} wants to connect</h3>
        <p style={{ margin: '4px 0 0', fontSize: 14, color: '#6b7280' }}>
          Name this browser so you can identify it later.
        </p>
      </div>

      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
        placeholder='e.g., "Work laptop", "Personal Chrome"'
        style={{
          width: '100%', padding: '8px 12px', fontSize: 14,
          borderRadius: 8, border: '1px solid #d1d5db', outline: 'none', boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={dismiss} style={{
          padding: '8px 16px', fontSize: 14, borderRadius: 8,
          border: '1px solid #d1d5db', background: 'transparent',
          cursor: 'pointer', color: '#6b7280',
        }}>Ignore</button>
        <button onClick={confirm} disabled={!name.trim()} style={{
          padding: '8px 16px', fontSize: 14, borderRadius: 8,
          border: 'none', background: name.trim() ? '#c96442' : '#d1d5db',
          color: '#fff', cursor: name.trim() ? 'pointer' : 'not-allowed',
        }}>Connect</button>
      </div>
    </div>
  );
}

function PairingPage(): React.ReactElement {
  const params = new URLSearchParams(window.location.search);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', padding: 16, background: '#f9fafb',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <PairingPrompt
        requestId={params.get('request_id') ?? ''}
        clientType={params.get('client_type') ?? 'desktop'}
        currentName={params.get('current_name') || undefined}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<PairingPage />);
