import { emptyStyleGuide } from '../types';
import type { AssetRef, ProviderProfile, RunRecord, StudioProject } from '../types';

export const TEST_PROFILES: ProviderProfile[] = [
  {
    id: 'openai-compatible',
    name: 'OpenAI 兼容中转',
    adapter: 'openai-compatible',
    baseUrl: 'https://relay.example/v1',
    auth: { type: 'bearer', keyRef: 'provider/openai-compatible' },
    enabled: true,
    schemaVersion: 1,
    models: [
      {
        id: 'gpt-4o-mini',
        displayName: 'GPT-4o mini',
        capabilities: [{ capability: 'text.chat', inputTransport: ['dataUrl'], async: false }],
      },
      {
        id: 'gpt-image-1',
        displayName: 'GPT Image 1',
        capabilities: [
          {
            capability: 'image.generate',
            inputTransport: ['dataUrl'],
            async: false,
            maxPromptChars: 4000,
            price: { unit: 'image', amount: 0.04, currency: 'CNY' },
          },
          {
            capability: 'image.edit',
            inputTransport: ['dataUrl'],
            async: false,
            maxReferenceImages: 4,
          },
        ],
      },
      {
        id: 'tts-1',
        displayName: 'TTS-1',
        capabilities: [
          { capability: 'audio.tts', inputTransport: ['dataUrl'], async: false, price: { unit: 'character', amount: 0.0002, currency: 'CNY' } },
        ],
      },
    ],
  },
  {
    id: 'minimax-h3',
    name: 'MiniMax H3',
    adapter: 'minimax-h3',
    baseUrl: 'https://api.minimax.example',
    auth: { type: 'bearer', keyRef: 'provider/minimax-h3' },
    enabled: true,
    schemaVersion: 1,
    models: [
      {
        id: 'MiniMax-H3',
        displayName: 'MiniMax H3',
        capabilities: [
          {
            capability: 'video.generate',
            modes: ['t2v', 'firstLast', 'reference'],
            maxReferenceImages: 9,
            maxReferenceVideos: 3,
            maxReferenceAudios: 3,
            supportsFirstFrame: true,
            supportsLastFrame: true,
            supportsNativeAudio: true,
            durations: { min: 5, max: 15, step: 1 },
            ratios: ['adaptive', '16:9', '9:16', '1:1'],
            resolutions: ['768P', '2K'],
            maxPromptChars: 20480,
            inputTransport: ['publicUrl'],
            async: true,
          },
        ],
        defaults: {
          protocol: 'official',
          submitPath: '/v1/video_generation',
          pollPath: '/v1/query/video_generation?task_id={task_id}',
          fileRetrievePath: '/v1/files/retrieve?file_id={file_id}',
        },
      },
    ],
  },
];

export const TEST_KEYS: Record<string, boolean> = {
  'openai-compatible': true,
  'minimax-h3': true,
};

export const S3_HOST = { strategy: 's3', publicBaseUrl: 'https://cdn.example' };

export const testProject: StudioProject = {
  schemaVersion: 1,
  id: 'project_test',
  name: '测试项目',
  aspectRatio: '9:16',
  styleGuide: { ...emptyStyleGuide(), visualStyle: '冷色写实', version: 3 },
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

export function assetRef(id: string, kind: AssetRef['kind'], mime = 'text/plain'): AssetRef {
  return {
    id, kind, path: `assets/${id}`, mime, bytes: 12,
    createdAt: '2026-10-31T00:00:00.000Z',
    provenance: { projectId: 'project_test' },
  };
}

export function succeededRun(nodeId: string, assetId: string, cacheKey = 'cache-key'): RunRecord {
  return {
    id: `run_${nodeId}_${assetId}`,
    projectId: 'project_test',
    boardId: 'board_test',
    nodeId,
    action: 'generate',
    cacheKey,
    status: 'succeeded',
    providerId: 'openai-compatible',
    model: 'gpt-image-1',
    promptSnapshot: { text: 'x', segments: [], hash: 'h', locked: false },
    params: {},
    inputAssetIds: [],
    outputAssetIds: [assetId],
    selectedAssetId: assetId,
    startedAt: '2026-10-31T00:00:00.000Z',
    finishedAt: '2026-10-31T00:00:05.000Z',
  };
}

export function runningRun(nodeId: string, status: RunRecord['status'] = 'running'): RunRecord {
  return { ...succeededRun(nodeId, 'asset_x'), id: `run_${nodeId}`, status };
}
