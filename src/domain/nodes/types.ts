import type { BoardNode, DataType, EdgeRole, ProviderProfile, StyleGuide } from '../types';

export interface PortDef {
  key: string;
  label: string;
  dataType: DataType;
  role?: EdgeRole;
  multi?: boolean;
  required?: boolean;
}

export interface Issue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  portKey?: string;
}

export interface NodeContext {
  styleGuide?: StyleGuide;
  providers: ProviderProfile[];
}

export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'toggle';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  help?: string;
}

export interface NodeAction {
  key: string;
  label: string;
  capability?: string;
}

export interface NodeDefinition<TData extends object = Record<string, unknown>> {
  type: string;
  typeVersion: number;
  title: string;
  category: 'script' | 'character' | 'scene' | 'shot' | 'media' | 'audio' | 'compose' | 'director' | 'agent' | 'utility';
  inputs: PortDef[];
  outputs: PortDef[];
  fields: FieldDef[];
  createDefaults(): TData;
  validate(node: BoardNode, ctx: NodeContext): Issue[];
  actions: NodeAction[];
}

export interface TextNodeData {
  prompt: string;
  system: string;
  mode: 'generate' | 'rewrite';
  providerId?: string;
  model?: string;
}

export interface ImageNodeData {
  prompt: string;
  negative: string;
  size: string;
  count: number;
  providerId?: string;
  model?: string;
}

export interface VideoNodeData {
  prompt: string;
  negative: string;
  mode: 't2v' | 'firstLast' | 'reference';
  duration: number;
  resolution: '768P' | '2K';
  aspectRatio: string;
  generateAudio: boolean;
  providerId?: string;
  model?: string;
}

export interface AudioNodeData {
  text: string;
  voice: string;
  format: 'mp3' | 'wav';
  providerId?: string;
  model?: string;
}

export interface ScriptNodeData {
  title: string;
  /** 创作要求：运行剧本节点时发给模型的指令。 */
  prompt: string;
  body: string;
  /** 节拍：每行一条。 */
  beats: string;
  providerId?: string;
  model?: string;
}

/** 角色三视图（业内通行版式：横版「面部特写 + 正/侧/背」，竖版 2×2 四视图）。 */
export interface CharacterNodeData {
  prompt: string;
  negative: string;
  layout: 'landscape' | 'portrait';
  background: 'white' | 'gray';
  model?: string;
  providerId?: string;
}

/** 分镜九宫格：一张图里排 9 个连续镜头。 */
export interface StoryboardNodeData {
  prompt: string;
  negative: string;
  grid: '3x3' | '4x4';
  model?: string;
  providerId?: string;
}

/**
 * 业务化节点共用数据形状。
 *
 * 这些节点都是「通用能力 + 固定版式约束」的组合：
 * variant 决定变体/方向类选项，note 是补充要求，grid/steps 是版式参数。
 */
export interface BusinessNodeData {
  prompt: string;
  negative: string;
  variant?: string;
  note?: string;
  grid?: string;
  steps?: number;
  layout?: string;
  background?: string;
  model?: string;
  providerId?: string;
  /** 节点级参考图（拆帧出来的视角等），运行时会作为额外参考注入。 */
  referenceAssetIds?: string[];
}

/** 局部重绘：源图连线进来，蒙版作为节点级资产保存（白=重绘，黑=保留）。 */
export interface InpaintNodeData {
  prompt: string;
  negative: string;
  note?: string;
  maskAssetId?: string;
  model?: string;
  providerId?: string;
}

export interface NoteNodeData {
  text: string;
  color: string;
}

export interface GroupNodeData {
  label: string;
  collapsed: boolean;
}
