import { newId } from '../ids';
import type { BoardNode, EdgeRole, ProviderProfile } from '../types';
import type {
  AudioNodeData, BusinessNodeData, CharacterNodeData, FieldDef, GroupNodeData, ImageNodeData,
  InpaintNodeData, Issue, NodeContext, NodeDefinition, NoteNodeData, PortDef, ScriptNodeData,
  StoryboardNodeData, TextNodeData, VideoNodeData,
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

/**
 * 视频节点数据。
 *
 * generateAudio 与 resolution 不写死：两者的默认值都来自目录里的模型参数。
 */
type VideoNodeDefaults = Omit<VideoNodeData, 'generateAudio' | 'resolution'> & {
  generateAudio?: boolean;
  resolution?: string;
};

function videoNode(): NodeDefinition<VideoNodeDefaults> {
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
      { key: 'duration', label: '时长（秒）', type: 'number', min: 1, step: 1 },
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
      prompt: '', negative: '', mode: 't2v', duration: 6, aspectRatio: '9:16',
    }),
    validate: (node) => {
      const issues: Issue[] = [];
      // 时长范围按所选模型的能力在运行前校验，这里只保证是正整数。
      const duration = Number(node.data.duration ?? 0);
      if (!Number.isInteger(duration) || duration <= 0) {
        issues.push(missing('PARAM_DURATION_RANGE', '时长需为正整数秒'));
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
    createDefaults: () => ({ text: '', voice: '', format: 'mp3' }),
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

function mediaSourceNode(): NodeDefinition<Record<string, unknown>> {
  return {
    type: 'media_source', typeVersion: 1, title: '本地素材', category: 'media',
    inputs: [],
    outputs: [{ key: 'output', label: '素材', dataType: 'any' }],
    fields: [
      { key: 'assetId', label: '素材 ID', type: 'text', help: '从项目素材库添加后自动绑定' },
      { key: 'kind', label: '素材类型', type: 'select', options: [
        { label: '视频', value: 'video' }, { label: '图片', value: 'image' }, { label: '音频', value: 'audio' },
      ] },
    ],
    createDefaults: () => ({ assetId: '', kind: 'video' }),
    validate: (node) => String(node.data.assetId ?? '').trim() ? [] : [missing('MEDIA_SOURCE_EMPTY', '请选择项目内素材')],
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

function characterNode(): NodeDefinition<CharacterNodeData> {
  return {
    type: 'character', typeVersion: 1, title: '角色三视图', category: 'character',
    inputs: [
      { key: 'prompt', label: '角色描述', dataType: 'text', role: 'prompt' },
      { key: 'references', label: '参考图', dataType: 'image', role: 'reference_image', multi: true },
    ],
    outputs: [{ key: 'image', label: '设定图', dataType: 'image' }],
    fields: [
      { key: 'prompt', label: '角色描述', type: 'textarea', placeholder: '年龄、体型、脸型、发型、服装、特征…' },
      { key: 'layout', label: '版式', type: 'select', options: [
        { label: '横版：面部特写 + 正/侧/背', value: 'landscape' },
        { label: '竖版：正/左/右/背 2×2', value: 'portrait' },
      ] },
      { key: 'background', label: '背景', type: 'select', options: [
        { label: '纯白', value: 'white' }, { label: '浅灰', value: 'gray' },
      ] },
      { key: 'negative', label: '负向约束', type: 'textarea' },
    ],
    createDefaults: () => ({ prompt: '', negative: '', layout: 'landscape', background: 'white' }),
    validate: (node) => {
      const issues: Issue[] = [];
      if (!String(node.data.prompt ?? '').trim()) {
        issues.push(missing('PROMPT_EMPTY', '请填写角色描述'));
      }
      return issues;
    },
    actions: [{ key: 'generate', label: '生成三视图', capability: 'image.generate' }],
  };
}

function storyboardNode(): NodeDefinition<StoryboardNodeData> {
  return {
    type: 'storyboard', typeVersion: 1, title: '分镜九宫格', category: 'shot',
    inputs: [
      { key: 'prompt', label: '镜头内容', dataType: 'text', role: 'prompt' },
      { key: 'references', label: '参考图', dataType: 'image', role: 'reference_image', multi: true },
    ],
    outputs: [{ key: 'image', label: '分镜图', dataType: 'image' }],
    fields: [
      { key: 'prompt', label: '镜头内容', type: 'textarea', placeholder: '这一段要拍什么：场景、动作、情绪、节奏…' },
      { key: 'grid', label: '宫格', type: 'select', options: [
        { label: '3×3（9 格）', value: '3x3' }, { label: '4×4（16 格）', value: '4x4' },
      ] },
      { key: 'negative', label: '负向约束', type: 'textarea' },
    ],
    createDefaults: () => ({ prompt: '', negative: '', grid: '3x3' }),
    validate: (node) => {
      const issues: Issue[] = [];
      if (!String(node.data.prompt ?? '').trim()) {
        issues.push(missing('PROMPT_EMPTY', '请填写镜头内容'));
      }
      return issues;
    },
    actions: [{ key: 'generate', label: '生成分镜图', capability: 'image.generate' }],
  };
}

/** 业务化节点：结构一致，差异在版式参数与提示词模板。 */
function businessNode(config: {
  type: string;
  title: string;
  category: NodeDefinition<any>['category'];
  promptLabel: string;
  promptPlaceholder: string;
  fields: FieldDef[];
  defaults: Record<string, unknown>;
  actionLabel: string;
}): NodeDefinition<BusinessNodeData> {
  return {
    type: config.type,
    typeVersion: 1,
    title: config.title,
    category: config.category,
    inputs: [
      { key: 'prompt', label: config.promptLabel, dataType: 'text', role: 'prompt' },
      { key: 'references', label: '参考图', dataType: 'image', role: 'reference_image', multi: true },
    ],
    outputs: [{ key: 'image', label: '图片', dataType: 'image' }],
    fields: [
      { key: 'prompt', label: config.promptLabel, type: 'textarea', placeholder: config.promptPlaceholder },
      ...config.fields,
      { key: 'negative', label: '负向约束', type: 'textarea' },
    ],
    createDefaults: () => ({ prompt: '', negative: '', ...config.defaults }),
    validate: (node) => {
      const issues: Issue[] = [];
      if (!String(node.data.prompt ?? '').trim()) {
        issues.push(missing('PROMPT_EMPTY', `请填写${config.promptLabel}`));
      }
      return issues;
    },
    actions: [{ key: 'generate', label: config.actionLabel, capability: 'image.generate' }],
  };
}

/** 局部重绘：源图从连线进来，蒙版在 Inspector 里画好后存成节点资产。 */
function inpaintNode(): NodeDefinition<InpaintNodeData> {
  return {
    type: 'inpaint', typeVersion: 1, title: '局部重绘', category: 'media',
    inputs: [
      { key: 'prompt', label: '重绘要求', dataType: 'text', role: 'prompt' },
      { key: 'source', label: '源图', dataType: 'image', role: 'source_image', required: true },
    ],
    outputs: [{ key: 'image', label: '图片', dataType: 'image' }],
    fields: [
      { key: 'prompt', label: '重绘要求', type: 'textarea', placeholder: '描述蒙版区域要画成什么' },
      { key: 'note', label: '补充说明', type: 'textarea', placeholder: '例如：保留原图的光线与风格' },
      { key: 'negative', label: '负向约束', type: 'textarea' },
    ],
    createDefaults: () => ({ prompt: '', negative: '', note: '', maskAssetId: '' }),
    validate: (node) => {
      const issues: Issue[] = [];
      if (!String(node.data.prompt ?? '').trim()) {
        issues.push(missing('PROMPT_EMPTY', '请填写重绘要求'));
      }
      return issues;
    },
    actions: [{ key: 'inpaint', label: '局部重绘', capability: 'image.edit' }],
  };
}

function expressionNode(): NodeDefinition<BusinessNodeData> {
  return businessNode({
    type: 'expression', title: '表情九宫格', category: 'character',
    promptLabel: '角色描述', promptPlaceholder: '同一角色的外貌、服装、光线基调…',
    actionLabel: '生成表情九宫格',
    fields: [
      { key: 'variant', label: '表情组', type: 'select', options: [
        { label: '基础九种', value: 'happy' },
        { label: '戏剧九种', value: 'dramatic' },
        { label: '克制九种', value: 'calm' },
      ] },
    ],
    defaults: { variant: 'happy' },
  });
}

function variantNode(): NodeDefinition<BusinessNodeData> {
  return businessNode({
    type: 'variant', title: '造型变体', category: 'character',
    promptLabel: '角色描述', promptPlaceholder: '同一个角色的固定外貌与身份描述…',
    actionLabel: '生成造型变体',
    fields: [
      { key: 'variant', label: '变体类型', type: 'select', options: [
        { label: '服装', value: 'outfit' }, { label: '年龄', value: 'age' },
        { label: '战损', value: 'battle' }, { label: '妆造', value: 'makeup' },
      ] },
      { key: 'note', label: '变体要求', type: 'text', placeholder: '例如：第 3 集·湿发、左脸擦伤' },
    ],
    defaults: { variant: 'outfit', note: '' },
  });
}

function turnaroundNode(): NodeDefinition<BusinessNodeData> {
  return businessNode({
    type: 'turnaround', title: '360 转面', category: 'character',
    promptLabel: '角色描述', promptPlaceholder: '同一个角色的固定外貌与服装…',
    actionLabel: '生成转面序列',
    fields: [
      { key: 'steps', label: '方向数', type: 'number', min: 4, max: 24, step: 4 },
    ],
    defaults: { steps: 8 },
  });
}

function coverageNode(): NodeDefinition<BusinessNodeData> {
  return businessNode({
    type: 'coverage', title: '场景多机位', category: 'scene',
    promptLabel: '场景描述', promptPlaceholder: '地点、时间、天气、主要陈设…',
    actionLabel: '生成多机位图',
    fields: [
      { key: 'grid', label: '宫格', type: 'select', options: [
        { label: '3×3（9 机位）', value: '3x3' }, { label: '4×4（16 机位）', value: '4x4' },
      ] },
    ],
    defaults: { grid: '3x3' },
  });
}

function continuityNode(): NodeDefinition<BusinessNodeData> {
  return businessNode({
    type: 'continuity', title: '剧情推演', category: 'shot',
    promptLabel: '剧情描述', promptPlaceholder: '这一镜发生了什么、角色状态与走向…',
    actionLabel: '生成推演四宫格',
    fields: [
      { key: 'variant', label: '推演方向', type: 'select', options: [
        { label: '前 3 秒 / 当前 / 后 3 秒', value: 'before-after' },
        { label: '前序 / 过程 / 后续 / 结果', value: 'sequence' },
      ] },
    ],
    defaults: { variant: 'before-after' },
  });
}

function redrawNode(): NodeDefinition<BusinessNodeData> {
  return businessNode({
    type: 'redraw', title: '重绘 / 改图', category: 'media',
    promptLabel: '要改成什么', promptPlaceholder: '例如：把衣服换成黑色风衣，人物不要看镜头',
    actionLabel: '重绘参考图',
    fields: [
      { key: 'note', label: '修改要求', type: 'textarea', placeholder: '只写要改的部分，其余保持原样' },
    ],
    defaults: { note: '' },
  });
}

const registry = new Map<string, NodeDefinition<any>>([
  ['text', textNode()],
  ['image', imageNode()],
  ['video', videoNode()],
  ['audio', audioNode()],
  ['script', scriptNode()],
  ['media_source', mediaSourceNode()],
  ['character', characterNode()],
  ['storyboard', storyboardNode()],
  ['expression', expressionNode()],
  ['variant', variantNode()],
  ['turnaround', turnaroundNode()],
  ['coverage', coverageNode()],
  ['continuity', continuityNode()],
  ['redraw', redrawNode()],
  ['inpaint', inpaintNode()],
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
