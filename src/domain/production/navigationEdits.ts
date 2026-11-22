type StructureEntity = {
  id: string;
  kind: string;
  revision: number;
  payload: Record<string, unknown>;
};

export function renameStructureEntity(entity: StructureEntity, label: string): Record<string, unknown> {
  const next = { ...entity.payload };
  if (entity.kind === 'scene') next.heading = label;
  else next.title = label;
  return next;
}

export function moveShotToScene(
  shot: StructureEntity,
  scene: StructureEntity | undefined,
  siblings: readonly StructureEntity[],
): Record<string, unknown> {
  if (!scene) {
    const { sceneId: _sceneId, episodeId: _episodeId, ...payload } = shot.payload;
    return payload;
  }
  const episodeId = typeof scene.payload.episodeId === 'string' ? scene.payload.episodeId : undefined;
  const nextOrder = siblings.filter((item) => item.kind === 'shot').length + 1;
  return {
    ...shot.payload,
    sceneId: scene.id,
    ...(episodeId ? { episodeId } : {}),
    order: nextOrder,
  };
}

export function reorderStructureSiblings(
  entities: readonly StructureEntity[],
  entityId: string,
  direction: 'up' | 'down',
): StructureEntity[] {
  const target = entities.find((entity) => entity.id === entityId);
  if (!target) return [...entities];
  const parentKey = target.kind === 'scene' ? 'episodeId' : target.kind === 'shot' ? 'sceneId' : undefined;
  const siblings = entities
    .filter((entity) => entity.kind === target.kind && (!parentKey || entity.payload[parentKey] === target.payload[parentKey]))
    .sort((left, right) => Number(left.payload.order ?? Number.MAX_SAFE_INTEGER) - Number(right.payload.order ?? Number.MAX_SAFE_INTEGER));
  const index = siblings.findIndex((entity) => entity.id === entityId);
  const otherIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || otherIndex < 0 || otherIndex >= siblings.length) return [...entities];
  [siblings[index], siblings[otherIndex]] = [siblings[otherIndex], siblings[index]];
  const orderById = new Map(siblings.map((entity, position) => [entity.id, position + 1]));
  return entities.map((entity) => orderById.has(entity.id) ? { ...entity, payload: { ...entity.payload, order: orderById.get(entity.id) } } : entity);
}
