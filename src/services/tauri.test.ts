import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../domain/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  convertFileSrc: (path: string) => `file://${path}`,
}));

import { assetUrl, importLegacyProject, listBoards, listRuns, listBreakdownDrafts, saveBreakdownDraft, saveAssetHost, startPaidRun } from './tauri';

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

  it('persists and reloads project scoped breakdown drafts', async () => {
    const draft = { shots: [{ localId: 's1' }], subjects: [] };
    const stored = { draftId: 'd1', scriptId: 'script1', scriptRevision: 3, payload: draft };
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce([stored]);
    await saveBreakdownDraft('p1', 'd1', 'script1', 3, draft);
    expect(invoke).toHaveBeenNthCalledWith(1, 'save_breakdown_draft', { projectId: 'p1', draftId: 'd1', scriptId: 'script1', scriptRevision: 3, payload: draft });
    await expect(listBreakdownDrafts('p1', 'script1')).resolves.toEqual([stored]);
    expect(invoke).toHaveBeenNthCalledWith(2, 'list_breakdown_drafts', { projectId: 'p1', scriptId: 'script1' });
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

    await startPaidRun(
      {
        previewId: 'preview_1',
        fingerprint: 'f1',
        projectId: run.projectId,
        boardId: run.boardId,
        cached: false,
        routes: [],
        estimates: {},
        warnings: [],
        expiresAt: '2026-10-31T00:01:00.000Z',
      },
      {
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
      },
    );

    expect(invoke).toHaveBeenCalledWith('start_paid_run', expect.objectContaining({ request: expect.anything() }));
    const request = invoke.mock.calls[0][1].request as Record<string, unknown>;
    expect(Object.keys(request)).toEqual(
      expect.arrayContaining(['schemaVersion', 'projectId', 'boardId', 'nodeId', 'cacheKey']),
    );
  });

  it('opens a project scoped media grant', async () => {
    invoke.mockResolvedValue({ url: 'frameforge-media://mg_1', expiresAt: '2026-11-22T00:00:00Z' });
    await expect(assetUrl('project_1', 'asset_1')).resolves.toBe('frameforge-media://mg_1');
    expect(invoke).toHaveBeenCalledWith('open_project_media', {
      projectId: 'project_1', assetId: 'asset_1', rendition: 'original',
    });
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
