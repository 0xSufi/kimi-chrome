import React from 'react';
import { usePermissionStore } from '../stores/permissions';

export function PermissionPrompt(): React.ReactElement | null {
  const { pending, resolve } = usePermissionStore();
  if (!pending) return null;

  const respond = (action: 'allow' | 'deny', duration: 'once' | 'always') => {
    resolve({ action, duration });
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'var(--bg-100, #fff)',
          color: 'var(--text-100, #1a1a1a)',
          borderRadius: 12,
          maxWidth: 360,
          width: '100%',
          padding: 20,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.25)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Allow tool access?</h2>
        <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.5, color: 'var(--text-300, #4b5563)' }}>
          <strong>{pending.tool}</strong> wants to act on{' '}
          <code style={{
            background: 'var(--bg-000, #f3f4f6)',
            padding: '1px 6px',
            borderRadius: 4,
            fontSize: 12,
          }}>{pending.netloc}</code>.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={() => respond('allow', 'once')} style={btn('primary')}>
            Allow once
          </button>
          <button onClick={() => respond('allow', 'always')} style={btn('secondary')}>
            Allow always on {pending.netloc}
          </button>
          <button onClick={() => respond('deny', 'once')} style={btn('subtle')}>
            Deny
          </button>
          <button onClick={() => respond('deny', 'always')} style={btn('danger')}>
            Deny always on {pending.netloc}
          </button>
        </div>
      </div>
    </div>
  );
}

function btn(variant: 'primary' | 'secondary' | 'subtle' | 'danger'): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    border: '1px solid transparent',
    textAlign: 'center',
  };
  switch (variant) {
    case 'primary':
      return { ...base, background: '#c96442', color: '#fff', borderColor: '#c96442' };
    case 'secondary':
      return { ...base, background: 'transparent', color: '#c96442', borderColor: '#c96442' };
    case 'subtle':
      return { ...base, background: 'transparent', color: 'var(--text-300, #4b5563)', borderColor: 'var(--border-300, #d1d5db)' };
    case 'danger':
      return { ...base, background: 'transparent', color: '#b91c1c', borderColor: 'var(--border-300, #d1d5db)' };
  }
}
