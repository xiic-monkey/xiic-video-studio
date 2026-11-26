import { useState } from 'react';
import { Download, FileInput, FolderKanban, LayoutGrid, Plus, Trash2 } from 'lucide-react';
import type { StudioProject } from '../domain/types';
import { exportProject, pickExportDirectory, pickExportPath } from '../services/tauri';
import { useStudioStore } from '../stores/studioStore';
import { confirmAction } from '../ui/confirmStore';
import { safeExportDirName, safeExportName } from './exportName';

interface Props {
  onOpenBoard(boardId: string): void;
}

/** 导出模式的分段按钮：选中态用描边和文字颜色区分，不另起一套控件。 */
export function ProjectLibrary({ onOpenBoard }: Props) {
  const projects = useStudioStore((state) => state.projects);
  const boards = useStudioStore((state) => state.boards);
  const currentProjectId = useStudioStore((state) => state.currentProjectId);
  const createProject = useStudioStore((state) => state.createProject);
  const createBoard = useStudioStore((state) => state.createBoard);
  const removeProject = useStudioStore((state) => state.removeProject);
  const openLegacyImport = useStudioStore((state) => state.openLegacyImport);
  const [name, setName] = useState('');
  const [ratio, setRatio] = useState<StudioProject['aspectRatio']>('9:16');
  const [boardName, setBoardName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  /** 导出模式：false 只导元数据 JSON，true 连带素材文件本体。 */
  const [includeAssets, setIncludeAssets] = useState(false);

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

  async function exportCurrent() {
    if (!current || busy) return;
    setBusy(true);
    setNotice('');
    try {
      if (includeAssets) {
        // 含素材导出：目标是一个目录，目录里放 project.json 与 assets/。
        let folder: string | null = null;
        try {
          folder = await pickExportDirectory();
        } catch {
          // 目录选择不可用：退回文件保存，只导出元数据，并说明发生了什么。
          setIncludeAssets(false);
          const fallback = await pickExportPath(safeExportName(current));
          if (!fallback) return;
          const summary = await exportProject(current.id, fallback);
          setNotice(`当前环境不支持选择目录，已改为仅导出元数据：${summary.path}`);
          return;
        }
        if (!folder) return;
        const target = `${folder.replace(/[\\/]+$/, '')}/${safeExportDirName(current)}`;
        const summary = await exportProject(current.id, target, { includeAssets: true });
        setNotice(
          `已导出 ${summary.boards} 张画布 / ${summary.runs} 次运行 / ${summary.assets} 个素材到 ${target}；` +
          '目录内含 project.json 与 assets/ 素材文件本体，迁移到别的机器可直接用。',
        );
        return;
      }
      const target = await pickExportPath(safeExportName(current));
      if (!target) return;
      const summary = await exportProject(current.id, target);
      setNotice(`已导出 ${summary.boards} 张画布 / ${summary.runs} 次运行 / ${summary.assets} 个资产索引；包内不含密钥与素材文件本体。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject(project: StudioProject) {
    const confirmed = await confirmAction({
      title: '删除项目',
      message: `确定删除项目「${project.name}」？`,
      detail: '项目下的画布、剧本、主体、镜头与资产关联会一并删除。此操作不可撤销。',
      tone: 'danger',
      confirmText: '删除项目',
    });
    if (!confirmed) return;
    try {
      await removeProject(project.id);
      setNotice(`已删除项目「${project.name}」`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
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
        <div className="studio-library-head-actions">
          <span className="studio-badge mint">项目 {current.id.slice(-6)}</span>
          <div className="studio-segmented" role="group" aria-label="导出内容">
            <button
              type="button"
              className={`studio-segment ${includeAssets ? '' : 'active'}`}
              aria-pressed={!includeAssets}
              onClick={() => setIncludeAssets(false)}
            >
              仅元数据
            </button>
            <button
              type="button"
              className={`studio-segment ${includeAssets ? 'active' : ''}`}
              aria-pressed={includeAssets}
              onClick={() => setIncludeAssets(true)}
            >
              含素材
            </button>
          </div>
          <button type="button" className="studio-button secondary" disabled={busy} onClick={() => { void exportCurrent(); }}>
            <Download size={13} /> 导出项目
          </button>
        </div>
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
      {projects.length > 1 && (
        <section className="studio-project-list">
          <h2>全部项目</h2>
          {projects.map((project) => (
            <div key={project.id} className={`studio-project-row ${project.id === currentProjectId ? 'active' : ''}`}>
              <span className="studio-project-name">{project.name}</span>
              <span className="studio-project-meta">{project.aspectRatio}</span>
              <button
                type="button"
                className="studio-list-remove"
                title={`删除项目「${project.name}」`}
                aria-label={`删除项目 ${project.name}`}
                onClick={() => { void deleteProject(project); }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </section>
      )}
      {notice && <p className="studio-notice">{notice}</p>}
    </div>
  );
}
