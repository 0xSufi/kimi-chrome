// Screenshot via CDP, with content-script-side downscale fallback
// for when the raw capture exceeds the upstream payload limit.

import { sendCommand } from './cdp';

const MAX_BASE64_CHARS = 1_398_100;

export interface Screenshot {
  base64: string;
  width: number;
  height: number;
  format: 'jpeg' | 'png';
  viewportWidth: number;
  viewportHeight: number;
}

export async function captureScreenshot(
  tabId: number,
  options: { format?: 'jpeg' | 'png'; quality?: number } = {},
): Promise<Screenshot> {
  // Hide the on-page glow so it isn't baked into the capture.
  // Best effort — content script may not be loaded on this URL.
  await chrome.tabs.sendMessage(tabId, { type: 'HIDE_FOR_TOOL_USE' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));

  try {
    const [vp] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
    });
    const viewport = vp?.result ?? { width: 1280, height: 720, devicePixelRatio: 1 };

    const format = options.format ?? 'jpeg';
    const params: Record<string, unknown> = {
      format,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
      fromSurface: true,
      captureBeyondViewport: false,
    };
    if (format === 'jpeg') params.quality = options.quality ?? 80;

    const result = await sendCommand<{ data: string }>(tabId, 'Page.captureScreenshot', params);
    const base64 = result?.data ?? '';

    if (base64.length > MAX_BASE64_CHARS) {
      const downscaled = await downscaleInPage(tabId, base64, format);
      if (downscaled) return { ...downscaled, format };
    }

    return {
      base64,
      width: Math.round(viewport.width * viewport.devicePixelRatio),
      height: Math.round(viewport.height * viewport.devicePixelRatio),
      format,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    };
  } finally {
    void chrome.tabs.sendMessage(tabId, { type: 'SHOW_AFTER_TOOL_USE' }).catch(() => {});
  }
}

async function downscaleInPage(
  tabId: number,
  base64: string,
  format: 'jpeg' | 'png',
): Promise<Omit<Screenshot, 'format'> | null> {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (b64: string, fmt: string) =>
        new Promise<{ base64: string; width: number; height: number; viewportWidth: number; viewportHeight: number } | null>((resolve) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const maxDim = 1568;
            let w = img.width;
            let h = img.height;
            if (w > maxDim || h > maxDim) {
              const scale = maxDim / Math.max(w, h);
              w = Math.round(w * scale);
              h = Math.round(h * scale);
            }
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
            let q = 0.75;
            let url = canvas.toDataURL(fmt === 'jpeg' ? 'image/jpeg' : 'image/png', q);
            while (url.length > 1_398_100 && q > 0.1) {
              q -= 0.05;
              url = canvas.toDataURL('image/jpeg', q);
            }
            resolve({ base64: url.split(',')[1] ?? '', width: w, height: h, viewportWidth: w, viewportHeight: h });
          };
          img.onerror = () => resolve(null);
          img.src = `data:image/${fmt};base64,${b64}`;
        }),
      args: [base64, format],
    });
    return r?.result ?? null;
  } catch {
    return null;
  }
}
