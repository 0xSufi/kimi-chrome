// CRUD for recurring prompts, persisted to chrome.storage.local
// and scheduled via chrome.alarms. Service worker forwards
// chrome.alarms.onAlarm events back into runScheduledPrompt().

import { StorageKey } from './protocol';
import { get as storageGet, set as storageSet } from './storage';

export type RepeatType = 'none' | 'daily' | 'weekly' | 'monthly' | 'annually';

export interface ScheduledPrompt {
  id: string;
  prompt: string;
  command?: string;
  url?: string;
  enabled: boolean;
  skipPermissions?: boolean;
  model?: string;
  repeatType: RepeatType;
  scheduledTime?: string; // HH:mm
  scheduledDay?: number;  // 0-6 (weekly), 1-31 (monthly), 1-365 (annually-day-of-year if you prefer)
  scheduledMonth?: number; // 1-12 (annually)
  nextScheduledTime?: number; // unix ms
  createdAt: number;
  updatedAt: number;
}

const ALARM_PREFIX = 'prompt_';

// ============================================================
// CRUD
// ============================================================

export async function listPrompts(): Promise<ScheduledPrompt[]> {
  return (await storageGet<ScheduledPrompt[]>(StorageKey.SAVED_PROMPTS)) ?? [];
}

export async function getPrompt(id: string): Promise<ScheduledPrompt | undefined> {
  return (await listPrompts()).find((p) => p.id === id);
}

export async function createPrompt(
  data: Omit<ScheduledPrompt, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<ScheduledPrompt> {
  const prompt: ScheduledPrompt = {
    ...data,
    id: `${ALARM_PREFIX}${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const list = await listPrompts();
  await storageSet(StorageKey.SAVED_PROMPTS, [...list, prompt]);
  await syncAlarm(prompt);
  return prompt;
}

export async function updatePrompt(
  id: string,
  changes: Partial<ScheduledPrompt>,
): Promise<ScheduledPrompt | null> {
  const list = await listPrompts();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;

  const next: ScheduledPrompt = { ...list[idx], ...changes, updatedAt: Date.now() };
  list[idx] = next;
  await storageSet(StorageKey.SAVED_PROMPTS, list);
  await syncAlarm(next);
  return next;
}

export async function deletePrompt(id: string): Promise<boolean> {
  const list = await listPrompts();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  await storageSet(StorageKey.SAVED_PROMPTS, next);
  await chrome.alarms.clear(id);
  return true;
}

// ============================================================
// Alarm scheduling
// ============================================================

function nextRunAt(p: ScheduledPrompt, now = Date.now()): number | null {
  const [hh, mm] = (p.scheduledTime ?? '09:00').split(':').map(Number);

  switch (p.repeatType) {
    case 'daily': {
      const d = new Date(); d.setHours(hh, mm, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    case 'weekly': {
      const target = p.scheduledDay ?? 1;
      const d = new Date(); d.setHours(hh, mm, 0, 0);
      const diff = (target - d.getDay() + 7) % 7;
      if (diff === 0 && d.getTime() <= now) d.setDate(d.getDate() + 7);
      else d.setDate(d.getDate() + diff);
      return d.getTime();
    }
    case 'monthly': {
      const target = p.scheduledDay ?? 1;
      const d = new Date(); d.setHours(hh, mm, 0, 0); d.setDate(target);
      if (d.getTime() <= now) d.setMonth(d.getMonth() + 1);
      while (d.getDate() !== target) {
        d.setDate(0);
        d.setMonth(d.getMonth() + 1);
        d.setDate(target);
      }
      return d.getTime();
    }
    case 'annually': {
      const month = (p.scheduledMonth ?? 1) - 1;
      const day = p.scheduledDay ?? 1;
      const d = new Date(); d.setMonth(month, day); d.setHours(hh, mm, 0, 0);
      if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
      return d.getTime();
    }
    default:
      return null;
  }
}

export async function syncAlarm(p: ScheduledPrompt): Promise<void> {
  if (!p.enabled || p.repeatType === 'none') {
    await chrome.alarms.clear(p.id);
    return;
  }
  const at = nextRunAt(p);
  if (!at) {
    await chrome.alarms.clear(p.id);
    return;
  }
  const periodInMinutes =
    p.repeatType === 'daily' ? 24 * 60 :
    p.repeatType === 'weekly' ? 7 * 24 * 60 :
    undefined;
  await chrome.alarms.create(p.id, periodInMinutes ? { when: at, periodInMinutes } : { when: at });
}

export async function refreshAllNextRunTimes(): Promise<void> {
  const list = await listPrompts();
  let dirty = false;
  for (const p of list) {
    if (!p.enabled || p.repeatType === 'none') continue;
    const at = nextRunAt(p);
    if (at && p.nextScheduledTime !== at) {
      p.nextScheduledTime = at;
      p.updatedAt = Date.now();
      dirty = true;
    }
  }
  if (dirty) await storageSet(StorageKey.SAVED_PROMPTS, list);
}

export function isPromptAlarm(name: string): boolean {
  return name.startsWith(ALARM_PREFIX);
}
