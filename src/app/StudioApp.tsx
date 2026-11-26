import { useCallback, useEffect, useState } from 'react';
import { Film, FolderKanban, Images, LayoutGrid, Plus, Save, Settings, Trash2 } from 'lucide-react';
import { ProjectLibrary } from './ProjectLibrary';
import { AssetLibrary } from './AssetLibrary';
import { CanvasView } from '../canvas/CanvasView';
import { Inspector } from '../inspector/Inspector';
import { SettingsDialog } from '../settings/SettingsDialog';
import { LegacyImportDialog } from '../import/LegacyImportDialog';
import { attachRunEvents } from '../run/events';
import { RunConfirmDialog } from '../run/RunConfirmDialog';
import { RunQueue } from '../run/RunQueue';
import { resumeJobs, loadBoard } from '../services/tauri';
import { useStudioStore } from '../stores/studioStore';
import { useBoardStore } from '../stores/boardStore';
import { useProviderStore } from '../stores/providerStore';
import { useRunStore } from '../stores/runStore';
import { useAssetStore } from '../stores/assetStore';
import { TimelineDrawer } from '../media/TimelineDrawer';
import { ProductionWorkspace } from '../production/ProductionWorkspace';
import { ConfirmHost } from '../ui/ConfirmHost';
import { confirmAction } from '../ui/confirmStore';
import { Dialog } from '../ui/Dialog';
import { ToastHost } from '../ui/ToastHost';
import { useFlushOnClose } from './useFlushOnClose';

/** 主区域的三种视图：项目总览、画布与时间线、剧本与镜头。 */
type WorkspaceView = 'library' | 'canvas' | 'production';

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
  const removeBoard = useStudioStore((state) => state.removeBoard);
  const legacyImportOpen = useStudioStore((state) => state.legacyImportOpen);
  const closeLegacyImport = useStudioStore((state) => state.closeLegacyImport);
  const board = useBoardStore((state) => state.board);
  const dirty = useBoardStore((state) => state.dirty);
  const saving = useBoardStore((state) => state.saving);
  const lastSavedAt = useBoardStore((state) => state.lastSavedAt);
  const bootProviders = useProviderStore((state) => state.boot);
  const openSettings = useProviderStore((state) => state.openSettings);
  // selector 返回数字，按值比较，不会因为别的运行状态变化而多渲染一次。
  const activeRuns = useRunStore((state) =>
    Object.values(state.runs).filter((item) => item.status === 'queued' || item.status === 'running').length,
  );
  const assetCount = useAssetStore((state) => state.assets.length);
  const loadAssets = useAssetStore((state) => state.load);
  const [view, setView] = useState<WorkspaceView>('canvas');
  const [assetOpen, setAssetOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [queueOpen, setQueueOpen] = useState(false);
  const [resumedJobs, setResumedJobs] = useState(0);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    void bootProviders();
  }, [bootProviders]);

  // 素材跟着项目走：切项目就重新拉，左栏入口的计数才不会串项目。
  useEffect(() => {
    void loadAssets(currentProjectId);
  }, [currentProjectId, loadAssets]);

  // 启动时恢复上次中断的任务：崩溃或重启后，导出、导入等任务不会自己回来。
  useEffect(() => {
    let alive = true;
    void resumeJobs().then((count) => {
      if (alive) setResumedJobs(count);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | undefined;
    void attachRunEvents().then((fn) => {
      if (alive) dispose = fn;
      else fn();
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, []);

  // 关窗前先落库，避免最后 700ms 的改动随窗口一起消失。
  useFlushOnClose();

  // 换画布后从服务端重新取一份，而不是用 studioStore 里的快照：
  // 快照的 revision 可能早于服务端那一份，拿它保存会撞修订冲突。
  useEffect(() => {
    if (!booted || !currentBoardId) return;
    if (useBoardStore.getState().board?.id === currentBoardId) return;
    let alive = true;
    void loadBoard(currentBoardId).then((fresh) => {
      if (!alive || !fresh) return;
      useBoardStore.getState().load(fresh);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [booted, currentBoardId]);

  const project = projects.find((item) => item.id === currentProjectId);

  const openBoard = useCallback(async (id: string) => {
    await useBoardStore.getState().flush();
    const next = await selectBoard(id);
    if (next) {
      useBoardStore.getState().load(next);
      setView('canvas');
    }
  }, [selectBoard]);

  const changeProject = useCallback(async (id: string) => {
    await useBoardStore.getState().flush();
    await selectProject(id);
  }, [selectProject]);

  const addBoard = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    await useBoardStore.getState().flush();
    const next = await createBoard(newBoardName);
    setNewBoardName('');
    setCreating(false);
    if (next) {
      useBoardStore.getState().load(next);
      setView('canvas');
    }
  }, [createBoard, newBoardName]);

  const deleteBoardById = useCallback(async (id: string, name: string) => {
    const confirmed = await confirmAction({
      title: '删除画布',
      message: `确定删除画布「${name}」？`,
      detail: '画布上的节点与连线会一并删除，此操作不可撤销。',
      tone: 'danger',
      confirmText: '删除画布',
    });
    if (!confirmed) return;
    // 删的是当前画布时，先把未保存内容落库，避免误把别的画布的改动写进去。
    if (useBoardStore.getState().board?.id === id) await useBoardStore.getState().flush();
    try {
      await removeBoard(id);
    } catch (issue) {
      useStudioStore.getState().setError(issue instanceof Error ? issue.message : String(issue));
    }
  }, [removeBoard]);

  // Cmd/Ctrl+S 立即保存：防抖保存最长要等 700ms，用户主动保存时不该再等。
  // 上次保存失败过就走重试路径：取回服务端最新修订号重新落库，而不是又撞一次同样的冲突。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      const store = useBoardStore.getState();
      if (store.saveError) void store.retrySave();
      else void store.flush();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 顶栏只报状态：保存中 / 有未保存改动 / 已保存。
  // 失败详情走右下角悬浮提示，不占顶栏常驻。
  const saveLabel = saving
    ? '保存中…'
    : dirty
      ? '有未保存改动'
      : lastSavedAt
        ? `已保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN')}`
        : '已保存';

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
          <span className="dot" /> {saveLabel}
        </span>
      </header>

      <div className="studio-body">
        <aside className="studio-rail">
          {/* 视图切换放在最上面：它是整个应用的一级入口，压在资产库下面会被埋掉。 */}
          <nav className="rail-nav" aria-label="视图切换">
            <button type="button" className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>
              <LayoutGrid size={13} /><span>项目总览</span>
            </button>
            <button type="button" className={view === 'canvas' ? 'active' : ''} onClick={() => setView('canvas')}>
              <FolderKanban size={13} /><span>画布与时间线</span>
            </button>
            <button type="button" className={view === 'production' ? 'active' : ''} onClick={() => setView('production')}>
              <Film size={13} /><span>剧本与镜头</span>
            </button>
          </nav>

          <section className="rail-block">
            <h2>项目</h2>
            <select
              className="rail-select"
              value={currentProjectId ?? ''}
              aria-label="当前项目"
              onChange={(event) => { void changeProject(event.target.value); }}
              disabled={!projects.length}
            >
              {!projects.length && <option value="">尚无项目</option>}
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>

            <span className="rail-sublabel">画布</span>
            <div className="rail-boards">
              {boards.map((item) => {
                // 当前画布用 store 里的实时文档，节点数才不是快照里的旧值。
                const live = item.id === board?.id ? board : item;
                return (
                  <div key={item.id} className={`rail-board-row ${item.id === currentBoardId ? 'active' : ''}`}>
                    <button
                      type="button"
                      className="rail-board-name"
                      title={live.name}
                      onClick={() => { void openBoard(item.id); }}
                    >
                      <span>{live.name}</span>
                      <small>{Object.keys(live.nodes ?? {}).length} 节点</small>
                    </button>
                    <button
                      type="button"
                      className="rail-remove"
                      title={`删除画布「${item.name}」`}
                      aria-label={`删除画布 ${item.name}`}
                      onClick={() => { void deleteBoardById(item.id, item.name); }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
              {!boards.length && <span className="studio-badge">暂无画布</span>}
            </div>

            {creating ? (
              <form className="rail-create" onSubmit={addBoard}>
                <input
                  value={newBoardName}
                  onChange={(event) => setNewBoardName(event.target.value)}
                  placeholder="新画布名称"
                  autoFocus
                  aria-label="新画布名称"
                />
                <button className="studio-button secondary" type="submit">确定</button>
                <button className="studio-button secondary" type="button" onClick={() => { setCreating(false); setNewBoardName(''); }}>取消</button>
              </form>
            ) : (
              <button type="button" className="rail-add" onClick={() => setCreating(true)}>
                <Plus size={12} /> 新建画布
              </button>
            )}
          </section>

          {/* 素材网格体量大，放进窄侧栏会把导航挤到看不见。改成入口 + 左侧抽屉。 */}
          <button type="button" className="rail-entry" onClick={() => setAssetOpen(true)}>
            <Images size={13} />
            <span>资产库</span>
            <span className="studio-badge">{assetCount}</span>
          </button>

          <div className="studio-rail-foot">
            <button className="studio-button secondary" onClick={() => { void useBoardStore.getState().flush(); }}>
              <Save size={13} /> 立即保存
            </button>
          </div>
        </aside>

        <main className="studio-main">
          {view === 'production' ? (
            <ProductionWorkspace projectId={currentProjectId ?? undefined} boardId={currentBoardId ?? undefined} />
          ) : view === 'canvas' && board ? (
            <>
              <CanvasView key={board.id} />
              <TimelineDrawer projectId={currentProjectId ?? undefined} boardId={board.id} />
            </>
          ) : (
            <ProjectLibrary onOpenBoard={(id) => { void openBoard(id); }} />
          )}
        </main>

        <Inspector />
      </div>

      <SettingsDialog />

      <RunConfirmDialog />

      {/* 全局确认框：替代原生 window.confirm，样式与焦点行为和应用内弹窗一致。 */}
      <ConfirmHost />

      {/* 悬浮提示：保存失败这类临时信息走右下角，几秒后自动消失。 */}
      <ToastHost />

      {/* 资产库抽屉：贴左侧展开，Esc 或点遮罩关闭，焦点行为与其它弹窗一致。 */}
      <Dialog
        open={assetOpen}
        onClose={() => setAssetOpen(false)}
        placement="left"
        label="资产库"
        className="asset-drawer"
      >
        <AssetLibrary projectId={currentProjectId ?? undefined} onClose={() => setAssetOpen(false)} />
      </Dialog>

      {/* 导入对话框挂在应用壳上：导入完成后画布会替换项目库，对话框留在壳里才能继续展示告警。 */}
      <LegacyImportDialog open={legacyImportOpen} onClose={closeLegacyImport} />

      <footer className="studio-dock">
        <span>{board ? board.name : '未打开画布'}</span>
        <span>{Object.keys(board?.nodes ?? {}).length} 个节点</span>
        <span>{Object.keys(board?.edges ?? {}).length} 条连线</span>
        <button type="button" className="studio-dock-link" onClick={() => setQueueOpen(true)}>
          {activeRuns > 0 ? `${activeRuns} 个任务进行中` : '任务面板'}
        </button>
        {resumedJobs > 0 && <span className="busy">已恢复 {resumedJobs} 个中断任务</span>}
        {error && <span className="error">{error}</span>}
      </footer>

      <RunQueue open={queueOpen} onClose={() => setQueueOpen(false)} />
    </div>
  );
}
