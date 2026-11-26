import { useBoardStore } from '../stores/boardStore';
import type { BoardNode } from '../domain/types';
import type { ModelChoice } from './model';
import { InspectorSection } from './InspectorSection';

interface ModelSectionProps {
  node: BoardNode;
  choices: ModelChoice[];
  hasKeys: Record<string, boolean>;
  capabilityLabel: string;
  onOpenSettings(): void;
}

/**
 * Inspector 的「模型」段。
 *
 * 单独成文件：这个段自己管着模型与供应商两个选择器、以及候选顺序提示，
 * 和字段编辑、运行控制互不相干，混在一个文件里改一处容易误伤。
 */
export function ModelSection({ node, choices, hasKeys, capabilityLabel, onOpenSettings }: ModelSectionProps) {
  const selectedChoice = choices.find((choice) => choice.modelId === String(node.data.model ?? ''));
  return (
    <InspectorSection title="模型" defaultOpen>
      <div className="inspector-field">
        <span>模型</span>
        <select
          value={String(node.data.model ?? '')}
          onChange={(event) => {
            const modelId = event.target.value;
            const providerId = String(node.data.providerId ?? '');
            const stillValid = choices.some((choice) => choice.modelId === modelId
              && choice.providers.some((provider) => provider.providerId === providerId));
            useBoardStore.getState().apply({
              type: 'setNodeData',
              nodeId: node.id,
              patch: { model: modelId, providerId: stillValid ? providerId : '' },
            });
          }}
        >
          <option value="">请选择模型</option>
          {choices.map((choice) => (
            <option key={choice.modelId} value={choice.modelId}>{choice.modelName}</option>
          ))}
        </select>
      </div>
      <div className="inspector-field">
        <span>供应商</span>
        <select
          value={String(node.data.providerId ?? '')}
          disabled={!selectedChoice}
          onChange={(event) => {
            useBoardStore.getState().apply({
              type: 'setNodeData',
              nodeId: node.id,
              patch: { providerId: event.target.value },
            });
          }}
        >
          <option value="">自动（按顺序回退）</option>
          {selectedChoice?.providers.map((provider) => (
            <option key={provider.providerId} value={provider.providerId}>{provider.providerName}</option>
          ))}
        </select>
      </div>
      <div className="inspector-section-head">
        <span className="inspector-note">能力：{capabilityLabel}</span>
        <button type="button" className="inspector-link" onClick={onOpenSettings}>打开设置</button>
      </div>
      {!choices.length && <p className="inspector-warning">没有可用模型，请先在设置中添加模型并保存 Key。</p>}
      {selectedChoice && (
        <p className="inspector-note">
          候选顺序：{selectedChoice.providers.map((provider) => provider.providerName).join(' → ')}
        </p>
      )}
      {String(node.data.providerId ?? '') && hasKeys[String(node.data.providerId)] === false && (
        <p className="inspector-warning">所选 Provider 尚未保存 API Key。</p>
      )}
    </InspectorSection>
  );
}
