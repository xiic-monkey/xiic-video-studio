import { describe, expect, it } from 'vitest';
import type { ProviderProfile } from '../types';
import { edge, makeDoc, node, videoNode } from '../graph/testFixtures';
import {
  S3_HOST, TEST_KEYS, TEST_PROFILES, assetRef, succeededRun, testProject,
} from './runFixtures';
import { inboundTextAssetIds, prepareRun, type PrepareDeps } from './prepare';

function deps(patch: Partial<PrepareDeps> = {}): PrepareDeps {
  return {
    project: testProject,
    profiles: TEST_PROFILES,
    hasKeys: TEST_KEYS,
    runs: [],
    assets: {},
    texts: {},
    ...patch,
  };
}

describe('prepareRun', () => {
  it('blocks an empty prompt before spending anything', () => {
    const doc = makeDoc([node('t', 'text')], []);
    const outcome = prepareRun(doc, 't', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_PROMPT_EMPTY');
  });

  it('carries node-level reference assets into the request', () => {
    const doc = makeDoc([node('i', 'image', { prompt: '雨夜街头', referenceAssetIds: ['asset_front'] })], []);
    const outcome = prepareRun(doc, 'i', deps());
    if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('；'));
    expect(outcome.request.referenceAssetIds).toEqual(['asset_front']);
    // 参考图由后端按资产 id 解析，不混进连线输入。
    expect(outcome.request.inputs).toEqual([]);
  });

  it('sends the catalog-resolved protocol so the backend does not fall back to the adapter default', () => {
    const doc = makeDoc([node('i', 'image', { prompt: '海报' })], []);
    const outcome = prepareRun(doc, 'i', deps());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.request.protocol).toBe('openai-images');
  });

  it('injects upstream text and appends it when the prompt does not reference it', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('i', 'image', { prompt: '雨夜街头' })],
      [edge('e1', 't', 'i', 'text', 'prompt', 'prompt')],
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: [succeededRun('t', 'asset_text')],
      texts: { asset_text: '第一幕：告别的雨夜' },
    }));
    if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('；'));
    expect(outcome.request.promptSnapshot.text).toBe('雨夜街头\n\n第一幕：告别的雨夜');
    expect(outcome.request.capability).toBe('image.generate');
    // 自动路由：供应商留空，由后端按模型下的供应商顺序逐家尝试。
    expect(outcome.request.providerId).toBe('');
    expect(outcome.request.model).toBe('gpt-image-1');
    expect(outcome.request.inputs).toEqual([]);
  });

  it('keeps an explicit variable reference instead of appending twice', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('i', 'image', { prompt: '氛围：{{prompt}}' })],
      [edge('e1', 't', 'i', 'text', 'prompt', 'prompt')],
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: [succeededRun('t', 'asset_text')],
      texts: { asset_text: '压抑' },
    }));
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.request.promptSnapshot.text).toBe('氛围：压抑');
  });

  it('routes media inputs with the edge role and flips the capability to edit', () => {
    const doc = makeDoc(
      [node('a', 'image'), node('i', 'image', { prompt: '换成红衣' })],
      [edge('e1', 'a', 'i', 'image', 'references', 'reference_image')],
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: [succeededRun('a', 'asset_img')],
      assets: { asset_img: assetRef('asset_img', 'image', 'image/png') },
    }));
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.request.capability).toBe('image.edit');
    expect(outcome.request.inputs).toEqual([
      { role: 'reference_image', assetId: 'asset_img', kind: 'image', mime: 'image/png' },
    ]);
    expect(outcome.request.inputAssetIds).toEqual(['asset_img']);
  });

  it('injects a saved mask as a dedicated input for the inpaint node', () => {
    const doc = makeDoc(
      [node('a', 'image'), node('p', 'inpaint', { prompt: '换掉背景', maskAssetId: 'mask_1' })],
      [edge('e1', 'a', 'p', 'image', 'source', 'source_image')],
    );
    const outcome = prepareRun(doc, 'p', deps({
      runs: [succeededRun('a', 'asset_src')],
      assets: {
        asset_src: assetRef('asset_src', 'image', 'image/png'),
        mask_1: assetRef('mask_1', 'image', 'image/png'),
      },
    }));
    if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('；'));
    expect(outcome.request.capability).toBe('image.edit');
    expect(outcome.request.inputs).toEqual([
      { role: 'source_image', assetId: 'asset_src', kind: 'image', mime: 'image/png' },
      { role: 'mask', assetId: 'mask_1', kind: 'image', mime: 'image/png' },
    ]);
    expect(outcome.request.promptSnapshot.text).toContain('只重绘蒙版标记的白色区域');
  });

  it('blocks inpaint when no mask has been saved', () => {
    const doc = makeDoc(
      [node('a', 'image'), node('p', 'inpaint', { prompt: '换掉背景' })],
      [edge('e1', 'a', 'p', 'image', 'source', 'source_image')],
    );
    const outcome = prepareRun(doc, 'p', deps({
      runs: [succeededRun('a', 'asset_src')],
      assets: { asset_src: assetRef('asset_src', 'image', 'image/png') },
    }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('RUN_MASK_MISSING');
  });

  it('blocks inpaint when the model does not accept a mask', () => {
    const custom: ProviderProfile = {
      ...TEST_PROFILES[0],
      models: [{
        id: 'custom-edit',
        displayName: 'Custom Edit',
        capabilities: [{
          capability: 'image.edit', inputTransport: ['dataUrl'], async: false,
          supportsMask: false,
        }],
      }],
    };
    const doc = makeDoc(
      [
        node('a', 'image'),
        node('p', 'inpaint', { prompt: '换掉背景', maskAssetId: 'mask_1', model: 'custom-edit' }),
      ],
      [edge('e1', 'a', 'p', 'image', 'source', 'source_image')],
    );
    const outcome = prepareRun(doc, 'p', deps({
      profiles: [custom],
      hasKeys: { 'openai-compatible': true },
      runs: [succeededRun('a', 'asset_src')],
      assets: {
        asset_src: assetRef('asset_src', 'image', 'image/png'),
        mask_1: assetRef('mask_1', 'image', 'image/png'),
      },
    }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('CAP_MASK_UNSUPPORTED');
  });

  it('feeds a connected system port into params instead of the prompt', () => {
    const doc = makeDoc(
      [node('s', 'text'), node('t', 'text', { prompt: '写分镜' })],
      [edge('e1', 's', 't', 'text', 'system', 'prompt')],
    );
    const outcome = prepareRun(doc, 't', deps({
      runs: [succeededRun('s', 'asset_sys')],
      texts: { asset_sys: '你是短剧编剧' },
    }));
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.request.params.system).toBe('你是短剧编剧');
    expect(outcome.request.promptSnapshot.text).toBe('写分镜');
  });

  it('appends the upstream system prompt after the local one instead of replacing it', () => {
    const doc = makeDoc(
      [node('s', 'text'), node('t', 'text', { prompt: '写分镜', system: '本地系统提示' })],
      [edge('e1', 's', 't', 'text', 'system', 'prompt')],
    );
    const outcome = prepareRun(doc, 't', deps({
      runs: [succeededRun('s', 'asset_sys')],
      texts: { asset_sys: '你是短剧编剧' },
    }));
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.request.params.system).toBe('本地系统提示\n\n你是短剧编剧');
    expect(outcome.request.promptSnapshot.text).toBe('写分镜');
  });

  it('keeps the local system prompt when no upstream system is connected', () => {
    const doc = makeDoc([node('t', 'text', { prompt: '写分镜', system: '本地系统提示' })], []);
    const outcome = prepareRun(doc, 't', deps());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.request.params.system).toBe('本地系统提示');
  });

  it('refuses a public-url-only model when the asset host is not configured', () => {
    const doc = makeDoc(
      [node('f', 'image'), videoNode('v', { mode: 'firstLast', prompt: '镜头推进' })],
      [edge('e1', 'f', 'v', 'image', 'start', 'first_frame')],
    );
    const base = deps({
      runs: [succeededRun('f', 'asset_frame')],
      assets: { asset_frame: assetRef('asset_frame', 'image', 'image/png') },
    });
    const blocked = prepareRun(doc, 'v', base);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.issues.map((issue) => issue.code)).toContain('CAP_PUBLIC_URL_REQUIRED');

    const allowed = prepareRun(doc, 'v', { ...base, assetHost: S3_HOST });
    if (!allowed.ok) throw new Error('expected ok with s3 host');
    expect(allowed.request.inputs[0]).toEqual({ role: 'first_frame', assetId: 'asset_frame', kind: 'image', mime: 'image/png' });
  });

  it('blocks a public-url-only model when only node-level references are present', () => {
    const doc = makeDoc([videoNode('v', { prompt: '镜头推进', referenceAssetIds: ['asset_ref'] })], []);
    const base = deps({
      profiles: [TEST_PROFILES[1]],
      hasKeys: { 'minimax-h3': true },
      assets: { asset_ref: assetRef('asset_ref', 'image', 'image/png') },
    });
    const blocked = prepareRun(doc, 'v', base);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.issues.map((issue) => issue.code)).toContain('CAP_PUBLIC_URL_REQUIRED');
    const allowed = prepareRun(doc, 'v', { ...base, assetHost: S3_HOST });
    expect(allowed.ok).toBe(true);
  });

  it('rejects an unsupported resolution before submitting', () => {
    const doc = makeDoc([videoNode('v', { resolution: '4K' })], []);
    const outcome = prepareRun(doc, 'v', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_RESOLUTION_UNSUPPORTED');
  });

  it('rejects reference images beyond the model limit', () => {
    const refs = Array.from({ length: 5 }, (_, index) => node(`r${index}`, 'image'));
    const doc = makeDoc(
      [...refs, node('i', 'image', { prompt: '融合参考' })],
      refs.map((ref, index) => edge(`e${index}`, ref.id, 'i', 'image', 'references', 'reference_image')),
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: refs.map((ref, index) => succeededRun(ref.id, `asset_${index}`)),
      assets: Object.fromEntries(refs.map((_, index) => [`asset_${index}`, assetRef(`asset_${index}`, 'image', 'image/png')])),
    }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_REFERENCE_LIMIT');
  });

  it('counts the style reference against the image quota', () => {
    const refs = Array.from({ length: 4 }, (_, index) => node(`r${index}`, 'image'));
    const doc = makeDoc(
      [...refs, node('i', 'image', { prompt: '融合参考' })],
      [
        ...refs.map((ref, index) => edge(`e${index}`, ref.id, 'i', 'image', 'references', 'reference_image')),
        edge('estyle', 'r0', 'i', 'image', 'style', 'style_ref'),
      ],
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: refs.map((ref, index) => succeededRun(ref.id, `asset_${index}`)),
      assets: Object.fromEntries(refs.map((_, index) => [`asset_${index}`, assetRef(`asset_${index}`, 'image', 'image/png')])),
    }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_REFERENCE_LIMIT');
  });

  it('blocks the first-last-frame mode when node-level references are present', () => {
    const doc = makeDoc(
      [
        node('f1', 'image'), node('f2', 'image'),
        videoNode('v', { mode: 'firstLast', referenceAssetIds: ['asset_ref'] }),
      ],
      [
        edge('e1', 'f1', 'v', 'image', 'start', 'first_frame'),
        edge('e2', 'f2', 'v', 'image', 'end', 'last_frame'),
      ],
    );
    const outcome = prepareRun(doc, 'v', deps({
      assetHost: S3_HOST,
      runs: [succeededRun('f1', 'asset_f1'), succeededRun('f2', 'asset_f2')],
      assets: {
        asset_f1: assetRef('asset_f1', 'image', 'image/png'),
        asset_f2: assetRef('asset_f2', 'image', 'image/png'),
      },
    }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_MODE_CONFLICT');
      expect(outcome.issues[0].message).toContain('首尾帧模式下不能同时使用参考图');
    }
  });

  it('blocks the native audio switch for a model without native audio', () => {
    const seedance: ProviderProfile = {
      ...TEST_PROFILES[1],
      models: [{
        id: 'doubao-seedance-1-0-pro-250528',
        displayName: 'Seedance 1.0 Pro',
        capabilities: [{
          capability: 'video.generate',
          modes: ['t2v', 'firstLast', 'reference'],
          durations: { min: 4, max: 30, step: 1 },
          ratios: ['16:9', '9:16'],
          resolutions: ['480p', '720p', '1080p'],
          supportsNativeAudio: false,
          inputTransport: ['publicUrl'],
          async: true,
        }],
      }],
    };
    const doc = makeDoc([videoNode('v', { generateAudio: true })], []);
    const outcome = prepareRun(doc, 'v', deps({
      profiles: [seedance],
      hasKeys: { 'minimax-h3': true },
    }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_MODE_UNSUPPORTED');
      expect(outcome.issues[0].message).toContain('不支持生成原生音频');
    }
  });

  it('sends the catalog resolution when the node has none', () => {
    const seedance: ProviderProfile = {
      ...TEST_PROFILES[1],
      models: [{
        id: 'doubao-seedance-1-0-pro-250528',
        displayName: 'Seedance 1.0 Pro',
        capabilities: [{
          capability: 'video.generate',
          modes: ['t2v', 'firstLast', 'reference'],
          durations: { min: 4, max: 30, step: 1 },
          ratios: ['16:9', '9:16'],
          resolutions: ['480p', '720p', '1080p'],
          inputTransport: ['publicUrl'],
          async: true,
        }],
      }],
    };
    const doc = makeDoc([videoNode('v')], []);
    const outcome = prepareRun(doc, 'v', deps({
      profiles: [seedance],
      hasKeys: { 'minimax-h3': true },
    }));
    if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('；'));
    expect(outcome.request.params.resolution).toBe('720p');
    expect(outcome.request.params.generateAudio).toBe(false);
  });

  it('estimates cost from the priced capability', () => {
    const doc = makeDoc([node('i', 'image', { prompt: '海报', count: 3 })], []);
    const outcome = prepareRun(doc, 'i', deps());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.cost).toEqual({ amount: 0.12, currency: 'CNY', unit: '张', breakdown: { count: 3 } });
    expect(outcome.cached).toBe(false);
  });

  it('flags a missing price instead of silently estimating zero', () => {
    const doc = makeDoc([videoNode('v')], []);
    const outcome = prepareRun(doc, 'v', deps());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.cost).toBeUndefined();
  });

  it('reports unresolved prompt variables', () => {
    const doc = makeDoc([node('i', 'image', { prompt: '{{character.name}} 出场' })], []);
    const outcome = prepareRun(doc, 'i', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PROMPT_MISSING_VARIABLE');
  });

  it('reuses the previous run when the cache key matches', () => {
    const doc = makeDoc([node('i', 'image', { prompt: '海报' })], []);
    const first = prepareRun(doc, 'i', deps());
    if (!first.ok) throw new Error('expected ok');
    const stored = succeededRun('i', 'asset_out', first.request.cacheKey);
    const second = prepareRun(doc, 'i', deps({
      runs: [stored],
      assets: { asset_out: assetRef('asset_out', 'image', 'image/png') },
    }));
    if (!second.ok) throw new Error('expected cache hit');
    expect(second.cached).toBe(true);
    expect(second.request.cachedAssetId).toBe('asset_out');
    expect(second.request.cacheKey).toBe(first.request.cacheKey);
  });

  it('blocks the run when an upstream node has no usable output yet', () => {
    const doc = makeDoc(
      [node('t', 'text', { prompt: '上游' }), node('i', 'image', { prompt: '海报' })],
      [edge('e1', 't', 'i', 'text', 'prompt', 'prompt')],
    );
    const outcome = prepareRun(doc, 'i', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((issue) => issue.code)).toContain('RUN_UPSTREAM_MISSING');
      expect(outcome.issues[0].message).toContain('上游「文本 / LLM」还没有可用结果，请先运行该上游节点');
    }
  });

  it('blocks the run when an upstream text cannot be read', () => {
    const doc = makeDoc(
      [node('t', 'text', { prompt: '上游' }), node('i', 'image', { prompt: '海报' })],
      [edge('e1', 't', 'i', 'text', 'prompt', 'prompt')],
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: [succeededRun('t', 'asset_text')],
      texts: { asset_text: '   ' },
    }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((issue) => issue.code)).toContain('RUN_UPSTREAM_TEXT_EMPTY');
      expect(outcome.issues[0].message).toContain('上游「文本 / LLM」的文本读取失败或为空，请先重新运行该上游节点');
    }
  });

  it('returns the graph error when the node itself is invalid', () => {
    const doc = makeDoc([videoNode('v', { duration: 4 })], []);
    const outcome = prepareRun(doc, 'v', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_DURATION_RANGE');
  });

  it('asks the user to save the API key when the supporting provider has none', () => {
    const doc = makeDoc([videoNode('v')], []);
    const outcome = prepareRun(doc, 'v', deps({
      hasKeys: { 'openai-compatible': true, 'minimax-h3': false },
    }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.map((issue) => issue.code)).toContain('PROVIDER_KEY_MISSING');
      expect(outcome.issues[0].message).toContain('MiniMax H3');
    }
  });

  it('refuses nodes that cannot run', () => {
    const doc = makeDoc([node('n', 'note', { text: '备忘' })], []);
    const outcome = prepareRun(doc, 'n', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('RUN_NOT_RUNNABLE');
  });
});

describe('inboundTextAssetIds', () => {
  it('lists only upstream text assets the controller must read', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('a', 'image'), node('i', 'image', { prompt: 'p' })],
      [
        edge('e1', 't', 'i', 'text', 'prompt', 'prompt'),
        edge('e2', 'a', 'i', 'image', 'references', 'reference_image'),
      ],
    );
    const runs = [succeededRun('t', 'asset_text'), succeededRun('a', 'asset_img')];
    const assets = { asset_img: assetRef('asset_img', 'image', 'image/png') };
    expect(inboundTextAssetIds(doc, 'i', runs, assets)).toEqual(['asset_text']);
  });
});
