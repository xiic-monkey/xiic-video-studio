import { describe, expect, it } from 'vitest';
import { formatSrt, parseSrt } from './timeline';

describe('srt', () => {
  it('round trips UTF-8 Chinese and multiline cues', () => {
    const source = '1\n00:00:00,000 --> 00:00:01,500\n你好\n第二行\n';
    expect(formatSrt(parseSrt(source))).toBe(source);
  });

  it('accepts MM:SS,mmm subtitle timecodes', () => {
    const cues = parseSrt('1\n00:01,000 --> 00:02,000\n第一句');
    expect(cues[0]).toMatchObject({ id: 'cue_1', startTicks: 240_000, endTicks: 480_000, text: '第一句' });
  });

  it('still accepts HH:MM:SS,mmm and dot separated millis', () => {
    const cues = parseSrt('1\n01:00:02,500 --> 01:00:03.000\n第二句');
    expect(cues[0].startTicks).toBe(864_600_000);
    expect(cues[0].endTicks).toBe(864_720_000);
  });
});
