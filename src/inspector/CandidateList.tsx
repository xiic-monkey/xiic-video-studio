import type { RunRecord } from '../domain/types';
import { statusOf } from '../nodes/summary';
import { useAssetUrl } from '../nodes/useAssetUrl';
import { useTextAsset } from '../nodes/useTextAsset';
import type { CandidateKind } from './model';

interface CandidateListProps {
  run?: RunRecord;
  kind: CandidateKind;
  busy: boolean;
  onSelect(assetId: string): void;
}

interface CandidateThumbProps {
  assetId: string;
  kind: CandidateKind;
  index: number;
  selected: boolean;
  busy: boolean;
  onSelect(): void;
}

function CandidateThumb({ assetId, kind, index, selected, busy, onSelect }: CandidateThumbProps) {
  const url = useAssetUrl(kind === 'text' ? undefined : assetId);
  const text = useTextAsset(kind === 'text' ? assetId : undefined);
  return (
    <div className={`candidate-card${selected ? ' is-selected' : ''}`}>
      {kind === 'audio' ? (
        <div className="candidate-media candidate-audio">
          {url ? <audio src={url} controls preload="metadata" /> : <span className="candidate-placeholder">音频</span>}
        </div>
      ) : (
        <button
          type="button"
          className="candidate-media"
          onClick={onSelect}
          disabled={busy}
          aria-label={`选择候选 ${index + 1}`}
        >
          {kind === 'image' && (url ? <img src={url} alt="" draggable={false} /> : <span className="candidate-placeholder">图片</span>)}
          {kind === 'video' && (url ? <video src={url} muted playsInline preload="metadata" /> : <span className="candidate-placeholder">视频</span>)}
          {kind === 'text' && <span className="candidate-text">{text || '文本结果'}</span>}
          {selected && <i className="candidate-check">已选</i>}
        </button>
      )}
      <div className="candidate-meta">
        <span>#{index + 1}</span>
        <button type="button" onClick={onSelect} disabled={busy}>{selected ? '当前' : '选择'}</button>
      </div>
    </div>
  );
}

export function CandidateList({ run, kind, busy, onSelect }: CandidateListProps) {
  if (!run) return <p className="inspector-note">运行完成后在这里选择候选。</p>;
  if (run.status === 'queued' || run.status === 'running') {
    return <p className="inspector-note">{statusOf(run).label}…完成后在这里选择候选。</p>;
  }
  if (run.status === 'failed') {
    return <p className="inspector-warning">最近一次运行失败：{run.error?.message ?? '未知错误'}</p>;
  }
  if (run.status === 'cancelled') return <p className="inspector-note">最近一次运行已取消。</p>;
  if (!run.outputAssetIds.length) return <p className="inspector-note">这次运行没有输出。</p>;
  return (
    <div className="candidate-grid">
      {run.outputAssetIds.map((assetId, index) => (
        <CandidateThumb
          key={assetId}
          assetId={assetId}
          kind={kind}
          index={index}
          selected={run.selectedAssetId === assetId}
          busy={busy}
          onSelect={() => onSelect(assetId)}
        />
      ))}
    </div>
  );
}
