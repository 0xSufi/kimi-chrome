import { addTabToMcpGroup, getMcpTabs } from '../core/tab-groups';
import { fail, ok, type ToolDefinition } from './types';

export const tabsCreateTool: ToolDefinition = {
  name: 'tabs_create_mcp',
  description: 'Create a new tab inside the agent\'s tab group.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to open (default: chrome://newtab)' },
    },
  },

  async execute(args) {
    const url = (args.url as string) || 'chrome://newtab';

    // Ensure the MCP group exists.
    const ctx = await getMcpTabs({ createIfEmpty: true });
    if (ctx.tabGroupId == null) return fail('Could not create or locate tab group');

    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id == null) return fail('Failed to create tab');
    const groupId = await addTabToMcpGroup(tab.id);
    if (groupId == null) return fail('Failed to add tab to group');

    return ok(`Created tab ${tab.id} (${url}) in group ${groupId}`);
  },
};
