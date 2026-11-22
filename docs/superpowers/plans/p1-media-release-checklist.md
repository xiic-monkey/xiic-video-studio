# P1 媒体工具验证与发行清单

验证日期：2026-11-22。源码基线 `e1f56d9`。本页记录 [Task 01](2026-11-22-p1-short-drama-production.md#task-01确定媒体工具契约与发行试构建) 的开发机证据，并给 Task 15 留下独立的发布门槛。

## 结论

- **通过开发验证**：使用真实 FFmpeg/FFprobe 生成、探测并解码 H.264/AAC MP4，识别 UTF-8 SRT，使用另一套本机配置完成 1080×1920 中文字幕烧录。未安装或不支持烧录时，能力探测不宣称支持烧录；可用的内部旁挂路线不受影响。
- **暂不发行媒体组件**：已验证的两套工具都不能作为发行候选。尚无完成许可审查的可复现构建，也没有断网干净机证据。没有将开发机的二进制或字体加入项目、改动 Tauri 打包配置或启用 UI 导入/导出入口。

## Rust 工具契约

- `MediaToolchain::probe` 只接受后端明确配置的绝对 `ffmpeg`、`ffprobe` 路径、受控 H.264 编码器及可选字体；无 `PATH` 回退，不注册 IPC，不在应用启动时同步探测。生产调用方应在媒体后台任务中调用，用经过审核的安装资源或明确内部配置，不从渲染器接受路径或参数。
- 在独立临时目录中执行固定参数的本地子进程，单调用最长等待 5 秒；退出后清理夹具。以真实编码、封装、元数据和解码验证普通导出能力；工具路径、版本、编码链路失败时返回明确的阶段错误，不回显本机路径或原始日志。
- `subtitle_burn_in` 通过固定中文 SRT 与指定字体做有、无字幕的解码帧比较。`require_release_capabilities` 是技术门禁，不代表发行许可、字体字形目检或最低系统版本审核。`build_fingerprint` 基于两套工具的版本/构建输出和编码器，不等同于发行二进制校验和，也不用于证明字体相同。

## 开发机证据

| 项目 | 普通 MP4 + UTF-8 SRT | 中文字幕烧录 |
|---|---|---|
| 实机 | Apple Silicon `arm64`，`sw_vers` 报告 macOS `27.2.1` / `26B131` | 同机 |
| FFmpeg | Homebrew `8.1.2_1`，Mach-O `arm64`；`LC_BUILD_VERSION minos 26.0` | 现有本地应用内的实验用 `6.0`，Mach-O `arm64`；`minos 12.0` 仅是该文件声明 |
| FFprobe | Homebrew `8.1.2_1`，Mach-O `arm64`；`minos 26.0` | 同左，本次允许开发环境混用版本；发行要求同批构建 |
| 构建配置 | 共享库，`--enable-gpl --enable-version3 --enable-libx264`，未启用 libass；`otool -L` 包含 Homebrew 动态库绝对依赖，`ffmpeg -L` 报告 GPLv3 或更高 | 含 `--enable-libass --enable-libfreetype --enable-fontconfig --enable-gpl --enable-nonfree`，`ffmpeg -L` 明示不可再分发；仅作本机对照 |
| 编码器与字体 | `h264_videotoolbox` + 软件 `aac`，无 CJK 字体入包；另用 `libx264` 做过本机 12 帧对照 | `h264_videotoolbox` + 软件 `aac`；系统 `STHeiti Light.ttc` / `Heiti SC`，CoreText 实际选中 `STHeitiSC-Light`；未授权复制发行 |
| 探测结果 | `probe/decode/h264/aac = true`，`subtitle_burn_in = false` | 五项均为 `true`；这是能力通过，不是正式发布通过 |
| 探测指纹 | `57f41f9816f23e062b1f6b2a760ac66bb5a27b496fd80ef6a51dfff879618a7f` | `c3ce52330cfedc3533f7779cacacc08edf63e2942e5d66d2db19a6cf` |

烧录样片经 FFprobe 实际解码计数：视频 `h264 / 1080×1920 / yuv420p / 30/1 / 12 帧`，音频 `aac / 48 kHz / 双声道`；另识别旁挂 `subrip`。在第 0.2 秒抽帧目检，「中文测试：镜头与字幕」可读、未见缺字方框。样片为 0.4 秒开发夹具，不代替 Task 15 的 300 帧成片验收、安全区、多行、取消或完整离线测试。

## 复现开发验证

普通套件不依赖 FFmpeg，显式媒体测试会实际运行工具、且缺少已声明的依赖时失败。以下变量只用于测试进程，不是应用设置或用户安装说明：

```sh
cargo test --manifest-path src-tauri/Cargo.toml media::toolchain::tests

env -u FRAMEFORGE_TEST_FONT_DIR \
  FRAMEFORGE_TEST_FFMPEG=/opt/homebrew/bin/ffmpeg \
  FRAMEFORGE_TEST_FFPROBE=/opt/homebrew/bin/ffprobe \
  FRAMEFORGE_TEST_H264_ENCODER=h264_videotoolbox \
  cargo test --manifest-path src-tauri/Cargo.toml \
  media::toolchain::tests -- --include-ignored --nocapture

FRAMEFORGE_TEST_FFMPEG=/absolute/path/to/ffmpeg-with-libass \
FRAMEFORGE_TEST_FFPROBE=/absolute/path/to/ffprobe \
FRAMEFORGE_TEST_FONT_DIR=/absolute/path/to/fonts \
FRAMEFORGE_TEST_FONT_FILE=NotoSansCJKsc-Regular.otf \
FRAMEFORGE_TEST_FONT_FAMILY='Noto Sans CJK SC' \
FRAMEFORGE_TEST_H264_ENCODER=h264_videotoolbox \
  cargo test --manifest-path src-tauri/Cargo.toml \
  media::toolchain::tests -- --include-ignored --nocapture
```

最后一条是候选构建的验法；本次实际烧录环境使用上表的 FFmpeg 6.0 和 `STHeiti Light.ttc`，未验证候选 Noto 字体。可用 `file -L`、`otool -L`、`otool -l`、`ffmpeg -version`、`ffmpeg -L` 留存架构、链接和构建声明；最终以 `ffprobe -count_frames`、字幕输出抽帧和完整解码判断能力，不以 `-encoders`/`-filters` 列表作为通过证据。

## Task 15 发行门槛

- [ ] **锁构建**：建议先试可再分发的原生 `arm64` FFmpeg 构建，不启用 `--enable-nonfree` 或 GPL 可选依赖，评估 VideoToolbox H.264、软件 AAC、libass 及其字体和整形依赖。固定源码版本、补丁、构建参数和工具链；记录 FFmpeg/FFprobe、依赖和字体的 SHA-256、许可证和再分发材料。技术建议不代替法律审查；需另确认 H.264/AAC 许可适用性。
- [ ] **锁字体**：候选 [Noto Sans CJK SC](https://github.com/notofonts/noto-cjk)（核验所选字体文件和上游许可版本），随审核通过的字体和许可证交付。禁止复制本机系统字体作为发行资源。验证简体、多行、标点及安全区，并核对真实加载的字形。
- [ ] **锁系统范围**：先以 Apple Silicon 为唯一候选架构；建议把 macOS 14 作为最低版本测试起点，而非支持承诺。构建后检查所有 Mach-O 和动态库声明，再在所提最低版本与一个较新版本的干净机验证，按实测上调或冻结。当前实验二进制的 `minos` 和开发机系统版本不能证明线上最低版本。
- [ ] **锁打包与实测**：确认依赖不引用 Homebrew 等开发机路径；验证签名、内部资源解析、离线启动及无本机 FFmpeg 时的素材操作。跑设计 A01–A08，尤其 1080×1920 中文烧录、旁挂、300 帧、无音轨、旋转/VFR。没有许可证与实机记录前，发行状态保持阻断。

许可资料入口：[FFmpeg 法律与许可](https://ffmpeg.org/legal.html)、[libass 上游](https://github.com/libass/libass)、[Noto CJK 上游](https://github.com/notofonts/noto-cjk)。
