import { setBeforeunloadPolicy, consumeBeforeunloadOutcome } from '../core/cdp-tracking';
import { fail, ok, type ToolDefinition } from './types';

function normalizeUrl(input: string): string {
  if (/^[a-z]+:\/\//i.test(input)) return input;
  return `https://${input}`;
}

async function withBeforeunload<T>(
  tabId: number,
  force: boolean,
  fn: () => Promise<T>,
): Promise<{ result: T; blocked: boolean }> {
  setBeforeunloadPolicy(tabId, force ? 'accept' : 'dismiss');
  try {
    const result = await fn();
    await new Promise((r) => setTimeout(r, 200));
    const outcome = consumeBeforeunloadOutcome(tabId);
    return { result, blocked: outcome != null && !outcome.accepted };
  } finally {
    setBeforeunloadPolicy(tabId, 'dismiss');
  }
}

export const navigateTool: ToolDefinition = {
  name: 'navigate',
  description: 'Navigate the current tab to a URL or step through history.',
  needsDebugger: true,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to navigate to, or "back" / "forward" for history' },
      tabId: { type: 'number' },
      force: { type: 'boolean', description: 'Bypass beforeunload prompts (default: false)' },
    },
    required: ['url'],
  },

  gateOn(args) {
    const url = args.url as string | undefined;
    if (!url || url === 'back' || url === 'forward') return undefined;
    try { return new URL(normalizeUrl(url)).href; } catch { return undefined; }
  },

  async execute(args, ctx) {
    const url = args.url as string;
    const tabId = (args.tabId as number) ?? ctx.tabId;
    const force = (args.force as boolean) ?? false;

    if (url === 'back' || url === 'forward') {
      const { blocked } = await withBeforeunload(tabId, force, () =>
        url === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId),
      );
      if (blocked) {
        return fail('Navigation blocked by unsaved changes — call again with force=true to override.');
      }
      await new Promise((r) => setTimeout(r, 500));
      const tab = await chrome.tabs.get(tabId);
      return ok(`Navigated ${url} to ${tab.url ?? 'unknown'}`);
    }

    const target = normalizeUrl(url);
    try {
      new URL(target);
    } catch {
      return fail(`Invalid URL: ${url}`);
    }

    const { blocked } = await withBeforeunload(tabId, force, () =>
      chrome.tabs.update(tabId, { url: target }),
    );
    if (blocked) {
      return fail('Navigation blocked by unsaved changes — call again with force=true to override.');
    }

    await new Promise((r) => setTimeout(r, 1000));
    const tab = await chrome.tabs.get(tabId);
    return ok(`Navigated to ${tab.url ?? target}`);
  },
};
