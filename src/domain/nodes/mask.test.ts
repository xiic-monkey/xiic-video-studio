import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node } from '../graph/testFixtures';
import { succeededRun } from '../run/runFixtures';
import { isMaskNode, maskAssetIdOf, maskPaintedRatio, sourceAssetIdOf } from './mask';

describe('mask helpers', () => {
  it('recognizes only the inpaint node', () => {
    expect(isMaskNode(node('i', 'inpaint'))).toBe(true);
    expect(isMaskNode(node('r', 'redraw'))).toBe(false);
    expect(isMaskNode(undefined)).toBe(false);
  });

  it('reads a stored mask asset id and ignores empty values', () => {
    expect(maskAssetIdOf(node('i', 'inpaint', { maskAssetId: 'mask_1' }))).toBe('mask_1');
    expect(maskAssetIdOf(node('i', 'inpaint', { maskAssetId: '' }))).toBeUndefined();
  });

  it('resolves the source image from the source port only', () => {
    const doc = makeDoc(
      [node('a', 'image'), node('b', 'image'), node('i', 'inpaint')],
      [
        edge('e1', 'a', 'i', 'image', 'source', 'source_image'),
        edge('e2', 'b', 'i', 'image', 'references', 'reference_image'),
      ],
    );
    const runs = [succeededRun('a', 'asset_a'), succeededRun('b', 'asset_b')];
    expect(sourceAssetIdOf(doc, 'i', runs)).toBe('asset_a');
  });

  it('returns nothing when the source port is not connected', () => {
    const doc = makeDoc([node('i', 'inpaint')], []);
    expect(sourceAssetIdOf(doc, 'i', [])).toBeUndefined();
  });

  /// 空蒙版提交上去模型无从下手，保存前必须拦住。
  it('counts only painted pixels when measuring the mask coverage', () => {
    // 两个像素：一个透明，一个不透明。
    const pixels = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]);
    expect(maskPaintedRatio(pixels)).toBe(0.5);
    expect(maskPaintedRatio(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]))).toBe(0);
    expect(maskPaintedRatio(new Uint8ClampedArray())).toBe(0);
  });
});
