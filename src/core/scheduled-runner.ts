// Glue between chrome.alarms fires and the side panel.
//
// Two delivery paths so a scheduled prompt isn't dropped when the side
// panel is closed (the common case for "fire in 8 hours" tasks):
//
//   1. Direct broadcast — chrome.runtime.sendMessage. Wins when the
//      side panel is already open. No-ops cleanly when nothing listens.
//   2. Persistent queue + notification — the prompt is appended to a
//      bounded queue in chrome.storage.local, and a notification is
//      raised. Clicking the notification opens the side panel via
//      sidePanel.open() (notification clicks count as user gesture
//      under MV3); on mount the side panel drains the queue.
//
// Items expire after 24h so a long-stale prompt doesn't fire days later.

import type { ScheduledPrompt } from './scheduled-prompts';

const QUEUE_KEY = 'pendingScheduledPrompts';
const NOTIFICATION_PREFIX = 'dyspel-scheduled-';
const MAX_QUEUE = 20;
const TTL_MS = 24 * 60 * 60 * 1000;

interface QueueItem {
  id: string;            // notification id == prompt id at fire time
  promptId: string;      // ScheduledPrompt.id
  text: string;
  enqueuedAt: number;
  windowId?: number;
}

async function readQueue(): Promise<QueueItem[]> {
  const stored = await chrome.storage.local.get([QUEUE_KEY]);
  const list = (stored[QUEUE_KEY] as QueueItem[] | undefined) ?? [];
  const cutoff = Date.now() - TTL_MS;
  return list.filter((it) => it.enqueuedAt >= cutoff);
}

async function writeQueue(list: QueueItem[]): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_KEY]: list.slice(-MAX_QUEUE) });
}

export async function enqueueScheduledFire(prompt: ScheduledPrompt): Promise<void> {
  const text = prompt.prompt;
  if (!text) return;

  const item: QueueItem = {
    id: `${NOTIFICATION_PREFIX}${prompt.id}-${Date.now()}`,
    promptId: prompt.id,
    text,
    enqueuedAt: Date.now(),
  };

  const list = await readQueue();
  list.push(item);
  await writeQueue(list);

  // Fire-and-forget broadcast for the side-panel-open case.
  void chrome.runtime.sendMessage({
    type: 'EXECUTE_SCHEDULED_TASK',
    prompt,
    queueItemId: item.id,
  }).catch(() => {});

  // Notification fallback for the side-panel-closed case.
  if (chrome.notifications?.create) {
    try {
      await chrome.notifications.create(item.id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon-128.png'),
        title: 'Kimi scheduled task ready',
        message: truncate(text, 120),
        priority: 1,
      });
    } catch {}
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// Side-panel-open path: drain the queue once the panel responds.
export async function ackQueueItem(id: string): Promise<void> {
  const list = await readQueue();
  await writeQueue(list.filter((it) => it.id !== id));
  if (chrome.notifications?.clear) {
    try { await chrome.notifications.clear(id); } catch {}
  }
}

// Notification click → open side panel and let it drain on mount.
export async function handleNotificationClick(notificationId: string): Promise<void> {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  try { await chrome.notifications.clear(notificationId); } catch {}

  // Open the side panel in the focused window. We don't have a tab
  // context from the notification, so use the last focused window.
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win.id != null) await chrome.sidePanel.open({ windowId: win.id });
  } catch {}
}

// On side panel mount, return any queued items that haven't been acked
// yet so the panel can submit them. Used when the panel opens via a
// notification click.
export async function drainPending(): Promise<QueueItem[]> {
  const list = await readQueue();
  await writeQueue([]);
  return list;
}
