import { create } from 'zustand';
import type { BoardDoc, StudioProject } from '../domain/types';
import {
  deleteBoard as deleteBoardCommand,
  listBoards,
  listStudioProjects,
  loadBoard,
  saveBoard,
  saveStudioProject,
} from '../services/tauri';
import { createEmptyBoard, createStudioProject } from '../app/factories';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface StudioState {
  booted: boolean;
  loading: boolean;
  projects: StudioProject[];
  boards: BoardDoc[];
  currentProjectId?: string;
  currentBoardId?: string;
  error?: string;
  boot(): Promise<void>;
  createProject(name: string, aspectRatio: StudioProject['aspectRatio']): Promise<StudioProject>;
  selectProject(projectId: string): Promise<void>;
  createBoard(name: string): Promise<BoardDoc | undefined>;
  selectBoard(boardId: string): Promise<BoardDoc | undefined>;
  removeBoard(boardId: string): Promise<void>;
  setError(message?: string): void;
}

export const useStudioStore = create<StudioState>((set, get) => ({
  booted: false,
  loading: false,
  projects: [],
  boards: [],

  async boot() {
    if (get().booted || get().loading) return;
    set({ loading: true, error: undefined });
    try {
      const projects = await listStudioProjects();
      const currentProjectId = projects[0]?.id;
      const boards = currentProjectId ? await listBoards(currentProjectId) : [];
      set({
        booted: true,
        loading: false,
        projects,
        boards,
        currentProjectId,
        currentBoardId: boards[0]?.id,
      });
    } catch (error) {
      set({ booted: true, loading: false, error: messageOf(error) });
    }
  },

  async createProject(name, aspectRatio) {
    const project = createStudioProject(name, aspectRatio);
    await saveStudioProject(project);
    const board = createEmptyBoard(project.id);
    await saveBoard(board);
    set((state) => ({
      projects: [project, ...state.projects],
      boards: [board],
      currentProjectId: project.id,
      currentBoardId: board.id,
      error: undefined,
    }));
    return project;
  },

  async selectProject(projectId) {
    set({ loading: true, error: undefined });
    try {
      const boards = await listBoards(projectId);
      set({
        loading: false,
        currentProjectId: projectId,
        boards,
        currentBoardId: boards[0]?.id,
      });
    } catch (error) {
      set({ loading: false, error: messageOf(error) });
    }
  },

  async createBoard(name) {
    const projectId = get().currentProjectId;
    if (!projectId) return undefined;
    const board = createEmptyBoard(projectId, name.trim() || '未命名画布');
    await saveBoard(board);
    set((state) => ({
      boards: [board, ...state.boards],
      currentBoardId: board.id,
      error: undefined,
    }));
    return board;
  },

  async selectBoard(boardId) {
    const board = await loadBoard(boardId);
    if (!board) {
      set({ error: '画布不存在或已被删除' });
      return undefined;
    }
    set((state) => ({
      currentBoardId: boardId,
      boards: state.boards.map((item) => (item.id === boardId ? board : item)),
      error: undefined,
    }));
    return board;
  },

  async removeBoard(boardId) {
    const state = get();
    await deleteBoardCommand(boardId);
    const boards = state.boards.filter((board) => board.id !== boardId);
    set({
      boards,
      currentBoardId: state.currentBoardId === boardId ? boards[0]?.id : state.currentBoardId,
      error: undefined,
    });
  },

  setError(message) {
    set({ error: message });
  },
}));
