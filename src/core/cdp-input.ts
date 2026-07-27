// CDP-driven mouse / keyboard / scroll.

import { sendCommand } from './cdp';

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const SPECIAL_KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

for (let i = 1; i <= 12; i++) {
  SPECIAL_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  win: 4,
  shift: 8,
};

export function parseModifiers(modStr?: string): number {
  if (!modStr) return 0;
  let bits = 0;
  for (const part of modStr.toLowerCase().split('+')) {
    const m = MODIFIER_BITS[part.trim()];
    if (m) bits |= m;
  }
  return bits;
}

function keyDef(input: string): KeyDef {
  const lower = input.toLowerCase();
  if (SPECIAL_KEYS[lower]) return SPECIAL_KEYS[lower];

  if (input.length === 1) {
    const upper = input.toUpperCase();
    return { key: input, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: input };
  }

  return { key: input, code: input, keyCode: 0 };
}

// ============================================================
// Mouse
// ============================================================

export interface MouseParams {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle' | 'none';
  clickCount?: number;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
}

export function dispatchMouseEvent(tabId: number, params: MouseParams): Promise<unknown> {
  return sendCommand(tabId, 'Input.dispatchMouseEvent', params as unknown as Record<string, unknown>);
}

export async function click(
  tabId: number,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
  clickCount = 1,
  modifiers = 0,
): Promise<void> {
  await dispatchMouseEvent(tabId, { type: 'mouseMoved', x, y, modifiers });
  for (let i = 1; i <= clickCount; i++) {
    if (i > 1) await sleep(100);
    await dispatchMouseEvent(tabId, { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
    await sleep(12);
    await dispatchMouseEvent(tabId, { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
  }
}

export async function scrollWheel(
  tabId: number,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await dispatchMouseEvent(tabId, { type: 'mouseWheel', x, y, deltaX, deltaY });
}

// ============================================================
// Keyboard
// ============================================================

export async function insertText(tabId: number, text: string): Promise<void> {
  await sendCommand(tabId, 'Input.insertText', { text });
}

export async function typeText(tabId: number, text: string): Promise<void> {
  for (const ch of text) {
    if (ch === '\n') await pressKey(tabId, 'Enter');
    else await insertText(tabId, ch);
  }
}

export async function keyDown(tabId: number, key: string, modifiers = 0): Promise<void> {
  const def = keyDef(key);
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: def.key,
    code: def.code,
    keyCode: def.keyCode,
    windowsVirtualKeyCode: def.keyCode,
    text: def.text,
    modifiers,
  });
}

export async function keyUp(tabId: number, key: string, modifiers = 0): Promise<void> {
  const def = keyDef(key);
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: def.key,
    code: def.code,
    keyCode: def.keyCode,
    windowsVirtualKeyCode: def.keyCode,
    modifiers,
  });
}

export async function pressKey(tabId: number, key: string, modifiers = 0): Promise<void> {
  await keyDown(tabId, key, modifiers);
  await keyUp(tabId, key, modifiers);
}

export async function pressKeyChord(tabId: number, chord: string): Promise<void> {
  const parts = chord.toLowerCase().split('+').map((s) => s.trim());
  let mods = 0;
  const keys: string[] = [];
  for (const p of parts) {
    if (MODIFIER_BITS[p] != null) mods |= MODIFIER_BITS[p];
    else keys.push(p);
  }

  // Press modifiers in a deterministic order.
  if (mods & 2) await keyDown(tabId, 'Control', mods);
  if (mods & 1) await keyDown(tabId, 'Alt', mods);
  if (mods & 8) await keyDown(tabId, 'Shift', mods);
  if (mods & 4) await keyDown(tabId, 'Meta', mods);

  for (const k of keys) await pressKey(tabId, k, mods);

  if (mods & 4) await keyUp(tabId, 'Meta');
  if (mods & 8) await keyUp(tabId, 'Shift');
  if (mods & 1) await keyUp(tabId, 'Alt');
  if (mods & 2) await keyUp(tabId, 'Control');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
