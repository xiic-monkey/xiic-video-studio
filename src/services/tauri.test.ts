import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../domain/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  convertFileSrc: (path: string) => `file://${path}`,
}));

import { assetUrl, importLegacyProject, listBoards, listRuns, saveAssetHost, startRun } from './tauri';

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

  it('imports a legacy project through the Rust command with camelCase counts', async () => {
    invoke.mockResolvedValue({
      project: { id: 'project_1' },
      board: { id: 'board_1' },
      assetCount: 12,
      runCount: 9,
      warnings: ['素材读不到'],
    });
    const result = await importLegacyProject('/tmp/legacy.json');
    expect(invoke).toHaveBeenCalledWith('import_legacy_project', { path: '/tmp/legacy.json' });
    expect(result.assetCount).toBe(12);
    expect(result.runCount).toBe(9);
    expect(result.warnings).toEqual(['素材读不到']);
  });

  it('refuses the legacy import outside the desktop app', async () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    await expect(importLegacyProject('/tmp/legacy.json')).rejects.toThrow('旧项目导入只能在桌面应用中运行');
    expect(invoke).not.toHaveBeenCalled();
  });
});
