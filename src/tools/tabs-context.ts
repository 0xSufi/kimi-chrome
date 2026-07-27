import { getMcpTabs } from '../core/tab-groups';
import { ok, type ToolDefinition } from './types';

export const tabsContextTool: ToolDefinition = {
  name: 'tabs_context_mcp',
  description: 'Get information about tabs in the agent\'s tab group. Pass createIfEmpty to create a fresh group if none exists.',
  parameters: {
    type: 'object',
    properties: {
      createIfEmpty: { type: 'boolean' },
    },
  },

  async execute(args) {
    const result = await getMcpTabs({ createIfEmpty: args.createIfEmpty === true });
    if (result.tabs.length === 0) return ok('No tabs available.');

    const lines = [
      `Tab group${result.tabGroupId != null ? ` (id: ${result.tabGroupId})` : ' (none — using active tab)'}: ${result.tabs.length} tab(s)`,
      '',
    ];
    for (const t of result.tabs) {
      lines.push(`  - Tab ${t.tabId}: ${t.title || '(untitled)'}`);
      lines.push(`    URL: ${t.url || 'about:blank'}`);
    }
    return ok(lines.join('\n'));
  },
};
