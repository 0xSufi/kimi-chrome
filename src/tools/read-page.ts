import { fail, ok, type ToolDefinition } from './types';

interface InjectedResult {
  pageContent?: string;
  viewport?: { width: number; height: number };
  error?: string;
}

export const readPageTool: ToolDefinition = {
  name: 'read_page',
  description: 'Get the page accessibility tree — interactive elements with refs you can pass to computer/form_input.',
  parameters: {
    type: 'object',
    properties: {
      filter: { type: 'string', enum: ['interactive', 'all'] },
      depth: { type: 'number' },
      ref_id: { type: 'string' },
      max_chars: { type: 'number' },
      tabId: { type: 'number' },
    },
  },

  async execute(args, ctx) {
    const tabId = (args.tabId as number) ?? ctx.tabId;
    const filter = (args.filter as string) ?? 'all';
    const depth = (args.depth as number) ?? 15;
    const refId = (args.ref_id as string | undefined) ?? null;
    const maxChars = (args.max_chars as number) ?? 50_000;

    let result: { result?: InjectedResult };
    try {
      [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (f: string, d: number, mc: number, ri: string | null) => {
          const w = window as unknown as {
            __dyspelGenerateAccessibilityTree?: (filter: string | null, depth: number, max: number, ref: string | null) => InjectedResult;
          };
          if (!w.__dyspelGenerateAccessibilityTree) {
            return { error: 'Accessibility tree script not loaded — refresh the page and retry.' };
          }
          return w.__dyspelGenerateAccessibilityTree(f === 'interactive' ? 'interactive' : null, d, mc, ri);
        },
        args: [filter, depth, maxChars, refId],
      });
    } catch (e) {
      return fail(`Failed to read page: ${e instanceof Error ? e.message : String(e)}`);
    }

    const data = result?.result;
    if (!data) return fail('No response from accessibility-tree script. The page may not be loaded yet.');
    if (data.error) return fail(data.error);

    const vp = data.viewport ?? { width: 0, height: 0 };
    return ok(`${data.pageContent ?? ''}\n\nViewport: ${vp.width}x${vp.height}`);
  },
};
