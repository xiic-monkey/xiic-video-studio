import { describe, expect, it } from 'vitest';
import { customCapabilityOption, customModelBinding, protocolOptionsFor } from './customModels';

describe('自定义模型', () => {
  it('按能力声明路由依据：能力 + 协议都写进绑定', () => {
    const binding = customModelBinding('my-tuned-llm', 'text.chat', 'openai-chat');
    expect(binding.id).toBe('my-tuned-llm');
    expect(binding.capabilities[0].capability).toBe('text.chat');
    expect(binding.protocols?.['text.chat']).toBe('openai-chat');
    expect(binding.capabilities[0].inputTransport.length).toBeGreaterThan(0);
  });

  it('能力换了，协议跟着换', () => {
    const binding = customModelBinding('m', 'image.generate', 'qwen-image');
    expect(binding.capabilities[0].capability).toBe('image.generate');
    expect(binding.protocols?.['image.generate']).toBe('qwen-image');
    expect(customCapabilityOption('image.generate')?.protocols).toContain('qwen-image');
  });

  it('协议选项：目录里的模型用目录，自定义模型用绑定声明', () => {
    const catalogBinding = customModelBinding('gpt-6-astra', 'text.chat', 'openai-chat');
    // 目录里有这个模型时，选项来自目录而不是绑定。
    expect(protocolOptionsFor(catalogBinding, 'text.chat')).toContain('openai-responses');

    const custom = customModelBinding('my-tuned-llm', 'text.chat', 'anthropic-messages');
    expect(protocolOptionsFor(custom, 'text.chat')).toEqual(['anthropic-messages']);
  });

  it('绑定没声明协议时退到该能力的通用协议', () => {
    const binding = { id: 'x', displayName: 'x', capabilities: [] };
    expect(protocolOptionsFor(binding, 'video.generate')).toContain('minimax-video');
  });
});
