import type { BoardNode } from '../types';

/**
 * 剧本节点的内容语义。
 *
 * 剧本节点是「内容节点」：它的输出就是节点里写着的正文与节拍，
 * 不需要先跑一次；跑一次的结果也会回填到这两个字段里。
 * 所以下游读到的永远是节点字段，而不是某次运行的产物。
 */

/** 剧本节点的两个输出端口。 */
export type ScriptPort = 'script' | 'beats';

/** 节点字段里的剧本内容。 */
export function scriptContent(node: BoardNode | undefined): { script: string; beats: string } {
  if (!node || node.type !== 'script') return { script: '', beats: '' };
  return {
    script: String(node.data.body ?? ''),
    beats: String(node.data.beats ?? ''),
  };
}

/**
 * 解析运行产物。
 *
 * 模型按规范输出 JSON；解析不出 JSON 时按纯文本兜底：
 * 正文取全文，节拍留空（不猜，免得把正文当成节拍）。
 */
export function parseScriptPayload(text: string): { script: string; beats: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // 模型偶尔会在 JSON 外面裹一层 ```json 代码块。
  const fenced = trimmed.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { script: trimmed, beats: '' };
  }
  if (!parsed || typeof parsed !== 'object') return { script: trimmed, beats: '' };
  const record = parsed as Record<string, unknown>;
  const script = typeof record.script === 'string' ? record.script : '';
  const beats = beatsToText(record.beats);
  if (!script && !beats) return { script: trimmed, beats: '' };
  return { script: script || trimmed, beats };
}

/** 节拍数组转成「每行一条」的文本。 */
export function beatsToText(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
      .map((item, index) => `${index + 1}. ${item}`)
      .join('\n');
  }
  if (typeof value === 'string') return value.trim();
  return '';
}

/**
 * 从一段文本里取某个输出端口的内容。
 *
 * 只对剧本节点有意义：JSON 产物按端口取字段，纯文本产物按端口兜底。
 */
export function scriptTextForPort(text: string, portKey: string): string {
  const payload = parseScriptPayload(text);
  if (!payload) return '';
  return portKey === 'beats' ? payload.beats : payload.script;
}
