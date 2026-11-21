# Frameforge Canvas Studio 设计文档

- 日期：2026-10-31
- 状态：设计待评审
- 目标读者：产品负责人、前端/ Rust 工程实现者、后续 Agent/协作/3D 子系统实现者
- 现有工程：`xiic-video-studio`（Tauri 2 + React 18 + Rust，产品名 Frameforge）
- 参考产品：LibTV（哩布TV）
- 开源参考：Toonflow（MIT）、infinite-canvas（MIT）、ComfyUI、tldraw/Yjs

---

## 1. 背景与目标

Frameforge 现有形态是「故事 → 角色 → 分镜 → 素材 → 合成 → 画布」的分阶段工作台，最后一步画布是只读关系图。目标是把整套生产线改成 **画布优先**：剧本、角色、场景、分镜、首尾帧、视频、音频、剪辑都在同一张无限画布上以节点和连线组织，节点图可直接执行，最终产出短剧成片。

本设计覆盖 LibTV 的全量能力方向：

- 无限画布 + 节点式工作流
- 文本、图片、视频、音频、脚本五类基础节点
- 短剧领域节点：角色三视图/造型、场景、分镜镜头、首尾帧、成片剪辑
- 多模型聚合：文本、生图、视频、TTS、音乐/音效、视觉分析
- 角色一致性、镜头连续性、片段重拍、智能引用
- 3D 导演台、手绘运镜、打光、预演
- 拉片/帧分析、动作捕捉、局部重绘/扩图、多机位
- 人类创作者与 Agent 共用同一套底层能力
- 团队协作、审片、共享资产
- 插件节点、MCP/Skill、多平台成片交付

**全量目标不缩减。** 本文按子系统给出完整架构，再按交付顺序排 P0–P6。分阶段是交付顺序，不是砍功能。

### 1.1 成功标准

一条 9:16 竖屏短剧主链可以在画布上完整跑通：

```text
剧本 → 角色三视图 → 场景/地点 → 分镜镜头 → 首帧/尾帧 → 视频片段 → 合成 → MP4
```

并且满足：

- 同一角色跨 3 个镜头保持可审阅的一致性
- 未改动的节点重跑命中缓存，不重复扣费
- 改上游只把下游标记为过期，不自动生成
- 关掉应用再打开，未完成的视频任务能继续
- 每个产物可追溯到节点、提示词、模型、参数、运行记录
- 项目导出不包含任何 API Key

---

## 2. 产品范围与对标

### 2.1 目标用户

- 一人剧组：自己写剧本、定角色、出分镜、出视频、剪成片
- 3–10 人短剧小团队：共享角色库、分镜、素材，分工审片
- 后续：用 Agent/MCP 做批量生产或参考视频复刻的自动化用户

### 2.2 对标功能矩阵

| LibTV 能力 | Frameforge 子系统 | 阶段 |
|---|---|---|
| 无限画布、节点连线、自动保存 | Canvas + Board 文档 | P0 |
| 文本/图片/视频/音频/脚本节点 | 原语节点 | P0 |
| 30+ 模型聚合、模型设置 | Capability Gateway + Provider 适配器 | P0/P2 |
| TV Director 剧本拆集/拆场/拆镜 | Script 节点 + LLM 编译器 | P1 |
| 角色造型室、三视图、360、定妆 | Character 实体 + 造型子图 | P1/P2 |
| 场景/主体库 | Location/Prop 实体 + 资产库 | P1/P2 |
| 分镜图、首尾帧、图生视频 | Shot 宏节点 + FramePair 节点 | P1 |
| 画布内剪辑、转场、字幕、音频 | Compose 节点 + 时间线 | P1/P2 |
| 片段重拍、智能引用、候选对比 | Run/候选/引用解析器 | P2 |
| 分镜组、九宫格、4K 提案图 | Storyboard Grid 视图 | P2 |
| 打光、机位、大师运镜、多机位 | Prompt 控制 + Director Stage | P3 |
| 3D 导演台、手绘运镜 | Director3D 节点 | P3 |
| 深度动作捕捉 | 视频 → 姿态 → 人偶 | P3 |
| 拉片、帧分析、参考视频复刻 | FrameAnalysis + Vision/ASR 管线 | P3/P4 |
| Agent/Skill、一句话短剧 | Director Agent + MCP/CLI | P4 |
| 团队协作、在线状态、审片 | CRDT 同步 + Review | P5 |
| 插件市场、ComfyUI、多语言/多平台 | 插件 SDK + 适配器 + 交付预设 | P6 |

### 2.3 开源参考与取舍

| 项目 | 可借鉴 | 不照搬 |
|---|---|---|
| Toonflow | 节点插件包、`director3dNode`/`frameAnalysisNode`、MCP、团队包、画布工作区 | Vue/Electrobun 技术栈、业务代码 |
| infinite-canvas | React 画布、Agent 面板、素材/提示词库、模型设置面板的交互 | 浏览器本地存 Key、无后端的安全模型 |
| ComfyUI | DAG 执行、按内容缓存、显式队列、自定义节点契约 | Python 插件运行时、节点即 UI 的极客交互 |
| tldraw/Yjs | 无限画布交互、CRDT 协作、presence | tldraw 的工作流语义（需自建端口/角色） |
| FFmpeg | 媒体探针、抽帧、缩略图、拼接、字幕、导出 | 在 UI 线程直接跑命令行 |

**结论**：借节点分类、执行模型、协作模型；不直接分叉任何项目，因为现有 Tauri + Rust + 桌面 ffmpeg 能力与它们的栈不匹配。

### 2.4 设计原则

1. **画布就是项目**：画布文档是创作状态的权威载体，不是某个页面的附属视图。
2. **领域节点优先，原语节点兜底**：短剧语义节点负责效率，原语节点负责自由度。
3. **边有语义**：连线不只是「媒体传给媒体」，而是 `casting`、`first_frame`、`style_ref`、`prev_shot` 等制作关系。
4. **显式执行，绝不自动扣费**：用户触发运行；上游变化只标记 stale。
5. **一切产物可追溯**：资产、提示词、模型、参数、运行、成本都能回放。
6. **人类路径与 Agent 路径同一套命令**：UI 和 Agent 都通过命令层改图、运行、导出。
7. **本地优先**：项目、素材、密钥都在本机；云是可选协作层。
8. **提示词可读、可编辑、可锁定**：不把关键提示词藏在黑盒里。
9. **结构优先于功能**：先定稳定的领域模型和接缝，再加功能，避免第二个 206KB 的 `App.tsx`。

---

## 3. 总体架构

### 3.1 分层

```text
┌──────────────────────────────────────────────────────────────┐
│ React UI                                                     │
│  Canvas (React Flow) · Node Renderers · Inspector · Panels   │
│  Timeline · Director3D · Agent Panel · Review                │
└──────────────────────────┬───────────────────────────────────┘
                           │ typed commands / events
┌──────────────────────────▼───────────────────────────────────┐
│ Domain Core (pure TypeScript, no React)                      │
│  Node Registry · Entity Model · Prompt Compilers             │
│  Graph Validation · Scheduler · Cache Keys · Commands        │
│  Templates · Reference Resolver · Cost Estimator             │
└──────────────────────────┬───────────────────────────────────┘
                           │ Tauri invoke / event
┌──────────────────────────▼───────────────────────────────────┐
│ Rust Infrastructure                                          │
│  Provider Gateway · Adapters · Job Queue/Poller              │
│  Keychain · SQLite · Asset Store (CAS) · FFmpeg Pipeline     │
│  Project Packages · Migrations · Logging                     │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTPS / file
┌──────────────────────────▼───────────────────────────────────┐
│ External                                                     │
│  Text/Image/Video/Audio APIs · Optional S3/R2/OSS Asset Host │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 为什么领域层用 TypeScript，基础设施用 Rust

- **领域层（TS）**：节点 schema、提示词编译、引用解析、缓存键、模板、命令、撤销，变化最快。纯 TS、无 React 依赖，后续 Agent、CLI、测试、服务端都能复用。
- **基础设施（Rust）**：模型网关、密钥、任务队列、异步视频轮询、SQLite、资产哈希、ffmpeg、项目包。这些是长期稳定、需要可靠性和系统权限的部分，继续复用现有 Rust 能力。
- **长任务归 Rust 所有**：视频提交/轮询/取消/重试/持久化在 Rust 后台任务中完成，关掉窗口不丢任务；UI 只订阅事件。
- **调度在 TS**：运行某节点时，TS 解析上游、检查缓存、编译执行步骤，再逐项调用 Rust 网关。这样节点语义迭代快，且不把短剧业务塞进 Rust。

不选「Rust 全内核」的原因：节点语义和提示词需要高频迭代，全部放 Rust 会让每个小改动都跨语言；不选「浏览器全本地」的原因：密钥安全、ffmpeg、后台任务、项目存储都需要桌面后端。

### 3.3 命令与事件流

```text
用户点击 Run
  → TS Domain: validate(node) + resolveUpstream + cacheKey
  → 命中缓存: 复用资产，生成 0 成本 Run 记录
  → 未命中: compile(node) → ExecutionStep[]
  → Rust: provider.execute(step)（异步任务则入队、轮询）
  → Rust event: job.updated / run.updated / asset.created
  → TS 更新 Board/Entity 状态，写 Run 记录
  → UI 刷新节点状态、候选、成本
```

所有图变更都通过命令：

```ts
type GraphCommand =
  | { type: 'node.create'; node: BoardNode }
  | { type: 'node.update'; nodeId: string; patch: Partial<BoardNode> }
  | { type: 'node.delete'; nodeId: string }
  | { type: 'edge.create'; edge: BoardEdge }
  | { type: 'edge.update'; edgeId: string; patch: Partial<BoardEdge> }
  | { type: 'edge.delete'; edgeId: string }
  | { type: 'entity.update'; entityId: string; patch: Record<string, unknown> }
  | { type: 'asset.select'; nodeId: string; assetId: string }
  | { type: 'node.pin'; nodeId: string; assetId: string | null };
```

命令层负责：撤销/重做、Agent 审计、协作同步、批量操作。UI 不允许直接改 store 里的节点图。

---

## 4. 核心概念与数据模型

### 4.1 项目级对象

```text
Project
├─ StyleGuide                 全局视觉风格/类型/时代/色彩/镜头语言/约束
├─ Script                    剧本实体（可多份）
├─ Episodes[]                集
├─ Scenes[]                  叙事场次（场）
├─ Characters[]              角色实体
├─ Locations[]               视觉场景/地点实体
├─ Props[]                   道具实体
├─ PromptLibrary[]           提示词库
├─ Boards[]                  画布
├─ Timelines[]               成片时间线
├─ Assets[]                  资产索引（实际文件在 CAS）
├─ Runs[] / Jobs[]           运行与异步任务
└─ Exports[]                 导出记录
```

**Board 与 Entity 分离**：

- **Entity** 是项目级创作数据：角色、场景、镜头、剧本、时间线。可跨画布、跨集复用，是协作同步和 Agent 操作的对象。
- **Board** 是空间化视图：节点、连线、位置、分组、视口。节点通过 `entityId` 引用实体。
- **Node** 是实体或原语在画布上的表现。角色节点、镜头节点编辑的是实体；图片/视频生成节点可以自带数据，不建实体。

这样避免同一角色在多张画布上出现三份不一致的数据。

### 4.2 Board 文档

```ts
interface BoardDoc {
  schemaVersion: number;
  id: string;
  projectId: string;
  name: string;
  nodes: Record<string, BoardNode>;   // map，不用数组，便于 CRDT
  edges: Record<string, BoardEdge>;
  viewport: { x: number; y: number; zoom: number };
  createdAt: string;
  updatedAt: string;
}

interface BoardNode {
  id: string;
  type: string;                 // 'shot' | 'character' | 'image' | ...
  typeVersion: number;
  entityId?: string;            // 领域节点指向项目实体
  position: { x: number; y: number };
  size?: { width: number; height: number };
  parentId?: string;            // 分组/Frame
  z: number;
  collapsed?: boolean;
  data: Record<string, unknown>; // 原语节点配置 / 视图级覆盖
  ui?: { color?: string; pinned?: boolean; note?: string };
}

interface BoardEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  role: EdgeRole;               // 语义角色，见 4.4
  createdAt: string;
}
```

### 4.3 领域实体

```ts
interface StyleGuide {
  genre: string;
  visualStyle: string;
  colorLanguage: string;
  cameraLanguage: string;
  era: string;
  constraints: string;
  negative: string;
  version: number;
}

interface ScriptEntity {
  id: string;
  title: string;
  body: string;                 // Markdown/纯文本
  format: 'idea' | 'synopsis' | 'episode' | 'scene-list';
  beats: Beat[];                // 结构化节拍
  episodeIds: string[];
  status: ApprovalStatus;       // draft | review | approved
}

interface CharacterEntity {
  id: string;
  name: string;
  role: string;
  bio: string;
  personality: string;
  appearance: {
    age: string;
    face: string;
    hair: string;
    body: string;
    wardrobe: string;
    distinguishing: string;    // 疤、痣、纹身等
  };
  pack: {
    front?: string;             // assetId
    side?: string;
    back?: string;
    threeQuarter?: string;
    closeup?: string;
    turnaround?: string[];      // 360 序列
  };
  variants: AppearanceVariant[];
  voice?: { providerId: string; model: string; voiceId: string };
  promptDescriptor: string;     // 可编辑的身份描述
  negative: string;
  lockedVersion?: number;       // 审批锁版本
  status: ApprovalStatus;
}

interface LocationEntity {
  id: string;
  name: string;
  description: string;
  timeOfDay: string[];
  weather: string[];
  plates: string[];             // 场景参考图
  promptDescriptor: string;
  status: ApprovalStatus;
}

interface PropEntity {
  id: string;
  name: string;
  description: string;
  images: string[];
  promptDescriptor: string;
  status: ApprovalStatus;
}

interface SceneEntity {         // 叙事场次
  id: string;
  episodeId: string;
  number: number;
  heading: string;
  action: string;
  dialogue: string;
  emotionalBeat: string;
  locationId?: string;
  shotIds: string[];
  status: ApprovalStatus;
}

interface ShotEntity {
  id: string;
  episodeId: string;
  sceneId: string;
  number: number;
  order: number;
  spec: {
    duration: number;           // 秒，最终以模型能力为准
    framing: string;            // 特写/近景/中景/全景/远景
    angle: string;              // 平视/俯拍/仰拍/过肩
    cameraMove: string;         // 固定/推/拉/摇/移/跟/环绕/手持
    lens: string;
    action: string;
    dialogue: string;
    emotion: string;
    lighting: string;
    notes: string;
  };
  casting: CastingSlot[];
  locationId?: string;
  propIds: string[];
  continuity: {
    prevShotId?: string;
    nextShotId?: string;
    usePrevLastFrame: boolean;  // 尾帧接首帧
  };
  assets: {
    storyboardId?: string;
    firstFrameId?: string;
    lastFrameId?: string;
    middleFrameId?: string;
    videoId?: string;
    audioId?: string;
  };
  promptOverrides?: {
    image?: string;
    video?: string;
    negative?: string;
    locked?: boolean;
  };
  status: ApprovalStatus;
}

interface CastingSlot {
  characterId: string;
  variantId?: string;
  slot: number;
  notes?: string;               // 本镜状态：受伤/湿发/换装
}

interface TimelineEntity {
  id: string;
  episodeId?: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
  clips: TimelineClip[];
  audioTracks: AudioTrack[];
  subtitles: SubtitleCue[];
  cover?: string;
  endCard?: string;
  status: ApprovalStatus;
}
```

### 4.4 边角色

| role | 含义 | 典型来源 → 目标 |
|---|---|---|
| `script` | 剧本/节拍文本 | Script → Shot 拆解 |
| `beat` | 单个节拍 | Script → Shot |
| `prompt` | 提示词/指令文本 | Text → Image/Video/Audio |
| `character_ref` | 角色身份参考 | Character → Shot/Image/Video |
| `location_ref` | 场景地点参考 | Location → Shot/Image/Video |
| `prop_ref` | 道具参考 | Prop → Shot/Image/Video |
| `style_ref` | 风格参考 | Style/Image → Image/Video |
| `first_frame` | 视频首帧 | Image → Video |
| `last_frame` | 视频尾帧 | Image → Video |
| `middle_frame` | 中间帧 | Image → Video |
| `reference_image` | 通用参考图 | Image → Image/Video |
| `reference_video` | 参考视频（动作/运镜） | Video → Video |
| `reference_audio` | 参考音频（音色/节奏） | Audio → Video |
| `prev_shot` | 上一镜，用于连续性和尾帧接首帧 | Shot → Shot |
| `storyboard` | 分镜图 | Image → Shot |
| `video_clip` | 视频片段 | Video → Compose |
| `audio` | 音频 | Audio → Compose/Shot |
| `timeline` | 时间线 | Compose 内部 |

端口声明类型 + 角色，边必须匹配。一个输入槽可以有多个候选来源，但同一时刻只能绑定一个（多参考槽除外，见 5.4）。

### 4.5 资产

```ts
interface AssetRef {
  id: string;                   // sha256 内容哈希
  kind: 'image' | 'video' | 'audio' | 'text' | 'json';
  path: string;                 // 本地 CAS 相对路径
  thumbPath?: string;
  proxyPath?: string;
  mime: string;
  width?: number;
  height?: number;
  duration?: number;            // 秒
  bytes: number;
  createdAt: string;
  provenance: {
    projectId: string;
    nodeId?: string;
    runId?: string;
    providerId?: string;
    model?: string;
    promptHash?: string;
    params?: Record<string, unknown>;
  };
}
```

规则：

- 资产不可变。裁剪、调色、重绘都产生新资产。
- 以内容哈希去重；同图不同元数据共用文件。
- 远端生成的视频/图片立即下载进 CAS，不能只存临时 URL。
- 资产元数据进 SQLite，文件进 `assets/<hash>`。
- 选中/审批状态属于实体或节点，不属于资产文件。

### 4.6 运行与任务

```ts
interface PromptSnapshot {
  text: string;
  negative?: string;
  segments: PromptSegment[];
  hash: string;
  locked: boolean;
}

interface CostBreakdown {
  estimated?: CostEstimate;
  actual?: CostEstimate;
}

interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  providerRaw?: string;
  details?: Record<string, unknown>;
}

interface RunRecord {
  id: string;
  projectId: string;
  boardId: string;
  nodeId: string;
  entityId?: string;
  action: string;               // 'generate' | 'retake' | 'extractLastFrame' ...
  cacheKey: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  providerId?: string;
  model?: string;
  promptSnapshot: PromptSnapshot;
  params: Record<string, unknown>;
  inputAssetIds: string[];
  outputAssetIds: string[];
  selectedAssetId?: string;
  cost?: CostBreakdown;
  error?: AppError;
  startedAt: string;
  finishedAt?: string;
}

interface JobRecord {
  id: string;
  runId: string;
  providerId: string;
  capability: string;
  remoteTaskId?: string;
  status: 'queued' | 'submitted' | 'polling' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  rawStatus?: string;
  attempts: number;
  nextPollAt?: string;
  updatedAt: string;
}
```

节点状态是派生值：

```text
nodeState = lastRun.status
          + stale（上游/配置变化）
          + pinned（锁定输出）
          + approval（草案/待审/已通过/已驳回）
```

---

## 5. 节点体系

### 5.1 节点注册表

每个节点类型是一个声明式定义，UI 与执行共用：

```ts
interface NodeDefinition<TData = unknown> {
  type: string;
  typeVersion: number;
  title: string;
  category: 'script' | 'character' | 'scene' | 'shot' | 'media'
          | 'audio' | 'compose' | 'director' | 'agent' | 'utility';
  inputs: PortDef[];
  outputs: PortDef[];
  createDefaults(ctx: NodeCreateContext): TData;
  validate(node: BoardNode, ctx: NodeContext): Issue[];
  compile(node: BoardNode, ctx: NodeContext): ExecutionStep[];
  actions: NodeAction[];
  renderer: React.ComponentType<NodeRendererProps<TData>>;
  inspector: React.ComponentType<InspectorProps<TData>>;
}

interface PortDef {
  key: string;
  label: string;
  dataType: 'text' | 'script' | 'beat' | 'character' | 'location' | 'prop'
          | 'image' | 'video' | 'audio' | 'frame' | 'timeline' | 'any';
  role?: EdgeRole;
  multi?: boolean;
  required?: boolean;
}

interface ExecutionStep {
  kind: 'text' | 'image' | 'video' | 'audio' | 'media';
  capability: string;           // 'text.chat' | 'image.generate' | ...
  prompt?: string;
  messages?: ChatMessage[];
  refs?: ReferenceBinding[];
  params: Record<string, unknown>;
  outputs: string[];            // 逻辑输出名
  mediaOp?: 'extractLastFrame' | 'probe' | 'thumbnail' | 'concat' | 'trim';
}

interface ReferenceBinding {
  assetId?: string;
  sourceUrl?: string;
  role: EdgeRole;
  slot?: string;
  label?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
```

新增节点类型只改注册表 + 渲染器，不改调度器。后续插件节点复用同一契约。

### 5.2 原语节点

| 节点 | 输入 | 输出 | 主要动作 |
|---|---|---|---|
| Text / LLM | system、context | text | 生成、改写、扩写、翻译、结构化 |
| Script | idea、参考 | script/beats | 拆集、拆场、拆镜、改写 |
| Image | prompt、参考图 | image | 生成 N 候选、编辑、局部重绘、扩图、超分 |
| Video | prompt、首/尾帧、参考 | video | 文生、图生、首尾帧、参考生成、抽尾帧、延长 |
| Audio | text、参考音频 | audio | TTS、音乐、音效、变声 |
| Group / Frame | 子节点 | — | 分组、命名、折叠、批量运行 |
| Note | — | — | 说明、评审意见 |
| Compose | video/image/audio | timeline/export | 自动装配、预览、导出 |
| Compare | 多资产 | — | 候选并排对比、选择 |
| Router / Select | 多输入 | 任一 | 手动选择上游、A/B 分支 |

### 5.3 领域节点

| 节点 | 核心数据 | 输入 | 输出 | 动作 |
|---|---|---|---|---|
| Character | CharacterEntity | 参考图、风格 | 角色参考包、身份描述 | 生成三视图、360、表情、服装、锁版、加入 casting |
| Location | LocationEntity | 参考图、风格 | 场景参考板 | 生成多时段/天气版本、锁版 |
| Prop | PropEntity | 参考图 | 道具参考 | 生成多角度、锁版 |
| Script | ScriptEntity | 灵感、原作 | 剧本、节拍、镜头列表 | 拆集/拆场/拆镜、改写、翻译 |
| Shot | ShotEntity | 剧本/节拍、角色、场景、道具、风格、前镜 | 分镜图、首帧、尾帧、视频、音频 | 生成分镜、生成首帧、生成尾帧、生成视频、一条龙、重拍、审批 |
| FramePair | 首/尾帧资产 | 首帧、动作、前镜尾帧 | 首/中/尾帧 | 由首帧生成尾帧、从前镜抽尾帧、生成中间帧 |
| Compose | TimelineEntity | 视频/图片/音频/字幕 | 时间线、成片 | 自动装配、裁剪、转场、字幕、导出 |
| Director3D | Scene3DEntity | 场景描述、角色、道具 | 关键帧、previz、控制图、运镜 JSON | 打开导演台、捕获关键帧、渲染预演 |
| Agent | AgentSession | 项目上下文、选中节点 | 计划/命令 | 规划、预览 diff、执行、等待、汇报 |

#### 5.3.1 已实现：业务化节点（通用能力 + 版式约束）

这些节点不是新协议，也不新增执行能力：内部仍然调用 `image.generate` / `image.edit`，
差异只在「多一个固定版式的提示词模板」与「多一个版式参数」。

| 节点 | 用途 | 版式参数 | 模板要点 |
|---|---|---|---|
| 角色三视图 `character` | 角色身份参考包 | 横版/竖版、白底/浅灰 | 横版「面部特写 + 正/侧/背」，竖版 2×2；侧脸只露一只眼，背面不画脸 |
| 分镜九宫格 `storyboard` | 一段戏的连续分镜 | 3×3 / 4×4 | 同场景同角色同光线，景别递进，不出现文字 |
| 表情九宫格 `expression` | 情绪参考 | 表情组预设 | 同一张脸九种表情，其余完全一致 |
| 造型变体 `variant` | 换装/年龄/战损/妆造 | 变体类型 + 说明 | 只改造型，脸保持可辨认地一致 |
| 360 转面 `turnaround` | 多角度参考 | 方向数 4–24 | 等高对齐连续转身一周 |
| 场景多机位 `coverage` | 分镜预演 | 3×3 / 4×4 | 同一场景不同机位与景别 |
| 剧情推演 `continuity` | 前后连续性 | 前 3 秒/后 3 秒 或 前序/过程/后续 | 构图连续、动作衔接自然 |
| 重绘 `redraw` | 改图（无蒙版） | 修改要求 | 保持构图视角光线，只改指出的部分 |

拆帧：设定图、九宫格、转面图这类「一张多格图」可以在 Inspector 里一键拆成单张，
按版式比例裁切（横版 1 特写 + 3 视角、竖版 2×2、宫格按行列、横排按方向数），
切块各自落进资产库（`provenance.view` 记录是第几格/哪个视角）。
拆出的视角可以逐张勾选为该节点的参考图；参考图以 `referenceAssetIds` 存在节点上，
运行时由后端按资产 id 解析成 `reference_image` 输入，不依赖前端内存里的素材表。

#### 5.3.2 已实现：局部重绘 `inpaint`

局部重绘在 `redraw`（无蒙版整图改）之上多了一步「人手画遮挡区」，不新增协议：
内部仍是 `image.edit`，只是把蒙版作为独立输入发给模型。

- 节点 `inpaint`：必填「源图」端口（角色 `source_image`）、重绘要求、补充说明、负向约束；
  蒙版以 `maskAssetId` 存在节点上，随画布一起持久化。
- Inspector 里打开蒙版编辑器：在源图上用画笔涂抹要重绘的区域（半透明白色），
  可以换橡皮、调笔刷、清空；保存时把 RGBA 画板交给后端。
- 后端 `save_mask` 校验蒙版与源图同尺寸，把编辑器画板归一化成 RGBA 蒙版后走 CAS 落库并生成缩略图，
  `provenance.kind` 记为 `mask`。
  归一化同时满足两种协议约定：`RGB = 灰度`（重绘区白、保留区黑，按灰度解读的协议直接可用），
  `A = 255 - alpha`（重绘区透明、保留区不透明，OpenAI 图片编辑约定「透明处才是要重绘的区域」）。
  只输出灰度会让模型认为整张图都不用改。
- 运行时 `prepareRun` 把蒙版作为 `role=mask` 的输入注入（与连线素材并列，不混进参考图），
  模型必须在目录里标了 `supportsMask`（当前只有 `gpt-image-1` 的 `image.edit`），
  否则在花钱前拦下。`openai-images` 适配器把 mask 作为 multipart 的 `mask` 字段发出。
- 蒙版编辑器在保存前检查已涂比例：空蒙版直接拦住，不发请求。
- 图片接口的参数随模型分流：`gpt-image` 系列只发 `output_format` + `quality`
  （官方不认识 `response_format`，发了会 400），`dall-e-3` / seedream 仍发 `response_format`。
- 白=重绘、黑=保留 是通用约定；不同供应商对透明通道的解释可能不同，
  换协议时只改适配器，不改节点与编辑器。

### 5.4 Shot 宏节点

Shot 是短剧生产的核心单位，不是一张普通图片节点。

```text
输入：
  script/beat ──────────────┐
  Character A ──casting─────┤
  Character B ──casting─────┼──► Shot 宏节点
  Location ────location─────┤       ├─ 分镜图
  Prop ────────prop─────────┤       ├─ 首帧
  Style ───────style────────┤       ├─ 尾帧
  prev Shot ───prev_shot────┘       ├─ 视频
                                    └─ 音频/对白
```

节点卡片内直接展示：分镜图、首帧、尾帧、视频四个槽位，以及镜头号、景别、运镜、时长、角色、审批状态。点击「一条龙」按顺序执行：分镜图 → 首帧 → 尾帧 → 视频；每一步都可暂停、替换、锁定。

**展开为子图**：高级用户可以右键「展开」，把 Shot 展开成显式子图：

```text
Shot Inputs → ImageGen(storyboard) → ImageGen(first) → ImageGen(last) → VideoGen → Shot Outputs
```

展开后仍归属同一个 Shot 实体，子图是它的实现细节；收起时显示汇总状态。这样既保留宏节点的效率，也保留 ComfyUI 级控制力。

### 5.5 端口与能力感知

节点的端口不是静态的，而是随模型能力/模式变化：

- Video 节点模式：`t2v`、`firstLast`、`reference`。
- `t2v`：只有提示词和通用参考。
- `firstLast`：首帧、尾帧端口；不显示参考图/视频/音频端口。
- `reference`：参考图/视频/音频端口；不显示首/尾帧端口。
- 切换模式时，不兼容的边会被保留但标记为「未启用」，并提示用户，不静默删除。

MiniMax H3 的首尾帧模式与全能参考模式互斥，这一约束由适配器的 capability 声明，端口层自动执行。

### 5.6 模板

模板是「节点 + 实体骨架 + 连线 + 布局 + 提示词预设」的预设包：

| 模板 | 内容 |
|---|---|
| 短剧标准流水线 | Script、角色位、Location、Shot 网格、FramePair、Compose |
| 单镜头实验 | Image → FramePair → Video → Compare |
| 角色定妆 | Character + 多视角 ImageGen + 审批 |
| 参考视频复刻 | Video 分析 → Shot 列表 → 角色/场景提取 → 生成 |
| 多机位分镜 | Shot + 3×3 网格生成 + 选片 |

模板不锁定用户操作，创建后所有节点可改。

---

## 6. 执行引擎

### 6.1 图校验

运行前校验：

1. 图是 DAG；P0 不允许环。需要迭代时用子图/批量节点表达。
2. 边两端端口类型与角色兼容。
3. 必填输入齐全；实体引用存在且属于当前项目。
4. 模型能力满足：时长、比例、分辨率、参考图数量、首尾帧、音频。
5. 首尾帧与参考模式不混用。
6. Compose 的片段资产存在且可解码。
7. 预估成本可计算；超出预算时阻止或要求确认。

校验失败返回结构化 `Issue[]`，在节点上显示，不进入执行。

### 6.2 拉取式执行

用户点击 Run 后：

```text
1. 从目标节点向上游遍历，收集依赖。
2. 对每个依赖节点计算 cacheKey。
3. 有缓存且未 stale → 复用输出，不执行。
4. 无缓存或强制重跑 → 按拓扑序执行。
5. 每个节点执行前再次校验；执行后写入 Run 与资产。
6. 下游节点若因本次输出变化而失效，标记 stale，但不自动运行。
```

**默认不自动运行下游。** 只有用户明确选择「运行到下游」或「运行整板」时才继续。

### 6.3 缓存键

```text
cacheKey = sha256(canonicalJson({
  nodeType, typeVersion,
  entityVersion,                 // 领域实体版本号
  nodeData,                      // 原语配置/覆盖
  inputHashes,                   // 上游选中资产的哈希，按端口+角色排序
  providerId, model,
  params,
  promptHash,                    // 编译后或锁定的提示词
  styleGuideVersion,
  referenceResolverVersion
}))
```

不进入缓存键：节点位置、尺寸、折叠状态、视口、备注、选中 UI。这样拖动节点不会导致重跑。

规则：

- 「运行」优先命中缓存；「重新生成」强制 miss。
- 命中缓存仍写一条 `RunRecord`，`cost = 0`，便于审计。
- 候选选择变化会改变输出值，因此下游 cacheKey 变化。
- 锁定（pin）节点输出后，上游变化不会让该节点及其下游失效；解锁后恢复传播。

### 6.4 运行模式

| 模式 | 行为 |
|---|---|
| 单节点 | 解析上游缓存，只执行目标节点 |
| 运行到下游 | 目标节点 + 其所有下游，按拓扑序，每个节点仍需通过校验 |
| 选区 | 对选中节点分别执行，共享上游缓存 |
| 整板 | 全图拓扑执行；遇到未审批/缺输入节点跳过并报告 |
| 一条龙（Shot） | 领域动作：分镜 → 首帧 → 尾帧 → 视频，步骤间可暂停 |
| 批量 | 多镜头/多候选，按 provider 并发上限排队 |

所有模式都先显示成本预估和执行计划，超过阈值需确认。

### 6.5 候选、选择、锁定、审批

- 图片/视频节点支持一次生成 N 个候选；候选并列展示，不自动选第一个。
- 用户选择某个候选后，写入 `selectedAssetId`，下游引用它。
- 锁定（pin）：把当前选中资产固定为该节点的输出；上游变化不传播。
- 审批：资产/镜头状态 `draft → review → approved / rejected`；审批通过可自动 pin。
- 重拍：保留旧 Run 与旧资产，生成新候选；对比视图并排查看。

### 6.6 任务队列与恢复

Rust 负责：

- 提交异步视频任务，持久化 `remoteTaskId`。
- 轮询、退避、超时、取消。
- 按 provider 的并发上限排队；全局并发上限。
- 应用重启后扫描未完成任务，继续轮询或标记失败。
- 下载结果到 CAS；下载失败可重试，不影响 provider 任务记录。
- 事件：`job.updated`、`run.updated`、`asset.created`。

幂等：

- 每次提交带 `clientRequestId = runId + stepIndex + attempt`（重试用同一逻辑 ID，避免重复计费）。
- 提交前先写本地 Job 记录；提交成功后补 `remoteTaskId`；本地写入失败时尝试取消远端任务。
- 重试只针对可重试错误；鉴权/参数/内容审核错误不重试。

### 6.7 成本控制

- 每个 provider/model/capability 有价格表；用户可改。
- 运行前估算：文本按 token 估算，图片按张，视频按秒 × 分辨率，音频按字符/秒。
- 项目预算 + 单次确认阈值 + 可选每日上限。
- 运行后记录实际用量（provider 返回则用实际值，否则用估算）。
- 成本面板按项目/集/镜头/模型汇总。
- **任何自动运行（Agent/模板）都必须受预算约束。**

### 6.8 错误分类

| 类别 | 可重试 | 处理 |
|---|---|---|
| `auth` / `permission` | 否 | 提示重新配置 Key/权限 |
| `quota` / `rate_limit` | 是（退避） | 排队/延后，显示预计等待 |
| `invalid_request` | 否 | 显示具体字段与校验问题 |
| `unsupported_capability` | 否 | 提示切换模型/模式 |
| `content_moderation` | 否 | 显示供应商原因，允许修改提示词 |
| `timeout` / `provider_unavailable` | 是 | 重试，超过次数标记失败 |
| `task_failed` | 视情况 | 显示远端 rawStatus，允许重拍 |
| `download_failed` | 是 | 重试下载；保留远端 URL 与任务 ID |
| `storage_error` | 否 | 阻止继续，提示磁盘/权限 |
| `cancelled` | — | 用户取消，保留记录 |

### 6.9 命令、撤销、审计

- 所有图/实体修改走 `GraphCommand`。
- 撤销栈按会话保存；拖拽/连续输入合并为一条命令。
- Agent 命令带 `actor: 'agent'`，在历史面板可区分。
- 运行记录不可撤销，但可以删除本地记录（资产保留或按策略回收）。
- 持久化快照用于跨会话回滚；不在 P0 做完整协作历史。

---

## 7. 模型接入层

### 7.1 能力矩阵

统一能力名：

```text
text.chat
image.generate
image.edit
image.upscale
video.generate
video.edit
video.extend
audio.tts
audio.music
audio.sfx
vision.analyze
video.analyze
asr
```

每个 provider/model 声明：

```ts
interface ModelCapability {
  capability: string;
  modes?: string[];                 // t2v | firstLast | reference
  maxReferenceImages?: number;
  maxReferenceVideos?: number;
  maxReferenceAudios?: number;
  freeReferenceImages?: number;
  supportsFirstFrame?: boolean;
  supportsLastFrame?: boolean;
  supportsNativeAudio?: boolean;
  durations?: { min: number; max: number; step: number };
  ratios?: string[];
  resolutions?: string[];
  maxPromptChars?: number;
  inputTransport: ('dataUrl' | 'publicUrl' | 'upload' | 'multipart')[];
  async: boolean;
  concurrency?: number;
  price?: PriceRule;
}

interface PriceRule {
  unit: 'token' | 'image' | 'second' | 'character' | 'request';
  amount: number;
  currency: string;
}

interface ModelConfig {
  id: string;
  displayName: string;
  capabilities: ModelCapability[];
  defaults?: Record<string, unknown>;
}
```

### 7.2 Provider 与适配器

```ts
interface ProviderProfile {
  id: string;
  name: string;
  adapter: 'openai-compatible' | 'minimax-h3' | 'bytedance-video'
         | 'grok-video' | 'gemini-video' | 'comfyui' | 'custom';
  baseUrl: string;
  auth: { type: 'bearer' | 'header'; keyRef: string }; // keyRef 指向 keychain
  models: ModelConfig[];
  enabled: boolean;
}

interface ProviderAdapter {
  validate(request: CapabilityRequest, model: ModelConfig): Issue[];
  estimateCost(request: CapabilityRequest, model: ModelConfig): CostEstimate;
  execute(request: CapabilityRequest, ctx: AdapterContext): Promise<AdapterResult>;
  poll?(handle: JobHandle, ctx: AdapterContext): Promise<JobStatus>;
  cancel?(handle: JobHandle, ctx: AdapterContext): Promise<void>;
  mapError(raw: unknown): AppError;
}

interface CapabilityRequest {
  capability: string;
  model: string;
  prompt?: string;
  messages?: ChatMessage[];
  refs?: ReferenceBinding[];
  params: Record<string, unknown>;
  clientRequestId: string;
}

interface AdapterContext {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, rawStatus?: string) => void;
}

interface AssetPayload {
  kind: 'image' | 'video' | 'audio' | 'text';
  mime: string;
  url?: string;
  data?: string;
}

interface AdapterResult {
  status: 'succeeded' | 'queued';
  outputs: AssetPayload[];
  taskId?: string;
  raw?: unknown;
}

interface JobHandle {
  providerId: string;
  taskId: string;
  raw?: unknown;
}

interface JobStatus {
  status: 'queued' | 'submitted' | 'polling' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  outputs?: AssetPayload[];
  rawStatus?: string;
  error?: AppError;
}

interface CostEstimate {
  amount: number;
  currency: string;
  unit: string;
  breakdown?: Record<string, number>;
}
```

首批适配器：

| 适配器 | 能力 | 说明 |
|---|---|---|
| `openai-compatible` | 文本、图片生成/编辑、TTS | 用户已有中转；baseUrl + key + model 可配；图片优先 data URL |
| `minimax-h3` | 视频生成（文生/首尾帧/全能参考） | 官方/中转两套传输策略；5–15 秒；768P/2K；异步 task_id |
| `bytedance-video` | 视频 | 保留现有实现，按新接口重构 |
| `grok-video` | 视频 | 保留现有实现 |
| `gemini-video` | 视频 | 保留现有实现 |
| `comfyui` | 图片/视频工作流 | P6，通过本地工作流提交，不把 ComfyUI 内嵌 |
| `custom` | 通用异步 HTTP | P6，用户配置提交/查询/结果路径与 JSON 映射 |

### 7.3 MiniMax H3 约束

- 模式：文生视频、图生视频（首帧/尾帧/首尾帧）、全能参考（图片/视频/音频）。
- **首尾帧模式与全能参考模式互斥**，不能在同一请求中混用。
- 时长：5–15 秒，整数秒。
- 分辨率：768P / 2K。
- 比例：`adaptive`、`21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16`。
- 参考素材上限：最多 9 张图、3 段视频、3 段音频；图片 ≤ 30MB；视频 2–15 秒、≤ 50MB；音频 2–15 秒、≤ 15MB。
- 提示词最长 20480 字符；实际使用建议更短，过长会丢细节。
- 官方接口的图片/视频输入要求公网可访问 URL；没有公开的文件上传接口。
- 异步：提交返回 task_id，轮询查询；结果 URL 有时效，必须立即下载。

这些约束写入 capability，不由 UI 硬编码。

### 7.4 输入传输与资产外链

这是桌面应用接官方视频 API 的关键难点。

```ts
interface AssetTransport {
  kind: 'dataUrl' | 'publicUrl' | 'upload' | 'multipart';
  prepare(asset: AssetRef, purpose: 'image' | 'video' | 'audio'): Promise<TransportRef>;
  release?(ref: TransportRef): Promise<void>;
}

type TransportRef = {
  kind: 'dataUrl' | 'url' | 'uploadId' | 'multipart';
  value: string;
  expiresAt?: string;
  cleanup?: () => Promise<void>;
};
```

策略：

1. **优先 data URL/base64**：OpenAI 兼容的图片编辑、TTS 参考等，凡是支持的就地转 base64，零外部依赖。
2. **优先支持上传的中转**：MiniMax H3 中转若支持 base64 或文件上传，直接用中转，不要求用户配对象存储。P0 联调时先验证。
3. **官方 H3 等只收公网 URL 的 provider**：使用可配置的 **S3 兼容资产桶**（R2/OSS/S3/MinIO）：
   - 上传派生输入（压缩到合适尺寸的 JPEG/PNG、必要时的短视频），不传原始大文件。
   - 使用短期签名 URL；任务结束后回收 `tmp/<project>/<run>/`。
   - 桶配置与密钥进 keychain；项目和日志不落明文。
4. **本地隧道**（Cloudflare Tunnel/ngrok）只作为开发调试，不作为产品方案。
5. 适配器在运行前明确告诉用户当前使用的传输方式；不能静默把本地路径传给 provider。

这条链路同时服务后续团队协作的共享资产，不是临时补丁。

### 7.5 提示词编译

每个领域节点有一个或多个 `PromptCompiler`：

```ts
interface PromptCompiler {
  target: 'image' | 'video' | 'text' | 'audio';
  compile(ctx: PromptContext): PromptResult;
}

interface PromptContext {
  styleGuide: StyleGuide;
  projectBible: string;
  characterDescriptors: string[];
  locationDescriptor?: string;
  propDescriptors: string[];
  shotSpec?: ShotEntity['spec'];
  continuity?: ContinuityInfo;
  provider: ModelConfig;
  userOverride?: string;
  locked: boolean;
}

interface PromptSegment {
  key: 'style' | 'subject' | 'action' | 'camera' | 'lighting'
     | 'composition' | 'continuity' | 'negative';
  label: string;
  text: string;
}

interface PromptResult {
  text: string;
  negative?: string;            // 仅当模型支持负向提示时使用
  segments: PromptSegment[];    // style/subject/action/camera/lighting/...
  promptHash: string;
}
```

规则：

- 提示词分段可读：风格、主体、动作、镜头、光线、构图、连续性、负向。
- UI 显示「编译结果」与「用户覆盖」；用户可编辑并锁定。
- 锁定后运行只使用用户文本；未锁定则自动编译，并在运行记录里保存快照。
- 不支持负向提示的模型（如 H3）不拼接 `Negative:` 文本，而是把负向约束转成正向描述或省略。
- 不同模型不同模板：图片偏自然语言，视频偏结构化镜头描述，H3 用其推荐的结构。
- 提示词库支持变量（`{{character.name}}`、`{{style.palette}}`）和版本。

### 7.6 引用解析

`ReferenceResolver` 在运行前决定「这次到底带哪些参考图」：

优先级：

1. 角色特写/三四分之三视角
2. 角色正面全身
3. 本镜服装变体
4. 场景/地点参考板
5. 道具参考
6. 风格参考帧
7. 上一镜尾帧（若开启尾帧接首帧）

规则：

- 首帧/尾帧是「帧槽」，不是「参考图」，不能混入 reference_image 计数。
- 按 provider 上限裁剪；超出时丢弃最低优先级并警告，或让用户手动选择。
- 去重（哈希）、压缩（输入尺寸/质量）、按角色分组。
- 运行前在 Inspector 展示解析后的参考列表和用途，用户可拖拽调整顺序/禁用。
- 解析器版本进入 cacheKey，避免规则变化后误用缓存。

### 7.7 路由、凭据、用量

- 每个能力有默认模型；节点可覆盖；项目可覆盖。
- 回退链必须显式：例如视频默认 H3，失败后可手动切到另一模型；不做静默换模型（输出会变）。
- 密钥只存系统钥匙串；前端只拿 masked 显示；所有请求从 Rust 发出。
- 项目导出、日志、错误上报都不含密钥；日志中的 Authorization 一律脱敏。
- 用量按项目/模型/能力/日期记录；成本面板可导出 CSV。
- 模型目录用 JSON 配置，新增模型不改代码；适配器只处理协议差异。

#### 7.7.1 已实现：模型目录 × 供应商 × 多 Key 的路由

节点按「能力」划分，不按模型划分；模型差异全部落在**模型目录**与**绑定**上：

```
节点（选 modelId + 可选 providerId）
  → 路由（modelId → 供应商绑定排序 → 供应商内多 Key）
  → 协议适配器（绑定上的 capability → protocol）
  → 供应商端点
```

- **模型目录**（`src/domain/providers/catalog.ts`）：内置模型的能力、参数、推荐协议、官方供应商建议。新增模型只改目录。
- **绑定**：供应商 profile 里的 `models[]` 就是「供应商 × 模型」的绑定表；`protocols` 是「能力 → 协议」，`priority` 是该模型下跨供应商的调用顺序，`enabled` 是针对该模型停用这家。
- **多 Key**：供应商可以有多个 Key（`keys[]`，密钥在钥匙串 `provider/{id}/key/{keyId}`）。调用时按顺序尝试，401 作废该 Key（不再尝试），403/限流/服务错误只做 60 秒冷却，到期自动恢复。
- **自动 vs 指定**：节点上 `providerId` 为空 = 自动路由（按 priority 逐家尝试，失败回退下一家）；指定供应商 = 只用这一家。自动路由时供应商不进缓存键，换供应商不会让缓存失效。
- **回退策略**（`gateway::should_fallback`）：鉴权、限流、服务不可用、超时、端点不存在、响应坏掉 → 换下一个候选；参数错误、内容审核 → 直接失败（换一家结果一样）。素材传输方式不匹配（`CAP_PUBLIC_URL_REQUIRED`）也换下一家：换一家支持另一种传输方式的供应商可能就能跑。
- **协议优先级**：绑定上的 `protocols[capability]` > 请求带的协议（前端按目录解析）> 旧适配器兜底。绑定优先，用户在设置里为这条绑定改的协议才会生效。
- **错误判定**：状态码优先于错误体关键词。401/403/404/429/5xx 各有确定含义，不会因为错误体里出现一个 "safety" 就被误判成审核拒绝；只有 400/422 且错误体提到审核时才算 `MODERATION_REJECTED`。
- **异步任务收尾**：运行到达终态（成功/失败/取消）时同步关闭它名下的 job 行；重启时的恢复扫描遇到已终态的运行只收敛 job 行，不会把它改判成「提交中断」。
- **协议清单**：文本 `openai-chat` / `openai-responses` / `anthropic-messages`；图片 `openai-images` / `qwen-image` / `banana-image`；音频 `openai-audio` / `minimax-tts` / `mimo-tts`；视频 `minimax-video` / `seedance-video`。
- **目录参数真正下发**：Inspector 里能改的目录参数（`speed` / `quality` 等）按目录定义进请求与缓存键；不写进对应适配器就等于没生效，改目录时记得同步适配器。
- **传输方式预检**：只接受 `publicUrl` 的模型，用节点级参考图（拆帧视角）或蒙版时同样要求配置公网素材桶，预检阶段就拦住，不等运行创建后才报错。
- **运行轨迹**：`RunRecord.route` 记录依次试过哪些供应商 / Key 与失败码，最终用哪家一目了然。

### 7.8 连接测试与模型目录

设置页提供：

- 供应商页：Base URL、多 Key（可增删、按顺序回退）、勾选这家提供的模型、每个能力选协议。
- 模型管理页：按模型看有哪些供应商在供，可排序（priority）、可针对该模型停用某家、可换协议。
- 「测试连接」：文本发一条短消息；图片生成 1 张最小图；视频只做参数校验/配额检查，不实际提交（避免无谓扣费）。
- 能力矩阵展示：每个模型支持的模式、时长、比例、参考数量、输入传输方式。
- 错误详情：HTTP 状态、provider 错误码、建议动作；敏感信息脱敏。

---

## 8. 角色一致性与连续性

### 8.1 角色圣经

角色实体是唯一权威：

- 文字：身份、性格、年龄、脸型、发型、体型、服装、特征（疤/痣/纹身）、负向约束。
- 图像：正面、侧面、背面、四分之三、特写、360 序列。
- 变体：服装、年龄、受伤、湿发、妆造；每个变体有适用集数/场次和审批状态。
- 声音：TTS provider/voiceId（后续）。
- 锁定版本：审批通过后生成 `lockedVersion`；下游默认引用锁定版本。

### 8.2 三视图与造型生成

Character 节点的「生成三视图」动作：

1. 文本模型把角色设定扩写成结构化外观描述（可编辑）。
2. 生图模型按「正面/侧面/背面/四分之三 + 特写」布局模板生成。
3. 用户选片；可单独重绘某一视角。
4. 生成 360 序列（可选，多帧）。
5. 生成表情/服装变体（可选）。
6. 审批通过 → 锁版。

三视图不是目的，**可复用的身份参考包**才是目的。

业内通行版式（LibTV / CVY / 99AICreator 一致）：

- 横版 16:9：左侧大幅面部特写 + 右侧正面 / 侧面 / 背面全身；竖版 9:16：2×2 正面 / 左侧 / 右侧 / 背面。
- 纯白背景、柔和棚拍光、统一身高服装站姿；提示词里排除文字、标签、箭头、道具、场景。
- 侧面视角只露一只眼睛、正面双眼对称、背面不画脸——这是避免「多脸」的关键约束。
- 模块化参考：脸 / 身材 / 风格 / 服装道具 / 姿势分槽位给（上限 5–10 张）；没有脸时用无头人台或头盔，避免脸串味。
- 产出一整套素材而不是单张图：单视角 + 面部特写分开落库，锁版后作为下游 `character_ref`。

### 8.3 Casting

Shot 的 `casting` 槽位绑定角色：

- 从左侧角色库拖入，或从 Character 节点连线到 Shot 的 casting 端口。
- 每个槽位可指定变体（如「第 3 集·战损」）和本镜备注（「湿发、左脸擦伤」）。
- 运行时解析器自动把角色参考包注入图片/视频请求，并把身份描述写进提示词。
- 同一角色跨镜头默认使用同一锁定版本；需要变化时显式换变体，避免静默漂移。

### 8.4 场景、道具、风格

- Location 实体：地点描述、参考板、时段/天气变体；Shot 通过 `location_ref` 引用。
- Prop 实体：道具多角度参考；Shot 通过 `prop_ref` 引用。
- StyleGuide：全局类型、视觉风格、色彩、镜头语言、时代、约束、负向；所有提示词编译器默认注入，可按板/镜头覆盖。
- 风格参考图可来自 Image 节点或项目风格板；作为 `style_ref`，不与角色参考混淆。

### 8.5 镜头连续性

- Shot 链按 `order` 排列；`prevShotId`/`nextShotId` 维护前后关系。
- 「尾帧接首帧」开启时：
  - 若上一镜有视频：Rust ffmpeg 抽最后一帧，作为本镜首帧候选。
  - 若上一镜只有尾帧图：直接复用。
  - 若没有：用本镜分镜图生成首帧。
- FramePair 节点用于精调：首帧 + 动作 → 生成尾帧；或首帧 + 尾帧 → 生成中间帧。
- 视频生成后自动抽尾帧存档，供下一镜使用；抽帧是媒体步骤，不计模型费用。
- 连续性检查：
  - 技术：分辨率、比例、时长、帧率、音频。
  - 视觉（可选）：上一镜尾帧与本镜首帧的亮度/色调/构图差异；角色服装/道具是否延续。
  - 语义（可选）：视觉模型检查角色身份、服装、场景、道具是否一致，返回问题列表，不自动阻断。

### 8.6 一致性质量检查

分三层：

1. **技术 QC**：ffprobe 时长/分辨率/帧率/音频；首尾帧是否存在；黑帧/冻结帧；文件可解码。
2. **身份 QC**：用视觉模型对比生成图与角色参考包，输出「像/不像 + 差异点」；可选做人脸嵌入相似度（后续本地模型）。
3. **连续性 QC**：镜头链的服装、道具、光线、动作方向；Compose 前的缺镜/重复/时长检查。

QC 结果作为审批参考，不自动重生成；用户决定重拍或通过。

### 8.7 一致性的边界

纯 API 方案无法保证 100% 一致。设计上通过：

- 锁定角色包 + 参考图注入 + 身份描述 + 候选制 + 人工审批 + QC 提示
- 后续接 ComfyUI/IP-Adapter/LoRA 做本地一致性增强（P6）
- 镜头级重拍和变体管理

不承诺「一键永不漂移」，但保证漂移可发现、可回退、可重拍。

---

## 9. 画布与交互

### 9.1 工作台布局

```text
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：项目 / 画布页签 / 比例 / 缩放 / 模型状态 / 队列 / 成本 │
├──────────┬───────────────────────────────────────┬───────────┤
│ 左栏     │                                       │ Inspector │
│ 节点库   │           无限画布                    │ 实体/镜头 │
│ 模板     │      React Flow + 自定义节点          │ 提示词    │
│ 素材     │                                       │ 参考/模型 │
│ 角色     │                                       │ 运行历史  │
│ 场景     │                                       │ QC/审批   │
│ 提示词   │                                       │           │
├──────────┴───────────────────────────────────────┴───────────┤
│ 底部 Dock：任务队列 / 时间线 / 预览 / Agent / 日志            │
└──────────────────────────────────────────────────────────────┘
```

### 9.2 节点卡片

- 头部：类型图标、标题、实体名、状态点（运行/过期/失败/已审批）、锁定图标。
- 主体：媒体预览（图/视频首帧/音频波形/文本摘要）；空态显示主操作。
- 端口：左侧输入、右侧输出；悬停显示类型与角色；必填端口有标记。
- 底部：Run、候选数、展开、更多菜单。
- 尺寸：默认 260–360px；媒体节点按原始比例；可调整；分组可折叠。
- 状态视觉：运行中脉冲、stale 半透明+角标、失败红色、审批通过绿色、锁定金色。

### 9.3 连线

- 贝塞尔曲线；颜色按数据类型；标签显示角色（casting/first_frame/...）。
- 从端口拖出；松开在空白处弹出节点选择器，自动创建兼容节点。
- 连线校验：类型、角色、单/多输入、能力模式。
- 多输入槽显示堆叠缩略图；点击管理引用顺序。
- 删除上游节点时，下游边保留为「断开的引用」并标红，提示重新连接。

### 9.4 Inspector

Schema 驱动，按节点类型渲染：

- 实体字段：角色设定、镜头规格、场景描述、时间线。
- 提示词：编译结果、覆盖编辑、锁定、分段展开。
- 参考：解析后的角色/场景/道具/风格/帧槽，可调整顺序、禁用。
- 模型：provider、model、模式、时长、比例、分辨率、参考上限。
- 成本：预估、实际、币种。
- 运行：历史、候选、对比、重拍、抽尾帧。
- QC：技术/身份/连续性结果。
- 审批：状态、评论、锁定。

### 9.5 视图

| 视图 | 用途 |
|---|---|
| 画布视图 | 默认，节点编排 |
| 生产视图 | 按集/场自动布局，显示镜头链和完成度 |
| 分镜网格 | 选中镜头 → 宫格排版，带镜号/时长/台词，导出 PNG/PDF/4K |
| 聚焦模式 | 只显示某个 Shot 子图或某个场景 |
| 审片模式 | 逐镜预览、通过/驳回、评论、批量审批 |
| 时间线 | Compose 的剪辑视图 |
| 导演台 | Director3D 全屏编辑 |
| Agent | 对话 + 计划 diff |

### 9.6 交互与快捷键

- 空格拖拽平移；滚轮缩放；`Shift+1` 适配全部；`Shift+2` 适配选中。
- `Cmd/Ctrl+Z` 撤销，`Shift+Cmd/Ctrl+Z` 重做。
- `Cmd/Ctrl+C/V` 复制节点/实体引用；`Cmd/Ctrl+D` 复制并偏移。
- `R` 运行选中；`Shift+R` 运行到下游；`Esc` 取消选择。
- 多选、框选、对齐/分布、打组、折叠、锁定位置。
- 右键菜单：运行、重拍、展开、复制、创建模板、查看血缘。
- 双击空白：节点选择器；拖入素材：创建 Image/Video/Audio 节点。
- 双击连线：插入兼容节点（如 Image → Video 之间插入 FramePair）。

### 9.7 性能

- React Flow `onlyRenderVisibleElements`；节点组件 memo。
- 媒体缩略图懒加载；视频只加载 poster；进入视口再加载元数据。
- 视频代理（低码率 mp4）用于画布预览；原片只在导出/详情用。
- 资产只传引用，不把 base64/Blob 放进全局 store。
- 列表虚拟化（素材库、任务队列、提示词库）。
- 大图/大视频不进入撤销快照；快照只存引用。
- 目标：500 节点 + 200 媒体缩略图可流畅平移；超过 1000 节点时提示使用子图/分组/聚焦模式。

### 9.8 视觉系统

- 延续 Frameforge：墨黑底 `#111617`、薄荷青 `#75d8bd`、面板 `#151b1c/#20292a`、暖橙 `#bf7256`。
- 节点分类色：剧本（暖黄）、角色（薄荷）、场景（蓝）、镜头（橙）、媒体（紫）、音频（青绿）、合成（白）。
- 字体：界面用无衬线；品牌/编号可用等宽。
- 暗色为主；P0 不做亮色主题，后续可加。
- 设计 token 集中在 `src/ui/tokens.css`，禁止散落硬编码颜色。

### 9.9 无障碍

- 所有按钮有 `aria-label`；键盘可达。
- 端口连线提供键盘替代（Inspector 中选择上游）。
- 颜色不作为唯一状态信号，配图标/文字。
- 文本节点按纯文本渲染，Markdown 经过 sanitize。
- 对比度满足 WCAG AA；动效尊重 `prefers-reduced-motion`。

---

## 10. 成片与媒体

### 10.1 Compose 节点

Compose 绑定一个 `TimelineEntity`：

- 自动装配：按集/场/镜头顺序取每个 Shot 的选中视频；缺镜/未审批的镜头标黄。
- 片段：视频、图片（定帧时长）、转场、封面、片尾。
- 音频：对白、音乐、音效；音量、淡入淡出、起始时间。
- 字幕：文本、起止时间、样式；可从对白生成。
- 预览：画布内播放器，按时间线播放；支持逐镜跳转。
- 导出：调用 Rust ffmpeg，输出 MP4；进度事件；结果写 `Exports`。

### 10.2 导出规格

- 比例：9:16 / 16:9 / 1:1（项目级 + 预设）。
- 分辨率：720p / 1080p / 2K（按源素材和性能限制）。
- 编码：H.264 + AAC；CRF 可配；字幕可烧录或旁挂。
- 音频：混合轨道；响度归一化（可选）。
- 缩略图：抽取封面帧。
- 校验：ffprobe 输出时长/分辨率/音轨；与时间线预期对比，不符则警告。

### 10.3 QC 门禁

导出前检查：

- 缺镜、空片段、时长 0。
- 分辨率/比例不一致。
- 无音轨或音频削波。
- 黑帧/冻结帧。
- 未审批镜头（可强制导出，但需确认）。
- 字幕越界/重叠。

### 10.4 多版本交付

P6：

- 多比例版本（同一时间线重排/裁切）。
- 多语言字幕/配音。
- 平台预设（抖音/快手/YouTube/TikTok）。
- 封面/标题/描述模板。
- 批量导出队列。

### 10.5 项目包

- 导出：项目 JSON + 实体 + 画布 + 资产清单；可选包含媒体文件。
- 不包含：API Key、钥匙串引用、运行中的远端 task ID、日志中的敏感信息。
- 导入：校验 schemaVersion、资产哈希、路径安全；旧版本走迁移。
- 用于备份、交接、模板分享。

---

## 11. 3D 导演台

### 11.1 定位

3D 导演台是 **预演与构图工具**，不是最终渲染器：

- 搭场景、摆人偶、调机位、打光、设计运镜。
- 捕获关键帧、深度/法线/姿态控制图、快速 previz。
- 把机位和运镜转成视频模型的提示词/控制输入。

### 11.2 场景实体

```ts
interface Scene3DEntity {
  id: string;
  name: string;
  units: 'meter';
  environment: { hdri?: string; backgroundColor?: string; fog?: number };
  objects: Scene3DObject[];     // 地面、建筑、家具、道具、GLB
  characters: Scene3DCharacter[];
  lights: Scene3DLight[];
  cameras: Scene3DCamera[];
  cameraPaths: CameraPath[];
  updatedAt: string;
}
```

- 对象：primitive 或 GLB；位置/旋转/缩放/材质。
- 人偶：身高、比例、姿势预设、简单服装块；不追求最终角色渲染。
- 灯光：主光/辅光/轮廓光/环境光/实际光源；色温、强度、软硬。
- 相机：焦距、传感器、位置、目标、景深；多机位。
- 运镜：关键帧 + 缓动；推/拉/摇/移/跟/环绕/手持。

### 11.3 捕获输出

- 关键帧 PNG：任意相机、任意时间点。
- 中间帧：用于首/中/尾帧视频模式。
- Previz MP4：按时间线渲染低分辨率帧，ffmpeg 合成；用于节奏/构图预览。
- 控制图：深度、法线、姿态（人偶）；给支持控制输入的模型。
- 运镜 JSON：位置/朝向/焦距/关键帧；提示词编译器转成 `cameraMove` 描述。

### 11.4 与 Shot 集成

- Shot 可挂一个 Director3D 场景 + 机位；一键捕获首/尾/中帧并填入槽位。
- 运镜 JSON 自动写到 Shot 的 `cameraMove`/`notes`，视频提示词使用。
- Previz 视频可作为 `reference_video`，用于动作/节奏参考（模型支持时）。
- 手绘运镜：在 2D 叠加层画路径，映射为 3D 样条，调整高度/速度。

### 11.5 技术选型

- three.js + React Three Fiber + drei。
- 场景数据 JSON 存实体；GLB/HDRI 存 CAS。
- 捕获用 WebGL render target；previz 用离屏渲染帧 + ffmpeg。
- 性能：限制面数/贴图；LOD；只在导演台打开时渲染；离开释放 GPU 资源。
- 不做：影视级光线追踪、复杂绑定、最终角色渲染。

### 11.6 动作捕捉与拉片

- 动作捕捉（P3）：视频 → 姿态序列（本地 MediaPipe 或外部 API）→ 驱动人偶 → 输出姿态图/参考视频。
- 拉片（P3/P4）：ffmpeg 抽帧 + 镜头切分 + ASR + 视觉模型描述 → 镜头列表/风格/台词 → 生成。
- 参考视频复刻（P4）：拉片结果 + 模板 + Agent 自动建板。
- 这些能力消费 Shot/Timeline 数据，不另建一套生产模型。

---

## 12. Agent 与 Skill

### 12.1 定位

Agent 是「制片助手」，不是另一个黑盒生成器：

- 与人类共用命令层、节点、模型、资产、成本控制。
- 能创建/修改/运行图，但默认先出计划 diff，用户确认后执行。
- 所有操作可撤销、可审计、有预算上限。

### 12.2 工具集

| 工具 | 作用 |
|---|---|
| `project.inspect` | 读取项目摘要、风格、角色、镜头、预算 |
| `board.create` | 从模板创建画布 |
| `node.create/update/delete` | 增删改节点 |
| `edge.create/delete` | 连线/断线 |
| `entity.update` | 更新角色/场景/镜头/剧本 |
| `run.node` | 运行节点（受预算限制） |
| `run.wait` | 等待任务完成/失败 |
| `asset.select` | 选择候选 |
| `compose.build` | 装配时间线 |
| `export.cut` | 导出成片 |
| `ask_user` | 需要决策时暂停询问 |

### 12.3 模式

- **建议模式**：只生成计划 diff，不落盘、不运行。
- **执行模式**：用户确认后执行；涉及付费运行逐步确认或按预算放行。
- **自动驾驶**：设定预算和检查点（角色定妆、分镜、成片），在检查点暂停等人工审批。

### 12.4 一句话短剧

流程：

1. 读取创意/题材/时长/比例/预算。
2. 生成 logline、剧本、角色、场景、镜头列表。
3. 创建画布与实体，生成角色三视图（检查点 1）。
4. 生成分镜/首尾帧（检查点 2）。
5. 批量生成视频（预算约束、并发控制）。
6. 装配时间线、生成字幕/音频、导出（检查点 3）。
7. 输出成本与素材清单。

### 12.5 参考视频复刻

1. 视频分析：镜头切分、抽帧、ASR、视觉描述、风格/运镜总结。
2. 生成镜头列表与风格圣经。
3. 角色/场景/道具提取与建库。
4. 建板、生成、对齐节奏。
5. 人工审片与重拍。

### 12.6 MCP / Skill / CLI

- 本地 API：Tauri 命令或 localhost HTTP；仅本机、token 鉴权、项目范围限制。
- MCP 工具：暴露上述工具；外部 Agent 可调用；禁止任意文件/命令执行。
- Headless CLI（P4）：读取项目 + 命令脚本，复用领域层；初期可用 Tauri runner 模式，后续抽 Node/Bun CLI。
- 审计：每次 Agent 调用记录 actor、工具、参数、成本、结果；可回放。

### 12.7 护栏

- 预算上限（单次/项目/每日）。
- 付费运行确认阈值。
- 删除/覆盖/批量操作需确认。
- 禁止修改密钥、导出路径、系统设置。
- 失败重试有次数上限；不静默换模型。
- 提示词注入防护：项目文本不作为系统指令；工具权限最小化。

---

## 13. 协作与云

### 13.1 本地优先

- 单机是完整产品；协作是可选层。
- 项目、资产、密钥默认本机。
- 离线可编辑；联网后同步。

### 13.2 CRDT 文档

- Board 文档、实体文档用 Yjs 兼容的 CRDT。
- `nodes`/`edges` 用 map；位置/尺寸是字段；顺序用 fractional index，不用数组下标。
- 文本（剧本、描述）用 `Y.Text`；标量用字段级 LWW。
- 资产不可变，按哈希引用，天然无冲突。
- 运行记录是本地的；共享时只同步运行摘要（可选）。

### 13.3 同步服务

推荐：Rust `axum` + `yrs`（Yjs Rust 实现）+ Postgres + S3 兼容对象存储。

- WebSocket 同步 board/entity 文档。
- Awareness：光标、选中、视口、编辑中节点。
- 权限：owner/editor/reviewer/viewer；项目邀请。
- 审片链接：签名只读链接；评论锚定节点/资产/时间码。
- 版本：命名快照；恢复生成新状态，不破坏历史。
- 资产：上传共享桶；客户端本地缓存；按哈希去重。
- 生成执行仍在各成员本地（各自 Key/预算）；共享的是文档和资产。需要集中渲染时再加 runner 服务。

### 13.4 协作交互

- 队友光标/选中框；节点显示「XX 编辑中」。
- 评论/批注；@提醒（后续）。
- 审批状态同步；冲突时以字段级合并为主，文本按 CRDT。
- 离线改动队列；重连合并；冲突提示。

### 13.5 版本与审片

- 快照：手动命名 + 自动每日。
- 审片模式：逐镜播放、通过/驳回、评论、批量审批。
- 分镜网格导出 4K PNG/PDF，带镜号/时长/台词，用于提案。
- 变更对比：两个快照之间节点/资产/审批差异。

---

## 14. 存储与数据管理

### 14.1 本地目录

```text
~/Library/Application Support/com.frameforge.studio/
├─ projects/<projectId>/
│  ├─ project.db              SQLite（WAL）
│  ├─ assets/<sha256>         原始资产
│  ├─ thumbs/<sha256>.jpg     缩略图
│  ├─ proxies/<sha256>.mp4    视频代理
│  ├─ exports/                成片
│  └─ logs/                   脱敏日志
└─ settings.json              非敏感全局设置（密钥在 keychain）
```

### 14.2 SQLite 表

```sql
projects(id TEXT PRIMARY KEY, name TEXT, doc_json TEXT, schema_version INT,
         created_at TEXT, updated_at TEXT);
boards(id TEXT PRIMARY KEY, project_id TEXT, doc_json TEXT, schema_version INT,
       updated_at TEXT);
entities(id TEXT PRIMARY KEY, project_id TEXT, type TEXT, doc_json TEXT,
         version INT, updated_at TEXT);
assets(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, path TEXT, mime TEXT,
       width INT, height INT, duration REAL, bytes INT, metadata_json TEXT,
       created_at TEXT);
runs(id TEXT PRIMARY KEY, project_id TEXT, board_id TEXT, node_id TEXT,
     entity_id TEXT, action TEXT, cache_key TEXT, status TEXT,
     provider_id TEXT, model TEXT, prompt_json TEXT, params_json TEXT,
     input_asset_ids TEXT, output_asset_ids TEXT, selected_asset_id TEXT,
     cost_json TEXT, error_json TEXT, started_at TEXT, finished_at TEXT);
jobs(id TEXT PRIMARY KEY, run_id TEXT, provider_id TEXT, capability TEXT,
     remote_task_id TEXT, status TEXT, progress INT, raw_status TEXT,
     attempts INT, next_poll_at TEXT, updated_at TEXT);
usage(id TEXT PRIMARY KEY, project_id TEXT, provider_id TEXT, model TEXT,
      capability TEXT, units REAL, cost REAL, currency TEXT, created_at TEXT);
snapshots(id TEXT PRIMARY KEY, project_id TEXT, board_id TEXT, doc_json TEXT,
          label TEXT, created_at TEXT);
exports(id TEXT PRIMARY KEY, project_id TEXT, path TEXT, format TEXT,
        aspect_ratio TEXT, duration REAL, clip_count INT, created_at TEXT);
```

- 索引：`projects(name)`、`entities(project_id, type)`、`runs(project_id, node_id)`、`jobs(status)`、`assets(project_id, kind)`。
- 写入用事务；自动保存 debounce 800ms + 窗口失焦/关闭强制保存。
- 启动时检查 WAL、未完成 jobs、损坏快照。

### 14.3 资产流水线

- 生成结果下载 → 临时文件 → 计算 sha256 → 移入 CAS → 生成缩略图/代理 → 写元数据 → 事件通知 UI。
- 图片缩略图：最长边 512；视频 poster：首帧；音频波形：Rust 生成 PNG。
- 视频代理：720p/低码率，画布预览用；导出用原片。
- 回收：未被任何实体/节点/运行引用的资产进入回收站；默认保留 N 天；用户可清理。
- 导入外部文件：复制进 CAS，不引用原路径。

### 14.4 快照与恢复

- 每次重大操作/手动保存生成快照（节点图 + 实体 + 审批 + 引用，不含媒体文件）。
- 崩溃后：优先恢复最新自动保存；提供最近快照列表。
- 恢复是「恢复到新状态」，不破坏当前历史。
- 项目包导出用于异地备份。

### 14.5 迁移

- `schemaVersion`：项目、Board、实体、项目包各自版本。
- 加载时逐级迁移；迁移前自动备份。
- 节点 `typeVersion` 迁移；旧节点保留只读渲染，提示升级。
- 旧 Frameforge 项目导入：
  - characters → CharacterEntity（portrait → pack.front，bio → appearance/描述）。
  - scenes → SceneEntity；shots → ShotEntity；candidates → 资产。
  - storyboards → shot.assets.storyboard；referenceBindings → casting/边。
  - timeline/audio/subtitles → TimelineEntity。
  - 自动生成一张标准布局 Board。
  - 旧阶段 UI 不再保留；导入是唯一迁移入口。

---

## 15. 安全与合规

### 15.1 密钥

- API Key 只存 OS keychain（`keyring`），按 provider 存储。
- 前端只拿 masked 值；不在 localStorage、项目文件、日志、崩溃报告中出现。
- 项目包导出显式剔除 key/credential 字段。
- 日志中间件统一脱敏 `Authorization`、`api_key`、`token`。

### 15.2 网络与 SSRF

- Provider base URL 用户可配；校验 `http/https`。
- 默认禁止向 localhost/私网地址发请求；「本地 provider」（Ollama/ComfyUI）需要显式开启本地网络权限。
- 远端资产下载校验协议、大小上限、重定向次数；不执行远端内容。
- 签名 URL 短时效；桶权限最小化。

### 15.3 文件与路径

- 资产文件名只用哈希；导入路径做规范化与边界校验，禁止 `../`。
- 项目包解压校验条目路径、大小、类型；拒绝符号链接/设备文件。
- 导出路径由用户选择；不自动写入系统目录。

### 15.4 内容与渲染

- 文本节点按纯文本渲染；Markdown 用 sanitize，禁止内联脚本/事件属性。
- 外部链接用系统浏览器打开。
- 图片/视频只从受信路径加载；不渲染任意 HTML。
- 供应商内容审核错误原样提示，不做绕过。

### 15.5 插件与 Agent

- P0–P5 不执行第三方任意代码。
- 插件节点（P6）优先声明式（schema + HTTP + 提示词模板）；需要 JS 时放 worker/沙箱，限制文件/网络/密钥访问。
- Agent 工具最小权限；删除/批量/付费操作需确认；预算硬上限。
- MCP/localhost API 只绑定本机、token 鉴权、项目范围限制。

### 15.6 成本与滥用

- 无自动运行；运行前预估与确认。
- 并发/重试/每日上限。
- Agent 预算护栏。
- 失败任务不无限重试。

### 15.7 许可

- Toonflow/infinite-canvas 为 MIT：可参考/复用，但保留版权与许可声明。
- LibTV 为商业产品：只做功能对标，不复制其代码/资产/提示词。
- 模型输出遵循各供应商条款；工具不提供规避审核的能力。

---

## 16. 技术选型与仓库结构

### 16.1 前端

| 项 | 选型 | 理由 |
|---|---|---|
| 框架 | React 18 + TypeScript 5 + Vite 6 | 现有栈，生态成熟 |
| 画布 | `@xyflow/react`（React Flow） | 节点/端口/连线/分组/小地图开箱即用，MIT |
| 状态 | Zustand + Immer | 轻量、可测试；配合命令层 |
| 撤销 | 自建命令历史（可结合 zundo） | 需要 Agent/协作审计，不能只靠快照 |
| 样式 | Tailwind + Radix + CSS tokens | 快速构建、可访问性、统一主题 |
| 图标 | lucide-react | 现有依赖 |
| 表单 | React Hook Form + Zod | schema 校验与 Inspector |
| 测试 | Vitest + Testing Library | 领域/组件单测 |
| E2E | Playwright | 画布主链验收 |
| 3D | three.js + @react-three/fiber + drei | 导演台/previz |

### 16.2 桌面/后端

| 项 | 选型 | 说明 |
|---|---|---|
| 壳 | Tauri 2 | 现有 |
| 异步 | tokio | 任务/轮询/HTTP |
| HTTP | reqwest | 复用现有 |
| 存储 | rusqlite + WAL | 复用现有 |
| 密钥 | keyring | 复用现有 |
| 媒体 | ffmpeg/ffprobe | 复用现有 |
| 序列化 | serde/serde_json | 现有 |
| 日志 | tracing + 文件滚动 | 脱敏 |
| 测试 | cargo test + wiremock | 适配器/队列/存储 |

### 16.3 仓库结构（目标）

```text
src/
├─ app/                 应用壳、路由、全局 Provider
├─ canvas/              React Flow 画布、边、工具栏、小地图
├─ nodes/               节点注册表、各节点 renderer/inspector/compiler
├─ domain/              纯 TS 领域层
│  ├─ entities/         Project/Character/Shot/Timeline...
│  ├─ graph/            校验、调度、缓存键、命令、撤销
│  ├─ prompts/          提示词编译器、模板、变量
│  ├─ references/       引用解析、裁剪、压缩
│  ├─ providers/        能力声明、成本估算（协议在 Rust）
│  └─ templates/        画布模板
├─ features/            角色库、素材库、提示词库、审片、设置
├─ media/               预览播放器、时间线、波形
├─ director3d/          3D 导演台
├─ agent/               Agent 面板、工具、计划 diff
├─ review/              审批/评论
├─ ui/                  设计系统、通用组件、tokens
├─ services/            Tauri bridge、事件、更新
└─ stores/              Zustand stores（只存引用，不存媒体大对象）

src-tauri/
├─ src/
│  ├─ lib.rs            Tauri 装配、命令、事件
│  ├─ commands/         项目/画布/运行/资产/设置/导出
│  ├─ gateway/          provider 适配器、请求、错误映射
│  ├─ jobs/             队列、轮询、恢复
│  ├─ storage/          SQLite、迁移、项目包
│  ├─ assets/           CAS、缩略图、代理、回收
│  ├─ media/            ffmpeg/ffprobe、导出
│  ├─ credentials/      keychain
│  └─ security/         SSRF、路径、脱敏
└─ tests/

docs/superpowers/specs/   设计文档
docs/plans/               实施计划
```

### 16.4 IPC 契约

命令：

```text
project.list / project.create / project.load / project.save / project.import / project.export
board.save / board.load / board.snapshot
provider.list / provider.save / provider.test / provider.credentials.set
run.start / run.cancel / run.list
job.list / job.resume
asset.import / asset.get / asset.thumbnail / asset.proxy / asset.delete
timeline.export / timeline.probe
log.tail
```

事件：

```text
run.updated
job.updated
asset.created
asset.failed
export.progress
provider.health
```

所有 payload 带 `schemaVersion`；前端对未知事件忽略并记录，不崩溃。

### 16.5 测试策略

- **领域单测**：提示词编译、缓存键、图校验、引用解析、成本估算、迁移。
- **Rust 单测**：适配器（wiremock）、任务状态机、CAS、ffmpeg 封装、项目包往返、密钥不泄漏。
- **集成测试**：mock provider 跑通「剧本 → 角色 → 镜头 → 视频 → 导出」；缓存命中；取消；重启恢复。
- **UI E2E**：Playwright 建板、加节点、连线、运行（mock）、撤销、导出。
- **真实 API 冒烟**：文本/图片/视频各一次，限定预算；不进入 CI。
- **验收脚本**：P1 场景可重复执行，输出 md5/ffprobe 报告。

---

## 17. 路线图与验收

### 17.1 P0 — 画布地基

交付：

- 新应用壳、项目库、画布页签。
- React Flow 画布：节点、连线、分组、缩放、小地图、撤销/重做、自动保存。
- 节点注册表 + 原语节点：Text/LLM、Image、Video、Audio、Script、Note、Group。
- Inspector（schema 驱动）、运行按钮、候选展示、节点状态。
- Provider 设置：OpenAI 兼容 + MiniMax H3；Key 入 keychain；连接测试。
- 资产外链抽象：data URL + S3 兼容桶（至少打通一种到 H3 的输入传输）。
- Rust：任务队列、异步视频轮询、CAS 资产、SQLite、事件。
- 提示词基础编译与预览。
- 旧项目导入。

退出标准：

- 新建项目 → 加文本/图片/视频节点 → 运行 → 选候选 → 保存 → 重启恢复。
- 关窗/重启不丢未完成视频任务。
- 项目导出不含 Key。
- 500 节点画布可平移缩放。

### 17.2 P1 — 短剧主链

交付：

- Script 实体与拆集/拆场/拆镜。
- Character 实体、三视图生成、锁版、casting。
- Location/Prop 实体与参考注入。
- Shot 宏节点（分镜/首帧/尾帧/视频/一条龙/展开子图）。
- FramePair 节点、尾帧接首帧、抽尾帧。
- Compose 时间线、字幕、音频、MP4 导出。
- 模板：短剧标准流水线。
- 缓存/过期/pin/审批基础。
- 成本预估与确认。

退出标准（P1 验收场景）：

1. 配置文本、生图、视频各一个可用模型。
2. 用模板建板，写一段 3 镜短剧。
3. 生成 1 个角色三视图并锁版。
4. 建 3 个 Shot，casting 同一角色，生成分镜图、首帧、尾帧。
5. 用 MiniMax H3（按 P0 确定的传输方式）生成 3 段 5–15 秒视频。
6. 自动装配、加字幕/音频、导出 9:16 MP4。
7. 未改节点重跑命中缓存，成本 0。
8. 改角色描述 → 下游镜头标记 stale，不自动运行。
9. 重启应用，未完成视频任务继续并落盘。
10. 导出项目包，确认无密钥；另一台机器可导入。

### 17.3 P2 — 生产级

- 角色变体（服装/年龄/受伤）、表情、360。
- 场景圣经、风格指南、提示词库、负向约束。
- 引用解析器可视化、参考上限裁剪、智能引用。
- 片段重拍、候选对比、批量生成、批量审批。
- 技术/身份/连续性 QC。
- 分镜网格、4K 提案图、审片模式。
- 成本面板、项目预算、用量导出。
- 多画布/多集管理、生产中视图。
- 旧项目完整迁移。

退出标准：

- 同一角色跨 3 镜生成，人工评审一致性通过。
- 3 镜批量重拍只影响选中镜头。
- 分镜网格导出 4K，带镜号/时长/台词。
- 项目成本可汇总到镜头/模型。

### 17.4 P3 — 高级创作

- Director3D：场景、人偶、灯光、多机位、运镜、关键帧、previz、控制图。
- 手绘运镜、打光预设、多机位九宫格。
- 拉片/帧分析、镜头切分、ASR、视觉描述。
- 局部重绘/扩图/超分。
- 动作捕捉（视频 → 姿态 → 人偶）。
- 视频精准编辑（裁剪/延长/局部替换，按 provider 能力）。

退出标准：

- 用 3D 导演台摆一个场景，捕获首/尾帧，生成 H3 视频。
- 拉片一个 30 秒参考视频，得到镜头列表与风格摘要。
- 局部重绘一张分镜图并回填 Shot。

### 17.5 P4 — Agent / 自动化

- 制片 Agent 面板、工具集、计划 diff、预算/审批/回滚。
- 一句话短剧流水线（含检查点）。
- 参考视频复刻。
- MCP/localhost Skill API。
- Headless CLI/runner。

退出标准：

- Agent 在预算内完成 3 镜短剧，停在角色/分镜/成片检查点。
- 外部 Agent 通过 MCP 调用建板/运行/导出。
- 所有 Agent 操作可在历史中回放/撤销。

### 17.6 P5 — 团队协作 / 云

- CRDT 同步服务（axum + yrs）、Postgres、S3。
- 项目成员/权限、邀请、审片链接。
- 在线状态、光标、编辑锁、评论。
- 共享角色库/素材库、版本快照、变更对比。
- 离线编辑与重连合并。

退出标准：

- 两台客户端同时编辑同一 Board，无丢改动。
- 审片链接可只读播放并评论。
- 角色锁版后，团队成员下游引用一致。

### 17.7 P6 — 生态 / 分发

- 插件节点 SDK（声明式优先）、插件目录。
- ComfyUI 适配器。
- 模型目录/预设更新。
- 多语言/多平台/多比例交付。
- 项目模板市场（可选）。

退出标准：

- 第三方以声明式方式注册一个节点并跑通。
- ComfyUI 工作流作为图片/视频后端可调用。
- 同一时间线导出 9:16/16:9 两个版本。

---

## 18. 风险与开放决策

### 18.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| MiniMax H3 官方接口要求公网 URL | P0 联调阻塞 | 资产外链抽象；优先支持 base64/上传的中转；官方走 S3 兼容桶；P0 实测 |
| 中转/供应商协议差异、限流、稳定性 | 生成失败/成本浪费 | 适配器 + capability 矩阵 + 错误分类 + 退避 + 显式重试 |
| 角色一致性达不到影视级 | 核心体验不达标 | 锁定角色包 + 参考解析 + 候选/审批 + QC；后续 ComfyUI/LoRA |
| 成本失控 | 用户不敢用 | 默认不自动运行 + 预估 + 预算 + 确认阈值 |
| 画布性能 | 大项目卡顿 | React Flow 优化、代理、懒加载、聚焦/子图 |
| 数据丢失 | 创作损失 | WAL、自动保存、快照、项目包、恢复流程 |
| CRDT 冲突 | 团队数据错乱 | map/字段级 LWW、Y.Text、资产不可变、P5 再上 |
| 3D/动作捕捉范围膨胀 | 拖垮主线 | 只做 previz；人偶/GLB；明确不做最终渲染 |
| Agent 不可靠/乱花钱 | 信任崩塌 | 计划 diff、检查点、预算硬上限、可撤销 |
| 单人开发带宽 | 延期 | 阶段门禁、复用 OSS、P0/P1 先闭环 |
| 供应商条款/版权 | 合规风险 | 不绕过审核；输出条款提示；不复制 LibTV 资产 |

### 18.2 已定决策

- 画布：React Flow。
- 领域层：纯 TS；基础设施：Rust。
- 执行：拉取式 DAG + 显式运行 + 内容缓存。
- 数据：Board 图 + 项目实体库 + 不可变资产。
- 边：类型 + 语义角色。
- 模型：能力网关 + 适配器；首批 OpenAI 兼容 + MiniMax H3。
- 资产外链：传输抽象；优先 base64/上传中转；官方 H3 用 S3 兼容桶。
- 协作：P5 用 axum + yrs + Postgres + S3。
- 3D：three.js/R3F，previz 定位。
- 插件：声明式优先，P6。

### 18.3 P0 联调必须确认

1. 你的 OpenAI 兼容中转对图片编辑/参考图是否接受 data URL/base64。
2. 你的 MiniMax H3 入口是中转还是官方；中转是否接受 base64/文件上传，还是要求公网 URL。
3. 若要求公网 URL：选择 R2/OSS/S3/MinIO 中的哪一个作为资产桶；P0 先做 S3 兼容抽象，配置项落地。
4. 视频任务的最长等待/轮询间隔/并发上限；按中转实际限制配置。
5. 文本模型是否支持结构化 JSON 输出（拆镜需要）；不支持则用文本解析 + 校验兜底。

---

## 19. 附录

### 19.1 节点类型清单

| type | 类别 | 阶段 | 说明 |
|---|---|---|---|
| `text` | media | P0 | LLM 文本 |
| `image` | media | P0 | 图片生成/编辑 |
| `video` | media | P0 | 视频生成/抽帧 |
| `audio` | audio | P0 | TTS/音乐/音效 |
| `script` | script | P0/P1 | 剧本实体视图 |
| `note` | utility | P0 | 备注 |
| `group` | utility | P0 | 分组 |
| `compare` | utility | P2 | 候选对比 |
| `character` | character | P1 | 角色实体视图 |
| `location` | scene | P1 | 地点实体视图 |
| `prop` | scene | P2 | 道具实体视图 |
| `shot` | shot | P1 | 分镜镜头宏节点 |
| `framePair` | shot | P1 | 首/中/尾帧 |
| `compose` | compose | P1 | 成片时间线 |
| `director3d` | director | P3 | 3D 导演台 |
| `frameAnalysis` | utility | P3 | 拉片/帧分析 |
| `agent` | agent | P4 | 制片 Agent |
| `plugin` | utility | P6 | 插件节点 |

### 19.2 能力矩阵（首批）

| 能力 | OpenAI 兼容 | MiniMax H3 | 现有视频适配器 |
|---|---|---|---|
| 文本 | 是 | 否 | 否 |
| 图片生成 | 是 | 否 | 否 |
| 图片编辑 | 按中转实测 | 否 | 否 |
| TTS | 是 | 可扩展 | 否 |
| 视频文生 | 按中转实测 | 是 | 是 |
| 视频首尾帧 | 按中转实测 | 是 | 按模型实测 |
| 视频参考 | 按中转实测 | 是 | 按模型实测 |
| 异步任务 | 按中转实测 | 是 | 是 |
| 原生音频 | 按模型实测 | 是 | 按模型实测 |

### 19.3 错误码前缀

```text
AUTH_ / PERM_ / QUOTA_ / RATE_ / PARAM_ / CAP_ / MODERATION_
TIMEOUT_ / UNAVAILABLE_ / TASK_ / DOWNLOAD_ / STORAGE_ / CANCELLED_ / UNKNOWN_
```

### 19.4 术语

- **Board**：一张无限画布文档。
- **Entity**：项目级创作对象（角色/场景/镜头/剧本/时间线）。
- **Node**：实体或原语在画布上的视图/操作单元。
- **Run**：一次节点执行记录。
- **Job**：一次供应商异步任务。
- **Asset**：不可变媒体/文本文件，按哈希存储。
- **Casting**：镜头与角色的绑定关系。
- **Stale**：节点输出因上游/配置变化而需要重跑。
- **Pin**：锁定节点输出，阻断上游失效传播。
- **Capability**：统一模型能力名（text.chat/image.generate/video.generate...）。
- **Transport**：资产如何送到 provider（dataUrl/publicUrl/upload/multipart）。
- **Previz**：3D 预演，不是最终画面。

---

## 20. 设计自审记录

- 已确认无占位符/未完成项；P0 联调项以「必须确认 + 默认方案」给出。
- 架构与功能矩阵一致：所有 LibTV 能力都有对应子系统与阶段。
- 范围：全量目标保留；P0/P1 是可验收的交付切片，不是缩减目标。
- 歧义处理：Shot/Scene/Location 明确区分；首尾帧与参考图槽位分离；锁版/pin/stale 定义明确。
- 数据安全：密钥、项目包、日志、SSRF、路径、插件均有明确边界。
- 待评审后进入实施计划（writing-plans）。
