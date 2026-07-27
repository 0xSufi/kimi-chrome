import { fail, ok, type ToolDefinition } from './types';

interface InjectedResult {
  pageContent?: string;
  viewport?: { width: number; height: number };
  error?: string;
}

const MAX_HITS = 20;

export const findTool: ToolDefinition = {
  name: 'find',
  description: 'Find elements on the page matching a natural-language query. Returns refs you can hand to other tools.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      tabId: { type: 'number' },
    },
    required: ['query'],
  },

  async execute(args, ctx) {
    const query = (args.query as string)?.trim();
    if (!query) return fail('query parameter is required');
    const tabId = (args.tabId as number) ?? ctx.tabId;

    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const w = window as unknown as {
          __dyspelGenerateAccessibilityTree?: (filter: string | null, depth: number, max: number, ref: string | null) => InjectedResult;
        };
        return w.__dyspelGenerateAccessibilityTree?.(null, 15, 50_000, null) ?? null;
      },
    });

    const tree: InjectedResult | null = r?.result ?? null;
    if (!tree?.pageContent) return fail('Failed to read page content. Refresh and retry.');

    const lines = tree.pageContent.split('\n');
    const q = query.toLowerCase();

    const exact = lines.filter((l) => l.includes('ref_') && l.toLowerCase().includes(q));
    const matches = exact.length > 0
      ? exact
      : lines.filter((l) => {
          if (!l.includes('ref_')) return false;
          const lower = l.toLowerCase();
          return q.split(/\s+/).some((word) => lower.includes(word));
        });

    if (matches.length === 0) {
      return ok(`No elements found matching "${query}". Use read_page to see all elements.`);
    }

    const head = matches.slice(0, MAX_HITS).map((m) => m.trim());
    const tail = matches.length > MAX_HITS ? [`\n… and ${matches.length - MAX_HITS} more — narrow your query.`] : [];
    return ok([`Found ${matches.length} element(s) for "${query}"`, '', ...head, ...tail].join('\n'));
  },
};
