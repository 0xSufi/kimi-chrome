// Domain category check + managed-policy blocklist.
//
// The remote category service (claude.ai domain_info in the original
// extension) has no Kimi counterpart, so only the managed blocklist
// applies: everything not on it is allowed.

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

// No remote category service in the Kimi port. Hook point if one
// ever exists again; returning undefined means "no category known",
// which the callers treat as allowed.
async function fetchCategory(_domain: string): Promise<DomainCategory | undefined> {
  return undefined;
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
