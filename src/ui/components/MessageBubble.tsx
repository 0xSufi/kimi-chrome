import React from 'react';
import type { ChatMessage } from '../stores/messages';

export function MessageBubble({ message, onApproval }: {
  message: ChatMessage;
  onApproval?: (messageId: string, approvalId: string, decision: 'approved' | 'rejected') => void;
}): React.ReactElement {
  if (message.role === 'system') {
    return (
      <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-400, #9ca3af)', padding: '4px 0' }}>
        {message.content}
      </div>
    );
  }

  const isUser = message.role === 'user';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 4 }}>
      <div style={{
        maxWidth: '85%',
        padding: '10px 14px',
        borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
        background: isUser ? '#c96442' : 'var(--bg-100, #fff)',
        color: isUser ? '#fff' : 'var(--text-100, #1a1a1a)',
        border: isUser ? 'none' : '1px solid var(--border-200, #e5e7eb)',
        fontSize: 14,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {message.isStreaming && !message.content ? <StreamingDots /> : message.content}

        {message.error && (
          <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(220,38,38,0.1)', color: '#dc2626', fontSize: 13 }}>
            {message.error}
          </div>
        )}

        {message.toolUse && (
          <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(201,100,66,0.1)', fontSize: 12, fontFamily: 'monospace' }}>
            <strong>{message.toolUse.name}</strong>
            <pre style={{ margin: '4px 0 0', fontSize: 11, overflow: 'auto' }}>
              {JSON.stringify(message.toolUse.input, null, 2)}
            </pre>
          </div>
        )}

        {message.approval && (
          <div style={{ marginTop: message.content ? 8 : 0, padding: 10, borderRadius: 6, background: 'rgba(201,100,66,0.08)', border: '1px solid rgba(201,100,66,0.3)', fontSize: 13 }}>
            <div style={{ marginBottom: 6 }}>
              Kimi wants to run <strong style={{ fontFamily: 'monospace' }}>{message.approval.toolName}</strong>
            </div>
            {message.approval.action && (
              <pre style={{ margin: '0 0 8px', fontSize: 11, fontFamily: 'monospace', overflow: 'auto', maxHeight: 120 }}>
                {message.approval.action}
              </pre>
            )}
            {message.approval.resolved ? (
              <div style={{ fontSize: 12, color: 'var(--text-400, #9ca3af)' }}>
                {message.approval.resolved === 'approved' ? 'Approved'
                  : message.approval.resolved === 'rejected' ? 'Rejected'
                  : 'Resolved elsewhere'}
              </div>
            ) : onApproval ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => onApproval(message.id, message.approval!.approvalId, 'approved')}
                  style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer' }}
                >
                  Approve
                </button>
                <button
                  onClick={() => onApproval(message.id, message.approval!.approvalId, 'rejected')}
                  style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid #dc2626', background: 'transparent', color: '#dc2626', cursor: 'pointer' }}
                >
                  Reject
                </button>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-400, #9ca3af)' }}>Pending…</div>
            )}
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-400, #9ca3af)', padding: '0 4px' }}>
        {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
}

function StreamingDots(): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', gap: 4, padding: '4px 0' }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'currentColor', opacity: 0.4,
          animation: `dyspel-pulse 1.4s infinite ${i * 0.2}s`,
        }} />
      ))}
      <style>{`
        @keyframes dyspel-pulse {
          0%, 80%, 100% { opacity: 0.4; transform: scale(1); }
          40% { opacity: 1; transform: scale(1.2); }
        }
      `}</style>
    </span>
  );
}
