import type { RunRecord } from '../domain/types';
import { statusOf } from '../nodes/summary';

export function RunHistory({ runs }: { runs: RunRecord[] }) {
  if (!runs.length) return <p className="inspector-note">还没有运行记录。</p>;
  return (
    <div className="run-history">
      {runs.map((run) => (
        <div className="run-row" key={run.id}>
          <span className={`run-dot tone-${statusOf(run).tone}`} />
          <span>{statusOf(run).label}</span>
          <span className="run-time">{new Date(run.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="run-model" title={run.model ?? run.action}>{run.model ?? run.action}</span>
          {run.error && <span className="run-error">{run.error.message}</span>}
        </div>
      ))}
    </div>
  );
}
