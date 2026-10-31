import { useEffect, useState } from 'react';
import { FolderKanban, Plus, Save, Settings } from 'lucide-react';
import { ProjectLibrary } from './ProjectLibrary';
import { CanvasView } from '../canvas/CanvasView';
import { Inspector } from '../inspector/Inspector';
import { SettingsDialog } from '../settings/SettingsDialog';
import { useStudioStore } from '../stores/studioStore';
import { useBoardStore } from '../stores/boardStore';
import { useProviderStore } from '../stores/providerStore';

export function StudioApp() {
  const boot = useStudioStore((state) => state.boot);
  const booted = useStudioStore((state) => state.booted);
  const error = useStudioStore((state) => state.error);
  const projects = useStudioStore((state) => state.projects);
  const boards = useStudioStore((state) => state.boards);
  const currentProjectId = useStudioStore((state) => state.currentProjectId);
  const currentBoardId = useStudioStore((state) => state.currentBoardId);
  const selectProject = useStudioStore((state) => state.selectProject);
  const selectBoard = useStudioStore((state) => state.selectBoard);
  const createBoard = useStudioStore((state) => state.createBoard);
  const board = useBoardStore((state) => state.board);
  const dirty = useBoardStore((state) => state.dirty);
  const saving = useBoardStore((state) => state.saving);
  const saveError = useBoardStore((state) => state.saveError);
  const lastSavedAt = useBoardStore((state) => state.lastSavedAt);
  const bootProviders = useProviderStore((state) => state.boot);
  const openSettings = useProviderStore((state) => state.openSettings);
  const [newBoardName, setNewBoardName] = useState('');

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    void bootProviders();
  }, [bootProviders]);

  useEffect(() => {
    if (!booted || !currentBoardId) return;
    if (useBoardStore.getState().board?.id === currentBoardId) return;
    const snapshot = boards.find((item) => item.id === currentBoardId);
    if (snapshot) useBoardStore.getState().load(snapshot);
  }, [booted, currentBoardId, boards]);

  const project = projects.find((item) => item.id === currentProjectId);

  async function openBoard(id: string) {
    await useBoardStore.getState().flush();
    const next = await selectBoard(id);
    if (next) useBoardStore.getState().load(next);
  }

  async function changeProject(id: string) {
    await useBoardStore.getState().flush();
    await selectProject(id);
  }

  async function addBoard(event: React.FormEvent) {
    event.preventDefault();
    await useBoardStore.getState().flush();
    const next = await createBoard(newBoardName);
    setNewBoardName('');
    if (next) useBoardStore.getState().load(next);
  }

  const saveLabel = saving ? '保存中…' : dirty ? '有未保存改动' : lastSavedAt ? `已保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN')}` : '已保存';

  return (
    <div className="studio-shell">
      <header className="studio-topbar">
        <div className="studio-brand"><span className="studio-brand-mark">F</span> FRAMEFORGE</div>
        <div className="studio-crumbs">
          <FolderKanban size={13} />
          <b>{project?.name ?? '未选择项目'}</b>
          <span>/</span>
          <b>{board?.name ?? '未选择画布'}</b>
        </div>
        <div className="studio-topbar-spacer" />
        <button type="button" className="studio-icon-button" title="设置" onClick={openSettings}>
          <Settings size={15} />
        </button>
        <span className={`studio-save-state ${saving ? 'saving' : dirty ? 'dirty' : ''}`}>
          <span className="dot" /> {saveError ? `保存失败：${saveError}` : saveLabel}
        </span>
      </header>

      <div className="studio-body">
        <aside className="studio-rail">
          <section>
            <h2>项目</h2>
            <label className="studio-field">
              <span>当前项目</span>
              <select
                value={currentProjectId ?? ''}
                onChange={(event) => { void changeProject(event.target.value); }}
                disabled={!projects.length}
              >
                {!projects.length && <option value="">尚无项目</option>}
                {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          </section>
          <section>
            <h2>画布</h2>
            <div className="studio-list">
              {boards.map((item) => (
                <button
                  key={item.id}
                  className={item.id === currentBoardId ? 'active' : ''}
                  onClick={() => { void openBoard(item.id); }}
                >
                  <Plus size={12} />
                  <span>{item.name}</span>
                </button>
              ))}
              {!boards.length && <span className="studio-badge">暂无画布</span>}
            </div>
            <form className="studio-board-create" onSubmit={addBoard}>
              <input value={newBoardName} onChange={(event) => setNewBoardName(event.target.value)} placeholder="新画布名称" />
              <button className="studio-button secondary" type="submit" aria-label="新建画布"><Plus size={14} /></button>
            </form>
          </section>
          <div className="studio-rail-foot">
            <button className="studio-button secondary" onClick={() => { void useBoardStore.getState().flush(); }}>
              <Save size={13} /> 立即保存
            </button>
          </div>
        </aside>

        <main className="studio-main">
          {board ? (
            <CanvasView key={board.id} />
          ) : (
            <ProjectLibrary onOpenBoard={(id) => { void openBoard(id); }} />
          )}
        </main>

        <Inspector />
      </div>

      <SettingsDialog />

      <footer className="studio-dock">
        <span>{board ? `board ${board.id.slice(-8)}` : 'no-board'}</span>
        <span>{Object.keys(board?.nodes ?? {}).length} nodes</span>
        <span>{Object.keys(board?.edges ?? {}).length} edges</span>
        {error && <span className="error">{error}</span>}
      </footer>
    </div>
  );
}
