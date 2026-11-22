import { create } from 'zustand';
import type { BoardDoc } from '../domain/types';
import { applyGraphCommand, type GraphCommand } from '../domain/graph/commands';
import { saveBoard } from '../services/tauri';

const HISTORY_LIMIT = 60;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let gestureSnapshot: BoardDoc | null = null;

function scheduleSave(get: () => BoardState): void {
  if (typeof window === 'undefined') return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void get().flush(); }, 700);
}

function pushPast(past: BoardDoc[], snapshot: BoardDoc): BoardDoc[] {
  return [...past, snapshot].slice(-HISTORY_LIMIT);
}

interface BoardState {
  board: BoardDoc | null;
  past: BoardDoc[];
  future: BoardDoc[];
  selectedNodeId?: string;
  selectedNodeIds: string[];
  dirty: boolean;
  saving: boolean;
  saveError?: string;
  lastSavedAt?: string;
  notice?: string;
  load(board: BoardDoc | null): void;
  apply(command: GraphCommand, options?: { history?: boolean }): void;
  applyMany(commands: GraphCommand[], options?: { history?: boolean }): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  select(nodeId?: string): void;
  selectMany(nodeIds: string[]): void;
  notify(message?: string): void;
  flush(): Promise<void>;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  board: null,
  past: [],
  future: [],
  selectedNodeIds: [],
  dirty: false,
  saving: false,

  load(board) {
    if (saveTimer) clearTimeout(saveTimer);
    gestureSnapshot = null;
    set({
      board,
      past: [],
      future: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
      dirty: false,
      saving: false,
      saveError: undefined,
      lastSavedAt: board ? new Date().toISOString() : undefined,
      notice: undefined,
    });
  },

  apply(command, options) {
    const state = get();
    if (!state.board) return;
    const history = options?.history !== false && gestureSnapshot === null;
    const next = applyGraphCommand(state.board, command);
    const past = history ? pushPast(state.past, state.board) : state.past;
    set({
      board: next,
      past,
      future: history ? [] : state.future,
      dirty: true,
      notice: undefined,
    });
    scheduleSave(get);
  },

  applyMany(commands, options) {
    const state = get();
    if (!state.board) return;
    const history = options?.history !== false && gestureSnapshot === null;
    const past = history ? pushPast(state.past, state.board) : state.past;
    let next = state.board;
    for (const command of commands) next = applyGraphCommand(next, command);
    set({
      board: next,
      past,
      future: history ? [] : state.future,
      dirty: true,
      notice: undefined,
    });
    scheduleSave(get);
  },

  beginGesture() {
    if (gestureSnapshot || !get().board) return;
    gestureSnapshot = get().board;
  },

  endGesture() {
    const snapshot = gestureSnapshot;
    gestureSnapshot = null;
    if (!snapshot || snapshot === get().board) return;
    set({ past: pushPast(get().past, snapshot), future: [] });
    scheduleSave(get);
  },

  undo() {
    const state = get();
    if (!state.board || !state.past.length) return;
    const previous = state.past[state.past.length - 1];
    set({
      board: previous,
      past: state.past.slice(0, -1),
      future: [state.board, ...state.future].slice(0, HISTORY_LIMIT),
      dirty: true,
      notice: undefined,
    });
    scheduleSave(get);
  },

  redo() {
    const state = get();
    if (!state.board || !state.future.length) return;
    const next = state.future[0];
    set({
      board: next,
      past: pushPast(state.past, state.board),
      future: state.future.slice(1),
      dirty: true,
      notice: undefined,
    });
    scheduleSave(get);
  },

  select(nodeId) {
    set({ selectedNodeId: nodeId, selectedNodeIds: nodeId ? [nodeId] : [] });
  },

  selectMany(nodeIds) {
    set({
      selectedNodeIds: nodeIds,
      selectedNodeId: nodeIds.length === 1 ? nodeIds[0] : undefined,
    });
  },

  notify(message) {
    set({ notice: message });
  },

  async flush() {
    const snapshot = get().board;
    if (!snapshot || !get().dirty || get().saving) return;
    set({ saving: true, saveError: undefined });
    try {
      const result = await saveBoard(snapshot);
      const stillCurrent = get().board === snapshot;
      const current = get().board;
      // revision 属于服务端那一行，不属于这次快照：即使保存期间又发生了编辑，
      // 也必须把后端返回的新修订号写回，否则本地永远拿着旧修订号，
      // 下一次保存必然撞上 PRODUCTION_REVISION_CONFLICT 且无法自愈。
      const sameBoard = current && current.id === snapshot.id;
      set({
        board: sameBoard && result.revision ? { ...current, revision: result.revision } : current,
        saving: false,
        dirty: stillCurrent ? false : get().dirty,
        lastSavedAt: new Date().toISOString(),
      });
      if (!stillCurrent) scheduleSave(get);
    } catch (error) {
      set({ saving: false, saveError: error instanceof Error ? error.message : String(error) });
    }
  },
}));
