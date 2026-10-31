import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  type Connection, type EdgeChange, type NodeChange, type NodeTypes,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createNode, edgeRoleFor, getNodeDefinition } from '../domain/nodes/definitions';
import { makeEdge } from '../domain/graph/commands';
import { validateConnection } from '../domain/graph/validate';
import { useBoardStore } from '../stores/boardStore';
import { danglingEdgeCount, nodeColor, toFlowEdges, toFlowNodes } from './mapping';
import { DefaultNode } from './DefaultNode';

const nodeTypes: NodeTypes = {
  text: DefaultNode, image: DefaultNode, video: DefaultNode, audio: DefaultNode,
  script: DefaultNode, note: DefaultNode, group: DefaultNode,
};

function CanvasInner() {
  const board = useBoardStore((state) => state.board);
  const notice = useBoardStore((state) => state.notice);
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const nodes = useMemo(() => (board ? toFlowNodes(board) : []), [board]);
  const edges = useMemo(() => (board ? toFlowEdges(board) : []), [board]);
  const dangling = board ? danglingEdgeCount(board) : 0;

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        useBoardStore.getState().apply({ type: 'moveNode', nodeId: change.id, position: change.position }, { history: false });
      } else if (change.type === 'remove') {
        useBoardStore.getState().apply({ type: 'removeNode', nodeId: change.id });
      }
    }
    const picked = changes.find((change) => change.type === 'select' && change.selected);
    if (picked && picked.type === 'select') {
      useBoardStore.getState().select(picked.id);
    } else if (changes.some((change) => change.type === 'select')) {
      useBoardStore.getState().select(undefined);
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
    const node = createNode(type, { x: center.x - 150, y: center.y - 100 });
    useBoardStore.getState().apply({ type: 'addNode', node });
    useBoardStore.getState().select(node.id);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select')) return;
      const store = useBoardStore.getState();
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo(); else store.undo();
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
      if ((event.key === 'Delete' || event.key === 'Backspace') && store.selectedNodeId) {
        event.preventDefault();
        store.apply({ type: 'removeNode', nodeId: store.selectedNodeId });
        store.select(undefined);
        return;
      }
      if (event.key === 'Escape') store.select(undefined);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
        {['text', 'image', 'video', 'audio', 'script', 'note', 'group'].map((type) => (
          <button key={type} className="canvas-tool" onClick={() => addAtCenter(type)}>
            {getNodeDefinition(type)?.title ?? type}
          </button>
        ))}
        <span className="canvas-toolbar-spacer" />
        <button className="canvas-tool" onClick={() => useBoardStore.getState().undo()} disabled={!useBoardStore.getState().past.length}>撤销</button>
        <button className="canvas-tool" onClick={() => useBoardStore.getState().redo()} disabled={!useBoardStore.getState().future.length}>重做</button>
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
        minZoom={0.2}
        maxZoom={2.5}
        nodeDragThreshold={0}
      >
        <Background color="#26302f" gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(node) => nodeColor(node.type ?? '')} maskColor="rgba(9, 13, 13, 0.72)" />
      </ReactFlow>
      {!nodes.length && (
        <div className="canvas-empty">
          <b>空白画布</b>
          <span>从上方「添加」开始，或用拖拽把节点放到任意位置。</span>
          <span>文本 → 图片 → 视频，连起来就是一条可执行链路。</span>
        </div>
      )}
      {notice && <div className="canvas-notice" role="status">{notice}</div>}
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
