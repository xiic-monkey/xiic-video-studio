import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  convertFileSrc: (path: string) => `file://${path}`,
}));

import { makeDoc, edge, node } from '../domain/graph/testFixtures';
import { TEST_KEYS, TEST_PROFILES, assetRef, succeededRun, testProject } from '../domain/run/runFixtures';
import type { BoardDoc, RunRecord } from '../domain/types';
import { useBoardStore } from '../stores/boardStore';
import { useProviderStore } from '../stores/providerStore';
import { useRunStore } from '../stores/runStore';
import { useStudioStore } from '../stores/studioStore';
import { useRunController } from './controller';

interface StartRunPayload {
  schemaVersion: number;
  projectId: string;
  boardId: string;
  nodeId: string;
  providerId: string;
  model: string;
  cacheKey: string;
  cachedAssetId?: string;
  promptSnapshot: RunRecord['promptSnapshot'];
  params: Record<string, unknown>;
  inputAssetIds: string[];
}

let dbRuns: RunRecord[] = [];

function enableTauri() {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
}

function startCalls(): Array<[string, { request: StartRunPayload }]> {
  return invoke.mock.calls.filter((call) => call[0] === 'start_run') as Array<[string, { request: StartRunPayload }]>;
}

function loadBoard(doc: BoardDoc) {
  useBoardStore.getState().load(doc);
}

beforeEach(() => {
  invoke.mockReset();
  dbRuns = [];
  enableTauri();
  invoke.mockImplementation(async (cmd: string, args?: { request: StartRunPayload; assetId?: string }) => {
    if (cmd === 'list_runs') return dbRuns;
    if (cmd === 'read_asset_text') {
      if (args?.assetId === 'asset_missing') throw new Error('资产文件缺失');
      return '上游文本';
    }
    if (cmd === 'start_run') {
      const request = args!.request;
      const run: RunRecord = {
        id: `run_${dbRuns.length + 1}`,
        projectId: request.projectId,
        boardId: request.boardId,
        nodeId: request.nodeId,
        action: 'generate',
        cacheKey: request.cacheKey,
        status: request.cachedAssetId ? 'succeeded' : 'queued',
        providerId: request.providerId,
        model: request.model,
        promptSnapshot: request.promptSnapshot,
        params: request.params,
        inputAssetIds: request.inputAssetIds,
        outputAssetIds: request.cachedAssetId ? [request.cachedAssetId] : [],
        selectedAssetId: request.cachedAssetId,
        cost: request.cachedAssetId ? { estimated: { amount: 0, currency: '', unit: '缓存命中' } } : undefined,
        startedAt: '2026-10-31T00:00:00.000Z',
      };
      dbRuns.push(run);
      return run;
    }
    return undefined;
  });

  useStudioStore.setState({ projects: [testProject], currentProjectId: testProject.id });
  useProviderStore.setState({ profiles: TEST_PROFILES, hasKeys: TEST_KEYS, loaded: true, assetHost: undefined });
  useRunStore.setState({ runs: {}, latestByNode: {}, assets: {}, boardId: undefined, loading: false, error: undefined });
  useRunController.setState({ busy: {}, pending: undefined });
});

describe('run controller', () => {
  it('blocks an empty prompt before any money is spent', async () => {
    loadBoard(makeDoc([node('i', 'image', { prompt: '' })], []));

    await useRunController.getState().requestRun('i');

    expect(useBoardStore.getState().notice).toBe('提示词为空，请填写或连接上游文本节点');
    expect(useRunController.getState().pending).toBeUndefined();
    expect(startCalls()).toHaveLength(0);
  });

  it('opens the cost confirmation and writes no run record when the user cancels', async () => {
    loadBoard(makeDoc([node('i', 'image', { prompt: '海报' })], []));

    await useRunController.getState().requestRun('i');
    const pending = useRunController.getState().pending;

    expect(pending?.label.nodeTitle).toBe('图片');
    expect(pending?.cost).toEqual({ amount: 0.08, currency: 'CNY', unit: '张', breakdown: { count: 2 } });
    expect(pending?.inputCount).toBe(0);

    useRunController.getState().dismissRun();

    expect(useRunController.getState().pending).toBeUndefined();
    expect(startCalls()).toHaveLength(0);
    expect(Object.keys(useRunStore.getState().runs)).toHaveLength(0);
  });

  it('sends the confirmed request to Rust and records the run', async () => {
    loadBoard(makeDoc([node('i', 'image', { prompt: '海报' })], []));

    await useRunController.getState().requestRun('i');
    await useRunController.getState().confirmRun();

    const [call] = startCalls();
    expect(call[1].request.schemaVersion).toBe(1);
    // 自动路由：providerId 留空，后端按候选顺序回退。
    expect(call[1].request.providerId).toBe('');
    expect(call[1].request.model).toBe('gpt-image-1');
    expect(call[1].request.cachedAssetId).toBeUndefined();
    expect(useRunController.getState().pending).toBeUndefined();
    expect(useRunStore.getState().latestByNode.i).toBe('run_1');
    expect(useRunStore.getState().runs.run_1.status).toBe('queued');
  });

  it('reuses the cached asset without a confirmation dialog and without cost', async () => {
    loadBoard(makeDoc([node('i', 'image', { prompt: '海报' })], []));

    await useRunController.getState().requestRun('i');
    const cacheKey = useRunController.getState().pending!.request.cacheKey;
    useRunController.getState().dismissRun();

    const previous = succeededRun('i', 'asset_out', cacheKey);
    dbRuns = [previous];
    useRunStore.setState({
      runs: { [previous.id]: previous },
      latestByNode: { i: previous.id },
      assets: { asset_out: assetRef('asset_out', 'image', 'image/png') },
    });

    await useRunController.getState().requestRun('i');

    expect(useRunController.getState().pending).toBeUndefined();
    expect(useBoardStore.getState().notice).toBe('缓存命中，未产生费用');
    const [call] = startCalls();
    expect(call[1].request.cachedAssetId).toBe('asset_out');
    const cached = dbRuns[dbRuns.length - 1];
    expect(cached.status).toBe('succeeded');
    expect(cached.cost?.estimated?.amount).toBe(0);
  });

  it('cancels the active run and refuses to cancel a finished one', async () => {
    const active = { ...succeededRun('i', 'asset_out'), id: 'run_active', status: 'running' as const };
    useRunStore.setState({ runs: { run_active: active }, latestByNode: { i: 'run_active' } });

    await useRunController.getState().cancelRun('i');
    expect(invoke).toHaveBeenCalledWith('cancel_run', { runId: 'run_active' });

    const finished = { ...succeededRun('i', 'asset_out'), id: 'run_done', status: 'succeeded' as const };
    useRunStore.setState({ runs: { run_done: finished }, latestByNode: { i: 'run_done' } });

    await useRunController.getState().cancelRun('i');
    expect(invoke.mock.calls.filter((call) => call[0] === 'cancel_run')).toHaveLength(1);
    expect(useBoardStore.getState().notice).toBe('该运行已经结束，无需取消');
  });

  it('never rolls a finished run back to a running state', async () => {
    const done = succeededRun('i', 'asset_out');
    useRunStore.getState().upsertRun(done);
    useRunStore.getState().upsertRun({ ...done, status: 'running' });

    expect(useRunStore.getState().runs[done.id].status).toBe('succeeded');
  });

  it('blocks the run and logs a warning when an upstream text cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const upstream = succeededRun('t', 'asset_missing');
    useRunStore.setState({
      runs: { [upstream.id]: upstream },
      latestByNode: { t: upstream.id },
      assets: { asset_missing: assetRef('asset_missing', 'text', 'text/plain') },
    });
    loadBoard(makeDoc(
      [node('t', 'text', { prompt: '上游' }), node('i', 'image', { prompt: '海报' })],
      [edge('e1', 't', 'i', 'text', 'prompt', 'prompt')],
    ));

    await useRunController.getState().requestRun('i');

    expect(useBoardStore.getState().notice).toBe('上游「文本 / LLM」的文本读取失败或为空，请先重新运行该上游节点');
    expect(useRunController.getState().pending).toBeUndefined();
    expect(startCalls()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('blocks the run when an upstream node has no usable output yet', async () => {
    loadBoard(makeDoc(
      [node('t', 'text', { prompt: '上游' }), node('i', 'image', { prompt: '海报' })],
      [edge('e1', 't', 'i', 'text', 'prompt', 'prompt')],
    ));

    await useRunController.getState().requestRun('i');

    expect(useBoardStore.getState().notice).toBe('上游「文本 / LLM」还没有可用结果，请先运行该上游节点');
    expect(useRunController.getState().pending).toBeUndefined();
    expect(startCalls()).toHaveLength(0);
  });

  it('drops the pending run when the board changed before confirming', async () => {
    loadBoard(makeDoc([node('i', 'image', { prompt: '海报' })], []));

    await useRunController.getState().requestRun('i');
    expect(useRunController.getState().pending).toBeDefined();

    loadBoard({ ...makeDoc([node('j', 'image', { prompt: '另一张' })], []), id: 'board_other' });
    await useRunController.getState().confirmRun();

    expect(startCalls()).toHaveLength(0);
    expect(useRunController.getState().pending).toBeUndefined();
    expect(useBoardStore.getState().notice).toBe('画布已切换，本次运行已取消');
    expect(Object.keys(useRunStore.getState().runs)).toHaveLength(0);
  });

  it('ignores another run request while a confirmation is pending', async () => {
    loadBoard(makeDoc(
      [node('i', 'image', { prompt: '海报' }), node('j', 'image', { prompt: '另一张' })],
      [],
    ));

    await useRunController.getState().requestRun('i');
    const pending = useRunController.getState().pending;

    await useRunController.getState().requestRun('j');

    expect(useRunController.getState().pending).toBe(pending);
    expect(pending?.nodeId).toBe('i');
    expect(startCalls()).toHaveLength(0);
  });
});
