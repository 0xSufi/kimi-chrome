import { sendCommand } from '../core/cdp';
import {
  click,
  dispatchMouseEvent,
  parseModifiers,
  pressKey,
  pressKeyChord,
  scrollWheel,
  typeText,
} from '../core/cdp-input';
import { captureScreenshot } from '../core/cdp-screenshot';
import { fail, ok, textAndImage, type ToolDefinition } from './types';

async function resolveRef(tabId: number, ref: string): Promise<{ x: number; y: number } | null> {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (refId: string) => {
        const map = (window as unknown as { __dyspelElementMap?: Record<string, WeakRef<Element>> }).__dyspelElementMap;
        if (!map?.[refId]) return null;
        const el = map[refId].deref();
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      },
      args: [ref],
    });
    return r?.result ?? null;
  } catch {
    return null;
  }
}

function isReloadKey(text: string): boolean {
  const k = text.toLowerCase();
  return k === 'f5' || /^(ctrl|cmd|command)(\+shift)?\+r$/.test(k);
}

export const computerTool: ToolDefinition = {
  name: 'computer',
  description: 'Pointer, keyboard, screenshot, scroll, and zoom actions on the active page.',
  needsDebugger: true,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'screenshot',
          'left_click',
          'right_click',
          'double_click',
          'triple_click',
          'type',
          'key',
          'scroll',
          'scroll_to',
          'left_click_drag',
          'hover',
          'zoom',
          'wait',
        ],
      },
      coordinate: { type: 'array' },
      start_coordinate: { type: 'array' },
      region: { type: 'array' },
      text: { type: 'string' },
      ref: { type: 'string' },
      duration: { type: 'number' },
      scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      scroll_amount: { type: 'number' },
      repeat: { type: 'number' },
      modifiers: { type: 'string' },
      tabId: { type: 'number' },
    },
    required: ['action'],
  },

  async execute(args, ctx) {
    const action = args.action as string;
    const tabId = (args.tabId as number) ?? ctx.tabId;
    const coordinate = args.coordinate as [number, number] | undefined;
    const text = args.text as string | undefined;
    const ref = args.ref as string | undefined;
    const modifiers = parseModifiers(args.modifiers as string | undefined);

    switch (action) {
      case 'screenshot': {
        const ss = await captureScreenshot(tabId);
        return textAndImage(
          `Screenshot ${ss.width}x${ss.height} (${ss.format})`,
          ss.base64,
          ss.format === 'png' ? 'image/png' : 'image/jpeg',
        );
      }

      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click': {
        const target = await resolveTarget(tabId, ref, coordinate);
        if (!target) return fail('Either coordinate or ref is required for click actions');

        const button = action === 'right_click' ? 'right' : 'left';
        const clickCount = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
        await click(tabId, target.x, target.y, button, clickCount, modifiers);
        return ok(`Clicked ${describeTarget(ref, target)}${clickCount > 1 ? ` (${clickCount}x)` : ''}`);
      }

      case 'type': {
        if (!text) return fail('text parameter is required for type');
        await typeText(tabId, text);
        return ok(`Typed ${preview(text)}`);
      }

      case 'key': {
        if (!text) return fail('text parameter is required for key');
        const repeat = clamp((args.repeat as number) ?? 1, 1, 100);
        const keys = text.split(/\s+/);
        for (let i = 0; i < repeat; i++) {
          for (const key of keys) {
            if (isReloadKey(key)) {
              await chrome.tabs.reload(tabId, { bypassCache: key.toLowerCase().includes('shift') });
              continue;
            }
            if (key.includes('+')) await pressKeyChord(tabId, key);
            else await pressKey(tabId, key, modifiers);
          }
        }
        return ok(`Pressed ${keys.join(' ')}${repeat > 1 ? ` × ${repeat}` : ''}`);
      }

      case 'scroll': {
        if (!coordinate) return fail('coordinate is required for scroll');
        const direction = (args.scroll_direction as string) ?? 'down';
        const amount = clamp((args.scroll_amount as number) ?? 3, 1, 10);
        const PX_PER_TICK = 100;
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
        await scrollWheel(tabId, coordinate[0], coordinate[1], dx * PX_PER_TICK, dy * PX_PER_TICK);
        return ok(`Scrolled ${direction} by ${amount}`);
      }

      case 'scroll_to': {
        if (!ref) return fail('ref parameter is required for scroll_to');
        const target = await resolveRef(tabId, ref);
        if (!target) return fail(`Element ${ref} not found`);
        return ok(`Scrolled to ${ref} at (${target.x}, ${target.y})`);
      }

      case 'left_click_drag': {
        const start = args.start_coordinate as [number, number] | undefined;
        if (!start || !coordinate) return fail('start_coordinate and coordinate are both required for drag');
        const [sx, sy] = start;
        const [ex, ey] = coordinate;
        await dispatchMouseEvent(tabId, { type: 'mouseMoved', x: sx, y: sy });
        await dispatchMouseEvent(tabId, { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 100));
        await dispatchMouseEvent(tabId, { type: 'mouseMoved', x: ex, y: ey, button: 'left' });
        await dispatchMouseEvent(tabId, { type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1 });
        return ok(`Dragged (${sx},${sy}) → (${ex},${ey})`);
      }

      case 'hover': {
        const target = await resolveTarget(tabId, ref, coordinate);
        if (!target) return fail('Either coordinate or ref is required for hover');
        await dispatchMouseEvent(tabId, { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
        return ok(`Hovered ${describeTarget(ref, target)}`);
      }

      case 'zoom': {
        const region = args.region as [number, number, number, number] | undefined;
        if (!region || region.length !== 4) return fail('region [x0,y0,x1,y1] is required for zoom');
        const [x0, y0, x1, y1] = region;
        if (x1 <= x0 || y1 <= y0) return fail('Invalid region');
        const r = await sendCommand<{ data: string }>(tabId, 'Page.captureScreenshot', {
          format: 'png',
          clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 1 },
        });
        return textAndImage(`Zoom (${x0},${y0})–(${x1},${y1})`, r.data ?? '', 'image/png');
      }

      case 'wait': {
        const seconds = clamp((args.duration as number) ?? 1, 0, 30);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return ok(`Waited ${seconds}s`);
      }

      default:
        return fail(`Unknown action: ${action}`);
    }
  },
};

async function resolveTarget(
  tabId: number,
  ref: string | undefined,
  coordinate: [number, number] | undefined,
): Promise<{ x: number; y: number } | null> {
  if (ref) return resolveRef(tabId, ref);
  if (coordinate) return { x: coordinate[0], y: coordinate[1] };
  return null;
}

function describeTarget(ref: string | undefined, target: { x: number; y: number }): string {
  return ref ? `element ${ref}` : `(${target.x}, ${target.y})`;
}

function preview(text: string): string {
  return JSON.stringify(text.length > 50 ? text.slice(0, 50) + '…' : text);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
