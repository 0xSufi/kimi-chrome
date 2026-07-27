// Typed wrappers around chrome.storage.local.
//
// Always cast keys to string at the call site so @types/chrome's
// literal-key generic doesn't reject our enum values.

import { StorageKey } from './protocol';

export async function get<T>(key: StorageKey): Promise<T | undefined> {
  const result = await chrome.storage.local.get([key as string]);
  return result[key] as T | undefined;
}

export async function set<T>(key: StorageKey, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function remove(...keys: StorageKey[]): Promise<void> {
  await chrome.storage.local.remove(keys.map((k) => k as string));
}

export async function getMany<T extends Partial<Record<StorageKey, unknown>>>(
  keys: StorageKey[],
): Promise<T> {
  const result = await chrome.storage.local.get(keys.map((k) => k as string));
  return result as T;
}
