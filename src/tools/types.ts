// Tool definition shapes plus result-builder helpers.

import type { ToolContent } from '../core/protocol';

export interface ToolResult {
  content: ToolContent;
  is_error?: boolean;
}

export interface ToolContext {
  tabId: number;
  source: 'native' | 'bridge';
  clientId?: string;
  tabGroupId?: number | string;
  sessionScope?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  needsDebugger?: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  // Optional override: which URL should the permission gate run against?
  // Defaults to the resolved tab's current URL. navigate uses this to
  // gate on the destination so the agent can't ferry the user from a
  // permitted domain to an unconsented one.
  gateOn?(args: Record<string, unknown>): string | undefined;
}

export interface ToolParameterSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

// ============================================================
// Result builders
// ============================================================

export function ok(text: string): ToolResult {
  return { content: text };
}

export function fail(text: string): ToolResult {
  return { content: text, is_error: true };
}

export function image(base64: string, mediaType: 'image/jpeg' | 'image/png' = 'image/jpeg'): ToolResult {
  return {
    content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }],
  };
}

export function textAndImage(
  text: string,
  base64: string,
  mediaType: 'image/jpeg' | 'image/png' = 'image/jpeg',
): ToolResult {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
    ],
  };
}
