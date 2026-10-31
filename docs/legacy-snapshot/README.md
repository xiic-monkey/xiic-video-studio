# 旧版分阶段工作台前端快照

2026-10-31 清理「画布优先」重构后的残留死代码时存档。

- 快照内容：旧版「故事 → 角色 → 分镜 → 素材 → 合成 → 画布」分阶段工作台的
  `App.tsx` / `bridge.ts` / `demo.ts` / `story.ts` / `styles.css` / `types.ts`
  **未提交版本**（含 2026-09-13 ~ 09-14 的 Provider 能力字段与阶段状态改动）。
- 这条链路在画布优先重构后已无人引用：`src/main.tsx` 挂载的是 `src/app/StudioApp.tsx`，
  新架构有自己的 `src/services/tauri.ts`（IPC 桥）与 `src/domain/types.ts`（领域类型）。
- 恢复方式：`cp docs/legacy-snapshot/src/<file> src/`（旧版入口需自行接回 `main.tsx`）。

用途：`src/import/legacy.ts`（P0 Task 22 旧项目导入）需要旧版项目 JSON 结构样例，
参考 `docs/fixtures/legacy-demo-project.json`（由旧 `demo.ts` 导出，字段结构与旧项目包一致）。
