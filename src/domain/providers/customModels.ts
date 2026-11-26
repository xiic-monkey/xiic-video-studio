import { capabilityProtocols } from './catalog';
import type { ModelCapability, ModelConfig, ProtocolId } from '../types';

/**
 * 自定义模型的能力与协议默认值。
 *
 * 自定义供应商的模型不在内置目录里，没有现成的能力声明：用户得自己
 * 说清「这个模型干什么活、用什么协议」。这里给出各能力的合理默认值，
 * 免得让用户去填 inputTransport 这种实现细节。
 */
export interface CustomCapabilityOption {
  capability: string;
  label: string;
  /** 这类能力常用的协议，按推荐顺序。 */
  protocols: ProtocolId[];
  inputTransport: Array<'dataUrl' | 'publicUrl' | 'upload' | 'multipart'>;
  async: boolean;
}

export const CUSTOM_CAPABILITIES: CustomCapabilityOption[] = [
  {
    capability: 'text.chat',
    label: '文本生成',
    protocols: ['openai-chat', 'openai-responses', 'anthropic-messages'],
    inputTransport: ['dataUrl'],
    async: false,
  },
  {
    capability: 'image.generate',
    label: '图片生成',
    protocols: ['openai-images', 'qwen-image', 'banana-image'],
    inputTransport: ['dataUrl', 'multipart', 'publicUrl'],
    async: false,
  },
  {
    capability: 'image.edit',
    label: '图片编辑',
    protocols: ['openai-images', 'qwen-image', 'banana-image'],
    inputTransport: ['dataUrl', 'multipart', 'publicUrl'],
    async: false,
  },
  {
    capability: 'video.generate',
    label: '视频生成',
    protocols: ['minimax-video', 'seedance-video'],
    inputTransport: ['publicUrl'],
    async: true,
  },
  {
    capability: 'audio.tts',
    label: '语音合成',
    protocols: ['openai-audio', 'minimax-tts', 'mimo-tts'],
    inputTransport: ['dataUrl'],
    async: false,
  },
];

export function customCapabilityOption(capability: string): CustomCapabilityOption | undefined {
  return CUSTOM_CAPABILITIES.find((option) => option.capability === capability);
}

/**
 * 按用户填的模型 id 生成一条绑定。
 *
 * 绑定上的能力声明就是路由依据：后端展开候选时只看绑定，
 * 所以这里声明清楚，模型就能被正常调用。
 */
export function customModelBinding(
  modelId: string,
  capability: string,
  protocol: ProtocolId,
): ModelConfig {
  const option = customCapabilityOption(capability);
  const declared: ModelCapability = {
    capability,
    inputTransport: option?.inputTransport ?? ['dataUrl'],
    async: option?.async ?? false,
    protocols: [protocol],
  };
  return {
    id: modelId,
    displayName: modelId,
    vendor: '自定义',
    capabilities: [declared],
    protocols: { [capability]: protocol },
    priority: 100,
    enabled: true,
  };
}

/**
 * 某个模型在某能力下可选的协议。
 *
 * 目录里的模型用目录推荐的协议；自定义模型没有目录，
 * 用绑定里声明的协议，再退到该能力的通用协议。
 */
export function protocolOptionsFor(model: ModelConfig, capability: string): ProtocolId[] {
  const catalog = capabilityProtocols(model.id, capability);
  if (catalog.length) return catalog;
  const own = model.capabilities.find((item) => item.capability === capability)?.protocols ?? [];
  if (own.length) return own;
  return customCapabilityOption(capability)?.protocols ?? [];
}
