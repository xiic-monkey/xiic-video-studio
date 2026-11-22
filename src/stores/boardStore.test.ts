import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const saveBoard = vi.fn();

vi.mock('../services/tauri', () => ({
  saveBoard: (...args: unknown[]) => saveBoard(...args),
}));

import { useBoardStore } from './boardStore';
import type { BoardDoc } from '../domain/types';

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

describe('boardStore 保存修订号', () => {
  beforeEach(() => {
    saveBoard.mockReset();
    useBoardStore.getState().load(null);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('保存期间发生编辑时也把后端返回的新修订号写回', async () => {
    vi.useFakeTimers();
    const snapshot = doc(1);
    useBoardStore.setState({ board: snapshot, dirty: true, saving: false });

    let release: (value: { revision: number }) => void = () => {};
    saveBoard.mockImplementation(() => new Promise<{ revision: number }>((resolve) => { release = resolve; }));

    const flushing = useBoardStore.getState().flush();
    // 保存还在路上时用户又改了一次画布。
    useBoardStore.setState({ board: { ...snapshot, name: '改名' }, dirty: true });
    release({ revision: 2 });
    await flushing;

    // 修订号属于服务端那一行：必须写回，否则下一次保存必然冲突。
    expect(useBoardStore.getState().board?.revision).toBe(2);
    expect(useBoardStore.getState().dirty).toBe(true);
  });

  it('保存期间发生编辑后，下一次保存用的是新修订号', async () => {
    vi.useFakeTimers();
    const snapshot = doc(1);
    useBoardStore.setState({ board: snapshot, dirty: true, saving: false });

    let release: (value: { revision: number }) => void = () => {};
    saveBoard.mockImplementationOnce(() => new Promise<{ revision: number }>((resolve) => { release = resolve; }));
    saveBoard.mockImplementationOnce(async () => ({ revision: 3 }));

    const flushing = useBoardStore.getState().flush();
    useBoardStore.setState({ board: { ...snapshot, name: '改名' }, dirty: true });
    release({ revision: 2 });
    await flushing;

    await useBoardStore.getState().flush();
    expect(saveBoard).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2 }));
    expect(useBoardStore.getState().board?.revision).toBe(3);
    expect(useBoardStore.getState().dirty).toBe(false);
  });

  it('没有发生编辑时正常写入修订号并清掉 dirty', async () => {
    const snapshot = doc(1);
    useBoardStore.setState({ board: snapshot, dirty: true, saving: false });
    saveBoard.mockResolvedValue({ revision: 2 });

    await useBoardStore.getState().flush();

    expect(useBoardStore.getState().board?.revision).toBe(2);
    expect(useBoardStore.getState().dirty).toBe(false);
  });
});
