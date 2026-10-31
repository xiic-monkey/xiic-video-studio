import { sha256Json } from '../hash';
import type { PromptSegment, PromptSnapshot, StyleGuide } from '../types';

export interface PromptCompileContext {
  variables: Record<string, string>;
  styleGuide?: StyleGuide;
  negative?: string;
  lockedText?: string;
  overrides?: { text?: string; negative?: string };
}

const VARIABLE = /\{\{\s*([\w.]+)\s*\}\}/g;

function resolveVariable(key: string, ctx: PromptCompileContext): string | undefined {
  if (key.startsWith('style.')) {
    const field = key.slice('style.'.length) as keyof StyleGuide;
    const value = ctx.styleGuide?.[field];
    return value === undefined || value === null ? undefined : String(value);
  }
  return ctx.variables[key];
}

function segmentKey(key: string): string {
  if (key.startsWith('style.')) return 'style';
  if (key.startsWith('character.')) return 'subject';
  if (key.startsWith('camera.')) return 'camera';
  if (key.startsWith('lighting.')) return 'lighting';
  return 'variable';
}

export function compilePrompt(template: string, ctx: PromptCompileContext): PromptSnapshot {
  const locked = ctx.lockedText ?? ctx.overrides?.text;
  const source = locked ?? template;
  const segments: PromptSegment[] = [];
  const missing = new Set<string>();
  let cursor = 0;

  for (const match of source.matchAll(VARIABLE)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ key: 'literal', label: '文本', text: source.slice(cursor, index) });
    }
    const key = match[1];
    const value = resolveVariable(key, ctx);
    if (value === undefined) {
      missing.add(key);
      segments.push({ key: segmentKey(key), label: key, text: match[0] });
    } else {
      segments.push({ key: segmentKey(key), label: key, text: value });
    }
    cursor = index + match[0].length;
  }
  if (cursor < source.length) {
    segments.push({ key: 'literal', label: '文本', text: source.slice(cursor) });
  }
  if (!segments.length) segments.push({ key: 'literal', label: '文本', text: '' });

  const text = segments.map((segment) => segment.text).join('');
  const negative = ctx.overrides?.negative ?? ctx.negative ?? '';
  return {
    text,
    negative,
    segments,
    hash: sha256Json({ text, negative }),
    locked: Boolean(locked),
    missingVariables: [...missing],
  };
}
