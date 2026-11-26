import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  type Connection, type EdgeChange, type NodeChange, useReactFlow, useStore,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronDown } from 'lucide-react';
import { newId } from '../domain/ids';
import { createNode, edgeRoleFor, getNodeDefinition, sourceNodeKindFor, sourceNodeType } from '../domain/nodes/definitions';
import { makeEdge } from '../domain/graph/commands';
import { validateConnection } from '../domain/graph/validate';
import { useBoardStore } from '../stores/boardStore';
import { useRunStore } from '../stores/runStore';
import { useStaleNodeIds } from '../run/useStaleNodeIds';
import { useRunController } from '../run/controller';
import { nodeTypes } from '../nodes/registry';
import { importClipboardImage, importImageBytes, importMediaPaths, isTauri, type ImportedPath } from '../services/tauri';
import { hasImageInDataTransfer, imageBytesFromDataTransfer, toBase64 } from '../media/clipboardImage';
import { useAssetStore } from '../stores/assetStore';
import { useStudioStore } from '../stores/studioStore';
import { danglingEdgeCount, nodeColor, recordMeasured, subscribeMeasured, toFlowEdges, toFlowNodes } from './mapping';
import * as clipboard from './clipboard';

/**
 * 节点类型分组。
 *
 * 16 种节点平铺在一条工具栏上，1080px 窗口下必然拥挤。
 * 按「生成 / 角色 / 镜头 / 辅助」分组后，工具栏只剩四个入口。
 */
const NODE_GROUPS = [
  { id: 'generate', label: '生成', types: ['text', 'image', 'video', 'audio', 'script'] },
  { id: 'character', label: '角色', types: ['character', 'expression', 'variant', 'turnaround'] },
  { id: 'shot', label: '镜头', types: ['storyboard', 'coverage', 'continuity', 'redraw', 'inpaint'] },
  { id: 'source', label: '素材', types: ['image_source', 'video_source', 'audio_source', 'text_source'] },
  { id: 'assist', label: '辅助', types: ['note', 'group'] },
] as const;

/** 素材能接的输入端口，按优先级排（越小越优先）。 */
const PORT_PRIORITY: Record<string, number> = {
  references: 0, style: 1, start: 2, end: 3,
  referenceVideo: 0, referenceAudio: 0,
};

/**
 * 文件扩展名 → 素材类型。
 *
 * 口径与后端 `kind_for_path` 一致：后端不认的格式就别往里导，
 * 否则会出现「文件拖进来了但导入失败」的白跑一趟。
 */
const FILE_KIND: Record<string, 'image' | 'video' | 'audio'> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image',
  mp4: 'video', mov: 'video',
  wav: 'audio', mp3: 'audio', m4a: 'audio',
};

function kindOfFile(path: string): 'image' | 'video' | 'audio' | undefined {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return FILE_KIND[extension];
}

function CanvasInner() {
  const board = useBoardStore((state) => state.board);
  const notice = useBoardStore((state) => state.notice);
  const noticeTone = useBoardStore((state) => state.noticeTone);
  const selectedNodeIds = useBoardStore((state) => state.selectedNodeIds);
  const selectedIsGroup = useBoardStore((state) => {
    const id = state.selectedNodeId;
    return Boolean(id && state.board?.nodes[id]?.type === 'group');
  });
  const canUndo = useBoardStore((state) => state.past.length > 0);
  const canRedo = useBoardStore((state) => state.future.length > 0);
  const { screenToFlowPosition, getZoom } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const staleNodeIds = useStaleNodeIds();
  const requestRunBatch = useRunController((state) => state.requestRunBatch);
  const [openGroup, setOpenGroup] = useState<string>();
  // 拖着图片悬在画布上：给一句提示，让人知道松手会发生什么。
  const [dropActive, setDropActive] = useState(false);
  // measured 变了要重建 userNode（minimap 依赖它算包围盒），所以订阅一下。
  const [measuredTick, bumpMeasured] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeMeasured(bumpMeasured), []);
  const nodes = useMemo(
    () => (board ? toFlowNodes(board, selectedNodeIds, staleNodeIds) : []),
    [board, selectedNodeIds, staleNodeIds, measuredTick],
  );
  const edges = useMemo(() => (board ? toFlowEdges(board) : []), [board]);
  const dangling = board ? danglingEdgeCount(board) : 0;

  useEffect(() => {
    void useRunStore.getState().load(board?.id);
  }, [board?.id]);

  const groupSelection = useCallback(() => {
    const store = useBoardStore.getState();
    if (!store.board || store.selectedNodeIds.length < 2) return;
    const zoom = getZoom() || 1;
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const nodeId of store.selectedNodeIds) {
      const element = wrapper.current?.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      sizes[nodeId] = { width: rect.width / zoom, height: rect.height / zoom };
    }
    store.apply({
      type: 'group',
      groupId: newId('node'),
      childIds: store.selectedNodeIds,
      label: '新分组',
      sizes,
    });
    store.selectMany([]);
  }, [getZoom]);

  const ungroupSelection = useCallback(() => {
    const store = useBoardStore.getState();
    const groupId = store.selectedNodeId;
    if (!groupId || store.board?.nodes[groupId]?.type !== 'group') return;
    store.apply({ type: 'ungroup', groupId });
    store.selectMany([]);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        useBoardStore.getState().apply({ type: 'moveNode', nodeId: change.id, position: change.position }, { history: false });
      } else if (change.type === 'remove') {
        useBoardStore.getState().apply({ type: 'removeNode', nodeId: change.id });
      }
    }
    const selects = changes.filter((change) => change.type === 'select');
    if (selects.length) {
      const next = new Set(useBoardStore.getState().selectedNodeIds);
      for (const change of selects) {
        if (change.type !== 'select') continue;
        if (change.selected) next.add(change.id); else next.delete(change.id);
      }
      useBoardStore.getState().selectMany([...next]);
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === 'remove') {
        useBoardStore.getState().apply({ type: 'disconnect', edgeId: change.id });
      }
    }
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const store = useBoardStore.getState();
    const doc = store.board;
    if (!doc || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const issues = validateConnection(doc, connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
    const error = issues.find((issue) => issue.severity === 'error');
    if (error) {
      store.notify(error.message);
      return;
    }
    const sourceDef = getNodeDefinition(doc.nodes[connection.source].type);
    const targetDef = getNodeDefinition(doc.nodes[connection.target].type);
    const sourcePort = sourceDef?.outputs.find((port) => port.key === connection.sourceHandle);
    const targetPort = targetDef?.inputs.find((port) => port.key === connection.targetHandle);
    if (!sourcePort || !targetPort) return;
    store.apply({
      type: 'connect',
      edge: makeEdge(connection.source, connection.sourceHandle, connection.target, connection.targetHandle, edgeRoleFor(sourcePort, targetPort)),
    });
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/frameforge-node');
    if (!type || !getNodeDefinition(type)) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const node = createNode(type, position);
    useBoardStore.getState().apply({ type: 'addNode', node });
    useBoardStore.getState().select(node.id);
  }, [screenToFlowPosition]);

  function addAtCenter(type: string) {
    const rect = wrapper.current?.getBoundingClientRect();
    const center = rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 80, y: 80 };
    const node = createNode(type, { x: center.x - 132, y: center.y - 100 });
    useBoardStore.getState().apply({ type: 'addNode', node });
    useBoardStore.getState().select(node.id);
  }

  /**
   * 拖文件进画布。
   *
   * 对标 ComfyUI 的 Load Image 与 TapCanvas 的拖图导入：
   * - 落在空白处 → 按文件类型新建对应的素材节点（图片 / 视频 / 音频）；
   * - 落在某个节点上 → 直接接进它同类型的输入端口（参考图 / 参考视频 / 参考音频）；
   * - 落在同类素材节点上 → 换成新素材。
   *
   * 桌面 webview 里 HTML5 拖放被 Tauri 接管了，拿不到 File 对象，
   * 只能由系统拖放事件给出路径，再按路径导入成项目素材。
   */
  const handleFileDrop = useCallback(async (paths: string[], position: { x: number; y: number }) => {
    const store = useBoardStore.getState();
    const projectId = useStudioStore.getState().currentProjectId;
    if (!projectId) {
      store.notify('先选一个项目，再把素材拖进来');
      return;
    }
    const usable = paths.filter((item) => kindOfFile(item));
    if (!usable.length) {
      store.notify('只支持拖入图片（png / jpg / webp）、视频（mp4 / mov）或音频（wav / mp3 / m4a）');
      return;
    }
    let imported: Array<{ assetId: string; displayName: string; kind: string }>;
    try {
      const result = await importMediaPaths(projectId, usable);
      imported = result.imported;
      if (result.failed.length) store.notify(`${result.failed.length} 个文件导入失败`);
    } catch (error) {
      store.notify(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!imported.length) return;
    await useAssetStore.getState().refresh();

    const scale = window.devicePixelRatio || 1;
    const clientX = position.x / scale;
    const clientY = position.y / scale;
    const hit = document.elementsFromPoint(clientX, clientY)
      .map((element) => element.closest('.react-flow__node[data-id]'))
      .find(Boolean) as HTMLElement | undefined;
    const hitId = hit?.getAttribute('data-id');
    const target = hitId ? useBoardStore.getState().board?.nodes[hitId] : undefined;

    imported.forEach((asset, index) => {
      const kind = (kindOfFile(asset.displayName) ?? (asset.kind as 'image' | 'video' | 'audio'));
      const nodeType = sourceNodeType(kind);
      const sourceDef = getNodeDefinition(nodeType);
      const sourcePort = sourceDef?.outputs[0];
      const flow = screenToFlowPosition({ x: clientX, y: clientY });
      const offset = index * 36;
      const node = createNode(nodeType, { x: flow.x - 132 + offset, y: flow.y - 100 + offset }, {
        assetId: asset.assetId,
        displayName: asset.displayName,
        kind,
      });
      const current = useBoardStore.getState();
      current.apply({ type: 'addNode', node });

      // 落在同类素材节点上：直接换掉它绑定的素材。
      if (target && sourceNodeKindFor(target.type) === kind) {
        current.apply({
          type: 'setNodeData',
          nodeId: target.id,
          patch: { assetId: asset.assetId, displayName: asset.displayName },
        });
        return;
      }
      // 落在别的节点上：把新节点接到它同类型的输入端口（参考图 / 参考视频 / 参考音频）。
      if (target && sourcePort) {
        const def = getNodeDefinition(target.type);
        const port = def?.inputs
          .filter((item) => item.dataType === kind || (kind === 'image' && item.dataType === 'frame'))
          .sort((left, right) => {
            const leftIndex = PORT_PRIORITY[left.key] ?? 99;
            const rightIndex = PORT_PRIORITY[right.key] ?? 99;
            return leftIndex - rightIndex;
          })[0];
        if (port) {
          const existing = Object.values(useBoardStore.getState().board?.edges ?? {})
            .find((edge) => edge.target === target.id && edge.targetPort === port.key);
          // 单入端口已有连线时先摘掉旧的，避免两个素材互相顶掉。
          if (existing && !port.multi) {
            useBoardStore.getState().apply({ type: 'disconnect', edgeId: existing.id });
          }
          useBoardStore.getState().apply({
            type: 'connect',
            edge: makeEdge(node.id, sourcePort.key, target.id, port.key, edgeRoleFor(sourcePort, port)),
          });
          current.select(node.id);
          return;
        }
      }
      // 落在空白处：只新建一个素材节点。
      current.select(node.id);
      if (index === 0) store.notify('已添加素材节点：把它连到下游的参考端口', 'success');
    });
  }, [screenToFlowPosition]);

  // 系统级拖放：Tauri 接管了 webview 的 HTML5 拖放，只能听它的事件。
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const listener = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'enter' || payload.type === 'over') {
            setDropActive(true);
            return;
          }
          if (payload.type === 'leave') {
            setDropActive(false);
            return;
          }
          if (payload.type === 'drop') {
            setDropActive(false);
            void handleFileDrop(payload.paths, payload.position);
          }
        });
        if (alive) stop = listener;
        else listener();
      } catch {
        // 浏览器里跑（没有 Tauri 运行时）时没有这个事件，忽略即可。
      }
    })();
    return () => { alive = false; stop?.(); };
  }, [handleFileDrop]);

  useEffect(() => {
    if (!openGroup) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.canvas-tool-group')) return;
      setOpenGroup(undefined);
    }
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [openGroup]);

  /**
   * Cmd+V 的优先级：应用内复制的节点 > 系统剪贴板里的图片。
   *
   * macOS 上 Tauri 用的是 WKWebView，它不把剪贴板里的图片交给 paste 事件
   * （WebKit 不支持把剪贴板文件暴露给网页），所以桌面端只能让后端读系统
   * 剪贴板；浏览器里则由 paste 事件直接给出字节。
   *
   * `pasteSession` 用来作废过期的那一路：两条路都可能成功，只留先到的。
   */
  const pasteSession = useRef(0);

  /**
   * 把一张已经导入的图片落到画布。
   *
   * - 选中的节点是图片素材节点 → 直接换成这张图；
   * - 否则 → 在画布中央新建一个图片素材节点。
   */
  const applyImportedImage = useCallback(async (imported: ImportedPath) => {
    await useAssetStore.getState().refresh();
    const selectedId = useBoardStore.getState().selectedNodeId;
    const selected = selectedId ? useBoardStore.getState().board?.nodes[selectedId] : undefined;
    if (selected?.type === 'image_source') {
      useBoardStore.getState().apply({
        type: 'setNodeData',
        nodeId: selected.id,
        patch: { assetId: imported.assetId, displayName: imported.displayName },
      });
      return;
    }
    const rect = wrapper.current?.getBoundingClientRect();
    const center = rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 80, y: 80 };
    const node = createNode('image_source', { x: center.x - 132, y: center.y - 100 }, {
      assetId: imported.assetId,
      displayName: imported.displayName,
      kind: 'image',
    });
    useBoardStore.getState().apply({ type: 'addNode', node });
    useBoardStore.getState().select(node.id);
    useBoardStore.getState().notify('已粘贴截图', 'success');
  }, [screenToFlowPosition]);

  /**
   * 粘贴前端读到的图片字节（浏览器路径：paste 事件能拿到文件）。
   */
  const pasteClipboardImage = useCallback(async (bytes: Uint8Array) => {
    const projectId = useStudioStore.getState().currentProjectId;
    if (!projectId) {
      useBoardStore.getState().notify('先选一个项目，再粘贴图片');
      return;
    }
    let imported: ImportedPath;
    try {
      imported = await importImageBytes(projectId, toBase64(bytes), '剪贴板截图');
    } catch (error) {
      useBoardStore.getState().notify(error instanceof Error ? error.message : String(error));
      return;
    }
    await applyImportedImage(imported);
  }, [applyImportedImage]);

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      // 焦点在输入框里时，Cmd+V 是往输入框贴文本，不能抢。
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const data = event.clipboardData;
      if (!data) return;
      // 同步判断有没有图片：只有图片才抢这次粘贴。
      // 异步去读字节的话，可能慢过 keydown 里的系统剪贴板读取。
      if (!hasImageInDataTransfer(data)) return;
      event.preventDefault();
      // 接管这次粘贴：作废 keydown 里发起的系统剪贴板读取，避免贴两次。
      const session = ++pasteSession.current;
      void imageBytesFromDataTransfer(data).then((bytes) => {
        if (pasteSession.current !== session || !bytes) return;
        void pasteClipboardImage(bytes);
      });
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [pasteClipboardImage]);

  /**
   * 悬停展开分组菜单。
   *
   * 原来要点一下才展开，鼠标要来回跑两趟；现在移入即开、移出即收。
   * 关闭有一点延迟：菜单浮在按钮下方，中间那几像素的空隙如果立刻关，
   * 鼠标往下移的过程中菜单就消失了。
   */
  const closeTimer = useRef<number>();
  const openMenu = useCallback((groupId: string) => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
    setOpenGroup(groupId);
  }, []);
  const closeMenu = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpenGroup(undefined), 180);
  }, []);
  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const store = useBoardStore.getState();
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo(); else store.undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (event.shiftKey) ungroupSelection(); else groupSelection();
        return;
      }
      if (meta && event.key.toLowerCase() === 'd') {
        const selected = store.selectedNodeId ? store.board?.nodes[store.selectedNodeId] : undefined;
        if (selected) {
          event.preventDefault();
          const copy = createNode(selected.type, { x: selected.position.x + 40, y: selected.position.y + 40 }, selected.data);
          store.apply({ type: 'addNode', node: copy });
          store.select(copy.id);
        }
        return;
      }
      if (meta && event.key.toLowerCase() === 'a') {
        // 全选：选中当前画布的全部节点，便于批量编组或批量删除。
        const board = store.board;
        if (!board) return;
        event.preventDefault();
        store.selectMany(Object.keys(board.nodes));
        return;
      }
      if (meta && event.key.toLowerCase() === 'c') {
        // 复制：把选中节点的定义复制到应用内剪贴板。
        const board = store.board;
        if (!board) return;
        event.preventDefault();
        clipboard.copyNodes(board, store.selectedNodeIds);
        return;
      }
      if (meta && event.key.toLowerCase() === 'v') {
        const board = store.board;
        if (!board) return;
        event.preventDefault();
        // 1) 应用内复制的节点优先：系统剪贴板里还留着旧图时，也该先粘节点。
        const pasted = clipboard.pasteNodes(board);
        if (pasted) {
          pasteSession.current += 1;
          store.applyMany(pasted.map((node) => ({ type: 'addNode' as const, node })));
          store.selectMany(pasted.map((node) => node.id));
          return;
        }
        // 2) 系统剪贴板里的图片。
        //    浏览器路径由 paste 事件接管；桌面端 WKWebView 拿不到，
        //    等一小会儿让浏览器先表态，再让后端读系统剪贴板。
        const session = ++pasteSession.current;
        window.setTimeout(async () => {
          if (pasteSession.current !== session) return;
          const projectId = useStudioStore.getState().currentProjectId;
          if (!projectId) {
            store.notify('先选一个项目，再粘贴图片');
            return;
          }
          if (!isTauri()) {
            store.notify('剪贴板里没有图片');
            return;
          }
          try {
            const imported = await importClipboardImage(projectId);
            if (pasteSession.current !== session) return;
            await applyImportedImage(imported);
          } catch (error) {
            if (pasteSession.current !== session) return;
            const message = error instanceof Error ? error.message : String(error);
            store.notify(message.includes('CLIPBOARD_NO_IMAGE') ? '剪贴板里没有图片' : message);
          }
        }, 120);
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && store.selectedNodeIds.length) {
        event.preventDefault();
        store.applyMany(store.selectedNodeIds.map((nodeId) => ({ type: 'removeNode' as const, nodeId })));
        store.selectMany([]);
        return;
      }
      if (event.key === 'Escape') {
        setOpenGroup(undefined);
        store.selectMany([]);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [groupSelection, ungroupSelection, applyImportedImage]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useBoardStore.getState().notify(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!board) return <div className="studio-empty-canvas">正在加载画布…</div>;

  return (
    <div className="studio-canvas" ref={wrapper}>
      <div className="canvas-toolbar" role="toolbar" aria-label="添加节点">
        <span className="canvas-toolbar-label">添加</span>
        {NODE_GROUPS.map((group) => (
          <div
            className="canvas-tool-group"
            key={group.id}
            onMouseEnter={() => openMenu(group.id)}
            onMouseLeave={closeMenu}
          >
            <button
              type="button"
              className="canvas-tool canvas-tool-menu"
              aria-haspopup="menu"
              aria-expanded={openGroup === group.id}
              onClick={() => openMenu(group.id)}
            >
              {group.label} <ChevronDown size={11} />
            </button>
            {/*
              菜单常驻 DOM，用 class 控制显隐：收起时才能播退出动画，
              条件渲染会直接卸载节点，动画来不及播。
            */}
            <div className={`canvas-tool-menu-pop${openGroup === group.id ? ' is-open' : ''}`} role="menu">
              {group.types.map((type) => (
                <button
                  key={type}
                  type="button"
                  role="menuitem"
                  className="canvas-tool"
                  onClick={() => { addAtCenter(type); closeMenu(); }}
                >
                  {getNodeDefinition(type)?.title ?? type}
                </button>
              ))}
            </div>
          </div>
        ))}
        <span className="canvas-toolbar-sep" />
        <button className="canvas-tool" onClick={groupSelection} disabled={selectedNodeIds.length < 2}>编组</button>
        <button className="canvas-tool" onClick={ungroupSelection} disabled={!selectedIsGroup}>解组</button>
        <span className="canvas-toolbar-sep" />
        <button
          className="canvas-tool"
          title="重跑所有结果已过期的节点"
          disabled={!staleNodeIds.size}
          onClick={() => { void requestRunBatch([...staleNodeIds]); }}
        >
          重跑过期（{staleNodeIds.size}）
        </button>
        <span className="canvas-toolbar-spacer" />
        <button className="canvas-tool" onClick={() => useBoardStore.getState().undo()} disabled={!canUndo}>撤销</button>
        <button className="canvas-tool" onClick={() => useBoardStore.getState().redo()} disabled={!canRedo}>重做</button>
        {dangling > 0 && <span className="canvas-warning">{dangling} 条断开的引用</span>}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={board.viewport}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={() => useBoardStore.getState().beginGesture()}
        onNodeDragStop={() => useBoardStore.getState().endGesture()}
        onDrop={onDrop}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
        onMoveEnd={(_, viewport) => {
          const current = useBoardStore.getState().board;
          if (!current) return;
          if (current.viewport.x === viewport.x && current.viewport.y === viewport.y && current.viewport.zoom === viewport.zoom) return;
          useBoardStore.getState().apply({ type: 'setViewport', viewport }, { history: false });
        }}
        onlyRenderVisibleElements
        selectionOnDrag
        panOnScroll
        deleteKeyCode={null}
        fitView={false}
        minZoom={0.12}
        maxZoom={2.5}
        nodeDragThreshold={0}
        elevateNodesOnSelect={false}
      >
        <Background color="#dfe2e6" gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(node) => nodeColor(node.type ?? '')} maskColor="rgba(242, 243, 245, 0.72)" />
        <MeasuredSync />
      </ReactFlow>
      {!nodes.length && (
        <div className="canvas-empty">
          <b>空白画布</b>
          <span>从上方「添加」开始，或用拖拽把节点放到任意位置。</span>
          <span>文本 → 图片 → 视频，连起来就是一条可执行链路。</span>
        </div>
      )}
      {dropActive && (
        <div className="canvas-drop-hint" role="status">
          <b>松手加入图片素材</b>
          <span>落在空白处新建节点，落在图片 / 视频节点上直接接进它的参考图端口</span>
        </div>
      )}
      {notice && <div className={`canvas-notice${noticeTone === 'success' ? ' is-success' : ''}`} role="status">{notice}</div>}
    </div>
  );
}

export function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

/**
 * 把 React Flow 内部量出的节点尺寸写回给 userNode。
 *
 * React Flow 只把实测尺寸写进内部节点，MiniMap 读的却是 userNode，
 * 于是小地图算不出包围盒。这里订阅内部 store，把尺寸同步到
 * `mapping.ts` 的缓存，`toFlowNodes` 下次构建 userNode 时带上 `measured`。
 */
function MeasuredSync() {
  const sizes = useStore((s) =>
    Array.from(s.nodeLookup.values()).map((n) => ({
      id: n.id,
      width: n.measured?.width,
      height: n.measured?.height,
    })),
  );
  useEffect(() => {
    for (const size of sizes) {
      if (size.width && size.height) recordMeasured(size.id, size.width, size.height);
    }
  }, [sizes]);
  return null;
}
