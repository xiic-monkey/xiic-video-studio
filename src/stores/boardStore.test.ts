import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const saveBoard = vi.fn();
const loadBoard = vi.fn();

vi.mock('../services/tauri', () => ({
  saveBoard: (...args: unknown[]) => saveBoard(...args),
  loadBoard: (...args: unknown[]) => loadBoard(...args),
}));

import { useBoardStore } from './boardStore';
import type { BoardDoc, BoardNode } from '../domain/types';

function doc(revision?: number): BoardDoc {
  return {
    schemaVersion: 1,
    id: 'board_1',
    projectId: 'p1',
    name: '画布',
    nodes: {},
    edges: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...(revision === undefined ? {} : { revision }),
  };
}

const node: BoardNode = {
  id: 'node_1',
  type: 'text',
  typeVersion: 1,
  position: { x: 0, y: 0 },
  size: { width: 200, height: 120 },
  z: 1,
  data: {},
};

describe('boardStore 保存修订号', () => {
  beforeEach(() => {
    saveBoard.mockReset();
    loadBoard.mockReset();
    useBoardStore.getState().load(null);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('保存期间发生编辑时也把后端返回的新修订号写回', async () => {
    vi.useFakeTimers();
    const snapshot = doc(1);
    useBoardStore.setState({ board: snapshot, dirty: true, saving: false, revision: 1 });

    let release: (value: { revision: number }) => void = () => {};
    saveBoard.mockImplementation(() => new Promise<{ revision: number }>((resolve) => { release = resolve; }));

    const flushing = useBoardStore.getState().flush();
    // 保存还在路上时用户又改了一次画布。
    useBoardStore.setState({ board: { ...snapshot, name: '改名' }, dirty: true });
    release({ revision: 2 });
    await flushing;

    // 修订号属于服务端那一行：必须写回，否则下一次保存必然冲突。
    expect(useBoardStore.getState().board?.revision).toBe(2);
    expect(useBoardStore.getState().revision).toBe(2);
    expect(useBoardStore.getState().dirty).toBe(true);
  });

  it('保存期间发生编辑后，下一次保存用的是新修订号', async () => {
    vi.useFakeTimers();
    const snapshot = doc(1);
    useBoardStore.setState({ board: snapshot, dirty: true, saving: false, revision: 1 });

    let release: (value: { revision: number }) => void = () => {};
    saveBoard.mockImplementationOnce(() => new Promise<{ revision: number }>((resolve) => { release = resolve; }));
    saveBoard.mockImplementationOnce(async () => ({ revision: 3 }));

    const flushing = useBoardStore.getState().flush();
    useBoardStore.setState({ board: { ...snapshot, name: '改名' }, dirty: true });
    release({ revision: 2 });
    await flushing;

    await useBoardStore.getState().flush();
    expect(saveBoard).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2 }), 2);
    expect(useBoardStore.getState().board?.revision).toBe(3);
    expect(useBoardStore.getState().dirty).toBe(false);
  });

  it('没有发生编辑时正常写入修订号并清掉 dirty', async () => {
    const snapshot = doc(1);
    useBoardStore.setState({ board: snapshot, dirty: true, saving: false, revision: 1 });
    saveBoard.mockResolvedValue({ revision: 2 });

    await useBoardStore.getState().flush();

    expect(useBoardStore.getState().board?.revision).toBe(2);
    expect(useBoardStore.getState().dirty).toBe(false);
  });

  /**
   * 修订号是服务端的 CAS 令牌，不属于画布内容。
   * 撤销/重做会把旧快照整个换回来，若把快照里的 revision 一起带回来，
   * 下一次保存就会用旧修订号比对，必然撞 PRODUCTION_REVISION_CONFLICT，
   * 而且每撤销一次就再旧一点，永远自愈不了。
   */
  it('撤销后保存仍然使用服务端最新修订号', async () => {
    vi.useFakeTimers();
    saveBoard.mockResolvedValue({ revision: 6 });
    useBoardStore.getState().load(doc(5));
    useBoardStore.getState().apply({ type: 'addNode', node });

    await useBoardStore.getState().flush();
    expect(saveBoard).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'board_1' }), 5);
    expect(useBoardStore.getState().revision).toBe(6);

    useBoardStore.getState().undo();
    // 内容回到旧快照，但修订号必须停在服务端最新的那个。
    expect(useBoardStore.getState().board?.revision).toBe(6);

    await useBoardStore.getState().flush();
    expect(saveBoard).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'board_1' }), 6);
  });

  it('重做后保存同样使用服务端最新修订号', async () => {
    vi.useFakeTimers();
    saveBoard.mockResolvedValue({ revision: 6 });
    useBoardStore.getState().load(doc(5));
    useBoardStore.getState().apply({ type: 'addNode', node });
    await useBoardStore.getState().flush();

    useBoardStore.getState().undo();
    useBoardStore.getState().redo();
    expect(useBoardStore.getState().revision).toBe(6);

    await useBoardStore.getState().flush();
    expect(saveBoard).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'board_1' }), 6);
  });

  it('修订冲突后重试会取最新修订号重新落库', async () => {
    saveBoard
      .mockRejectedValueOnce(new Error('PRODUCTION_REVISION_CONFLICT'))
      .mockResolvedValueOnce({ revision: 20 });
    loadBoard.mockResolvedValue(doc(19));
    useBoardStore.getState().load(doc(5));
    useBoardStore.getState().apply({ type: 'addNode', node });

    await useBoardStore.getState().retrySave();

    expect(loadBoard).toHaveBeenCalledWith('board_1');
    // 重试要带服务端最新的修订号，本地内容原样保留。
    expect(saveBoard).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'board_1' }), 19);
    expect(useBoardStore.getState().saveError).toBeUndefined();
    expect(useBoardStore.getState().revision).toBe(20);
  });
});
