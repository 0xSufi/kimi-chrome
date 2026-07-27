// Per-tab buffers for console messages and network requests.
// Subscribes to CDP events emitted from cdp.ts.

import { onCdpEvent, sendCommand } from './cdp';

const MAX_LOGS_PER_TAB = 10_000;
const MAX_REQUESTS_PER_TAB = 1_000;

export interface ConsoleMessage {
  type: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

export interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  type?: string;
}

const consoleByTab = new Map<number, ConsoleMessage[]>();
const networkByTab = new Map<number, NetworkRequest[]>();
const consoleEnabled = new Set<number>();
const networkEnabled = new Set<number>();

const beforeunloadPolicyByTab = new Map<number, 'accept' | 'dismiss'>();
const beforeunloadOutcomeByTab = new Map<number, { accepted: boolean }>();
const beforeunloadWaiters = new Map<number, (outcome: { accepted: boolean }) => void>();

let listenerAttached = false;

function ensureListener(): void {
  if (listenerAttached) return;
  listenerAttached = true;

  onCdpEvent((tabId, method, raw) => {
    const params = raw as Record<string, unknown> | undefined;
    if (!params) return;

    switch (method) {
      case 'Runtime.consoleAPICalled':
        record(consoleByTab, tabId, MAX_LOGS_PER_TAB, {
          type: (params.type as string) ?? 'log',
          text: stringifyArgs(params.args as ConsoleArg[] | undefined),
          timestamp: Date.now(),
          url: firstFrameUrl(params),
          lineNumber: firstFrameLine(params),
        });
        return;

      case 'Runtime.exceptionThrown': {
        const detail = params.exceptionDetails as ExceptionDetails | undefined;
        record(consoleByTab, tabId, MAX_LOGS_PER_TAB, {
          type: 'error',
          text: detail?.exception?.description ?? detail?.text ?? 'Unknown exception',
          timestamp: Date.now(),
          url: detail?.url,
          lineNumber: detail?.lineNumber,
        });
        return;
      }

      case 'Network.requestWillBeSent': {
        const req = params.request as { url: string; method: string } | undefined;
        if (!req) return;
        record(networkByTab, tabId, MAX_REQUESTS_PER_TAB, {
          requestId: params.requestId as string,
          url: req.url,
          method: req.method,
          type: params.type as string | undefined,
        });
        return;
      }

      case 'Network.responseReceived': {
        const list = networkByTab.get(tabId);
        if (!list) return;
        const match = list.find((r) => r.requestId === params.requestId);
        if (!match) return;
        const response = params.response as { status?: number; statusText?: string } | undefined;
        match.status = response?.status;
        match.statusText = response?.statusText;
        return;
      }

      case 'Network.loadingFailed': {
        const list = networkByTab.get(tabId);
        if (!list) return;
        const match = list.find((r) => r.requestId === params.requestId);
        if (match) match.status = 503;
        return;
      }

      case 'Page.javascriptDialogOpening': {
        if (params.type !== 'beforeunload') return;
        const policy = beforeunloadPolicyByTab.get(tabId);
        if (!policy) return;
        const accept = policy === 'accept';
        void sendCommand(tabId, 'Page.handleJavaScriptDialog', { accept });
        beforeunloadOutcomeByTab.set(tabId, { accepted: accept });
        const waiter = beforeunloadWaiters.get(tabId);
        if (waiter) {
          waiter({ accepted: accept });
          beforeunloadWaiters.delete(tabId);
        }
        return;
      }
    }
  });
}

interface ConsoleArg {
  type: string;
  value?: unknown;
  description?: string;
  preview?: { properties?: { name: string; value: string }[] };
}

interface ExceptionDetails {
  exception?: { description?: string };
  text?: string;
  url?: string;
  lineNumber?: number;
}

function stringifyArgs(args: ConsoleArg[] | undefined): string {
  if (!args) return '';
  return args
    .map((a) => {
      if (a.type === 'string') return String(a.value ?? '');
      if (a.type === 'object' && a.preview?.properties) {
        return JSON.stringify(Object.fromEntries(a.preview.properties.map((p) => [p.name, p.value])));
      }
      return a.description ?? String(a.value ?? '');
    })
    .join(' ');
}

function firstFrameUrl(params: Record<string, unknown>): string | undefined {
  const stack = params.stackTrace as { callFrames?: { url?: string }[] } | undefined;
  return stack?.callFrames?.[0]?.url;
}

function firstFrameLine(params: Record<string, unknown>): number | undefined {
  const stack = params.stackTrace as { callFrames?: { lineNumber?: number }[] } | undefined;
  return stack?.callFrames?.[0]?.lineNumber;
}

function record<T>(map: Map<number, T[]>, tabId: number, max: number, item: T): void {
  let list = map.get(tabId);
  if (!list) {
    list = [];
    map.set(tabId, list);
  }
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

// ============================================================
// Public API
// ============================================================

export async function enableConsoleTracking(tabId: number): Promise<void> {
  ensureListener();
  if (consoleEnabled.has(tabId)) return;
  await sendCommand(tabId, 'Runtime.enable');
  consoleEnabled.add(tabId);
}

export async function enableNetworkTracking(tabId: number): Promise<void> {
  ensureListener();
  if (networkEnabled.has(tabId)) return;
  await sendCommand(tabId, 'Network.enable', { maxPostDataSize: 65536 });
  networkEnabled.add(tabId);
}

export function getConsoleMessages(
  tabId: number,
  opts: { errorsOnly?: boolean; pattern?: string } = {},
): ConsoleMessage[] {
  let list = consoleByTab.get(tabId) ?? [];
  if (opts.errorsOnly) list = list.filter((m) => m.type === 'error');
  if (opts.pattern) {
    try {
      const re = new RegExp(opts.pattern, 'i');
      list = list.filter((m) => re.test(m.text));
    } catch {}
  }
  return list;
}

export function getNetworkRequests(tabId: number, urlFilter?: string): NetworkRequest[] {
  const list = networkByTab.get(tabId) ?? [];
  return urlFilter ? list.filter((r) => r.url.includes(urlFilter)) : list;
}

export function clearConsole(tabId: number): void {
  consoleByTab.delete(tabId);
}

export function clearNetwork(tabId: number): void {
  networkByTab.delete(tabId);
}

export function setBeforeunloadPolicy(tabId: number, policy: 'accept' | 'dismiss'): void {
  ensureListener();
  beforeunloadPolicyByTab.set(tabId, policy);
}

export function consumeBeforeunloadOutcome(tabId: number): { accepted: boolean } | undefined {
  const out = beforeunloadOutcomeByTab.get(tabId);
  beforeunloadOutcomeByTab.delete(tabId);
  return out;
}

export function cleanupTab(tabId: number): void {
  consoleByTab.delete(tabId);
  networkByTab.delete(tabId);
  consoleEnabled.delete(tabId);
  networkEnabled.delete(tabId);
  beforeunloadPolicyByTab.delete(tabId);
  beforeunloadOutcomeByTab.delete(tabId);
  beforeunloadWaiters.delete(tabId);
}
