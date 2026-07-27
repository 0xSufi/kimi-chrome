// Tab-group lifecycle.
//
// One MCP group per browser. resolveTab() picks the right tab id
// for an incoming tool invocation: explicit > group's active tab >
// MCP group's active tab > the user's currently active tab.
//
// The v1 had an indicator state machine, prefix mgmt (⌛/✅/🔔),
// dismissed-groups bookkeeping, and reconciliation. Dropped here.
// Indicator messages are sent inline by tools that need them.

import { StorageKey } from './protocol';
import { get as storageGet, set as storageSet } from './storage';

const MCP_GROUP_TITLE = 'Kimi (MCP)';
const MCP_GROUP_KEY = 'mcpTabGroupId' as const;

let mcpGroupId: number | null = null;
let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const stored = await chrome.storage.local.get(MCP_GROUP_KEY);
  const candidate = stored[MCP_GROUP_KEY] as number | undefined;
  if (candidate != null) {
    try {
      await chrome.tabGroups.get(candidate);
      mcpGroupId = candidate;
    } catch {
      mcpGroupId = null;
      await chrome.storage.local.remove(MCP_GROUP_KEY);
    }
  }
}

// ============================================================
// MCP group resolution
// ============================================================

export interface TabSummary { tabId: number; url: string; title: string }

export async function getMcpTabs(opts: { createIfEmpty?: boolean } = {}): Promise<{
  tabGroupId: number | null;
  tabs: TabSummary[];
}> {
  await ensureInit();

  if (mcpGroupId != null) {
    try {
      const tabs = await chrome.tabs.query({ groupId: mcpGroupId });
      if (tabs.length > 0) return { tabGroupId: mcpGroupId, tabs: tabs.map(toSummary) };
    } catch {}
    mcpGroupId = null;
    await chrome.storage.local.remove(MCP_GROUP_KEY);
  }

  if (!opts.createIfEmpty) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { tabGroupId: null, tabs: active?.id != null ? [toSummary(active)] : [] };
  }

  const tab = await chrome.tabs.create({ url: 'chrome://newtab', active: false });
  if (tab.id == null) return { tabGroupId: null, tabs: [] };
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: MCP_GROUP_TITLE, color: 'orange', collapsed: false });
  mcpGroupId = groupId;
  await chrome.storage.local.set({ [MCP_GROUP_KEY]: groupId });
  return { tabGroupId: groupId, tabs: [toSummary(tab)] };
}

export async function addTabToMcpGroup(tabId: number): Promise<number | null> {
  await ensureInit();
  if (mcpGroupId == null) {
    const result = await getMcpTabs({ createIfEmpty: true });
    if (result.tabGroupId == null) return null;
  }
  if (mcpGroupId == null) return null;
  try {
    await chrome.tabs.group({ tabIds: [tabId], groupId: mcpGroupId });
    return mcpGroupId;
  } catch {
    return null;
  }
}

export async function clearMcpGroup(): Promise<void> {
  mcpGroupId = null;
  await chrome.storage.local.remove(MCP_GROUP_KEY);
}

function toSummary(t: chrome.tabs.Tab): TabSummary {
  return { tabId: t.id ?? -1, url: t.url ?? '', title: t.title ?? '' };
}

// ============================================================
// Tab resolution for tool dispatch
// ============================================================

export interface ResolvedTab {
  tabId: number;
  url: string;
  domain: string;
  groupId: number; // -1 when the tab is not in a group
}

export async function resolveTab(hints: {
  tabId?: number | string;
  tabGroupId?: number | string;
}): Promise<ResolvedTab | null> {
  await ensureInit();

  const explicitTab = parseId(hints.tabId);
  if (explicitTab != null) {
    const tab = await chrome.tabs.get(explicitTab).catch(() => null);
    if (tab?.id != null) return summarize(tab);
  }

  const explicitGroup = parseId(hints.tabGroupId);
  if (explicitGroup != null) {
    const tabs = await chrome.tabs.query({ groupId: explicitGroup });
    const pick = tabs.find((t) => t.active) ?? tabs[0];
    if (pick?.id != null) return summarize(pick);
  }

  if (mcpGroupId != null) {
    const tabs = await chrome.tabs.query({ groupId: mcpGroupId });
    const pick = tabs.find((t) => t.active) ?? tabs[0];
    if (pick?.id != null) return summarize(pick);
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id != null) return summarize(active);
  return null;
}

function parseId(value: number | string | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  return Number.isFinite(n) ? n : null;
}

function summarize(t: chrome.tabs.Tab): ResolvedTab {
  const url = t.url ?? '';
  let domain = '';
  try { domain = url ? new URL(url).hostname : ''; } catch {}
  return {
    tabId: t.id ?? -1,
    url,
    domain,
    groupId: typeof t.groupId === 'number' ? t.groupId : -1,
  };
}

// ============================================================
// Group title prefix feedback
//
// ⌛ while a tool is running, ✅ once it completes, 🔔 when a
// permission prompt is open. Strips any existing prefix before
// applying the new one so consecutive states don't accumulate.
// ============================================================

const PREFIX_REGEX = /^(⌛|🔔|✅)\s*/u;

export async function setGroupPrefix(
  groupId: number,
  prefix: '⌛' | '✅' | '🔔' | null,
): Promise<void> {
  if (groupId == null || groupId < 0) return;
  try {
    const group = await chrome.tabGroups.get(groupId);
    const base = (group.title ?? '').replace(PREFIX_REGEX, '');
    const next = prefix ? `${prefix} ${base}` : base;
    if (next === group.title) return;
    await chrome.tabGroups.update(groupId, { title: next });
  } catch {}
}

export const setLoadingPrefix = (groupId: number) => setGroupPrefix(groupId, '⌛');
export const setCompletionPrefix = (groupId: number) => setGroupPrefix(groupId, '✅');
export const setPermissionPrefix = (groupId: number) => setGroupPrefix(groupId, '🔔');
export const clearGroupPrefix = (groupId: number) => setGroupPrefix(groupId, null);

// ============================================================
// Indicator helpers (inline; no state machine)
// ============================================================

export async function showAgentIndicator(tabId: number, isMcp = true): Promise<void> {
  try { await chrome.tabs.sendMessage(tabId, { type: 'SHOW_AGENT_INDICATORS', isMcp }); } catch {}
}

export async function hideAgentIndicator(tabId: number): Promise<void> {
  try { await chrome.tabs.sendMessage(tabId, { type: 'HIDE_AGENT_INDICATORS' }); } catch {}
}

// Tab-storage hint Phase G can use to remember a "last targeted tab"
// without paying chrome.tabs.query on every dispatch.
export async function rememberTargetTab(tabId: number): Promise<void> {
  await storageSet(StorageKey.TARGET_TAB_ID, tabId);
}

export async function getRememberedTargetTab(): Promise<number | undefined> {
  return storageGet<number>(StorageKey.TARGET_TAB_ID);
}
