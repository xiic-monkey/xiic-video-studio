import type { BoardDoc } from '../types';

export function topoSort(doc: BoardDoc): { order: string[]; cycle: string[] } {
  const ids = Object.keys(doc.nodes);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  for (const item of Object.values(doc.edges)) {
    if (!doc.nodes[item.source] || !doc.nodes[item.target]) continue;
    outgoing.get(item.source)!.push(item.target);
    indegree.set(item.target, (indegree.get(item.target) ?? 0) + 1);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const cycle = ids.filter((id) => !order.includes(id));
  return { order: cycle.length ? [] : order, cycle };
}
