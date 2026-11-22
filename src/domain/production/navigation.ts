export interface ProductionNavigationEntity {
  id: string;
  kind: 'episode' | 'scene' | 'shot' | string;
  payload: Record<string, unknown>;
}

export interface ProductionNavigationNode {
  id: string;
  kind: 'root' | 'episode' | 'scene' | 'shot' | 'ungrouped';
  label: string;
  shotIds: string[];
  children: ProductionNavigationNode[];
}

function text(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function order(entity: ProductionNavigationEntity): number {
  const value = entity.payload.order;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function buildProductionNavigation(entities: readonly ProductionNavigationEntity[]): ProductionNavigationNode {
  const episodes = entities.filter((entity) => entity.kind === 'episode').sort((left, right) => order(left) - order(right));
  const scenes = entities.filter((entity) => entity.kind === 'scene').sort((left, right) => order(left) - order(right));
  const shots = entities.filter((entity) => entity.kind === 'shot').sort((left, right) => order(left) - order(right));
  const usedShots = new Set<string>();

  const shotNode = (shot: ProductionNavigationEntity): ProductionNavigationNode => ({
    id: shot.id,
    kind: 'shot',
    label: text(shot.payload, 'title', `镜头 ${String(shot.payload.order ?? '?')}`),
    shotIds: [shot.id],
    children: [],
  });
  const sceneNode = (scene: ProductionNavigationEntity): ProductionNavigationNode => {
    const sceneShots = shots.filter((shot) => shot.payload.sceneId === scene.id);
    sceneShots.forEach((shot) => usedShots.add(shot.id));
    return {
      id: scene.id,
      kind: 'scene',
      label: text(scene.payload, 'heading', text(scene.payload, 'title', scene.id)),
      shotIds: sceneShots.map((shot) => shot.id),
      children: sceneShots.map(shotNode),
    };
  };

  const episodeNodes = episodes.map((episode) => {
    const episodeScenes = scenes.filter((scene) => scene.payload.episodeId === episode.id);
    const children = episodeScenes.map(sceneNode);
    const directShots = shots.filter((shot) => shot.payload.episodeId === episode.id && !usedShots.has(shot.id));
    directShots.forEach((shot) => usedShots.add(shot.id));
    children.push(...directShots.map(shotNode));
    return {
      id: episode.id,
      kind: 'episode' as const,
      label: text(episode.payload, 'title', `第 ${String(episode.payload.order ?? '?')} 集`),
      shotIds: children.flatMap((child) => child.shotIds),
      children,
    };
  });

  const ungroupedShots = shots.filter((shot) => !usedShots.has(shot.id));
  const ungrouped: ProductionNavigationNode | undefined = ungroupedShots.length
    ? { id: 'ungrouped-shots', kind: 'ungrouped', label: '未分组镜头', shotIds: ungroupedShots.map((shot) => shot.id), children: ungroupedShots.map(shotNode) }
    : undefined;

  return {
    id: 'production-root',
    kind: 'root',
    label: '制作结构',
    shotIds: shots.map((shot) => shot.id),
    children: ungrouped ? [...episodeNodes, ungrouped] : episodeNodes,
  };
}
