// Chrome DevTools Protocol — attach / sendCommand.
//
// Held separate from input and tracking so the input module doesn't
// need to know about the debugger event firehose.

const ATTACH_VERSION = '1.3';
const DEFAULT_TIMEOUT_MS = 8_000;

const attachedTabs = new Set<number>();
type EventListener = (tabId: number, method: string, params: unknown) => void;
const eventListeners = new Set<EventListener>();
let listenerInstalled = false;

function installListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId == null) return;
    for (const fn of eventListeners) fn(source.tabId, method, params);
  });

  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId != null) attachedTabs.delete(source.tabId);
  });
}

export function onCdpEvent(listener: EventListener): () => void {
  installListener();
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function isAttached(tabId: number): boolean {
  return attachedTabs.has(tabId);
}

export async function attach(tabId: number): Promise<void> {
  installListener();
  if (attachedTabs.has(tabId)) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url ?? '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    throw new Error(`Cannot attach debugger to ${url}`);
  }

  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, ATTACH_VERSION, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      attachedTabs.add(tabId);
      resolve();
    });
  });

  await Promise.allSettled([
    sendCommandRaw(tabId, 'Runtime.enable'),
    sendCommandRaw(tabId, 'Network.enable', { maxPostDataSize: 65536 }),
    sendCommandRaw(tabId, 'Page.enable'),
  ]);
}

export async function detach(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  await new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      attachedTabs.delete(tabId);
      resolve();
    });
  });
}

export function listAttachedTabs(): number[] {
  return Array.from(attachedTabs);
}

export async function detachAll(): Promise<void> {
  await Promise.allSettled(listAttachedTabs().map((id) => detach(id)));
}

export async function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  try {
    return await sendCommandRaw<T>(tabId, method, params, timeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('not attached')) {
      await attach(tabId);
      return sendCommandRaw<T>(tabId, method, params, timeoutMs);
    }
    throw e;
  }
}

function sendCommandRaw<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return Promise.race([
    new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result as T);
        }
      });
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}
