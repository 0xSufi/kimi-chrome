// Lazy creator for the offscreen document.
//
// The MV3 service worker can't run AudioContext or render to a
// Canvas; offscreen.html owns those responsibilities. We create
// it on demand for any reason that might need it (audio, GIF) and
// keep it open afterwards — the keepalive ping it sends back also
// helps the SW stay warm.

const OFFSCREEN_PATH = 'offscreen.html';

let creating: Promise<void> | null = null;

async function isOpen(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  // hasDocument exists on Chrome 116+. Fall back to enumerating contexts.
  type OffscreenApi = {
    hasDocument?: () => Promise<boolean>;
    Reason?: Record<string, string>;
  };
  const offscreen = chrome.offscreen as unknown as OffscreenApi;
  if (typeof offscreen.hasDocument === 'function') {
    return offscreen.hasDocument();
  }
  type Ctx = { contextType: string; documentUrl: string };
  const matched = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [url],
  }) as unknown as Ctx[];
  return matched.length > 0;
}

export async function ensureOffscreen(
  reason: chrome.offscreen.Reason = chrome.offscreen.Reason.AUDIO_PLAYBACK,
): Promise<void> {
  if (await isOpen()) return;
  if (creating) return creating;

  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [reason],
    justification: 'Audio playback, GIF rendering, and SW keepalive.',
  }).finally(() => { creating = null; });

  return creating;
}

export async function closeOffscreen(): Promise<void> {
  if (!(await isOpen())) return;
  await chrome.offscreen.closeDocument();
}
