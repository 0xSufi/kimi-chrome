import { sendCommand } from '../core/cdp';
import { fail, ok, type ToolDefinition } from './types';

const MAX_OUTPUT = 51_200;
const MAX_STRING = 1_000;

const SENSITIVE_KEY = /password|token|secret|api[_-]?key|authorization|credential/i;
const JWT = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]{20,}={0,2}$/;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[MAX DEPTH]';

  if (typeof value === 'string') {
    if (value.length > MAX_STRING) return value.slice(0, MAX_STRING) + '… [TRUNCATED]';
    if (JWT.test(value)) return '[JWT FILTERED]';
    if (BASE64.test(value) && value.length > 40) return '[BASE64 FILTERED]';
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > 100) {
      return [...value.slice(0, 100).map((v) => sanitize(v, depth + 1)), `… [${value.length - 100} more items]`];
    }
    return value.map((v) => sanitize(v, depth + 1));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[SENSITIVE FILTERED]' : sanitize(v, depth + 1);
    }
    return out;
  }

  return value;
}

interface EvalResult {
  exceptionDetails?: { exception?: { description?: string }; text?: string };
  result?: { value?: unknown };
}

export const javascriptTool: ToolDefinition = {
  name: 'javascript_tool',
  description: 'Execute JavaScript in the page context. Output is filtered for likely secrets.',
  needsDebugger: true,
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'JavaScript expression or statement(s) to evaluate' },
      tabId: { type: 'number' },
    },
    required: ['text'],
  },

  async execute(args, ctx) {
    const code = args.text as string;
    const tabId = (args.tabId as number) ?? ctx.tabId;
    if (!code) return fail('text parameter is required');

    const expression = `(function(){'use strict';return eval(${JSON.stringify(code)});})()`;

    let result: EvalResult;
    try {
      result = await sendCommand<EvalResult>(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: 30_000,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('timed out')) return fail('JavaScript timed out after 30s');
      return fail(`JavaScript failed: ${msg}`);
    }

    if (result.exceptionDetails) {
      return fail(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'JavaScript error');
    }

    const value = result.result?.value;
    if (value === undefined) return ok('undefined');

    const sanitized = sanitize(value);
    let output = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized, null, 2);
    if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n[OUTPUT TRUNCATED]';

    return ok(output);
  },
};
