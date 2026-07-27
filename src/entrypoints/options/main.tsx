import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Permission } from '../../core/permissions';
import type { ScheduledPrompt } from '../../core/scheduled-prompts';

// ============================================================
// Permissions
// ============================================================

function PermissionsTab(): React.ReactElement {
  const [permissions, setPermissions] = useState<Permission[]>([]);

  useEffect(() => {
    chrome.storage.local.get('permissions', (r) => {
      setPermissions(r.permissions ?? []);
    });
    const listener = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.permissions) {
        setPermissions((changes.permissions.newValue as Permission[] | undefined) ?? []);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const revoke = useCallback((id: string) => {
    chrome.storage.local.set({ permissions: permissions.filter((p) => p.id !== id) });
  }, [permissions]);

  const clearAll = useCallback(() => {
    chrome.storage.local.set({ permissions: [] });
  }, []);

  return (
    <div>
      <header style={rowBetween}>
        <h2 style={{ margin: 0 }}>Site Permissions</h2>
        {permissions.length > 0 && <button onClick={clearAll} style={btn}>Clear All</button>}
      </header>
      {permissions.length === 0 ? (
        <p style={{ color: '#6b7280' }}>No permissions granted yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Scope</th><th style={th}>Action</th><th style={th}>Duration</th><th style={th} /></tr></thead>
          <tbody>
            {permissions.map((p) => (
              <tr key={p.id}>
                <td style={td}>
                  {p.scope.type === 'netloc' ? p.scope.netloc : `${p.scope.from} → ${p.scope.to}`}
                </td>
                <td style={td}><Pill kind={p.action === 'allow' ? 'good' : 'bad'}>{p.action}</Pill></td>
                <td style={td}>{p.duration}</td>
                <td style={td}><button onClick={() => revoke(p.id)} style={{ ...btn, fontSize: 12, padding: '4px 8px' }}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ============================================================
// Scheduled prompts
// ============================================================

type RepeatType = ScheduledPrompt['repeatType'];

interface DraftPrompt {
  command: string;
  prompt: string;
  repeatType: RepeatType;
  scheduledTime: string;
  scheduledDay: string;
  scheduledMonth: string;
  skipPermissions: boolean;
}

function emptyDraft(): DraftPrompt {
  return {
    command: '',
    prompt: '',
    repeatType: 'daily',
    scheduledTime: '09:00',
    scheduledDay: '1',
    scheduledMonth: '1',
    skipPermissions: false,
  };
}

function PromptsTab(): React.ReactElement {
  const [prompts, setPrompts] = useState<ScheduledPrompt[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<DraftPrompt>(emptyDraft);

  useEffect(() => {
    chrome.storage.local.get('savedPrompts', (r) => setPrompts(r.savedPrompts ?? []));
    const listener = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.savedPrompts) {
        setPrompts((changes.savedPrompts.newValue as ScheduledPrompt[] | undefined) ?? []);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const remove = useCallback(async (id: string) => {
    chrome.storage.local.set({ savedPrompts: prompts.filter((p) => p.id !== id) });
    await chrome.alarms.clear(id);
  }, [prompts]);

  const toggle = useCallback((id: string) => {
    chrome.storage.local.set({
      savedPrompts: prompts.map((p) => p.id === id ? { ...p, enabled: !p.enabled, updatedAt: Date.now() } : p),
    });
  }, [prompts]);

  const runNow = useCallback((p: ScheduledPrompt) => {
    chrome.runtime.sendMessage({ type: 'EXECUTE_SCHEDULED_TASK', prompt: { ...p, skipPermissions: true } });
  }, []);

  const create = useCallback(async () => {
    if (!draft.prompt.trim()) return;
    const id = `prompt_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const newPrompt: ScheduledPrompt = {
      id,
      command: draft.command || undefined,
      prompt: draft.prompt,
      enabled: true,
      skipPermissions: draft.skipPermissions || undefined,
      repeatType: draft.repeatType,
      scheduledTime: draft.repeatType === 'none' ? undefined : draft.scheduledTime,
      scheduledDay: ['weekly', 'monthly', 'annually'].includes(draft.repeatType)
        ? parseInt(draft.scheduledDay, 10)
        : undefined,
      scheduledMonth: draft.repeatType === 'annually'
        ? parseInt(draft.scheduledMonth, 10)
        : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    chrome.runtime.sendMessage({ type: 'create_scheduled_prompt', prompt: newPrompt }, () => {
      setDraft(emptyDraft());
      setShowForm(false);
    });
  }, [draft]);

  return (
    <div>
      <header style={rowBetween}>
        <h2 style={{ margin: 0 }}>Scheduled Prompts</h2>
        {!showForm && <button onClick={() => setShowForm(true)} style={btn}>+ New prompt</button>}
      </header>

      {showForm && <PromptForm draft={draft} setDraft={setDraft} onCancel={() => { setShowForm(false); setDraft(emptyDraft()); }} onCreate={() => void create()} />}

      {prompts.length === 0 ? (
        <p style={{ color: '#6b7280' }}>No scheduled prompts yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Name</th><th style={th}>Schedule</th><th style={th}>Status</th><th style={th} /></tr></thead>
          <tbody>
            {prompts.map((p) => (
              <tr key={p.id}>
                <td style={td}>
                  <div style={{ fontWeight: 500 }}>{p.command || 'Untitled'}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    {p.prompt.slice(0, 80)}{p.prompt.length > 80 ? '…' : ''}
                  </div>
                </td>
                <td style={td}>
                  <div style={{ fontSize: 13 }}>{p.repeatType}</div>
                  {p.scheduledTime && <div style={{ fontSize: 12, color: '#6b7280' }}>{p.scheduledTime}</div>}
                </td>
                <td style={td}>
                  <span onClick={() => toggle(p.id)} style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                    background: p.enabled ? '#dcfce7' : '#f3f4f6',
                    color: p.enabled ? '#166534' : '#6b7280',
                  }}>
                    {p.enabled ? 'Active' : 'Paused'}
                  </span>
                </td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => runNow(p)} style={{ ...btn, fontSize: 12, padding: '4px 8px' }}>Run</button>
                    <button onClick={() => void remove(p.id)} style={{ ...btn, fontSize: 12, padding: '4px 8px', color: '#991b1b' }}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ============================================================
// Connection
// ============================================================

interface NativeHostStatus {
  nativeHostInstalled: boolean;
  mcpConnected: boolean;
  bridgeStatus?: 'disconnected' | 'connecting' | 'paired' | 'waiting';
}

const HOST_URL_KEY = 'DYSPEL_HOST_URL';
const HOST_TOKEN_KEY = 'DYSPEL_HOST_TOKEN';

function ConnectionTab(): React.ReactElement {
  const [status, setStatus] = useState<NativeHostStatus | null>(null);
  const [hostUrl, setHostUrl] = useState('');
  const [hostToken, setHostToken] = useState('');
  const [saved, setSaved] = useState<'idle' | 'saving' | 'done'>('idle');
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const refreshSignIn = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'oauth_status' }, (r) => {
      setSignedIn(!!r?.signedIn);
    });
  }, []);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'check_native_host_status' }, (r) => {
      setStatus((r?.status as NativeHostStatus | undefined) ?? null);
    });
    chrome.storage.local.get([HOST_URL_KEY, HOST_TOKEN_KEY], (r) => {
      setHostUrl((r[HOST_URL_KEY] as string | undefined) ?? '');
      setHostToken((r[HOST_TOKEN_KEY] as string | undefined) ?? '');
    });
    refreshSignIn();

    // Refresh sign-in status when storage changes (e.g. after OAuth callback).
    const listener = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && (changes.accessToken || changes.refreshToken)) refreshSignIn();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refreshSignIn]);

  const signIn = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'oauth_initiate' });
  }, []);

  const signOut = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'oauth_logout' }, () => refreshSignIn());
  }, [refreshSignIn]);

  const saveHost = useCallback(async () => {
    setSaved('saving');
    await chrome.storage.local.set({
      [HOST_URL_KEY]: hostUrl.trim(),
      [HOST_TOKEN_KEY]: hostToken.trim(),
    });
    setSaved('done');
    setTimeout(() => setSaved('idle'), 1500);
  }, [hostUrl, hostToken]);

  const bridgeColor = status?.bridgeStatus === 'paired' ? '#22c55e'
    : status?.bridgeStatus === 'waiting' ? '#3b82f6'
    : status?.bridgeStatus === 'connecting' ? '#f59e0b'
    : '#9ca3af';

  return (
    <div>
      <h2>Connection Status</h2>
      {status ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Row dot={status.nativeHostInstalled ? '#22c55e' : '#ef4444'}>
            Native host: {status.nativeHostInstalled ? 'Installed' : 'Not found'}
          </Row>
          <Row dot={status.mcpConnected ? '#22c55e' : '#9ca3af'}>
            MCP: {status.mcpConnected ? 'Connected' : 'Disconnected'}
          </Row>
          <Row dot={bridgeColor}>
            Bridge: {status.bridgeStatus ?? 'disconnected'}
          </Row>
        </div>
      ) : (
        <p style={{ color: '#6b7280' }}>Loading…</p>
      )}

      <h2 style={{ marginTop: 32 }}>Account</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {signedIn === null && <span style={{ color: '#6b7280', fontSize: 13 }}>Loading…</span>}
        {signedIn === true && (
          <>
            <Row dot="#22c55e">Signed in to claude.ai</Row>
            <button onClick={signOut} style={btn}>Sign out</button>
          </>
        )}
        {signedIn === false && (
          <>
            <Row dot="#9ca3af">Not signed in</Row>
            <button onClick={signIn} style={{ ...btn, background: '#c96442', color: '#fff', borderColor: '#c96442' }}>
              Sign in to claude.ai
            </button>
          </>
        )}
      </div>

      <h2 style={{ marginTop: 32 }}>Host Server (sidepanel chat)</h2>
      <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 12 }}>
        The side panel chat talks to a cc-wasm host server over HTTP+WS.
        Set the URL (e.g. <code>http://127.0.0.1:7474</code>) and the bearer token.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
        <label style={fieldLabel}>
          Host URL
          <input
            type="text"
            value={hostUrl}
            onChange={(e) => setHostUrl(e.target.value)}
            placeholder="http://127.0.0.1:7474"
            style={field}
          />
        </label>
        <label style={fieldLabel}>
          Auth token
          <input
            type="password"
            value={hostToken}
            onChange={(e) => setHostToken(e.target.value)}
            placeholder="bearer token"
            style={field}
          />
        </label>
        <div>
          <button onClick={() => void saveHost()} disabled={saved === 'saving'} style={btn}>
            {saved === 'done' ? 'Saved ✓' : saved === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PromptForm({
  draft, setDraft, onCancel, onCreate,
}: {
  draft: DraftPrompt;
  setDraft: (d: DraftPrompt) => void;
  onCancel: () => void;
  onCreate: () => void;
}): React.ReactElement {
  const repeatTypes: RepeatType[] = ['none', 'daily', 'weekly', 'monthly', 'annually'];
  const showTime = draft.repeatType !== 'none';
  const showDay = ['weekly', 'monthly', 'annually'].includes(draft.repeatType);
  const showMonth = draft.repeatType === 'annually';
  const dayLabel = draft.repeatType === 'weekly' ? 'Day of week (0=Sun, 6=Sat)' : 'Day of month';

  return (
    <div style={{
      padding: 16, marginBottom: 16,
      border: '1px solid #e5e7eb', borderRadius: 8, background: '#fafafa',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={fieldLabel}>
          Name (optional)
          <input
            type="text"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            placeholder="Morning standup"
            style={field}
          />
        </label>
        <label style={fieldLabel}>
          Prompt
          <textarea
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            placeholder="What should the agent do?"
            rows={3}
            style={{ ...field, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </label>
        <label style={fieldLabel}>
          Repeat
          <select
            value={draft.repeatType}
            onChange={(e) => setDraft({ ...draft, repeatType: e.target.value as RepeatType })}
            style={field}
          >
            {repeatTypes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        {showTime && (
          <label style={fieldLabel}>
            Time (24h)
            <input
              type="time"
              value={draft.scheduledTime}
              onChange={(e) => setDraft({ ...draft, scheduledTime: e.target.value })}
              style={field}
            />
          </label>
        )}
        {showDay && (
          <label style={fieldLabel}>
            {dayLabel}
            <input
              type="number"
              value={draft.scheduledDay}
              onChange={(e) => setDraft({ ...draft, scheduledDay: e.target.value })}
              style={field}
            />
          </label>
        )}
        {showMonth && (
          <label style={fieldLabel}>
            Month (1-12)
            <input
              type="number"
              min="1" max="12"
              value={draft.scheduledMonth}
              onChange={(e) => setDraft({ ...draft, scheduledMonth: e.target.value })}
              style={field}
            />
          </label>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={draft.skipPermissions}
            onChange={(e) => setDraft({ ...draft, skipPermissions: e.target.checked })}
          />
          Skip permission prompts (run unattended)
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCreate} disabled={!draft.prompt.trim()} style={{
            ...btn, background: '#c96442', color: '#fff', borderColor: '#c96442',
            opacity: draft.prompt.trim() ? 1 : 0.5,
          }}>Create</button>
          <button onClick={onCancel} style={btn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Row({ dot, children }: { dot: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: dot }} />
      {children}
    </div>
  );
}

// ============================================================
// Top-level
// ============================================================

type Tab = 'connection' | 'permissions' | 'prompts';
const TABS: Tab[] = ['connection', 'permissions', 'prompts'];

function OptionsApp(): React.ReactElement {
  const [tab, setTab] = useState<Tab>(() => {
    const hash = window.location.hash.replace('#', '') as Tab;
    return TABS.includes(hash) ? hash : 'connection';
  });

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: 24, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>Dyspel Settings</h1>
      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', marginBottom: 24 }}>
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); window.location.hash = t; }}
            style={{
              padding: '8px 16px', border: 'none', background: 'transparent',
              borderBottom: tab === t ? '2px solid #c96442' : '2px solid transparent',
              color: tab === t ? '#c96442' : '#6b7280',
              fontWeight: tab === t ? 600 : 400, cursor: 'pointer',
              fontSize: 14, textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'connection' && <ConnectionTab />}
      {tab === 'permissions' && <PermissionsTab />}
      {tab === 'prompts' && <PromptsTab />}
    </div>
  );
}

// ============================================================
// Style helpers
// ============================================================

function Pill({ children, kind }: { children: React.ReactNode; kind: 'good' | 'bad' }): React.ReactElement {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, fontSize: 12,
      background: kind === 'good' ? '#dcfce7' : '#fee2e2',
      color: kind === 'good' ? '#166534' : '#991b1b',
    }}>{children}</span>
  );
}

const btn: React.CSSProperties = {
  padding: '6px 12px', fontSize: 13, borderRadius: 6,
  border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', color: '#374151',
};
const th: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: 12, color: '#6b7280',
  borderBottom: '1px solid #e5e7eb', fontWeight: 500,
};
const td: React.CSSProperties = {
  padding: '8px 12px', borderBottom: '1px solid #f3f4f6', fontSize: 13,
};
const rowBetween: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16,
};
const fieldLabel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#374151',
};
const field: React.CSSProperties = {
  padding: '6px 10px', fontSize: 13, borderRadius: 6,
  border: '1px solid #d1d5db', fontFamily: 'inherit',
};

const root = document.getElementById('root');
if (root) createRoot(root).render(<OptionsApp />);
