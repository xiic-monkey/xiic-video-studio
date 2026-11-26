import type { ProductionNavigationNode } from '../../domain/production/navigation';

export function findNavigationNode(node: ProductionNavigationNode, id: string): ProductionNavigationNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNavigationNode(child, id);
    if (found) return found;
  }
  return undefined;
}

export function NavigationTree({ node, selectedId, onSelect, depth = 0 }: { node: ProductionNavigationNode; selectedId: string; onSelect: (id: string) => void; depth?: number }) {
  return <div className="production-structure-node" style={{ marginLeft: depth * 12 }}><button type="button" className={selectedId === node.id ? 'active' : ''} onClick={() => onSelect(node.id)}><span>{node.kind === 'shot' ? '镜' : node.kind === 'scene' ? '场' : node.kind === 'episode' ? '集' : '·'}</span>{node.label}<small>{node.shotIds.length}</small></button>{node.children.map((child) => <NavigationTree key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />)}</div>;
}

