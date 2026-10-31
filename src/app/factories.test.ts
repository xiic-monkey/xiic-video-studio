import { describe, expect, it } from 'vitest';
import { createEmptyBoard, createStudioProject } from './factories';

describe('studio factories', () => {
  it('creates a project with a versioned style guide', () => {
    const project = createStudioProject('  雨夜短剧  ', '9:16');
    expect(project.name).toBe('雨夜短剧');
    expect(project.schemaVersion).toBe(1);
    expect(project.styleGuide.version).toBe(0);
    expect(project.aspectRatio).toBe('9:16');
    expect(project.id).toMatch(/^project_/);
  });

  it('falls back to a default name and creates an empty board', () => {
    const project = createStudioProject('   ');
    const board = createEmptyBoard(project.id);
    expect(project.name).toBe('未命名项目');
    expect(board.projectId).toBe(project.id);
    expect(board.nodes).toEqual({});
    expect(board.edges).toEqual({});
    expect(board.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
