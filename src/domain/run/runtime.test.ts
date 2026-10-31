import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node, videoNode } from '../graph/testFixtures';
import { emptyStyleGuide } from '../types';
import { TEST_KEYS, TEST_PROFILES, runningRun } from './runFixtures';
import { buildCacheContext, mergeRunRecord, nodeParams, resolveModel, runCapability } from './runtime';

describe('runCapability', () => {
  it('switches an image node to the edit capability when a reference is connected', () => {
    const doc = makeDoc([node('img', 'image'), node('ref', 'image')], [edge('e1', 'ref', 'img', 'image', 'references', 'reference_image')]);
    expect(runCapability(doc, doc.nodes.img)).toBe('image.edit');
  });

  it('returns undefined for utility nodes', () => {
    const doc = makeDoc([node('note', 'note')], []);
    expect(runCapability(doc, doc.nodes.note)).toBeUndefined();
  });
});

describe('resolveModel', () => {
  it('auto-picks the first enabled provider that supports the capability', () => {
    const doc = makeDoc([node('t', 'text', { prompt: '写一段开场' })], []);
    const result = resolveModel(TEST_PROFILES, TEST_KEYS, doc.nodes.t, 'text.chat');
    expect(result.ok && result.resolved.providerId).toBe('openai-compatible');
    expect(result.ok && result.resolved.modelId).toBe('gpt-4o-mini');
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
});

describe('buildCacheContext', () => {
  it('keys runtime per node and leaves promptHashes empty', () => {
    const doc = makeDoc([node('t', 'text', { prompt: 'hi' }), node('note', 'note')], []);
    const ctx = buildCacheContext({ doc, runs: [], profiles: TEST_PROFILES, hasKeys: TEST_KEYS, styleGuide: emptyStyleGuide() });
    expect(ctx.runtime.t).toEqual({ providerId: 'openai-compatible', model: 'gpt-4o-mini', params: { system: '' } });
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
