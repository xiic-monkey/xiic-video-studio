import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../domain/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  convertFileSrc: (path: string) => `file://${path}`,
}));

import { assetUrl, listBoards, listRuns, saveAssetHost, startRun } from './tauri';

function enableTauri() {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
}

describe('tauri bridge', () => {
  beforeEach(() => {
    invoke.mockReset();
    enableTauri();
  });

  it('passes camelCase arguments that the Rust command expects', async () => {
    invoke.mockResolvedValue([]);
    await listBoards('project_1');
    expect(invoke).toHaveBeenCalledWith('list_boards', { projectId: 'project_1' });

    await listRuns('board_1');
    expect(invoke).toHaveBeenCalledWith('list_runs', { boardId: 'board_1' });
  });

  it('keeps the run payload contract camelCase', async () => {
    invoke.mockResolvedValue({ id: 'run_1' });
    const run: RunRecord = {
      id: 'run_1',
      projectId: 'project_1',
      boardId: 'board_1',
      nodeId: 'node_1',
      action: 'generate',
      cacheKey: 'k',
      status: 'queued',
      promptSnapshot: { text: 'hi', segments: [], hash: 'h', locked: false },
      params: {},
      inputAssetIds: [],
      outputAssetIds: [],
      startedAt: '2026-10-31T00:00:00.000Z',
    };
    expect(Object.keys(run)).toContain('cacheKey');
    expect(run.promptSnapshot.hash).toBe('h');

    await startRun({
      schemaVersion: 1,
      projectId: run.projectId,
      boardId: run.boardId,
      nodeId: run.nodeId,
      capability: 'image.generate',
      providerId: 'provider_1',
      model: 'gpt-image-1',
      promptSnapshot: run.promptSnapshot,
      params: {},
      inputs: [],
      inputAssetIds: [],
      cacheKey: run.cacheKey,
    });

    expect(invoke).toHaveBeenCalledWith('start_run', expect.objectContaining({ request: expect.anything() }));
    const request = invoke.mock.calls[0][1].request as Record<string, unknown>;
    expect(Object.keys(request)).toEqual(
      expect.arrayContaining(['schemaVersion', 'projectId', 'boardId', 'nodeId', 'cacheKey']),
    );
  });

  it('builds an asset url from the resolved file path', async () => {
    invoke.mockResolvedValue('/tmp/assets/a.png');
    await expect(assetUrl('asset_1')).resolves.toBe('file:///tmp/assets/a.png');
    expect(invoke).toHaveBeenCalledWith('asset_file_path', { assetId: 'asset_1' });
  });

  it('keeps the asset host payload contract', async () => {
    invoke.mockResolvedValue(undefined);
    await saveAssetHost({
      schemaVersion: 1,
      strategy: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'frameforge',
    });
    expect(invoke).toHaveBeenCalledWith('save_asset_host', {
      config: expect.objectContaining({ schemaVersion: 1, strategy: 's3', endpoint: 'https://s3.example.com' }),
    });
  });
});
