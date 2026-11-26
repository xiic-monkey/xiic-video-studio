import { create } from 'zustand';
import type { BoardDoc, StudioProject } from '../domain/types';
import {
  deleteBoard as deleteBoardCommand,
  deleteStudioProject,
  listBoards,
  listStudioProjects,
  loadBoard,
  saveBoard,
  saveStudioProject,
} from '../services/tauri';
import { createEmptyBoard, createStudioProject } from '../app/factories';
import { invalidateTextCache } from '../run/controller';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 上次打开的项目与画布。
 *
 * 存在 localStorage 而不是数据库：这是一次性的界面偏好，不需要进工程数据，
 * 也不该跟着项目导出走。读不到就退回「第一个项目 / 第一张画布」。
 */
const LAST_OPENED_KEY = 'frameforge.lastOpened';

interface LastOpened {
  projectId?: string;
  boardId?: string;
}

function readLastOpened(): LastOpened {
  try {
    const raw = window.localStorage.getItem(LAST_OPENED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as LastOpened;
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function writeLastOpened(value: LastOpened): void {
  try {
    window.localStorage.setItem(LAST_OPENED_KEY, JSON.stringify(value));
  } catch {
    // 隐私模式或存储不可用时忽略：只是少了个记忆功能，不该阻断主流程。
  }
}

interface StudioState {
  booted: boolean;
  loading: boolean;
  projects: StudioProject[];
  boards: BoardDoc[];
  currentProjectId?: string;
  currentBoardId?: string;
  error?: string;
  legacyImportOpen: boolean;
  boot(force?: boolean): Promise<void>;
  createProject(name: string, aspectRatio: StudioProject['aspectRatio']): Promise<StudioProject>;
  selectProject(projectId: string): Promise<void>;
  createBoard(name: string): Promise<BoardDoc | undefined>;
  selectBoard(boardId: string): Promise<BoardDoc | undefined>;
  removeBoard(boardId: string): Promise<void>;
  /** 删除项目及其全部画布、制作数据与资产关联。 */
  removeProject(projectId: string): Promise<void>;
  openLegacyImport(): void;
  closeLegacyImport(): void;
  setError(message?: string): void;
}

export const useStudioStore = create<StudioState>((set, get) => ({
  booted: false,
  loading: false,
  projects: [],
  boards: [],
  legacyImportOpen: false,

  async boot(force) {
    if (!force && (get().booted || get().loading)) return;
    set({ loading: true, error: undefined });
    try {
      const projects = await listStudioProjects();
      const last = readLastOpened();
      // 上次打开的项目可能已被删除：找不到就退回第一个项目。
      const currentProjectId = projects.some((item) => item.id === last.projectId)
        ? last.projectId
        : projects[0]?.id;
      const boards = currentProjectId ? await listBoards(currentProjectId) : [];
      const currentBoardId = boards.some((item) => item.id === last.boardId)
        ? last.boardId
        : boards[0]?.id;
      set({
        booted: true,
        loading: false,
        projects,
        boards,
        currentProjectId,
        currentBoardId,
      });
      writeLastOpened({ projectId: currentProjectId, boardId: currentBoardId });
    } catch (error) {
      set({ booted: true, loading: false, error: messageOf(error) });
    }
  },

  async createProject(name, aspectRatio) {
    const project = createStudioProject(name, aspectRatio);
    await saveStudioProject(project);
    const board = createEmptyBoard(project.id);
    const savedBoard = { ...board, revision: (await saveBoard(board)).revision };
    set((state) => ({
      projects: [project, ...state.projects],
      boards: [savedBoard],
      currentProjectId: project.id,
      currentBoardId: savedBoard.id,
      error: undefined,
    }));
    writeLastOpened({ projectId: project.id, boardId: savedBoard.id });
    return project;
  },

  async selectProject(projectId) {
    set({ loading: true, error: undefined });
    try {
      const boards = await listBoards(projectId);
      const last = readLastOpened();
      const currentBoardId = boards.some((item) => item.id === last.boardId)
        ? last.boardId
        : boards[0]?.id;
      set({
        loading: false,
        currentProjectId: projectId,
        boards,
        currentBoardId,
      });
      writeLastOpened({ projectId, boardId: currentBoardId });
      // 切项目后旧项目的文本缓存不再有用：留着会在新项目里读到别的工程的内容。
      invalidateTextCache();
    } catch (error) {
      set({ loading: false, error: messageOf(error) });
    }
  },

  async createBoard(name) {
    const projectId = get().currentProjectId;
    if (!projectId) return undefined;
    const board = createEmptyBoard(projectId, name.trim() || '未命名画布');
    const savedBoard = { ...board, revision: (await saveBoard(board)).revision };
    set((state) => ({
      boards: [savedBoard, ...state.boards],
      currentBoardId: savedBoard.id,
      error: undefined,
    }));
    writeLastOpened({ projectId, boardId: savedBoard.id });
    return savedBoard;
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
    writeLastOpened({ projectId: get().currentProjectId, boardId });
    return board;
  },

  async removeBoard(boardId) {
    const state = get();
    await deleteBoardCommand(boardId);
    const boards = state.boards.filter((board) => board.id !== boardId);
    const currentBoardId = state.currentBoardId === boardId ? boards[0]?.id : state.currentBoardId;
    set({
      boards,
      currentBoardId,
      error: undefined,
    });
    writeLastOpened({ projectId: state.currentProjectId, boardId: currentBoardId });
  },

  async removeProject(projectId) {
    const state = get();
    await deleteStudioProject(projectId);
    const projects = state.projects.filter((project) => project.id !== projectId);
    const removedCurrent = state.currentProjectId === projectId;
    const nextProjectId = removedCurrent ? projects[0]?.id : state.currentProjectId;
    const boards = nextProjectId && removedCurrent ? await listBoards(nextProjectId) : state.boards;
    const currentBoardId = removedCurrent ? boards[0]?.id : state.currentBoardId;
    set({
      projects,
      boards,
      currentProjectId: nextProjectId,
      currentBoardId,
      error: undefined,
    });
    writeLastOpened({ projectId: nextProjectId, boardId: currentBoardId });
  },

  openLegacyImport() {
    set({ legacyImportOpen: true });
  },

  closeLegacyImport() {
    set({ legacyImportOpen: false });
  },

  setError(message) {
    set({ error: message });
  },
}));
