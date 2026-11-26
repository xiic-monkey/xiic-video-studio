import { useMemo, useState } from 'react';
import { CircleSlash, History, X } from 'lucide-react';
import { useRunStore } from '../stores/runStore';
import { useRunController } from '../run/controller';
import { statusOf } from '../nodes/summary';
import { Dialog } from '../ui/Dialog';

interface RunQueueProps {
  open: boolean;
  onClose(): void;
}

/**
 * 全局任务面板。
 *
 * 以前 dock 只有一句「N 个任务进行中」，看不到进度、日志，也没法取消。
 * 这里列出全部运行记录：进行中的可取消，历史的可查状态与耗时。
 */
export function RunQueue({ open, onClose }: RunQueueProps) {
  const runs = useRunStore((state) => state.runs);
  const cancelRun = useRunController((state) => state.cancelRun);
  const [showFinished, setShowFinished] = useState(false);

  const list = useMemo(() => Object.values(runs).sort(
    (left, right) => right.startedAt.localeCompare(left.startedAt),
  ), [runs]);
  const active = list.filter((run) => run.status === 'queued' || run.status === 'running');
  const finished = list.filter((run) => run.status !== 'queued' && run.status !== 'running');
  const visible = showFinished ? list : active;

  return (
    <Dialog open={open} onClose={onClose} label="任务面板" className="run-queue-dialog">
      <header className="settings-head">
        <h2>任务面板</h2>
        <button type="button" className="studio-icon-button" title="关闭" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="run-queue-body">
        {!list.length && <p className="inspector-note">还没有任何运行记录。</p>}
        {visible.map((run) => {
          const badge = statusOf(run);
          const cancellable = run.status === 'queued' || run.status === 'running';
          return (
            <div className="run-queue-row" key={run.id}>
              <span className={`run-dot tone-${badge.tone}`} />
              <span className="run-queue-title">{run.nodeId.slice(-8)}</span>
              <span className={`flow-status tone-${badge.tone}`}>{badge.label}</span>
              <span className="run-time">{new Date(run.startedAt).toLocaleTimeString('zh-CN')}</span>
              {cancellable && (
                <button
                  type="button"
                  className="studio-button secondary"
                  title="取消这个运行"
                  onClick={() => { void cancelRun(run.nodeId); }}
                >
                  <CircleSlash size={12} /> 取消
                </button>
              )}
            </div>
          );
        })}
        {!visible.length && list.length > 0 && (
          <p className="inspector-note">当前没有进行中的任务。</p>
        )}
      </div>
      <footer className="run-queue-foot">
        <button type="button" className="studio-button secondary" onClick={() => setShowFinished((value) => !value)}>
          <History size={13} /> {showFinished ? '只看进行中' : `显示历史（${finished.length}）`}
        </button>
      </footer>
    </Dialog>
  );
}
