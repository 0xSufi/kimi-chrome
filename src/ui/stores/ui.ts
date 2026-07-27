import { create } from 'zustand';

export type BridgeStatus = 'disconnected' | 'connecting' | 'paired' | 'waiting';

interface UIStore {
  isConnected: boolean;
  hasNativeHost: boolean;
  bridgeStatus: BridgeStatus;
  setConnected: (v: boolean) => void;
  setHasNativeHost: (v: boolean) => void;
  setBridgeStatus: (s: BridgeStatus) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  isConnected: false,
  hasNativeHost: false,
  bridgeStatus: 'disconnected',
  setConnected: (isConnected) => set({ isConnected }),
  setHasNativeHost: (hasNativeHost) => set({ hasNativeHost }),
  setBridgeStatus: (bridgeStatus) => set({ bridgeStatus }),
}));
