import { create } from 'zustand';

export type PermissionAction = 'allow' | 'deny';
export type PermissionDuration = 'once' | 'always';

export interface PermissionDecision {
  action: PermissionAction;
  duration: PermissionDuration;
}

export interface PermissionRequest {
  requestId: string;
  netloc: string;
  tool: string;
  toolUseId?: string;
  resolve: (decision: PermissionDecision) => void;
}

interface PermissionStore {
  pending: PermissionRequest | null;
  open: (req: PermissionRequest) => void;
  resolve: (decision: PermissionDecision) => void;
}

export const usePermissionStore = create<PermissionStore>((set, get) => ({
  pending: null,
  open: (req) => {
    const { pending } = get();
    if (pending) {
      // Side panel is showing a different request — auto-deny the new one
      // so cc-wasm gets a prompt response instead of hanging forever.
      req.resolve({ action: 'deny', duration: 'once' });
      return;
    }
    set({ pending: req });
  },
  resolve: (decision) => {
    const { pending } = get();
    if (!pending) return;
    pending.resolve(decision);
    set({ pending: null });
  },
}));
