import { useMemo } from 'react';
import { latestSucceededRun } from '../domain/graph/cacheKey';
import { computeStaleSet } from '../domain/graph/stale';
import { buildCacheContext } from '../domain/run/runtime';
import { useBoardStore } from '../stores/boardStore';
import { useProviderStore } from '../stores/providerStore';
import { useRunStore } from '../stores/runStore';
import { useStudioStore } from '../stores/studioStore';

export function useStaleNodeIds(): Set<string> {
  const board = useBoardStore((state) => state.board);
  const runs = useRunStore((state) => state.runs);
  const styleGuide = useStudioStore((state) =>
    state.projects.find((item) => item.id === state.currentProjectId)?.styleGuide);
  const profiles = useProviderStore((state) => state.profiles);
  const hasKeys = useProviderStore((state) => state.hasKeys);
  const loaded = useProviderStore((state) => state.loaded);

  return useMemo(() => {
    if (!board || !loaded) return new Set<string>();
    const runList = Object.values(runs);
    const ctx = buildCacheContext({ doc: board, runs: runList, profiles, hasKeys, styleGuide });
    const pinned = new Set(Object.values(board.nodes).filter((node) => node.ui?.pinned).map((node) => node.id));
    const stale = computeStaleSet(board, ctx, pinned);
    // 只标记「跑过但结果已过期」；从未运行的节点用「未运行」状态表达，不叠加过期角标。
    return new Set([...stale].filter((nodeId) => latestSucceededRun(runList, nodeId)));
  }, [board, runs, profiles, hasKeys, loaded, styleGuide]);
}
