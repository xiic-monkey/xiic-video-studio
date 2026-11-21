import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node, videoNode } from '../graph/testFixtures';
import { emptyStyleGuide } from '../types';
import type { ProviderProfile } from '../types';
import { TEST_KEYS, TEST_PROFILES, runningRun } from './runFixtures';
import { buildCacheContext, mergeRunRecord, nodeParams, resolveModel, runCapability } from './runtime';

describe('runCapability', () => {
  it('switches an image node to the edit capability when a reference is connected', () => {
    const doc = makeDoc([node('img', 'image'), node('ref', 'image')], [edge('e1', 'ref', 'img', 'image', 'references', 'reference_image')]);
    expect(runCapability(doc, doc.nodes.img)).toBe('image.edit');
  });

  it('always runs the inpaint node with the edit capability', () => {
    const doc = makeDoc([node('p', 'inpaint')], []);
    expect(runCapability(doc, doc.nodes.p)).toBe('image.edit');
  });

  it('returns undefined for utility nodes', () => {
    const doc = makeDoc([node('note', 'note')], []);
    expect(runCapability(doc, doc.nodes.note)).toBeUndefined();
  });
});

describe('resolveModel', () => {
  it('auto-picks a model that supports the capability and keeps the provider unset', () => {
    const doc = makeDoc([node('t', 'text', { prompt: '写一段开场' })], []);
    const result = resolveModel(TEST_PROFILES, TEST_KEYS, doc.nodes.t, 'text.chat');
    // 自动路由时 providerId 留空：调用顺序由模型下各供应商的优先级决定。
    expect(result.ok && result.resolved.providerId).toBe('');
    expect(result.ok && result.resolved.providerName).toBe('自动路由');
    expect(result.ok && result.resolved.modelId).toBe('gpt-4o-mini');
  });

  it('pins the provider when the node selected one', () => {
    const doc = makeDoc([node('t', 'text', { prompt: '写一段开场', model: 'gpt-4o-mini', providerId: 'openai-compatible' })], []);
    const result = resolveModel(TEST_PROFILES, TEST_KEYS, doc.nodes.t, 'text.chat');
    expect(result.ok && result.resolved.providerId).toBe('openai-compatible');
    expect(result.ok && result.resolved.providerName).toBe('OpenAI 兼容中转');
  });

  it('prefers an actionable key error over CAP_NO_MODEL', () => {
    const doc = makeDoc([videoNode('v')], []);
    const result = resolveModel(TEST_PROFILES, { 'openai-compatible': true }, doc.nodes.v, 'video.generate');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('PROVIDER_KEY_MISSING');
  });

  it('rejects an explicit model that lacks the capability', () => {
    const doc = makeDoc([node('i', 'image', { providerId: 'openai-compatible', model: 'gpt-4o-mini' })], []);
    const result = resolveModel(TEST_PROFILES, TEST_KEYS, doc.nodes.i, 'image.generate');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('PARAM_MODEL_INVALID');
  });

  it('reports CAP_NO_MODEL when no model supports the capability', () => {
    const doc = makeDoc([node('a', 'audio', { text: '台词' })], []);
    const result = resolveModel(TEST_PROFILES, TEST_KEYS, doc.nodes.a, 'video.edit');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('CAP_NO_MODEL');
  });

  it('reports PROVIDER_KEY_MISSING when a supporting provider has no key saved', () => {
    const doc = makeDoc([videoNode('v')], []);
    const result = resolveModel(TEST_PROFILES, { 'openai-compatible': true, 'minimax-h3': false }, doc.nodes.v, 'video.generate');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe('PROVIDER_KEY_MISSING');
      expect(result.issue.message).toContain('MiniMax H3');
    }
  });

  /// 所有 Key 都在冷却中时不能当成「可用」：预检要拦住，别等后端报没有候选。
  it('reports a cooling key instead of treating the provider as usable', () => {
    const cooling: ProviderProfile = {
      ...TEST_PROFILES[0],
      keys: [{
        id: 'k1',
        label: '主 Key',
        keyRef: 'provider/openai-compatible/key/k1',
        enabled: true,
        status: 'cooling',
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
        hasSecret: true,
      }],
    };
    const doc = makeDoc([node('t', 'text', { prompt: '写一段开场', model: 'gpt-4o-mini', providerId: 'openai-compatible' })], []);
    const result = resolveModel([cooling], TEST_KEYS, doc.nodes.t, 'text.chat');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('PROVIDER_KEY_COOLING');
  });

  /// 冷却过期的 Key 立刻恢复可用。
  it('accepts a key whose cooldown has expired', () => {
    const expired: ProviderProfile = {
      ...TEST_PROFILES[0],
      keys: [{
        id: 'k1',
        label: '主 Key',
        keyRef: 'provider/openai-compatible/key/k1',
        enabled: true,
        status: 'cooling',
        cooldownUntil: new Date(Date.now() - 1_000).toISOString(),
        hasSecret: true,
      }],
    };
    const doc = makeDoc([node('t', 'text', { prompt: '写一段开场', model: 'gpt-4o-mini', providerId: 'openai-compatible' })], []);
    const result = resolveModel([expired], TEST_KEYS, doc.nodes.t, 'text.chat');
    expect(result.ok).toBe(true);
  });
});

describe('nodeParams', () => {
  it('maps the video ratio field onto the provider parameter name', () => {
    const doc = makeDoc([videoNode('v', { mode: 'firstLast', duration: 8, resolution: '2K', aspectRatio: '16:9', generateAudio: false })], []);
    expect(nodeParams(doc.nodes.v, 'video.generate')).toEqual({
      mode: 'firstLast', duration: 8, resolution: '2K', ratio: '16:9', generateAudio: false,
    });
  });

  it('clamps the candidate count into the adapter range', () => {
    const doc = makeDoc([node('i', 'image', { count: 9 })], []);
    expect(nodeParams(doc.nodes.i, 'image.generate').count).toBe(4);
  });

  it('carries the tts text so per-character pricing works', () => {
    const doc = makeDoc([node('a', 'audio', { text: '你好', voice: 'Chelsie', format: 'wav' })], []);
    expect(nodeParams(doc.nodes.a, 'audio.tts')).toEqual({ voice: 'Chelsie', format: 'wav', text: '你好' });
  });

  it('carries the catalog params rendered in the Inspector', () => {
    const audio = makeDoc([node('a', 'audio', { text: '你好', speed: 1.5 })], []);
    expect(nodeParams(audio.nodes.a, 'audio.tts', { id: 'speech-02-hd' })).toMatchObject({ speed: 1.5 });
    const image = makeDoc([node('i', 'image', { count: 1 })], []);
    expect(nodeParams(image.nodes.i, 'image.generate', { id: 'gpt-image-1' })).toMatchObject({
      quality: 'auto',
    });
  });
});

describe('buildCacheContext', () => {
  it('keys runtime per node and leaves promptHashes empty', () => {
    const doc = makeDoc([node('t', 'text', { prompt: 'hi' }), node('note', 'note')], []);
    const ctx = buildCacheContext({ doc, runs: [], profiles: TEST_PROFILES, hasKeys: TEST_KEYS, styleGuide: emptyStyleGuide() });
    // 自动路由不进缓存键：换一家供应商不该让缓存失效。
    expect(ctx.runtime.t).toEqual({
      providerId: '', model: 'gpt-4o-mini',
      params: { system: '', temperature: 0.7, maxTokens: 4096 },
    });
    expect(ctx.runtime.note).toBeUndefined();
    expect(ctx.promptHashes).toEqual({});
  });

  it('still records params when the model cannot be resolved', () => {
    const doc = makeDoc([videoNode('v', { duration: 9 })], []);
    const ctx = buildCacheContext({ doc, runs: [], profiles: TEST_PROFILES, hasKeys: {}, styleGuide: undefined });
    expect(ctx.runtime.v).toEqual({ providerId: undefined, model: undefined, params: nodeParams(doc.nodes.v, 'video.generate') });
  });
});

describe('mergeRunRecord', () => {
  it('drops a non-terminal update for an already terminal run', () => {
    const runs = { run_v: runningRun('v', 'succeeded') };
    expect(mergeRunRecord(runs, runningRun('v', 'running'))).toBeUndefined();
  });

  it('applies a terminal update over a running record', () => {
    const merged = mergeRunRecord({ run_v: runningRun('v') }, runningRun('v', 'failed'));
    expect(merged ? merged.run_v.status : '').toBe('failed');
  });
});
