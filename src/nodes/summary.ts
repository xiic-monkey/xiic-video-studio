import type { BoardNode, RunRecord } from '../domain/types';

const MODE_LABEL: Record<string, string> = {
  t2v: '文生视频', firstLast: '首尾帧', reference: '全能参考',
  generate: '生成', rewrite: '改写',
};

export function summarizeNode(node: BoardNode, max = 96): string {
  const raw = node.data.prompt ?? node.data.text ?? node.data.body ?? node.data.label ?? '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return '空节点';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function modeLabel(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  return MODE_LABEL[String(value)] ?? String(value);
}

export type RunTone = 'idle' | 'busy' | 'ok' | 'error' | 'cancelled';

export interface RunBadge {
  label: string;
  tone: RunTone;
}

export function statusOf(run?: RunRecord): RunBadge {
  if (!run) return { label: '未运行', tone: 'idle' };
  switch (run.status) {
    case 'queued': return { label: '排队中', tone: 'busy' };
    case 'running': return { label: '生成中', tone: 'busy' };
    case 'succeeded': return { label: '完成', tone: 'ok' };
    case 'failed': return { label: '失败', tone: 'error' };
    case 'cancelled': return { label: '已取消', tone: 'cancelled' };
  }
}

export function outputAssetId(run?: RunRecord): string | undefined {
  if (!run || run.status !== 'succeeded') return undefined;
  return run.selectedAssetId ?? run.outputAssetIds[0];
}

export function durationLabel(run?: RunRecord): string {
  if (!run?.finishedAt) return '';
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '<1s';
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function indexLatest(runs: RunRecord[]): Record<string, string> {
  const latest: Record<string, string> = {};
  const sorted = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const run of sorted) latest[run.nodeId] = run.id;
  return latest;
}
