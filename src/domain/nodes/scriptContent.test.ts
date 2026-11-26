import { describe, expect, it } from 'vitest';
import { beatsToText, parseScriptPayload, scriptTextForPort } from './scriptContent';

describe('parseScriptPayload', () => {
  it('reads the script and the beats out of the json the model returns', () => {
    const payload = parseScriptPayload('{"script": "第一幕：雨夜", "beats": ["告别", "追车"]}');
    expect(payload?.script).toBe('第一幕：雨夜');
    expect(payload?.beats).toBe('1. 告别\n2. 追车');
  });

  it('unwraps a fenced json block', () => {
    const payload = parseScriptPayload('```json\n{"script": "正文", "beats": []}\n```');
    expect(payload?.script).toBe('正文');
  });

  it('falls back to plain text when the model ignores the json contract', () => {
    const payload = parseScriptPayload('第一幕：雨夜\n第二幕：追车');
    expect(payload?.script).toBe('第一幕：雨夜\n第二幕：追车');
    // 猜不出节拍就不能编：宁可空着。
    expect(payload?.beats).toBe('');
  });

  it('returns nothing for empty output', () => {
    expect(parseScriptPayload('   ')).toBeUndefined();
  });
});

describe('scriptTextForPort', () => {
  it('picks the field the port asks for', () => {
    const text = '{"script": "正文", "beats": ["一", "二"]}';
    expect(scriptTextForPort(text, 'script')).toBe('正文');
    expect(scriptTextForPort(text, 'beats')).toBe('1. 一\n2. 二');
  });
});

describe('beatsToText', () => {
  it('numbers the beats', () => {
    expect(beatsToText(['a', 'b'])).toBe('1. a\n2. b');
  });

  it('keeps a plain string as is', () => {
    expect(beatsToText(' a ')).toBe('a');
  });
});
