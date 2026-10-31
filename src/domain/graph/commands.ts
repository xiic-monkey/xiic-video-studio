import { newId } from '../ids';
import type { BoardDoc, BoardEdge, BoardNode } from '../types';

export type GraphCommand =
  | { type: 'addNode'; node: BoardNode }
  | { type: 'addNodes'; nodes: BoardNode[] }
  | { type: 'removeNode'; nodeId: string }
  | { type: 'moveNode'; nodeId: string; position: { x: number; y: number } }
  | { type: 'resizeNode'; nodeId: string; size: { width: number; height: number } }
  | { type: 'setNodeData'; nodeId: string; patch: Record<string, unknown> }
  | { type: 'setNodeUi'; nodeId: string; patch: NonNullable<BoardNode['ui']> }
  | { type: 'connect'; edge: BoardEdge }
  | { type: 'connectMany'; edges: BoardEdge[] }
  | { type: 'disconnect'; edgeId: string }
  | { type: 'setViewport'; viewport: BoardDoc['viewport'] }
  | { type: 'group'; groupId: string; childIds: string[]; label: string; sizes?: Record<string, { width: number; height: number }> }
  | { type: 'ungroup'; groupId: string };

function stamp(doc: BoardDoc): BoardDoc {
  return { ...doc, updatedAt: new Date().toISOString() };
}

export function applyGraphCommand(doc: BoardDoc, command: GraphCommand): BoardDoc {
  switch (command.type) {
    case 'addNode':
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.node.id]: command.node } });
    case 'addNodes': {
      const nodes = { ...doc.nodes };
      for (const node of command.nodes) nodes[node.id] = node;
      return stamp({ ...doc, nodes });
    }
    case 'removeNode': {
      const nodes = { ...doc.nodes };
      const removed = nodes[command.nodeId];
      delete nodes[command.nodeId];
      if (removed) {
        for (const child of Object.values(nodes)) {
          if (child.parentId !== command.nodeId) continue;
          nodes[child.id] = {
            ...child,
            parentId: undefined,
            position: { x: child.position.x + removed.position.x, y: child.position.y + removed.position.y },
          };
        }
      }
      return stamp({ ...doc, nodes });
    }
    case 'moveNode': {
      const node = doc.nodes[command.nodeId];
      if (!node) return doc;
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.nodeId]: { ...node, position: command.position } } });
    }
    case 'resizeNode': {
      const node = doc.nodes[command.nodeId];
      if (!node) return doc;
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.nodeId]: { ...node, size: command.size } } });
    }
    case 'setNodeData': {
      const node = doc.nodes[command.nodeId];
      if (!node) return doc;
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.nodeId]: { ...node, data: { ...node.data, ...command.patch } } } });
    }
    case 'setNodeUi': {
      const node = doc.nodes[command.nodeId];
      if (!node) return doc;
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.nodeId]: { ...node, ui: { ...node.ui, ...command.patch } } } });
    }
    case 'connect':
      return stamp({ ...doc, edges: { ...doc.edges, [command.edge.id]: command.edge } });
    case 'connectMany': {
      const edges = { ...doc.edges };
      for (const edge of command.edges) edges[edge.id] = edge;
      return stamp({ ...doc, edges });
    }
    case 'disconnect': {
      const edges = { ...doc.edges };
      delete edges[command.edgeId];
      return stamp({ ...doc, edges });
    }
    case 'setViewport':
      return stamp({ ...doc, viewport: command.viewport });
    case 'group': {
      const children = command.childIds.map((id) => doc.nodes[id]).filter(Boolean);
      if (!children.length) return doc;
      const sizeOf = (child: BoardNode) => command.sizes?.[child.id] ?? { width: 300, height: 220 };
      const minX = Math.min(...children.map((child) => child.position.x)) - 24;
      const minY = Math.min(...children.map((child) => child.position.y)) - 64;
      const maxX = Math.max(...children.map((child) => child.position.x + sizeOf(child).width));
      const maxY = Math.max(...children.map((child) => child.position.y + sizeOf(child).height));
      const group: BoardNode = {
        id: command.groupId, type: 'group', typeVersion: 1,
        position: { x: minX, y: minY },
        size: { width: maxX - minX + 24, height: maxY - minY + 24 },
        z: Math.min(...children.map((child) => child.z)) - 1,
        data: { label: command.label, collapsed: false },
      };
      const nodes = { ...doc.nodes, [command.groupId]: group };
      for (const child of children) {
        nodes[child.id] = {
          ...child,
          parentId: command.groupId,
          position: { x: child.position.x - minX, y: child.position.y - minY },
        };
      }
      return stamp({ ...doc, nodes });
    }
    case 'ungroup': {
      const group = doc.nodes[command.groupId];
      if (!group) return doc;
      const nodes = { ...doc.nodes };
      delete nodes[command.groupId];
      for (const child of Object.values(nodes)) {
        if (child.parentId !== command.groupId) continue;
        nodes[child.id] = {
          ...child,
          parentId: undefined,
          position: { x: child.position.x + group.position.x, y: child.position.y + group.position.y },
        };
      }
      return stamp({ ...doc, nodes });
    }
  }
}

export function addNodeCommand(node: BoardNode): GraphCommand {
  return { type: 'addNode', node };
}

export function connectCommand(edge: BoardEdge): GraphCommand {
  return { type: 'connect', edge };
}

export function makeEdge(source: string, sourcePort: string, target: string, targetPort: string, role: BoardEdge['role']): BoardEdge {
  return { id: newId('edge'), source, sourcePort, target, targetPort, role, createdAt: new Date().toISOString() };
}
