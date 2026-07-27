// Tool registry and dispatch.
//
// Phase C: tabs are resolved from the invocation hint or the active tab.
// Phase E will replace resolveTab with the tab-group-aware version.
//
// Debugger lifecycle: attach lazily on first use, then detach
// after a 20s idle timer so consecutive calls don't pay the
// attach cost. attached state lives in cdp.ts.

import { setDispatch, type ToolInvocation } from '../core/router';
import { attach, detach } from '../core/cdp';
import {
  resolveTab,
  setLoadingPrefix,
  setCompletionPrefix,
  clearGroupPrefix,
  setPermissionPrefix,
} from '../core/tab-groups';
import { getCategory, isBlockedCategory } from '../core/domain-checker';
import { check as checkPermission } from '../core/permissions';
import { requestPermission } from '../core/permission-bridge';
import { fail, type ToolDefinition, type ToolResult } from './types';

import { navigateTool } from './navigate';
import { javascriptTool } from './javascript';
import { readPageTool } from './read-page';
import { computerTool } from './computer';
import { findTool } from './find';
import { formInputTool } from './form-input';
import { tabsContextTool } from './tabs-context';
import { tabsCreateTool } from './tabs-create';
import { readConsoleMessagesTool } from './read-console-messages';
import { readNetworkRequestsTool } from './read-network-requests';
import { resizeWindowTool } from './resize-window';
import { gifCreatorTool } from './gif-creator';
import { updatePlanTool } from './update-plan';

// ============================================================
// Registry
// ============================================================

const tools = new Map<string, ToolDefinition>();

function register(t: ToolDefinition): void {
  tools.set(t.name, t);
}

register(navigateTool);
register(javascriptTool);
register(readPageTool);
register(computerTool);
register(findTool);
register(formInputTool);
register(tabsContextTool);
register(tabsCreateTool);
register(readConsoleMessagesTool);
register(readNetworkRequestsTool);
register(resizeWindowTool);
register(gifCreatorTool);
register(updatePlanTool);

export function listTools(): ToolDefinition[] {
  return Array.from(tools.values());
}

// ============================================================
// Idle detach
// ============================================================

const detachTimers = new Map<number, ReturnType<typeof setTimeout>>();
const DETACH_IDLE_MS = 20_000;

function scheduleDetach(tabId: number): void {
  const existing = detachTimers.get(tabId);
  if (existing) clearTimeout(existing);
  detachTimers.set(
    tabId,
    setTimeout(() => {
      detachTimers.delete(tabId);
      void detach(tabId).catch(() => {});
    }, DETACH_IDLE_MS),
  );
}

// ============================================================
// Agent visual indicator — show on the tab being acted upon,
// hide after a short idle so consecutive tool calls don't
// flicker the glow off and on.
// ============================================================

const indicatorHideTimers = new Map<number, ReturnType<typeof setTimeout>>();
const INDICATOR_IDLE_MS = 1_500;

function showIndicator(tabId: number, isMcp: boolean): void {
  const pending = indicatorHideTimers.get(tabId);
  if (pending) {
    clearTimeout(pending);
    indicatorHideTimers.delete(tabId);
  }
  void chrome.tabs.sendMessage(tabId, { type: 'SHOW_AGENT_INDICATORS', isMcp }).catch(() => {});
}

function scheduleHideIndicator(tabId: number): void {
  const existing = indicatorHideTimers.get(tabId);
  if (existing) clearTimeout(existing);
  indicatorHideTimers.set(
    tabId,
    setTimeout(() => {
      indicatorHideTimers.delete(tabId);
      void chrome.tabs.sendMessage(tabId, { type: 'HIDE_AGENT_INDICATORS' }).catch(() => {});
    }, INDICATOR_IDLE_MS),
  );
}

// ============================================================
// Tab-group title prefixes — ⌛ while running, ✅ on completion,
// then clear after a short idle so the prefix doesn't stick
// forever. Active runs cancel any pending clear so we don't blink.
// ============================================================

const prefixClearTimers = new Map<number, ReturnType<typeof setTimeout>>();
const PREFIX_CLEAR_IDLE_MS = 3_000;

function cancelPrefixClear(groupId: number): void {
  const t = prefixClearTimers.get(groupId);
  if (t) {
    clearTimeout(t);
    prefixClearTimers.delete(groupId);
  }
}

function schedulePrefixClear(groupId: number): void {
  cancelPrefixClear(groupId);
  prefixClearTimers.set(
    groupId,
    setTimeout(() => {
      prefixClearTimers.delete(groupId);
      void clearGroupPrefix(groupId).catch(() => {});
    }, PREFIX_CLEAR_IDLE_MS),
  );
}

// ============================================================
// Dispatch
// ============================================================

function isDebuggableUrl(url: string): boolean {
  return Boolean(url) && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://');
}

function matchesAllowedDomain(netloc: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === netloc) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return netloc === suffix || netloc.endsWith(`.${suffix}`);
  }
  return false;
}

async function dispatch(inv: ToolInvocation): Promise<void> {
  const tool = tools.get(inv.tool);
  if (!tool) {
    inv.reply(fail(`Unknown tool: ${inv.tool}`));
    return;
  }

  const resolved = await resolveTab({ tabId: inv.tabId, tabGroupId: inv.tabGroupId });
  if (!resolved) {
    inv.reply(fail('No active tab available for this tool'));
    return;
  }

  // Domain blocklist gate. Skip for chrome:// URLs and the new-tab page.
  if (resolved.url && resolved.url !== 'chrome://newtab/') {
    const category = await getCategory(resolved.url);
    if (isBlockedCategory(category)) {
      const msg = category === 'category_org_blocked'
        ? 'This domain is blocked by your organization\'s policy.'
        : 'This domain is blocked for safety reasons.';
      inv.reply(fail(msg));
      return;
    }
  }

  // Per-domain permission gate. The side panel prompts the user when
  // there's no stored decision for this netloc. Skip for chrome:// pages,
  // when the bridge says permissions are bypassed, and when the bridge
  // pre-approved the gate URL via allowed_domains.
  const skipPermissions = inv.permissionMode === 'bypassPermissions';
  const gateUrl = tool.gateOn?.(inv.args) ?? resolved.url;

  let gateNetloc = resolved.domain;
  if (gateUrl) {
    try { gateNetloc = new URL(gateUrl).hostname; } catch {}
  }

  const preApprovedByBridge = !!inv.allowedDomains?.some((pattern) =>
    matchesAllowedDomain(gateNetloc, pattern),
  );

  if (
    !skipPermissions &&
    !preApprovedByBridge &&
    gateUrl &&
    !gateUrl.startsWith('chrome://') &&
    !gateUrl.startsWith('chrome-extension://')
  ) {
    const decision = await checkPermission(gateUrl, inv.toolUseId);
    if (!decision.allowed && decision.needsPrompt) {
      if (resolved.groupId >= 0) void setPermissionPrefix(resolved.groupId).catch(() => {});
      const prompted = await requestPermission({
        netloc: gateNetloc,
        tool: inv.tool,
        toolUseId: inv.toolUseId,
      });
      if (!prompted.allowed) {
        if (resolved.groupId >= 0) void clearGroupPrefix(resolved.groupId).catch(() => {});
        inv.reply(fail(prompted.reason ?? 'Permission denied'));
        return;
      }
    } else if (!decision.allowed) {
      inv.reply(fail('Permission denied for this domain'));
      return;
    }
  }

  if (tool.needsDebugger && isDebuggableUrl(resolved.url)) {
    try {
      await attach(resolved.tabId);
    } catch (e) {
      console.warn('[kimi] debugger attach failed:', e);
    }
  }

  // Show the on-page glow for the duration of this call. The bridge
  // and host-server transports both flag MCP sessions, so the Stop
  // button stays hidden in those cases.
  const isMcp = inv.source === 'bridge' || inv.clientId === 'host-server-relay';
  showIndicator(resolved.tabId, isMcp);

  if (resolved.groupId >= 0) {
    cancelPrefixClear(resolved.groupId);
    void setLoadingPrefix(resolved.groupId).catch(() => {});
  }

  // Lock args.tabId to the resolved tab before handing off — every
  // tool reads `args.tabId ?? ctx.tabId` and we don't want a request
  // that gated against tab A to execute against tab B.
  const lockedArgs: Record<string, unknown> = { ...inv.args, tabId: resolved.tabId };

  let result: ToolResult;
  try {
    result = await tool.execute(lockedArgs, {
      tabId: resolved.tabId,
      source: inv.source,
      clientId: inv.clientId,
      tabGroupId: inv.tabGroupId,
      sessionScope: inv.sessionScope,
    });
  } catch (e) {
    result = fail(`Tool '${inv.tool}' threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  scheduleHideIndicator(resolved.tabId);
  if (tool.needsDebugger) scheduleDetach(resolved.tabId);

  if (resolved.groupId >= 0) {
    void setCompletionPrefix(resolved.groupId).catch(() => {});
    schedulePrefixClear(resolved.groupId);
  }

  inv.reply(result);
}

setDispatch(dispatch);

// ============================================================
// Direct invocation (bypasses transports — for the sidepanel
// host-server relay which already speaks its own wire format).
// ============================================================

export async function invokeTool(opts: {
  tool: string;
  args: Record<string, unknown>;
  source?: 'native' | 'bridge';
  clientId?: string;
}): Promise<ToolResult> {
  return new Promise((resolve) => {
    void dispatch({
      tool: opts.tool,
      args: opts.args,
      source: opts.source ?? 'bridge',
      clientId: opts.clientId,
      reply: resolve,
    });
  });
}
