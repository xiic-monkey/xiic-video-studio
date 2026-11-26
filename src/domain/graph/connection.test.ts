import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node } from './testFixtures';
import { validateConnection } from './validate';

describe('validateConnection', () => {
  it('accepts a text prompt into an image node', () => {
    const doc = makeDoc([node('t', 'text'), node('i', 'image')], []);
    expect(validateConnection(doc, 't', 'text', 'i', 'prompt')).toEqual([]);
  });

  it('rejects an image into the hidden start port of a text-to-video node', () => {
    const doc = makeDoc([node('i', 'image'), node('v', 'video')], []);
    const issues = validateConnection(doc, 'i', 'image', 'v', 'start');
    expect(issues.map((issue) => issue.code)).toContain('GRAPH_PORT_HIDDEN');
  });

  it('rejects a second source on a single-input port', () => {
    const doc = makeDoc(
      [node('t1', 'text'), node('t2', 'text'), node('i', 'image')],
      [edge('e1', 't1', 'i')],
    );
    const issues = validateConnection(doc, 't2', 'text', 'i', 'prompt');
    expect(issues.map((issue) => issue.code)).toContain('GRAPH_SINGLE_INPUT');
  });

  it('rejects incompatible data types', () => {
    const doc = makeDoc([node('a', 'audio'), node('i', 'image')], []);
    const issues = validateConnection(doc, 'a', 'audio', 'i', 'references');
    expect(issues.map((issue) => issue.code)).toContain('GRAPH_TYPE_MISMATCH');
  });
});

describe('端口兼容矩阵', () => {
  it('accepts the script output into any text input', () => {
    const doc = makeDoc([node('s', 'script'), node('t', 'text'), node('i', 'image')], []);
    expect(validateConnection(doc, 's', 'script', 't', 'context')).toEqual([]);
    expect(validateConnection(doc, 's', 'script', 'i', 'prompt')).toEqual([]);
  });

  it('accepts the beats output into a text input', () => {
    const doc = makeDoc([node('s', 'script'), node('t', 'text')], []);
    expect(validateConnection(doc, 's', 'beats', 't', 'context')).toEqual([]);
  });

  it('rejects the script output into an image input', () => {
    const doc = makeDoc([node('s', 'script'), node('i', 'image')], []);
    const issues = validateConnection(doc, 's', 'script', 'i', 'references');
    expect(issues.map((issue) => issue.code)).toContain('GRAPH_TYPE_MISMATCH');
  });

  it('素材节点的端口类型固定：视频素材接不进参考图', () => {
    const videoAsset = makeDoc([node('v', 'video_source', { kind: 'video', assetId: 'a1' }), node('i', 'image')], []);
    const issues = validateConnection(videoAsset, 'v', 'video', 'i', 'references');
    expect(issues.map((issue) => issue.code)).toContain('GRAPH_TYPE_MISMATCH');

    const imageAsset = makeDoc([node('p', 'image_source', { kind: 'image', assetId: 'a1' }), node('v', 'video', { mode: 'firstLast' })], []);
    expect(validateConnection(imageAsset, 'p', 'image', 'v', 'start')).toEqual([]);
  });

  it('图片素材节点能接进参考图与首尾帧端口', () => {
    const doc = makeDoc([node('p', 'image_source', { assetId: 'a1' }), node('i', 'image'), node('v', 'video', { mode: 'firstLast' })], []);
    expect(validateConnection(doc, 'p', 'image', 'i', 'references')).toEqual([]);
    expect(validateConnection(doc, 'p', 'image', 'i', 'style')).toEqual([]);
    expect(validateConnection(doc, 'p', 'image', 'v', 'start')).toEqual([]);
  });

  it('视频与音频素材接进各自的参考端口', () => {
    const doc = makeDoc([node('v', 'video_source', { assetId: 'a1' }), node('a', 'audio_source', { assetId: 'a2' }), node('n', 'video', { mode: 'reference' })], []);
    expect(validateConnection(doc, 'v', 'video', 'n', 'referenceVideo')).toEqual([]);
    expect(validateConnection(doc, 'a', 'audio', 'n', 'referenceAudio')).toEqual([]);
    // 类型不同就接不上。
    expect(validateConnection(doc, 'a', 'audio', 'n', 'referenceVideo').map((issue) => issue.code))
      .toContain('GRAPH_TYPE_MISMATCH');
  });

  it('文本素材能接进任何文本输入，图片素材不行', () => {
    const doc = makeDoc([node('x', 'text_source', { text: '设定' }), node('t', 'text'), node('i', 'image')], []);
    expect(validateConnection(doc, 'x', 'text', 't', 'context')).toEqual([]);
    expect(validateConnection(doc, 'x', 'text', 't', 'system')).toEqual([]);
    expect(validateConnection(doc, 'x', 'text', 'i', 'prompt')).toEqual([]);
    // 图片接不进文本端口。
    const withImage = makeDoc([node('p', 'image_source', { assetId: 'a1' }), node('t', 'text')], []);
    expect(validateConnection(withImage, 'p', 'image', 't', 'context').map((issue) => issue.code))
      .toContain('GRAPH_TYPE_MISMATCH');
  });
});
