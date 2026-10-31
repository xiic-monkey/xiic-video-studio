import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { getNodeDefinition, visibleInputPorts } from '../domain/nodes/definitions';
import { nodeColor, type StudioNodeData } from '../canvas/mapping';
import { useRunStore } from '../stores/runStore';
import { BODIES } from './bodies';
import { durationLabel, statusOf, summarizeNode } from './summary';

export function NodeCard({ data, selected }: NodeProps<Node<StudioNodeData>>) {
  const node = data.domain;
  const def = getNodeDefinition(node.type);
  const run = useRunStore((state) => {
    const runId = state.latestByNode[node.id];
    return runId ? state.runs[runId] : undefined;
  });

  if (!def) {
    return <div className="flow-node flow-node-unknown">{node.type}</div>;
  }

  const Body = BODIES[node.type];
  const badge = statusOf(run);
  const accent = nodeColor(node.type);
  const activeInputs = visibleInputPorts(def, node);
  const hasPorts = def.inputs.length > 0 || def.outputs.length > 0;

  return (
    <div
      className={`flow-node type-${node.type}${selected ? ' is-selected' : ''}${node.type === 'group' ? ' is-group' : ''}`}
      style={{ borderColor: selected ? 'var(--mint)' : accent }}
    >
      <header>
        <span className="flow-node-type" style={{ background: accent }} />
        <b>{def.title}</b>
        {node.ui?.pinned && <span className="flow-node-lock">锁定</span>}
        <span className={`flow-status tone-${badge.tone}`}>{badge.label}</span>
      </header>
      {Body ? <Body node={node} run={run} /> : <p className="flow-quote">{summarizeNode(node)}</p>}
      {node.type !== 'group' && (
        <footer>
          <span>{node.type} · v{node.typeVersion}</span>
          <span>{run ? `${run.outputAssetIds.length} 个结果` : ''}</span>
          <span>{durationLabel(run)}</span>
        </footer>
      )}
      {hasPorts && (
        <div className="flow-ports">
          <div className="flow-ports-in">
            {def.inputs.map((port) => (
              <div
                className={`flow-port flow-port-in${activeInputs.some((item) => item.key === port.key) ? '' : ' is-inactive'}`}
                key={port.key}
              >
                <Handle type="target" position={Position.Left} id={port.key} className="flow-handle" />
                <span>{port.label}{port.required ? ' *' : ''}</span>
              </div>
            ))}
          </div>
          <div className="flow-ports-out">
            {def.outputs.map((port) => (
              <div className="flow-port flow-port-out" key={port.key}>
                <span>{port.label}</span>
                <Handle type="source" position={Position.Right} id={port.key} className="flow-handle" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
