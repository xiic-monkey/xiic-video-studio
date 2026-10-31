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
