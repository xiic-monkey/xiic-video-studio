# P1 发布证据

状态：本地核心实现已接线；P1 端到端验收与正式发行均未通过。阻断包括可再分发媒体工具、字体许可和干净 macOS、模型拆镜调用、付费提交完整恢复协议、真实业务集成测试及桌面 GUI 验收。集/场/镜导航写操作和 SQLite 预览一次性消费已完成自动化验证。

## 已验证

- Rust/TypeScript 单元范围：项目资产隔离、单 Range 授权、媒体源输出、整数时间线、SRT 中文往返、生产变更幂等原语、脚本草案校验、主体参考解析、镜头采纳与短片段换片提示。该项不代表完整 P1 业务流程已验收。
- 本地素材入口：原生文件选择、项目/用途绑定授权、流式哈希暂存、格式和配额校验、CAS 原子发布、任务查询/取消。
- 媒体能力：Task 01 清单记录 H.264/AAC、1080×1920、UTF-8 SRT 与中文字幕烧录的开发机结果；该工具链未获发行许可，不作为线上成功证据。
- 本轮复验（2026-11-23）：`pnpm test` 为 39 个测试文件、250 个 TypeScript 用例通过；同命令中的 Rust 为 196 个通过、4 个 ignored；`pnpm build` 通过（Vite 提示主 JS chunk 超过 500 kB，不阻断构建）；`git diff --check` 通过。Rust 仍有既存未使用代码/变量警告。
- 显式本机媒体复验：`FRAMEFORGE_FFMPEG=/opt/homebrew/bin/ffmpeg FRAMEFORGE_FFPROBE=/opt/homebrew/bin/ffprobe cargo test --manifest-path src-tauri/Cargo.toml media::render::tests -- --include-ignored` 为 6/6 通过，含真实 300 帧与真实双音轨 WAV 裁切、时间线偏移、增益、混音和时长断言；`FRAMEFORGE_TEST_FFMPEG=/opt/homebrew/bin/ffmpeg FRAMEFORGE_TEST_FFPROBE=/opt/homebrew/bin/ffprobe FRAMEFORGE_TEST_H264_ENCODER=h264_videotoolbox cargo test --manifest-path src-tauri/Cargo.toml media::toolchain::tests -- --include-ignored` 为 3/3 通过，探测到本机 H.264/AAC 并确认无字幕烧录能力；`cargo test --manifest-path src-tauri/Cargo.toml production::flow_tests -- --include-ignored` 为 1/1 通过，但该测试仅验证时间线 fixture 正好 300 帧及采纳规格兼容性，不调用媒体渲染、脚本服务、Provider 或重拍流程。
- 制作事务：已验证拆镜草案按 script revision 一次应用、脚本修订快照、实体类型/项目隔离、主体版本绑定、制作变更反向快照撤销会检查后续冲突、短片段替换必须显式确认和导出中断后暂停。
- 时间线：已验证 30 fps 整数 tick、视频主轨、SRT 中文、多音频轨项目成员/增益/延迟校验、无源音频自动静音填充与输出帧数核验。

## 发布阻断

- 尚无不依赖 Homebrew 或本机应用路径的可再分发 FFmpeg/FFprobe 与 CJK 字体构建。
- 尚无目标最低 macOS 版本的干净设备安装、断网启动、300 帧导出和签名验证记录。
- 尚无桌面 GUI 的 Compose 完整流程验收；多音轨编辑控件已接入，渲染器混音逻辑和显式 FFmpeg 两轨 WAV 集成测试已通过，但桌面操作及发行工具链仍未验收。
- 生产 UI 已支持项目视频候选的显式采用、采纳记录与稳定规格哈希审批；镜头动作已接入统一付费确认并按 Shot 归集运行候选；已增加 episode 冻结、集时间线创建、短片段换片确认和字幕锚点保留。集→场→镜导航树已接入集/场新建、重命名、同级排序与镜头移场；完整画布定位和 GUI 证据仍缺。
- 付费预览已持久化到 SQLite，支持重启后校验指纹、过期时间并一次性消费；仍不能覆盖 requestId 幂等、submit intent、未知提交恢复、供应商/凭据版本锁定。`prepare_shot_run` 当前也不是模型拆镜 API，UI 没有模型拆镜入口。
- Task 15 的 `production::flow_tests` 不是端到端集成测试：没有脚本导入/拆镜、统一付费提交、实际媒体渲染或重拍旧文件哈希校验。不能把其通过登记为 A01/A03。
- `revert_production_change` 已按事务 before/after 快照执行反向恢复并拒绝后续冲突；历史库中没有快照的旧开发记录不能回溯撤销。`applyBreakdown` 当前仍为按行本地草案应用，模型草案的付费/恢复链路需独立验收。

## 复现命令

```sh
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml production::flow_tests -- --include-ignored
FRAMEFORGE_FFMPEG=/opt/homebrew/bin/ffmpeg FRAMEFORGE_FFPROBE=/opt/homebrew/bin/ffprobe \
  cargo test --manifest-path src-tauri/Cargo.toml media::render::tests -- --include-ignored
FRAMEFORGE_TEST_FFMPEG=/opt/homebrew/bin/ffmpeg FRAMEFORGE_TEST_FFPROBE=/opt/homebrew/bin/ffprobe \
FRAMEFORGE_TEST_H264_ENCODER=h264_videotoolbox \
  cargo test --manifest-path src-tauri/Cargo.toml media::toolchain::tests -- --include-ignored
```

每次发布候选需补充：基线提交、架构/系统版本、工具和字体 SHA-256、许可证、A01–A08 输入输出、真实命令日志、失败 stderr 脱敏结果。
