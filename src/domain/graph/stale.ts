import type { BoardDoc } from '../types';
import type { CacheContext } from './cacheKey';
import { computeCacheKey, latestSucceededRun } from './cacheKey';
import { topoSort } from './topo';

export function computeStaleSet(doc: BoardDoc, ctx: CacheContext, pinned: Set<string>): Set<string> {
  const stale = new Set<string>();
  for (const nodeId of Object.keys(doc.nodes)) {
    if (pinned.has(nodeId)) continue;
    const run = latestSucceededRun(ctx.runs, nodeId);
    if (!run || run.cacheKey !== computeCacheKey(doc, nodeId, ctx)) stale.add(nodeId);
  }

  const dependencies = new Map<string, string[]>();
  for (const nodeId of Object.keys(doc.nodes)) dependencies.set(nodeId, []);
  for (const item of Object.values(doc.edges)) {
    if (doc.nodes[item.source] && doc.nodes[item.target]) {
      dependencies.get(item.target)!.push(item.source);
    }
  }

  const { order } = topoSort(doc);
  for (const nodeId of order) {
    if (pinned.has(nodeId)) {
      stale.delete(nodeId);
      continue;
    }
    if (stale.has(nodeId)) continue;
    if (dependencies.get(nodeId)!.some((dependency) => stale.has(dependency))) {
      stale.add(nodeId);
    }
  }
  return stale;
}
