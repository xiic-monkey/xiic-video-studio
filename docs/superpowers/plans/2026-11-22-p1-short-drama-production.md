# Frameforge P1 短剧制作闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Frameforge 画布内交付「中文剧本 → 可编辑三镜 → 同角色版本 → 片段生成或导入 → 剪辑混音/字幕 → 竖屏 MP4」，并支持只替换第二镜后另存新成片。

**Architecture:** React/React Flow 保留画布入口；纯 TypeScript 处理编辑与预览；Rust/Tauri 持有文件授权、SQLite 事务、模型提交及媒体任务。现有节点继续兼容，新增实体通过 `entityId` 关联画板；已采用资产、审批和导出快照不跟随最新候选自动变更。

**Tech Stack:** React 18、TypeScript 5.6、Vite 6、React Flow 12、Zustand 5、Vitest 3、Tauri 2、Rust、rusqlite/WAL、wiremock、FFmpeg/FFprobe。

**Spec:** [Frameforge 短剧制作闭环与竞品缺口设计](../specs/2026-11-22-short-drama-production-design.md)，以 §5–12 技术边界、§14 切片、§15 A01–A08 为准。源码审查基线 `e1f56d9`。本计划仅覆盖 P1；P2–P6 保持为设计中的后续范围。

**执行状态（2026-11-23）：** Task 01–14 的本地功能代码已接入；本轮复验 `pnpm test` 为 250 项通过、Rust 为 196 项通过/4 项默认忽略，`pnpm build` 通过。明确启用本机 FFmpeg/FFprobe 后，300 帧、双音轨裁切/偏移/增益和工具链能力探测用例通过。集→场→镜导航写操作、Rust 层级引用校验以及 SQLite 预览持久化/重启后一次性消费已完成。当前仍不能据此声称所有计划任务已完成：Task 15 的集成用例只是时间线纯逻辑夹具，并非“剧本→真实媒体渲染→重拍保留旧输出”的业务端到端测试；模型拆镜调用、requestId/submit intent/未知提交恢复、凭据身份锁定、桌面 IPC/GUI A01–A08、发行字体与 FFmpeg 许可、干净 macOS 安装均未完成。导出中断会暂停并要求重新预检，不猜测输出成功。详见[实现文档](2026-11-22-p1-implementation-details.md)、[媒体发行清单](p1-media-release-checklist.md)和[P1 发布证据](p1-release-evidence.md)。App 尚未上线，低版本开发 SQLite 元数据可在事务中清空并重建；不迁移旧行、不删除 CAS 媒体文件。本文件不授权提交 Git 或调用付费模型。

**当前实现标记：** 01 工具契约、02 schema/资产成员、03 项目媒体授权、04 原生导入/媒体源、05 探测/抽帧、06 修订事务与快照撤销、07 时间线/SRT、08 实际渲染与不覆盖发布、09 Compose、11 剧本导入/本地拆镜应用、12 主体版本/引用解析、13 镜头本地候选采纳/稳定审批原语、14 元数据导出脱敏均有代码和自动化覆盖。Task 10 已完成 SQLite 预览持久化与一次性消费，但仍不满足 requestId、submit intent、未知提交安全恢复和原凭据身份锁定；Task 11 未接模型拆镜，集/场/镜导航写操作与层级事务校验已接入；Task 13 集装配及换片的领域/事务接线已有，但候选预览和真实业务流程未验收。Task 15 仅有开发机媒体测试，不具备发行条件。每项差异见实现文档第 9 节。

> **勘误**：下方 checkbox 保留原始实施过程的 RED/GREEN 记录，不能单独作为当前完成状态。当前状态以本节、[实现文档第 9 节](2026-11-22-p1-implementation-details.md#9-未完成实现与发布阻断)和[发布证据](p1-release-evidence.md)为准；已完成的本地能力、仍缺的端到端能力及发行阻断已在其中逐项审计。

## Global Constraints

- 纯领域层不 import React、Tauri 或浏览器专属 API；前端不绕过 IPC 请求供应商、运行媒体命令或直接访问 CAS 持久化路径。现有原语节点、旧项目导入和多画板继续工作。
- 沿用单 SQLite/WAL；App 尚未上线，开发库 `user_version` 低于当前版本时直接重建，不回填或兼容旧数据。DB `user_version`、各 DTO 的 `schemaVersion`、实体 `revision` 与节点 `typeVersion` 独立。
- `240_000 tick/s`、`30 fps`、`8_000 tick/帧`；区间左闭右开。预设 `1080×1920` 与 `1920×1080`，MP4 H.264/AAC、`yuv420p`、48 kHz 双声道，中文字幕烧录和 UTF-8 SRT 分别验证。
- 本地素材：PNG/JPEG/WebP、MP4/MOV、WAV/MP3；图片 `30 MiB` 且不超过 `40 MP`，音频 `100 MiB`，视频 `1 GiB` 且不超过 `30 分钟`，单批 `20 项`。真实解码须符合输入类型。
- 剧本：手输或 `.txt`/`.md`/`.docx`；正文最多 `200 KiB`，单次提交最多 `16,000` 个 Unicode 码点且受模型上下文限制；来源行号从 `1` 开始、首尾均含。不自动截断、执行宏或取外链。
- 所有付费入口复用同一授权边界。编辑不调用模型；普通运行有效命中缓存不出站；未知提交不自动重发；已有远端任务只轮询原路径。Key、签名地址、授权凭证及本机路径不得进入可分享数据或通用事件。
- CAS 哈希相同只复用字节；项目归属和来源独立。预览、上游文本、模型输入、导入/抽帧/拆格/蒙版、导出都校验项目范围。文件路径只经原生入口授权。
- 本地素材路线不要求 Provider 或网络。P1 不覆盖既有目标或历史交付路径。P1 元数据包不含媒体正文、无重新导入，不能宣传为完整备份。
- 首发建议 Apple Silicon macOS；设计未指定最低系统版本，不从开发机推断。内部可用显式配置工具验证，正式支持范围以 Task 01 冻结报告与 Task 15 干净机结果为准。

## Review Focus

- 同一哈希来自两个项目且用户正切换画板：列表、缩略图、Range 及文本读取不会漏到另一项目（Task 03）。
- 脚本修改已经提交，旧的 700ms 延迟保存随后抵达：旧画板版本被拒绝，不覆盖已创建镜头（Task 06）。
- VFR/旋转源无音轨且被裁切：不存在的最后一帧不被当成 PNG；无声片段不让后续声音错位（Tasks 05、08）。
- 服务商收到请求但客户端未得到响应，或者轮询前账号已更换：不重复提交，也不拿新账号轮询（Task 10）。
- 新候选短于原入出点，旧的已审批片段仍在时间线：提示并等待确认，不挪动或覆盖历史成片（Tasks 07、13）。

---

## 执行顺序与文件边界

| 切片 | 任务 | 可独立评审的交付 |
|---|---|---|
| P1-A 媒体底座 | 01–05 | 真实探测；数据库与资产归属升级；本地可导入、预览、抽帧 |
| P1-B 成片交付 | 06–09 | 有修订控制的编辑；无 Provider 完成排序、裁切、旁白、字幕和 MP4 |
| P1-C 剧本与镜头 | 10–11 | 新旧付费入口共用确认和恢复；审阅后一次应用剧本草案 |
| P1-D 主体与生成 | 12–14 | 绑定主体版本、独立生成和采用、选择性重拍、元数据 v2 |
| 发布 | 15 | A01–A08、旧应用兼容、干净设备媒体和真实供应商冒烟记录 |

关键依赖：`01 → 04/05/08/15`；`02 → 03 → 04 → 05`；`02 → 06 → 07 → 08 → 09`；`03/06 → 10 → 11 → 12 → 13`；`08/09/13 → 14 → 15`。建议按表顺序合入；01 的工具验证可以先做，若分发方案未获批准，可继续不依赖打包的实现，但不宣布发布。不要让同一批工作并行修改 `lib.rs`、`db.rs`、`boardStore.ts` 或 Provider 运行链。

| 文件区域 | 职责 |
|---|---|
| `src-tauri/src/production/`、`src/domain/production/` | 实体、剧本草案、命令、主体解析、采纳与审批；Rust 是持久化与校验权威，TS 负责编辑与预测 |
| `src-tauri/src/media/`、`src/domain/media/` | Rust 管工具链、文件、探测与渲染；TS 管时间映射、编辑操作和字幕草案 |
| `src-tauri/src/{assets,runs,jobs,export,db,lib}.rs` 与 `src/services/tauri.ts` | 对现有实现的接入点，不另建一套任务、Provider 网关或 CAS |
| `src/app/`、`src/canvas/`、`src/inspector/`、`src/nodes/` | 逐切片增加入口和视图；已有节点不重写，不引入独立剪辑应用 |

**测试约定：** 从仓库根目录运行以下命令。新 Rust 测试使用现有 `tempfile`/`wiremock`；新 JS 测试放在 `src/**/*.test.ts`（当前 Vitest 只发现此模式）。文档中的 `it`/`#[test]` 均为待新增用例，红测以缺接口或所列断言失败为证，不能把未发现测试当成 RED。局部通过后再跑切片验证。文件清单包含主要业务文件，新增 Rust 模块同时在各自父模块登记。

**真实媒体测试：** `pnpm test` 保持无外部媒体工具可跑，覆盖纯逻辑、工具替身及明确的工具缺失分支。真实解码或渲染用例标为 `#[ignore]`，由 `-- --include-ignored` 显式纳入。Task 01 在发行清单记录测试环境的 `FRAMEFORGE_TEST_FFMPEG`、`FRAMEFORGE_TEST_FFPROBE` 和需要中文烧录时的 `FRAMEFORGE_TEST_FONT_DIR`，仅测试夹具读取，应用仍使用已经验证的工具配置。显式运行时缺少依赖应失败，不跳过；发布证据必须包含实际运行结果。

### Task 01：确定媒体工具契约与发行试构建

**Files:** 新建 `src-tauri/src/media/{mod,toolchain}.rs`、`docs/superpowers/plans/p1-media-release-checklist.md`（执行产物）；修改 `src-tauri/src/lib.rs`。发行配置 `src-tauri/tauri.conf.json` 留到 Task 15。

**Interfaces:** 产出 `MediaToolchain::probe(config: &ToolchainConfig) -> Result<MediaToolchain, MediaError>`、`MediaToolchain::capabilities(&self) -> &MediaCapabilities`；`MediaToolchain` 持有已验证的工具路径和构建指纹，能力至少区分 `probe/decode/h264/aac/subtitleBurnIn`。

- [x] **RED**：在 `toolchain::tests` 写 `rejects_missing_or_incomplete_toolchain`、`passes_only_with_required_capabilities`；替身缺 `ffprobe` 或中文字幕依赖时预检失败，内部旁挂方案仍可报告可用，正式发行门禁不通过。运行 `cargo test --manifest-path src-tauri/Cargo.toml media::toolchain::tests`，确认失败。
- [x] **实现**：工具位置来自显式内部配置或已验证发行资源，不从 IPC 接受任意可执行路径；命令非 shell 拼接。探测版本、解码和指定编码/字幕滤镜；用可再生成夹具验证可解码 MP4、独立 UTF-8 SRT 和中文字幕烧录。
- [x] **验证**：重跑同命令确认通过；记录二进制架构、构建配置、依赖许可、字体来源、实际系统版本和最小支持建议。未确认的授权或最小系统版本明确列为发布阻断，不用某台开发机的 Homebrew 成功替代。输出供 Tasks 05、08、15 复用。

### Task 02：初始化领域数据库与多项目资产索引

**Files:** 修改 `src-tauri/{Cargo.toml,src/db.rs,src/assets.rs,src/runs.rs,src/import.rs,src/lib.rs}`；新建 `src-tauri/src/production/{mod,repository}.rs` 与 `src-tauri/src/db/migration_2.sql`。

**Interfaces:** 产出 `production::repository::require_project_asset(conn: &Connection, project_id: &str, asset_id: &str) -> Result<AssetRef, ProductionError>`；`record_asset_membership(tx: &Transaction, project_id: &str, asset: &AssetRef, origin: &AssetOrigin) -> Result<(), ProductionError>`；`ProjectAssetPage { items, nextCursor }`。保留 `assets` 主表和 CAS 路径；新增表的字段以设计 §5.3 为准。

- [ ] **RED**：在 `db::tests` 写 `replaces_unreleased_v1_data_with_current_schema`；夹具通过 WAL 写入旧数据，重新打开后旧记录清空，新表就绪，版本固定且第二次打开幂等。`production::repository::tests::shared_hash_keeps_distinct_project_origins` 验证同一内容可独立归属两个项目、第三项目查不到。运行两个局部 Cargo 测试并确认失败。
- [ ] **实现**：App 未上线；版本低于当前 schema 时在一个事务里删除旧表并重建，不创建历史备份、不迁移/回填旧记录；版本高于当前版本时明确拒绝降级打开。新 schema 包含 §5.3 的实体、资产成员/来源、采纳与审批、草案/事务、任务、导出表以及 Board revision，实体 revision 初始为 1。新写入的生成/导入/派生素材要在同事务写成员关系与来源；CAS 可跨项目去重，但源记录和归属独立，不允许 `INSERT OR REPLACE` 清掉其他项目关联。
- [ ] **验证**：重跑上述两个局部测试与 `cargo test --manifest-path src-tauri/Cargo.toml import::tests`；确认旧开发库只清理一次，新数据库可重复打开、版本超前报错，同哈希跨项目分别保留来源；数据库清理不移动或误删素材存储目录外的文件。

### Task 03：切换所有素材读取和预览授权

**Files:** 新建 `src-tauri/src/media/access.rs`；修改 `src-tauri/src/{lib,runs,export}.rs`、`src-tauri/tauri.conf.json`、`src/services/tauri.ts`、`src/{app/AssetLibrary.tsx,inspector/Inspector.tsx,inspector/MaskEditor.tsx,inspector/ReferencePicker.tsx,inspector/CandidateList.tsx,nodes/useAssetUrl.ts,nodes/useTextAsset.ts,run/controller.ts}`；新增 `src/services/mediaAccess.test.ts`。用 `rg -n 'assetUrl|assetThumbUrl|readAssetText|convertFileSrc' src` 检查实际调用方，不保留隐式全局回退。

**Interfaces:** 消费 Task 02 的 `require_project_asset`。IPC `open_project_media(projectId, assetId, rendition) -> { url, expiresAt }`；`read_project_asset_text(projectId, assetId) -> string`；`list_project_assets(projectId, kind?, query?, cursor?) -> ProjectAssetPage`。`rendition` 为 `original | thumbnail | proxy`，缺派生版本只在同项目范围内回退。

- [ ] **RED**：Rust `media::access::tests` 中写 `denies_unowned_hash_and_expired_grant`、`range_only_reads_authorized_asset`，覆盖同哈希双项目、未授权第三项目、越界 Range、过期凭证及路径替代。TS 写 `drops_stale_media_response_after_project_switch`；旧项目异步结果不能进入新项目状态。运行 `cargo test --manifest-path src-tauri/Cargo.toml media::access::tests` 与 `pnpm exec vitest run src/services/mediaAccess.test.ts`，确认失败。
- [ ] **实现**：媒体协议通过作用域受限的随机令牌关联窗口、项目、素材、派生类型及有效期，服务端验证完整授权后支持播放器 `Range`；日志和 UI 状态不保存 URL 凭证。移除宽泛 `$APPDATA/assets/**` 访问与旧的全局路径 IPC。素材列表、参考图、上游文本和运行输入走项目成员关系；校验 Board/Run 对应项目，不能只相信调用方传入的 ID。保留旧运行历史显示。
- [ ] **验证**：重跑两个红测命令；桌面上同时手测图片、音频和视频拖动播放头，切项目以后旧凭证拒绝或在过期后刷新；搜索确认不再有旧的全局 CAS 读路径和 `asset_file_path` 注册。现有 `pnpm test:unit` 无回归。

### Task 04：原生授权导入与可连线媒体源节点

**Files:** 新建 `src-tauri/src/media/{grants,ingest,probe}.rs`、`src/domain/graph/output.ts`、`src/domain/graph/output.test.ts`；修改 `src-tauri/src/{lib,assets}.rs`、`src/services/tauri.ts`、`src/app/AssetLibrary.tsx`、`src/canvas/CanvasView.tsx`、`src/domain/{nodes/definitions,graph/cacheKey,run/prepare}.ts`、`src/nodes/{registry,bodies}.tsx`。

**Interfaces:** `import_media(projectId, fileGrantIds, requestId) -> { jobId }`；`list_media_tasks(projectId) -> MediaTask[]`；`cancel_media_task(projectId, jobId) -> MediaTask`；`resolveNodeOutput(node: BoardNode, portKey: string, runs: RunRecord[]): string | undefined`。固定资产源节点 `media_source` 自带 `assetId/kind`，输出类型由其真实 kind 决定，兼容旧生成节点的选中候选输出。Rust 内部 `FileGrantStore` 统一签发和核验短期授权，绑定窗口、项目与用途；`open_input` 返回已授权的可读句柄，供媒体、字幕和剧本导入分用途使用；`resolve_export_target` 只解析原生选择的写入目标，Task 08 在提交和发布时再次校验该目标及不覆盖约束。渲染器只接收授权 ID 和必要展示信息。

- [ ] **RED**：在 `media::ingest::tests` 写 `imports_valid_items_only_and_retains_after_source_removal`、`rejects_fake_or_oversize_media_before_publication`、`cannot_use_a_grant_in_another_project`；断言部分成功、失败无成员记录、源路径移走仍可读、超限阻断。TS 写 `resolves_media_source_without_run` 和 `cache_key_changes_only_when_source_asset_changes`。运行 `cargo test --manifest-path src-tauri/Cargo.toml media::ingest::tests`、`pnpm exec vitest run src/domain/graph/output.test.ts`，确认失败。
- [ ] **实现**：原生选取/桌面拖入建立文件授权；先开文件句柄、按流验证配额与真格式，在暂存区边复制边哈希，通过探测后在同卷原子发布；事务写资产、归属和来源。失败或取消清理本任务临时文件。列表按 `(addedAt, assetId)` 游标查询；「添加到画布」建媒体源，导入不发网络请求。运行输入解析通过同一个输出解析器接通源节点、老候选和派生节点。
- [ ] **验证**：重跑局部测试；真实桌面拖入 3 段源视频后关闭并移走原目录，重启仍能预览和连接。用素材文件拖入不会被误当成内部节点拖拽；旧项目导入继续可用。

### Task 05：代理、封面与抽帧

**Files:** 新建 `src-tauri/src/media/{derive,fixtures}.rs`；修改 `src-tauri/src/media/{mod,probe}.rs`、`src-tauri/src/lib.rs`、`src/services/tauri.ts`、`src/inspector/Inspector.tsx`。

**Interfaces:** `extract_media_frame(projectId, assetId, selector, requestId) -> { jobId }`，`selector = first | last | { atTicks }`；成功结果 `DerivedFrame { assetId, sourceAssetId, actualTicks }`；重用 Task 04 查询/取消。

- [ ] **RED**：写 `media::derive::tests::{last_frame_uses_actual_timestamp_for_rotated_vfr,identical_derivation_reuses_output,derived_task_can_be_cancelled}`；用异色 VFR 尾帧与 90° 旋转，断言实际帧、方向和父资产，重做相同派生哈希稳定。按真实媒体测试约定运行 `cargo test --manifest-path src-tauri/Cargo.toml media::derive::tests -- --include-ignored`，确认失败；缺工具分支另做不依赖本机工具的单测。
- [ ] **实现**：按真实时间戳抽首/尾/当前可解码帧，不用 `duration - 1/fps` 猜尾帧；对需要全解码的源限时且可取消。缓存键包含源哈希、选择器、变换规则和实现版本；派生发布后更新索引。代理与封面失败不损伤源资产，导出继续用源，Inspector 提供可访问的抽帧按钮与结果节点。
- [ ] **验证**：重跑派生测试；对无音轨视频、旋转 MOV 和 VFR 夹具做本地预览检查。P1-A 切片通过后，确认当前即可无需供应商导入、预览、抽帧和复用。

### Task 06：修订、制作事务与撤销边界

**Files:** 新建 `src-tauri/src/production/{types,commands}.rs`、`src/domain/production/{types,changes,changes.test}.ts`；修改 `src-tauri/src/lib.rs`、`src/services/tauri.ts`、`src/domain/types.ts`、`src/stores/{boardStore,studioStore}.ts`。

**Interfaces:** `save_board(board, expectedRevision) -> { revision }`；`list_production_entities(projectId, kind?, cursor?) -> EntityPage`；`apply_production_change(projectId, changeId, expectedRevisions, operations) -> { revisionMap, affectedIds }`；`revert_production_change(projectId, changeId, revertId) -> ChangeResult`。`expectedRevisions` 按对象 ID 指定，`0` 代表创建且要求不存在；`operations` 为受限 DTO 联合，不接受任意 JSON Patch 或 SQL。制作变更发出 `production.changed`，读端按最新修订重查；导入和导出以 `asset.ingest.updated` / `media.export.updated` 通知，事件只携带脱敏状态而非权威数据。

- [ ] **RED**：Rust `production::commands::tests` 写 `rolls_back_all_changes_on_bad_reference`、`rejects_autosave_from_before_successful_change`、`idempotent_same_id_but_different_payload_is_conflict`、`undo_preserves_media_and_rejects_later_adjustment`；TS `changes.test.ts` 写 `waits_for_in_flight_save_before_production_change`。运行 `cargo test --manifest-path src-tauri/Cargo.toml production::commands::tests`、`pnpm exec vitest run src/domain/production/changes.test.ts`，确认失败。
- [ ] **实现**：新增/更新镜头、关联节点、模板和时间线时在一事务内校验实体类型、归属、版本、所有引用和命令哈希；已提交相同请求返回旧结果。先 flush 并等待同画板的 in-flight save，而非仅清 timer；旧写入按 DB revision 拒绝。普通历史不跨制作事务；制作反向操作另写新修订，不取消远程任务或删除资产。
- [ ] **验证**：重跑红测命令；用两个快速编辑/应用/切板场景核实不会把旧 revision 响应恢复到新画板。UI 能定位冲突并保留原草案，状态以事务响应与重查为准。

### Task 07：时间线编辑、整数帧和预检纯逻辑

**Files:** 新建 `src/domain/media/{timeline,timeline.test,subtitles,subtitles.test}.ts`、`src-tauri/src/media/timeline.rs`、`docs/fixtures/p1-timeline.json`；修改 `src-tauri/src/production/{types,commands}.rs`。

**Interfaces:** `compileTimeline(data: TimelineData, assets: Readonly<Record<string, ProbedAsset>>): TimelinePlan`；`applyTimelineEdit(data: TimelineData, edit: TimelineEdit): EditResult`；`parseSrt(input: string): SubtitleCue[]`；`formatSrt(cues: readonly SubtitleCue[]): string`；Rust `validate_timeline(data: &TimelineData, sources: &SourceMap) -> Result<TimelinePlan, MediaError>` 是权威，TS 预览与 Rust 同夹具。`TimelinePlan` 生成按顺序的片段、可解析音轨/字幕、`totalTicks` 和质量问题。

- [ ] **RED**：TS 写 `trims_4_5_3_sources_to_300_frames`（10 秒、`2_400_000` ticks）；`moves_only_anchored_cues_when_reordered`；`flags_cross_cut_and_out_of_range_cues`；`shorter_replacement_requires_trim_confirmation`；UTF-8 SRT 往返含中文与多行。Rust 加 `compile_matches_shared_timeline_fixture`。运行 `pnpm exec vitest run src/domain/media/timeline.test.ts src/domain/media/subtitles.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml media::timeline::tests`，确认失败。
- [ ] **实现**：限定一个连续主轨，支持启用、排序、裁切、拆分、固定资产换片；片段位置由排序与长度派生，源区间按输出帧边界转换，音频与字幕独立锚定。Rust 明确验证 `assemblyScope`、缺件和告警；独立合成不检查剧本完整性。源文件被删、字幕超界、片段过短均阻断；不做 P1 外转场/多视频轨。
- [ ] **验证**：重跑两侧测试，使用同一 JSON 夹具比较 TS/Rust 编译后的片段边界、音轨起点及字幕；操纵器传错误 `sourceOutTicks` 无法绕过后端校验。

### Task 08：冻结成片快照、渲染和不覆盖发布

**Files:** 新建 `src-tauri/src/media/{render,export_task,publish}.rs`；修改 `src-tauri/src/media/mod.rs`、`src-tauri/src/lib.rs`、`src/services/tauri.ts`。复用 Tasks 05、07 的媒体与时间线夹具。媒体集成测试写在 Rust crate 内的 `media::render::tests`，避免为测试暴露内部执行入口。项目 JSON 导出仍属于 Task 14。

**Interfaces:** `prepare_media_export(projectId, timelineId, revision, preset, targetGrantId) -> ExportPreview`；`start_media_export(previewId, acknowledgedIssueIds, requestId) -> { exportId }`；`ExportPreview { previewId, editHash, totalTicks, preset, issues }`，预览本身不写目标文件。`list_media_tasks` 可查询导出阶段；`exportId` 与媒体任务 ID 一致对外可查询。

- [ ] **RED**：写 `media::export_task::tests::{rejects_changed_timeline_and_unacknowledged_warning,never_overwrites_external_or_historical_target,recovers_mp4_and_srt_publication_after_interrupt}`；断言改变时间线旧确认无效、两个请求竞争同目标至多一个成功、只写成 MP4 未完成 SRT 时可对账、取消不删旧输出。`media::render::tests::renders_300_frames_with_audio_and_cjk_burn_in` 检查 300 帧、字幕区域及有/无音片段音轨边界。运行 `cargo test --manifest-path src-tauri/Cargo.toml media::export_task::tests`、`cargo test --manifest-path src-tauri/Cargo.toml media::render::tests -- --include-ignored`，确认失败。
- [ ] **实现**：预检从 DB 读取时间线，按版本、编辑语义哈希、素材成员及目标授权冻结；`requestId` 幂等。同一次导出只读该快照；处理旋转、缩放、像素/帧率、静音填充、混音与字幕，在可取消进程中渲染。ffprobe 验 MP4 的流、尺寸、帧率和时长，落盘清单后用不覆盖语义发布；MP4 与 SRT 逐文件对账，不承诺两个目标同时原子提交。重启扫描未达终态任务，不能仅凭同名文件判断成功。
- [ ] **验证**：重跑两类测试；用显式、已验证媒体工具跑集成套件，审查输出哈希、封面/字幕、哨兵音轨时间位置。修改渲染中时间线，旧输出仍与冻结快照匹配；同名一律提示另存。记录失败 stderr 的脱敏行为。

### Task 09：Compose 面板、预览与本地片段端到端

**Files:** 新建 `src/media/{TimelineDrawer.tsx,ComposeInspector.tsx,ExportDialog.tsx,timelineController.ts,timelineController.test.ts}`、`src-tauri/src/media/subtitles.rs`；修改 `src/app/StudioApp.tsx`、`src/canvas/CanvasView.tsx`、`src/inspector/Inspector.tsx`、`src/domain/nodes/definitions.ts`、`src/nodes/registry.tsx`、`src/styles/studio.css`、`src/services/tauri.ts`、`src-tauri/src/lib.rs`。

**Interfaces:** `createLocalCompose(projectId, boardId, orderedAssetIds) -> Promise<ChangeResult>`；`commitTimelineEdit(timelineId, expectedRevision, edit) -> Promise<ChangeResult>`；IPC `import_subtitle_document(projectId, fileGrantId) -> { text, displayName }` 仅从 Task 04 的字幕输入授权读取有界 UTF-8 内容。`createLocalCompose` 经 Task 06 同事务创建绑定 Timeline 实体的 `compose` 节点，使用 Tasks 07–08 时间映射与导出预检。

- [ ] **RED**：在 `timelineController.test.ts` 写 `creates_compose_in_confirmed_order_without_provider`、`keeps_newer_edit_when_export_progress_arrives`、`cannot_confirm_blocking_preflight_issue`、`reloads_active_exports_after_remount`；在 `media::subtitles::tests` 写 `rejects_ungranted_or_non_utf8_subtitle`。运行 `pnpm exec vitest run src/media/timelineController.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml media::subtitles::tests`，确认失败。
- [ ] **实现**：提供选中媒体→建合成、视频主轨排序/裁切/拆分、播放器、音轨导入、字幕编辑和进度/取消。手填、粘贴台词和 UTF-8 SRT 导入进入字幕草案；台词需要人工校时，确认后走时间线事务。播放与编辑复用 Task 07 的映射；用项目媒体授权进播放器，不出站。错误及告警可定位，阻断不可「忽略」。拖拽操作提供按钮或键盘等价；输入框内不触发画布快捷键。
- [ ] **验证**：重跑局部测试、`pnpm build`；在 `pnpm tauri dev` 里断网、未配置 Provider，用三个本地视频完成 A02，导出烧录版和 SRT 旁挂版。手测键盘排序、切板后查询进度、取消不删既有成片。提交 P1-B 演示证据，不要求剧本工作流已可用。

### Task 10：统一所有付费入口与未知提交恢复

**Files:** 新建 `src-tauri/src/run_authorization.rs`、`src-tauri/src/db/migration_3.sql`；修改 `src-tauri/src/{lib,db,runs,jobs}.rs`、`src-tauri/src/gateway/mod.rs`、`src/services/tauri.ts`、`src/run/{controller.ts,controller.test.ts,RunConfirmDialog.tsx,events.ts}`、`src/domain/{types.ts,run/prepare.ts}`。

**Interfaces:** `prepare_paid_run(projectId, boardId, expectedRevision, draft) -> RunPreview`；`start_paid_run(previewId, requestId) -> RunRecord`；`RunPreview { previewId, fingerprint, cached, routes, estimates, warnings }`。`draft` 是既有 `StartRunRequest` 所需输入的受控投影，不接受前端指定的缓存结果、外链或费用为运行依据。镜头/剧本经专用 prepare 不同入口进入相同确认和提交内核，`RunRecord` 继续承接历史与 UI。

- [ ] **RED**：Rust `run_authorization::tests` 写 `rejects_expired_replayed_or_modified_preview`、`cached_run_does_not_call_provider`、`ambiguous_submit_does_not_try_next_key_or_restart_submit`、`pending_job_pauses_if_original_credential_changed`；`wiremock` 明确断言提交次数、服务商路径、轮询次数。TS 增加 `primitive_run_requires_backend_preview`、`changed_route_requires_confirming_again`。运行 `cargo test --manifest-path src-tauri/Cargo.toml run_authorization::tests`、`pnpm exec vitest run src/run/controller.test.ts`，确认失败。
- [ ] **实现预检/确认**：后端冻结能力、目标规范、服务范围、实际输入及上限，缓存检查重新验证文件及项目归属。用本机预览凭证、修订与 `requestId` 验证一次逻辑提交；旧 `start_run` 不再作为可绕过预览的对外命令，原语节点原 UI 可继续使用。
- [ ] **实现状态/恢复**：远程请求前落盘逻辑操作；只有明确未接单且属于用户确认候选时才回退。传输中断等不确定结果记 `submission_unknown`，既不自动重提也不换 Key。远端任务轮询锁定端点、适配器与凭据身份版本；原凭据不可安全使用则暂停。旧在途任务缺可信冻结信息时仅在可验证原路径的情况下继续，否则显式暂停，不重发；历史运行保持可读。
- [ ] **验证**：重跑红测、`cargo test --manifest-path src-tauri/Cargo.toml jobs::tests` 及 `pnpm test:unit`；模拟无 Key、缓存零请求、明确限流回退与超时后单次请求。确认视图不显示敏感字段，项目切换/修改后旧预览不可提交。

### Task 11：导入剧本、拆镜草案与一致应用

**Files:** 新建 `src-tauri/src/production/{script,breakdown}.rs`、`src/domain/production/{breakdown,breakdown.test}.ts`、`src/production/{ScriptPanel,BreakdownReview,ShotList,ShotCard}.tsx`、`docs/fixtures/p1-breakdown-three-shots.json`；修改 `src-tauri/src/production/{types,commands}.rs`、`src-tauri/{Cargo.toml,src/lib.rs}`、`src/services/tauri.ts`、`src/app/StudioApp.tsx`、`src/domain/nodes/definitions.ts`、`src/nodes/registry.tsx`。

**Interfaces:** `import_script_document(projectId, fileGrantId) -> { title, body, displayName }`；`prepare_script_breakdown(projectId, scriptId, scriptRevision, selection?) -> RunPreview`，由 `start_paid_run` 确认；`list_breakdown_drafts(projectId, scriptId) -> BreakdownDraft[]`；`buildBreakdownDiff(draft: BreakdownDraft, baseline: AppliedBreakdown | undefined, current: ProductionIndex): BreakdownDiff`；Task 06 `apply_production_change` 新增 `applyBreakdown` 操作。

- [ ] **RED**：Rust 写 `production::breakdown::tests::{strict_draft_rejects_bad_line_and_local_ids,malformed_result_never_creates_entities_or_repays,applies_once_or_rejects_changed_source_revision}`，以及 `production::script::tests::rejects_invalid_or_inflated_docx`；TS 补 `preserves_human_edit_and_adopted_media_on_redraft`、`marks_ambiguous_matches_for_manual_mapping`。分别运行 `cargo test --manifest-path src-tauri/Cargo.toml production::breakdown::tests`、`cargo test --manifest-path src-tauri/Cargo.toml production::script::tests`、`pnpm exec vitest run src/domain/production/breakdown.test.ts`，确认失败。
- [ ] **实现导入和编译**：本地校验文件授权，严格 UTF-8 或受体积/条目上限约束的 DOCX ZIP/XML 正文解析；不执行宏、外链和嵌入对象。按保存修订及选区发起文本模型调用，解析 JSON 严格校验临时编号、来源行、归属和数量，草案与原文分别保存。模型失败不写正式实体或自动再次提交。
- [ ] **实现应用**：用户手改场/镜/主体占位与标注后查看差异；比较基线、现值和草案，无唯一匹配时不按展示镜号覆盖。只应用明确选择的修改；同事务写集场镜、占位与画板节点，保留手改、已采纳和旧剪辑；版本冲突保留草案。本任务交付可编辑镜头规格与基础镜头卡，不显示尚不可用的生成动作。「竖屏三镜」内置模板创建剧本与流程骨架，镜头由确认草案创建，不预置重复的正式镜头。
- [ ] **验证**：重跑三条局部测试；模拟模型拆出三镜，改台词并一次应用，再编辑原稿触发并解决冲突；观察无半张画板、多次提交无重复实体。主管理视图能从按集/场/镜的列表跳转画布。

### Task 12：主体版本、参考解析与尾帧接续

**Files:** 新建 `src-tauri/src/production/{subjects,references}.rs`、`src/domain/production/{references,references.test}.ts`、`src/production/{SubjectLibrary.tsx,SubjectBindingEditor.tsx}`；修改 `src-tauri/src/production/{types,commands}.rs`、`src-tauri/src/lib.rs`、`src/domain/{graph/cacheKey,run/prepare}.ts`、`src/services/tauri.ts`、`src/app/StudioApp.tsx`、`src/inspector/Inspector.tsx`。

**Interfaces:** `resolveShotReferences(input: ShotReferenceInput): ResolvedShotReferences`，字段包括 `descriptor, orderedInputs, excludedInputs, issues, fingerprint`；Rust `resolve_shot_references(input: &ShotReferenceInput) -> Result<ResolvedShotReferences, ProductionError>` 是提交权威，使用与 TS 同样的规范化夹具。`apply_production_change` 新增 `createSubjectVersion`、`setShotBindings`、`attachPreviousLastFrame`。

- [ ] **RED**：TS 写 `same_role_asset_deduplicates_but_first_frame_and_ref_stay_distinct`、`first_last_does_not_mix_generic_references`、`renaming_subject_does_not_change_fingerprint`、`rebind_changes_only_users_of_that_version`；Rust 写 `production::references::tests::matches_shared_resolution_cases`、`previous_tail_stays_fixed_after_upstream_replacement`。运行 `pnpm exec vitest run src/domain/production/references.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml production::references::tests`，确认失败。
- [ ] **实现**：同项目建角色/地点/道具，存不可变身份描述、视角与可选现有 TTS 音色。镜头选择主体 ID 和具体版本；「当前版本」更新不迁移旧镜头。解析显式端口、主体视角、风格与额外参考，展示接受、排除原因和能力额度；主动超配需处理，不静默截断。抽上一镜尾帧经 Task 05 校验并冻结来源镜头、视频哈希和帧哈希，仅提示上游更新。
- [ ] **验证**：重跑双侧夹具；手测一个角色版本绑定三镜、切首尾帧模式时可读原因、更新单镜绑定不触发远程生成；跨项目主体绑定拒绝。

### Task 13：镜头逐项生成、采纳、审批和选择性重拍

**Files:** 新建 `src-tauri/src/production/shots.rs`、`src/domain/production/{shots,shots.test}.ts`、`src/production/ShotInspector.tsx`；修改 `src-tauri/src/production/{types,commands}.rs`、`src-tauri/src/lib.rs`、`src/services/tauri.ts`、`src/{production/ShotCard.tsx,production/ShotList.tsx,run/controller.ts,canvas/CanvasView.tsx,inspector/Inspector.tsx,domain/nodes/definitions.ts,media/timelineController.ts,app/StudioApp.tsx}`。

**Interfaces:** `prepare_shot_run(projectId, shotId, action, intent, overrides?) -> RunPreview`，`action = storyboard | firstFrame | lastFrame | video | dialogue`，`intent = normal | regenerate`，执行仍走 `start_paid_run`。事务操作 `adoptShotMedia`、`recordProductionReview`、`assembleEpisode`、`replaceTimelineClip`。`previewShotReplacement(clip: TimelineClip, adoption: ShotAdoption, asset: ProbedAsset): ReplacePreview` 必须报告可保留与需调整的入出点。

- [ ] **RED**：Rust `production::shots::tests` 写 `adoptions_and_reviews_are_immutable_and_specific_to_version`、`regenerate_bypasses_cache_but_leaves_existing_adoption`、`run_completing_with_old_inputs_is_not_auto_adopted`、`episode_assembly_freezes_required_shots`；TS `shots.test.ts` 写 `replacing_second_shot_preserves_others_and_subtitle_anchors`、`asks_for_confirmation_when_retake_is_shorter`。运行 `cargo test --manifest-path src-tauri/Cargo.toml production::shots::tests`、`pnpm exec vitest run src/domain/production/shots.test.ts`，确认失败。
- [ ] **实现生成**：镜头卡按槽展示当前结果和候选；每动作只建一个主执行节点，其他画板链接过去。利用现有图/视频/语音节点及 Task 12 解析器，显示原始/覆盖/锁定提示词；缓存优先，显式重拍应绕过缓存。未完成步骤提示原因，不自动执行付费上游。支持从已有原语结果或媒体直接填兼容槽。
- [ ] **实现采用/剪辑衔接**：采用产生不可变采纳行，镜头审批关联 `specHash + videoAdoptionId`，剪辑审批关联 `editHash`；历史审批不传给新片。集装配冻结必需镜头及排除规则；时间线收到新候选仅标记，用户确认换片后保留无冲突编辑。短于原区间必须处理，缺应交付镜头只允许草稿预览，正式导出仍阻断。
- [ ] **验证**：重跑局部测试；演示从同角色三镜直接生成/采用到装配导出，重拍第二镜但不自动替换，再手动确认第二镜。旧审批/成片保持；A03、A04 用快照及实际请求数作证据。

### Task 14：元数据 v2、历史兼容与分享前脱敏

**Files:** 修改 `src-tauri/src/export.rs`、`src-tauri/src/import.rs`、`src/app/ProjectLibrary.tsx`、`src/services/tauri.ts`；新增 `docs/fixtures/p1-legacy-export-golden.json`（脱敏期望结构）。

**Interfaces:** 继续使用 `export_project`，输出 `packageKind: 'frameforge.project'`、`schemaVersion: 2`、`assetBodiesIncluded: false`。显式 allowlist 包含可分享项目、画板、运行摘要、实体、采用/审批、主体版本、导出快照摘要及可解析资产清单。候选/归属信息来自 Tasks 02、13，不重建 P1 导入协议。

- [ ] **RED**：Rust 加 `exports_v2_production_metadata_without_asset_bodies`、`does_not_export_paths_tokens_or_provider_secret_references`、`legacy_project_still_opens_and_exports_with_new_tables`。夹具覆盖新嵌套主体声音、运行授权和导出快照，断言没有 Key、本机完整路径、授权凭证、远端任务 ID、签名 URL；项目资产清单不含别的项目。运行 `cargo test --manifest-path src-tauri/Cargo.toml export::tests`，确认失败。
- [ ] **实现**：构建白名单 DTO，先按项目获取实体、版本、记录和使用中的资产，再执行已有脱敏；不直接导出本地内部授权表或完整快照 payload。项目库明确标记「元数据 JSON，不含媒体文件」，区分 Compose 成片的 MP4/SRT 入口；旧分阶段导入兼容，现有 v1/v2 元数据 P1 无重新导入功能。
- [ ] **验证**：重跑 `cargo test --manifest-path src-tauri/Cargo.toml export::tests` 与 `cargo test --manifest-path src-tauri/Cargo.toml import::tests`；对 golden JSON 比对字段并检查老画板仍能运行图/视频，局部能力 Git diff 无关变更不混入。

### Task 15：集成验收、发行打包和证据收口

**Files:** 新建 `docs/superpowers/plans/p1-release-evidence.md`（执行产物）、`src-tauri/src/production/flow_tests.rs` 并在 `src-tauri/src/production/mod.rs` 中仅测试构建启用；修改 `src-tauri/tauri.conf.json` 和 Task 01 发行清单。媒体资源的打包位置与许可材料由 Task 01 验证后记录；不能把未获许可的二进制直接加入仓库。

**Interfaces:** 消费 Tasks 01–14 已交付的实际接口；维持现有 `pnpm test`、`pnpm build`。发行证据字段：基线提交、体系结构/系统版本、二进制及许可、每条验收输入、实际输出、命令/截图或日志、失败/阻断说明。

- [ ] **集成基线**：加入 Rust `p1_mock_script_to_three_shot_publish_and_retake` 用例，使用本地模拟服务、Tasks 05、07 媒体与时间线夹具、Task 11 剧本，走实际业务服务边界。必须证明可写出 300 帧、固定三镜绑定、保留原输出字节；若绕过确认/提交契约或使用伪 MP4，不算验收。运行 `cargo test --manifest-path src-tauri/Cargo.toml production::flow_tests -- --include-ignored` 并记录断点；若前置任务已满足，保留真实通过，不制造假失败。桌面 IPC 及用户确认由实机流程另外验收。
- [ ] **实现/整合**：按 Task 01 获准方案打包媒体组件、许可和字体。只修复阻断上述用例的接线；未批准分发或没有干净机，明确保留发布阻断，不用开发机替代。录入以下矩阵 A01–A08 与 P1 的真实生成冒烟；后者单独获得用户授权与预算后再做。
- [ ] **验证**：运行 `pnpm test`、`pnpm build`；显式媒体环境下运行 `cargo test --manifest-path src-tauri/Cargo.toml media::derive::tests -- --include-ignored`、`cargo test --manifest-path src-tauri/Cargo.toml media::render::tests -- --include-ignored` 与 `cargo test --manifest-path src-tauri/Cargo.toml production::flow_tests -- --include-ignored`；打包执行 `pnpm tauri build --target aarch64-apple-darwin --bundles app`。在目标范围的干净 macOS 安装中断网并确认无本机 FFmpeg 依赖，运行本地素材编辑/字幕烧录与旁挂；再用用户明确授权的文本/视频模型验证逐项分镜、首尾帧、远端任务恢复和重拍。留存结果，不留密钥。

## 发布验收追踪

| 设计验收 | 实施任务 | 通过证据 |
|---|---|---|
| A01 三镜成片 | 09、11–13、15 | 「竖屏三镜」模板、同一角色版本、干净安装离线中文字幕烧录、1080×1920 MP4、旁挂 SRT |
| A02 精确计时 | 07–09、15 | `4/5/3 秒 − 0.5/1/0.5 秒 = 10 秒`，恰 300 帧；验证切点、音轨和字幕 |
| A03 单镜返工 | 07、08、13 | 旧 MP4 的 SHA-256 不变；只换第 2 镜的采纳/剪辑，未采用的新片不进入时间线 |
| A04 缓存与版本 | 04、10、12、13 | 请求计数证明缓存零出站；拖拽/改名无误失效，实际输入变化才标过期 |
| A05 媒体与隔离 | 02–05、08 | VFR、旋转和无音轨夹具，第三项目及过期媒体凭证访问被拒 |
| A06 退出与恢复 | 06、08、10、11 | 真正模拟中断、同 `requestId` 重试、账号变更和版本冲突；只恢复原轮询，无重复出站 |
| A07 兼容与交接 | 02、10、14、15 | v1 SQLite 夹具、旧项目导入、老原语节点、v2 元数据包无正文与凭证 |
| A08 错误与可访问性 | 01、03、04、07–09、15 | 无 Provider 流程、缺工具/资产、路径冲突、键盘操作与可定位错误 |

## 审阅与实施交接

- 先批准本计划的 P1 门槛与媒体发行方案（或同意先完成 Task 01、将正式发行标为阻断）。若希望首版交付跨设备项目恢复、Shot 自动一条龙或多视频轨，先改设计和任务依赖，不在实施中隐式增加范围。
- 每个任务的审查材料：触及文件和接口、RED/通过证据、已知限制、与后续接口是否一致；每个切片结束跑相关回归，Task 15 再统一标记可发布状态。
- P2–P6 不在本计划中预留不可用 UI 或未授权接口；从此计划交付的稳定契约继续拆分各期独立子计划。
