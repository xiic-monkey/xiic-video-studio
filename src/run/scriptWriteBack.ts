import { parseScriptPayload } from '../domain/nodes/scriptContent';
import { readAssetText } from '../services/tauri';
import { useBoardStore } from '../stores/boardStore';
import type { RunRecord } from '../domain/types';

/**
 * 剧本节点的运行结果回填。
 *
 * 剧本节点的输出就是它自己写着的正文与节拍，所以模型跑完后要把结果写回节点，
 * 下游才能立刻拿到新内容（也会让下游的缓存键失效，需要重新跑）。
 * 解析不出 JSON 就保持原样：宁可不回填，也不要把半截 JSON 塞进正文。
 */
export async function applyScriptOutput(run: RunRecord): Promise<void> {
  if (run.status !== 'succeeded') return;
  const board = useBoardStore.getState().board;
  if (!board || board.id !== run.boardId) return;
  const node = board.nodes[run.nodeId];
  if (!node || node.type !== 'script') return;
  const assetId = run.selectedAssetId ?? run.outputAssetIds[0];
  if (!assetId) return;
  let text = '';
  try {
    text = await readAssetText(run.projectId, assetId);
  } catch {
    return;
  }
  const payload = parseScriptPayload(text);
  if (!payload) return;
  const patch: Record<string, unknown> = {};
  if (payload.script && payload.script !== node.data.body) patch.body = payload.script;
  if (payload.beats && payload.beats !== node.data.beats) patch.beats = payload.beats;
  if (!Object.keys(patch).length) return;
  // 系统回填不进撤销历史：它是这次运行的产物，不是用户的一次编辑。
  useBoardStore.getState().apply({ type: 'setNodeData', nodeId: node.id, patch }, { history: false });
}
