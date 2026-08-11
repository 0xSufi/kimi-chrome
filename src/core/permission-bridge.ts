// SW → side panel permission prompt bridge.
//
// dispatch() calls requestPermission() when check() returns needsPrompt.
// We sendMessage to the side panel; the panel renders the prompt and
// responds with { action, duration }. If the panel is closed, sendMessage
// rejects with "Could not establish connection" and we treat it as a
// timeout-style deny: better to fail the tool than block native messaging
// callers forever.

import { grant, deny, type PermissionScope } from './permissions';

interface PermissionResponse {
  action: 'allow' | 'deny';
  duration: 'once' | 'always';
}

const PROMPT_TIMEOUT_MS = 60_000;

export async function requestPermission(opts: {
  netloc: string;
  tool: string;
  toolUseId?: string;
}): Promise<{ allowed: boolean; reason?: string }> {
  const requestId = crypto.randomUUID();

  let response: PermissionResponse | null = null;
  try {
    response = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'permission_request',
        requestId,
        netloc: opts.netloc,
        tool: opts.tool,
        toolUseId: opts.toolUseId,
      }) as Promise<PermissionResponse | undefined>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROMPT_TIMEOUT_MS)),
    ]) as PermissionResponse | null;
  } catch {
    // Side panel is not open; sendMessage rejects. Say what actually
    // unblocks it — the old message sent people to open the panel, which
    // works once and then asks again, because "allow once" is bound to a
    // single toolUseId. An ALWAYS grant, or a trusted origin, is what makes
    // it stop asking.
    return {
      allowed: false,
      reason: `No UI to prompt for permission on ${opts.netloc}. Open the side panel and choose `
        + `"Allow always" (an "allow once" grant covers a single call), or add ${opts.netloc} to `
        + `trusted origins so it never prompts.`,
    };
  }

  if (!response) {
    return { allowed: false, reason: 'Permission prompt timed out' };
  }

  const scope: PermissionScope = { type: 'netloc', netloc: opts.netloc };
  if (response.action === 'allow') {
    await grant(scope, response.duration, opts.toolUseId);
    return { allowed: true };
  }
  await deny(scope, response.duration);
  return { allowed: false, reason: 'Permission denied' };
}
