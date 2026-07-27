// Dyspel service worker — rewrite spine.
//
// Phase B: connect to the native host and the bridge; route
// inbound tool requests to the (still-stubbed) tool registry.
// Phase C will replace the dispatch stub with a real registry.

import {
  bridgeTransport,
  confirmPairing,
  initialize as initBridge,
  onBridgeStatusChange,
  getBridgeStatus,
} from './core/bridge-client';
import { nativeTransport, getStatus as getNativeStatus, onStatusChange } from './core/native-messaging';
import { registerTransport, broadcastNotification } from './core/router';
import { detachAll as detachAllDebuggers } from './core/cdp';
import { InternalMessage } from './core/protocol';
import { handleOAuthRedirect, initiateOAuthFlow, logout, getAccessToken } from './core/oauth';
import {
  isPromptAlarm,
  getPrompt,
  refreshAllNextRunTimes,
  createPrompt,
  type ScheduledPrompt,
} from './core/scheduled-prompts';
import {
  enqueueScheduledFire,
  ackQueueItem,
  handleNotificationClick,
  drainPending,
} from './core/scheduled-runner';
import { clearOnce as clearOncePermissions } from './core/permissions';

// Registers tools and replaces the default dispatch stub.
import './tools/registry';

console.log('[dyspel] service worker booted');

registerTransport(nativeTransport);
registerTransport(bridgeTransport);

// Broadcast status changes to any open extension page so the
// connection pill updates without polling. catch() because the
// send fails when no listener is open, which is fine.
onStatusChange((status) => {
  void chrome.runtime.sendMessage({
    type: 'mcp_status_changed',
    hostInstalled: status.hostInstalled,
    connected: status.mcpConnected,
  }).catch(() => {});
});

onBridgeStatusChange((bridgeStatus) => {
  void chrome.runtime.sendMessage({
    type: 'bridge_status_changed',
    bridgeStatus,
  }).catch(() => {});
});

initBridge();
void nativeTransport.connect();
void bridgeTransport.connect();

// Once-duration permissions are tied to a single tool_use_id. Once the
// SW restarts, those ids will never come around again, so it's safe to
// drop them — keeps chrome.storage from accreting dead entries.
void clearOncePermissions().catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[dyspel] installed');
  void nativeTransport.connect();
  void bridgeTransport.connect();
});

chrome.runtime.onStartup.addListener(() => {
  void nativeTransport.connect();
  void bridgeTransport.connect();
  void refreshAllNextRunTimes();
});

// ============================================================
// Scheduled prompts — chrome.alarms relays the fire to whoever's
// listening (sidepanel; Phase G). The alarm name is the prompt id.
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!isPromptAlarm(alarm.name)) return;
  const prompt = await getPrompt(alarm.name);
  if (!prompt || !prompt.enabled) return;

  // Two-path delivery: broadcast for side-panel-open + notification +
  // persistent queue for side-panel-closed. See core/scheduled-runner.
  void enqueueScheduledFire(prompt);
});

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    void handleNotificationClick(notificationId);
  });
}

// ============================================================
// UI surface
// ============================================================

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-side-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
});

// ============================================================
// Internal messages from extension UI pages
// ============================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  switch (message.type) {
    case InternalMessage.SW_KEEPALIVE:
      sendResponse({ ok: true });
      return false;

    case InternalMessage.PAIRING_CONFIRMED:
      void confirmPairing(message.request_id, message.name);
      sendResponse({ ok: true });
      return false;

    case InternalMessage.OAUTH_REDIRECT:
      handleOAuthRedirect(message.url, _sender.tab?.id).then(sendResponse);
      return true;

    case 'check_native_host_status': {
      const native = getNativeStatus();
      sendResponse({
        status: {
          nativeHostInstalled: native.hostInstalled,
          mcpConnected: native.mcpConnected,
          bridgeStatus: getBridgeStatus(),
        },
      });
      return false;
    }

    case 'ack_scheduled_queue_item':
      if (typeof message.id === 'string') void ackQueueItem(message.id);
      sendResponse({ ok: true });
      return false;

    case 'drain_scheduled_pending':
      drainPending().then((items) => sendResponse({ items }));
      return true;

    case 'create_scheduled_prompt': {
      const { id, createdAt, updatedAt, ...rest } = message.prompt as ScheduledPrompt;
      void id; void createdAt; void updatedAt;
      createPrompt(rest).then((created) => sendResponse({ ok: true, prompt: created }));
      return true;
    }

    case 'oauth_initiate':
      void initiateOAuthFlow();
      sendResponse({ ok: true });
      return false;

    case 'oauth_logout':
      logout().then(() => sendResponse({ ok: true }));
      return true;

    case 'oauth_status':
      getAccessToken().then((token) => sendResponse({ signedIn: !!token }));
      return true;

    case 'STOP_AGENT':
      // Telling every transport to stop is a fanout: broadcast an
      // interrupt notification so cc-wasm/the bridge can act, detach
      // every debugger so any in-flight CDP work fails fast, and
      // forward the signal to the side panel for the host-server-relay
      // chat (sendInterrupt() lives there).
      broadcastNotification('interrupt', {});
      void detachAllDebuggers();
      void chrome.runtime.sendMessage({ type: 'AGENT_STOPPED' }).catch(() => {});
      sendResponse({ ok: true });
      return false;
  }

  return false;
});

// External page → service worker (claude.ai, dyspel.xyz, localhost).
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === InternalMessage.OAUTH_REDIRECT) {
    handleOAuthRedirect(message.url, sender.tab?.id).then(sendResponse);
    return true;
  }

  // Tool calls from authorized origins (e.g. dyspel.xyz dashboards).
  if (message.type === 'tool_call') {
    // Phase B's router doesn't expose direct invocation yet; Phase G
    // wires this when the dashboard surface lands.
    sendResponse({ ok: false, error: 'tool_call from external origins is not enabled in this build' });
    return false;
  }

  return false;
});

export {};
