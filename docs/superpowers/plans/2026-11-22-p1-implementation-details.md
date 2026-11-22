# Frameforge P1 实现文档

> 本文是 [P1 短剧制作计划](2026-11-22-p1-short-drama-production.md) 的实现级补充。产品行为与边界以 [设计文档](../specs/2026-11-22-short-drama-production-design.md) 为准；本文把领域契约、IPC、持久化、媒体流水线、界面组合和验证要求细化为可执行实现说明。

## 1. 目标与实现状态

本轮实现已覆盖：项目级媒体隔离、原生导入、抽帧、整数时间线、字幕、视频/音频混音、真实 FFmpeg 渲染、MP4/SRT 不覆盖发布、导出任务中断暂停、剧本导入与可恢复本地拆镜草案、主体版本绑定、项目视频候选显式采纳、稳定镜头规格哈希、制作事务快照撤销、音轨裁切/起点/增益/删除控件、镜头审批与元数据脱敏导出、拆镜 baseline/current/draft 三方差异和歧义阻断、镜头运行与 `shotId/action` 关联。未完成项不被 UI 静默绕过，均保留明确错误或发布阻断状态。

最近补齐的装配闭环：`buildEpisodeAssembly` 按镜头顺序冻结已采用视频、生成 `episode` 与 `assemblyScope=episode` 的时间线；镜头列表提供“冻结镜头并创建时间线”，时间线抽屉自动接管该集时间线。换片先计算新素材可保留的入/出点，短片段必须确认；Rust 事务只更新目标 clip，保留其他片段、字幕锚点和历史导出，并校验新素材属于当前项目且范围不越界。

交付一条可恢复、可审计的本地制作路径：素材/剧本输入 → 结构化制作数据 → 镜头引用与采用 → 时间线编辑 → 预览和导出。付费生成是可选能力，所有输入经后端预览、确认和单次提交；本地剪辑不能依赖 Provider。数据尚未上线，当前开发数据库落后时可清空 SQLite 元数据并建当前 schema；不得删除 CAS 目录中的资产文件，也不得据此推断未来正式版本可无迁移升级。

代码边界目前分为三层：

- `src/domain/**`：可测的时间线、SRT、拆镜差异、引用解析及采纳预览纯逻辑，不访问 React、IPC、文件或网络。
- `src/services/tauri.ts` 和 React 视图：序列化 IPC、呈现加载/冲突/错误状态；不持有 CAS 绝对路径，不调用 FFmpeg 或 Provider。
- `src-tauri/src/**`：项目授权、SQLite 事务、素材解码、运行授权和媒体任务权威实现。UI 的预览结果不能替代后端校验。

底座与 P1 业务代码已接线，并通过纯逻辑、数据库事务和显式本地 FFmpeg 渲染测试。镜头动作定位现有 Image/Video/Audio 原语节点，复用 `prepare_paid_run → RunConfirmDialog → start_paid_run`；后端在预览与提交前验证镜头项目和画板，运行结果归集为候选而不自动采用。`RunPreview` 已写入 SQLite `run_previews`，`start_paid_run` 以立即事务校验指纹/过期时间并一次性标记消费，重启后仍可恢复；仍不包含 `requestId` 幂等、submit intent、未知提交恢复或凭据身份锁定。`makeLocalBreakdownDraft` 仍是本地按非空行生成器，不是模型拆镜。纯逻辑 fixture、真实媒体集成测试、桌面 GUI 与发行证据必须分开记录，不能合并宣称端到端通过。

## 2. 关键实现决定

1. SQLite 保持单库/WAL。`user_version` 小于当前版时，在单一立即事务中移除数据库表并执行全部当前建表 SQL；版本较高时拒绝打开。仅清数据库，不清素材存储目录。发布后另订升级策略。
2. CAS 只负责按内容哈希去重。项目访问始终通过 `(project_id, asset_id)` 成员关系；每次导入/生成/派生分别追加来源记录。窗口媒体 URL 是十分钟短效能力，不把 URL 写入 Board 或生产实体。
3. 所有跨实体写入接受稳定 `changeId`、对象 `expectedRevisions` 和受限操作联合。服务端先校验所有实体/项目/资产引用，全部通过后才在一个 SQLite 事务内写入实体、关系、before/after 快照和命令日志；同 ID 同 payload 返回原响应，不同 payload 返回冲突。撤销通过目标事务快照反向写入新修订，并确认当前对象仍等于目标事务 after 快照，否则拒绝；不撤销远程运行、不删除媒体资产。
4. 编辑采用整数 tick：240,000 tick/s、8,000 tick/frame。显示时间可用毫秒，但 DB 和导出计划以帧对齐整数为准。片段区间左闭右开；排序决定连续主轨位置，不持久化可由顺序推导的位置。
5. 生产状态、运行状态、素材选用和审批分开持久化。新候选不会覆盖 ShotAdoption；审批固定到 `specHash + adoptionId` 或 `editHash`。用新版本替换时间线片段是另一个需确认的制作变更。
6. 渲染输出先写唯一临时目录。FFmpeg 参数以 `Command` 参数数组传入，不经过 shell；源文件从已授权项目资产解析。渲染完成须经 FFprobe 检查后才允许无覆盖发布。MP4 与 SRT 分别发布、分别记录状态，不声称双文件原子提交。

## 3. 数据契约

### 项目实体

`project_entities` 是 Script、Episode、Scene、Shot、Subject、Timeline 的当前投影；`id` 为稳定 ID，`revision` 每次有效写入递增，`payload` 是经领域 DTO 白名单验证的 JSON。归档不物理删除，以便历史采纳、导出和时间线继续读取引用。

不可变/追加表承担历史：`subject_versions(subject_id, ordinal)`、`shot_adoptions`、`production_reviews`、`script_revisions`、`breakdown_drafts`、`production_changes`、`media_exports`。关系字段保存源修订、资产 ID、规格 hash、编辑 hash、创建时间和操作者决定；不要保存本机绝对路径、授权令牌、Provider 密钥或签名 URL 到可分享 DTO。

### Timeline

Timeline payload 至少含 `assemblyScope`、按顺序排列的 `clips`、独立 `audioTracks`、`subtitleCues` 与 revision。clip 保存 `clipId/assetId/enabled/sourceInTicks/sourceOutTicks`；轨道输入只引用同项目音频资产，gain 使用线性数值并做有限值/范围检查。字幕保存 cue ID、文本、区间及可选锚点 clip ID。更新排序、裁切、换片或字幕都是 revision 条件写入；若换片后 cue 锚点无效，返回可读冲突而非静默漂移。

### Export snapshot

预检读取持久化 timeline 和素材探测元数据，生成不可变快照：`exportId/requestId/projectId/timelineId/timelineRevision/editHash/toolchainFingerprint/preset/assetHashes/acknowledgedIssueIds`。渲染阶段不得再次读取“当前 timeline”补参数。状态至少 `queued → rendering → validating → publishing → succeeded`，错误和取消为终态；重启扫描非终态快照，只能在临时输出和输入 hash 均可验证时继续，否则暂停为需用户处理状态。

## 4. IPC 与服务 API

命令参数使用 camelCase JSON DTO；Tauri 命令将错误码与简短用户文案分开，日志移除本机路径和 query 中令牌。UI 调用封装到 `src/services/tauri.ts`：

| 命令 | 用途与约束 |
|---|---|
| `list_project_assets(projectId, kind?, query?, cursor?)` | 只列项目成员；100 条游标分页，UI 不截断总量 |
| `open_project_media(projectId, assetId, rendition)` | 成员校验后发放窗口绑定短期 URL；媒体协议只支持 GET/HEAD 与单段 Range |
| `import_media(projectId, fileGrantIds, requestId)` | 原生文件授权、逐项验证、暂存、哈希、探测、CAS 发布和来源入库；同 requestId 幂等 |
| `list_production_entities(projectId, kind?, cursor?)` | 只返回未归档实体 envelope 与 revision |
| `apply_production_change(projectId, changeId, expectedRevisions, operations)` | 白名单 union，事务更新并返回 revision map；引用、权限、幂等均以后端为准 |
| `prepare_paid_run(projectId, boardId, expectedRevision, draft)` | 计算服务路由、真实输入 hash、缓存和估算，不产生供应商请求 |
| `start_paid_run(previewId, requestId)` | 一次性确认预览；禁止前端自行提供缓存/费用依据；不确定提交不自动重提 |
| `prepare_media_export(projectId, timelineId, expectedRevision, preset)` | 读 DB、预检项目素材、冻结快照，不写输出目标 |
| `start_media_export(previewId, acknowledgedIssueIds, targetGrants, requestId)` | 验预览未过期、告警确认与输出授权，创建后台任务并返回 export ID |
| `list_media_tasks(projectId)` / `cancel_media_task(projectId, taskId)` | 任务轮询和取消；取消只杀关联子进程和清理自身暂存，不碰已发布输出 |

文件输入/输出路径不从任意字符串接受。原生 picker 仅保存内存中的短期 `FileGrant`，用途分别是媒体导入、剧本、字幕、导出目标；项目 ID、用途、窗口/调用边界及过期时间都须匹配。输出目标必须显式解析扩展名、父目录和既存文件状态；重试同 requestId 不能换目标。

## 5. 后端服务实现

### 5.1 制作事务

将当前 `Vec<Value>` 入口收紧为 serde tagged enum 操作：`upsertEntity`、`applyBreakdown`、`createSubjectVersion`、`setShotBindings`、`adoptShotMedia`、`recordProductionReview`、`assembleEpisode`、`replaceTimelineClip`、`commitTimelineEdit` 和 `revertProductionChange`。拒绝未知字段、未知 kind、跨项目父子关系、错误版本、无成员关系的素材及重复主执行节点。生产更改先确认画板保存队列 drain 完成，再调用事务；旧保存用 revision 冲突拒绝。

错误分类包括 `PRODUCTION_REVISION_CONFLICT`（刷新并重看差异）、`PRODUCTION_REFERENCE_INVALID`（保留草案）、`PRODUCTION_ASSET_NOT_IN_PROJECT`、`PRODUCTION_CHANGE_CONFLICT` 和 `PRODUCTION_VALIDATION_FAILED`。不将数据库 SQL 错误直接显示给最终用户。

### 5.2 生产文件导入

脚本导入只读授权句柄。txt/md 限 200 KiB 且 UTF-8 严格解码；DOCX 通过 ZIP 条目白名单读取 `word/document.xml`，限制压缩/解压总量和 XML 深度，不加载宏、图片、外链或关系目标。文本正规化后保存 `script_revisions`。剧本文本不会因导入自动发送模型；拆镜前独立显示服务商、选区、输入字符数和估价，并走统一 `prepare_paid_run/start_paid_run`。

模型结果先落草案表，按 schema、临时 ID 唯一性、行号范围、数量上限、场镜主体引用做严格校验。校验失败不创建正式实体。应用草案前检查源 script revision、实体 revision 和 board revision；`applyBreakdown` 把 scene/shot/subject placeholders 与可定位画布节点同事务写入。重新拆镜以来源 anchor 三方比较；不唯一匹配需要人工映射。

### 5.3 派生与渲染

抽帧：先按成员关系取得源文件，FFprobe 获取 stream/time base/rotation/frame timestamp；尾帧选取小于 duration 的最后一个实际可解码时间戳，FFmpeg 显式应用 autorotate 或等价 transpose 规则。源 hash、selector、方向变换、实现版本形成派生 cache key。取消要杀子进程并清理该任务 staging；发布结果时同事务写 CAS 索引、项目成员、origin 和媒体任务终态。

渲染：

1. 预检编译 Timeline；素材缺失、无效 range、无视频主轨、无效 cue 或未确认阻断问题时不创建输出任务。
2. 创建任务专属 staging；为每个视频输入加入 trim/setpts、旋转、按目标尺寸等比缩放+补边、30fps、SAR 与像素格式归一化。视频 concat 仅接受单主轨；逐段音频缺失时使用匹配时长的 48 kHz 双声道静音填充，源声与显式旁白/音乐轨按 clip 映射混音、限幅。
3. 字幕烧录使用严格生成的 UTF-8 SRT 和已验证字体目录；参数中的路径按 FFmpeg filter escaping 规则编码，不通过 shell。SRT 旁挂文件与烧录使用同一冻结 cue 快照。
4. 输出 H.264/AAC、MP4、yuv420p、指定尺寸与 30fps；FFprobe 检查视频/音频流、分辨率、帧率、声道、时长和文件可读性。实际帧数以探测结果复核时间线预期。
5. 目标不存在才用同目录原子 rename 发布；目标已存在返回冲突，不覆盖、不自动加后缀。MP4 和 SRT 各自保存发布阶段/文件 hash，退出后重启靠 exportId、快照和 staging manifest 对账，不能以同名文件推断成功。

长任务使用后台任务表和进程句柄管理器。任务事件只广播 `exportId/status/progress/issueCode`；进度不覆盖用户更晚的 timeline 编辑。App 启动恢复只扫描归属项目任务，取消或失败清理临时文件并留脱敏诊断信息。

## 6. 前端视图和交互

- `ProductionWorkspace` 放在现有左侧项目 rail 的“制作”视图中，列表以集/场/镜层级展示，按实体 ID 选择；点击镜头定位 Canvas 和 Inspector，不复制领域实体。
- `ScriptPanel` 编辑剧本修订、导入 txt/md/docx、按选择区编译；模型调用前经过已有付费确认弹窗。`BreakdownReview` 显示新增/变更/不变/歧义，逐条勾选应用，手工字段优先保留。
- `SubjectLibrary` 管理角色、地点和道具；`SubjectBindingEditor` 绑定具体版本，更新“当前版本”不自动改动镜头。
- `ShotCard` 显示镜头规格、产物槽、引用来源、采纳版本和审批状态。候选默认只预览；采用、审批、重拍与换片分别是明确动作。重拍完成不会自动采用。
- `TimelineDrawer` 支持排序、启停、入出点、拆分、源资产替换、播放头、音轨源裁切/时间线起点/增益/删除、SRT 导入/编辑。所有拖拽有键盘按钮等价；文本框不触发画布快捷键。音视频播放源为项目媒体短期 URL。
- `ExportDialog` 显示输出尺寸、预计时长、预检错误/告警及确认项。阻断项不可被忽略；确认后显示后台阶段、进度、取消、输出位置和脱敏失败信息。进度回流按 exportId 合并，不能替换更高 timeline revision。
- 移动/隐藏面板时输入状态保留；加载、空态、错误、权限过期、冲突、任务恢复均是显式状态。按钮必须有可理解文字或带 tooltip 的图标，不能只用颜色表示状态。

## 7. 观测、错误与隐私

结构化本地日志只包含任务 ID、阶段、错误码、耗时、工具 build fingerprint 和输入哈希前缀。禁止记录提示词全文、SRT 正文、绝对路径、媒体 grant URL/token、密钥、带签名 URL 和模型请求完整正文。供应商原始错误先过现有脱敏，再放入 RunRecord。导出的项目元数据 DTO 使用 allowlist，asset body 始终不包含；绝对路径、远端 task ID 和内部授权表不能进包。

所有文件写入采取 `create_new`/不覆盖策略；用户取消与失败不能删除已发布素材。临时目录用 app-owned 随机前缀并写 manifest；启动清理仅删除能够证明属于本应用未完成任务且超过保留期的 staging。DB schema 重建绝不触碰 staging/CAS，孤儿清理单独运行并有 hash/关系保护。

## 8. 自动化测试与手工验收

每个新增命令按顺序覆盖纯 DTO 校验、SQLite 事务/回滚、项目隔离、IPC 参数映射、UI 状态竞争；新行为先写失败用例，再实现。媒体逻辑测试默认无外部依赖。显式媒体集成测试读取 `FRAMEFORGE_TEST_FFMPEG`、`FRAMEFORGE_TEST_FFPROBE`、`FRAMEFORGE_TEST_FONT_DIR`，使用真实小型 VFR、旋转、无声、CJK 夹具；环境变量缺失时普通套件不运行 ignored 案例，显式选择时缺依赖必须失败。

发布前逐项记录 A01–A08 的输入、系统/架构、FFmpeg 构建与许可、测试命令和输出 hash。手测至少包含：断网本地三段视频、300 帧时长、无音轨片段前后旁白对齐、SRT 中文往返/烧录、输出冲突、第二镜重拍不覆盖旧结果、项目切换后旧媒体 grant 失效、任务取消和退出恢复、键盘等价操作。付费模型冒烟必须独立获得明确授权，本实现任务不得为了通过验收自动调用付费接口。

`pnpm test`、`pnpm build` 和 `cargo check --offline` 是基本门禁，但不能替代桌面 IPC、真实媒体渲染或干净设备安装。未运行的清洁机、许可和付费冒烟必须继续标作发布阻断，不允许以纯逻辑测试冒充完成。

## 9. 未完成实现与发布阻断

以下不是“实现细节待优化”，而是仍未达成的产品验收。它们应继续作为明确阻断项，不可用预览按钮、模拟测试或本机工具结果标成已完成。

| 阻断项 | 当前真实状态 | 完成定义 | 依赖/原因 |
|---|---|---|---|
| 镜头远程生成提交与恢复 | 已接通现有原语节点、统一付费确认与后端 Shot 项目/画板归属校验；RunRecord 保存 `entityId/action`，候选列表标注本镜头运行结果且不自动采用 | 预览/提交意图和凭据身份需落盘；真实服务商提交/恢复、失败/取消/`submission_unknown` 桌面体验；episode frozen set 与换片确认 | 真实供应商冒烟须另获用户授权与预算；本轮未调用外部模型 |
| 模型拆镜草案与恢复 | 当前 `makeLocalBreakdownDraft` 按非空行生成并持久化可审阅草案，不发模型请求；没有模型结果解析和远程恢复 | 保存明确 script revision/选区；调用前展示供应商、费用和发送范围并复用通用付费确认；结果严格校验后持久化 draft；重复响应幂等，提交不确定时不自动重发；断网/错误不写入实体 | 真实调用属付费外部副作用；当前无用户为本次冒烟授权的模型和预算 |
| 拆镜三方差异与应用 | 已实现 baseline/current/draft 匹配、added/changed/preserved/unchanged/conflict/ambiguous 展示、冲突选择、歧义阻止自动应用；草案按 script revision 持久化，单事务应用 | 接入模型草案来源、集/场创建与编辑、歧义人工映射 UI | 本地草案流程已可用；模型付费调用/恢复未实现且需要另行授权 |
| 镜头结果→集装配→重拍 | 候选按 Run 的 `entityId` 归集提示；本地/项目视频可显式采用，审批哈希在 Rust 权威侧复核；已增加按镜头顺序冻结 episode 和 episode 时间线、换片预览/确认、字幕锚点保留；导航树支持集→场→镜过滤与未归组镜头展示 | 候选预览细节、历史导出字节保持、桌面验收 | 导航写操作已接入事务；完整画布定位与 GUI 验收仍缺 |
| 多音轨真实渲染验收 | 编辑控件含源入/出点、时间线起点、增益及删除；渲染器按延迟与增益混音；显式 FFmpeg 两轨 WAV 哨兵测试已覆盖裁切、偏移、增益、混音和输出时长 | 目标桌面 GUI 的多音轨操作、发行工具链和完整 A02 证据 | 不依赖 Provider，但仍需桌面/发行环境 |
| 桌面端 A01–A08 | CI/本地测试通过不代表 Tauri 窗口、键盘操作、项目切换、媒体 Range 刷新及任务恢复通过 | 在目标 macOS 版本完成真实桌面完整流程；记录各项输入、输出哈希、截图/日志、失败和环境 | 需要桌面交互验收与独立可复现环境 |
| 发行媒体工具与字体 | 开发机 FFmpeg 能力已实测；现有 Homebrew/实验二进制不可用于发行，字体也未清许可 | 固定可再分发的 arm64 构建；收集 FFmpeg/依赖/字体许可证与哈希；离线安装无系统 FFmpeg 仍完成 MP4、中文烧录和 SRT；检查签名、动态依赖与最低系统版本 | 许可评估、可复现构建与干净设备尚无证据，不能在代码中以配置假装完成 |
| 付费供应商真实冒烟 | 未运行，且本轮没有用户授权；本地预览已具备 SQLite 持久化和一次性消费 | 单独确认供应商、输入内容、费用上限和允许的动作后，记录预览、提交、恢复、候选与采用；不得记录密钥 | 外部费用和数据发送需要明确的独立授权 |

| 集/场/镜导航与实体编辑 | 已新增以稳定实体 ID 建树的导航视图；支持集/场新建、重命名、同级排序、镜头移场和未归属镜头展示；Rust 校验项目/层级引用 | 剧本应用仍需原子创建 episode/scene/shot；UI 还缺完整选中镜头定位画布和桌面键盘验收 | 集/场/镜写操作已落盘；不把缺失的画布定位或 GUI 验收标为完成 |

### 9.1 剩余工作包与完成门槛

| 顺序 | 工作包 | 具体交付 | 可自动验收 | 外部/人工门槛 |
|---|---|---|---|---|
| P1 | 完整集场实体编辑 | 拆镜应用原子创建 Episode/Scene/Shot；树上新建、改名、排序、镜头跨场移动；按 entity ID 定位画布 | Rust 事务回滚/项目隔离/revision 冲突；树归组、顺序和悬空父引用 Vitest | Tauri GUI 键盘可达性和跨板定位实测 |
| P1 | 付费提交与恢复协议 | 已持久化 preview 并支持重启后一次性消费；仍需 confirmation/requestId/route identity、submit intent、未知态恢复和凭据身份锁定 | wiremock 断言 exact request count、回放冲突、过期预览、凭据更换、启动恢复；不读取真实密钥 | 真实供应商烟测需用户指定供应商、输入数据和预算上限 |
| P1 | 模型拆镜 | 保存 script revision/选区；费用/供应商/数据发送范围确认；严格 parse/schema/来源校验；幂等持久化 draft；人工差异应用 | 假 Provider 夹具覆盖错误 JSON、超时、重复提交、修订变化、无半提交 | 真模型质量与费用烟测需单独授权 |
| P1 | 真正的 P1 业务集成 | `p1_mock_script_to_three_shot_publish_and_retake` 经过项目服务边界、mock Provider、真实 FFmpeg 渲染；证明 300 帧和第二镜重拍后旧输出 hash 未变 | 离线 CI 可运行的 mock Provider/媒体 fixture；保存输出 hash 与 Run/Adoption/Timestamp 证据 | 与 GUI 手测分开；不得用现有逻辑 fixture 替代 |
| P1 | 桌面 A01–A08 | 本地三段素材流程、出错/取消/恢复、键盘操作、项目切换、输出冲突、审批/重拍 | 自动化能补的 IPC 契约和回归测试 | 目标 macOS 真窗口手测、截图/日志/环境与输出 hash |
| P1 Release | 媒体发行物 | 固定 FFmpeg/FFprobe、CJK 字体及依赖；签名、最小系统版本与许可材料 | 可重现 arm64 build、依赖扫描、许可证清单 | 法律许可审核及干净 macOS 离线安装 |

实施顺序：先完成集场实体写操作和落盘付费协议；再接模型拆镜和 mock Provider 业务流；之后做 A01–A08；最终收口媒体许可、签名与干净机。真实供应商调用不是自动化门禁，也不得为了让测试通过而发送剧本或媒体。

