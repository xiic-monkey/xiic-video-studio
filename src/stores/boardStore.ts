import { create } from 'zustand';
import type { BoardDoc } from '../domain/types';
import { saveBoard } from '../services/tauri';

interface BoardState {
  board: BoardDoc | null;
  dirty: boolean;
  saving: boolean;
  saveError?: string;
  lastSavedAt?: string;
  load(board: BoardDoc | null): void;
  markDirty(): void;
  flush(): Promise<void>;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  board: null,
  dirty: false,
  saving: false,

  load(board) {
    set({ board, dirty: false, saveError: undefined, lastSavedAt: board ? new Date().toISOString() : undefined });
  },

  markDirty() {
    set({ dirty: true });
  },

  async flush() {
    const board = get().board;
    if (!board || !get().dirty || get().saving) return;
    set({ saving: true, saveError: undefined });
    try {
      await saveBoard(board);
      set({ saving: false, dirty: false, lastSavedAt: new Date().toISOString() });
    } catch (error) {
      set({ saving: false, saveError: error instanceof Error ? error.message : String(error) });
    }
  },
}));
