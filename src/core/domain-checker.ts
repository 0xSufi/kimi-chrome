// Domain category check + managed-policy blocklist.
//
// Categories come from claude.ai's domain_info endpoint when the
// user is logged in. Without an access token we skip the check,
// which means everything not on the managed blocklist is allowed.

import { StorageKey } from './protocol';
import { get as storageGet } from './storage';

const CACHE_TTL_MS = 5 * 60 * 1000;

export type DomainCategory =
  | 'category0' // allowed
  | 'category1' // blocked
  | 'category2' // restricted
  | 'category3' // very restricted
  | 'category_org_blocked';

const RANK: Record<DomainCategory, number> = {
  category0: 1,
  category3: 2,
  category2: 3,
  category_org_blocked: 3,
  category1: 4,
};

interface CacheEntry { category: DomainCategory; at: number }
const cache = new Map<string, CacheEntry>();

let blocklistPatterns: string[] | null = null;
let blocklistListenerInstalled = false;

function normalizeDomain(input: string): string {
  try {
    return new URL(input.includes('://') ? input : `https://${input}`).hostname.toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}

// ============================================================
// Managed blocklist
// ============================================================

async function ensureBlocklistLoaded(): Promise<string[]> {
  if (blocklistPatterns !== null) return blocklistPatterns;
  try {
    const r = await chrome.storage.managed.get('blockedUrlPatterns');
    blocklistPatterns = (r?.blockedUrlPatterns as string[] | undefined) ?? [];
  } catch {
    blocklistPatterns = [];
  }
  if (!blocklistListenerInstalled) {
    blocklistListenerInstalled = true;
    chrome.storage.managed.onChanged.addListener((changes) => {
      if (changes.blockedUrlPatterns) {
        blocklistPatterns = (changes.blockedUrlPatterns.newValue as string[] | undefined) ?? [];
      }
    });
  }
  return blocklistPatterns;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export async function isBlockedByManagedPolicy(url: string): Promise<boolean> {
  const patterns = await ensureBlocklistLoaded();
  if (patterns.length === 0) return false;
  for (const p of patterns) {
    try {
      if (globToRegex(p).test(url)) return true;
    } catch {}
  }
  return false;
}

// ============================================================
// Category fetch
// ============================================================

async function fetchCategory(domain: string): Promise<DomainCategory | undefined> {
  const accessToken = await storageGet<string>(StorageKey.ACCESS_TOKEN);
  if (!accessToken) return undefined;

  try {
    const resp = await fetch(
      `https://claude.ai/api/web/domain_info/browser_extension?domain=${encodeURIComponent(domain)}`,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
    );
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as { org_policy?: string; category?: DomainCategory };
    if (data.org_policy === 'block') return 'category_org_blocked';
    return data.category;
  } catch {
    return undefined;
  }
}

export async function getCategory(input: string): Promise<DomainCategory | undefined> {
  const url = input.includes('://') ? input : `https://${input}`;
  if (await isBlockedByManagedPolicy(url)) return 'category1';

  const domain = normalizeDomain(input);
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.category;

  const category = await fetchCategory(domain);
  if (category) cache.set(domain, { category, at: Date.now() });
  return category;
}

export function isBlockedCategory(c: DomainCategory | undefined): boolean {
  return c === 'category1' || c === 'category_org_blocked';
}

export function mostRestrictive(categories: (DomainCategory | undefined)[]): DomainCategory | undefined {
  let max = 0;
  let result: DomainCategory | undefined;
  for (const c of categories) {
    if (!c) continue;
    const r = RANK[c] ?? 0;
    if (r > max) { max = r; result = c; }
  }
  return result;
}

export function clearCache(): void {
  cache.clear();
}
