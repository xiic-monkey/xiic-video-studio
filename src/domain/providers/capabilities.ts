import type { CostEstimate, ModelCapability, ModelConfig, ProviderProfile } from '../types';

export const MINIMAX_H3_MODEL: ModelConfig = {
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
      ratios: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
      resolutions: ['768P', '2K'],
      maxPromptChars: 20480,
      inputTransport: ['publicUrl'],
      async: true,
      concurrency: 2,
    },
  ],
  defaults: {
    protocol: 'official',
    submitPath: '/v1/video_generation',
    pollPath: '/v1/query/video_generation?task_id={task_id}',
    cancelPath: '',
    fileRetrievePath: '/v1/files/retrieve?file_id={file_id}',
  },
};

export const DEFAULT_PROVIDERS: ProviderProfile[] = [
  {
    id: 'openai-compatible', name: 'OpenAI 兼容中转', adapter: 'openai-compatible',
    baseUrl: '', auth: { type: 'bearer', keyRef: 'provider/openai-compatible' },
    models: [], enabled: true, schemaVersion: 1,
  },
  {
    id: 'minimax-h3', name: 'MiniMax H3', adapter: 'minimax-h3',
    baseUrl: '', auth: { type: 'bearer', keyRef: 'provider/minimax-h3' },
    models: [MINIMAX_H3_MODEL], enabled: true, schemaVersion: 1,
  },
];

export function capabilityOf(model: ModelConfig, capability: string): ModelCapability | undefined {
  return model.capabilities.find((item) => item.capability === capability);
}

export function estimateCost(
  model: ModelConfig,
  capability: string,
  params: Record<string, unknown>,
): CostEstimate | undefined {
  const price = capabilityOf(model, capability)?.price;
  if (!price) return undefined;
  const round = (value: number) => Math.round(value * 10000) / 10000;
  switch (price.unit) {
    case 'request':
      return { amount: round(price.amount), currency: price.currency, unit: '次' };
    case 'image': {
      const count = Number(params.count ?? 1);
      return { amount: round(price.amount * count), currency: price.currency, unit: '张', breakdown: { count } };
    }
    case 'second': {
      const duration = Number(params.duration ?? 0);
      return { amount: round(price.amount * duration), currency: price.currency, unit: '秒', breakdown: { duration } };
    }
    case 'character': {
      const chars = String(params.text ?? '').length;
      return { amount: round(price.amount * chars), currency: price.currency, unit: '字符', breakdown: { chars } };
    }
    case 'token':
      return undefined;
  }
}
