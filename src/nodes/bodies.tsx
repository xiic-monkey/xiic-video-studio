import type { ReactElement } from 'react';
import type { BoardNode, RunRecord } from '../domain/types';
import { modeLabel, outputAssetId, statusOf, summarizeNode } from './summary';
import { useAssetUrl } from './useAssetUrl';

interface BodyProps {
  node: BoardNode;
  run?: RunRecord;
}

function Meta({ items }: { items: Array<string | undefined | false> }) {
  const visible = items.filter(Boolean) as string[];
  if (!visible.length) return null;
  return (
    <div className="flow-meta">
      {visible.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
    </div>
  );
}

export function TextBody({ node }: BodyProps) {
  return (
    <div className="flow-body">
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[modeLabel(node.data.mode)]} />
    </div>
  );
}

export function ImageBody({ node, run }: BodyProps) {
  const url = useAssetUrl(outputAssetId(run));
  return (
    <div className="flow-body">
      {url
        ? <img className="flow-media" src={url} alt="" draggable={false} />
        : <div className="flow-media flow-media-empty"><span>暂无图片</span></div>}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[
        String(node.data.size ?? ''),
        `${Number(node.data.count ?? 1)} 张候选`,
        run?.status === 'running' ? `${statusOf(run).label}…` : undefined,
      ]} />
    </div>
  );
}

export function VideoBody({ node, run }: BodyProps) {
  const url = useAssetUrl(outputAssetId(run));
  return (
    <div className="flow-body">
      {url
        ? <video className="flow-media" src={url} muted playsInline preload="metadata" />
        : <div className="flow-media flow-media-empty"><span>暂无视频</span></div>}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[
        modeLabel(node.data.mode),
        `${Number(node.data.duration ?? 0)}s`,
        String(node.data.resolution ?? ''),
        String(node.data.aspectRatio ?? ''),
      ]} />
    </div>
  );
}

export function AudioBody({ node, run }: BodyProps) {
  const url = useAssetUrl(outputAssetId(run));
  const text = String(node.data.text ?? '');
  const bars = Array.from({ length: 28 }, (_, index) => {
    const code = text.charCodeAt(index % Math.max(text.length, 1)) || 58;
    return 18 + (code % 62);
  });
  return (
    <div className="flow-body">
      {url
        ? <audio className="flow-audio nodrag" src={url} controls preload="metadata" />
        : <div className="flow-wave" aria-hidden="true">{bars.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[String(node.data.voice ?? ''), String(node.data.format ?? '').toUpperCase()]} />
    </div>
  );
}

export function ScriptBody({ node }: BodyProps) {
  const body = String(node.data.body ?? '');
  const lines = body.split(/\n+/).filter((line) => line.trim()).length;
  return (
    <div className="flow-body">
      <p className="flow-title">{String(node.data.title ?? '').trim() || '未命名剧本'}</p>
      <p className="flow-quote">{summarizeNode(node, 120)}</p>
      <Meta items={[`${lines} 段`]} />
    </div>
  );
}

export function NoteBody({ node }: BodyProps) {
  return (
    <div className={`flow-body flow-note flow-note-${String(node.data.color ?? 'default')}`}>
      <p className="flow-quote">{summarizeNode(node, 140)}</p>
    </div>
  );
}

export function GroupBody({ node }: BodyProps) {
  return (
    <div className="flow-body flow-group-body">
      <p className="flow-title">{String(node.data.label ?? '').trim() || '分组'}</p>
      <Meta items={['框选节点后 Cmd/Ctrl+G 编组']} />
    </div>
  );
}

export type NodeBody = (props: BodyProps) => ReactElement;

export const BODIES: Record<string, NodeBody> = {
  text: TextBody,
  image: ImageBody,
  video: VideoBody,
  audio: AudioBody,
  script: ScriptBody,
  note: NoteBody,
  group: GroupBody,
};
