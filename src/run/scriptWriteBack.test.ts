import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  convertFileSrc: (path: string) => `file://${path}`,
}));

import { makeDoc, node } from '../domain/graph/testFixtures';
import type { RunRecord } from '../domain/types';
import { useBoardStore } from '../stores/boardStore';
import { applyScriptOutput } from './scriptWriteBack';

function run(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_1', projectId: 'project_test', boardId: 'board_test', nodeId: 's',
    action: 'generate', cacheKey: 'k', status: 'succeeded',
    promptSnapshot: { text: '', segments: [], hash: 'h', locked: false },
    params: {}, inputAssetIds: [], outputAssetIds: ['asset_script'], selectedAssetId: 'asset_script',
    startedAt: '2026-11-25T00:00:00.000Z', ...partial,
  };
}

beforeEach(() => {
  invoke.mockReset();
  (globalThis as unknown as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'read_project_asset_text') return '{"script": "第一幕：雨夜", "beats": ["告别"]}';
    return undefined;
  });
  useBoardStore.getState().load(makeDoc([node('s', 'script', { title: '雨夜' })], []));
});

describe('applyScriptOutput', () => {
  function scriptData(): Record<string, unknown> {
    return useBoardStore.getState().board?.nodes.s.data ?? {};
  }

  it('writes the generated script and beats back into the node', async () => {
    await applyScriptOutput(run());
    const data = scriptData();
    expect(data.body).toBe('第一幕：雨夜');
    expect(data.beats).toBe('1. 告别');
  });

  it('falls back to plain text when the model ignores the json contract', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_project_asset_text') return '抱歉，我无法完成。';
      return undefined;
    });
    await applyScriptOutput(run());
    const data = scriptData();
    // 兜底成正文（用户可以在 Inspector 里改），但不猜节拍。
    expect(data.body).toBe('抱歉，我无法完成。');
    expect(data.beats).toBe('');
  });

  it('ignores runs of other boards and failed runs', async () => {
    await applyScriptOutput(run({ boardId: 'other_board' }));
    await applyScriptOutput(run({ status: 'failed' }));
    expect(scriptData().body).toBe('');
  });
});
