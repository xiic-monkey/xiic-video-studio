import { Lock, Unlock } from 'lucide-react';
import { useBoardStore } from '../stores/boardStore';
import type { BoardNode } from '../domain/types';
import type { PromptSnapshot } from '../domain/types';
import { InspectorSection } from './InspectorSection';

interface PromptSectionProps {
  node: BoardNode;
  preview: PromptSnapshot;
  onToggleLock(): void;
}

/**
 * Inspector 的「提示词预览」段。
 *
 * 锁定/解锁会把当前预览写回节点，覆盖自动拼装的提示词，
 * 所以这是个有副作用的动作，单独成文件以便看清它的边界。
 */
export function PromptSection({ node, preview, onToggleLock }: PromptSectionProps) {
  return (
    <InspectorSection
      title="提示词预览"
      aside={(
        <button type="button" className="inspector-link" onClick={onToggleLock}>
          {node.data.promptLocked ? <><Unlock size={11} /> 解锁</> : <><Lock size={11} /> 锁定</>}
        </button>
      )}
    >
      <p className="prompt-preview">{preview.text || '（空）'}</p>
      {preview.negative && <p className="inspector-note">负向：{preview.negative}</p>}
      {!!preview.segments.length && (
        <div className="prompt-segments">
          {preview.segments.map((segment, index) => (
            <span key={`${segment.key}-${index}`} title={segment.text}>{segment.label}</span>
          ))}
        </div>
      )}
      {!!preview.missingVariables?.length && (
        <p className="inspector-warning">缺少变量：{preview.missingVariables.join('、')}</p>
      )}
    </InspectorSection>
  );
}
