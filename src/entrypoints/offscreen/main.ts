// Offscreen document.
//
// Three responsibilities:
//   - Service worker keepalive (a message every 20s defeats MV3 idle).
//   - Audio playback (Web Audio API can't run in the SW).
//   - GIF rendering with overlays (clicks, drags, labels, watermark,
//     progress bar) — also blocked from SW because it needs Canvas
//     and a worker for gif.js.

setInterval(() => {
  void chrome.runtime.sendMessage({ type: 'SW_KEEPALIVE' }).catch(() => {});
}, 20_000);

// ============================================================
// Audio
// ============================================================

let audioContext: AudioContext | undefined;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
    audioContext = new Ctor();
  }
  return audioContext;
}

async function playAudio(url: string, volume: number): Promise<void> {
  const ctx = getAudioContext();
  const buffer = await fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(ctx.destination);

  if (ctx.state === 'suspended') await ctx.resume();
  source.start(0);
  return new Promise<void>((resolve) => { source.onended = () => resolve(); });
}

// ============================================================
// GIF generation
// ============================================================

interface Frame {
  base64: string;
  format?: string;
  delay?: number;
  action?: {
    type: string;
    coordinate?: [number, number];
    start_coordinate?: [number, number];
    description?: string;
  };
  viewportWidth?: number;
  viewportHeight?: number;
}

interface GifOptions {
  showClickIndicators?: boolean;
  showDragPaths?: boolean;
  showActionLabels?: boolean;
  showProgressBar?: boolean;
  showWatermark?: boolean;
  quality?: number;
}

const ORANGE = '#D97757';
const ORANGE_RGBA = (alpha: number) => `rgba(217, 119, 87, ${alpha})`;
const RED = '#dc2626';

function drawClickIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, 15 * s, 0, 2 * Math.PI); ctx.fillStyle = ORANGE_RGBA(0.3); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, 11 * s, 0, 2 * Math.PI); ctx.fillStyle = ORANGE_RGBA(0.5); ctx.fill();
  ctx.strokeStyle = ORANGE_RGBA(1); ctx.lineWidth = 2 * s; ctx.stroke();
  ctx.restore();
}

function drawDragPath(ctx: CanvasRenderingContext2D, sx: number, sy: number, ex: number, ey: number, s: number): void {
  ctx.save();
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
  ctx.strokeStyle = RED; ctx.lineWidth = 3 * s; ctx.stroke();

  const angle = Math.atan2(ey - sy, ex - sx);
  const headLen = 15 * s;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - headLen * Math.cos(angle - Math.PI / 6), ey - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(ex - headLen * Math.cos(angle + Math.PI / 6), ey - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath(); ctx.fillStyle = RED; ctx.fill();

  for (const [mx, my, color] of [[sx, sy, ORANGE], [ex, ey, RED]] as [number, number, string][]) {
    ctx.beginPath(); ctx.arc(mx, my, 6 * s, 0, 2 * Math.PI);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2 * s; ctx.stroke();
  }
  ctx.restore();
}

function drawActionLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, s: number): void {
  ctx.save();
  const fontSize = 14 * s;
  ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
  const metrics = ctx.measureText(text);
  const padding = 8 * s;
  const textHeight = 20 * s;

  let labelX = x + 20 * s;
  let labelY = y - 10 * s;
  if (labelX + metrics.width + padding * 2 > ctx.canvas.width) labelX = x - metrics.width - padding * 2 - 20 * s;
  if (labelY < 0) labelY = y + 20 * s;

  const w = metrics.width + padding * 2;
  const h = textHeight + padding;
  ctx.beginPath(); ctx.roundRect(labelX, labelY, w, h, 6 * s);
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 4 * s; ctx.shadowOffsetY = 2 * s;
  ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(text, labelX + padding, labelY + padding);
  ctx.restore();
}

function drawProgressBar(ctx: CanvasRenderingContext2D, progress: number, s: number): void {
  const h = 4 * s;
  const y = ctx.canvas.height - h;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(0, y, ctx.canvas.width, h);
  ctx.fillStyle = '#C96442'; ctx.fillRect(0, y, ctx.canvas.width * progress, h);
}

function drawWatermark(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.save();
  const padding = 8 * s;
  const size = 32 * s;
  const x = ctx.canvas.width - padding - size;
  const y = ctx.canvas.height - padding - size - 4 * s;

  ctx.beginPath(); ctx.roundRect(x, y, size, size, size * 0.234);
  const grad = ctx.createLinearGradient(x, y + size, x, y);
  grad.addColorStop(0, '#DC6038'); grad.addColorStop(1, ORANGE);
  ctx.fillStyle = grad; ctx.fill();

  ctx.fillStyle = 'rgba(250,249,245,0.9)';
  ctx.font = `bold ${size * 0.6}px system-ui`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('D', x + size / 2, y + size / 2);
  ctx.restore();
}

function applyOverlays(
  canvas: HTMLCanvasElement,
  action: Frame['action'],
  opts: Required<Omit<GifOptions, 'quality'>>,
  s: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || !action) return;

  if (opts.showClickIndicators && action.coordinate && (action.type.includes('click') || action.type === 'scroll')) {
    const [x, y] = action.coordinate;
    drawClickIndicator(ctx, x * s, y * s, s);
    if (opts.showActionLabels && action.description) drawActionLabel(ctx, action.description, x * s, y * s, s);
  }
  if (opts.showDragPaths && action.type === 'left_click_drag' && action.start_coordinate && action.coordinate) {
    const [sx, sy] = action.start_coordinate;
    const [ex, ey] = action.coordinate;
    drawDragPath(ctx, sx * s, sy * s, ex * s, ey * s, s);
    if (opts.showActionLabels && action.description) drawActionLabel(ctx, action.description, ex * s, ey * s, s);
  }
  if (opts.showActionLabels && action.description && !action.coordinate && ['type', 'key', 'wait'].includes(action.type)) {
    drawActionLabel(ctx, action.description, 20 * s, 20 * s, s);
  }
}

interface GifJsLib {
  new (config: Record<string, unknown>): {
    on(event: 'finished', cb: (blob: Blob) => void): void;
    on(event: 'abort', cb: () => void): void;
    addFrame(canvas: HTMLCanvasElement, options: { delay: number }): void;
    render(): void;
  };
}

async function generateGif(frames: Frame[], options: GifOptions): Promise<{
  base64: string; blobUrl: string; size: number; width: number; height: number;
}> {
  const opts = {
    showClickIndicators: options.showClickIndicators ?? true,
    showDragPaths: options.showDragPaths ?? true,
    showActionLabels: options.showActionLabels ?? true,
    showProgressBar: options.showProgressBar ?? true,
    showWatermark: options.showWatermark ?? true,
  };

  const images = await Promise.all(
    frames.map((f) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = `data:image/${f.format ?? 'png'};base64,${f.base64}`;
      }),
    ),
  );

  const width = images[0].width;
  const height = images[0].height;

  const canvases = images.map((img, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    const frame = frames[i];
    const s = frame.viewportWidth ? canvas.width / frame.viewportWidth : 1;
    if (frame.action) applyOverlays(canvas, frame.action, opts, s);
    if (opts.showProgressBar) drawProgressBar(ctx, (i + 1) / images.length, s);
    if (opts.showWatermark) drawWatermark(ctx, s);
    return canvas;
  });

  const delays = frames.map((f, i) => {
    const base = f.delay ?? 800;
    return i === frames.length - 1 ? base + 2_000 : base;
  });

  const GIF = (window as unknown as { GIF?: GifJsLib }).GIF;
  if (!GIF) throw new Error('gif.js not loaded');

  return new Promise((resolve, reject) => {
    const gif = new GIF({
      workers: 2,
      quality: options.quality ?? 10,
      width, height,
      workerScript: chrome.runtime.getURL('vendor/gif.worker.js'),
      repeat: 0,
    });

    gif.on('finished', (blob) => {
      const blobUrl = URL.createObjectURL(blob);
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1] ?? '';
        resolve({ base64, blobUrl, size: blob.size, width, height });
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    gif.on('abort', () => reject(new Error('GIF rendering aborted')));

    canvases.forEach((c, i) => gif.addFrame(c, { delay: delays[i] }));
    gif.render();
  });
}

// ============================================================
// Message handler
// ============================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'OFFSCREEN_PLAY_SOUND') {
    playAudio(message.audioUrl, message.volume ?? 0.5)
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: String(e) }));
    return true;
  }

  if (message.type === 'REVOKE_BLOB_URL') {
    URL.revokeObjectURL(message.blobUrl);
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'GENERATE_GIF') {
    generateGif(message.frames, message.options ?? {})
      .then((result) => sendResponse({ success: true, result }))
      .catch((e) => sendResponse({ success: false, error: String(e) }));
    return true;
  }

  return false;
});
