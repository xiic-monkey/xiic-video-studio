import { newId } from '../ids';
import type { BoardNode, EdgeRole, ProviderProfile } from '../types';
import type {
  AudioNodeData, GroupNodeData, ImageNodeData, Issue, NodeContext, NodeDefinition,
  NoteNodeData, PortDef, ScriptNodeData, TextNodeData, VideoNodeData,
} from './types';

const DEFAULT_ROLE: Record<string, EdgeRole> = {
  text: 'prompt', script: 'script', beat: 'beat', character: 'character_ref',
  location: 'location_ref', prop: 'prop_ref', image: 'reference_image',
  video: 'reference_video', audio: 'audio', frame: 'reference_image',
  timeline: 'timeline', any: 'reference_image',
};

const missing = (code: string, message: string): Issue => ({ code, message, severity: 'error' });

function textNode(): NodeDefinition<TextNodeData> {
  return {
    type: 'text', typeVersion: 1, title: '文本 / LLM', category: 'media',
    inputs: [
      { key: 'system', label: '系统提示', dataType: 'text' },
      { key: 'context', label: '上下文', dataType: 'text', multi: true },
    ],
    outputs: [{ key: 'text', label: '文本', dataType: 'text', role: 'prompt' }],
    fields: [
      { key: 'system', label: '系统提示', type: 'textarea', placeholder: '可留空' },
      { key: 'prompt', label: '提示词', type: 'textarea', placeholder: '输入要生成或改写的文本' },
      { key: 'mode', label: '模式', type: 'select', options: [{ label: '生成', value: 'generate' }, { label: '改写', value: 'rewrite' }] },
    ],
    createDefaults: () => ({ prompt: '', system: '', mode: 'generate', providerId: '', model: '' }),
    validate: () => [],
    actions: [{ key: 'generate', label: '生成文本', capability: 'text.chat' }],
  };
}

function imageNode(): NodeDefinition<ImageNodeData> {
  return {
    type: 'image', typeVersion: 1, title: '图片', category: 'media',
    inputs: [
      { key: 'prompt', label: '提示词', dataType: 'text', role: 'prompt' },
      { key: 'references', label: '参考图', dataType: 'image', role: 'reference_image', multi: true },
      { key: 'style', label: '风格参考', dataType: 'image', role: 'style_ref' },
    ],
    outputs: [{ key: 'image', label: '图片', dataType: 'image' }],
    fields: [
      { key: 'prompt', label: '提示词', type: 'textarea' },
      { key: 'negative', label: '负向提示', type: 'textarea' },
      { key: 'size', label: '尺寸', type: 'select', options: [
        { label: '1024×1024', value: '1024x1024' }, { label: '1024×1536（竖）', value: '1024x1536' },
        { label: '1536×1024（横）', value: '1536x1024' },
      ] },
      { key: 'count', label: '候选数', type: 'number', min: 1, max: 4, step: 1 },
    ],
    createDefaults: () => ({ prompt: '', negative: '', size: '1024x1536', count: 2 }),
    validate: (node) => {
      const issues: Issue[] = [];
      const count = Number(node.data.count ?? 1);
      if (count < 1 || count > 4) issues.push(missing('PARAM_COUNT_RANGE', '候选数需在 1–4 之间'));
      return issues;
    },
    actions: [{ key: 'generate', label: '生成图片', capability: 'image.generate' }],
  };
}

function videoNode(): NodeDefinition<VideoNodeData> {
  return {
    type: 'video', typeVersion: 1, title: '视频', category: 'media',
    inputs: [
      { key: 'prompt', label: '提示词', dataType: 'text', role: 'prompt' },
      { key: 'start', label: '首帧', dataType: 'frame', role: 'first_frame' },
      { key: 'end', label: '尾帧', dataType: 'frame', role: 'last_frame' },
      { key: 'references', label: '参考图', dataType: 'image', role: 'reference_image', multi: true },
      { key: 'referenceVideo', label: '参考视频', dataType: 'video', role: 'reference_video' },
      { key: 'referenceAudio', label: '参考音频', dataType: 'audio', role: 'reference_audio' },
    ],
    outputs: [{ key: 'video', label: '视频', dataType: 'video' }],
    fields: [
      { key: 'prompt', label: '提示词', type: 'textarea' },
      { key: 'negative', label: '负向约束', type: 'textarea' },
      { key: 'mode', label: '模式', type: 'select', options: [
        { label: '文生视频', value: 't2v' }, { label: '首尾帧', value: 'firstLast' },
        { label: '全能参考', value: 'reference' },
      ] },
      { key: 'duration', label: '时长（秒）', type: 'number', min: 5, max: 15, step: 1 },
      { key: 'resolution', label: '分辨率', type: 'select', options: [
        { label: '768P', value: '768P' }, { label: '2K', value: '2K' },
      ] },
      { key: 'aspectRatio', label: '比例', type: 'select', options: [
        { label: '9:16', value: '9:16' }, { label: '16:9', value: '16:9' }, { label: '1:1', value: '1:1' },
        { label: '4:3', value: '4:3' }, { label: '3:4', value: '3:4' }, { label: '21:9', value: '21:9' },
        { label: '自适应', value: 'adaptive' },
      ] },
      { key: 'generateAudio', label: '生成原生音频', type: 'toggle' },
    ],
    createDefaults: () => ({
      prompt: '', negative: '', mode: 't2v', duration: 6, resolution: '768P',
      aspectRatio: '9:16', generateAudio: true,
    }),
    validate: (node) => {
      const issues: Issue[] = [];
      const duration = Number(node.data.duration ?? 0);
      if (!Number.isInteger(duration) || duration < 5 || duration > 15) {
        issues.push(missing('PARAM_DURATION_RANGE', 'H3 时长需为 5–15 的整数秒'));
      }
      return issues;
    },
    actions: [{ key: 'generate', label: '生成视频', capability: 'video.generate' }],
  };
}

function audioNode(): NodeDefinition<AudioNodeData> {
  return {
    type: 'audio', typeVersion: 1, title: '音频 / TTS', category: 'audio',
    inputs: [
      { key: 'text', label: '文本', dataType: 'text', role: 'prompt' },
      { key: 'referenceAudio', label: '参考音频', dataType: 'audio', role: 'reference_audio' },
    ],
    outputs: [{ key: 'audio', label: '音频', dataType: 'audio' }],
    fields: [
      { key: 'text', label: '台词', type: 'textarea' },
      { key: 'voice', label: '音色', type: 'text', placeholder: 'alloy / 中文女声…' },
      { key: 'format', label: '格式', type: 'select', options: [
        { label: 'MP3', value: 'mp3' }, { label: 'WAV', value: 'wav' },
      ] },
    ],
    createDefaults: () => ({ text: '', voice: 'alloy', format: 'mp3' }),
    validate: () => [],
    actions: [{ key: 'generate', label: '生成语音', capability: 'audio.tts' }],
  };
}

function scriptNode(): NodeDefinition<ScriptNodeData> {
  return {
    type: 'script', typeVersion: 1, title: '剧本', category: 'script',
    inputs: [
      { key: 'idea', label: '灵感', dataType: 'text', role: 'prompt' },
      { key: 'reference', label: '参考', dataType: 'text', role: 'prompt', multi: true },
    ],
    outputs: [
      { key: 'script', label: '剧本', dataType: 'script', role: 'script' },
      { key: 'beats', label: '节拍', dataType: 'beat', role: 'beat' },
    ],
    fields: [
      { key: 'title', label: '标题', type: 'text' },
      { key: 'body', label: '正文', type: 'textarea' },
    ],
    createDefaults: () => ({ title: '', body: '' }),
    validate: () => [],
    actions: [],
  };
}

function noteNode(): NodeDefinition<NoteNodeData> {
  return {
    type: 'note', typeVersion: 1, title: '备注', category: 'utility',
    inputs: [], outputs: [],
    fields: [
      { key: 'text', label: '内容', type: 'textarea' },
      { key: 'color', label: '颜色', type: 'select', options: [
        { label: '默认', value: 'default' }, { label: '薄荷', value: 'mint' }, { label: '暖橙', value: 'warm' },
      ] },
    ],
    createDefaults: () => ({ text: '', color: 'default' }),
    validate: () => [],
    actions: [],
  };
}

function groupNode(): NodeDefinition<GroupNodeData> {
  return {
    type: 'group', typeVersion: 1, title: '分组', category: 'utility',
    inputs: [], outputs: [],
    fields: [
      { key: 'label', label: '名称', type: 'text' },
      { key: 'collapsed', label: '折叠', type: 'toggle' },
    ],
    createDefaults: () => ({ label: '分组', collapsed: false }),
    validate: () => [],
    actions: [],
  };
}

const registry = new Map<string, NodeDefinition<any>>([
  ['text', textNode()],
  ['image', imageNode()],
  ['video', videoNode()],
  ['audio', audioNode()],
  ['script', scriptNode()],
  ['note', noteNode()],
  ['group', groupNode()],
]);

export function getNodeDefinition(type: string): NodeDefinition<any> | undefined {
  return registry.get(type);
}

export function listNodeDefinitions(): NodeDefinition<any>[] {
  return [...registry.values()];
}

export function createNode(
  type: string,
  position: { x: number; y: number },
  overrides: Record<string, unknown> = {},
): BoardNode {
  const def = getNodeDefinition(type);
  if (!def) throw new Error(`Unknown node type: ${type}`);
  return {
    id: newId('node'),
    type,
    typeVersion: def.typeVersion,
    position,
    z: 0,
    data: { ...(def.createDefaults() as Record<string, unknown>), ...overrides },
  };
}

export function visibleInputPorts(def: NodeDefinition<any>, node: BoardNode): PortDef[] {
  if (def.type !== 'video') return def.inputs;
  const mode = (node.data as unknown as VideoNodeData).mode;
  if (mode === 'firstLast') {
    return def.inputs.filter((port) => !['references', 'referenceVideo', 'referenceAudio'].includes(port.key));
  }
  if (mode === 'reference') {
    return def.inputs.filter((port) => !['start', 'end'].includes(port.key));
  }
  return def.inputs.filter((port) => !['start', 'end', 'referenceVideo', 'referenceAudio'].includes(port.key));
}

export function edgeRoleFor(source: PortDef, target: PortDef): EdgeRole {
  return target.role ?? source.role ?? DEFAULT_ROLE[source.dataType] ?? 'reference_image';
}

export function providerSupports(profile: ProviderProfile, capability: string): boolean {
  return profile.enabled && profile.models.some((model) =>
    model.capabilities.some((item) => item.capability === capability));
}

export function capabilityFor(profile: ProviderProfile, modelId: string, capability: string) {
  return profile.models.find((model) => model.id === modelId)
    ?.capabilities.find((item) => item.capability === capability);
}

export type { NodeContext };
