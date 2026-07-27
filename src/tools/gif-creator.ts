// GIF recorder. Frames are buffered here; rendering happens in the
// offscreen document (Phase F). Until offscreen lands, export will
// return a stub message indicating frames are buffered but not encoded.

import { ensureOffscreen } from '../core/offscreen';
import { fail, ok, type ToolDefinition } from './types';

const MAX_FRAMES = 50;

interface Frame {
  base64: string;
  format: string;
  timestamp: number;
}

const framesByGroup = new Map<string, Frame[]>();
const recording = new Set<string>();

function key(ctx: { tabGroupId?: number | string; tabId: number }): string {
  return ctx.tabGroupId != null ? `g:${ctx.tabGroupId}` : `t:${ctx.tabId}`;
}

export function isRecording(k: string): boolean {
  return recording.has(k);
}

export function pushFrame(k: string, base64: string, format = 'jpeg'): void {
  if (!recording.has(k)) return;
  const frames = framesByGroup.get(k) ?? [];
  if (frames.length >= MAX_FRAMES) return;
  frames.push({ base64, format, timestamp: Date.now() });
  framesByGroup.set(k, frames);
}

export const gifCreatorTool: ToolDefinition = {
  name: 'gif_creator',
  description: 'Record browser actions and export as an animated GIF.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start_recording', 'stop_recording', 'export', 'clear'] },
      filename: { type: 'string' },
      options: { type: 'object' },
      tabId: { type: 'number' },
    },
    required: ['action'],
  },

  async execute(args, ctx) {
    const action = args.action as string;
    const k = key(ctx);

    switch (action) {
      case 'start_recording':
        framesByGroup.set(k, []);
        recording.add(k);
        return ok(`Recording started (cap: ${MAX_FRAMES} frames). Perform actions, then stop_recording → export.`);

      case 'stop_recording': {
        const count = framesByGroup.get(k)?.length ?? 0;
        recording.delete(k);
        return ok(`Recording stopped. Captured ${count} frame(s). Use 'export' to render.`);
      }

      case 'export': {
        const frames = framesByGroup.get(k);
        if (!frames || frames.length === 0) {
          return fail('No frames captured. Start recording first.');
        }
        try {
          await ensureOffscreen(chrome.offscreen.Reason.BLOBS);
          const response = await chrome.runtime.sendMessage({
            type: 'GENERATE_GIF',
            frames: frames.map((f) => ({ base64: f.base64, format: f.format })),
            options: args.options ?? {},
          });
          if (response?.error) return fail(response.error);
          return ok(`GIF exported (${frames.length} frames)`);
        } catch (e) {
          return fail(`GIF export failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      case 'clear':
        framesByGroup.delete(k);
        recording.delete(k);
        return ok('Recording data cleared.');

      default:
        return fail(`Unknown gif_creator action: ${action}`);
    }
  },
};
