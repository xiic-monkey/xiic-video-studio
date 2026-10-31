import { useState } from 'react';
import { FileInput, FolderKanban, LayoutGrid, Plus } from 'lucide-react';
import type { StudioProject } from '../domain/types';
import { useStudioStore } from '../stores/studioStore';

interface Props {
  onOpenBoard(boardId: string): void;
}

export function ProjectLibrary({ onOpenBoard }: Props) {
  const projects = useStudioStore((state) => state.projects);
  const boards = useStudioStore((state) => state.boards);
  const currentProjectId = useStudioStore((state) => state.currentProjectId);
  const createProject = useStudioStore((state) => state.createProject);
  const createBoard = useStudioStore((state) => state.createBoard);
  const openLegacyImport = useStudioStore((state) => state.openLegacyImport);
  const [name, setName] = useState('');
  const [ratio, setRatio] = useState<StudioProject['aspectRatio']>('9:16');
  const [boardName, setBoardName] = useState('');
  const [busy, setBusy] = useState(false);

  const current = projects.find((project) => project.id === currentProjectId);

  async function submitProject(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await createProject(name, ratio);
      setName('');
    } finally {
      setBusy(false);
    }
  }

  async function submitBoard(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const board = await createBoard(boardName);
      setBoardName('');
      if (board) onOpenBoard(board.id);
    } finally {
      setBusy(false);
    }
  }

  if (!current) {
    return (
      <div className="studio-library">
        <form className="studio-onboarding" onSubmit={submitProject}>
          <span className="studio-eyebrow">Frameforge · 画布优先</span>
          <h1>新建第一个项目</h1>
          <p>项目承载画布、提示词与资产。所有生成都由你手动触发，密钥只保存在系统钥匙串。</p>
          <label className="studio-field">
            <span>项目名</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：雨夜追凶" autoFocus />
          </label>
          <label className="studio-field">
            <span>画幅</span>
            <select value={ratio} onChange={(event) => setRatio(event.target.value as StudioProject['aspectRatio'])}>
              <option value="9:16">9:16 竖屏短剧</option>
              <option value="16:9">16:9 横屏</option>
              <option value="1:1">1:1 方形</option>
            </select>
          </label>
          <button className="studio-button" type="submit" disabled={busy}>
            <Plus size={14} /> {busy ? '创建中…' : '创建项目'}
          </button>
          <button type="button" className="studio-button secondary" onClick={() => openLegacyImport()}>
            <FileInput size={13} /> 导入旧项目
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="studio-library">
      <div className="studio-library-head">
        <div>
          <span className="studio-eyebrow">项目库</span>
          <h1>{current.name}</h1>
          <p>{current.aspectRatio} · {boards.length} 张画布 · 画布优先工作台</p>
        </div>
        <span className="studio-badge mint">项目 {current.id.slice(-6)}</span>
      </div>
      <div className="studio-board-grid">
        {boards.map((board) => (
          <button key={board.id} className="studio-board-card" onClick={() => onOpenBoard(board.id)}>
            <span><LayoutGrid size={13} /> {Object.keys(board.nodes).length} 节点 · {Object.keys(board.edges).length} 连线</span>
            <b>{board.name}</b>
            <span>{new Date(board.updatedAt).toLocaleString('zh-CN')}</span>
            <span className="open">打开画布 →</span>
          </button>
        ))}
        {!boards.length && (
          <div className="studio-board-card">
            <span><FolderKanban size={13} /> 还没有画布</span>
            <b>从下方创建第一张画布</b>
          </div>
        )}
      </div>
      <form className="studio-board-create" onSubmit={submitBoard}>
        <input value={boardName} onChange={(event) => setBoardName(event.target.value)} placeholder="新画布名称，例如：第一集" />
        <button className="studio-button secondary" type="submit" disabled={busy}>
          <Plus size={14} /> 新建画布
        </button>
      </form>
      <div className="studio-library-actions">
        <button type="button" className="studio-button secondary" onClick={() => openLegacyImport()}>
          <FileInput size={13} /> 导入旧项目
        </button>
      </div>
    </div>
  );
}
