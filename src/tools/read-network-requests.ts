import { enableNetworkTracking, getNetworkRequests, clearNetwork } from '../core/cdp-tracking';
import { fail, ok, type ToolDefinition } from './types';

export const readNetworkRequestsTool: ToolDefinition = {
  name: 'read_network_requests',
  description: 'Read HTTP requests made by a tab.',
  needsDebugger: true,
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'number' },
      urlPattern: { type: 'string' },
      clear: { type: 'boolean' },
      limit: { type: 'number' },
    },
    required: ['tabId'],
  },

  async execute(args, ctx) {
    const tabId = (args.tabId as number) ?? ctx.tabId;
    const urlPattern = args.urlPattern as string | undefined;
    const limit = (args.limit as number) ?? 100;
    const clear = args.clear === true;

    try {
      await enableNetworkTracking(tabId);
    } catch (e) {
      return fail(`Cannot read network: ${e instanceof Error ? e.message : String(e)}`);
    }

    let requests = getNetworkRequests(tabId, urlPattern);
    if (requests.length > limit) requests = requests.slice(-limit);
    if (clear) clearNetwork(tabId);

    if (requests.length === 0) {
      return ok(urlPattern ? `No requests matching "${urlPattern}".` : 'No requests.');
    }

    const lines = [`${requests.length} request(s)${urlPattern ? ` matching "${urlPattern}"` : ''}:`, ''];
    requests.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.method} ${r.url}`);
      if (r.status != null) lines.push(`   status: ${r.status}${r.statusText ? ' ' + r.statusText : ''}`);
      if (r.type) lines.push(`   type: ${r.type}`);
      lines.push('');
    });
    return ok(lines.join('\n'));
  },
};
