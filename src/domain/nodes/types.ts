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
  body: string;
}

export interface NoteNodeData {
  text: string;
  color: string;
}

export interface GroupNodeData {
  label: string;
  collapsed: boolean;
}
