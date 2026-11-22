import type { CatalogModel, ModelCapability, ParamDef, ProtocolId } from '../types';

/** 全部内置协议：目录自检与协议标签以这份清单为准。 */
export const PROTOCOL_IDS: ProtocolId[] = [
  'openai-chat', 'openai-responses', 'anthropic-messages',
  'openai-images', 'qwen-image', 'banana-image',
  'openai-audio', 'minimax-tts', 'mimo-tts',
  'minimax-video', 'seedance-video',
];

const PROTOCOL_LABELS: Record<ProtocolId, string> = {
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'openai-images': 'OpenAI 图片',
  'qwen-image': '通义万相图片',
  'banana-image': 'Nano Banana 图片',
  'openai-audio': 'OpenAI 音频',
  'minimax-tts': 'MiniMax 语音合成',
  'mimo-tts': 'MiMo 语音合成',
  'minimax-video': 'MiniMax 视频',
  'seedance-video': 'Seedance 视频',
};

/** 协议的中文标签。 */
export function protocolLabel(protocol: ProtocolId): string {
  return PROTOCOL_LABELS[protocol] ?? protocol;
}

const TEXT_PARAMS: ParamDef[] = [
  { key: 'temperature', label: '温度', type: 'number', min: 0, max: 2, step: 0.1, default: 0.7 },
  { key: 'maxTokens', label: '最大输出 tokens', type: 'number', min: 256, max: 32768, step: 256, default: 4096 },
];

/**
 * 文本协议能读取的参数。
 *
 * 只有协议真正支持的参数才允许下发：协议读不到的参数改了也没用，
 * 还会白白让缓存键失效（缓存键里含 params）。
 */
export const TEXT_PROTOCOL_PARAM_MAP: Record<string, string[]> = {
  'openai-chat': ['temperature', 'maxTokens'],
  'openai-responses': ['temperature', 'maxTokens'],
  'anthropic-messages': ['temperature', 'maxTokens'],
};

const IMAGE_PARAMS: ParamDef[] = [
  {
    key: 'size', label: '尺寸', type: 'select',
    options: [
      { label: '1024x1024', value: '1024x1024' },
      { label: '1024x1536', value: '1024x1536' },
      { label: '1536x1024', value: '1536x1024' },
    ],
    default: '1024x1536',
  },
  { key: 'count', label: '生成数量', type: 'number', min: 1, max: 4, step: 1, default: 2 },
];

const VIDEO_PARAMS: ParamDef[] = [
  { key: 'duration', label: '时长（秒）', type: 'number', min: 4, max: 30, step: 1, default: 6 },
  {
    key: 'resolution', label: '分辨率', type: 'select',
    options: [
      { label: '720p', value: '720p' },
      { label: '1080p', value: '1080p' },
    ],
    default: '720p',
  },
  {
    key: 'aspectRatio', label: '画面比例', type: 'select',
    options: [
      { label: '16:9', value: '16:9' },
      { label: '9:16', value: '9:16' },
      { label: '1:1', value: '1:1' },
    ],
    default: '16:9',
  },
  { key: 'generateAudio', label: '生成原生音频', type: 'toggle', default: false },
];

const AUDIO_PARAMS: ParamDef[] = [
  { key: 'voice', label: '音色', type: 'text', default: 'male-qn-qingse' },
  {
    key: 'format', label: '音频格式', type: 'select',
    options: [
      { label: 'MP3', value: 'mp3' },
      { label: 'WAV', value: 'wav' },
    ],
    default: 'mp3',
  },
  { key: 'speed', label: '语速', type: 'number', min: 0.5, max: 2, step: 0.1, default: 1 },
];

/** MiMo 的音色名和 MiniMax 不一样，默认音色不能共用。 */
const MIMO_AUDIO_PARAMS: ParamDef[] = AUDIO_PARAMS.map((param) => (
  param.key === 'voice' ? { ...param, default: 'mimo_default' } : param
));

const RATIO_OPTIONS = (ratios: string[]) => ratios.map((value) => ({ label: value, value }));

/**
 * 内置模型目录。新增模型只改这里，不改适配器代码。
 */
export const CATALOG: CatalogModel[] = [
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    vendor: 'OpenAI',
    capabilities: [
      {
        capability: 'text.chat',
        maxPromptChars: 128000,
        inputTransport: ['dataUrl'],
        async: false,
        protocols: ['openai-chat', 'openai-responses'],
      },
    ],
    params: [...TEXT_PARAMS],
    suggestedProviders: [
      { name: 'OpenAI', baseUrl: 'https://api.openai.com', protocol: 'openai-chat' },
    ],
  },
  {
    id: 'gpt-4.1',
    displayName: 'GPT-4.1',
    vendor: 'OpenAI',
    capabilities: [
      {
        capability: 'text.chat',
        maxPromptChars: 1048576,
        inputTransport: ['dataUrl'],
        async: false,
        protocols: ['openai-chat', 'openai-responses'],
      },
    ],
    params: [...TEXT_PARAMS],
    suggestedProviders: [
      { name: 'OpenAI', baseUrl: 'https://api.openai.com', protocol: 'openai-chat' },
    ],
  },
  {
    id: 'claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    vendor: 'Anthropic',
    capabilities: [
      {
        capability: 'text.chat',
        maxPromptChars: 200000,
        inputTransport: ['dataUrl'],
        async: false,
        protocols: ['anthropic-messages'],
      },
    ],
    params: [...TEXT_PARAMS],
    suggestedProviders: [
      { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages', authType: 'header' },
    ],
  },
  {
    id: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    vendor: 'DeepSeek',
    capabilities: [
      {
        capability: 'text.chat',
        maxPromptChars: 64000,
        inputTransport: ['dataUrl'],
        async: false,
        protocols: ['openai-chat'],
      },
    ],
    params: [...TEXT_PARAMS],
    suggestedProviders: [
      { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'openai-chat' },
    ],
  },
  {
    id: 'mimo-v2.5',
    displayName: 'MiMo V2.5',
    vendor: '小米 MiMo',
    capabilities: [
      {
        capability: 'text.chat',
        maxPromptChars: 1000000,
        inputTransport: ['dataUrl'],
        async: false,
        protocols: ['openai-chat', 'anthropic-messages'],
      },
    ],
    params: [...TEXT_PARAMS],
    suggestedProviders: [
      { name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com', protocol: 'openai-chat' },
    ],
  },
  {
    id: 'qwen-max',
    displayName: '通义千问 Max',
    vendor: '阿里通义千问',
    capabilities: [
      {
        capability: 'text.chat',
        maxPromptChars: 32000,
        inputTransport: ['dataUrl'],
        async: false,
        protocols: ['openai-chat'],
      },
    ],
    params: [...TEXT_PARAMS],
    suggestedProviders: [
      { name: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com', protocol: 'openai-chat' },
    ],
  },
  {
    id: 'gpt-image-1',
    displayName: 'GPT Image 1',
    vendor: 'OpenAI',
    capabilities: [
      {
        capability: 'image.generate',
        inputTransport: ['dataUrl', 'multipart'],
        async: false,
        protocols: ['openai-images'],
      },
      {
        capability: 'image.edit',
        maxReferenceImages: 4,
        supportsMask: true,
        inputTransport: ['dataUrl', 'multipart'],
        async: false,
        protocols: ['openai-images'],
      },
    ],
    params: [
      ...IMAGE_PARAMS,
      {
        // gpt-image 系列的合法档位是 low / medium / high / auto。
        key: 'quality', label: '质量', type: 'select',
        options: [
          { label: 'auto（服务端默认）', value: 'auto' },
          { label: '低', value: 'low' },
          { label: '中', value: 'medium' },
          { label: '高', value: 'high' },
        ],
        default: 'auto',
      },
    ],
    suggestedProviders: [
      { name: 'OpenAI', baseUrl: 'https://api.openai.com', protocol: 'openai-images' },
    ],
  },
  {
    id: 'nano-banana',
    displayName: 'Nano Banana',
    vendor: 'Google Gemini',
    capabilities: [
      {
        capability: 'image.generate',
        inputTransport: ['dataUrl'],
        async: false,
        protocols: ['banana-image'],
      },
    ],
    params: [...IMAGE_PARAMS],
    suggestedProviders: [
      { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', protocol: 'banana-image' },
    ],
  },
  {
    id: 'qwen-image',
    displayName: '通义万相 Qwen Image',
    vendor: '阿里通义万相',
    capabilities: [
      {
        capability: 'image.generate',
        maxReferenceImages: 3,
        inputTransport: ['dataUrl', 'publicUrl'],
        async: true,
        protocols: ['qwen-image'],
      },
      {
        capability: 'image.edit',
        maxReferenceImages: 3,
        inputTransport: ['dataUrl', 'publicUrl'],
        async: true,
        protocols: ['qwen-image'],
      },
    ],
    params: [...IMAGE_PARAMS],
    suggestedProviders: [
      { name: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com', protocol: 'qwen-image' },
    ],
  },
  {
    id: 'seedream-4.0',
    displayName: 'Seedream 4.0',
    vendor: '字节 即梦',
    capabilities: [
      {
        capability: 'image.generate',
        inputTransport: ['publicUrl'],
        async: false,
        protocols: ['openai-images'],
      },
    ],
    params: [...IMAGE_PARAMS],
    defaults: {
      // 火山方舟的图片接口在 /api/v3 下，不是 /v1。
      submitPath: '/api/v3/images/generations',
    },
    suggestedProviders: [
      { name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com', protocol: 'openai-images' },
    ],
  },
  {
    id: 'MiniMax-H3',
    displayName: 'MiniMax H3',
    vendor: 'MiniMax',
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
        protocols: ['minimax-video'],
      },
    ],
    params: [
      { key: 'duration', label: '时长（秒）', type: 'number', min: 5, max: 15, step: 1, default: 6 },
      {
        key: 'resolution', label: '分辨率', type: 'select',
        options: [
          { label: '768P', value: '768P' },
          { label: '2K', value: '2K' },
        ],
        default: '768P',
      },
      {
        key: 'aspectRatio', label: '画面比例', type: 'select',
        options: RATIO_OPTIONS(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
        default: '16:9',
      },
      { key: 'generateAudio', label: '生成原生音频', type: 'toggle', default: true },
    ],
    defaults: {
      submitPath: '/v1/video_generation',
      pollPath: '/v1/query/video_generation?task_id={task_id}',
      fileRetrievePath: '/v1/files/retrieve?file_id={file_id}',
    },
    suggestedProviders: [
      { name: 'MiniMax', baseUrl: 'https://api.minimax.io', protocol: 'minimax-video' },
    ],
  },
  {
    id: 'doubao-seedance-1-0-pro-250528',
    displayName: 'Seedance 1.0 Pro',
    vendor: '火山方舟',
    capabilities: [
      {
        capability: 'video.generate',
        modes: ['t2v', 'firstLast', 'reference'],
        maxReferenceImages: 10,
        supportsFirstFrame: true,
        supportsLastFrame: true,
        supportsNativeAudio: false,
        durations: { min: 4, max: 30, step: 1 },
        ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
        resolutions: ['480p', '720p', '1080p'],
        maxPromptChars: 2000,
        inputTransport: ['publicUrl'],
        async: true,
        protocols: ['seedance-video'],
      },
    ],
    params: [
      { key: 'duration', label: '时长（秒）', type: 'number', min: 4, max: 30, step: 1, default: 5 },
      {
        key: 'resolution', label: '分辨率', type: 'select',
        options: [
          { label: '480p', value: '480p' },
          { label: '720p', value: '720p' },
          { label: '1080p', value: '1080p' },
        ],
        default: '720p',
      },
      {
        key: 'aspectRatio', label: '画面比例', type: 'select',
        options: RATIO_OPTIONS(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']),
        default: '16:9',
      },
      { key: 'generateAudio', label: '生成原生音频', type: 'toggle', default: false },
    ],
    defaults: {
      submitPath: '/api/v3/contents/generations/tasks',
      pollPath: '/api/v3/contents/generations/tasks/{task_id}',
    },
    suggestedProviders: [
      { name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com', protocol: 'seedance-video' },
    ],
  },
  {
    id: 'speech-02-hd',
    displayName: 'Speech 02 HD',
    vendor: 'MiniMax',
    capabilities: [
      {
        capability: 'audio.tts',
        inputTransport: [],
        async: false,
        protocols: ['minimax-tts'],
      },
    ],
    params: [...AUDIO_PARAMS],
    suggestedProviders: [
      { name: 'MiniMax', baseUrl: 'https://api.minimax.io', protocol: 'minimax-tts' },
    ],
  },
  {
    id: 'mimo-v2.5-tts',
    displayName: 'MiMo V2.5 TTS',
    vendor: '小米 MiMo',
    capabilities: [
      {
        capability: 'audio.tts',
        inputTransport: [],
        async: false,
        protocols: ['mimo-tts'],
      },
    ],
    params: [...MIMO_AUDIO_PARAMS],
    suggestedProviders: [
      { name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com', protocol: 'mimo-tts' },
    ],
  },
];

/** 按 id 取目录条目。 */
export function catalogModel(id: string): CatalogModel | undefined {
  return CATALOG.find((model) => model.id === id);
}

/** 取某个模型在某能力下的能力描述。 */
export function catalogCapability(id: string, capability: string): ModelCapability | undefined {
  return catalogModel(id)?.capabilities.find((item) => item.capability === capability);
}

/** 支持某能力的全部模型，按展示名排序。 */
export function catalogModelsFor(capability: string): CatalogModel[] {
  return CATALOG
    .filter((model) => model.capabilities.some((item) => item.capability === capability))
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** 按能力给出的通用参数，目录里没写参数时兜底。 */
function genericParams(capability: string): ParamDef[] {
  switch (capability) {
    case 'text.chat':
      return [...TEXT_PARAMS];
    case 'image.generate':
    case 'image.edit':
      return [...IMAGE_PARAMS];
    case 'video.generate':
      return [...VIDEO_PARAMS];
    case 'audio.tts':
      return [...AUDIO_PARAMS];
    default:
      return [];
  }
}

/** 某模型在某能力下的参数定义：目录参数优先，否则用通用参数。 */
export function catalogParams(id: string, capability: string): ParamDef[] {
  const model = catalogModel(id);
  if (model?.params) return model.params;
  return genericParams(capability);
}

/** 某模型在某能力下支持的协议。 */
export function capabilityProtocols(id: string, capability: string): ProtocolId[] {
  return catalogCapability(id, capability)?.protocols ?? [];
}

/** 目录参数里某个键的可选值（没有选项时返回 undefined）。 */
export function catalogParamOptions(
  id: string,
  capability: string,
  key: string,
): Array<{ label: string; value: string }> | undefined {
  return catalogParams(id, capability).find((param) => param.key === key)?.options;
}
