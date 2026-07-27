// Plan-for-approval surface. Phase G can wire this to a sidepanel modal;
// for now it just echoes the plan back as text.

import { fail, ok, type ToolDefinition } from './types';

export const updatePlanTool: ToolDefinition = {
  name: 'update_plan',
  description: 'Present a plan with target domains and steps for the user to review.',
  parameters: {
    type: 'object',
    properties: {
      domains: { type: 'array' },
      approach: { type: 'array' },
    },
    required: ['domains', 'approach'],
  },

  async execute(args) {
    const domains = args.domains as string[] | undefined;
    const approach = args.approach as string[] | undefined;
    if (!Array.isArray(domains) || domains.length === 0) {
      return fail('domains must be a non-empty array');
    }
    if (!Array.isArray(approach) || approach.length === 0) {
      return fail('approach must be a non-empty array');
    }

    const lines = [
      'Plan submitted for approval:',
      '',
      'Domains:',
      ...domains.map((d) => `  - ${d}`),
      '',
      'Approach:',
      ...approach.map((a, i) => `  ${i + 1}. ${a}`),
    ];
    return ok(lines.join('\n'));
  },
};
