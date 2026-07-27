import { fail, ok, type ToolDefinition } from './types';

const MAX_W = 7680;
const MAX_H = 4320;

export const resizeWindowTool: ToolDefinition = {
  name: 'resize_window',
  description: 'Resize the browser window containing the given tab.',
  parameters: {
    type: 'object',
    properties: {
      width: { type: 'number' },
      height: { type: 'number' },
      tabId: { type: 'number' },
    },
    required: ['width', 'height', 'tabId'],
  },

  async execute(args, ctx) {
    const width = args.width as number;
    const height = args.height as number;
    const tabId = (args.tabId as number) ?? ctx.tabId;

    if (!(width > 0) || !(height > 0)) return fail('width and height must be positive');
    if (width > MAX_W || height > MAX_H) return fail(`Maximum dimensions are ${MAX_W}×${MAX_H}`);

    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId == null) return fail('Tab has no window');
      await chrome.windows.update(tab.windowId, { width, height });
      return ok(`Resized window to ${width}×${height}`);
    } catch (e) {
      return fail(`Resize failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
