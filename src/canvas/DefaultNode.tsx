import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { getNodeDefinition, visibleInputPorts } from '../domain/nodes/definitions';
import { nodeColor, type StudioNodeData } from './mapping';

function preview(node: StudioNodeData['domain']): string {
  const data = node.data;
  const candidate = data.body ?? data.prompt ?? data.text ?? data.label ?? '';
  const text = String(candidate).trim();
  return text ? text.slice(0, 120) : '空节点';
}

export function DefaultNode({ data, selected }: NodeProps<Node<StudioNodeData>>) {
  const node = data.domain;
  const def = getNodeDefinition(node.type);
  if (!def) {
    return <div className="flow-node flow-node-unknown">{node.type}</div>;
  }
  const active = visibleInputPorts(def, node);
  const inputs = def.inputs;
  const outputs = def.outputs;
  const rows = Math.max(inputs.length, outputs.length);
  return (
    <div
      className={`flow-node type-${node.type}${selected ? ' is-selected' : ''}`}
      style={{ minHeight: 46 + rows * 20, borderColor: selected ? '#75d8bd' : nodeColor(node.type) }}
    >
      <header>
        <span className="flow-node-type" style={{ background: nodeColor(node.type) }} />
        <b>{def.title}</b>
        {node.ui?.pinned && <span className="flow-node-lock">锁定</span>}
      </header>
      <p>{preview(node)}</p>
      {inputs.map((port, index) => (
        <div
          className={`flow-port flow-port-in${active.some((item) => item.key === port.key) ? '' : ' is-inactive'}`}
          key={port.key}
          style={{ top: 44 + index * 20 }}
        >
          <Handle type="target" position={Position.Left} id={port.key} />
          <span>{port.label}</span>
        </div>
      ))}
      {outputs.map((port, index) => (
        <div className="flow-port flow-port-out" key={port.key} style={{ top: 44 + index * 20 }}>
          <span>{port.label}</span>
          <Handle type="source" position={Position.Right} id={port.key} />
        </div>
      ))}
      <footer>{node.type} · v{node.typeVersion}</footer>
    </div>
  );
}
