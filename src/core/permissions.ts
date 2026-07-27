// Per-domain tool permissions.
//
// A Permission grants or denies access to a netloc (domain) or a
// from→to domain transition, either ONCE (until cleared) or ALWAYS.
// Phase E ships the data layer; Phase G wires the prompt UI.

import { StorageKey } from './protocol';

export type PermissionAction = 'allow' | 'deny';
export type PermissionDuration = 'once' | 'always';

export interface NetlocScope { type: 'netloc'; netloc: string }
export interface TransitionScope { type: 'transition'; from: string; to: string }
export type PermissionScope = NetlocScope | TransitionScope;

export interface Permission {
  id: string;
  scope: PermissionScope;
  action: PermissionAction;
  duration: PermissionDuration;
  createdAt: number;
  toolUseId?: string;
}

export interface CheckResult {
  allowed: boolean;
  needsPrompt?: boolean;
  permission?: Permission;
}

let cache: Permission[] | null = null;

async function load(): Promise<Permission[]> {
  if (cache) return cache;
  const data = await chrome.storage.local.get([StorageKey.PERMISSIONS as string]);
  cache = (data[StorageKey.PERMISSIONS] as Permission[] | undefined) ?? [];
  return cache;
}

async function save(list: Permission[]): Promise<void> {
  cache = list;
  await chrome.storage.local.set({ [StorageKey.PERMISSIONS]: list });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[StorageKey.PERMISSIONS]) {
    cache = (changes[StorageKey.PERMISSIONS].newValue as Permission[] | undefined) ?? [];
  }
});

// ============================================================
// Matching
// ============================================================

export function matchesNetloc(domain: string, pattern: string): boolean {
  if (pattern === domain) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return domain === suffix || domain.endsWith(`.${suffix}`);
  }
  return false;
}

function netlocOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ============================================================
// Querying
// ============================================================

export async function check(url: string, toolUseId?: string): Promise<CheckResult> {
  const netloc = netlocOf(url);
  if (!netloc) return { allowed: true };

  const list = await load();

  // ONCE permissions tied to a specific toolUseId beat ALWAYS rules.
  if (toolUseId) {
    for (const p of list) {
      if (
        p.scope.type === 'netloc' &&
        p.duration === 'once' &&
        p.toolUseId === toolUseId &&
        matchesNetloc(netloc, p.scope.netloc)
      ) {
        return { allowed: p.action === 'allow', permission: p };
      }
    }
  }

  for (const p of list) {
    if (
      p.scope.type === 'netloc' &&
      p.duration === 'always' &&
      matchesNetloc(netloc, p.scope.netloc)
    ) {
      return { allowed: p.action === 'allow', permission: p };
    }
  }

  return { allowed: false, needsPrompt: true };
}

export async function checkTransition(fromUrl: string, toUrl: string): Promise<CheckResult> {
  const from = netlocOf(fromUrl);
  const to = netlocOf(toUrl);
  if (!from || !to || from === to) return { allowed: true };

  const list = await load();
  for (const p of list) {
    if (
      p.scope.type === 'transition' &&
      matchesNetloc(from, p.scope.from) &&
      matchesNetloc(to, p.scope.to)
    ) {
      return { allowed: p.action === 'allow', permission: p };
    }
  }
  return { allowed: false, needsPrompt: true };
}

export async function listAll(): Promise<Permission[]> {
  return [...(await load())];
}

// ============================================================
// Mutation
// ============================================================

export async function grant(
  scope: PermissionScope,
  duration: PermissionDuration,
  toolUseId?: string,
): Promise<Permission> {
  return write({ scope, action: 'allow', duration, toolUseId });
}

export async function deny(
  scope: PermissionScope,
  duration: PermissionDuration,
): Promise<Permission> {
  return write({ scope, action: 'deny', duration });
}

export async function revoke(id: string): Promise<void> {
  const list = await load();
  await save(list.filter((p) => p.id !== id));
}

export async function clearOnce(): Promise<void> {
  const list = await load();
  await save(list.filter((p) => p.duration !== 'once'));
}

export async function clearAll(): Promise<void> {
  await save([]);
}

async function write(input: Omit<Permission, 'id' | 'createdAt'>): Promise<Permission> {
  const p: Permission = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    toolUseId: input.duration === 'once' ? input.toolUseId : undefined,
  };
  const list = await load();
  await save([...list, p]);
  return p;
}
