import { enableConsoleTracking, getConsoleMessages, clearConsole } from '../core/cdp-tracking';
import { fail, ok, type ToolDefinition } from './types';

export const readConsoleMessagesTool: ToolDefinition = {
  name: 'read_console_messages',
  description: 'Read browser console messages from a tab.',
  needsDebugger: true,
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'number' },
      onlyErrors: { type: 'boolean' },
      pattern: { type: 'string' },
      clear: { type: 'boolean' },
      limit: { type: 'number' },
    },
    required: ['tabId'],
  },

  async execute(args, ctx) {
    const tabId = (args.tabId as number) ?? ctx.tabId;
    const errorsOnly = args.onlyErrors === true;
    const pattern = args.pattern as string | undefined;
    const limit = (args.limit as number) ?? 100;
    const clear = args.clear === true;

    try {
      await enableConsoleTracking(tabId);
    } catch (e) {
      return fail(`Cannot read console: ${e instanceof Error ? e.message : String(e)}`);
    }

    let messages = getConsoleMessages(tabId, { errorsOnly, pattern });
    if (messages.length > limit) messages = messages.slice(-limit);

    if (clear) clearConsole(tabId);

    if (messages.length === 0) return ok('No console messages.');

    const lines = [`${messages.length} message(s):`, ''];
    messages.forEach((m, i) => {
      const time = new Date(m.timestamp).toLocaleTimeString();
      const loc = m.url ? ` (${m.url}${m.lineNumber != null ? `:${m.lineNumber}` : ''})` : '';
      lines.push(`[${i + 1}] ${time} ${m.type.toUpperCase()}${loc}`);
      lines.push(`  ${m.text}`);
      lines.push('');
    });
    return ok(lines.join('\n'));
  },
};
