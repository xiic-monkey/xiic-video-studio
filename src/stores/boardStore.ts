import { create } from 'zustand';
import type { BoardDoc } from '../domain/types';
import { applyGraphCommand, type GraphCommand } from '../domain/graph/commands';
import { describeSaveError } from '../domain/saveError';
import { saveBoard, loadBoard } from '../services/tauri';
import { pushToast } from '../ui/toast';

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
  /**
   * 服务端那一行的修订号（CAS 令牌）。
   *
   * 它不属于画布内容：撤销/重做会把旧快照整个换回来，
   * 快照里的 revision 是当时的值，拿它保存必然撞 PRODUCTION_REVISION_CONFLICT。
   * 所以修订号单独存在 store 里，只随服务端返回值前进。
   */
  revision?: number;
  past: BoardDoc[];
  future: BoardDoc[];
  selectedNodeId?: string;
  selectedNodeIds: string[];
  dirty: boolean;
  saving: boolean;
  saveError?: string;
  lastSavedAt?: string;
  notice?: string;
  /** 画布底部提示的语气：默认按错误（红）显示，成功的事显式传 'success'。 */
  noticeTone?: 'error' | 'success';
  load(board: BoardDoc | null): void;
  apply(command: GraphCommand, options?: { history?: boolean }): void;
  applyMany(commands: GraphCommand[], options?: { history?: boolean }): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  select(nodeId?: string): void;
  selectMany(nodeIds: string[]): void;
  notify(message?: string, tone?: 'error' | 'success'): void;
  flush(): Promise<void>;
  /** 保存失败后重试：把 dirty 复位并重新走一次落库。 */
  retrySave(): Promise<void>;
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
      revision: board?.revision,
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
    // 内容回到旧快照，但修订号保持服务端最新值：它是 CAS 令牌，不随内容回退。
    set({
      board: { ...previous, revision: state.revision },
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
      board: { ...next, revision: state.revision },
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

  notify(message, tone: 'error' | 'success' = 'error') {
    set({ notice: message, noticeTone: message ? tone : undefined });
  },

  async flush() {
    const snapshot = get().board;
    if (!snapshot || !get().dirty || get().saving) return;
    set({ saving: true, saveError: undefined });
    try {
      // 条件用 store 里单独记的修订号，不用文档里的那份：
      // 文档里的 revision 可能来自撤销快照，会比服务端旧。
      const result = await saveBoard(snapshot, get().revision ?? null);
      const stillCurrent = get().board === snapshot;
      const current = get().board;
      // revision 属于服务端那一行，不属于这次快照：即使保存期间又发生了编辑，
      // 也必须把后端返回的新修订号写回，否则本地永远拿着旧修订号，
      // 下一次保存必然撞上 PRODUCTION_REVISION_CONFLICT 且无法自愈。
      const sameBoard = current && current.id === snapshot.id;
      set({
        board: sameBoard && result.revision ? { ...current, revision: result.revision } : current,
        revision: result.revision ?? get().revision,
        saving: false,
        dirty: stillCurrent ? false : get().dirty,
        lastSavedAt: new Date().toISOString(),
      });
      if (!stillCurrent) scheduleSave(get);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ saving: false, saveError: message });
      // 失败详情走右下角悬浮提示：顶栏只留「有未保存改动」这种状态，
      // 错误原文常驻在顶栏既占位置又抢注意力。
      pushToast({
        title: '保存失败',
        detail: describeSaveError(message, '画布', '点「重试保存」可以重新落库。'),
        tone: 'error',
        action: { label: '重试保存', onClick: () => { void useBoardStore.getState().retrySave(); } },
      });
    }
  },

  async retrySave() {
    // 失败后 dirty 仍为 true，flush 会直接返回，所以先强制标记一次待保存。
    set({ saveError: undefined, dirty: true });
    await get().flush();
    if (!get().saveError) return;
    const message = get().saveError ?? '';
    if (!message.includes('REVISION_CONFLICT')) return;
    // 修订冲突：本地修订号过期了。重新从服务端取一份画布，
    // 用它的最新修订号重新落库本地内容——本地内容才是用户真正要保存的东西。
    const snapshot = get().board;
    if (!snapshot) return;
    try {
      const fresh = await loadBoard(snapshot.id);
      if (!fresh) {
        set({ saveError: '画布已不存在，无法保存' });
        return;
      }
      set({
        board: { ...snapshot, revision: fresh.revision },
        revision: fresh.revision,
        dirty: true,
        saveError: undefined,
      });
      await get().flush();
    } catch (error) {
      set({ saveError: error instanceof Error ? error.message : String(error) });
    }
  },
}));
