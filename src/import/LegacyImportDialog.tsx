import { useState } from 'react';
import { importLegacyProject } from '../services/tauri';
import { useStudioStore } from '../stores/studioStore';
import { useBoardStore } from '../stores/boardStore';
import { pickLegacyFile, summarizeImport } from './legacy';

interface Props {
  open: boolean;
  onClose(): void;
}

export function LegacyImportDialog({ open, onClose }: Props) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  if (!open) return null;

  async function choose() {
    try {
      const picked = await pickLegacyFile();
      if (picked) {
        setPath(picked);
        setMessage('');
        setWarnings([]);
        setFailed(false);
      }
    } catch (error) {
      setFailed(true);
      setMessage(`选择文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function run() {
    setBusy(true);
    setMessage('');
    setWarnings([]);
    setFailed(false);
    try {
      const result = await importLegacyProject(path);
      setMessage(summarizeImport(result));
      setWarnings(result.warnings);
      const projectId = result.project?.id;
      const boardId = result.board?.id;
      if (!projectId || !boardId) {
        setFailed(true);
        setMessage('导入失败：导入结果缺少项目或画布标识');
        return;
      }
      // 切换画布前先把当前画布的改动落库，避免未保存的编辑被新画布顶掉。
      await useBoardStore.getState().flush();
      await useStudioStore.getState().boot(true);
      await useStudioStore.getState().selectProject(projectId);
      const board = useStudioStore.getState().boards.find((item) => item.id === boardId);
      if (board) await useStudioStore.getState().selectBoard(board.id);
    } catch (error) {
      setFailed(true);
      setMessage(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="confirm-backdrop" role="dialog" aria-modal="true" aria-label="导入旧项目">
      <div className="confirm-dialog">
        <header>
          <h2>导入旧项目</h2>
          <p className="confirm-sub">读取旧 Frameforge 项目 JSON，素材复制进本地资产库并自动生成一张画布。</p>
        </header>
        <div className="inspector-field">
          <span>项目文件</span>
          <div className="import-path">
            <input readOnly value={path} placeholder="尚未选择文件" />
            <button type="button" className="studio-button secondary" onClick={() => void choose()}>浏览…</button>
          </div>
        </div>
        <p className="inspector-note">导入的节点会被锁定（pinned），改动上游后不会自动重跑，需要手动解锁再生成。</p>
        {message && <p className={failed ? 'import-error' : 'inspector-warning'}>{message}</p>}
        {warnings.length > 0 && (
          <ul className="confirm-warnings">
            {warnings.map((warning, index) => (<li key={`${index}-${warning}`}>{warning}</li>))}
          </ul>
        )}
        <footer className="confirm-actions">
          <button type="button" className="studio-button secondary" onClick={onClose} disabled={busy}>关闭</button>
          <button type="button" className="studio-button" disabled={!path || busy} onClick={() => void run()}>
            {busy ? '导入中…' : '开始导入'}
          </button>
        </footer>
      </div>
    </div>
  );
}
