import React, { useEffect } from 'react';
import { ChatView } from './ChatView';
import { PermissionPrompt } from './PermissionPrompt';
import { useUIStore } from '../stores/ui';
import { useMessageStore, hydrateChatHistory } from '../stores/messages';
import { usePermissionStore } from '../stores/permissions';

interface StatusMessage {
  type: 'mcp_status_changed';
  connected?: boolean;
  hostInstalled?: boolean;
}

interface BridgeStatusMessage {
  type: 'bridge_status_changed';
  bridgeStatus?: 'disconnected' | 'connecting' | 'paired' | 'waiting';
}

interface ScheduledTaskMessage {
  type: 'EXECUTE_SCHEDULED_TASK';
  prompt?: { prompt?: string };
  queueItemId?: string;
}

interface QueuedScheduledItem {
  id: string;
  promptId: string;
  text: string;
  enqueuedAt: number;
}

interface PermissionRequestMessage {
  type: 'permission_request';
  requestId: string;
  netloc: string;
  tool: string;
  toolUseId?: string;
}

type IncomingMessage =
  | StatusMessage
  | BridgeStatusMessage
  | ScheduledTaskMessage
  | PermissionRequestMessage
  | { type: string };

export function App(): React.ReactElement {
  const { setConnected, setHasNativeHost, setBridgeStatus } = useUIStore();

  useEffect(() => {
    void hydrateChatHistory();

    chrome.runtime.sendMessage({ type: 'check_native_host_status' }, (response) => {
      if (response?.status) {
        setHasNativeHost(response.status.nativeHostInstalled);
        setConnected(response.status.mcpConnected);
        if (response.status.bridgeStatus) setBridgeStatus(response.status.bridgeStatus);
      }
    });

    // If the panel was opened by clicking a scheduled-task notification,
    // drain the persistent queue and submit the most recent prompt.
    chrome.runtime.sendMessage({ type: 'drain_scheduled_pending' }, (response) => {
      const items = (response as { items?: QueuedScheduledItem[] } | undefined)?.items ?? [];
      if (items.length === 0) return;
      const latest = items[items.length - 1];
      useMessageStore.getState().queuePrompt(latest.text);
    });

    const listener = (
      message: IncomingMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      if (message.type === 'mcp_status_changed') {
        const m = message as StatusMessage;
        if (typeof m.hostInstalled === 'boolean') setHasNativeHost(m.hostInstalled);
        if (typeof m.connected === 'boolean') setConnected(m.connected);
        return false;
      }
      if (message.type === 'bridge_status_changed') {
        const m = message as BridgeStatusMessage;
        if (m.bridgeStatus) setBridgeStatus(m.bridgeStatus);
        return false;
      }
      if (message.type === 'EXECUTE_SCHEDULED_TASK') {
        const m = message as ScheduledTaskMessage;
        const text = m.prompt?.prompt;
        if (text) {
          useMessageStore.getState().queuePrompt(text);
          if (m.queueItemId) {
            void chrome.runtime.sendMessage({
              type: 'ack_scheduled_queue_item',
              id: m.queueItemId,
            }).catch(() => {});
          }
        }
        return false;
      }
      if (message.type === 'permission_request') {
        const m = message as PermissionRequestMessage;
        usePermissionStore.getState().open({
          requestId: m.requestId,
          netloc: m.netloc,
          tool: m.tool,
          toolUseId: m.toolUseId,
          resolve: (decision) => sendResponse(decision),
        });
        return true; // keep the channel open for the async response
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [setConnected, setHasNativeHost, setBridgeStatus]);

  return (
    <>
      <ChatView />
      <PermissionPrompt />
    </>
  );
}
