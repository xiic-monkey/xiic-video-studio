import { newId } from '../domain/ids';
import { emptyStyleGuide } from '../domain/types';
import type { BoardDoc, StudioProject } from '../domain/types';

export function createStudioProject(
  name: string,
  aspectRatio: StudioProject['aspectRatio'] = '9:16',
): StudioProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: newId('project'),
    name: name.trim() || '未命名项目',
    aspectRatio,
    styleGuide: emptyStyleGuide(),
    createdAt: now,
    updatedAt: now,
  };
}

export function createEmptyBoard(projectId: string, name = '主画布'): BoardDoc {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: newId('board'),
    projectId,
    name,
    nodes: {},
    edges: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: now,
    updatedAt: now,
  };
}
