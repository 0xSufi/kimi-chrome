import React from 'react';
import { useUIStore, type BridgeStatus } from '../stores/ui';

export function ConnectionStatus(): React.ReactElement {
  const { isConnected, hasNativeHost, bridgeStatus } = useUIStore();

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <HostPill connected={isConnected} hasHost={hasNativeHost} />
      <BridgePill status={bridgeStatus} />
    </span>
  );
}

function HostPill({ connected, hasHost }: { connected: boolean; hasHost: boolean }): React.ReactElement {
  if (!hasHost) {
    return (
      <span style={dot('#f59e0b')} title="No native messaging host installed">
        <span style={swatch('#f59e0b')} />
        No host
      </span>
    );
  }
  return (
    <span style={dot(connected ? '#22c55e' : '#9ca3af')} title="cc-wasm host server status">
      <span style={swatch(connected ? '#22c55e' : '#9ca3af')} />
      {connected ? 'MCP' : 'MCP off'}
    </span>
  );
}

function BridgePill({ status }: { status: BridgeStatus }): React.ReactElement | null {
  const config = bridgeColors(status);
  if (!config) return null;
  return (
    <span style={dot(config.color)} title={`Bridge: ${status}`}>
      <span style={swatch(config.color)} />
      {config.label}
    </span>
  );
}

function bridgeColors(status: BridgeStatus): { color: string; label: string } | null {
  switch (status) {
    case 'paired':      return { color: '#22c55e', label: 'Bridge' };
    case 'waiting':     return { color: '#3b82f6', label: 'Bridge waiting' };
    case 'connecting':  return { color: '#9ca3af', label: 'Bridge…' };
    case 'disconnected': return null; // hide when not connected at all
  }
}

function dot(color: string): React.CSSProperties {
  return { fontSize: 11, color, display: 'flex', alignItems: 'center', gap: 4 };
}

function swatch(color: string): React.CSSProperties {
  return { width: 6, height: 6, borderRadius: '50%', background: color };
}
