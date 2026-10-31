import { describe, expect, it } from 'vitest';
import { emptyStyleGuide } from '../types';
import { validateBoard } from './validate';
import { edge, makeDoc, node, videoNode } from './testFixtures';

const ctx = { providers: [], styleGuide: emptyStyleGuide() };

describe('validateBoard', () => {
  it('reports type mismatches', () => {
    const doc = makeDoc([node('text1', 'text'), node('img', 'image')], [
      edge('e1', 'text1', 'img', 'text', 'references', 'reference_image'),
    ]);
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('GRAPH_TYPE_MISMATCH');
  });

  it('reports duplicate single-input edges', () => {
    const doc = makeDoc(
      [node('t1', 'text'), node('t2', 'text'), node('img', 'image')],
      [
        edge('e1', 't1', 'img', 'text', 'prompt', 'prompt'),
        edge('e2', 't2', 'img', 'text', 'prompt', 'prompt'),
      ],
    );
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('GRAPH_SINGLE_INPUT');
  });

  it('rejects mixing frame and reference modes', () => {
    const doc = makeDoc(
      [node('img1', 'image', { prompt: 'frame' }), node('img2', 'image', { prompt: 'ref' }), videoNode('vid', { mode: 'firstLast', prompt: 'go' })],
      [
        edge('e1', 'img1', 'vid', 'image', 'start', 'first_frame'),
        edge('e2', 'img2', 'vid', 'image', 'references', 'reference_image'),
      ],
    );
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('VIDEO_MODE_CONFLICT');
  });

  it('requires a frame in firstLast mode', () => {
    const doc = makeDoc([videoNode('vid', { mode: 'firstLast', prompt: 'go' })], []);
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('PARAM_FRAME_REQUIRED');
  });

  it('reports cycles', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'text')], [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')]);
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('GRAPH_CYCLE');
  });
});
