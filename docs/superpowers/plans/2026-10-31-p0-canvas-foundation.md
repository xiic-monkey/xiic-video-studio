# P0 画布地基实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Frameforge 画布优先的新工作台地基：新建项目/画布、7 类原语节点、单节点运行（文本/图片/视频/音频）、候选选择、自动保存与重启恢复、Provider 设置与密钥托管、内容寻址资产库、H3 异步视频任务恢复。

**Architecture:** React 18 + React Flow 负责画布与交互；`src/domain` 是纯 TS 图引擎（校验/命令/缓存键/stale/提示词/成本），不依赖 Tauri；Rust 负责 Provider 网关、任务队列、CAS、SQLite、keychain，并通过 Tauri 命令/事件与前端通信。P0 只做单节点运行 + 上游缓存命中；整板/下游/选区/批量运行、Shot/Character 领域节点、Compose、3D、Agent、协作均在 P1 及以后。

**Tech Stack:** Tauri 2、React 18、TypeScript 5.6 strict、Vite 6、@xyflow/react 12、zustand 5、@noble/hashes 1.5、Vitest 3、Rust（reqwest/rusqlite/sha2/hmac/keyring/ffmpeg）、wiremock。

**Spec:** `docs/superpowers/specs/2026-10-31-canvas-studio-design.md`（本计划实现第 17.1 节 P0；第 4/5/6/7/9/14/15/16 节给出契约）

## Global Constraints

- `src/domain/**` 不得 import `@tauri-apps/*`、React 运行时或浏览器专属 API；领域测试在 Node 环境运行。
- API Key 只进 macOS keychain（service `com.frameforge.studio`；account `provider/{id}`、`asset-host/access-key`、`asset-host/secret-key`）。前端只写 Key，不读回明文；项目包、日志、事件、错误消息不得包含密钥。
- 所有付费生成必须由用户显式点击运行；缓存命中写 `RunRecord` 且 `cost.estimated.amount = 0`；上游变化只标 stale，不自动运行。
- 渲染进程不得直接请求供应商 API；所有供应商请求、文件下载由 Rust 发起。
- Rust 负责所有文件写入与路径校验：拒绝 `..`、绝对路径逃逸、`file://`；远端 URL 只允许 https，拒绝 localhost 与私有网段字面量。
- 品牌 token：墨黑 `#111617`、薄荷青 `#75d8bd`、面板 `#151b1c`/`#20292a`、暖橙 `#bf7256`；品牌字体 `DM Mono`，正文系统字体。
- UI 文案中文，标识符英文。所有 IPC payload 带 `schemaVersion: 1`。
- P0 运行模式只有「单节点」：目标节点的上游必须已有成功产出，否则报错；不自动运行上游。
- 每个 Task 完成后提交一次 git commit，消息格式 `feat(p0): ...` 或 `test(p0): ...`。

---

## 阶段 A — 领域地基

### Task 1: 工具链与测试基线

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Create: `src/domain/env.test.ts`

**Interfaces:**
- Produces: `pnpm test:unit` 可运行 Vitest；后续所有领域测试用 `import { describe, it, expect, vi } from 'vitest'`。

- [ ] **Step 1: 安装依赖**

```bash
pnpm add @xyflow/react zustand @noble/hashes@1.5.0
pnpm add -D vitest@^3.2.0
```

- [ ] **Step 2: 更新 package.json 脚本**

把 `scripts` 改成：

```json
{
  "dev": "vite",
  "build": "tsc -b && vite build",
  "test": "tsc -b && vitest run && cargo test --manifest-path src-tauri/Cargo.toml",
  "test:unit": "vitest run",
  "test:unit:watch": "vitest",
  "preview": "vite preview",
  "tauri": "tauri"
}
```

- [ ] **Step 3: 把 Vitest 配置并入 Vite 配置**

`vite.config.ts` 改为：

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'es2021', sourcemap: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'], restoreMocks: true },
});
```

- [ ] **Step 4: 写环境冒烟测试**

`src/domain/env.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('runs in node with crypto available', () => {
    expect(typeof process).toBe('object');
    expect(typeof crypto.randomUUID).toBe('function');
  });
});
```

- [ ] **Step 5: 运行测试**

Run: `pnpm test:unit`
Expected: PASS，1 test passed。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml vite.config.ts src/domain/env.test.ts
git commit -m "feat(p0): 建立 vitest 测试基线与画布依赖"
```

---

### Task 2: 领域类型与哈希基元

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/ids.ts`
- Create: `src/domain/canonical.ts`
- Create: `src/domain/hash.ts`
- Test: `src/domain/canonical.test.ts`
- Test: `src/domain/ids.test.ts`

**Interfaces:**
- Produces:
  - `newId(prefix: string): string`
  - `canonicalJson(value: unknown): string`
  - `sha256Hex(input: string): string`
  - `export interface BoardDoc/BoardNode/BoardEdge/AssetRef/RunRecord/JobRecord/AppError/PromptSnapshot/PromptSegment/CostEstimate/ModelConfig/ModelCapability/PriceRule/ProviderProfile/StyleGuide`
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

`src/domain/canonical.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical';
import { sha256Hex } from './hash';

describe('canonicalJson', () => {
  it('sorts object keys and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
  });

  it('drops undefined object fields but keeps null array slots', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: [undefined, 2] })).toBe('{"b":1,"c":[null,2]}');
  });

  it('is stable for nested structures', () => {
    expect(canonicalJson({ z: [{ y: 1, x: 2 }], a: true })).toBe('{"a":true,"z":[{"x":2,"y":1}]}');
  });
});

describe('sha256Hex', () => {
  it('matches the known abc vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

`src/domain/ids.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { newId } from './ids';

describe('newId', () => {
  it('prefixes a uuid', () => {
    expect(newId('board')).toMatch(/^board_[0-9a-f-]{36}$/);
  });

  it('is unique', () => {
    expect(newId('node')).not.toBe(newId('node'));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，提示找不到 `./canonical` 与 `./ids`。

- [ ] **Step 3: 实现基元**

`src/domain/ids.ts`：

```ts
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
```

`src/domain/canonical.ts`：

```ts
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
```

`src/domain/hash.ts`：

```ts
import { sha256 } from '@noble/hashes/sha256';
import { canonicalJson } from './canonical';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(input: string): string {
  return toHex(sha256(new TextEncoder().encode(input)));
}

export function sha256Json(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
```

- [ ] **Step 4: 写类型定义**

`src/domain/types.ts`：

```ts
export type DataType =
  | 'text' | 'script' | 'beat' | 'character' | 'location' | 'prop'
  | 'image' | 'video' | 'audio' | 'frame' | 'timeline' | 'any';

export type EdgeRole =
  | 'script' | 'beat' | 'prompt' | 'character_ref' | 'location_ref'
  | 'prop_ref' | 'style_ref' | 'first_frame' | 'last_frame' | 'middle_frame'
  | 'reference_image' | 'reference_video' | 'reference_audio' | 'prev_shot'
  | 'storyboard' | 'video_clip' | 'audio' | 'timeline';

export type ApprovalStatus = 'draft' | 'review' | 'approved' | 'rejected';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobStatus = 'queued' | 'submitted' | 'polling' | 'succeeded' | 'failed' | 'cancelled';

export interface BoardDoc {
  schemaVersion: 1;
  id: string;
  projectId: string;
  name: string;
  nodes: Record<string, BoardNode>;
  edges: Record<string, BoardEdge>;
  viewport: { x: number; y: number; zoom: number };
  createdAt: string;
  updatedAt: string;
}

export interface BoardNode {
  id: string;
  type: string;
  typeVersion: number;
  entityId?: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  parentId?: string;
  z: number;
  collapsed?: boolean;
  data: Record<string, unknown>;
  ui?: { color?: string; pinned?: boolean; note?: string };
}

export interface BoardEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  role: EdgeRole;
  createdAt: string;
}

export interface AssetRef {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'text' | 'json';
  path: string;
  thumbPath?: string;
  proxyPath?: string;
  mime: string;
  width?: number;
  height?: number;
  duration?: number;
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

export interface PromptSegment {
  key: string;
  label: string;
  text: string;
}

export interface PromptSnapshot {
  text: string;
  negative?: string;
  segments: PromptSegment[];
  hash: string;
  locked: boolean;
  missingVariables?: string[];
}

export interface CostEstimate {
  amount: number;
  currency: string;
  unit: string;
  breakdown?: Record<string, number>;
}

export interface CostBreakdown {
  estimated?: CostEstimate;
  actual?: CostEstimate;
}

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  providerRaw?: string;
  details?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  projectId: string;
  boardId: string;
  nodeId: string;
  entityId?: string;
  action: string;
  cacheKey: string;
  status: RunStatus;
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

export interface JobRecord {
  id: string;
  runId: string;
  providerId: string;
  capability: string;
  remoteTaskId?: string;
  status: JobStatus;
  progress?: number;
  rawStatus?: string;
  attempts: number;
  nextPollAt?: string;
  updatedAt: string;
}

export interface StyleGuide {
  genre: string;
  visualStyle: string;
  colorLanguage: string;
  cameraLanguage: string;
  era: string;
  constraints: string;
  negative: string;
  version: number;
}

export interface PriceRule {
  unit: 'token' | 'image' | 'second' | 'character' | 'request';
  amount: number;
  currency: string;
}

export interface ModelCapability {
  capability: string;
  modes?: string[];
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
  inputTransport: Array<'dataUrl' | 'publicUrl' | 'upload' | 'multipart'>;
  async: boolean;
  concurrency?: number;
  price?: PriceRule;
}

export interface ModelConfig {
  id: string;
  displayName: string;
  capabilities: ModelCapability[];
  defaults?: Record<string, unknown>;
}

export interface ProviderProfile {
  id: string;
  name: string;
  adapter: 'openai-compatible' | 'minimax-h3' | 'bytedance-video'
    | 'grok-video' | 'gemini-video' | 'comfyui' | 'custom';
  baseUrl: string;
  auth: { type: 'bearer' | 'header'; keyRef: string };
  models: ModelConfig[];
  enabled: boolean;
  schemaVersion: 1;
}

export interface StudioProject {
  schemaVersion: 1;
  id: string;
  name: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
  styleGuide: StyleGuide;
  createdAt: string;
  updatedAt: string;
}

export function emptyStyleGuide(): StyleGuide {
  return {
    genre: '', visualStyle: '', colorLanguage: '', cameraLanguage: '',
    era: '', constraints: '', negative: '', version: 0,
  };
}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm test:unit`
Expected: PASS，5 tests passed。

- [ ] **Step 6: 提交**

```bash
git add src/domain/types.ts src/domain/ids.ts src/domain/canonical.ts src/domain/hash.ts src/domain/canonical.test.ts src/domain/ids.test.ts
git commit -m "feat(p0): 领域类型、ID 与内容哈希基元"
```

---

### Task 3: 原语节点定义与注册表

**Files:**
- Create: `src/domain/nodes/types.ts`
- Create: `src/domain/nodes/definitions.ts`
- Test: `src/domain/nodes/definitions.test.ts`

**Interfaces:**
- Consumes: `src/domain/types.ts`、`src/domain/ids.ts`。
- Produces:
  - `getNodeDefinition(type: string): NodeDefinition | undefined`
  - `listNodeDefinitions(): NodeDefinition[]`
  - `createNode(type: string, position: { x: number; y: number }, overrides?: Record<string, unknown>): BoardNode`
  - `visibleInputPorts(def: NodeDefinition, node: BoardNode): PortDef[]`
  - `edgeRoleFor(source: PortDef, target: PortDef): EdgeRole`
  - 7 个类型：`text` `image` `video` `audio` `script` `note` `group`

- [ ] **Step 1: 写失败测试**

`src/domain/nodes/definitions.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createNode, edgeRoleFor, getNodeDefinition, listNodeDefinitions, visibleInputPorts } from './definitions';

describe('node definitions', () => {
  it('registers the seven P0 primitive nodes', () => {
    expect(listNodeDefinitions().map((def) => def.type).sort())
      .toEqual(['audio', 'group', 'image', 'note', 'script', 'text', 'video']);
  });

  it('creates a video node with H3-safe defaults', () => {
    const node = createNode('video', { x: 10, y: 20 });
    expect(node.id).toMatch(/^node_/);
    expect(node.typeVersion).toBe(1);
    expect(node.data).toMatchObject({ mode: 't2v', duration: 6, resolution: '768P', aspectRatio: '9:16' });
  });

  it('hides frame ports in reference mode and hides reference ports in firstLast mode', () => {
    const def = getNodeDefinition('video')!;
    const base = createNode('video', { x: 0, y: 0 });
    const firstLast = visibleInputPorts(def, { ...base, data: { ...base.data, mode: 'firstLast' } });
    const reference = visibleInputPorts(def, { ...base, data: { ...base.data, mode: 'reference' } });
    expect(firstLast.map((port) => port.key)).toEqual(['prompt', 'start', 'end']);
    expect(reference.map((port) => port.key)).toEqual(['prompt', 'references', 'referenceVideo', 'referenceAudio']);
  });

  it('derives edge roles from the target port first', () => {
    const def = getNodeDefinition('video')!;
    const start = def.inputs.find((port) => port.key === 'start')!;
    const prompt = def.inputs.find((port) => port.key === 'prompt')!;
    const imageOut = getNodeDefinition('image')!.outputs[0];
    const textOut = getNodeDefinition('text')!.outputs[0];
    expect(edgeRoleFor(imageOut, start)).toBe('first_frame');
    expect(edgeRoleFor(textOut, prompt)).toBe('prompt');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./definitions`。

- [ ] **Step 3: 写节点类型**

`src/domain/nodes/types.ts`：

```ts
import type { BoardNode, DataType, EdgeRole, ProviderProfile, StyleGuide } from '../types';

export interface PortDef {
  key: string;
  label: string;
  dataType: DataType;
  role?: EdgeRole;
  multi?: boolean;
  required?: boolean;
}

export interface Issue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  portKey?: string;
}

export interface NodeContext {
  styleGuide?: StyleGuide;
  providers: ProviderProfile[];
}

export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'toggle';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  help?: string;
}

export interface NodeAction {
  key: string;
  label: string;
  capability?: string;
}

export interface NodeDefinition<TData extends object = Record<string, unknown>> {
  type: string;
  typeVersion: number;
  title: string;
  category: 'script' | 'character' | 'scene' | 'shot' | 'media' | 'audio' | 'compose' | 'director' | 'agent' | 'utility';
  inputs: PortDef[];
  outputs: PortDef[];
  fields: FieldDef[];
  createDefaults(): TData;
  validate(node: BoardNode, ctx: NodeContext): Issue[];
  actions: NodeAction[];
}

export interface TextNodeData {
  prompt: string;
  system: string;
  mode: 'generate' | 'rewrite';
  providerId?: string;
  model?: string;
}

export interface ImageNodeData {
  prompt: string;
  negative: string;
  size: string;
  count: number;
  providerId?: string;
  model?: string;
}

export interface VideoNodeData {
  prompt: string;
  negative: string;
  mode: 't2v' | 'firstLast' | 'reference';
  duration: number;
  resolution: '768P' | '2K';
  aspectRatio: string;
  generateAudio: boolean;
  providerId?: string;
  model?: string;
}

export interface AudioNodeData {
  text: string;
  voice: string;
  format: 'mp3' | 'wav';
  providerId?: string;
  model?: string;
}

export interface ScriptNodeData {
  title: string;
  body: string;
}

export interface NoteNodeData {
  text: string;
  color: string;
}

export interface GroupNodeData {
  label: string;
  collapsed: boolean;
}
```

- [ ] **Step 4: 写节点定义**

`src/domain/nodes/definitions.ts`：

```ts
import { newId } from '../ids';
import type { BoardNode, EdgeRole, ProviderProfile } from '../types';
import type {
  AudioNodeData, GroupNodeData, ImageNodeData, Issue, NodeContext, NodeDefinition,
  NoteNodeData, PortDef, ScriptNodeData, TextNodeData, VideoNodeData,
} from './types';

const DEFAULT_ROLE: Record<string, EdgeRole> = {
  text: 'prompt', script: 'script', beat: 'beat', character: 'character_ref',
  location: 'location_ref', prop: 'prop_ref', image: 'reference_image',
  video: 'reference_video', audio: 'audio', frame: 'reference_image',
  timeline: 'timeline', any: 'reference_image',
};

const missing = (code: string, message: string): Issue => ({ code, message, severity: 'error' });

function textNode(): NodeDefinition<TextNodeData> {
  return {
    type: 'text', typeVersion: 1, title: '文本 / LLM', category: 'media',
    inputs: [
      { key: 'system', label: '系统提示', dataType: 'text' },
      { key: 'context', label: '上下文', dataType: 'text', multi: true },
    ],
    outputs: [{ key: 'text', label: '文本', dataType: 'text', role: 'prompt' }],
    fields: [
      { key: 'system', label: '系统提示', type: 'textarea', placeholder: '可留空' },
      { key: 'prompt', label: '提示词', type: 'textarea', placeholder: '输入要生成或改写的文本' },
      { key: 'mode', label: '模式', type: 'select', options: [{ label: '生成', value: 'generate' }, { label: '改写', value: 'rewrite' }] },
    ],
    createDefaults: () => ({ prompt: '', system: '', mode: 'generate', providerId: '', model: '' }),
    validate: (node) => (String(node.data.prompt ?? '').trim() ? [] : [missing('PARAM_PROMPT_REQUIRED', '请填写文本提示词')]),
    actions: [{ key: 'generate', label: '生成文本', capability: 'text.chat' }],
  };
}

function imageNode(): NodeDefinition<ImageNodeData> {
  return {
    type: 'image', typeVersion: 1, title: '图片', category: 'media',
    inputs: [
      { key: 'prompt', label: '提示词', dataType: 'text', role: 'prompt' },
      { key: 'references', label: '参考图', dataType: 'image', role: 'reference_image', multi: true },
      { key: 'style', label: '风格参考', dataType: 'image', role: 'style_ref' },
    ],
    outputs: [{ key: 'image', label: '图片', dataType: 'image' }],
    fields: [
      { key: 'prompt', label: '提示词', type: 'textarea' },
      { key: 'negative', label: '负向提示', type: 'textarea' },
      { key: 'size', label: '尺寸', type: 'select', options: [
        { label: '1024×1024', value: '1024x1024' }, { label: '1024×1536（竖）', value: '1024x1536' },
        { label: '1536×1024（横）', value: '1536x1024' },
      ] },
      { key: 'count', label: '候选数', type: 'number', min: 1, max: 4, step: 1 },
    ],
    createDefaults: () => ({ prompt: '', negative: '', size: '1024x1536', count: 2 }),
    validate: (node) => {
      const issues: Issue[] = [];
      const count = Number(node.data.count ?? 1);
      if (count < 1 || count > 4) issues.push(missing('PARAM_COUNT_RANGE', '候选数需在 1–4 之间'));
      return issues;
    },
    actions: [{ key: 'generate', label: '生成图片', capability: 'image.generate' }],
  };
}

function videoNode(): NodeDefinition<VideoNodeData> {
  return {
    type: 'video', typeVersion: 1, title: '视频', category: 'media',
    inputs: [
      { key: 'prompt', label: '提示词', dataType: 'text', role: 'prompt' },
      { key: 'start', label: '首帧', dataType: 'frame', role: 'first_frame' },
      { key: 'end', label: '尾帧', dataType: 'frame', role: 'last_frame' },
      { key: 'references', label: '参考图', dataType: 'image', role: 'reference_image', multi: true },
      { key: 'referenceVideo', label: '参考视频', dataType: 'video', role: 'reference_video' },
      { key: 'referenceAudio', label: '参考音频', dataType: 'audio', role: 'reference_audio' },
    ],
    outputs: [{ key: 'video', label: '视频', dataType: 'video' }],
    fields: [
      { key: 'prompt', label: '提示词', type: 'textarea' },
      { key: 'negative', label: '负向约束', type: 'textarea' },
      { key: 'mode', label: '模式', type: 'select', options: [
        { label: '文生视频', value: 't2v' }, { label: '首尾帧', value: 'firstLast' },
        { label: '全能参考', value: 'reference' },
      ] },
      { key: 'duration', label: '时长（秒）', type: 'number', min: 5, max: 15, step: 1 },
      { key: 'resolution', label: '分辨率', type: 'select', options: [
        { label: '768P', value: '768P' }, { label: '2K', value: '2K' },
      ] },
      { key: 'aspectRatio', label: '比例', type: 'select', options: [
        { label: '9:16', value: '9:16' }, { label: '16:9', value: '16:9' }, { label: '1:1', value: '1:1' },
        { label: '4:3', value: '4:3' }, { label: '3:4', value: '3:4' }, { label: '21:9', value: '21:9' },
        { label: '自适应', value: 'adaptive' },
      ] },
      { key: 'generateAudio', label: '生成原生音频', type: 'toggle' },
    ],
    createDefaults: () => ({
      prompt: '', negative: '', mode: 't2v', duration: 6, resolution: '768P',
      aspectRatio: '9:16', generateAudio: true,
    }),
    validate: (node) => {
      const issues: Issue[] = [];
      const duration = Number(node.data.duration ?? 0);
      if (!Number.isInteger(duration) || duration < 5 || duration > 15) {
        issues.push(missing('PARAM_DURATION_RANGE', 'H3 时长需为 5–15 的整数秒'));
      }
      return issues;
    },
    actions: [{ key: 'generate', label: '生成视频', capability: 'video.generate' }],
  };
}

function audioNode(): NodeDefinition<AudioNodeData> {
  return {
    type: 'audio', typeVersion: 1, title: '音频 / TTS', category: 'audio',
    inputs: [
      { key: 'text', label: '文本', dataType: 'text', role: 'prompt' },
      { key: 'referenceAudio', label: '参考音频', dataType: 'audio', role: 'reference_audio' },
    ],
    outputs: [{ key: 'audio', label: '音频', dataType: 'audio' }],
    fields: [
      { key: 'text', label: '台词', type: 'textarea' },
      { key: 'voice', label: '音色', type: 'text', placeholder: 'alloy / 中文女声…' },
      { key: 'format', label: '格式', type: 'select', options: [
        { label: 'MP3', value: 'mp3' }, { label: 'WAV', value: 'wav' },
      ] },
    ],
    createDefaults: () => ({ text: '', voice: 'alloy', format: 'mp3' }),
    validate: () => [],
    actions: [{ key: 'generate', label: '生成语音', capability: 'audio.tts' }],
  };
}

function scriptNode(): NodeDefinition<ScriptNodeData> {
  return {
    type: 'script', typeVersion: 1, title: '剧本', category: 'script',
    inputs: [
      { key: 'idea', label: '灵感', dataType: 'text', role: 'prompt' },
      { key: 'reference', label: '参考', dataType: 'text', role: 'prompt', multi: true },
    ],
    outputs: [
      { key: 'script', label: '剧本', dataType: 'script', role: 'script' },
      { key: 'beats', label: '节拍', dataType: 'beat', role: 'beat' },
    ],
    fields: [
      { key: 'title', label: '标题', type: 'text' },
      { key: 'body', label: '正文', type: 'textarea' },
    ],
    createDefaults: () => ({ title: '', body: '' }),
    validate: () => [],
    actions: [],
  };
}

function noteNode(): NodeDefinition<NoteNodeData> {
  return {
    type: 'note', typeVersion: 1, title: '备注', category: 'utility',
    inputs: [], outputs: [],
    fields: [
      { key: 'text', label: '内容', type: 'textarea' },
      { key: 'color', label: '颜色', type: 'select', options: [
        { label: '默认', value: 'default' }, { label: '薄荷', value: 'mint' }, { label: '暖橙', value: 'warm' },
      ] },
    ],
    createDefaults: () => ({ text: '', color: 'default' }),
    validate: () => [],
    actions: [],
  };
}

function groupNode(): NodeDefinition<GroupNodeData> {
  return {
    type: 'group', typeVersion: 1, title: '分组', category: 'utility',
    inputs: [], outputs: [],
    fields: [
      { key: 'label', label: '名称', type: 'text' },
      { key: 'collapsed', label: '折叠', type: 'toggle' },
    ],
    createDefaults: () => ({ label: '分组', collapsed: false }),
    validate: () => [],
    actions: [],
  };
}

const registry = new Map<string, NodeDefinition<any>>([
  ['text', textNode()],
  ['image', imageNode()],
  ['video', videoNode()],
  ['audio', audioNode()],
  ['script', scriptNode()],
  ['note', noteNode()],
  ['group', groupNode()],
]);

export function getNodeDefinition(type: string): NodeDefinition<any> | undefined {
  return registry.get(type);
}

export function listNodeDefinitions(): NodeDefinition<any>[] {
  return [...registry.values()];
}

export function createNode(
  type: string,
  position: { x: number; y: number },
  overrides: Record<string, unknown> = {},
): BoardNode {
  const def = getNodeDefinition(type);
  if (!def) throw new Error(`Unknown node type: ${type}`);
  return {
    id: newId('node'),
    type,
    typeVersion: def.typeVersion,
    position,
    z: 0,
    data: { ...(def.createDefaults() as Record<string, unknown>), ...overrides },
  };
}

export function visibleInputPorts(def: NodeDefinition<any>, node: BoardNode): PortDef[] {
  if (def.type !== 'video') return def.inputs;
  const mode = (node.data as VideoNodeData).mode;
  if (mode === 'firstLast') {
    return def.inputs.filter((port) => !['references', 'referenceVideo', 'referenceAudio'].includes(port.key));
  }
  if (mode === 'reference') {
    return def.inputs.filter((port) => !['start', 'end'].includes(port.key));
  }
  return def.inputs.filter((port) => !['start', 'end', 'referenceVideo', 'referenceAudio'].includes(port.key));
}

export function edgeRoleFor(source: PortDef, target: PortDef): EdgeRole {
  return target.role ?? source.role ?? DEFAULT_ROLE[source.dataType] ?? 'reference_image';
}

export function providerSupports(profile: ProviderProfile, capability: string): boolean {
  return profile.enabled && profile.models.some((model) =>
    model.capabilities.some((item) => item.capability === capability));
}

export function capabilityFor(profile: ProviderProfile, modelId: string, capability: string) {
  return profile.models.find((model) => model.id === modelId)
    ?.capabilities.find((item) => item.capability === capability);
}

export type { NodeContext };
```

- [ ] **Step 5: 运行测试**

Run: `pnpm test:unit`
Expected: PASS，9 tests passed。

- [ ] **Step 6: 提交**

```bash
git add src/domain/nodes
git commit -m "feat(p0): 原语节点定义与能力感知端口"
```

---

## 阶段 B — 图引擎

### Task 4: 拓扑排序与图校验

**Files:**
- Create: `src/domain/graph/topo.ts`
- Create: `src/domain/graph/validate.ts`
- Test: `src/domain/graph/validate.test.ts`
- Test: `src/domain/graph/topo.test.ts`

**Interfaces:**
- Consumes: `getNodeDefinition`、`visibleInputPorts`、`NodeContext`、`BoardDoc`。
- Produces:
  - `topoSort(doc: BoardDoc): { order: string[]; cycle: string[] }`
  - `validateBoard(doc: BoardDoc, ctx: NodeContext): Issue[]`
  - `nodeIssues(doc, nodeId, ctx): Issue[]`

- [ ] **Step 1: 写失败测试**

`src/domain/graph/topo.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node } from './testFixtures';
import { topoSort } from './topo';

describe('topoSort', () => {
  it('orders upstream before downstream', () => {
    const doc = makeDoc(
      [node('a', 'text'), node('b', 'image'), node('c', 'video')],
      [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')],
    );
    expect(topoSort(doc).order).toEqual(['a', 'b', 'c']);
    expect(topoSort(doc).cycle).toEqual([]);
  });

  it('reports cycles', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'text')], [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')]);
    const result = topoSort(doc);
    expect(result.cycle.sort()).toEqual(['a', 'b']);
  });
});
```

`src/domain/graph/validate.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { emptyStyleGuide } from '../types';
import { validateBoard } from './validate';
import { edge, makeDoc, node, videoNode } from './testFixtures';

const ctx = { providers: [], styleGuide: emptyStyleGuide() };

describe('validateBoard', () => {
  it('reports type mismatches', () => {
    const doc = makeDoc([node('text1', 'text'), node('img', 'image')], [
      edge('e1', 'text1', 'img', 'text', 'references', 'reference_image'),
    ]);
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('GRAPH_TYPE_MISMATCH');
  });

  it('reports duplicate single-input edges', () => {
    const doc = makeDoc(
      [node('t1', 'text'), node('t2', 'text'), node('img', 'image')],
      [
        edge('e1', 't1', 'img', 'text', 'prompt', 'prompt'),
        edge('e2', 't2', 'img', 'text', 'prompt', 'prompt'),
      ],
    );
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('GRAPH_SINGLE_INPUT');
  });

  it('rejects mixing frame and reference modes', () => {
    const doc = makeDoc(
      [node('img1', 'image', { prompt: 'frame' }), node('img2', 'image', { prompt: 'ref' }), videoNode('vid', { mode: 'firstLast', prompt: 'go' })],
      [
        edge('e1', 'img1', 'vid', 'image', 'start', 'first_frame'),
        edge('e2', 'img2', 'vid', 'image', 'references', 'reference_image'),
      ],
    );
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('VIDEO_MODE_CONFLICT');
  });

  it('requires a frame in firstLast mode', () => {
    const doc = makeDoc([videoNode('vid', { mode: 'firstLast', prompt: 'go' })], []);
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('PARAM_FRAME_REQUIRED');
  });

  it('reports cycles', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'text')], [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')]);
    expect(validateBoard(doc, ctx).map((issue) => issue.code)).toContain('GRAPH_CYCLE');
  });
});
```

`src/domain/graph/testFixtures.ts`：

```ts
import { createNode } from '../nodes/definitions';
import type { BoardDoc, BoardEdge, BoardNode, EdgeRole } from '../types';

export function makeDoc(nodes: BoardNode[], edges: BoardEdge[]): BoardDoc {
  return {
    schemaVersion: 1, id: 'board_test', projectId: 'project_test', name: '测试画布',
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    edges: Object.fromEntries(edges.map((item) => [item.id, item])),
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
  };
}

export function node(id: string, type: string, data: Record<string, unknown> = {}): BoardNode {
  return { ...createNode(type, { x: 0, y: 0 }, data), id };
}

export function videoNode(id: string, data: Record<string, unknown> = {}): BoardNode {
  return node(id, 'video', { prompt: '默认提示', ...data });
}

export function edge(
  id: string, source: string, target: string,
  sourcePort = 'text', targetPort = 'prompt',
  role: EdgeRole = 'prompt',
): BoardEdge {
  return { id, source, sourcePort, target, targetPort, role, createdAt: '2026-10-31T00:00:00.000Z' };
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./topo` 与 `./validate`。

- [ ] **Step 3: 实现拓扑排序**

`src/domain/graph/topo.ts`：

```ts
import type { BoardDoc } from '../types';

export function topoSort(doc: BoardDoc): { order: string[]; cycle: string[] } {
  const ids = Object.keys(doc.nodes);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  for (const item of Object.values(doc.edges)) {
    if (!doc.nodes[item.source] || !doc.nodes[item.target]) continue;
    outgoing.get(item.source)!.push(item.target);
    indegree.set(item.target, (indegree.get(item.target) ?? 0) + 1);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const cycle = ids.filter((id) => !order.includes(id));
  return { order: cycle.length ? [] : order, cycle };
}
```

- [ ] **Step 4: 实现图校验**

`src/domain/graph/validate.ts`：

```ts
import { getNodeDefinition, visibleInputPorts } from '../nodes/definitions';
import type { Issue, NodeContext } from '../nodes/types';
import type { BoardDoc, BoardEdge, BoardNode, DataType } from '../types';
import { topoSort } from './topo';

const IMAGE_LIKE = new Set<DataType>(['image', 'frame']);

function compatible(source: DataType, target: DataType): boolean {
  if (source === 'any' || target === 'any' || source === target) return true;
  return IMAGE_LIKE.has(source) && IMAGE_LIKE.has(target);
}

export function validateBoard(doc: BoardDoc, ctx: NodeContext): Issue[] {
  const issues: Issue[] = [];
  for (const node of Object.values(doc.nodes)) {
    const def = getNodeDefinition(node.type);
    if (!def) {
      issues.push({ code: 'GRAPH_UNKNOWN_NODE', message: `未知节点类型 ${node.type}`, severity: 'error', nodeId: node.id });
      continue;
    }
    issues.push(...def.validate(node, ctx));
  }

  for (const item of Object.values(doc.edges)) {
    issues.push(...validateEdge(doc, item));
  }

  for (const node of Object.values(doc.nodes)) {
    issues.push(...validateRequiredInputs(doc, node));
    issues.push(...validateVideoMode(doc, node));
  }

  const { cycle } = topoSort(doc);
  if (cycle.length) {
    issues.push({ code: 'GRAPH_CYCLE', message: '画布存在环，P0 只允许 DAG', severity: 'error', nodeId: cycle[0] });
  }
  return issues;
}

function validateEdge(doc: BoardDoc, item: BoardEdge): Issue[] {
  const issues: Issue[] = [];
  const source = doc.nodes[item.source];
  const target = doc.nodes[item.target];
  if (!source || !target) {
    issues.push({ code: 'GRAPH_BROKEN_EDGE', message: '连线的一端已被删除，请重新连接', severity: 'warning' });
    return issues;
  }
  const sourceDef = getNodeDefinition(source.type);
  const targetDef = getNodeDefinition(target.type);
  const sourcePort = sourceDef?.outputs.find((port) => port.key === item.sourcePort);
  const targetPort = targetDef?.inputs.find((port) => port.key === item.targetPort);
  if (!sourcePort || !targetPort) {
    issues.push({ code: 'GRAPH_UNKNOWN_PORT', message: '连线端口不存在', severity: 'error', nodeId: target.id });
    return issues;
  }
  if (!compatible(sourcePort.dataType, targetPort.dataType)) {
    issues.push({ code: 'GRAPH_TYPE_MISMATCH', message: `${sourcePort.label} 不能连接到 ${targetPort.label}`, severity: 'error', nodeId: target.id, portKey: targetPort.key });
  }
  if (targetPort.role && item.role !== targetPort.role) {
    issues.push({ code: 'GRAPH_ROLE_MISMATCH', message: `连线角色应为 ${targetPort.role}`, severity: 'error', nodeId: target.id, portKey: targetPort.key });
  }
  if (!targetPort.multi) {
    const count = Object.values(doc.edges).filter((other) => other.target === item.target && other.targetPort === item.targetPort).length;
    if (count > 1) {
      issues.push({ code: 'GRAPH_SINGLE_INPUT', message: `${targetPort.label} 只能连接一个来源`, severity: 'error', nodeId: target.id, portKey: targetPort.key });
    }
  }
  return issues;
}

function validateRequiredInputs(doc: BoardDoc, node: BoardNode): Issue[] {
  const def = getNodeDefinition(node.type);
  if (!def) return [];
  const inbound = Object.values(doc.edges).filter((item) => item.target === node.id);
  const issues: Issue[] = [];
  for (const port of visibleInputPorts(def, node)) {
    if (port.required && !inbound.some((item) => item.targetPort === port.key)) {
      issues.push({ code: 'GRAPH_REQUIRED_INPUT', message: `${port.label} 未连接`, severity: 'error', nodeId: node.id, portKey: port.key });
    }
  }
  return issues;
}

function validateVideoMode(doc: BoardDoc, node: BoardNode): Issue[] {
  if (node.type !== 'video') return [];
  const inbound = Object.values(doc.edges).filter((item) => item.target === node.id);
  const hasFrame = inbound.some((item) => item.targetPort === 'start' || item.targetPort === 'end');
  const hasReference = inbound.some((item) => ['references', 'referenceVideo', 'referenceAudio'].includes(item.targetPort));
  const mode = String(node.data.mode ?? 't2v');
  const issues: Issue[] = [];
  if (mode === 'firstLast' && hasReference) {
    issues.push({ code: 'VIDEO_MODE_CONFLICT', message: '首尾帧模式与全能参考模式互斥，请断开参考连线或切换模式', severity: 'error', nodeId: node.id });
  }
  if (mode === 'reference' && hasFrame) {
    issues.push({ code: 'VIDEO_MODE_CONFLICT', message: '全能参考模式不能使用首/尾帧端口', severity: 'error', nodeId: node.id });
  }
  if (mode === 't2v' && (hasFrame || hasReference)) {
    issues.push({ code: 'VIDEO_MODE_CONFLICT', message: '文生视频模式不接受首尾帧或参考素材', severity: 'error', nodeId: node.id });
  }
  if (mode === 'firstLast' && !hasFrame) {
    issues.push({ code: 'PARAM_FRAME_REQUIRED', message: '首尾帧模式至少需要首帧或尾帧', severity: 'error', nodeId: node.id });
  }
  if (mode === 'reference' && !hasReference) {
    issues.push({ code: 'PARAM_REFERENCE_REQUIRED', message: '全能参考模式至少需要一张参考素材', severity: 'error', nodeId: node.id });
  }
  return issues;
}

export function nodeIssues(doc: BoardDoc, nodeId: string, ctx: NodeContext): Issue[] {
  return validateBoard(doc, ctx).filter((issue) => issue.nodeId === nodeId);
}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm test:unit`
Expected: PASS，全部通过。

- [ ] **Step 6: 提交**

```bash
git add src/domain/graph
git commit -m "feat(p0): DAG 拓扑排序与结构化图校验"
```

---

### Task 5: 图命令与撤销基础

**Files:**
- Create: `src/domain/graph/commands.ts`
- Test: `src/domain/graph/commands.test.ts`

**Interfaces:**
- Consumes: `BoardDoc`、`BoardNode`、`BoardEdge`、`newId`。
- Produces:
  - `type GraphCommand`
  - `applyGraphCommand(doc: BoardDoc, command: GraphCommand): BoardDoc`
  - `addNodeCommand(node)` / `connectCommand(edge)` 便捷构造器

- [ ] **Step 1: 写失败测试**

`src/domain/graph/commands.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { makeDoc, node, edge } from './testFixtures';
import { applyGraphCommand } from './commands';

describe('applyGraphCommand', () => {
  it('adds a node immutably', () => {
    const doc = makeDoc([], []);
    const next = applyGraphCommand(doc, { type: 'addNode', node: node('a', 'text', { prompt: 'hi' }) });
    expect(next.nodes.a).toBeDefined();
    expect(doc.nodes.a).toBeUndefined();
    expect(next.updatedAt).not.toBe(doc.updatedAt);
  });

  it('keeps incident edges when a node is removed', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const next = applyGraphCommand(doc, { type: 'removeNode', nodeId: 'a' });
    expect(next.nodes.a).toBeUndefined();
    expect(next.edges.e1).toBeDefined();
  });

  it('promotes children when a group is removed', () => {
    const doc = makeDoc([node('a', 'note')], []);
    const grouped = applyGraphCommand(doc, { type: 'group', groupId: 'g1', childIds: ['a'], label: '组' });
    const next = applyGraphCommand(grouped, { type: 'removeNode', nodeId: 'g1' });
    expect(next.nodes.a.parentId).toBeUndefined();
    expect(next.nodes.a.position).toEqual({ x: 0, y: 0 });
  });

  it('groups and ungroups nodes while preserving absolute positions', () => {
    const doc = makeDoc([
      { ...node('a', 'note'), position: { x: 100, y: 100 } },
      { ...node('b', 'note'), position: { x: 300, y: 200 } },
    ], []);
    const grouped = applyGraphCommand(doc, { type: 'group', groupId: 'g1', childIds: ['a', 'b'], label: '镜头组' });
    expect(grouped.nodes.a.parentId).toBe('g1');
    expect(grouped.nodes.a.position).toEqual({ x: 24, y: 64 });
    expect(grouped.nodes.g1.position).toEqual({ x: 76, y: 36 });
    const ungrouped = applyGraphCommand(grouped, { type: 'ungroup', groupId: 'g1' });
    expect(ungrouped.nodes.a.position).toEqual({ x: 100, y: 100 });
    expect(ungrouped.nodes.a.parentId).toBeUndefined();
    expect(ungrouped.nodes.g1).toBeUndefined();
  });

  it('patches node data and ui without replacing the node', () => {
    const doc = makeDoc([node('a', 'image', { prompt: 'old' })], []);
    const next = applyGraphCommand(doc, { type: 'setNodeData', nodeId: 'a', patch: { prompt: 'new' } });
    expect(next.nodes.a.data.prompt).toBe('new');
    expect(next.nodes.a.id).toBe('a');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./commands`。

- [ ] **Step 3: 实现命令**

`src/domain/graph/commands.ts`：

```ts
import { newId } from '../ids';
import type { BoardDoc, BoardEdge, BoardNode } from '../types';

export type GraphCommand =
  | { type: 'addNode'; node: BoardNode }
  | { type: 'addNodes'; nodes: BoardNode[] }
  | { type: 'removeNode'; nodeId: string }
  | { type: 'moveNode'; nodeId: string; position: { x: number; y: number } }
  | { type: 'resizeNode'; nodeId: string; size: { width: number; height: number } }
  | { type: 'setNodeData'; nodeId: string; patch: Record<string, unknown> }
  | { type: 'setNodeUi'; nodeId: string; patch: NonNullable<BoardNode['ui']> }
  | { type: 'connect'; edge: BoardEdge }
  | { type: 'connectMany'; edges: BoardEdge[] }
  | { type: 'disconnect'; edgeId: string }
  | { type: 'setViewport'; viewport: BoardDoc['viewport'] }
  | { type: 'group'; groupId: string; childIds: string[]; label: string }
  | { type: 'ungroup'; groupId: string };

function stamp(doc: BoardDoc): BoardDoc {
  return { ...doc, updatedAt: new Date().toISOString() };
}

export function applyGraphCommand(doc: BoardDoc, command: GraphCommand): BoardDoc {
  switch (command.type) {
    case 'addNode':
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.node.id]: command.node } });
    case 'addNodes': {
      const nodes = { ...doc.nodes };
      for (const node of command.nodes) nodes[node.id] = node;
      return stamp({ ...doc, nodes });
    }
    case 'removeNode': {
      const nodes = { ...doc.nodes };
      const removed = nodes[command.nodeId];
      delete nodes[command.nodeId];
      if (removed) {
        for (const child of Object.values(nodes)) {
          if (child.parentId !== command.nodeId) continue;
          nodes[child.id] = {
            ...child,
            parentId: undefined,
            position: { x: child.position.x + removed.position.x, y: child.position.y + removed.position.y },
          };
        }
      }
      return stamp({ ...doc, nodes });
    }
    case 'moveNode': {
      const node = doc.nodes[command.nodeId];
      if (!node) return doc;
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.nodeId]: { ...node, position: command.position } } });
    }
    case 'resizeNode': {
      const node = doc.nodes[command.nodeId];
      if (!node) return doc;
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.nodeId]: { ...node, size: command.size } } });
    }
    case 'setNodeData': {
      const node = doc.nodes[command.nodeId];
      if (!node) return doc;
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.nodeId]: { ...node, data: { ...node.data, ...command.patch } } } });
    }
    case 'setNodeUi': {
      const node = doc.nodes[command.nodeId];
      if (!node) return doc;
      return stamp({ ...doc, nodes: { ...doc.nodes, [command.nodeId]: { ...node, ui: { ...node.ui, ...command.patch } } } });
    }
    case 'connect':
      return stamp({ ...doc, edges: { ...doc.edges, [command.edge.id]: command.edge } });
    case 'connectMany': {
      const edges = { ...doc.edges };
      for (const edge of command.edges) edges[edge.id] = edge;
      return stamp({ ...doc, edges });
    }
    case 'disconnect': {
      const edges = { ...doc.edges };
      delete edges[command.edgeId];
      return stamp({ ...doc, edges });
    }
    case 'setViewport':
      return stamp({ ...doc, viewport: command.viewport });
    case 'group': {
      const children = command.childIds.map((id) => doc.nodes[id]).filter(Boolean);
      if (!children.length) return doc;
      const minX = Math.min(...children.map((child) => child.position.x)) - 24;
      const minY = Math.min(...children.map((child) => child.position.y)) - 64;
      const maxX = Math.max(...children.map((child) => child.position.x + (child.size?.width ?? 300)));
      const maxY = Math.max(...children.map((child) => child.position.y + (child.size?.height ?? 220)));
      const group: BoardNode = {
        id: command.groupId, type: 'group', typeVersion: 1,
        position: { x: minX, y: minY },
        size: { width: maxX - minX + 24, height: maxY - minY + 24 },
        z: Math.min(...children.map((child) => child.z)) - 1,
        data: { label: command.label, collapsed: false },
      };
      const nodes = { ...doc.nodes, [command.groupId]: group };
      for (const child of children) {
        nodes[child.id] = {
          ...child,
          parentId: command.groupId,
          position: { x: child.position.x - minX, y: child.position.y - minY },
        };
      }
      return stamp({ ...doc, nodes });
    }
    case 'ungroup': {
      const group = doc.nodes[command.groupId];
      if (!group) return doc;
      const nodes = { ...doc.nodes };
      delete nodes[command.groupId];
      for (const child of Object.values(nodes)) {
        if (child.parentId !== command.groupId) continue;
        nodes[child.id] = {
          ...child,
          parentId: undefined,
          position: { x: child.position.x + group.position.x, y: child.position.y + group.position.y },
        };
      }
      return stamp({ ...doc, nodes });
    }
  }
}

export function addNodeCommand(node: BoardNode): GraphCommand {
  return { type: 'addNode', node };
}

export function connectCommand(edge: BoardEdge): GraphCommand {
  return { type: 'connect', edge };
}

export function makeEdge(source: string, sourcePort: string, target: string, targetPort: string, role: BoardEdge['role']): BoardEdge {
  return { id: newId('edge'), source, sourcePort, target, targetPort, role, createdAt: new Date().toISOString() };
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm test:unit`
Expected: PASS。注意：测试里 `updatedAt` 可能在同一毫秒与 `createdAt` 相同，`not.toBe` 可能误报。若失败，把 `makeDoc` 的 `updatedAt` 固定为 `'2026-10-30T00:00:00.000Z'`，确保命令后时间不同。

- [ ] **Step 5: 提交**

```bash
git add src/domain/graph/commands.ts src/domain/graph/commands.test.ts
git commit -m "feat(p0): 图命令与位置保持的分组/解组"
```

---

### Task 6: 缓存键与 stale 传播

**Files:**
- Create: `src/domain/graph/cacheKey.ts`
- Create: `src/domain/graph/stale.ts`
- Test: `src/domain/graph/cacheKey.test.ts`
- Test: `src/domain/graph/stale.test.ts`

**Interfaces:**
- Consumes: `sha256Json`、`topoSort`、`BoardDoc`、`RunRecord`。
- Produces:
  - `interface NodeRuntimeConfig { providerId?: string; model?: string; params: Record<string, unknown> }`
  - `interface CacheContext { styleGuide?: StyleGuide; runs: RunRecord[]; runtime: Record<string, NodeRuntimeConfig>; promptHashes: Record<string, string>; referenceResolverVersion?: number }`
  - `computeCacheKey(doc, nodeId, ctx): string`
  - `latestRun(runs, nodeId): RunRecord | undefined`
  - `latestSucceededRun(runs, nodeId): RunRecord | undefined`
  - `selectedAssetOf(run): string | undefined`
  - `computeStaleSet(doc, ctx, pinned: Set<string>): Set<string>`

- [ ] **Step 1: 写失败测试**

`src/domain/graph/cacheKey.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { CacheContext } from './cacheKey';
import { computeCacheKey, selectedAssetOf } from './cacheKey';
import { edge, makeDoc, node } from './testFixtures';
import type { RunRecord } from '../types';

function run(partial: Partial<RunRecord>): RunRecord {
  return {
    id: 'run_1', projectId: 'project_test', boardId: 'board_test', nodeId: 'a',
    action: 'generate', cacheKey: 'old', status: 'succeeded', promptSnapshot: { text: '', segments: [], hash: 'h', locked: false },
    params: {}, inputAssetIds: [], outputAssetIds: ['asset_upstream'], selectedAssetId: 'asset_upstream',
    startedAt: '2026-10-31T00:00:00.000Z', ...partial,
  };
}

const ctx: CacheContext = {
  runs: [run({ nodeId: 'a' })],
  runtime: { b: { providerId: 'openai-compatible', model: 'gpt-image-1', params: { size: '1024x1536' } } },
  promptHashes: { b: 'prompt-hash' },
};

describe('computeCacheKey', () => {
  it('is stable regardless of position and ui changes', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const moved = { ...doc, nodes: { ...doc.nodes, b: { ...doc.nodes.b, position: { x: 999, y: 999 }, ui: { pinned: false } } } };
    expect(computeCacheKey(doc, 'b', ctx)).toBe(computeCacheKey(moved, 'b', ctx));
  });

  it('changes when the upstream selected asset changes', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const before = computeCacheKey(doc, 'b', ctx);
    const changed: CacheContext = { ...ctx, runs: [run({ nodeId: 'a', selectedAssetId: 'asset_other', outputAssetIds: ['asset_upstream', 'asset_other'] })] };
    expect(computeCacheKey(doc, 'b', changed)).not.toBe(before);
  });

  it('changes when prompt hash changes', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const before = computeCacheKey(doc, 'b', ctx);
    expect(computeCacheKey(doc, 'b', { ...ctx, promptHashes: { b: 'other-hash' } })).not.toBe(before);
  });

  it('selects the explicit candidate over the first output', () => {
    expect(selectedAssetOf(run({ selectedAssetId: 'asset_b', outputAssetIds: ['asset_a', 'asset_b'] }))).toBe('asset_b');
    expect(selectedAssetOf(run({ selectedAssetId: undefined, outputAssetIds: ['asset_a'] }))).toBe('asset_a');
  });
});
```

`src/domain/graph/stale.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { CacheContext } from './cacheKey';
import { computeCacheKey } from './cacheKey';
import { computeStaleSet } from './stale';
import { edge, makeDoc, node } from './testFixtures';
import type { RunRecord } from '../types';

function run(nodeId: string, cacheKey: string): RunRecord {
  return {
    id: `run_${nodeId}`, projectId: 'project_test', boardId: 'board_test', nodeId,
    action: 'generate', cacheKey, status: 'succeeded',
    promptSnapshot: { text: '', segments: [], hash: 'h', locked: false },
    params: {}, inputAssetIds: [], outputAssetIds: [`asset_${nodeId}`], selectedAssetId: `asset_${nodeId}`,
    startedAt: '2026-10-31T00:00:00.000Z',
  };
}

describe('computeStaleSet', () => {
  it('marks nodes without successful runs stale', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const ctx: CacheContext = { runs: [], runtime: {}, promptHashes: {} };
    expect([...computeStaleSet(doc, ctx, new Set())].sort()).toEqual(['a', 'b']);
  });

  it('keeps a node fresh when its cache key matches the last run and upstream is fresh', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image')], [edge('e1', 'a', 'b')]);
    const ctx: CacheContext = { runs: [], runtime: {}, promptHashes: {} };
    const aKey = computeCacheKey(doc, 'a', ctx);
    const freshCtx: CacheContext = { ...ctx, runs: [run('a', aKey)] };
    const bKey = computeCacheKey(doc, 'b', freshCtx);
    freshCtx.runs.push(run('b', bKey));
    expect([...computeStaleSet(doc, freshCtx, new Set())]).toEqual([]);
  });

  it('propagates staleness downstream', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image'), node('c', 'video')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')]);
    const ctx: CacheContext = { runs: [], runtime: {}, promptHashes: {} };
    const aKey = computeCacheKey(doc, 'a', ctx);
    const staleCtx: CacheContext = { ...ctx, runs: [run('a', aKey)] };
    expect([...computeStaleSet(doc, staleCtx, new Set())].sort()).toEqual(['b', 'c']);
  });

  it('stops propagation at a pinned node', () => {
    const doc = makeDoc([node('a', 'text'), node('b', 'image'), node('c', 'video')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')]);
    const seeded: CacheContext = { runs: [run('b', 'placeholder'), run('c', 'placeholder')], runtime: {}, promptHashes: {} };
    const bKey = computeCacheKey(doc, 'b', seeded);
    const cKey = computeCacheKey(doc, 'c', seeded);
    const ctx: CacheContext = { ...seeded, runs: [run('b', bKey), run('c', cKey)] };
    expect([...computeStaleSet(doc, ctx, new Set())].sort()).toEqual(['a', 'b', 'c']);
    expect([...computeStaleSet(doc, ctx, new Set(['b']))].sort()).toEqual(['a']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./cacheKey` / `./stale`。

- [ ] **Step 3: 实现缓存键**

`src/domain/graph/cacheKey.ts`：

```ts
import { sha256Json } from '../hash';
import { getNodeDefinition } from '../nodes/definitions';
import type { BoardDoc, RunRecord, StyleGuide } from '../types';

export interface NodeRuntimeConfig {
  providerId?: string;
  model?: string;
  params: Record<string, unknown>;
}

export interface CacheContext {
  styleGuide?: StyleGuide;
  runs: RunRecord[];
  runtime: Record<string, NodeRuntimeConfig>;
  promptHashes: Record<string, string>;
  referenceResolverVersion?: number;
}

const EXCLUDED_NODE_KEYS = new Set(['selectedAssetId', 'previewUrl', 'stale', 'pinned', 'draft']);

export function latestRun(runs: RunRecord[], nodeId: string): RunRecord | undefined {
  return runs
    .filter((item) => item.nodeId === nodeId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

export function latestSucceededRun(runs: RunRecord[], nodeId: string): RunRecord | undefined {
  return runs
    .filter((item) => item.nodeId === nodeId && item.status === 'succeeded')
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

export function selectedAssetOf(run: RunRecord | undefined): string | undefined {
  return run?.selectedAssetId ?? run?.outputAssetIds[0];
}

export function computeCacheKey(doc: BoardDoc, nodeId: string, ctx: CacheContext): string {
  const node = doc.nodes[nodeId];
  if (!node) return 'missing-node';
  const def = getNodeDefinition(node.type);
  const inbound = Object.values(doc.edges)
    .filter((item) => item.target === nodeId)
    .sort((left, right) => left.targetPort.localeCompare(right.targetPort) || left.id.localeCompare(right.id));
  const inputHashes = inbound.map((item) =>
    `${item.targetPort}:${selectedAssetOf(latestSucceededRun(ctx.runs, item.source)) ?? 'missing'}`);
  const nodeData = Object.fromEntries(Object.entries(node.data).filter(([key]) => !EXCLUDED_NODE_KEYS.has(key)));
  const runtime = ctx.runtime[nodeId] ?? { params: {} };
  return sha256Json({
    nodeType: node.type,
    typeVersion: def?.typeVersion ?? node.typeVersion,
    entityVersion: Number(node.data.entityVersion ?? 0),
    nodeData,
    inputHashes,
    providerId: runtime.providerId ?? '',
    model: runtime.model ?? '',
    params: runtime.params,
    promptHash: ctx.promptHashes[nodeId] ?? sha256Json(String(node.data.prompt ?? node.data.text ?? '')),
    styleGuideVersion: ctx.styleGuide?.version ?? 0,
    referenceResolverVersion: ctx.referenceResolverVersion ?? 1,
  });
}
```

- [ ] **Step 4: 实现 stale 传播**

语义（与 Task 21 的设计约束「`ui.pinned` 的节点不参与过期」保持一致）：

- 节点没有成功的 Run，或成功 Run 的 `cacheKey` 与当前重算值不一致 → 该节点过期。
- 过期沿下游传播；传播遇到 `pinned` 节点即停止——`pinned` 节点自身不进入过期集合，其下游也不再因为它而过期。
- `pinned` 只影响过期判定，不影响缓存键。

`src/domain/graph/stale.ts`：

```ts
import type { BoardDoc } from '../types';
import type { CacheContext } from './cacheKey';
import { computeCacheKey, latestSucceededRun } from './cacheKey';
import { topoSort } from './topo';

export function computeStaleSet(doc: BoardDoc, ctx: CacheContext, pinned: Set<string>): Set<string> {
  const stale = new Set<string>();
  for (const nodeId of Object.keys(doc.nodes)) {
    if (pinned.has(nodeId)) continue;
    const run = latestSucceededRun(ctx.runs, nodeId);
    if (!run || run.cacheKey !== computeCacheKey(doc, nodeId, ctx)) stale.add(nodeId);
  }

  const dependencies = new Map<string, string[]>();
  for (const nodeId of Object.keys(doc.nodes)) dependencies.set(nodeId, []);
  for (const item of Object.values(doc.edges)) {
    if (doc.nodes[item.source] && doc.nodes[item.target]) {
      dependencies.get(item.target)!.push(item.source);
    }
  }

  const { order } = topoSort(doc);
  for (const nodeId of order) {
    if (pinned.has(nodeId)) {
      stale.delete(nodeId);
      continue;
    }
    if (stale.has(nodeId)) continue;
    if (dependencies.get(nodeId)!.some((dependency) => stale.has(dependency))) {
      stale.add(nodeId);
    }
  }
  return stale;
}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm test:unit`
Expected: PASS。若第二条 stale 测试失败，检查 `computeCacheKey(doc, 'b', freshCtx)` 是否在上游 run 写入后才计算；必须先写 `a` 的 run，再算 `b` 的 key。

- [ ] **Step 6: 提交**

```bash
git add src/domain/graph/cacheKey.ts src/domain/graph/stale.ts src/domain/graph/cacheKey.test.ts src/domain/graph/stale.test.ts
git commit -m "feat(p0): 内容寻址缓存键与 stale 传播"
```

---

### Task 7: 提示词编译与成本估算

**Files:**
- Create: `src/domain/prompts/compile.ts`
- Create: `src/domain/providers/capabilities.ts`
- Test: `src/domain/prompts/compile.test.ts`
- Test: `src/domain/providers/capabilities.test.ts`

**Interfaces:**
- Consumes: `sha256Json`、`StyleGuide`、`ModelConfig`、`CostEstimate`。
- Produces:
  - `compilePrompt(template: string, ctx: PromptCompileContext): PromptSnapshot`
  - `PromptCompileContext { variables: Record<string,string>; styleGuide?: StyleGuide; negative?: string; lockedText?: string; overrides?: { text?: string; negative?: string } }`
  - `DEFAULT_PROVIDERS: ProviderProfile[]`
  - `MINIMAX_H3_MODEL: ModelConfig`
  - `estimateCost(model: ModelConfig, capability: string, params: Record<string, unknown>): CostEstimate | undefined`
  - `capabilityOf(model: ModelConfig, capability: string): ModelCapability | undefined`

- [ ] **Step 1: 写失败测试**

`src/domain/prompts/compile.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { emptyStyleGuide } from '../types';
import { compilePrompt } from './compile';

const styleGuide = { ...emptyStyleGuide(), visualStyle: '冷色写实电影感', version: 2 };

describe('compilePrompt', () => {
  it('replaces style variables and records segments', () => {
    const result = compilePrompt('{{style.visualStyle}}，雨夜街头，{{mood}}', {
      variables: { mood: '压抑' }, styleGuide,
    });
    expect(result.text).toBe('冷色写实电影感，雨夜街头，压抑');
    expect(result.segments.map((segment) => segment.key)).toEqual(['style', 'literal', 'variable']);
    expect(result.missingVariables).toEqual([]);
  });

  it('keeps unknown variables visible and reports them', () => {
    const result = compilePrompt('{{unknown}} 镜头', { variables: {}, styleGuide });
    expect(result.text).toBe('{{unknown}} 镜头');
    expect(result.missingVariables).toEqual(['unknown']);
  });

  it('uses locked text verbatim and hashes deterministically', () => {
    const first = compilePrompt('{{style.visualStyle}} 模板', { variables: {}, styleGuide, lockedText: '锁定提示词' });
    const second = compilePrompt('{{style.visualStyle}} 模板', { variables: {}, styleGuide, lockedText: '锁定提示词' });
    expect(first.text).toBe('锁定提示词');
    expect(first.locked).toBe(true);
    expect(first.hash).toBe(second.hash);
  });

  it('changes hash when negative changes', () => {
    const base = compilePrompt('镜头', { variables: {}, styleGuide, negative: '模糊' });
    const other = compilePrompt('镜头', { variables: {}, styleGuide, negative: '过曝' });
    expect(base.hash).not.toBe(other.hash);
  });
});
```

`src/domain/providers/capabilities.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, MINIMAX_H3_MODEL, capabilityOf, estimateCost } from './capabilities';

describe('provider defaults', () => {
  it('ships an H3 model with the documented limits', () => {
    const capability = capabilityOf(MINIMAX_H3_MODEL, 'video.generate')!;
    expect(capability.durations).toEqual({ min: 5, max: 15, step: 1 });
    expect(capability.resolutions).toEqual(['768P', '2K']);
    expect(capability.maxReferenceImages).toBe(9);
    expect(capability.maxReferenceVideos).toBe(3);
    expect(capability.maxReferenceAudios).toBe(3);
    expect(capability.inputTransport).toEqual(['publicUrl']);
  });

  it('includes an openai-compatible and an H3 profile', () => {
    expect(DEFAULT_PROVIDERS.map((profile) => profile.adapter)).toEqual(['openai-compatible', 'minimax-h3']);
  });

  it('estimates per-second video cost when a price exists', () => {
    const model = {
      ...MINIMAX_H3_MODEL,
      capabilities: MINIMAX_H3_MODEL.capabilities.map((item) => item.capability === 'video.generate'
        ? { ...item, price: { unit: 'second' as const, amount: 0.5, currency: 'CNY' } }
        : item),
    };
    expect(estimateCost(model, 'video.generate', { duration: 10 })).toMatchObject({ amount: 5, currency: 'CNY' });
  });

  it('returns undefined when no price is configured', () => {
    expect(estimateCost(MINIMAX_H3_MODEL, 'video.generate', { duration: 10 })).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现提示词编译器**

`src/domain/prompts/compile.ts`：

```ts
import { sha256Json } from '../hash';
import type { PromptSegment, PromptSnapshot, StyleGuide } from '../types';

export interface PromptCompileContext {
  variables: Record<string, string>;
  styleGuide?: StyleGuide;
  negative?: string;
  lockedText?: string;
  overrides?: { text?: string; negative?: string };
}

const VARIABLE = /\{\{\s*([\w.]+)\s*\}\}/g;

function resolveVariable(key: string, ctx: PromptCompileContext): string | undefined {
  if (key.startsWith('style.')) {
    const field = key.slice('style.'.length) as keyof StyleGuide;
    const value = ctx.styleGuide?.[field];
    return value === undefined || value === null ? undefined : String(value);
  }
  return ctx.variables[key];
}

function segmentKey(key: string): string {
  if (key.startsWith('style.')) return 'style';
  if (key.startsWith('character.')) return 'subject';
  if (key.startsWith('camera.')) return 'camera';
  if (key.startsWith('lighting.')) return 'lighting';
  return 'variable';
}

export function compilePrompt(template: string, ctx: PromptCompileContext): PromptSnapshot {
  const locked = ctx.lockedText ?? ctx.overrides?.text;
  const source = locked ?? template;
  const segments: PromptSegment[] = [];
  const missing = new Set<string>();
  let cursor = 0;

  for (const match of source.matchAll(VARIABLE)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ key: 'literal', label: '文本', text: source.slice(cursor, index) });
    }
    const key = match[1];
    const value = resolveVariable(key, ctx);
    if (value === undefined) {
      missing.add(key);
      segments.push({ key: segmentKey(key), label: key, text: match[0] });
    } else {
      segments.push({ key: segmentKey(key), label: key, text: value });
    }
    cursor = index + match[0].length;
  }
  if (cursor < source.length) {
    segments.push({ key: 'literal', label: '文本', text: source.slice(cursor) });
  }
  if (!segments.length) segments.push({ key: 'literal', label: '文本', text: '' });

  const text = segments.map((segment) => segment.text).join('');
  const negative = ctx.overrides?.negative ?? ctx.negative ?? '';
  return {
    text,
    negative,
    segments,
    hash: sha256Json({ text, negative }),
    locked: Boolean(locked),
    missingVariables: [...missing],
  };
}
```

- [ ] **Step 4: 实现 Provider 默认值与成本**

`src/domain/providers/capabilities.ts`：

```ts
import type { CostEstimate, ModelCapability, ModelConfig, ProviderProfile } from '../types';

export const MINIMAX_H3_MODEL: ModelConfig = {
  id: 'MiniMax-H3',
  displayName: 'MiniMax H3',
  capabilities: [
    {
      capability: 'video.generate',
      modes: ['t2v', 'firstLast', 'reference'],
      maxReferenceImages: 9,
      maxReferenceVideos: 3,
      maxReferenceAudios: 3,
      supportsFirstFrame: true,
      supportsLastFrame: true,
      supportsNativeAudio: true,
      durations: { min: 5, max: 15, step: 1 },
      ratios: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
      resolutions: ['768P', '2K'],
      maxPromptChars: 20480,
      inputTransport: ['publicUrl'],
      async: true,
      concurrency: 2,
    },
  ],
  defaults: {
    protocol: 'official',
    submitPath: '/v1/video_generation',
    pollPath: '/v1/query/video_generation?task_id={task_id}',
    cancelPath: '',
    fileRetrievePath: '/v1/files/retrieve?file_id={file_id}',
  },
};

export const DEFAULT_PROVIDERS: ProviderProfile[] = [
  {
    id: 'openai-compatible', name: 'OpenAI 兼容中转', adapter: 'openai-compatible',
    baseUrl: '', auth: { type: 'bearer', keyRef: 'provider/openai-compatible' },
    models: [], enabled: true, schemaVersion: 1,
  },
  {
    id: 'minimax-h3', name: 'MiniMax H3', adapter: 'minimax-h3',
    baseUrl: '', auth: { type: 'bearer', keyRef: 'provider/minimax-h3' },
    models: [MINIMAX_H3_MODEL], enabled: true, schemaVersion: 1,
  },
];

export function capabilityOf(model: ModelConfig, capability: string): ModelCapability | undefined {
  return model.capabilities.find((item) => item.capability === capability);
}

export function estimateCost(
  model: ModelConfig,
  capability: string,
  params: Record<string, unknown>,
): CostEstimate | undefined {
  const price = capabilityOf(model, capability)?.price;
  if (!price) return undefined;
  const round = (value: number) => Math.round(value * 10000) / 10000;
  switch (price.unit) {
    case 'request':
      return { amount: round(price.amount), currency: price.currency, unit: '次' };
    case 'image': {
      const count = Number(params.count ?? 1);
      return { amount: round(price.amount * count), currency: price.currency, unit: '张', breakdown: { count } };
    }
    case 'second': {
      const duration = Number(params.duration ?? 0);
      return { amount: round(price.amount * duration), currency: price.currency, unit: '秒', breakdown: { duration } };
    }
    case 'character': {
      const chars = String(params.text ?? '').length;
      return { amount: round(price.amount * chars), currency: price.currency, unit: '字符', breakdown: { chars } };
    }
    case 'token':
      return undefined;
  }
}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm test:unit`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/domain/prompts src/domain/providers
git commit -m "feat(p0): 提示词编译与模型成本估算"
```

---

## 阶段 C — Rust 基础设施

### Task 8: 数据库迁移与模块骨架

**Files:**
- Create: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/lib.rs`（顶部加 `mod db;`；`open_db` 改为调用 `db::open`）
- Modify: `src-tauri/Cargo.toml`（dev-dependencies 加 `tempfile = "3"`）
- Test: `src-tauri/src/db.rs` 内联测试

**Interfaces:**
- Consumes: `rusqlite`。
- Produces:
  - `db::open(path: &Path) -> Result<Connection, String>`
  - 表：`studio_projects` `boards` `runs` `jobs` `assets` `provider_profiles`（保留原有 `projects` `generation_jobs` `provider_settings` `app_settings`）
  - `PRAGMA user_version = 1`

- [ ] **Step 1: 写失败测试**

`src-tauri/src/db.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_schema_and_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("frameforge.sqlite3");
        let connection = open(&path).expect("open");
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, 1);
        for table in ["studio_projects", "boards", "runs", "jobs", "assets", "provider_profiles", "projects"] {
            let count: i64 = connection
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [table], |row| row.get(0))
                .expect("table count");
            assert_eq!(count, 1, "missing table {table}");
        }
        drop(connection);
        let reopened = open(&path).expect("reopen");
        let version: i64 = reopened
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, 1);
    }
}
```

- [ ] **Step 2: 添加依赖并运行测试确认失败**

在 `src-tauri/Cargo.toml` 增加：

```toml
[dev-dependencies]
tempfile = "3"
wiremock = "0.6"
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::tests`
Expected: FAIL，`db` 模块不存在。

- [ ] **Step 3: 实现 db.rs**

```rust
use rusqlite::Connection;
use std::path::Path;

const MIGRATION_1: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_project ON generation_jobs(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS provider_settings (
  provider_id TEXT PRIMARY KEY, base_url TEXT NOT NULL, model TEXT NOT NULL,
  text_model TEXT, voice TEXT
);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS boards_by_project ON boards(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, board_id TEXT NOT NULL, node_id TEXT NOT NULL,
  status TEXT NOT NULL, cache_key TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_board ON runs(board_id, created_at DESC);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider_id TEXT NOT NULL, capability TEXT NOT NULL,
  remote_task_id TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_poll_at TEXT, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(status, next_poll_at);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, width INTEGER, height INTEGER, duration REAL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY, adapter TEXT NOT NULL, base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
"#;

pub fn open(path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|error| error.to_string())?;
    migrate(&mut connection)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version < 1 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(MIGRATION_1).map_err(|error| error.to_string())?;
        transaction
            .pragma_update(None, "user_version", 1)
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}
```

- [ ] **Step 4: 接入 lib.rs**

在 `src-tauri/src/lib.rs` 顶部添加：

```rust
mod db;
```

把现有 `fn open_db(path: &PathBuf) -> Result<Connection, String>` 的函数体替换为：

```rust
fn open_db(path: &PathBuf) -> Result<Connection, String> {
    db::open(path)
}
```

- [ ] **Step 5: 运行测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::tests`
Expected: PASS（1 test）。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/db.rs src-tauri/src/lib.rs
git commit -m "feat(p0): SQLite 迁移框架与 P0 数据表"
```

---

### Task 9: 内容寻址资产库（CAS）

**Files:**
- Create: `src-tauri/src/assets.rs`
- Modify: `src-tauri/src/lib.rs`（`mod assets;`；`probe_media` 改 `pub(crate)`）
- Modify: `src-tauri/Cargo.toml`（`sha2 = "0.10"`）
- Test: `src-tauri/src/assets.rs` 内联测试

**Interfaces:**
- Consumes: `base64`、`chrono`、`sha2`、`serde_json`。
- Produces:
  - `assets::store_bytes(root: &Path, bytes: &[u8], kind: &str, mime: &str, provenance: serde_json::Value) -> Result<AssetRef, String>`
  - `assets::absolute_path(root: &Path, relative: &str) -> Result<PathBuf, String>`
  - `assets::decode_data_url(value: &str) -> Option<(String, Vec<u8>)>`
  - `AssetRef`（camelCase serde，与 TS 对应）

- [ ] **Step 1: 写失败测试**

`src-tauri/src/assets.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stores_content_addressed_and_deduplicates() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bytes = b"hello frameforge";
        let first = store_bytes(dir.path(), bytes, "text", "text/plain", json!({"projectId": "p1"})).expect("first");
        let second = store_bytes(dir.path(), bytes, "text", "text/plain", json!({"projectId": "p2"})).expect("second");
        assert_eq!(first.id, second.id);
        assert!(first.path.starts_with("assets/"));
        assert_eq!(first.bytes, bytes.len() as u64);
        assert!(dir.path().join(&first.path).exists());
        let count = std::fs::read_dir(dir.path().join("assets"))
            .expect("dir")
            .flat_map(|entry| std::fs::read_dir(entry.unwrap().path()).unwrap())
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn rejects_parent_directory_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(absolute_path(dir.path(), "assets/../secret.txt").is_err());
        assert!(absolute_path(dir.path(), "/etc/passwd").is_err());
    }

    #[test]
    fn decodes_data_urls() {
        let (mime, bytes) = decode_data_url("data:image/png;base64,aGVsbG8=").expect("decode");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn maps_mime_to_extension() {
        assert_eq!(extension_for("image/jpeg", "image"), "jpg");
        assert_eq!(extension_for("video/mp4", "video"), "mp4");
        assert_eq!(extension_for("audio/mpeg", "audio"), "mp3");
        assert_eq!(extension_for("text/plain", "text"), "txt");
        assert_eq!(extension_for("application/octet-stream", "image"), "bin");
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml assets::tests`
Expected: FAIL，`assets` 模块不存在。

- [ ] **Step 3: 实现 assets.rs**

```rust
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub thumb_path: Option<String>,
    pub proxy_path: Option<String>,
    pub mime: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub bytes: u64,
    pub created_at: String,
    pub provenance: Value,
}

pub fn extension_for(mime: &str, kind: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "text/plain" | "text/markdown" => "txt",
        "application/json" => "json",
        // octet-stream 意味着「格式未知」，不能按 kind 猜成 png/mp4。
        "application/octet-stream" => "bin",
        _ => match kind {
            "image" => "png",
            "video" => "mp4",
            "audio" => "mp3",
            "text" => "txt",
            "json" => "json",
            _ => "bin",
        },
    }
}

pub fn store_bytes(
    root: &Path,
    bytes: &[u8],
    kind: &str,
    mime: &str,
    provenance: Value,
) -> Result<AssetRef, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let id = hex::encode(hasher.finalize());
    let extension = extension_for(mime, kind);
    let relative = format!("assets/{}/{}.{}", &id[0..2], id, extension);
    let absolute = area_path(root, &relative)?;
    if !absolute.exists() {
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary = absolute.with_file_name(format!(".{id}.tmp"));
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &absolute).map_err(|error| error.to_string())?;
    }
    Ok(AssetRef {
        id,
        kind: kind.to_string(),
        path: relative,
        thumb_path: None,
        proxy_path: None,
        mime: mime.to_string(),
        width: None,
        height: None,
        duration: None,
        bytes: bytes.len() as u64,
        created_at: chrono::Utc::now().to_rfc3339(),
        provenance,
    })
}

fn area_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
        })
    {
        return Err("STORAGE_PATH_INVALID".to_string());
    }
    Ok(root.join(path))
}

pub fn absolute_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    area_path(root, relative)
}

pub fn decode_data_url(value: &str) -> Option<(String, Vec<u8>)> {
    let rest = value.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mime = meta.split(';').next()?.to_string();
    let bytes = base64::engine::general_purpose::STANDARD.decode(payload).ok()?;
    Some((mime, bytes))
}
```

- [ ] **Step 4: 接入 lib.rs**

顶部加 `mod assets;`；把 `fn probe_media(` 改为 `pub(crate) fn probe_media(`。

- [ ] **Step 5: 运行测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml assets::tests`
Expected: PASS（4 tests）。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/assets.rs src-tauri/src/lib.rs
git commit -m "feat(p0): 内容寻址资产库与路径校验"
```

---

### Task 10: Provider 网关与 OpenAI 兼容适配器

**Files:**
- Create: `src-tauri/src/gateway/mod.rs`
- Create: `src-tauri/src/gateway/openai.rs`
- Modify: `src-tauri/src/lib.rs`（`mod gateway;`；`http_client` 改 `pub(crate)`）
- Test: `src-tauri/src/gateway/openai.rs` 内联测试

**Interfaces:**
- Consumes: `reqwest`、`base64`、`serde_json`。
- Produces:
  - `gateway::ProviderRuntime { profile: ProviderProfile, api_key: String }`
  - `gateway::CapabilityRequest { capability, model, prompt, negative, params, inputs, client_request_id }`
  - `gateway::PreparedInput { role, kind, mime, value }`
  - `gateway::AssetPayload { kind, mime, url, data }`
  - `gateway::AdapterResult { status, outputs, task_id, raw }`
  - `gateway::JobStatus { status, progress, outputs, raw_status, error }`
  - `gateway::AppError { code, message, retryable, provider_raw, details }`
  - `gateway::execute(client, runtime, request) -> Result<AdapterResult, AppError>`
  - `openai::execute` 支持 `text.chat`、`image.generate`、`image.edit`、`audio.tts`

- [ ] **Step 1: 写失败测试**

`src-tauri/src/gateway/openai.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::{CapabilityRequest, PreparedInput, ProviderRuntime};
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn runtime(base_url: &str) -> ProviderRuntime {
        ProviderRuntime {
            profile: crate::gateway::test_profile("openai-compatible", base_url),
            api_key: "test-key".to_string(),
        }
    }

    fn request(capability: &str) -> CapabilityRequest {
        CapabilityRequest {
            capability: capability.to_string(),
            model: "test-model".to_string(),
            prompt: "雨夜街头".to_string(),
            negative: None,
            params: json!({ "system": "你是编剧", "count": 2, "size": "1024x1536", "voice": "alloy", "format": "mp3" }),
            inputs: Vec::new(),
            client_request_id: "req_1".to_string(),
        }
    }

    #[tokio::test]
    async fn chat_returns_text_output() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "第一场：雨夜" } }]
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("text.chat"))
            .await
            .expect("chat");
        assert_eq!(result.status, "succeeded");
        assert_eq!(result.outputs[0].kind, "text");
        assert_eq!(result.outputs[0].data.as_deref(), Some("第一场：雨夜"));
    }

    #[tokio::test]
    async fn image_generation_decodes_b64_candidates() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{ "b64_json": "aGVsbG8=" }, { "url": "https://cdn.example.com/a.png" }]
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("image.generate"))
            .await
            .expect("image");
        assert_eq!(result.outputs.len(), 2);
        assert_eq!(result.outputs[0].data.as_deref(), Some("aGVsbG8="));
        assert_eq!(result.outputs[1].url.as_deref(), Some("https://cdn.example.com/a.png"));
    }

    #[tokio::test]
    async fn unauthorized_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("text.chat"))
            .await
            .expect_err("auth");
        assert_eq!(error.code, "AUTH_UNAUTHORIZED");
        assert!(!error.retryable);
    }

    #[tokio::test]
    async fn rate_limit_is_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("text.chat"))
            .await
            .expect_err("rate");
        assert_eq!(error.code, "RATE_LIMIT");
        assert!(error.retryable);
    }

    #[tokio::test]
    async fn tts_returns_base64_audio() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/audio/speech"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"mp3-bytes".to_vec()))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("audio.tts"))
            .await
            .expect("tts");
        assert_eq!(result.outputs[0].kind, "audio");
        assert_eq!(result.outputs[0].data.as_deref(), Some("bXAzLWJ5dGVz"));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml gateway::`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现网关公共类型**

`src-tauri/src/gateway/mod.rs`：

```rust
pub mod openai;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    #[serde(rename = "type")]
    pub kind: String,
    pub key_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapability {
    pub capability: String,
    #[serde(default)]
    pub input_transport: Vec<String>,
    #[serde(default, rename = "async")]
    pub async_job: bool,
    #[serde(default)]
    pub durations: Option<Value>,
    #[serde(default)]
    pub max_prompt_chars: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub capabilities: Vec<ModelCapability>,
    #[serde(default)]
    pub defaults: Value,
}

impl ModelConfig {
    pub fn capability(&self, name: &str) -> Option<&ModelCapability> {
        self.capabilities.iter().find(|item| item.capability == name)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub adapter: String,
    pub base_url: String,
    pub auth: AuthConfig,
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct ProviderRuntime {
    pub profile: ProviderProfile,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedInput {
    pub role: String,
    pub kind: String,
    pub mime: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRequest {
    pub capability: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub negative: Option<String>,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub inputs: Vec<PreparedInput>,
    pub client_request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPayload {
    pub kind: String,
    pub mime: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterResult {
    pub status: String,
    #[serde(default)]
    pub outputs: Vec<AssetPayload>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default)]
    pub provider_raw: Option<String>,
    #[serde(default)]
    pub details: Option<Value>,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self { code: code.to_string(), message: message.into(), retryable, provider_raw: None, details: None }
    }

    pub fn with_raw(mut self, raw: String) -> Self {
        self.provider_raw = Some(raw.chars().take(800).collect());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub status: String,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default)]
    pub outputs: Vec<AssetPayload>,
    #[serde(default)]
    pub raw_status: Option<String>,
    #[serde(default)]
    pub error: Option<AppError>,
}

pub fn join_path(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

pub fn api_url(base: &str, path: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{trimmed}/{}", path.trim_start_matches('/'))
    } else {
        format!("{trimmed}/v1/{}", path.trim_start_matches('/'))
    }
}

pub fn map_http_status(status: reqwest::StatusCode, body: &str, label: &str) -> AppError {
    let lower = body.to_ascii_lowercase();
    let raw = body.chars().take(800).collect::<String>();
    if lower.contains("moderation") || lower.contains("content policy") || lower.contains("safety") {
        return AppError::new("MODERATION_REJECTED", format!("{label} 拒绝了该内容"), false).with_raw(raw);
    }
    match status.as_u16() {
        401 => AppError::new("AUTH_UNAUTHORIZED", format!("{label} 鉴权失败，请检查 API Key"), false).with_raw(raw),
        403 => AppError::new("PERM_FORBIDDEN", format!("{label} 无权限访问该模型"), false).with_raw(raw),
        404 => AppError::new("PARAM_ENDPOINT_NOT_FOUND", format!("{label} 端点不存在，请检查 Base URL"), false).with_raw(raw),
        400 | 422 => AppError::new("PARAM_INVALID", format!("{label} 参数无效"), false).with_raw(raw),
        429 => AppError::new("RATE_LIMIT", format!("{label} 限流"), true).with_raw(raw),
        value if (500..=599).contains(&value) => {
            AppError::new("UNAVAILABLE_PROVIDER", format!("{label} 服务不可用（{value}）"), true).with_raw(raw)
        }
        value => AppError::new("UNKNOWN_PROVIDER", format!("{label} 返回错误 {value}"), false).with_raw(raw),
    }
}

pub fn map_reqwest(error: reqwest::Error, label: &str) -> AppError {
    if error.is_timeout() {
        AppError::new("TIMEOUT_PROVIDER", format!("{label} 请求超时"), true)
    } else if error.is_connect() {
        AppError::new("UNAVAILABLE_PROVIDER", format!("{label} 连接失败"), true)
    } else {
        AppError::new("UNKNOWN_PROVIDER", format!("{label} 请求失败：{error}"), false)
    }
}

pub async fn read_json(response: reqwest::Response, label: &str) -> Result<Value, AppError> {
    let status = response.status();
    let text = response.text().await.map_err(|error| map_reqwest(error, label))?;
    if !status.is_success() {
        return Err(map_http_status(status, &text, label));
    }
    serde_json::from_str(&text).map_err(|_| {
        AppError::new("PROVIDER_BAD_JSON", format!("{label} 返回了非 JSON 响应"), false)
            .with_raw(text)
    })
}

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    match runtime.profile.adapter.as_str() {
        "openai-compatible" => openai::execute(client, runtime, request).await,
        other => Err(AppError::new(
            "CAP_UNSUPPORTED_ADAPTER",
            format!("P0 未实现适配器 {other}"),
            false,
        )),
    }
}

#[cfg(test)]
pub fn test_profile(adapter: &str, base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "test".to_string(),
        name: "Test".to_string(),
        adapter: adapter.to_string(),
        base_url: base_url.to_string(),
        auth: AuthConfig { kind: "bearer".to_string(), key_ref: "provider/test".to_string() },
        models: vec![ModelConfig {
            id: "test-model".to_string(),
            display_name: "Test Model".to_string(),
            capabilities: vec![ModelCapability {
                capability: "text.chat".to_string(),
                input_transport: vec!["dataUrl".to_string()],
                async_job: false,
                durations: None,
                max_prompt_chars: None,
            }],
            defaults: Value::Null,
        }],
        enabled: true,
    }
}
```

- [ ] **Step 4: 实现 OpenAI 适配器**

`src-tauri/src/gateway/openai.rs`：

```rust
use super::{
    api_url, map_reqwest, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest,
    ProviderRuntime,
};
use base64::Engine;
use serde_json::{json, Value};

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    match request.capability.as_str() {
        "text.chat" => chat(client, runtime, request).await,
        "image.generate" => image_generate(client, runtime, request).await,
        "image.edit" => image_edit(client, runtime, request).await,
        "audio.tts" => speech(client, runtime, request).await,
        other => Err(AppError::new(
            "CAP_UNSUPPORTED_CAPABILITY",
            format!("OpenAI 兼容适配器不支持 {other}"),
            false,
        )),
    }
}

async fn chat(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let system = request.params.get("system").and_then(Value::as_str).unwrap_or("").trim();
    let mut messages = Vec::new();
    if !system.is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": request.prompt }));
    let response = client
        .post(api_url(&runtime.profile.base_url, "chat/completions"))
        .bearer_auth(&runtime.api_key)
        .header("Idempotency-Key", &request.client_request_id)
        .json(&json!({ "model": request.model, "messages": messages, "stream": false }))
        .send()
        .await
        .map_err(|error| map_reqwest(error, "OpenAI 兼容文本"))?;
    let value = read_json(response, "OpenAI 兼容文本").await?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("PROVIDER_BAD_RESPONSE", "文本响应缺少 choices[0].message.content", false).with_raw(value.to_string()))?;
    Ok(AdapterResult {
        status: "succeeded".to_string(),
        outputs: vec![AssetPayload { kind: "text".to_string(), mime: "text/plain".to_string(), url: None, data: Some(content.to_string()) }],
        task_id: None,
        raw: Some(value),
    })
}

async fn image_generate(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let count = request.params.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 4);
    let size = request.params.get("size").and_then(Value::as_str).unwrap_or("1024x1536");
    let response = client
        .post(api_url(&runtime.profile.base_url, "images/generations"))
        .bearer_auth(&runtime.api_key)
        .json(&json!({
            "model": request.model,
            "prompt": request.prompt,
            "n": count,
            "size": size,
            "response_format": "b64_json"
        }))
        .send()
        .await
        .map_err(|error| map_reqwest(error, "OpenAI 兼容图片"))?;
    let value = read_json(response, "OpenAI 兼容图片").await?;
    let outputs = image_outputs(&value)?;
    Ok(AdapterResult { status: "succeeded".to_string(), outputs, task_id: None, raw: Some(value) })
}

async fn image_edit(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let first = request.inputs.iter().find(|input| input.kind == "image")
        .ok_or_else(|| AppError::new("CAP_UNSUPPORTED_INPUT", "图片编辑需要至少一张参考图", false))?;
    let (mime, bytes) = decode_data_input(&first.value)?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("image.png")
        .mime_str(&mime)
        .map_err(|error| AppError::new("PARAM_INVALID", format!("图片 MIME 无效：{error}"), false))?;
    let form = reqwest::multipart::Form::new()
        .text("model", request.model.clone())
        .text("prompt", request.prompt.clone())
        .text("n", request.params.get("count").and_then(Value::as_u64).unwrap_or(1).to_string())
        .text("size", request.params.get("size").and_then(Value::as_str).unwrap_or("1024x1536").to_string())
        .text("response_format", "b64_json")
        .part("image", part);
    let response = client
        .post(api_url(&runtime.profile.base_url, "images/edits"))
        .bearer_auth(&runtime.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| map_reqwest(error, "OpenAI 兼容图片编辑"))?;
    let value = read_json(response, "OpenAI 兼容图片编辑").await?;
    let outputs = image_outputs(&value)?;
    Ok(AdapterResult { status: "succeeded".to_string(), outputs, task_id: None, raw: Some(value) })
}

async fn speech(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let voice = request.params.get("voice").and_then(Value::as_str).unwrap_or("alloy");
    let format = request.params.get("format").and_then(Value::as_str).unwrap_or("mp3");
    let response = client
        .post(api_url(&runtime.profile.base_url, "audio/speech"))
        .bearer_auth(&runtime.api_key)
        .json(&json!({
            "model": request.model,
            "voice": voice,
            "input": request.prompt,
            "response_format": format
        }))
        .send()
        .await
        .map_err(|error| map_reqwest(error, "OpenAI 兼容语音"))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| map_reqwest(error, "OpenAI 兼容语音"))?;
    if !status.is_success() {
        return Err(super::map_http_status(status, &String::from_utf8_lossy(&bytes), "OpenAI 兼容语音"));
    }
    let mime = match format {
        "wav" => "audio/wav",
        "opus" => "audio/ogg",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => "audio/mpeg",
    };
    Ok(AdapterResult {
        status: "succeeded".to_string(),
        outputs: vec![AssetPayload {
            kind: "audio".to_string(),
            mime: mime.to_string(),
            url: None,
            data: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        }],
        task_id: None,
        raw: None,
    })
}

fn image_outputs(value: &Value) -> Result<Vec<AssetPayload>, AppError> {
    let data = value.get("data").and_then(Value::as_array)
        .ok_or_else(|| AppError::new("PROVIDER_BAD_RESPONSE", "图片响应缺少 data 数组", false).with_raw(value.to_string()))?;
    let outputs: Vec<AssetPayload> = data.iter().filter_map(|item| {
        if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
            Some(AssetPayload { kind: "image".to_string(), mime: "image/png".to_string(), url: None, data: Some(b64.to_string()) })
        } else {
            item.get("url").and_then(Value::as_str).map(|url| AssetPayload {
                kind: "image".to_string(), mime: "image/png".to_string(), url: Some(url.to_string()), data: None,
            })
        }
    }).collect();
    if outputs.is_empty() {
        return Err(AppError::new("PROVIDER_BAD_RESPONSE", "图片响应没有 url 或 b64_json", false).with_raw(value.to_string()));
    }
    Ok(outputs)
}

fn decode_data_input(value: &str) -> Result<(String, Vec<u8>), AppError> {
    let (mime, bytes) = crate::assets::decode_data_url(value)
        .ok_or_else(|| AppError::new("CAP_UNSUPPORTED_INPUT", "图片编辑 P0 只接受 data URL 参考图", false))?;
    Ok((mime, bytes))
}
```

- [ ] **Step 5: 接入 lib.rs 并运行测试**

顶部加 `mod gateway;`；把 `fn http_client()` 改为 `pub(crate) fn http_client()`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml gateway::`
Expected: PASS（5 tests）。若 `wiremock` 的 `header` 匹配大小写失败，改为 `header("Authorization", "Bearer test-key")`。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/gateway src-tauri/src/lib.rs
git commit -m "feat(p0): Provider 网关与 OpenAI 兼容适配器"
```

---

### Task 11: MiniMax H3 适配器

**Files:**
- Create: `src-tauri/src/gateway/minimax.rs`
- Modify: `src-tauri/src/gateway/mod.rs`（`pub mod minimax;`；`execute` 分发 `minimax-h3`）
- Test: `src-tauri/src/gateway/minimax.rs` 内联测试

**Interfaces:**
- Consumes: `gateway` 公共类型、`ModelConfig.defaults`（`protocol` / `submitPath` / `pollPath` / `cancelPath` / `fileRetrievePath`）。
- Produces:
  - `minimax::execute(client, runtime, request) -> Result<AdapterResult, AppError>`（提交）
  - `minimax::poll(client, runtime, model, task_id) -> Result<JobStatus, AppError>`
  - `minimax::cancel(client, runtime, model, task_id) -> Result<(), AppError>`
  - `minimax::validate(request, model) -> Result<(), AppError>`

- [ ] **Step 1: 写失败测试**

`src-tauri/src/gateway/minimax.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::{test_profile, CapabilityRequest, PreparedInput, ProviderRuntime};
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn runtime(base_url: &str) -> ProviderRuntime {
        let mut profile = test_profile("minimax-h3", base_url);
        profile.models = vec![model()];
        ProviderRuntime { profile, api_key: "h3-key".to_string() }
    }

    fn model() -> crate::gateway::ModelConfig {
        crate::gateway::ModelConfig {
            id: "MiniMax-H3".to_string(),
            display_name: "MiniMax H3".to_string(),
            capabilities: Vec::new(),
            defaults: json!({
                "protocol": "official",
                "submitPath": "/v1/video_generation",
                "pollPath": "/v1/query/video_generation?task_id={task_id}",
                "cancelPath": "",
                "fileRetrievePath": "/v1/files/retrieve?file_id={file_id}"
            }),
        }
    }

    fn request() -> CapabilityRequest {
        CapabilityRequest {
            capability: "video.generate".to_string(),
            model: "MiniMax-H3".to_string(),
            prompt: "雨夜街头，女主回头".to_string(),
            negative: None,
            params: json!({ "duration": 6, "resolution": "768P", "ratio": "9:16" }),
            inputs: vec![PreparedInput {
                role: "first_frame".to_string(),
                kind: "image".to_string(),
                mime: "image/png".to_string(),
                value: "https://cdn.example.com/frame.png".to_string(),
            }],
            client_request_id: "run_1-0-1".to_string(),
        }
    }

    #[tokio::test]
    async fn submits_task_with_first_frame() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/video_generation"))
            .and(body_partial_json(json!({
                "first_frame_image": "https://cdn.example.com/frame.png",
                "duration": 6,
                "resolution": "768P",
                "ratio": "9:16"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "task_id": "task_123" })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("submit");
        assert_eq!(result.status, "queued");
        assert_eq!(result.task_id.as_deref(), Some("task_123"));
    }

    #[tokio::test]
    async fn poll_maps_success_to_video_output() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/query/video_generation"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "Success",
                "file_id": "file_1",
                "file_url": "https://cdn.example.com/out.mp4"
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task_123")
            .await
            .expect("poll");
        assert_eq!(status.status, "succeeded");
        assert_eq!(status.outputs[0].url.as_deref(), Some("https://cdn.example.com/out.mp4"));
    }

    #[tokio::test]
    async fn poll_maps_failure_with_provider_message() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/query/video_generation"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "Fail",
                "message": "content rejected"
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task_123")
            .await
            .expect("poll");
        assert_eq!(status.status, "failed");
        assert_eq!(status.error.as_ref().map(|error| error.code.as_str()), Some("TASK_FAILED"));
    }

    #[test]
    fn rejects_mixed_frame_and_reference_modes() {
        let mut mixed = request();
        mixed.inputs.push(PreparedInput {
            role: "reference_image".to_string(), kind: "image".to_string(),
            mime: "image/png".to_string(), value: "https://cdn.example.com/ref.png".to_string(),
        });
        let error = validate(&mixed, &model()).expect_err("mixed");
        assert_eq!(error.code, "PARAM_MODE_CONFLICT");
    }

    #[test]
    fn rejects_out_of_range_duration() {
        let mut bad = request();
        bad.params = json!({ "duration": 4, "resolution": "768P", "ratio": "9:16" });
        assert_eq!(validate(&bad, &model()).expect_err("duration").code, "PARAM_DURATION_RANGE");
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml gateway::minimax`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 H3 适配器**

`src-tauri/src/gateway/minimax.rs`：

```rust
use super::{
    join_path, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest, JobStatus,
    ModelConfig, ProviderRuntime,
};
use serde::Deserialize;
use serde_json::{json, Value};

const RATIOS: [&str; 7] = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct H3Options {
    #[serde(default = "default_protocol")]
    protocol: String,
    #[serde(default = "default_submit_path")]
    submit_path: String,
    #[serde(default = "default_poll_path")]
    poll_path: String,
    #[serde(default)]
    cancel_path: String,
    #[serde(default)]
    file_retrieve_path: String,
}

impl Default for H3Options {
    fn default() -> Self {
        Self {
            protocol: default_protocol(),
            submit_path: default_submit_path(),
            poll_path: default_poll_path(),
            cancel_path: String::new(),
            file_retrieve_path: String::new(),
        }
    }
}

fn default_protocol() -> String { "official".to_string() }
fn default_submit_path() -> String { "/v1/video_generation".to_string() }
fn default_poll_path() -> String { "/v1/query/video_generation?task_id={task_id}".to_string() }

fn options(model: &ModelConfig) -> H3Options {
    serde_json::from_value(model.defaults.clone()).unwrap_or_default()
}

pub fn validate(request: &CapabilityRequest, model: &ModelConfig) -> Result<(), AppError> {
    let prompt_chars = request.prompt.chars().count();
    let limit = model.capability("video.generate").and_then(|item| item.max_prompt_chars).unwrap_or(20480) as usize;
    if prompt_chars > limit {
        return Err(AppError::new("PARAM_PROMPT_TOO_LONG", format!("提示词超过 {limit} 字符上限"), false));
    }
    let duration = request.params.get("duration").and_then(Value::as_i64).unwrap_or(5);
    if !(5..=15).contains(&duration) {
        return Err(AppError::new("PARAM_DURATION_RANGE", "H3 时长需为 5–15 的整数秒", false));
    }
    let resolution = request.params.get("resolution").and_then(Value::as_str).unwrap_or("768P");
    if !matches!(resolution, "768P" | "2K") {
        return Err(AppError::new("PARAM_RESOLUTION_UNSUPPORTED", "H3 只支持 768P 或 2K", false));
    }
    let ratio = request.params.get("ratio").and_then(Value::as_str).unwrap_or("9:16");
    if !RATIOS.contains(&ratio) {
        return Err(AppError::new("PARAM_RATIO_UNSUPPORTED", format!("H3 不支持比例 {ratio}"), false));
    }
    let has_frame = request.inputs.iter().any(|input| matches!(input.role.as_str(), "first_frame" | "last_frame"));
    let has_reference = request.inputs.iter().any(|input| matches!(input.role.as_str(), "reference_image" | "reference_video" | "reference_audio"));
    if has_frame && has_reference {
        return Err(AppError::new("PARAM_MODE_CONFLICT", "首尾帧模式与全能参考模式互斥", false));
    }
    let images = request.inputs.iter().filter(|input| input.role == "reference_image").count();
    let videos = request.inputs.iter().filter(|input| input.role == "reference_video").count();
    let audios = request.inputs.iter().filter(|input| input.role == "reference_audio").count();
    if images > 9 || videos > 3 || audios > 3 {
        return Err(AppError::new("PARAM_REFERENCE_LIMIT", "参考素材超过 H3 上限（9 图 / 3 视频 / 3 音频）", false));
    }
    Ok(())
}

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let model = runtime.profile.models.iter().find(|item| item.id == request.model)
        .ok_or_else(|| AppError::new("PARAM_MODEL_UNKNOWN", format!("Provider 未配置模型 {}", request.model), false))?;
    validate(request, model)?;
    let options = options(model);
    let mut body = json!({
        "model": request.model,
        "prompt": request.prompt,
        "duration": request.params.get("duration").and_then(Value::as_i64).unwrap_or(5),
        "resolution": request.params.get("resolution").and_then(Value::as_str).unwrap_or("768P"),
        "ratio": request.params.get("ratio").and_then(Value::as_str).unwrap_or("9:16")
    });
    let mut references = Vec::new();
    for input in &request.inputs {
        match input.role.as_str() {
            "first_frame" => body["first_frame_image"] = json!(input.value),
            "last_frame" => body["last_frame_image"] = json!(input.value),
            "reference_image" => references.push(json!({ "type": "image", "url": input.value })),
            "reference_video" => references.push(json!({ "type": "video", "url": input.value })),
            "reference_audio" => references.push(json!({ "type": "audio", "url": input.value })),
            _ => {}
        }
    }
    if !references.is_empty() {
        body["subject_reference"] = Value::Array(references);
    }
    if request.params.get("generateAudio").and_then(Value::as_bool).unwrap_or(true) {
        body["generate_audio"] = json!(true);
    }
    let response = client
        .post(join_path(&runtime.profile.base_url, &options.submit_path))
        .bearer_auth(&runtime.api_key)
        .header("Idempotency-Key", &request.client_request_id)
        .json(&body)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, "MiniMax H3"))?;
    let value = read_json(response, "MiniMax H3").await?;
    let task_id = first_string(&value, &["task_id", "taskId", "id", "data.task_id"])
        .ok_or_else(|| AppError::new("PROVIDER_BAD_RESPONSE", "H3 提交响应缺少 task_id", false).with_raw(value.to_string()))?;
    Ok(AdapterResult { status: "queued".to_string(), outputs: Vec::new(), task_id: Some(task_id), raw: Some(value) })
}

pub async fn poll(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    model: &ModelConfig,
    task_id: &str,
) -> Result<JobStatus, AppError> {
    let options = options(model);
    let url = join_path(&runtime.profile.base_url, &options.poll_path.replace("{task_id}", task_id));
    let response = client
        .get(url)
        .bearer_auth(&runtime.api_key)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, "MiniMax H3 查询"))?;
    let value = read_json(response, "MiniMax H3 查询").await?;
    let raw_status = first_string(&value, &["status", "task_status", "data.status"]).unwrap_or_default();
    let normalized = raw_status.to_ascii_lowercase();
    if matches!(normalized.as_str(), "success" | "succeeded" | "completed" | "finished") {
        let mut url = first_string(&value, &["file_url", "video_url", "download_url", "output.url", "data.file_url"]);
        if url.is_none() {
            if let (Some(file_id), false) = (first_string(&value, &["file_id", "data.file_id"]), options.file_retrieve_path.is_empty()) {
                let retrieve = join_path(&runtime.profile.base_url, &options.file_retrieve_path.replace("{file_id}", &file_id));
                let response = client.get(retrieve).bearer_auth(&runtime.api_key).send().await
                    .map_err(|error| super::map_reqwest(error, "MiniMax H3 文件"))?;
                let file_value = read_json(response, "MiniMax H3 文件").await?;
                url = first_string(&file_value, &["file.download_url", "download_url", "data.download_url"]);
            }
        }
        let url = url.ok_or_else(|| AppError::new("TASK_RESULT_UNRECOGNIZED", "H3 成功但未找到结果 URL", false).with_raw(value.to_string()))?;
        return Ok(JobStatus {
            status: "succeeded".to_string(),
            progress: Some(100.0),
            outputs: vec![AssetPayload { kind: "video".to_string(), mime: "video/mp4".to_string(), url: Some(url), data: None }],
            raw_status: Some(raw_status),
            error: None,
        });
    }
    if matches!(normalized.as_str(), "fail" | "failed" | "error") {
        let message = first_string(&value, &["message", "error.message", "base_resp.status_msg"]).unwrap_or_else(|| "H3 任务失败".to_string());
        return Ok(JobStatus {
            status: "failed".to_string(), progress: None, outputs: Vec::new(), raw_status: Some(raw_status),
            error: Some(AppError::new("TASK_FAILED", message, false).with_raw(value.to_string())),
        });
    }
    if matches!(normalized.as_str(), "cancelled" | "canceled") {
        return Ok(JobStatus { status: "cancelled".to_string(), progress: None, outputs: Vec::new(), raw_status: Some(raw_status), error: None });
    }
    let progress = value.get("progress").and_then(Value::as_f64);
    Ok(JobStatus { status: "polling".to_string(), progress, outputs: Vec::new(), raw_status: Some(raw_status), error: None })
}

pub async fn cancel(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    model: &ModelConfig,
    task_id: &str,
) -> Result<(), AppError> {
    let options = options(model);
    if options.cancel_path.is_empty() {
        return Ok(());
    }
    let url = join_path(&runtime.profile.base_url, &options.cancel_path.replace("{task_id}", task_id));
    let response = client.post(url).bearer_auth(&runtime.api_key).json(&json!({ "task_id": task_id })).send().await
        .map_err(|error| super::map_reqwest(error, "MiniMax H3 取消"))?;
    let status = response.status();
    if status.is_success() || status.as_u16() == 404 {
        return Ok(());
    }
    Err(super::map_http_status(status, &response.text().await.unwrap_or_default(), "MiniMax H3 取消"))
}

fn first_string(value: &Value, paths: &[&str]) -> Option<String> {
    for path in paths {
        let mut current = value;
        let mut found = true;
        for segment in path.split('.') {
            match current.get(segment) {
                Some(next) => current = next,
                None => { found = false; break; }
            }
        }
        if found {
            if let Some(text) = current.as_str() {
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}
```

- [ ] **Step 4: 分发到 H3**

`gateway/mod.rs` 顶部加 `pub mod minimax;`，把 `execute` 的 match 改为：

```rust
pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    match runtime.profile.adapter.as_str() {
        "openai-compatible" => openai::execute(client, runtime, request).await,
        "minimax-h3" => minimax::execute(client, runtime, request).await,
        other => Err(AppError::new(
            "CAP_UNSUPPORTED_ADAPTER",
            format!("P0 未实现适配器 {other}"),
            false,
        )),
    }
}
```

- [ ] **Step 5: 运行测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml gateway::minimax`
Expected: PASS（5 tests）。如果 wiremock 的 query string 匹配不到，把 `path("/v1/query/video_generation")` 换成 `path("/v1/query/video_generation")` 并确认 `pollPath` 里的 query 被 reqwest 保留。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/gateway
git commit -m "feat(p0): MiniMax H3 提交、轮询与约束校验"
```

---

### Task 12: 资产传输（data URL + S3 兼容桶）

**Files:**
- Create: `src-tauri/src/gateway/transport.rs`
- Create: `src-tauri/src/security.rs`
- Modify: `src-tauri/src/gateway/mod.rs`（`pub mod transport;`）
- Modify: `src-tauri/src/lib.rs`（`mod security;`）
- Modify: `src-tauri/Cargo.toml`（`hmac = "0.12"`、`hex = "0.4"`）
- Test: `src-tauri/src/gateway/transport.rs` 内联测试
- Test: `src-tauri/src/security.rs` 内联测试

**Interfaces:**
- Consumes: `AssetRef`、`assets::absolute_path`、`ModelCapability.inputTransport`。
- Produces:
  - `transport::AssetHostConfig { strategy, endpoint, bucket, region, prefix, public_base_url, access_key, secret_key }`
  - `transport::TransportRef { kind, value, expires_at }`
  - `transport::prepare_input(root, asset, capability, host) -> Result<TransportRef, AppError>`
  - `transport::sign_v4(secret, amz_date, date_stamp, region, service, canonical_request) -> String`
  - `security::validate_remote_url(url: &str) -> Result<reqwest::Url, AppError>`

- [ ] **Step 1: 写失败测试**

`src-tauri/src/gateway/transport.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aws_sigv4_documented_get_vector_matches() {
        let canonical = "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let signature = sign_v4(
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "20130524T000000Z",
            "20130524",
            "us-east-1",
            "s3",
            canonical,
        );
        assert_eq!(signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    }

    #[test]
    fn data_url_fallback_is_used_when_transport_allows_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bytes = b"frame";
        let host = AssetHostConfig::default();
        let result = prepare_bytes(dir.path(), bytes, "image/png", "abc123", &["dataUrl".to_string()], &host).expect("data url");
        assert_eq!(result.kind, "dataUrl");
        assert!(result.value.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn public_url_only_without_s3_config_is_actionable_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = AssetHostConfig::default();
        let error = prepare_bytes(dir.path(), b"x", "image/png", "abc123", &["publicUrl".to_string()], &host).expect_err("needs s3");
        assert_eq!(error.code, "CAP_PUBLIC_URL_REQUIRED");
    }
}
```

`src-tauri/src/security.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_and_local_targets() {
        assert!(validate_remote_url("http://127.0.0.1/a").is_err());
        assert!(validate_remote_url("http://localhost/a").is_err());
        assert!(validate_remote_url("http://192.168.1.2/a").is_err());
        assert!(validate_remote_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn accepts_public_https() {
        assert!(validate_remote_url("https://cdn.example.com/a.png").is_ok());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transport::tests security::tests`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 SSRF 校验**

`src-tauri/src/security.rs`：

```rust
use crate::gateway::AppError;

pub fn validate_remote_url(value: &str) -> Result<reqwest::Url, AppError> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| AppError::new("PARAM_URL_INVALID", "远端 URL 格式无效", false))?;
    if url.scheme() != "https" {
        return Err(AppError::new("PARAM_URL_INSECURE", "只允许 https 远端地址", false));
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return Err(AppError::new("PARAM_URL_PRIVATE", "禁止访问 localhost", false));
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let private = match ip {
            std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified(),
            std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
        };
        if private {
            return Err(AppError::new("PARAM_URL_PRIVATE", "禁止访问私网地址", false));
        }
    }
    Ok(url)
}
```

- [ ] **Step 4: 实现传输与 SigV4**

`src-tauri/src/gateway/transport.rs`：

```rust
use super::{AppError, JobStatus};
use crate::assets;
use base64::Engine;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetHostConfig {
    #[serde(default)]
    pub strategy: String,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub prefix: Option<String>,
    pub public_base_url: Option<String>,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
}

impl AssetHostConfig {
    fn s3_ready(&self) -> bool {
        self.endpoint.is_some() && self.bucket.is_some() && self.public_base_url.is_some()
            && self.access_key.is_some() && self.secret_key.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportRef {
    pub kind: String,
    pub value: String,
    pub expires_at: Option<String>,
}

pub fn prepare_input(
    root: &Path,
    asset: &assets::AssetRef,
    allowed: &[String],
    host: &AssetHostConfig,
) -> Result<TransportRef, AppError> {
    let path = assets::absolute_path(root, &asset.path)
        .map_err(|_| AppError::new("STORAGE_PATH_INVALID", "资产路径无效", false))?;
    let bytes = std::fs::read(&path)
        .map_err(|error| AppError::new("STORAGE_READ_FAILED", format!("读取资产失败：{error}"), false))?;
    prepare_bytes(root, &bytes, &asset.mime, &asset.id, allowed, host)
}

pub fn prepare_bytes(
    _root: &Path,
    bytes: &[u8],
    mime: &str,
    id: &str,
    allowed: &[String],
    host: &AssetHostConfig,
) -> Result<TransportRef, AppError> {
    let allows_data = allowed.iter().any(|item| item == "dataUrl");
    let allows_public = allowed.iter().any(|item| item == "publicUrl" || item == "upload");
    if allows_data && (host.strategy != "s3" || !host.s3_ready()) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(TransportRef { kind: "dataUrl".to_string(), value: format!("data:{mime};base64,{encoded}"), expires_at: None });
    }
    if allows_public && host.s3_ready() {
        return s3_put(host, bytes, mime, id);
    }
    if allows_data {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(TransportRef { kind: "dataUrl".to_string(), value: format!("data:{mime};base64,{encoded}"), expires_at: None });
    }
    Err(AppError::new(
        "CAP_PUBLIC_URL_REQUIRED",
        "该模型要求公网可访问的输入地址，请在设置中配置 S3 兼容资产桶",
        false,
    ))
}

fn s3_put(host: &AssetHostConfig, bytes: &[u8], mime: &str, id: &str) -> Result<TransportRef, AppError> {
    let endpoint = reqwest::Url::parse(host.endpoint.as_deref().unwrap_or_default())
        .map_err(|_| AppError::new("PARAM_ASSET_HOST_INVALID", "资产桶 endpoint 无效", false))?;
    let bucket = host.bucket.as_deref().unwrap_or_default();
    let region = host.region.as_deref().unwrap_or("auto");
    let prefix = host.prefix.as_deref().unwrap_or("").trim_matches('/');
    let extension = assets::extension_for(mime, kind_for_mime(mime));
    let key = if prefix.is_empty() { format!("{id}.{extension}") } else { format!("{prefix}/{id}.{extension}") };
    let canonical_uri = format!("/{bucket}/{key}");
    let host_name = match endpoint.port() {
        Some(port) => format!("{}:{port}", endpoint.host_str().unwrap_or_default()),
        None => endpoint.host_str().unwrap_or_default().to_string(),
    };
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let payload_hash = hex::encode(Sha256::digest(bytes));
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), mime.to_string());
    headers.insert("host".to_string(), host_name);
    headers.insert("x-amz-content-sha256".to_string(), payload_hash.clone());
    headers.insert("x-amz-date".to_string(), amz_date.clone());
    let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_headers = headers.iter().map(|(key, value)| format!("{key}:{value}\n")).collect::<String>();
    let canonical_request = format!("PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let signature = sign_v4(
        host.secret_key.as_deref().unwrap_or_default(),
        &amz_date,
        &date_stamp,
        region,
        "s3",
        &canonical_request,
    );
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}/{}/s3/aws4_request, SignedHeaders={}, Signature={}",
        host.access_key.as_deref().unwrap_or_default(), date_stamp, region, signed_headers, signature
    );
    let url = format!("{}{}", endpoint.as_str().trim_end_matches('/'), canonical_uri);
    let body = bytes.to_vec();
    let client = reqwest::Client::new();
    let response = client
        .put(url)
        .header("authorization", authorization)
        .header("content-type", mime)
        .header("x-amz-content-sha256", payload_hash)
        .header("x-amz-date", amz_date)
        .body(body)
        .send()
        .blocking_send()
        .map_err(|error| AppError::new("STORAGE_UPLOAD_FAILED", format!("上传资产桶失败：{error}"), true))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().blocking_send().unwrap_or_default();
        return Err(super::map_http_status(status, &text, "资产桶上传"));
    }
    let public = format!("{}/{}", host.public_base_url.as_deref().unwrap_or_default().trim_end_matches('/'), key);
    Ok(TransportRef { kind: "url".to_string(), value: public, expires_at: None })
}

/// mime 前缀即资产类别，未知 mime（如 application/octet-stream）落到 "bin"。
fn kind_for_mime(mime: &str) -> &str {
    mime.split('/').next().unwrap_or("bin")
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

pub fn sign_v4(
    secret: &str,
    amz_date: &str,
    date_stamp: &str,
    region: &str,
    service: &str,
    canonical_request: &str,
) -> String {
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{date_stamp}/{region}/{service}/aws4_request\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    let k_signing = hmac(&k_service, b"aws4_request");
    hex::encode(hmac(&k_signing, string_to_sign.as_bytes()))
}
```

注意：`reqwest` 没有 `blocking_send`。这里必须用异步函数。把 `s3_put` 改成 `async fn`，`prepare_bytes` 改成 `async fn`，`prepare_input` 改成 `async fn`，并用 `.await`。测试里用 `#[tokio::test]` 调用。修改后的签名：

```rust
pub async fn prepare_input(...) -> Result<TransportRef, AppError>
pub async fn prepare_bytes(...) -> Result<TransportRef, AppError>
async fn s3_put(...) -> Result<TransportRef, AppError>
```

并把测试改成：

```rust
#[tokio::test]
async fn data_url_fallback_is_used_when_transport_allows_it() { ... prepare_bytes(...).await ... }

#[tokio::test]
async fn public_url_only_without_s3_config_is_actionable_error() { ... prepare_bytes(...).await ... }
```

`JobStatus` import 未使用，删掉。

- [ ] **Step 5: 接入 lib.rs 并运行测试**

`src-tauri/src/lib.rs` 顶部加 `mod security;`；`src-tauri/src/gateway/mod.rs` 加 `pub mod transport;`。在 `Cargo.toml` 增加 `hmac` 与 `hex`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml transport::tests security::tests`
Expected: PASS（5 tests）。SigV4 向量若失败，逐行比对 canonical request：headers 必须按字母序、每行 `key:value\n`、最后空行后接 signed headers。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/security.rs src-tauri/src/gateway
git commit -m "feat(p0): data URL 与 S3 兼容资产外链传输"
```

---

### Task 13: 运行记录与同步执行（文本/图片/语音）

**Files:**
- Create: `src-tauri/src/runs.rs`
- Create: `src-tauri/src/jobs.rs`（先落 `attach_task` 的任务落库；Task 14 在此文件补轮询）
- Modify: `src-tauri/src/lib.rs`（`mod runs;` `mod jobs;`；`AppState` 增加 `data_dir` 并改为 `pub(crate)`；setup 传入 `app_data`；新增 `pub(crate) fn asset_host_internal`）
- Modify: `src-tauri/src/gateway/mod.rs`（无）
- Test: `src-tauri/src/runs.rs` 内联测试

**Interfaces:**
- Consumes: `db`、`assets`、`gateway`、`assets::store_bytes`、`crate::load_provider_credential`。
- Produces:
  - `runs::StartRunRequest`
  - `runs::create_run(state, request) -> Result<RunRecord, String>`
  - `runs::finish_cached(state, request, asset_id) -> Result<RunRecord, String>`
  - `runs::execute_run(app, state, run_id, job_id, request, runtime)`
  - `runs::list_runs(state, board_id) -> Result<Vec<RunRecord>, String>`
  - `runs::load_run(state, run_id) -> Result<RunRecord, String>`
  - `runs::select_candidate(state, run_id, asset_id) -> Result<RunRecord, String>`
  - `runs::mark_cancelled(state, run_id)`
  - 事件：`run.updated`（`RunUpdatedEvent { run, assets }`）、`job.updated`、`asset.created`

- [ ] **Step 1: 写失败测试**

`src-tauri/src/runs.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(cache_key: &str) -> StartRunRequest {
        StartRunRequest {
            schema_version: 1,
            project_id: "project_1".to_string(),
            board_id: "board_1".to_string(),
            node_id: "node_1".to_string(),
            capability: "text.chat".to_string(),
            provider_id: "openai-compatible".to_string(),
            model: "test-model".to_string(),
            prompt_snapshot: json!({ "text": "hi", "segments": [], "hash": "h", "locked": false }),
            params: json!({}),
            inputs: Vec::new(),
            input_asset_ids: Vec::new(),
            cache_key: cache_key.to_string(),
            cached_asset_id: None,
        }
    }

    #[test]
    fn creates_and_reads_a_queued_run() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let run = create_run(&state, &request("cache-1")).expect("create");
        assert_eq!(run.status, "queued");
        let loaded = load_run(&state, &run.id).expect("load");
        assert_eq!(loaded.cache_key, "cache-1");
        assert_eq!(list_runs(&state, "board_1").expect("list").len(), 1);
    }

    #[test]
    fn selecting_a_candidate_updates_the_run() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let mut run = create_run(&state, &request("cache-2")).expect("create");
        run.status = "succeeded".to_string();
        run.output_asset_ids = vec!["asset_a".to_string(), "asset_b".to_string()];
        save_run(&state, &run).expect("save");
        let updated = select_candidate(&state, &run.id, "asset_b").expect("select");
        assert_eq!(updated.selected_asset_id.as_deref(), Some("asset_b"));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml runs::tests`
Expected: FAIL，模块不存在 / `AppState` 缺少 `data_dir`。

- [ ] **Step 3: 实现 runs.rs 的类型与持久化**

```rust
use crate::assets::{self, AssetRef};
use crate::db;
use crate::gateway::{self, AppError, ProviderRuntime};
use crate::security;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    pub role: String,
    pub asset_id: String,
    pub kind: String,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub schema_version: u32,
    pub project_id: String,
    pub board_id: String,
    pub node_id: String,
    pub capability: String,
    pub provider_id: String,
    pub model: String,
    pub prompt_snapshot: Value,
    pub params: Value,
    pub inputs: Vec<RunInput>,
    pub input_asset_ids: Vec<String>,
    pub cache_key: String,
    pub cached_asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub project_id: String,
    pub board_id: String,
    pub node_id: String,
    pub entity_id: Option<String>,
    pub action: String,
    pub cache_key: String,
    pub status: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub prompt_snapshot: Value,
    pub params: Value,
    pub input_asset_ids: Vec<String>,
    pub output_asset_ids: Vec<String>,
    pub selected_asset_id: Option<String>,
    pub cost: Option<Value>,
    pub error: Option<AppError>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUpdatedEvent {
    pub run: RunRecord,
    pub assets: Vec<AssetRef>,
}

pub fn db_path(state: &AppState) -> Result<PathBuf, String> {
    state.db_path.lock().map(|path| path.clone()).map_err(|_| "Project database lock poisoned".to_string())
}

pub fn create_run(state: &AppState, request: &StartRunRequest) -> Result<RunRecord, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let run = RunRecord {
        id: format!("run_{}", uuid::Uuid::new_v4()),
        project_id: request.project_id.clone(),
        board_id: request.board_id.clone(),
        node_id: request.node_id.clone(),
        entity_id: None,
        action: "generate".to_string(),
        cache_key: request.cache_key.clone(),
        status: "queued".to_string(),
        provider_id: Some(request.provider_id.clone()),
        model: Some(request.model.clone()),
        prompt_snapshot: request.prompt_snapshot.clone(),
        params: request.params.clone(),
        input_asset_ids: request.input_asset_ids.clone(),
        output_asset_ids: Vec::new(),
        selected_asset_id: None,
        cost: None,
        error: None,
        started_at: now.clone(),
        finished_at: None,
    };
    save_run(state, &run)?;
    Ok(run)
}

pub fn save_run(state: &AppState, run: &RunRecord) -> Result<(), String> {
    let path = db_path(state)?;
    let connection = db::open(&path)?;
    let payload = serde_json::to_string(run).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO runs (id, project_id, board_id, node_id, status, cache_key, payload, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated_at=excluded.updated_at",
        rusqlite::params![run.id, run.project_id, run.board_id, run.node_id, run.status, run.cache_key, payload, run.started_at, chrono::Utc::now().to_rfc3339()],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn load_run(state: &AppState, run_id: &str) -> Result<RunRecord, String> {
    let path = db_path(state)?;
    let connection = db::open(&path)?;
    let payload: String = connection.query_row("SELECT payload FROM runs WHERE id=?1", [run_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&payload).map_err(|error| error.to_string())
}

pub fn list_runs(state: &AppState, board_id: &str) -> Result<Vec<RunRecord>, String> {
    let path = db_path(state)?;
    let connection = db::open(&path)?;
    let mut statement = connection.prepare("SELECT payload FROM runs WHERE board_id=?1 ORDER BY created_at DESC LIMIT 500")
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([board_id], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
    rows.map(|row| {
        let payload = row.map_err(|error| error.to_string())?;
        serde_json::from_str(&payload).map_err(|error| error.to_string())
    }).collect()
}

pub fn select_candidate(state: &AppState, run_id: &str, asset_id: &str) -> Result<RunRecord, String> {
    let mut run = load_run(state, run_id)?;
    if !run.output_asset_ids.iter().any(|item| item == asset_id) {
        return Err("选中的资产不属于该运行记录".to_string());
    }
    run.selected_asset_id = Some(asset_id.to_string());
    save_run(state, &run)?;
    Ok(run)
}

pub fn mark_cancelled(state: &AppState, run_id: &str) -> Result<RunRecord, String> {
    let mut run = load_run(state, run_id)?;
    run.status = "cancelled".to_string();
    run.finished_at = Some(chrono::Utc::now().to_rfc3339());
    save_run(state, &run)?;
    Ok(run)
}

pub fn finish_cached(state: &AppState, request: &StartRunRequest, asset_id: &str) -> Result<RunRecord, String> {
    let mut run = create_run(state, request)?;
    run.status = "succeeded".to_string();
    run.output_asset_ids = vec![asset_id.to_string()];
    run.selected_asset_id = Some(asset_id.to_string());
    run.cost = Some(json!({ "estimated": { "amount": 0, "currency": "", "unit": "缓存命中" } }));
    run.finished_at = Some(chrono::Utc::now().to_rfc3339());
    save_run(state, &run)?;
    Ok(run)
}

async fn prepare_inputs(state: &AppState, request: &StartRunRequest, capability: &gateway::ModelCapability, host: &gateway::transport::AssetHostConfig) -> Result<Vec<gateway::PreparedInput>, AppError> {
    let path = db_path(state).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let connection = db::open(&path).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let mut prepared = Vec::new();
    for input in &request.inputs {
        let payload: String = connection.query_row("SELECT payload FROM assets WHERE id=?1", [&input.asset_id], |row| row.get(0))
            .map_err(|_| AppError::new("STORAGE_ASSET_MISSING", format!("资产 {} 不存在", input.asset_id), false))?;
        let asset: AssetRef = serde_json::from_str(&payload)
            .map_err(|error| AppError::new("STORAGE_ASSET_CORRUPT", error.to_string(), false))?;
        let transport = gateway::transport::prepare_input(&state.data_dir, &asset, &capability.input_transport, host)
            .await
            .map_err(|error| error)?;
        prepared.push(gateway::PreparedInput {
            role: input.role.clone(),
            kind: input.kind.clone(),
            mime: input.mime.clone(),
            value: transport.value,
        });
    }
    Ok(prepared)
}

pub async fn execute_run(
    app: AppHandle,
    state: AppState,
    run: RunRecord,
    job_id: String,
    request: StartRunRequest,
    runtime: ProviderRuntime,
) {
    let model = match runtime.profile.models.iter().find(|item| item.id == request.model) {
        Some(model) => model.clone(),
        None => {
            fail_run(&app, &state, &run, AppError::new("PARAM_MODEL_UNKNOWN", "模型未配置", false));
            return;
        }
    };
    let capability = match model.capability(&request.capability) {
        Some(capability) => capability.clone(),
        None => {
            fail_run(&app, &state, &run, AppError::new("CAP_UNSUPPORTED_CAPABILITY", "模型不支持该能力", false));
            return;
        }
    };
    let host = crate::asset_host_internal(&state).unwrap_or_default();
    let inputs = match prepare_inputs(&state, &request, &capability, &host).await {
        Ok(inputs) => inputs,
        Err(error) => { fail_run(&app, &state, &run, error); return; }
    };
    let capability_request = gateway::CapabilityRequest {
        capability: request.capability.clone(),
        model: request.model.clone(),
        prompt: request.prompt_snapshot.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
        negative: request.prompt_snapshot.get("negative").and_then(Value::as_str).map(ToString::to_string),
        params: request.params.clone(),
        inputs,
        client_request_id: format!("{}-0-1", run.id),
    };
    let client = match crate::http_client() {
        Ok(client) => client,
        Err(message) => { fail_run(&app, &state, &run, AppError::new("UNAVAILABLE_HTTP", message, false)); return; }
    };
    match gateway::execute(&client, &runtime, &capability_request).await {
        Ok(result) if result.status == "queued" => {
            let task_id = match result.task_id {
                Some(task_id) => task_id,
                None => { fail_run(&app, &state, &run, AppError::new("PROVIDER_BAD_RESPONSE", "异步任务缺少 task_id", false)); return; }
            };
            crate::jobs::attach_task(&app, &state, &run, &job_id, &task_id, request, runtime, model);
        }
        Ok(result) => {
            match store_outputs(&app, &state, &run, result.outputs).await {
                Ok(assets) => succeed_run(&app, &state, &run, assets),
                Err(error) => fail_run(&app, &state, &run, error),
            }
        }
        Err(error) => fail_run(&app, &state, &run, error),
    }
}

async fn store_outputs(app: &AppHandle, state: &AppState, run: &RunRecord, outputs: Vec<gateway::AssetPayload>) -> Result<Vec<AssetRef>, AppError> {
    let mut assets_out = Vec::new();
    for output in outputs {
        let (bytes, mime) = match (output.data, output.url) {
            (Some(data), _) => {
                if output.kind == "text" {
                    (data.into_bytes(), output.mime.clone())
                } else {
                    let decoded = if data.starts_with("data:") {
                        assets::decode_data_url(&data).map(|(_, bytes)| bytes)
                    } else {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).ok()
                    };
                    (decoded.ok_or_else(|| AppError::new("DOWNLOAD_DECODE_FAILED", "生成结果 base64 解码失败", true))?, output.mime.clone())
                }
            }
            (None, Some(url)) => {
                let validated = security::validate_remote_url(&url)?;
                let response = reqwest::Client::new().get(validated).send().await
                    .map_err(|error| gateway::map_reqwest(error, "结果下载"))?;
                if !response.status().is_success() {
                    return Err(gateway::map_http_status(response.status(), "", "结果下载"));
                }
                (response.bytes().await.map_err(|error| gateway::map_reqwest(error, "结果下载"))?.to_vec(), output.mime.clone())
            }
            (None, None) => return Err(AppError::new("PROVIDER_BAD_RESPONSE", "生成结果既无 data 也无 url", false)),
        };
        let provenance = json!({
            "projectId": run.project_id, "nodeId": run.node_id, "runId": run.id,
            "providerId": run.provider_id, "model": run.model,
            "promptHash": run.prompt_snapshot.get("hash"),
        });
        let asset = assets::store_bytes(&state.data_dir, &bytes, &output.kind, &mime, provenance)
            .map_err(|message| AppError::new("STORAGE_WRITE_FAILED", message, false))?;
        save_asset(state, &asset)?;
        let _ = app.emit("asset.created", &asset);
        assets_out.push(asset);
    }
    Ok(assets_out)
}

fn save_asset(state: &AppState, asset: &AssetRef) -> Result<(), AppError> {
    let path = db_path(state).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let connection = db::open(&path).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let payload = serde_json::to_string(asset).map_err(|error| AppError::new("STORAGE_JSON_FAILED", error.to_string(), false))?;
    connection.execute(
        "INSERT OR REPLACE INTO assets (id, kind, path, mime, bytes, width, height, duration, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![asset.id, asset.kind, asset.path, asset.mime, asset.bytes, asset.width, asset.height, asset.duration, payload, asset.created_at],
    ).map_err(|error| AppError::new("STORAGE_DB_FAILED", error.to_string(), false))?;
    Ok(())
}

fn succeed_run(app: &AppHandle, state: &AppState, run: &RunRecord, assets_out: Vec<AssetRef>) {
    let mut finished = run.clone();
    finished.status = "succeeded".to_string();
    finished.output_asset_ids = assets_out.iter().map(|asset| asset.id.clone()).collect();
    if finished.output_asset_ids.len() == 1 {
        finished.selected_asset_id = finished.output_asset_ids.first().cloned();
    }
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    let _ = save_run(state, &finished);
    let _ = app.emit("run.updated", &RunUpdatedEvent { run: finished, assets: assets_out });
}

fn fail_run(app: &AppHandle, state: &AppState, run: &RunRecord, error: AppError) {
    let mut finished = run.clone();
    finished.status = "failed".to_string();
    finished.error = Some(error);
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    let _ = save_run(state, &finished);
    let _ = app.emit("run.updated", &RunUpdatedEvent { run: finished, assets: Vec::new() });
}

pub fn load_provider_profile(state: &AppState, provider_id: &str) -> Result<Option<gateway::ProviderProfile>, String> {
    let path = db_path(state)?;
    let connection = db::open(&path)?;
    let mut statement = connection.prepare("SELECT payload FROM provider_profiles WHERE id=?1").map_err(|error| error.to_string())?;
    let mut rows = statement.query([provider_id]).map_err(|error| error.to_string())?;
    match rows.next().map_err(|error| error.to_string())? {
        Some(row) => {
            let payload: String = row.get(0).map_err(|error| error.to_string())?;
            Ok(Some(serde_json::from_str(&payload).map_err(|error| error.to_string())?))
        }
        None => Ok(None),
    }
}
```

注意：`resume_pending` 依赖 `jobs::resume_poll`，而 jobs.rs 在 Task 14 才补齐轮询实现，因此 `resume_pending` 整个函数下移到 Task 14 的 `jobs.rs`（它的语义就是「扫表 + 恢复轮询」）。Task 13 只落运行记录与同步执行。

`AppState` 不需要 `Clone`：轮询器只持有 `db_path`/`data_dir` 两个值（它在自己的任务里独立开连接），把 `jobs::resume_poll(app, db_path, data_dir, ...)` 的参数改成 `db_path: PathBuf, data_dir: PathBuf`，避免 `AppState: Clone`。

- [ ] **Step 4: 修改 AppState 与 setup**

`src-tauri/src/lib.rs`：

```rust
pub(crate) struct AppState {
    pub(crate) db_path: Mutex<PathBuf>,
    pub(crate) data_dir: PathBuf,
}
```

setup 中：

```rust
app.manage(AppState { db_path: Mutex::new(db_path), data_dir: app_data.clone() });
```

同时在 lib.rs 里加资产桶配置读取（连接参数存 app_settings，密钥只在 keychain；Task 20 的 `save_asset_host`/`load_asset_host` 复用它）：

```rust
pub(crate) fn asset_host_internal(state: &AppState) -> Result<gateway::transport::AssetHostConfig, String> {
    let path = state.db_path.lock().map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    let stored: Option<String> = connection
        .query_row("SELECT value FROM app_settings WHERE key='asset_host'", [], |row| row.get(0))
        .ok();
    let mut config: gateway::transport::AssetHostConfig = match stored {
        Some(payload) => serde_json::from_str(&payload).unwrap_or_default(),
        None => gateway::transport::AssetHostConfig::default(),
    };
    if let Ok(entry) = Entry::new("com.frameforge.studio", "asset-host/access-key") {
        config.access_key = entry.get_password().ok();
    }
    if let Ok(entry) = Entry::new("com.frameforge.studio", "asset-host/secret-key") {
        config.secret_key = entry.get_password().ok();
    }
    Ok(config)
}
```

并把 `resume_pending` 放在 setup 末尾用 `tauri::async_runtime::spawn` 调用（Task 14 完成 jobs 后）。

- [ ] **Step 5: 运行测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml runs::tests`
Expected: PASS（2 tests）。需要 `uuid` 依赖：在 Cargo.toml 加 `uuid = { version = "1", features = ["v4"] }`。若 `AppState` 未 `pub`，改为 `pub(crate) struct AppState` 并让字段 `pub(crate)`。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/runs.rs src-tauri/src/jobs.rs src-tauri/src/lib.rs
git commit -m "feat(p0): 运行记录、缓存命中与同步结果落盘"
```

---

### Task 14: 异步视频轮询、取消与重启恢复

**Files:**
- Modify: `src-tauri/src/jobs.rs`（Task 13 已落 `attach_task` 的任务落库，这里补轮询、取消与启动恢复）
- Modify: `src-tauri/src/runs.rs`（新增 `store_outputs_for_poll`）
- Modify: `src-tauri/src/lib.rs`（`mod jobs;`；setup 调用 `jobs::resume_pending_on_start`)
- Test: `src-tauri/src/jobs.rs` 内联测试

**Interfaces:**
- Consumes: `runs`、`gateway::minimax`、`db`、`keyring`。
- Produces:
  - `jobs::attach_task(app, state, run, job_id, task_id, request, runtime, model)`
  - `jobs::poll_delay(attempt: u32) -> Duration`
  - `jobs::should_resume(status: &str, remote_task_id: Option<&str>) -> bool`
  - `jobs::resume_pending_on_start(app, state)`
  - `jobs::cancel(app, state, run_id)`

- [ ] **Step 1: 写失败测试**

`src-tauri/src/jobs.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(poll_delay(0), std::time::Duration::from_secs(2));
        assert_eq!(poll_delay(1), std::time::Duration::from_secs(3));
        assert_eq!(poll_delay(2), std::time::Duration::from_secs(5));
        assert_eq!(poll_delay(9), std::time::Duration::from_secs(15));
    }

    #[test]
    fn resume_only_when_remote_task_exists() {
        assert!(!should_resume("queued", None));
        assert!(should_resume("submitted", Some("task_1")));
        assert!(should_resume("polling", Some("task_1")));
        assert!(!should_resume("succeeded", Some("task_1")));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml jobs::tests`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 jobs.rs**

```rust
use crate::db;
use crate::gateway::{self, ModelConfig, ProviderRuntime};
use crate::runs::{self, RunRecord, StartRunRequest};
use crate::AppState;
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub fn poll_delay(attempt: u32) -> Duration {
    Duration::from_secs(match attempt {
        0 => 2, 1 => 3, 2 => 5, 3 => 8, 4 => 12, _ => 15,
    })
}

pub fn should_resume(status: &str, remote_task_id: Option<&str>) -> bool {
    matches!(status, "submitted" | "polling") && remote_task_id.is_some()
}

fn db_connection(state: &AppState) -> Result<rusqlite::Connection, String> {
    let path = runs::db_path(state)?;
    db::open(&path)
}

fn set_job(app: &AppHandle, state: &AppState, job_id: &str, status: &str, remote_task_id: Option<&str>, attempts: u32) {
    if let Ok(connection) = db_connection(state) {
        let _ = connection.execute(
            "UPDATE jobs SET status=?1, remote_task_id=COALESCE(?2, remote_task_id), attempts=?3, updated_at=?4 WHERE id=?5",
            rusqlite::params![status, remote_task_id, attempts, chrono::Utc::now().to_rfc3339(), job_id],
        );
    }
    let _ = app.emit("job.updated", json!({ "id": job_id, "status": status, "attempts": attempts }));
}

pub fn attach_task(
    app: &AppHandle,
    state: &AppState,
    run: &RunRecord,
    job_id: &str,
    task_id: &str,
    request: StartRunRequest,
    runtime: ProviderRuntime,
    model: ModelConfig,
) {
    if let Ok(connection) = db_connection(state) {
        let payload = serde_json::to_string(&request).unwrap_or_default();
        let _ = connection.execute(
            "INSERT INTO jobs (id, run_id, provider_id, capability, remote_task_id, status, attempts, next_poll_at, payload, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'submitted', 0, NULL, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET remote_task_id=excluded.remote_task_id, status='submitted', payload=excluded.payload, updated_at=excluded.updated_at",
            rusqlite::params![job_id, run.id, request.provider_id, request.capability, task_id, payload, chrono::Utc::now().to_rfc3339()],
        );
    }
    set_job(app, state, job_id, "submitted", Some(task_id), 0);
    let app = app.clone();
    let db_path = runs::db_path(state).unwrap_or_default();
    let data_dir = state.data_dir.clone();
    let run = run.clone();
    let job_id = job_id.to_string();
    let task_id = task_id.to_string();
    tauri::async_runtime::spawn(async move {
        poll_loop(app, db_path, data_dir, run, job_id, task_id, request, runtime, model).await;
    });
}

async fn poll_loop(
    app: AppHandle,
    db_path: PathBuf,
    data_dir: PathBuf,
    run: RunRecord,
    job_id: String,
    task_id: String,
    request: StartRunRequest,
    runtime: ProviderRuntime,
    model: ModelConfig,
) {
    let client = match crate::http_client() {
        Ok(client) => client,
        Err(message) => {
            finish_failed(&app, &db_path, &run, gateway::AppError::new("UNAVAILABLE_HTTP", message, false));
            return;
        }
    };
    let started = std::time::Instant::now();
    let mut attempt = 0u32;
    loop {
        tokio::time::sleep(poll_delay(attempt)).await;
        if is_cancelled(&db_path, &run.id) {
            let _ = gateway::minimax::cancel(&client, &runtime, &model, &task_id).await;
            finish_cancelled(&app, &db_path, &run);
            return;
        }
        if started.elapsed() > Duration::from_secs(20 * 60) {
            finish_failed(&app, &db_path, &run, gateway::AppError::new("TIMEOUT_TASK", "视频任务轮询超时", true));
            return;
        }
        match gateway::minimax::poll(&client, &runtime, &model, &task_id).await {
            Ok(status) if status.status == "succeeded" => {
                match crate::runs::store_outputs_for_poll(&app, &db_path, &data_dir, &run, status.outputs).await {
                    Ok(assets) => finish_succeeded(&app, &db_path, &run, assets),
                    Err(error) => finish_failed(&app, &db_path, &run, error),
                }
                set_job_values(&db_path, &job_id, "succeeded", attempt);
                return;
            }
            Ok(status) if status.status == "failed" => {
                let error = status.error.unwrap_or_else(|| gateway::AppError::new("TASK_FAILED", "视频任务失败", false));
                finish_failed(&app, &db_path, &run, error);
                set_job_values(&db_path, &job_id, "failed", attempt);
                return;
            }
            Ok(status) if status.status == "cancelled" => {
                finish_cancelled(&app, &db_path, &run);
                set_job_values(&db_path, &job_id, "cancelled", attempt);
                return;
            }
            Ok(status) => {
                set_job_values(&db_path, &job_id, "polling", attempt);
                let _ = app.emit("job.updated", json!({ "id": job_id, "status": "polling", "progress": status.progress, "rawStatus": status.raw_status }));
                attempt = attempt.saturating_add(1);
            }
            Err(error) if error.retryable && attempt < 8 => {
                attempt = attempt.saturating_add(1);
            }
            Err(error) => {
                finish_failed(&app, &db_path, &run, error);
                set_job_values(&db_path, &job_id, "failed", attempt);
                return;
            }
        }
    }
}

fn set_job_values(db_path: &PathBuf, job_id: &str, status: &str, attempts: u32) {
    if let Ok(connection) = db::open(db_path) {
        let _ = connection.execute(
            "UPDATE jobs SET status=?1, attempts=?2, updated_at=?3 WHERE id=?4",
            rusqlite::params![status, attempts, chrono::Utc::now().to_rfc3339(), job_id],
        );
    }
}

fn is_cancelled(db_path: &PathBuf, run_id: &str) -> bool {
    db::open(db_path)
        .ok()
        .and_then(|connection| connection.query_row("SELECT status FROM runs WHERE id=?1", [run_id], |row| row.get::<_, String>(0)).ok())
        .map(|status| status == "cancelled")
        .unwrap_or(false)
}

fn finish_succeeded(app: &AppHandle, db_path: &PathBuf, run: &RunRecord, assets: Vec<crate::assets::AssetRef>) {
    let mut finished = run.clone();
    finished.status = "succeeded".to_string();
    finished.output_asset_ids = assets.iter().map(|asset| asset.id.clone()).collect();
    finished.selected_asset_id = finished.output_asset_ids.first().cloned();
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    if let Ok(connection) = db::open(db_path) {
        let payload = serde_json::to_string(&finished).unwrap_or_default();
        let _ = connection.execute(
            "UPDATE runs SET status='succeeded', payload=?1, updated_at=?2 WHERE id=?3",
            rusqlite::params![payload, chrono::Utc::now().to_rfc3339(), finished.id],
        );
    }
    let _ = app.emit("run.updated", &runs::RunUpdatedEvent { run: finished, assets });
}

fn finish_failed(app: &AppHandle, db_path: &PathBuf, run: &RunRecord, error: gateway::AppError) {
    let mut finished = run.clone();
    finished.status = "failed".to_string();
    finished.error = Some(error);
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    if let Ok(connection) = db::open(db_path) {
        let payload = serde_json::to_string(&finished).unwrap_or_default();
        let _ = connection.execute(
            "UPDATE runs SET status='failed', payload=?1, updated_at=?2 WHERE id=?3",
            rusqlite::params![payload, chrono::Utc::now().to_rfc3339(), finished.id],
        );
    }
    let _ = app.emit("run.updated", &runs::RunUpdatedEvent { run: finished, assets: Vec::new() });
}

fn finish_cancelled(app: &AppHandle, db_path: &PathBuf, run: &RunRecord) {
    let mut finished = run.clone();
    finished.status = "cancelled".to_string();
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    if let Ok(connection) = db::open(db_path) {
        let payload = serde_json::to_string(&finished).unwrap_or_default();
        let _ = connection.execute(
            "UPDATE runs SET status='cancelled', payload=?1, updated_at=?2 WHERE id=?3",
            rusqlite::params![payload, chrono::Utc::now().to_rfc3339(), finished.id],
        );
    }
    let _ = app.emit("run.updated", &runs::RunUpdatedEvent { run: finished, assets: Vec::new() });
}

pub fn cancel(app: &AppHandle, state: &AppState, run_id: &str) {
    if let Ok(run) = runs::load_run(state, run_id) {
        let _ = runs::mark_cancelled(state, run_id);
        let _ = app.emit("run.updated", &runs::RunUpdatedEvent { run, assets: Vec::new() });
    }
}

pub fn resume_pending_on_start(app: AppHandle, state: &AppState) {
    let path = match runs::db_path(state) {
        Ok(path) => path,
        Err(_) => return,
    };
    let connection = match db::open(&path) {
        Ok(connection) => connection,
        Err(_) => return,
    };
    let mut statement = match connection.prepare(
        "SELECT id, run_id, provider_id, remote_task_id, payload FROM jobs WHERE status IN ('submitted','polling')",
    ) {
        Ok(statement) => statement,
        Err(_) => return,
    };
    let rows: Vec<(String, String, String, Option<String>, String)> = match statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })
        .and_then(|mapped| mapped.collect::<Result<Vec<_>, _>>())
    {
        Ok(rows) => rows,
        Err(_) => return,
    };
    for (job_id, run_id, provider_id, remote_task_id, payload) in rows {
        let task_id = match remote_task_id {
            Some(task_id) => task_id,
            None => continue,
        };
        let request: StartRunRequest = match serde_json::from_str(&payload) {
            Ok(request) => request,
            Err(_) => continue,
        };
        let key = match crate::load_provider_credential(provider_id.clone()) {
            Ok(Some(key)) => key,
            _ => continue,
        };
        let profile = match runs::load_provider_profile(state, &provider_id) {
            Ok(Some(profile)) => profile,
            _ => continue,
        };
        let model = match profile.models.iter().find(|item| item.id == request.model) {
            Some(model) => model.clone(),
            None => continue,
        };
        let run = match runs::load_run(state, &run_id) {
            Ok(run) => run,
            Err(_) => continue,
        };
        let runtime = ProviderRuntime { profile, api_key: key };
        let db_path = path.clone();
        let data_dir = state.data_dir.clone();
        let handle = app.clone();
        let job_id = job_id.clone();
        tauri::async_runtime::spawn(async move {
            poll_loop(
                handle,
                db_path,
                data_dir,
                run,
                job_id,
                task_id,
                request,
                runtime,
                model,
            )
            .await;
        });
    }
}
```

注意：`resume_pending` 从 Task 13 整体下移到本任务——它的语义就是「扫表 + 恢复轮询」，而轮询器只有到本任务才存在。上一版计划把它放在 runs.rs 并调用 `crate::jobs::resume_poll`，Task 13 编译不过；现在改成 jobs.rs 内部直接 spawn `poll_loop`，少一层转发。

轮询器只持有 `db_path`/`data_dir` 两个值（它在自己的任务里独立开连接），而 Task 13 的 `store_outputs` 收的是 `&AppState`。不要重写 `store_outputs` 的内部逻辑，加一层薄适配即可——`AppState` 的两个字段在 Task 13 已是 `pub(crate)`，可以在 jobs.rs 里现场组装：

在 `src-tauri/src/runs.rs` 的 `store_outputs` 之后追加：

```rust
pub(crate) async fn store_outputs_for_poll(
    app: &AppHandle,
    db_path: &std::path::PathBuf,
    data_dir: &std::path::PathBuf,
    run: &RunRecord,
    outputs: Vec<gateway::AssetPayload>,
) -> Result<Vec<AssetRef>, AppError> {
    let state = crate::AppState {
        db_path: std::sync::Mutex::new(db_path.clone()),
        data_dir: data_dir.clone(),
    };
    store_outputs(app, &state, run, outputs).await
}
```

`succeed_run`/`fail_run` 的事件发送仍留在 runs.rs 的同步路径里，poller 用 jobs.rs 自己的 `finish_succeeded`/`finish_failed`（上面已给出），两者互不复用。

- [ ] **Step 4: 注册模块与启动恢复**

`src-tauri/src/lib.rs` 的 `mod jobs;`、`mod runs;` 在 Task 13 已加好，本任务只需在 setup 末尾追加：

```rust
{
    let handle = app.handle().clone();
    let state = app.state::<AppState>();
    // AppState 不能 clone；在 setup 内直接调用同步扫描，轮询任务内部自行拿连接
    jobs::resume_pending_on_start(handle, &state);
}
```

`app.state::<AppState>()` 在 setup 闭包内是同步借用的，`resume_pending_on_start` 又是同步函数（内部只做「扫表 + spawn」），所以这个写法成立，不要为了它再加一个 `resume_from_paths`。若编译真的报 `State<'_, AppState>` 生命周期问题，唯一允许的方向是在 setup 里把两个字段拷出来再组装一个临时 owned `AppState` 传进去：

```rust
{
    let handle = app.handle().clone();
    let state = app.state::<AppState>();
    let owned = AppState {
        db_path: std::sync::Mutex::new(state.db_path.lock().map_err(|_| "db lock".to_string())?.clone()),
        data_dir: state.data_dir.clone(),
    };
    jobs::resume_pending_on_start(handle, &owned);
}
```

注意这段只作为编译兜底：`setup` 返回 `Result` 时才能用 `?`，若当前 setup 是 `Ok(())` 结尾就把它包进 `if let Ok(...)`，不要用 `unwrap` 让启动崩掉。

- [ ] **Step 5: 运行测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml jobs::tests`
Expected: PASS（2 tests）。`store_outputs_for_poll` 已在上一步给出实现，若仍报未定义，检查它是否写在 `runs.rs` 且是 `pub(crate)`，不要改成公开 API。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/jobs.rs src-tauri/src/runs.rs src-tauri/src/lib.rs
git commit -m "feat(p0): 异步视频轮询、取消与启动恢复"
```

---

### Task 15: Tauri 命令注册与前端桥

**Files:**
- Modify: `src-tauri/src/lib.rs`（新增命令、注册、`app_settings` 读写）
- Modify: `src-tauri/src/runs.rs`（`store_outputs_for_poll` 导出）
- Create: `src/services/tauri.ts`
- Create: `src/services/events.ts`
- Test: `src/services/tauri.test.ts`（仅测类型映射辅助函数）

**Interfaces:**
- Consumes: 所有 Rust 模块。
- Produces（命令）：
  - `list_studio_projects` / `save_studio_project`
  - `list_boards` / `load_board` / `save_board` / `delete_board`
  - `list_provider_profiles` / `save_provider_profile` / `provider_has_key` / `test_provider_profile`
  - `save_asset_host` / `load_asset_host`
  - `start_run` / `cancel_run` / `list_runs` / `select_run_candidate` / `resume_jobs`
  - `asset_file_path` / `read_asset_text`
  - 注：`import_asset` 在 Task 22 随旧项目导入一起实现，本 Task 不注册。
- Produces（前端）：`src/services/tauri.ts` 中同名 camelCase 包装函数。

- [ ] **Step 1: 在 lib.rs 顶部声明模块并新增命令**

```rust
mod assets;
mod db;
mod gateway;
mod jobs;
mod runs;
mod security;
```

在 `src-tauri/src/lib.rs` 的 `use` 区域追加（与既有 `use tauri::...` 放在一起）：

```rust
use keyring::Entry;
use std::sync::Mutex;
```

`keyring = { version = "3", features = ["apple-native"] }` 已存在于 `Cargo.toml`，无需新增依赖；若缺失则补上。

下面这些命令会用到三个基元（Task 13/14 已经以 `crate::load_provider_credential` 的形式引用它，本 Step 把它补齐）。追加在模块作用域、`run()` 之前：

```rust
const CREDENTIAL_ACCOUNT_PREFIX: &str = "provider/";
const KEYCHAIN_SERVICE: &str = "com.frameforge.studio";

// 精确匹配而非子串：RunRecord.cacheKey 必须保留，否则导入/重启后缓存命中与 stale 判定全部失效。
const SENSITIVE_KEYS: [&str; 16] = [
    "apikey", "api_key", "secretkey", "secret_key", "accesskey", "access_key",
    "accesskeyid", "secretaccesskey", "authorization", "bearer", "token", "accesstoken",
    "password", "credential", "credentials", "key",
];

pub(crate) fn strip_sensitive_fields(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|field, _| !SENSITIVE_KEYS.contains(&field.to_ascii_lowercase().as_str()));
            for nested in map.values_mut() {
                strip_sensitive_fields(nested);
            }
        }
        Value::Array(items) => {
            for nested in items.iter_mut() {
                strip_sensitive_fields(nested);
            }
        }
        _ => {}
    }
}

pub(crate) fn load_provider_credential(provider_id: String) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &format!("{}{}", CREDENTIAL_ACCOUNT_PREFIX, provider_id))
        .map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_provider_credential(provider_id: String, api_key: String) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    if provider_id.trim().is_empty() {
        return Err("Provider 缺少 id".to_string());
    }
    Entry::new(KEYCHAIN_SERVICE, &format!("{}{}", CREDENTIAL_ACCOUNT_PREFIX, provider_id))
        .map_err(|error| error.to_string())?
        .set_password(trimmed)
        .map_err(|error| error.to_string())?;
    Ok(())
}
```

`strip_sensitive_fields` 的入参是 `&mut Value`，`save_studio_project`/`save_provider_profile` 必须把参数声明成 `mut project: Value` / `mut profile: Value`（本 Task 的代码块已经是这个签名）。Task 22 与 Task 23 会以 `crate::strip_sensitive_fields` 复用同一个函数，所以这里就把它定成 `pub(crate)`，不要留到后面再改。

新增命令（追加在 `run()` 之前）：

```rust
#[tauri::command]
fn list_studio_projects(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection.prepare("SELECT payload FROM studio_projects ORDER BY updated_at DESC").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
    rows.map(|row| serde_json::from_str(&row.map_err(|error| error.to_string())?).map_err(|error| error.to_string())).collect()
}

#[tauri::command]
fn save_studio_project(mut project: Value, state: State<'_, AppState>) -> Result<(), String> {
    let id = project.get("id").and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("项目缺少 id")?;
    let name = project.get("name").and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("项目缺少名称")?;
    strip_sensitive_fields(&mut project);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let now = Utc::now().to_rfc3339();
    connection.execute(
        "INSERT INTO studio_projects (id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
        params![id, name, serde_json::to_string(&project).map_err(|error| error.to_string())?, now],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_boards(project_id: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection.prepare("SELECT payload FROM boards WHERE project_id=?1 ORDER BY updated_at DESC").map_err(|error| error.to_string())?;
    let rows = statement.query_map([project_id], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
    rows.map(|row| serde_json::from_str(&row.map_err(|error| error.to_string())?).map_err(|error| error.to_string())).collect()
}

#[tauri::command]
fn load_board(board_id: String, state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection.prepare("SELECT payload FROM boards WHERE id=?1").map_err(|error| error.to_string())?;
    let mut rows = statement.query([board_id]).map_err(|error| error.to_string())?;
    match rows.next().map_err(|error| error.to_string())? {
        Some(row) => Ok(Some(serde_json::from_str(&row.get::<_, String>(0).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?)),
        None => Ok(None),
    }
}

#[tauri::command]
fn save_board(board: Value, state: State<'_, AppState>) -> Result<(), String> {
    let id = board.get("id").and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("画布缺少 id")?;
    let project_id = board.get("projectId").and_then(Value::as_str).ok_or("画布缺少 projectId")?;
    let name = board.get("name").and_then(Value::as_str).unwrap_or("未命名画布");
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let now = Utc::now().to_rfc3339();
    connection.execute(
        "INSERT INTO boards (id, project_id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
        params![id, project_id, name, serde_json::to_string(&board).map_err(|error| error.to_string())?, now],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_board(board_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    db::open(&path)?.execute("DELETE FROM boards WHERE id=?1", [board_id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_provider_profiles(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection.prepare("SELECT payload FROM provider_profiles ORDER BY id").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
    rows.map(|row| serde_json::from_str(&row.map_err(|error| error.to_string())?).map_err(|error| error.to_string())).collect()
}

#[tauri::command]
fn save_provider_profile(mut profile: Value, state: State<'_, AppState>) -> Result<(), String> {
    strip_sensitive_fields(&mut profile);
    let id = profile.get("id").and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("Provider 缺少 id")?;
    let adapter = profile.get("adapter").and_then(Value::as_str).unwrap_or("openai-compatible");
    let base_url = profile.get("baseUrl").and_then(Value::as_str).unwrap_or("");
    let enabled = profile.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    connection.execute(
        "INSERT INTO provider_profiles (id, adapter, base_url, enabled, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET adapter=excluded.adapter, base_url=excluded.base_url, enabled=excluded.enabled, payload=excluded.payload, updated_at=excluded.updated_at",
        params![id, adapter, base_url, enabled, serde_json::to_string(&profile).map_err(|error| error.to_string())?, Utc::now().to_rfc3339()],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn provider_has_key(provider_id: String) -> Result<bool, String> {
    Ok(load_provider_credential(provider_id)?.is_some())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTestResult {
    ok: bool,
    message: String,
    model_count: Option<usize>,
}

#[tauri::command]
async fn test_provider_profile(provider_id: String, state: State<'_, AppState>) -> Result<ProviderTestResult, String> {
    let profile = runs::load_provider_profile(&state, &provider_id)?
        .ok_or_else(|| "Provider 未配置".to_string())?;
    let key = load_provider_credential(provider_id.clone())?.ok_or_else(|| "尚未保存 API Key".to_string())?;
    let client = http_client()?;
    if profile.adapter == "openai-compatible" {
        let url = if profile.base_url.trim_end_matches('/').ends_with("/v1") {
            format!("{}/models", profile.base_url.trim_end_matches('/'))
        } else {
            format!("{}/v1/models", profile.base_url.trim_end_matches('/'))
        };
        let response = client.get(url).bearer_auth(&key).send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            let count = value.get("data").and_then(Value::as_array).map(Vec::len);
            return Ok(ProviderTestResult { ok: true, message: "连接成功".to_string(), model_count: count });
        }
        return Ok(ProviderTestResult { ok: false, message: format!("连接失败：HTTP {}", status.as_u16()), model_count: None });
    }
    Ok(ProviderTestResult { ok: true, message: "配置已保存，视频接口将在首次生成时验证".to_string(), model_count: None })
}

#[tauri::command]
fn save_asset_host(config: Value, state: State<'_, AppState>) -> Result<(), String> {
    let access_key = config.get("accessKey").and_then(Value::as_str).unwrap_or("");
    let secret_key = config.get("secretKey").and_then(Value::as_str).unwrap_or("");
    if !access_key.is_empty() {
        Entry::new("com.frameforge.studio", "asset-host/access-key").map_err(|error| error.to_string())?.set_password(access_key).map_err(|error| error.to_string())?;
    }
    if !secret_key.is_empty() {
        Entry::new("com.frameforge.studio", "asset-host/secret-key").map_err(|error| error.to_string())?.set_password(secret_key).map_err(|error| error.to_string())?;
    }
    let mut public = config.clone();
    if let Some(object) = public.as_object_mut() {
        object.remove("accessKey");
        object.remove("secretKey");
    }
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    db::open(&path)?.execute(
        "INSERT INTO app_settings (key, value) VALUES ('asset_host', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(&public).map_err(|error| error.to_string())?],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn asset_host_internal(state: &AppState) -> Result<gateway::transport::AssetHostConfig, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let value: Option<String> = connection.query_row("SELECT value FROM app_settings WHERE key='asset_host'", [], |row| row.get(0)).ok();
    let mut config: gateway::transport::AssetHostConfig = value
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    config.access_key = Entry::new("com.frameforge.studio", "asset-host/access-key").ok()
        .and_then(|entry| entry.get_password().ok());
    config.secret_key = Entry::new("com.frameforge.studio", "asset-host/secret-key").ok()
        .and_then(|entry| entry.get_password().ok());
    Ok(config)
}

#[tauri::command]
fn load_asset_host(state: State<'_, AppState>) -> Result<Value, String> {
    let config = asset_host_internal(&state)?;
    Ok(serde_json::json!({
        "strategy": config.strategy,
        "endpoint": config.endpoint,
        "bucket": config.bucket,
        "region": config.region,
        "prefix": config.prefix,
        "publicBaseUrl": config.public_base_url,
        "hasCredentials": config.access_key.is_some() && config.secret_key.is_some()
    }))
}

#[tauri::command]
async fn start_run(request: runs::StartRunRequest, app: AppHandle, state: State<'_, AppState>) -> Result<runs::RunRecord, String> {
    let profile = runs::load_provider_profile(&state, &request.provider_id)?
        .ok_or_else(|| "Provider 未配置".to_string())?;
    if !profile.enabled {
        return Err("Provider 已禁用".to_string());
    }
    if let Some(asset_id) = request.cached_asset_id.clone() {
        return runs::finish_cached(&state, &request, &asset_id);
    }
    let key = load_provider_credential(request.provider_id.clone())?
        .ok_or_else(|| "尚未保存该 Provider 的 API Key".to_string())?;
    let runtime = gateway::ProviderRuntime { profile, api_key: key };
    let run = runs::create_run(&state, &request)?;
    let job_id = format!("job_{}", uuid::Uuid::new_v4());
    let db_path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    db::open(&db_path)?.execute(
        "INSERT INTO jobs (id, run_id, provider_id, capability, status, attempts, payload, updated_at) VALUES (?1, ?2, ?3, ?4, 'queued', 0, ?5, ?6)",
        params![job_id, run.id, request.provider_id, request.capability, serde_json::to_string(&request).map_err(|error| error.to_string())?, Utc::now().to_rfc3339()],
    ).map_err(|error| error.to_string())?;
    let state_clone = AppState {
        db_path: Mutex::new(db_path),
        data_dir: state.data_dir.clone(),
    };
    let app_clone = app.clone();
    let run_clone = run.clone();
    tauri::async_runtime::spawn(async move {
        runs::execute_run(app_clone, state_clone, run_clone, job_id, request, runtime).await;
    });
    Ok(run)
}

#[tauri::command]
fn cancel_run(run_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    jobs::cancel(&app, &state, &run_id);
    Ok(())
}

#[tauri::command]
fn list_runs(board_id: String, state: State<'_, AppState>) -> Result<Vec<runs::RunRecord>, String> {
    runs::list_runs(&state, &board_id)
}

#[tauri::command]
fn select_run_candidate(run_id: String, asset_id: String, state: State<'_, AppState>) -> Result<runs::RunRecord, String> {
    runs::select_candidate(&state, &run_id, &asset_id)
}

#[tauri::command]
fn resume_jobs(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    runs::resume_pending(app, &state)
}

#[tauri::command]
fn asset_file_path(asset_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let payload: String = connection.query_row("SELECT payload FROM assets WHERE id=?1", [asset_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let asset: assets::AssetRef = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    Ok(assets::absolute_path(&state.data_dir, &asset.path)?.to_string_lossy().to_string())
}

#[tauri::command]
fn read_asset_text(asset_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let payload: String = connection.query_row("SELECT payload FROM assets WHERE id=?1", [asset_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let asset: assets::AssetRef = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    std::fs::read_to_string(assets::absolute_path(&state.data_dir, &asset.path)?).map_err(|error| error.to_string())
}
```

上面已把 `save_studio_project` 的参数改成 `mut project: Value` 并直接 `strip_sensitive_fields(&mut project)`；如果实现时保留了旧签名，必须同时改签名，否则无法编译。

- [ ] **Step 2: 注册命令**

在 `invoke_handler(tauri::generate_handler![...])` 列表里追加：

```rust
list_studio_projects,
save_studio_project,
list_boards,
load_board,
save_board,
delete_board,
list_provider_profiles,
save_provider_profile,
save_provider_credential,
provider_has_key,
test_provider_profile,
save_asset_host,
load_asset_host,
start_run,
cancel_run,
list_runs,
select_run_candidate,
resume_jobs,
asset_file_path,
read_asset_text
```

- [ ] **Step 3: 写前端桥**

`src/services/tauri.ts`：

```ts
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type { AssetRef, BoardDoc, JobRecord, ProviderProfile, RunRecord, StudioProject } from '../domain/types';

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function listStudioProjects(): Promise<StudioProject[]> {
  if (!isTauri()) return [];
  return invoke<StudioProject[]>('list_studio_projects');
}

export async function saveStudioProject(project: StudioProject): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_studio_project', { project });
}

export async function listBoards(projectId: string): Promise<BoardDoc[]> {
  if (!isTauri()) return [];
  return invoke<BoardDoc[]>('list_boards', { projectId });
}

export async function loadBoard(boardId: string): Promise<BoardDoc | null> {
  if (!isTauri()) return null;
  return invoke<BoardDoc | null>('load_board', { boardId });
}

export async function saveBoard(board: BoardDoc): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_board', { board });
}

export async function deleteBoard(boardId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('delete_board', { boardId });
}

export async function listProviderProfiles(): Promise<ProviderProfile[]> {
  if (!isTauri()) return [];
  return invoke<ProviderProfile[]>('list_provider_profiles');
}

export async function saveProviderProfile(profile: ProviderProfile): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_provider_profile', { profile });
}

export async function setProviderKey(providerId: string, apiKey: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_provider_credential', { providerId, apiKey });
}

export async function providerHasKey(providerId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('provider_has_key', { providerId });
}

export interface ProviderTestResult { ok: boolean; message: string; modelCount?: number }

export async function testProviderProfile(providerId: string): Promise<ProviderTestResult> {
  if (!isTauri()) return { ok: false, message: '请在桌面应用中测试连接' };
  return invoke<ProviderTestResult>('test_provider_profile', { providerId });
}

export interface AssetHostConfig {
  strategy: 'dataUrl' | 's3';
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  publicBaseUrl?: string;
  accessKey?: string;
  secretKey?: string;
}

export async function saveAssetHost(config: AssetHostConfig): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_asset_host', { config });
}

export async function loadAssetHost(): Promise<AssetHostConfig & { hasCredentials?: boolean }> {
  if (!isTauri()) return { strategy: 'dataUrl' };
  return invoke<AssetHostConfig & { hasCredentials?: boolean }>('load_asset_host');
}

export interface StartRunInput {
  schemaVersion: 1;
  projectId: string;
  boardId: string;
  nodeId: string;
  capability: string;
  providerId: string;
  model: string;
  promptSnapshot: RunRecord['promptSnapshot'];
  params: Record<string, unknown>;
  inputs: Array<{ role: string; assetId: string; kind: string; mime: string }>;
  inputAssetIds: string[];
  cacheKey: string;
  cachedAssetId?: string;
}

export async function startRun(request: StartRunInput): Promise<RunRecord> {
  if (!isTauri()) throw new Error('生成只能在桌面应用中运行');
  return invoke<RunRecord>('start_run', { request });
}

export async function cancelRun(runId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('cancel_run', { runId });
}

export async function listRuns(boardId: string): Promise<RunRecord[]> {
  if (!isTauri()) return [];
  return invoke<RunRecord[]>('list_runs', { boardId });
}

export async function selectRunCandidate(runId: string, assetId: string): Promise<RunRecord> {
  if (!isTauri()) throw new Error('选择候选只能在桌面应用中运行');
  return invoke<RunRecord>('select_run_candidate', { runId, assetId });
}

export async function resumeJobs(): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>('resume_jobs');
}

export async function assetUrl(assetId: string): Promise<string> {
  if (!isTauri()) return '';
  const path = await invoke<string>('asset_file_path', { assetId });
  return convertFileSrc(path);
}

export async function readAssetText(assetId: string): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('read_asset_text', { assetId });
}

export type { AssetRef, JobRecord };
```

`src/services/events.ts`：

```ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AssetRef, RunRecord } from '../domain/types';

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface RunUpdatedEvent { run: RunRecord; assets: AssetRef[] }
export interface JobUpdatedEvent {
  id: string;
  status: string;
  progress?: number;
  rawStatus?: string;
  attempts?: number;
}

export async function onRunUpdated(handler: (event: RunUpdatedEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<RunUpdatedEvent>('run.updated', (event) => handler(event.payload));
}

export async function onJobUpdated(handler: (event: JobUpdatedEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<JobUpdatedEvent>('job.updated', (event) => handler(event.payload));
}

export async function onAssetCreated(handler: (asset: AssetRef) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<AssetRef>('asset.created', (event) => handler(event.payload));
}
```

- [ ] **Step 4: 写一个纯映射测试（保证桥模块可加载）**

`src/services/tauri.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../domain/types';

describe('run payload contract', () => {
  it('keeps camelCase keys used by the Rust command', () => {
    const run: RunRecord = {
      id: 'run_1', projectId: 'p1', boardId: 'b1', nodeId: 'n1', action: 'generate',
      cacheKey: 'k', status: 'queued',
      promptSnapshot: { text: 'hi', segments: [], hash: 'h', locked: false },
      params: {}, inputAssetIds: [], outputAssetIds: [],
      startedAt: '2026-10-31T00:00:00.000Z',
    };
    expect(Object.keys(run)).toContain('cacheKey');
    expect(run.promptSnapshot.hash).toBe('h');
  });
});
```

- [ ] **Step 5: 编译并运行测试**

Run:
```bash
pnpm test:unit
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: TS 测试通过；Rust 现有 + 新增测试全部通过。若 `start_run` 命令的 `AppHandle` 注入顺序报错，Tauri 2 要求 `AppHandle` 参数放在 `State` 之前或之后均可，但 `async` 命令返回类型必须 `Result`。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/lib.rs src-tauri/src/runs.rs src/services
git commit -m "feat(p0): 画布/Provider/运行命令与前端桥"
```

---

## 阶段 D — 画布工作台

### Task 16: 应用壳、项目库与画布页签

**Files:**
- Create: `src/ui/tokens.css`
- Create: `src/app/factories.ts`
- Create: `src/app/factories.test.ts`
- Create: `src/stores/studioStore.ts`
- Create: `src/stores/boardStore.ts`（最小保存骨架，Task 17 扩展为命令/撤销）
- Create: `src/app/ProjectLibrary.tsx`
- Create: `src/app/StudioApp.tsx`
- Create: `src/styles/studio.css`
- Modify: `src/main.tsx`
- Modify: `index.html`（`<title>` 改为 Frameforge）

**Interfaces:**
- Consumes: `src/services/tauri.ts` 的项目/画布命令、`newId`、`emptyStyleGuide`。
- Produces:
  - `createStudioProject(name, aspectRatio): StudioProject`
  - `createEmptyBoard(projectId, name?): BoardDoc`
  - `useStudioStore`：`boot()`、`projects`、`boards`、`currentProjectId`、`currentBoardId`、`createProject()`、`selectProject()`、`createBoard()`、`selectBoard()`、`deleteBoard()`
  - `useBoardStore` 最小接口：`board`、`dirty`、`saving`、`saveError`、`lastSavedAt`、`load()`、`flush()`
  - `StudioApp` 作为新的根组件；旧 `src/App.tsx` 不再挂载（文件暂留，Task 22 复用它依赖的 `src/bridge.ts` 做导入）。

- [ ] **Step 1: 写失败的工厂测试**

`src/app/factories.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./factories`。

- [ ] **Step 3: 实现工厂**

`src/app/factories.ts`：

```ts
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
```

- [ ] **Step 4: 写设计 token 与新壳样式**

`src/ui/tokens.css`：

```css
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600;700&display=swap');

:root {
  color-scheme: dark;
  --bg: #111617;
  --panel: #151b1c;
  --panel-2: #1a2223;
  --panel-3: #20292a;
  --line: #2c383a;
  --line-strong: #3a4a4c;
  --text: #e9f0ee;
  --text-muted: #9aa9a7;
  --text-dim: #6f7f7d;
  --mint: #75d8bd;
  --mint-strong: #9ae6d0;
  --warm: #bf7256;
  --danger: #d87368;
  --warning: #d8b66a;
  --radius: 6px;
  --font-ui: 'Noto Sans SC', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'DM Mono', ui-monospace, monospace;
  --node-text: #d8b66a;
  --node-script: #d8b66a;
  --node-image: #b08ad8;
  --node-video: #b08ad8;
  --node-audio: #62c8b4;
  --node-note: #7f908e;
  --node-group: #52605e;
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  color: var(--text);
  background: var(--bg);
  font-family: var(--font-ui);
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; }
button { border: 0; cursor: pointer; background: transparent; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--mint);
  outline-offset: 2px;
}
::selection { background: rgba(117, 216, 189, .28); }
```

`src/styles/studio.css`：

```css
@import '../ui/tokens.css';

.studio-shell { height: 100%; display: grid; grid-template-rows: 54px minmax(0, 1fr) 28px; background: var(--bg); }
.studio-topbar { display: flex; align-items: center; gap: 16px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
.studio-brand { display: flex; align-items: center; gap: 9px; font-family: var(--font-mono); font-size: 13px; letter-spacing: 1px; }
.studio-brand-mark { width: 24px; height: 24px; display: grid; place-items: center; color: #10201d; background: var(--mint); border-radius: 4px; font-weight: 700; }
.studio-crumbs { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--text-muted); font-size: 12px; }
.studio-crumbs b { max-width: 240px; overflow: hidden; color: var(--text); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.studio-topbar-spacer { flex: 1; }
.studio-save-state { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 11px; }
.studio-save-state.saving { color: var(--warning); }
.studio-save-state.dirty { color: var(--mint); }
.studio-save-state .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.studio-body { min-height: 0; display: grid; grid-template-columns: 244px minmax(0, 1fr) 300px; }
.studio-rail { min-height: 0; display: flex; flex-direction: column; gap: 18px; padding: 14px 12px; overflow: auto; border-right: 1px solid var(--line); background: var(--panel); }
.studio-rail h2 { margin: 0 0 8px; color: var(--text-dim); font-size: 10px; font-weight: 500; letter-spacing: .8px; text-transform: uppercase; }
.studio-field { display: grid; gap: 5px; margin-bottom: 8px; }
.studio-field > span { color: var(--text-muted); font-size: 10px; }
.studio-field input, .studio-field select, .studio-field textarea { width: 100%; padding: 7px 8px; color: var(--text); background: var(--panel-3); border: 1px solid var(--line-strong); border-radius: 4px; font-size: 12px; }
.studio-field textarea { min-height: 68px; resize: vertical; }
.studio-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 6px 10px; color: #10201d; background: var(--mint); border-radius: 4px; font-size: 12px; font-weight: 600; }
.studio-button:hover { background: var(--mint-strong); }
.studio-button:disabled { cursor: not-allowed; opacity: .45; }
.studio-button.secondary { color: var(--text); background: var(--panel-3); border: 1px solid var(--line-strong); }
.studio-button.secondary:hover { border-color: var(--mint); background: #26302f; }
.studio-button.danger { color: #ffd9d4; background: #4a2a27; border: 1px solid #6e3b36; }
.studio-list { display: grid; gap: 3px; }
.studio-list button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; color: var(--text-muted); border: 1px solid transparent; border-radius: 4px; text-align: left; font-size: 12px; }
.studio-list button:hover { color: var(--text); background: var(--panel-2); }
.studio-list button.active { color: var(--mint); background: #1c2b28; border-color: #2f4a44; }
.studio-list button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-rail-foot { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--line); }
.studio-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.studio-empty-canvas { flex: 1; display: grid; place-content: center; gap: 8px; color: var(--text-muted); text-align: center; font-size: 12px; }
.studio-empty-canvas b { color: var(--text); font-size: 15px; }
.studio-inspector { min-height: 0; overflow: auto; padding: 14px; border-left: 1px solid var(--line); background: var(--panel); }
.studio-inspector h2 { margin: 0 0 12px; color: var(--text); font-size: 13px; font-weight: 500; }
.studio-inspector p { color: var(--text-muted); font-size: 11px; line-height: 1.7; }
.studio-dock { display: flex; align-items: center; gap: 16px; padding: 0 14px; color: var(--text-dim); border-top: 1px solid var(--line); background: var(--panel); font-family: var(--font-mono); font-size: 10px; }
.studio-dock .error { color: var(--danger); }
.studio-library { flex: 1; overflow: auto; padding: 34px 38px 48px; }
.studio-library-head { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
.studio-library-head h1 { margin: 4px 0 6px; font-size: 26px; font-weight: 600; letter-spacing: -.5px; }
.studio-library-head p { margin: 0; color: var(--text-muted); font-size: 12px; }
.studio-eyebrow { color: var(--mint); font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
.studio-onboarding { max-width: 420px; margin: 8vh auto 0; padding: 24px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.studio-onboarding h1 { margin: 6px 0 8px; font-size: 24px; }
.studio-onboarding p { margin: 0 0 18px; color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.studio-board-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.studio-board-card { display: grid; gap: 8px; padding: 15px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; text-align: left; }
.studio-board-card:hover { border-color: #4b6a64; background: var(--panel-2); }
.studio-board-card b { font-size: 14px; }
.studio-board-card span { color: var(--text-muted); font-family: var(--font-mono); font-size: 10px; }
.studio-board-card .open { color: var(--mint); font-family: var(--font-ui); font-size: 11px; }
.studio-board-create { display: flex; gap: 8px; margin-top: 18px; }
.studio-board-create input { flex: 1; min-width: 0; padding: 8px 9px; color: var(--text); background: var(--panel); border: 1px solid var(--line-strong); border-radius: 4px; font-size: 12px; }
.studio-badge { display: inline-flex; align-items: center; padding: 2px 6px; color: var(--text-muted); background: var(--panel-3); border-radius: 3px; font-family: var(--font-mono); font-size: 9px; }
.studio-badge.mint { color: var(--mint); background: #1c302b; }
.studio-badge.warm { color: #efb39c; background: #38251f; }
@media (max-width: 1180px) { .studio-body { grid-template-columns: 210px minmax(0, 1fr) 264px; } }
@media (max-width: 900px) { .studio-body { grid-template-columns: 190px minmax(0, 1fr); }.studio-inspector { display: none; } }
@media (max-width: 680px) { .studio-body { grid-template-columns: minmax(0, 1fr); }.studio-rail { display: none; }.studio-library { padding: 22px 18px 40px; } }
```

- [ ] **Step 5: 写 studioStore**

`src/stores/studioStore.ts`：

```ts
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
```

- [ ] **Step 6: 写画布保存骨架**

`src/stores/boardStore.ts`（Task 17 会重写为完整版本，这里先保证壳可编译与可保存）：

```ts
import { create } from 'zustand';
import type { BoardDoc } from '../domain/types';
import { saveBoard } from '../services/tauri';

interface BoardState {
  board: BoardDoc | null;
  dirty: boolean;
  saving: boolean;
  saveError?: string;
  lastSavedAt?: string;
  load(board: BoardDoc | null): void;
  markDirty(): void;
  flush(): Promise<void>;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  board: null,
  dirty: false,
  saving: false,

  load(board) {
    set({ board, dirty: false, saveError: undefined, lastSavedAt: board ? new Date().toISOString() : undefined });
  },

  markDirty() {
    set({ dirty: true });
  },

  async flush() {
    const board = get().board;
    if (!board || !get().dirty || get().saving) return;
    set({ saving: true, saveError: undefined });
    try {
      await saveBoard(board);
      set({ saving: false, dirty: false, lastSavedAt: new Date().toISOString() });
    } catch (error) {
      set({ saving: false, saveError: error instanceof Error ? error.message : String(error) });
    }
  },
}));
```

- [ ] **Step 7: 写项目库**

`src/app/ProjectLibrary.tsx`：

```tsx
import { useState } from 'react';
import { FolderKanban, LayoutGrid, Plus } from 'lucide-react';
import type { StudioProject } from '../domain/types';
import { useStudioStore } from '../stores/studioStore';

interface Props {
  onOpenBoard(boardId: string): void;
}

export function ProjectLibrary({ onOpenBoard }: Props) {
  const projects = useStudioStore((state) => state.projects);
  const boards = useStudioStore((state) => state.boards);
  const currentProjectId = useStudioStore((state) => state.currentProjectId);
  const createProject = useStudioStore((state) => state.createProject);
  const createBoard = useStudioStore((state) => state.createBoard);
  const [name, setName] = useState('');
  const [ratio, setRatio] = useState<StudioProject['aspectRatio']>('9:16');
  const [boardName, setBoardName] = useState('');
  const [busy, setBusy] = useState(false);

  const current = projects.find((project) => project.id === currentProjectId);

  async function submitProject(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await createProject(name, ratio);
      setName('');
    } finally {
      setBusy(false);
    }
  }

  async function submitBoard(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const board = await createBoard(boardName);
      setBoardName('');
      if (board) onOpenBoard(board.id);
    } finally {
      setBusy(false);
    }
  }

  if (!current) {
    return (
      <div className="studio-library">
        <form className="studio-onboarding" onSubmit={submitProject}>
          <span className="studio-eyebrow">Frameforge · 画布优先</span>
          <h1>新建第一个项目</h1>
          <p>项目承载画布、提示词与资产。所有生成都由你手动触发，密钥只保存在系统钥匙串。</p>
          <label className="studio-field">
            <span>项目名</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：雨夜追凶" autoFocus />
          </label>
          <label className="studio-field">
            <span>画幅</span>
            <select value={ratio} onChange={(event) => setRatio(event.target.value as StudioProject['aspectRatio'])}>
              <option value="9:16">9:16 竖屏短剧</option>
              <option value="16:9">16:9 横屏</option>
              <option value="1:1">1:1 方形</option>
            </select>
          </label>
          <button className="studio-button" type="submit" disabled={busy}>
            <Plus size={14} /> {busy ? '创建中…' : '创建项目'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="studio-library">
      <div className="studio-library-head">
        <div>
          <span className="studio-eyebrow">项目库</span>
          <h1>{current.name}</h1>
          <p>{current.aspectRatio} · {boards.length} 张画布 · 画布优先工作台</p>
        </div>
        <span className="studio-badge mint">项目 {current.id.slice(-6)}</span>
      </div>
      <div className="studio-board-grid">
        {boards.map((board) => (
          <button key={board.id} className="studio-board-card" onClick={() => onOpenBoard(board.id)}>
            <span><LayoutGrid size={13} /> {Object.keys(board.nodes).length} 节点 · {Object.keys(board.edges).length} 连线</span>
            <b>{board.name}</b>
            <span>{new Date(board.updatedAt).toLocaleString('zh-CN')}</span>
            <span className="open">打开画布 →</span>
          </button>
        ))}
        {!boards.length && (
          <div className="studio-board-card">
            <span><FolderKanban size={13} /> 还没有画布</span>
            <b>从下方创建第一张画布</b>
          </div>
        )}
      </div>
      <form className="studio-board-create" onSubmit={submitBoard}>
        <input value={boardName} onChange={(event) => setBoardName(event.target.value)} placeholder="新画布名称，例如：第一集" />
        <button className="studio-button secondary" type="submit" disabled={busy}>
          <Plus size={14} /> 新建画布
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 8: 写 StudioApp 壳**

`src/app/StudioApp.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { FolderKanban, Plus, Save } from 'lucide-react';
import { ProjectLibrary } from './ProjectLibrary';
import { useStudioStore } from '../stores/studioStore';
import { useBoardStore } from '../stores/boardStore';

export function StudioApp() {
  const boot = useStudioStore((state) => state.boot);
  const booted = useStudioStore((state) => state.booted);
  const error = useStudioStore((state) => state.error);
  const projects = useStudioStore((state) => state.projects);
  const boards = useStudioStore((state) => state.boards);
  const currentProjectId = useStudioStore((state) => state.currentProjectId);
  const currentBoardId = useStudioStore((state) => state.currentBoardId);
  const selectProject = useStudioStore((state) => state.selectProject);
  const selectBoard = useStudioStore((state) => state.selectBoard);
  const createBoard = useStudioStore((state) => state.createBoard);
  const board = useBoardStore((state) => state.board);
  const dirty = useBoardStore((state) => state.dirty);
  const saving = useBoardStore((state) => state.saving);
  const saveError = useBoardStore((state) => state.saveError);
  const lastSavedAt = useBoardStore((state) => state.lastSavedAt);
  const [newBoardName, setNewBoardName] = useState('');

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (!booted || !currentBoardId) return;
    if (useBoardStore.getState().board?.id === currentBoardId) return;
    const snapshot = boards.find((item) => item.id === currentBoardId);
    if (snapshot) useBoardStore.getState().load(snapshot);
  }, [booted, currentBoardId, boards]);

  const project = projects.find((item) => item.id === currentProjectId);

  async function openBoard(id: string) {
    await useBoardStore.getState().flush();
    const next = await selectBoard(id);
    if (next) useBoardStore.getState().load(next);
  }

  async function changeProject(id: string) {
    await useBoardStore.getState().flush();
    await selectProject(id);
  }

  async function addBoard(event: React.FormEvent) {
    event.preventDefault();
    await useBoardStore.getState().flush();
    const next = await createBoard(newBoardName);
    setNewBoardName('');
    if (next) useBoardStore.getState().load(next);
  }

  const saveLabel = saving ? '保存中…' : dirty ? '有未保存改动' : lastSavedAt ? `已保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN')}` : '已保存';

  return (
    <div className="studio-shell">
      <header className="studio-topbar">
        <div className="studio-brand"><span className="studio-brand-mark">F</span> FRAMEFORGE</div>
        <div className="studio-crumbs">
          <FolderKanban size={13} />
          <b>{project?.name ?? '未选择项目'}</b>
          <span>/</span>
          <b>{board?.name ?? '未选择画布'}</b>
        </div>
        <div className="studio-topbar-spacer" />
        <span className={`studio-save-state ${saving ? 'saving' : dirty ? 'dirty' : ''}`}>
          <span className="dot" /> {saveError ? `保存失败：${saveError}` : saveLabel}
        </span>
      </header>

      <div className="studio-body">
        <aside className="studio-rail">
          <section>
            <h2>项目</h2>
            <label className="studio-field">
              <span>当前项目</span>
              <select
                value={currentProjectId ?? ''}
                onChange={(event) => { void changeProject(event.target.value); }}
                disabled={!projects.length}
              >
                {!projects.length && <option value="">尚无项目</option>}
                {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          </section>
          <section>
            <h2>画布</h2>
            <div className="studio-list">
              {boards.map((item) => (
                <button
                  key={item.id}
                  className={item.id === currentBoardId ? 'active' : ''}
                  onClick={() => { void openBoard(item.id); }}
                >
                  <Plus size={12} />
                  <span>{item.name}</span>
                </button>
              ))}
              {!boards.length && <span className="studio-badge">暂无画布</span>}
            </div>
            <form className="studio-board-create" onSubmit={addBoard}>
              <input value={newBoardName} onChange={(event) => setNewBoardName(event.target.value)} placeholder="新画布名称" />
              <button className="studio-button secondary" type="submit" aria-label="新建画布"><Plus size={14} /></button>
            </form>
          </section>
          <div className="studio-rail-foot">
            <button className="studio-button secondary" onClick={() => { void useBoardStore.getState().flush(); }}>
              <Save size={13} /> 立即保存
            </button>
          </div>
        </aside>

        <main className="studio-main">
          {board ? (
            <section className="studio-empty-canvas">
              <b>{board.name}</b>
              <span>{Object.keys(board.nodes).length} 个节点 · {Object.keys(board.edges).length} 条连线</span>
              <span>画布引擎将在 Task 17 接入；当前数据已可自动保存。</span>
            </section>
          ) : (
            <ProjectLibrary onOpenBoard={(id) => { void openBoard(id); }} />
          )}
        </main>

        <aside className="studio-inspector">
          <h2>Inspector</h2>
          {board ? (
            <p>选中画布节点后，在这里编辑提示词、模型参数与候选。当前画布已保存到本地 SQLite。</p>
          ) : (
            <p>先创建或打开一张画布。P0 只支持单节点运行，运行前会显示成本预估并等待确认。</p>
          )}
        </aside>
      </div>

      <footer className="studio-dock">
        <span>{board ? `board ${board.id.slice(-8)}` : 'no-board'}</span>
        <span>{Object.keys(board?.nodes ?? {}).length} nodes</span>
        <span>{Object.keys(board?.edges ?? {}).length} edges</span>
        {error && <span className="error">{error}</span>}
      </footer>
    </div>
  );
}
```

- [ ] **Step 9: 切换根入口**

`src/main.tsx` 改为：

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { StudioApp } from './app/StudioApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><StudioApp /></React.StrictMode>,
);
```

`index.html` 的 `<title>` 改为 `Frameforge`。**不要**再 import `./styles.css`：旧浅色样式会覆盖品牌 token；旧 `App.tsx` 保留但不再挂载。

- [ ] **Step 10: 运行测试与构建**

Run:
```bash
pnpm test:unit
pnpm build
```
Expected: 工厂测试通过；`tsc -b` 无错。若 `useStudioStore` 在 Node 测试里被间接加载导致 `window` 报错，不要给 store 写测试——本 Task 只测纯工厂。

- [ ] **Step 11: 手工验证空态**

Run: `pnpm tauri dev`
Expected: 首次启动显示「新建第一个项目」；创建项目后进入项目库，能看到「主画布」并打开；顶栏显示「已保存」。重启应用后项目与画布仍在。

- [ ] **Step 12: 提交**

```bash
git add src/ui src/app src/stores/studioStore.ts src/styles/studio.css src/main.tsx index.html
git commit -m "feat(p0): 画布优先应用壳与项目库"
```

### Task 17: React Flow 画布、自动保存与撤销

**Files:**
- Create: `src/canvas/mapping.ts`
- Create: `src/canvas/mapping.test.ts`
- Create: `src/canvas/DefaultNode.tsx`
- Create: `src/canvas/CanvasView.tsx`
- Modify: `src/domain/graph/validate.ts`（导出类型兼容函数、新增连接预检）
- Create: `src/domain/graph/connection.test.ts`
- Modify: `src/stores/boardStore.ts`（替换为命令 + 历史 + 防抖保存）
- Modify: `src/styles/studio.css`（画布样式）
- Modify: `src/app/StudioApp.tsx`（挂载 CanvasView）

**Interfaces:**
- Consumes: `applyGraphCommand`、`makeEdge`、`edgeRoleFor`、`createNode`、`validateConnection`、`saveBoard`。
- Produces:
  - `toFlowNodes(doc): Node<StudioNodeData>[]`
  - `toFlowEdges(doc): Edge[]`
  - `danglingEdgeCount(doc): number`
  - `validateConnection(doc, sourceId, sourcePort, targetId, targetPort): Issue[]`
  - `useBoardStore`：`board`、`past`、`future`、`selectedNodeId`、`apply(command, {history?})`、`applyMany()`、`beginGesture()`、`endGesture()`、`undo()`、`redo()`、`select()`、`notify()`、`flush()`
  - `CanvasView`：受控 React Flow 画布，支持拖拽/连线/删除/撤销/重做/自动保存/小地图/节点工具栏。

- [ ] **Step 1: 写连接预检的失败测试**

`src/domain/graph/connection.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node } from './testFixtures';
import { validateConnection } from './validate';

describe('validateConnection', () => {
  it('accepts a text prompt into an image node', () => {
    const doc = makeDoc([node('t', 'text'), node('i', 'image')], []);
    expect(validateConnection(doc, 't', 'text', 'i', 'prompt')).toEqual([]);
  });

  it('rejects an image into the hidden start port of a text-to-video node', () => {
    const doc = makeDoc([node('i', 'image'), node('v', 'video')], []);
    const issues = validateConnection(doc, 'i', 'image', 'v', 'start');
    expect(issues.map((issue) => issue.code)).toContain('GRAPH_PORT_HIDDEN');
  });

  it('rejects a second source on a single-input port', () => {
    const doc = makeDoc(
      [node('t1', 'text'), node('t2', 'text'), node('i', 'image')],
      [edge('e1', 't1', 'i')],
    );
    const issues = validateConnection(doc, 't2', 'text', 'i', 'prompt');
    expect(issues.map((issue) => issue.code)).toContain('GRAPH_SINGLE_INPUT');
  });

  it('rejects incompatible data types', () => {
    const doc = makeDoc([node('a', 'audio'), node('i', 'image')], []);
    const issues = validateConnection(doc, 'a', 'audio', 'i', 'references');
    expect(issues.map((issue) => issue.code)).toContain('GRAPH_TYPE_MISMATCH');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，`validateConnection` 未导出。

- [ ] **Step 3: 增加连接预检**

把 `src/domain/graph/validate.ts` 的 import 改为：

```ts
import { edgeRoleFor, getNodeDefinition, visibleInputPorts } from '../nodes/definitions';
```

把 `function compatible(` 改为：

```ts
export function compatibleTypes(source: DataType, target: DataType): boolean {
  if (source === 'any' || target === 'any' || source === target) return true;
  return IMAGE_LIKE.has(source) && IMAGE_LIKE.has(target);
}
```

并把 `validateEdge` 里的 `compatible(...)` 调用替换为 `compatibleTypes(...)`。同时在该函数中、端口存在性检查之后加入隐藏端口检查：

```ts
  if (!visibleInputPorts(targetDef, target).some((port) => port.key === item.targetPort)) {
    issues.push({ code: 'GRAPH_PORT_HIDDEN', message: '当前节点模式不接受这个端口，请切换模式或改用其他端口', severity: 'error', nodeId: target.id, portKey: target.id });
    return issues;
  }
```

在文件末尾追加：

```ts
export function validateConnection(
  doc: BoardDoc,
  sourceId: string,
  sourcePortKey: string,
  targetId: string,
  targetPortKey: string,
): Issue[] {
  const source = doc.nodes[sourceId];
  const target = doc.nodes[targetId];
  if (!source || !target) {
    return [{ code: 'GRAPH_BROKEN_EDGE', message: '连线的一端不存在', severity: 'error' }];
  }
  const sourceDef = getNodeDefinition(source.type);
  const targetDef = getNodeDefinition(target.type);
  const sourcePort = sourceDef?.outputs.find((port) => port.key === sourcePortKey);
  const targetPort = targetDef?.inputs.find((port) => port.key === targetPortKey);
  if (!sourcePort || !targetPort) {
    return [{ code: 'GRAPH_UNKNOWN_PORT', message: '端口不存在', severity: 'error', nodeId: targetId, portKey: targetPortKey }];
  }
  const probe: BoardEdge = {
    id: '__probe__', source: sourceId, sourcePort: sourcePortKey,
    target: targetId, targetPort: targetPortKey,
    role: edgeRoleFor(sourcePort, targetPort), createdAt: 'probe',
  };
  return validateEdge(doc, probe);
}
```

注意上面隐藏端口 issue 的 `portKey` 应写 `item.targetPort`，不是 `target.id`——实现时确认。

- [ ] **Step 4: 运行连接测试**

Run: `pnpm test:unit`
Expected: PASS。`testFixtures` 的 `edge()` 默认角色是 `prompt`；第二条单输入测试会先命中 `GRAPH_SINGLE_INPUT`。

- [ ] **Step 5: 写画布映射测试**

`src/canvas/mapping.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node } from '../domain/graph/testFixtures';
import { danglingEdgeCount, toFlowEdges, toFlowNodes } from './mapping';

describe('canvas mapping', () => {
  it('maps domain nodes to React Flow nodes with parent and size', () => {
    const doc = makeDoc([
      { ...node('g', 'group'), size: { width: 400, height: 300 } },
      { ...node('t', 'text'), parentId: 'g', position: { x: 20, y: 30 }, size: { width: 260, height: 180 } },
    ], []);
    const flow = toFlowNodes(doc);
    const child = flow.find((item) => item.id === 't')!;
    expect(child.parentId).toBe('g');
    expect(child.position).toEqual({ x: 20, y: 30 });
    expect(child.style).toEqual({ width: 260, height: 180 });
    expect(child.data.domain.type).toBe('text');
  });

  it('maps edges with handles and a readable role label', () => {
    const doc = makeDoc([node('t', 'text'), node('i', 'image')], [edge('e1', 't', 'i')]);
    const [flowEdge] = toFlowEdges(doc);
    expect(flowEdge.sourceHandle).toBe('text');
    expect(flowEdge.targetHandle).toBe('prompt');
    expect(flowEdge.label).toBe('提示词');
  });

  it('hides dangling edges but counts them', () => {
    const doc = makeDoc([node('t', 'text')], [edge('e1', 't', 'missing')]);
    expect(toFlowEdges(doc)).toEqual([]);
    expect(danglingEdgeCount(doc)).toBe(1);
  });
});
```

- [ ] **Step 6: 实现映射**

`src/canvas/mapping.ts`：

```ts
import type { Edge, Node } from '@xyflow/react';
import type { BoardDoc, BoardNode, EdgeRole } from '../domain/types';

export interface StudioNodeData extends Record<string, unknown> {
  domain: BoardNode;
}

const ROLE_LABEL: Record<EdgeRole, string> = {
  script: '剧本', beat: '节拍', prompt: '提示词', character_ref: '角色',
  location_ref: '场景', prop_ref: '道具', style_ref: '风格',
  first_frame: '首帧', last_frame: '尾帧', middle_frame: '中间帧',
  reference_image: '参考图', reference_video: '参考视频', reference_audio: '参考音频',
  prev_shot: '前镜', storyboard: '分镜', video_clip: '视频', audio: '音频', timeline: '时间线',
};

const ROLE_COLOR: Record<EdgeRole, string> = {
  script: '#d8b66a', beat: '#c9a85f', prompt: '#8d9a98', character_ref: '#75d8bd',
  location_ref: '#7fa8d8', prop_ref: '#a98fd0', style_ref: '#d8b66a',
  first_frame: '#b08ad8', last_frame: '#8f6fba', middle_frame: '#9b7fc2',
  reference_image: '#b08ad8', reference_video: '#b08ad8', reference_audio: '#62c8b4',
  prev_shot: '#bf7256', storyboard: '#bf7256', video_clip: '#bf7256', audio: '#62c8b4',
  timeline: '#e4ecea',
};

export function toFlowNodes(doc: BoardDoc): Node<StudioNodeData>[] {
  return Object.values(doc.nodes)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: { domain: node },
      parentId: node.parentId,
      extent: node.parentId ? 'parent' as const : undefined,
      zIndex: node.z,
      style: node.size ? { width: node.size.width, height: node.size.height } : undefined,
      draggable: true,
      selectable: true,
    }));
}

export function toFlowEdges(doc: BoardDoc): Edge[] {
  return Object.values(doc.edges)
    .filter((edge) => doc.nodes[edge.source] && doc.nodes[edge.target])
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
      label: ROLE_LABEL[edge.role],
      labelStyle: { fill: '#9aa9a7', fontSize: 9 },
      labelBgStyle: { fill: '#151b1c', fillOpacity: 0.9 },
      style: { stroke: ROLE_COLOR[edge.role], strokeWidth: 1.4 },
      data: { role: edge.role },
    }));
}

export function danglingEdgeCount(doc: BoardDoc): number {
  return Object.values(doc.edges).filter((edge) => !doc.nodes[edge.source] || !doc.nodes[edge.target]).length;
}

export function edgeColor(role: string): string {
  return ROLE_COLOR[role as EdgeRole] ?? '#5c6a68';
}

export function nodeColor(type: string): string {
  if (type === 'script') return '#d8b66a';
  if (type === 'text') return '#d8b66a';
  if (type === 'audio') return '#62c8b4';
  if (type === 'image' || type === 'video') return '#b08ad8';
  if (type === 'group') return '#52605e';
  return '#7f908e';
}
```

- [ ] **Step 7: 写默认节点渲染（Task 18 会替换为完整卡片）**

`src/canvas/DefaultNode.tsx`：

```tsx
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { getNodeDefinition, visibleInputPorts } from '../domain/nodes/definitions';
import { nodeColor, type StudioNodeData } from './mapping';

function preview(node: StudioNodeData['domain']): string {
  const data = node.data;
  const candidate = data.body ?? data.prompt ?? data.text ?? data.label ?? '';
  const text = String(candidate).trim();
  return text ? text.slice(0, 120) : '空节点';
}

export function DefaultNode({ data, selected }: NodeProps<Node<StudioNodeData>>) {
  const node = data.domain;
  const def = getNodeDefinition(node.type);
  if (!def) {
    return <div className="flow-node flow-node-unknown">{node.type}</div>;
  }
  const inputs = visibleInputPorts(def, node);
  return (
    <div
      className={`flow-node type-${node.type}${selected ? ' is-selected' : ''}`}
      style={{ borderColor: selected ? '#75d8bd' : nodeColor(node.type) }}
    >
      <header>
        <span className="flow-node-type" style={{ background: nodeColor(node.type) }} />
        <b>{def.title}</b>
        {node.ui?.pinned && <span className="flow-node-lock">锁定</span>}
      </header>
      <p>{preview(node)}</p>
      {inputs.map((port, index) => (
        <div className="flow-port flow-port-in" key={port.key} style={{ top: 44 + index * 20 }}>
          <Handle type="target" position={Position.Left} id={port.key} />
          <span>{port.label}</span>
        </div>
      ))}
      {def.outputs.map((port, index) => (
        <div className="flow-port flow-port-out" key={port.key} style={{ top: 44 + index * 20 }}>
          <span>{port.label}</span>
          <Handle type="source" position={Position.Right} id={port.key} />
        </div>
      ))}
      <footer>{node.type} · v{node.typeVersion}</footer>
    </div>
  );
}
```

- [ ] **Step 8: 重写 boardStore**

`src/stores/boardStore.ts`：

```ts
import { create } from 'zustand';
import type { BoardDoc } from '../domain/types';
import { applyGraphCommand, type GraphCommand } from '../domain/graph/commands';
import { saveBoard } from '../services/tauri';

const HISTORY_LIMIT = 60;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let gestureSnapshot: BoardDoc | null = null;

function scheduleSave(get: () => BoardState): void {
  if (typeof window === 'undefined') return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void get().flush(); }, 700);
}

function pushPast(past: BoardDoc[], snapshot: BoardDoc): BoardDoc[] {
  return [...past, snapshot].slice(-HISTORY_LIMIT);
}

interface BoardState {
  board: BoardDoc | null;
  past: BoardDoc[];
  future: BoardDoc[];
  selectedNodeId?: string;
  selectedNodeIds: string[];
  dirty: boolean;
  saving: boolean;
  saveError?: string;
  lastSavedAt?: string;
  notice?: string;
  load(board: BoardDoc | null): void;
  apply(command: GraphCommand, options?: { history?: boolean }): void;
  applyMany(commands: GraphCommand[], options?: { history?: boolean }): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  select(nodeId?: string): void;
  selectMany(nodeIds: string[]): void;
  notify(message?: string): void;
  flush(): Promise<void>;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  board: null,
  past: [],
  future: [],
  selectedNodeIds: [],
  dirty: false,
  saving: false,

  load(board) {
    if (saveTimer) clearTimeout(saveTimer);
    gestureSnapshot = null;
    set({
      board,
      past: [],
      future: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
      dirty: false,
      saving: false,
      saveError: undefined,
      lastSavedAt: board ? new Date().toISOString() : undefined,
      notice: undefined,
    });
  },

  apply(command, options) {
    const state = get();
    if (!state.board) return;
    const history = options?.history !== false && gestureSnapshot === null;
    const next = applyGraphCommand(state.board, command);
    const past = history ? pushPast(state.past, state.board) : state.past;
    set({
      board: next,
      past,
      future: history ? [] : state.future,
      dirty: true,
      notice: undefined,
    });
    scheduleSave(get);
  },

  applyMany(commands, options) {
    const state = get();
    if (!state.board) return;
    const history = options?.history !== false && gestureSnapshot === null;
    const past = history ? pushPast(state.past, state.board) : state.past;
    let next = state.board;
    for (const command of commands) next = applyGraphCommand(next, command);
    set({
      board: next,
      past,
      future: history ? [] : state.future,
      dirty: true,
      notice: undefined,
    });
    scheduleSave(get);
  },

  beginGesture() {
    if (gestureSnapshot || !get().board) return;
    gestureSnapshot = get().board;
  },

  endGesture() {
    const snapshot = gestureSnapshot;
    gestureSnapshot = null;
    if (!snapshot || snapshot === get().board) return;
    set({ past: pushPast(get().past, snapshot), future: [] });
    scheduleSave(get);
  },

  undo() {
    const state = get();
    if (!state.board || !state.past.length) return;
    const previous = state.past[state.past.length - 1];
    set({
      board: previous,
      past: state.past.slice(0, -1),
      future: [state.board, ...state.future].slice(0, HISTORY_LIMIT),
      dirty: true,
      notice: undefined,
    });
    scheduleSave(get);
  },

  redo() {
    const state = get();
    if (!state.board || !state.future.length) return;
    const next = state.future[0];
    set({
      board: next,
      past: pushPast(state.past, state.board),
      future: state.future.slice(1),
      dirty: true,
      notice: undefined,
    });
    scheduleSave(get);
  },

  select(nodeId) {
    set({ selectedNodeId: nodeId, selectedNodeIds: nodeId ? [nodeId] : [] });
  },

  selectMany(nodeIds) {
    set({
      selectedNodeIds: nodeIds,
      selectedNodeId: nodeIds.length === 1 ? nodeIds[0] : undefined,
    });
  },

  notify(message) {
    set({ notice: message });
  },

  async flush() {
    const snapshot = get().board;
    if (!snapshot || !get().dirty || get().saving) return;
    set({ saving: true, saveError: undefined });
    try {
      await saveBoard(snapshot);
      const stillCurrent = get().board === snapshot;
      set({
        saving: false,
        dirty: stillCurrent ? false : get().dirty,
        lastSavedAt: new Date().toISOString(),
      });
      if (!stillCurrent) scheduleSave(get);
    } catch (error) {
      set({ saving: false, saveError: error instanceof Error ? error.message : String(error) });
    }
  },
}));
```

- [ ] **Step 9: 写 CanvasView**

`src/canvas/CanvasView.tsx`：

```tsx
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeTypes,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createNode, edgeRoleFor, getNodeDefinition } from '../domain/nodes/definitions';
import { makeEdge } from '../domain/graph/commands';
import { validateConnection } from '../domain/graph/validate';
import { useBoardStore } from '../stores/boardStore';
import { danglingEdgeCount, nodeColor, toFlowEdges, toFlowNodes, type StudioNodeData } from './mapping';
import { DefaultNode } from './DefaultNode';

const nodeTypes: NodeTypes = {
  text: DefaultNode, image: DefaultNode, video: DefaultNode, audio: DefaultNode,
  script: DefaultNode, note: DefaultNode, group: DefaultNode,
};

function CanvasInner() {
  const board = useBoardStore((state) => state.board);
  const notice = useBoardStore((state) => state.notice);
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const nodes = useMemo(() => (board ? toFlowNodes(board) : []), [board]);
  const edges = useMemo(() => (board ? toFlowEdges(board) : []), [board]);
  const dangling = board ? danglingEdgeCount(board) : 0;

  const onNodesChange = useCallback((changes: NodeChange<Node<StudioNodeData>>[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        useBoardStore.getState().apply({ type: 'moveNode', nodeId: change.id, position: change.position }, { history: false });
      } else if (change.type === 'remove') {
        useBoardStore.getState().apply({ type: 'removeNode', nodeId: change.id });
      }
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === 'remove') {
        useBoardStore.getState().apply({ type: 'disconnect', edgeId: change.id });
      }
    }
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const store = useBoardStore.getState();
    const doc = store.board;
    if (!doc || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const issues = validateConnection(doc, connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
    const error = issues.find((issue) => issue.severity === 'error');
    if (error) {
      store.notify(error.message);
      return;
    }
    const sourceDef = getNodeDefinition(doc.nodes[connection.source].type);
    const targetDef = getNodeDefinition(doc.nodes[connection.target].type);
    const sourcePort = sourceDef?.outputs.find((port) => port.key === connection.sourceHandle);
    const targetPort = targetDef?.inputs.find((port) => port.key === connection.targetHandle);
    if (!sourcePort || !targetPort) return;
    store.apply({
      type: 'connect',
      edge: makeEdge(connection.source, connection.sourceHandle, connection.target, connection.targetHandle, edgeRoleFor(sourcePort, targetPort)),
    });
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/frameforge-node');
    if (!type || !getNodeDefinition(type)) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const node = createNode(type, position);
    useBoardStore.getState().apply({ type: 'addNode', node });
    useBoardStore.getState().select(node.id);
  }, [screenToFlowPosition]);

  function addAtCenter(type: string) {
    const rect = wrapper.current?.getBoundingClientRect();
    const center = rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 80, y: 80 };
    const node = createNode(type, { x: center.x - 150, y: center.y - 100 });
    useBoardStore.getState().apply({ type: 'addNode', node });
    useBoardStore.getState().select(node.id);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select')) return;
      const store = useBoardStore.getState();
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo(); else store.undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'd') {
        const selected = store.selectedNodeId ? store.board?.nodes[store.selectedNodeId] : undefined;
        if (selected) {
          event.preventDefault();
          const copy = createNode(selected.type, { x: selected.position.x + 40, y: selected.position.y + 40 }, selected.data);
          store.apply({ type: 'addNode', node: copy });
          store.select(copy.id);
        }
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && store.selectedNodeId) {
        event.preventDefault();
        store.apply({ type: 'removeNode', nodeId: store.selectedNodeId });
        store.select(undefined);
        return;
      }
      if (event.key === 'Escape') store.select(undefined);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useBoardStore.getState().notify(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!board) return <div className="studio-empty-canvas">正在加载画布…</div>;

  return (
    <div className="studio-canvas" ref={wrapper}>
      <div className="canvas-toolbar" role="toolbar" aria-label="添加节点">
        <span className="canvas-toolbar-label">添加</span>
        {['text', 'image', 'video', 'audio', 'script', 'note', 'group'].map((type) => (
          <button key={type} className="canvas-tool" onClick={() => addAtCenter(type)}>
            {getNodeDefinition(type)?.title ?? type}
          </button>
        ))}
        <span className="canvas-toolbar-spacer" />
        <button className="canvas-tool" onClick={() => useBoardStore.getState().undo()} disabled={!useBoardStore.getState().past.length}>撤销</button>
        <button className="canvas-tool" onClick={() => useBoardStore.getState().redo()} disabled={!useBoardStore.getState().future.length}>重做</button>
        {dangling > 0 && <span className="canvas-warning">{dangling} 条断开的引用</span>}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={board.viewport}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={() => useBoardStore.getState().beginGesture()}
        onNodeDragStop={() => useBoardStore.getState().endGesture()}
        onSelectionChange={({ nodes: selected }) => useBoardStore.getState().select(selected[0]?.id)}
        onDrop={onDrop}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
        onMoveEnd={(_, viewport) => {
          const current = useBoardStore.getState().board;
          if (!current) return;
          if (current.viewport.x === viewport.x && current.viewport.y === viewport.y && current.viewport.zoom === viewport.zoom) return;
          useBoardStore.getState().apply({ type: 'setViewport', viewport }, { history: false });
        }}
        onlyRenderVisibleElements
        selectionOnDrag
        panOnScroll
        deleteKeyCode={null}
        fitView={false}
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#26302f" gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(node) => nodeColor(node.type ?? '')} maskColor="rgba(9, 13, 13, 0.72)" />
      </ReactFlow>
      {!nodes.length && (
        <div className="canvas-empty">
          <b>空白画布</b>
          <span>从上方「添加」开始，或用拖拽把节点放到任意位置。</span>
          <span>文本 → 图片 → 视频，连起来就是一条可执行链路。</span>
        </div>
      )}
      {notice && <div className="canvas-notice" role="status">{notice}</div>}
    </div>
  );
}

export function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
```

注意：`proOptions={{ hideAttribution: true }}` 仅在 React Flow 许可证允许时使用；如果团队要求保留署名，删掉该行。P0 默认保留更稳妥——**实现时删除这一行**。

- [ ] **Step 10: 追加载画布样式**

在 `src/styles/studio.css` 末尾追加：

```css
.studio-canvas { position: relative; flex: 1; min-height: 0; }
.studio-canvas .react-flow { background: var(--bg); }
.canvas-toolbar { position: absolute; z-index: 5; top: 10px; left: 10px; right: 10px; display: flex; align-items: center; gap: 4px; padding: 5px; background: rgba(21, 27, 28, .92); border: 1px solid var(--line); border-radius: 5px; backdrop-filter: blur(8px); }
.canvas-toolbar-label { padding: 0 7px; color: var(--text-dim); font-size: 10px; }
.canvas-tool { padding: 5px 7px; color: var(--text-muted); border: 1px solid transparent; border-radius: 3px; font-size: 11px; }
.canvas-tool:hover { color: var(--text); background: var(--panel-3); border-color: var(--line-strong); }
.canvas-tool:disabled { cursor: default; opacity: .35; }
.canvas-toolbar-spacer { flex: 1; }
.canvas-warning { padding: 0 8px; color: var(--warning); font-size: 10px; }
.flow-node { min-width: 240px; max-width: 320px; padding: 10px 12px; color: var(--text); background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 6px; box-shadow: 0 10px 28px rgba(0, 0, 0, .28); font-size: 11px; }
.flow-node header { display: flex; align-items: center; gap: 7px; }
.flow-node header b { font-size: 12px; font-weight: 600; }
.flow-node-type { width: 7px; height: 7px; border-radius: 50%; }
.flow-node-lock { margin-left: auto; color: var(--warning); font-size: 9px; }
.flow-node p { margin: 8px 0 0; color: var(--text-muted); line-height: 1.55; overflow-wrap: anywhere; }
.flow-node footer { margin-top: 9px; color: var(--text-dim); font-family: var(--font-mono); font-size: 9px; }
.flow-node.is-selected { box-shadow: 0 0 0 1px var(--mint), 0 10px 28px rgba(0, 0, 0, .28); }
.flow-node.type-group { min-width: 320px; min-height: 220px; background: rgba(32, 41, 42, .55); border-style: dashed; }
.flow-port { position: absolute; display: flex; align-items: center; gap: 5px; color: var(--text-dim); font-size: 9px; white-space: nowrap; }
.flow-port-in { left: -7px; transform: translateX(-100%); }
.flow-port-out { right: -7px; transform: translateX(100%); flex-direction: row-reverse; }
.flow-port .react-flow__handle { position: relative; top: auto; left: auto; right: auto; transform: none; width: 9px; height: 9px; background: var(--panel); border: 1px solid var(--mint); }
.canvas-empty { position: absolute; inset: 48px 0 0; z-index: 2; display: grid; place-content: center; gap: 7px; color: var(--text-muted); text-align: center; pointer-events: none; }
.canvas-empty b { color: var(--text); font-size: 16px; }
.canvas-empty span { font-size: 11px; }
.canvas-notice { position: absolute; z-index: 8; left: 50%; bottom: 20px; transform: translateX(-50%); padding: 8px 12px; color: #fff3ef; background: #4a2a27; border: 1px solid #6e3b36; border-radius: 4px; font-size: 11px; }
.studio-canvas .react-flow__minimap { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; }
.studio-canvas .react-flow__controls { box-shadow: none; }
.studio-canvas .react-flow__controls-button { color: var(--text-muted); background: var(--panel-2); border-bottom: 1px solid var(--line); }
```

- [ ] **Step 11: 挂载 CanvasView**

`src/app/StudioApp.tsx`：import `CanvasView`，把 `board ?` 分支里的 `studio-empty-canvas` 占位替换为：

```tsx
<CanvasView key={board.id} />
```

- [ ] **Step 12: 运行测试与构建**

Run:
```bash
pnpm test:unit
pnpm build
```
Expected: 映射与连接测试通过；构建无错。若 React Flow 报 `NodeChange` 泛型不匹配，直接改用 `NodeChange[]`（运行时结构相同）。

- [ ] **Step 13: 手工验证**

Run: `pnpm tauri dev`
Expected:
1. 画布可用「添加」创建 7 类节点；拖拽移动后停下触发自动保存。
2. 从文本输出端口拖到图片 prompt 端口成功连线；拖到视频 start 端口提示「当前节点模式不接受这个端口」。
3. `Cmd/Ctrl+Z` / `Shift+Cmd/Ctrl+Z` 撤销重做；Delete 删除节点后连线保留并显示「断开的引用」计数。
4. 缩放/平移后收起再打开画布，viewport 保持。

- [ ] **Step 14: 提交**

```bash
git add src/canvas src/stores/boardStore.ts src/domain/graph src/app/StudioApp.tsx src/styles/studio.css
git commit -m "feat(p0): React Flow 画布、连接预检与撤销自动保存"
```

### Task 18: 节点卡片、七类渲染与运行读模型

**Files:**
- Create: `src/nodes/summary.ts`
- Test: `src/nodes/summary.test.ts`
- Create: `src/nodes/useAssetUrl.ts`
- Create: `src/nodes/bodies.tsx`
- Create: `src/nodes/NodeCard.tsx`
- Create: `src/nodes/registry.tsx`
- Create: `src/stores/runStore.ts`
- Replace: `src/canvas/CanvasView.tsx`
- Delete: `src/canvas/DefaultNode.tsx`
- Modify: `src/styles/studio.css`

**Interfaces:**
- Consumes: `getNodeDefinition`、`visibleInputPorts`、`nodeColor`、`StudioNodeData`、`listRuns`、`assetUrl`、`useBoardStore`（Task 17 已加 `selectedNodeIds` / `selectMany`）。
- Produces:
  - `useRunStore`：`boardId`、`loading`、`runs`、`latestByNode`、`assets`、`load(boardId?)`、`upsertRun(run)`、`mergeAssets(assets)`、`reset()`。
  - `NodeCard` 与 `nodeTypes`（7 类节点共用一张卡片，主体按类型分发）。
  - `useAssetUrl(assetId?)`、`BODIES`、`summarizeNode`、`statusOf`、`outputAssetId`、`durationLabel`、`indexLatest`。
  - `CanvasView` 支持多选、`Cmd/Ctrl+G` 编组、`Shift+Cmd/Ctrl+G` 解组、批量删除，并在打开画布时加载运行历史。

- [ ] **Step 1: 写失败的摘要测试**

`src/nodes/summary.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { BoardNode, RunRecord } from '../domain/types';
import { durationLabel, indexLatest, modeLabel, outputAssetId, statusOf, summarizeNode } from './summary';

const node = (data: Record<string, unknown>): BoardNode => ({
  id: 'n1', type: 'text', typeVersion: 1, position: { x: 0, y: 0 }, z: 0, data,
});

const run = (patch: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1', projectId: 'p1', boardId: 'b1', nodeId: 'n1', action: 'generate', cacheKey: 'k',
  status: 'succeeded', promptSnapshot: { text: 't', segments: [], hash: 'h', locked: false },
  params: {}, inputAssetIds: [], outputAssetIds: ['asset_a', 'asset_b'],
  startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:00:07.500Z', ...patch,
});

describe('node summary', () => {
  it('prefers prompt and collapses whitespace', () => {
    expect(summarizeNode(node({ prompt: '  雨夜\n  街角  ' }))).toBe('雨夜 街角');
    expect(summarizeNode(node({ text: '台词' }))).toBe('台词');
    expect(summarizeNode(node({}))).toBe('空节点');
  });

  it('truncates long text with an ellipsis', () => {
    expect(summarizeNode(node({ prompt: 'x'.repeat(200) }), 10)).toBe('xxxxxxxxxx…');
  });

  it('maps modes and run status', () => {
    expect(modeLabel('t2v')).toBe('文生视频');
    expect(modeLabel('custom')).toBe('custom');
    expect(statusOf()).toEqual({ label: '未运行', tone: 'idle' });
    expect(statusOf(run({ status: 'failed' }))).toEqual({ label: '失败', tone: 'error' });
    expect(statusOf(run()).tone).toBe('ok');
  });

  it('prefers the selected candidate and requires success', () => {
    expect(outputAssetId(run())).toBe('asset_a');
    expect(outputAssetId(run({ selectedAssetId: 'asset_b' }))).toBe('asset_b');
    expect(outputAssetId(run({ status: 'running' }))).toBeUndefined();
  });

  it('formats run duration', () => {
    expect(durationLabel(run())).toBe('7.5s');
    expect(durationLabel(run({ finishedAt: undefined }))).toBe('');
  });

  it('indexes the latest run per node', () => {
    const older = run({ id: 'r_old', startedAt: '2026-10-31T00:00:00.000Z' });
    const newer = run({ id: 'r_new', startedAt: '2026-10-31T00:01:00.000Z' });
    expect(indexLatest([newer, older])).toEqual({ n1: 'r_new' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./summary`。

- [ ] **Step 3: 实现摘要与运行标签**

`src/nodes/summary.ts`：

```ts
import type { BoardNode, RunRecord } from '../domain/types';

const MODE_LABEL: Record<string, string> = {
  t2v: '文生视频', firstLast: '首尾帧', reference: '全能参考',
  generate: '生成', rewrite: '改写',
};

export function summarizeNode(node: BoardNode, max = 96): string {
  const raw = node.data.prompt ?? node.data.text ?? node.data.body ?? node.data.label ?? '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return '空节点';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function modeLabel(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  return MODE_LABEL[String(value)] ?? String(value);
}

export type RunTone = 'idle' | 'busy' | 'ok' | 'error' | 'cancelled';

export interface RunBadge {
  label: string;
  tone: RunTone;
}

export function statusOf(run?: RunRecord): RunBadge {
  if (!run) return { label: '未运行', tone: 'idle' };
  switch (run.status) {
    case 'queued': return { label: '排队中', tone: 'busy' };
    case 'running': return { label: '生成中', tone: 'busy' };
    case 'succeeded': return { label: '完成', tone: 'ok' };
    case 'failed': return { label: '失败', tone: 'error' };
    case 'cancelled': return { label: '已取消', tone: 'cancelled' };
  }
}

export function outputAssetId(run?: RunRecord): string | undefined {
  if (!run || run.status !== 'succeeded') return undefined;
  return run.selectedAssetId ?? run.outputAssetIds[0];
}

export function durationLabel(run?: RunRecord): string {
  if (!run?.finishedAt) return '';
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '<1s';
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function indexLatest(runs: RunRecord[]): Record<string, string> {
  const latest: Record<string, string> = {};
  const sorted = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const run of sorted) latest[run.nodeId] = run.id;
  return latest;
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm test:unit`
Expected: PASS。

- [ ] **Step 5: 写运行读模型与资产 URL**

`src/stores/runStore.ts`：

```ts
import { create } from 'zustand';
import type { AssetRef, RunRecord } from '../domain/types';
import { listRuns } from '../services/tauri';
import { indexLatest } from '../nodes/summary';

interface RunState {
  boardId?: string;
  loading: boolean;
  error?: string;
  runs: Record<string, RunRecord>;
  latestByNode: Record<string, string>;
  assets: Record<string, AssetRef>;
  load(boardId?: string): Promise<void>;
  upsertRun(run: RunRecord): void;
  mergeAssets(assets: AssetRef[]): void;
  reset(): void;
}

export const useRunStore = create<RunState>((set, get) => ({
  loading: false,
  runs: {},
  latestByNode: {},
  assets: {},

  async load(boardId) {
    if (!boardId) {
      get().reset();
      return;
    }
    set({ boardId, loading: true, error: undefined, runs: {}, latestByNode: {}, assets: {} });
    try {
      const runs = await listRuns(boardId);
      if (get().boardId !== boardId) return;
      set({
        loading: false,
        runs: Object.fromEntries(runs.map((run) => [run.id, run])),
        latestByNode: indexLatest(runs),
      });
    } catch (error) {
      if (get().boardId !== boardId) return;
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  upsertRun(run) {
    set((state) => {
      const runs = { ...state.runs, [run.id]: run };
      return { runs, latestByNode: indexLatest(Object.values(runs)) };
    });
  },

  mergeAssets(assets) {
    set((state) => ({
      assets: { ...state.assets, ...Object.fromEntries(assets.map((asset) => [asset.id, asset])) },
    }));
  },

  reset() {
    set({ boardId: undefined, loading: false, error: undefined, runs: {}, latestByNode: {}, assets: {} });
  },
}));
```

`src/nodes/useAssetUrl.ts`：

```ts
import { useEffect, useState } from 'react';
import { assetUrl } from '../services/tauri';

const cache = new Map<string, string>();

export function useAssetUrl(assetId?: string): string | undefined {
  const [state, setState] = useState<{ id?: string; url?: string }>(() => ({
    id: assetId,
    url: assetId ? cache.get(assetId) : undefined,
  }));

  useEffect(() => {
    if (!assetId) {
      setState({ id: undefined, url: undefined });
      return;
    }
    const cached = cache.get(assetId);
    if (cached) {
      setState({ id: assetId, url: cached });
      return;
    }
    let alive = true;
    assetUrl(assetId)
      .then((value) => {
        if (!value) return;
        cache.set(assetId, value);
        if (alive) setState({ id: assetId, url: value });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [assetId]);

  if (!assetId) return undefined;
  if (state.id === assetId) return state.url;
  return cache.get(assetId);
}
```

- [ ] **Step 6: 写七类节点主体**

`src/nodes/bodies.tsx`：

```tsx
import type { ReactElement } from 'react';
import type { BoardNode, RunRecord } from '../domain/types';
import { modeLabel, outputAssetId, statusOf, summarizeNode } from './summary';
import { useAssetUrl } from './useAssetUrl';

interface BodyProps {
  node: BoardNode;
  run?: RunRecord;
}

function Meta({ items }: { items: Array<string | undefined | false> }) {
  const visible = items.filter(Boolean) as string[];
  if (!visible.length) return null;
  return (
    <div className="flow-meta">
      {visible.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
    </div>
  );
}

export function TextBody({ node }: BodyProps) {
  return (
    <div className="flow-body">
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[modeLabel(node.data.mode)]} />
    </div>
  );
}

export function ImageBody({ node, run }: BodyProps) {
  const url = useAssetUrl(outputAssetId(run));
  return (
    <div className="flow-body">
      {url
        ? <img className="flow-media" src={url} alt="" draggable={false} />
        : <div className="flow-media flow-media-empty"><span>暂无图片</span></div>}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[
        String(node.data.size ?? ''),
        `${Number(node.data.count ?? 1)} 张候选`,
        run?.status === 'running' ? `${statusOf(run).label}…` : undefined,
      ]} />
    </div>
  );
}

export function VideoBody({ node, run }: BodyProps) {
  const url = useAssetUrl(outputAssetId(run));
  return (
    <div className="flow-body">
      {url
        ? <video className="flow-media" src={url} muted playsInline preload="metadata" />
        : <div className="flow-media flow-media-empty"><span>暂无视频</span></div>}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[
        modeLabel(node.data.mode),
        `${Number(node.data.duration ?? 0)}s`,
        String(node.data.resolution ?? ''),
        String(node.data.aspectRatio ?? ''),
      ]} />
    </div>
  );
}

export function AudioBody({ node, run }: BodyProps) {
  const url = useAssetUrl(outputAssetId(run));
  const text = String(node.data.text ?? '');
  const bars = Array.from({ length: 28 }, (_, index) => {
    const code = text.charCodeAt(index % Math.max(text.length, 1)) || 58;
    return 18 + (code % 62);
  });
  return (
    <div className="flow-body">
      {url
        ? <audio className="flow-audio nodrag" src={url} controls preload="metadata" />
        : <div className="flow-wave" aria-hidden="true">{bars.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>}
      <p className="flow-quote">{summarizeNode(node)}</p>
      <Meta items={[String(node.data.voice ?? ''), String(node.data.format ?? '').toUpperCase()]} />
    </div>
  );
}

export function ScriptBody({ node }: BodyProps) {
  const body = String(node.data.body ?? '');
  const lines = body.split(/\n+/).filter((line) => line.trim()).length;
  return (
    <div className="flow-body">
      <p className="flow-title">{String(node.data.title ?? '').trim() || '未命名剧本'}</p>
      <p className="flow-quote">{summarizeNode(node, 120)}</p>
      <Meta items={[`${lines} 段`]} />
    </div>
  );
}

export function NoteBody({ node }: BodyProps) {
  return (
    <div className={`flow-body flow-note flow-note-${String(node.data.color ?? 'default')}`}>
      <p className="flow-quote">{summarizeNode(node, 140)}</p>
    </div>
  );
}

export function GroupBody({ node }: BodyProps) {
  return (
    <div className="flow-body flow-group-body">
      <p className="flow-title">{String(node.data.label ?? '').trim() || '分组'}</p>
      <Meta items={['框选节点后 Cmd/Ctrl+G 编组']} />
    </div>
  );
}

export type NodeBody = (props: BodyProps) => ReactElement;

export const BODIES: Record<string, NodeBody> = {
  text: TextBody,
  image: ImageBody,
  video: VideoBody,
  audio: AudioBody,
  script: ScriptBody,
  note: NoteBody,
  group: GroupBody,
};
```

- [ ] **Step 7: 写节点卡片与注册表**

`src/nodes/NodeCard.tsx`：

```tsx
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { getNodeDefinition, visibleInputPorts } from '../domain/nodes/definitions';
import { nodeColor, type StudioNodeData } from '../canvas/mapping';
import { useRunStore } from '../stores/runStore';
import { BODIES } from './bodies';
import { durationLabel, statusOf, summarizeNode } from './summary';

export function NodeCard({ data, selected }: NodeProps<Node<StudioNodeData>>) {
  const node = data.domain;
  const def = getNodeDefinition(node.type);
  const run = useRunStore((state) => {
    const runId = state.latestByNode[node.id];
    return runId ? state.runs[runId] : undefined;
  });

  if (!def) {
    return <div className="flow-node flow-node-unknown">{node.type}</div>;
  }

  const inputs = visibleInputPorts(def, node);
  const Body = BODIES[node.type];
  const badge = statusOf(run);
  const accent = nodeColor(node.type);
  const hasPorts = inputs.length > 0 || def.outputs.length > 0;

  return (
    <div
      className={`flow-node type-${node.type}${selected ? ' is-selected' : ''}${node.type === 'group' ? ' is-group' : ''}`}
      style={{ borderColor: selected ? 'var(--mint)' : accent }}
    >
      <header>
        <span className="flow-node-type" style={{ background: accent }} />
        <b>{def.title}</b>
        {node.ui?.pinned && <span className="flow-node-lock">锁定</span>}
        <span className={`flow-status tone-${badge.tone}`}>{badge.label}</span>
      </header>
      {Body ? <Body node={node} run={run} /> : <p className="flow-quote">{summarizeNode(node)}</p>}
      {node.type !== 'group' && (
        <footer>
          <span>{node.type} · v{node.typeVersion}</span>
          <span>{run ? `${run.outputAssetIds.length} 个结果` : ''}</span>
          <span>{durationLabel(run)}</span>
        </footer>
      )}
      {hasPorts && (
        <div className="flow-ports">
          <div className="flow-ports-in">
            {inputs.map((port) => (
              <div className="flow-port flow-port-in" key={port.key}>
                <Handle type="target" position={Position.Left} id={port.key} className="flow-handle" />
                <span>{port.label}{port.required ? ' *' : ''}</span>
              </div>
            ))}
          </div>
          <div className="flow-ports-out">
            {def.outputs.map((port) => (
              <div className="flow-port flow-port-out" key={port.key}>
                <span>{port.label}</span>
                <Handle type="source" position={Position.Right} id={port.key} className="flow-handle" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

`src/nodes/registry.tsx`：

```tsx
import type { NodeTypes } from '@xyflow/react';
import { NodeCard } from './NodeCard';

export const nodeTypes: NodeTypes = {
  text: NodeCard,
  image: NodeCard,
  video: NodeCard,
  audio: NodeCard,
  script: NodeCard,
  note: NodeCard,
  group: NodeCard,
};
```

- [ ] **Step 8: 替换 CanvasView**

用以下内容整体替换 `src/canvas/CanvasView.tsx`，然后删除 `src/canvas/DefaultNode.tsx`（`git rm`）：

```tsx
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  type Connection, type EdgeChange, type Node, type NodeChange, useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { newId } from '../domain/ids';
import { createNode, edgeRoleFor, getNodeDefinition } from '../domain/nodes/definitions';
import { makeEdge } from '../domain/graph/commands';
import { validateConnection } from '../domain/graph/validate';
import { useBoardStore } from '../stores/boardStore';
import { useRunStore } from '../stores/runStore';
import { nodeTypes } from '../nodes/registry';
import { danglingEdgeCount, nodeColor, toFlowEdges, toFlowNodes, type StudioNodeData } from './mapping';

function CanvasInner() {
  const board = useBoardStore((state) => state.board);
  const notice = useBoardStore((state) => state.notice);
  const selectedNodeIds = useBoardStore((state) => state.selectedNodeIds);
  const selectedIsGroup = useBoardStore((state) => {
    const id = state.selectedNodeId;
    return Boolean(id && state.board?.nodes[id]?.type === 'group');
  });
  const canUndo = useBoardStore((state) => state.past.length > 0);
  const canRedo = useBoardStore((state) => state.future.length > 0);
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const nodes = useMemo(() => (board ? toFlowNodes(board) : []), [board]);
  const edges = useMemo(() => (board ? toFlowEdges(board) : []), [board]);
  const dangling = board ? danglingEdgeCount(board) : 0;

  useEffect(() => {
    void useRunStore.getState().load(board?.id);
  }, [board?.id]);

  const groupSelection = useCallback(() => {
    const store = useBoardStore.getState();
    if (!store.board || store.selectedNodeIds.length < 2) return;
    store.apply({
      type: 'group',
      groupId: newId('node'),
      childIds: store.selectedNodeIds,
      label: '新分组',
    });
    store.selectMany([]);
  }, []);

  const ungroupSelection = useCallback(() => {
    const store = useBoardStore.getState();
    const groupId = store.selectedNodeId;
    if (!groupId || store.board?.nodes[groupId]?.type !== 'group') return;
    store.apply({ type: 'ungroup', groupId });
    store.selectMany([]);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<Node<StudioNodeData>>[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        useBoardStore.getState().apply({ type: 'moveNode', nodeId: change.id, position: change.position }, { history: false });
      } else if (change.type === 'remove') {
        useBoardStore.getState().apply({ type: 'removeNode', nodeId: change.id });
      }
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === 'remove') {
        useBoardStore.getState().apply({ type: 'disconnect', edgeId: change.id });
      }
    }
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const store = useBoardStore.getState();
    const doc = store.board;
    if (!doc || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const issues = validateConnection(doc, connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
    const error = issues.find((issue) => issue.severity === 'error');
    if (error) {
      store.notify(error.message);
      return;
    }
    const sourceDef = getNodeDefinition(doc.nodes[connection.source].type);
    const targetDef = getNodeDefinition(doc.nodes[connection.target].type);
    const sourcePort = sourceDef?.outputs.find((port) => port.key === connection.sourceHandle);
    const targetPort = targetDef?.inputs.find((port) => port.key === connection.targetHandle);
    if (!sourcePort || !targetPort) return;
    store.apply({
      type: 'connect',
      edge: makeEdge(connection.source, connection.sourceHandle, connection.target, connection.targetHandle, edgeRoleFor(sourcePort, targetPort)),
    });
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/frameforge-node');
    if (!type || !getNodeDefinition(type)) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const node = createNode(type, position);
    useBoardStore.getState().apply({ type: 'addNode', node });
    useBoardStore.getState().select(node.id);
  }, [screenToFlowPosition]);

  function addAtCenter(type: string) {
    const rect = wrapper.current?.getBoundingClientRect();
    const center = rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 80, y: 80 };
    const node = createNode(type, { x: center.x - 132, y: center.y - 100 });
    useBoardStore.getState().apply({ type: 'addNode', node });
    useBoardStore.getState().select(node.id);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const store = useBoardStore.getState();
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo(); else store.undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (event.shiftKey) ungroupSelection(); else groupSelection();
        return;
      }
      if (meta && event.key.toLowerCase() === 'd') {
        const selected = store.selectedNodeId ? store.board?.nodes[store.selectedNodeId] : undefined;
        if (selected) {
          event.preventDefault();
          const copy = createNode(selected.type, { x: selected.position.x + 40, y: selected.position.y + 40 }, selected.data);
          store.apply({ type: 'addNode', node: copy });
          store.select(copy.id);
        }
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && store.selectedNodeIds.length) {
        event.preventDefault();
        store.applyMany(store.selectedNodeIds.map((nodeId) => ({ type: 'removeNode' as const, nodeId })));
        store.selectMany([]);
        return;
      }
      if (event.key === 'Escape') store.selectMany([]);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [groupSelection, ungroupSelection]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useBoardStore.getState().notify(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!board) return <div className="studio-empty-canvas">正在加载画布…</div>;

  return (
    <div className="studio-canvas" ref={wrapper}>
      <div className="canvas-toolbar" role="toolbar" aria-label="添加节点">
        <span className="canvas-toolbar-label">添加</span>
        {['text', 'image', 'video', 'audio', 'script', 'note', 'group'].map((type) => (
          <button key={type} className="canvas-tool" onClick={() => addAtCenter(type)}>
            {getNodeDefinition(type)?.title ?? type}
          </button>
        ))}
        <span className="canvas-toolbar-sep" />
        <button className="canvas-tool" onClick={groupSelection} disabled={selectedNodeIds.length < 2}>编组</button>
        <button className="canvas-tool" onClick={ungroupSelection} disabled={!selectedIsGroup}>解组</button>
        <span className="canvas-toolbar-spacer" />
        <button className="canvas-tool" onClick={() => useBoardStore.getState().undo()} disabled={!canUndo}>撤销</button>
        <button className="canvas-tool" onClick={() => useBoardStore.getState().redo()} disabled={!canRedo}>重做</button>
        {dangling > 0 && <span className="canvas-warning">{dangling} 条断开的引用</span>}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={board.viewport}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={() => useBoardStore.getState().beginGesture()}
        onNodeDragStop={() => useBoardStore.getState().endGesture()}
        onSelectionChange={({ nodes: selected }) => useBoardStore.getState().selectMany(selected.map((node) => node.id))}
        onDrop={onDrop}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
        onMoveEnd={(_, viewport) => {
          const current = useBoardStore.getState().board;
          if (!current) return;
          if (current.viewport.x === viewport.x && current.viewport.y === viewport.y && current.viewport.zoom === viewport.zoom) return;
          useBoardStore.getState().apply({ type: 'setViewport', viewport }, { history: false });
        }}
        onlyRenderVisibleElements
        selectionOnDrag
        panOnScroll
        deleteKeyCode={null}
        fitView={false}
        minZoom={0.2}
        maxZoom={2.5}
      >
        <Background color="#26302f" gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(node) => nodeColor(node.type ?? '')} maskColor="rgba(9, 13, 13, 0.72)" />
      </ReactFlow>
      {!nodes.length && (
        <div className="canvas-empty">
          <b>空白画布</b>
          <span>从上方「添加」开始，或用拖拽把节点放到任意位置。</span>
          <span>文本 → 图片 → 视频，连起来就是一条可执行链路。</span>
        </div>
      )}
      {notice && <div className="canvas-notice" role="status">{notice}</div>}
    </div>
  );
}

export function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
```

注意：Task 17 中的 `proOptions={{ hideAttribution: true }}` 不再保留。

- [ ] **Step 9: 替换节点卡片样式**

在 `src/styles/studio.css` 中，把 Task 17 追加的 `.flow-node { min-width: 240px; ... }` 到 `.flow-port .react-flow__handle { ... }` 这一段（共 13 行）替换为以下内容：

```css
.flow-node { position: relative; width: 264px; color: var(--text); background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 6px; box-shadow: 0 10px 28px rgba(0, 0, 0, .28); font-size: 11px; }
.flow-node header { display: flex; align-items: center; gap: 7px; padding: 9px 11px 7px; }
.flow-node header b { font-size: 12px; font-weight: 600; }
.flow-node-type { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; }
.flow-node-lock { color: var(--warning); font-size: 9px; }
.flow-status { margin-left: auto; padding: 2px 5px; border-radius: 3px; font-size: 9px; white-space: nowrap; }
.flow-status.tone-idle { color: var(--text-dim); background: rgba(255, 255, 255, .03); }
.flow-status.tone-busy { color: #f0d58d; background: #4a3d20; }
.flow-status.tone-ok { color: #a8e6d2; background: #24483c; }
.flow-status.tone-error { color: #f0b3ab; background: #52302d; }
.flow-status.tone-cancelled { color: var(--text-dim); background: #2d3435; }
.flow-body { display: grid; gap: 7px; padding: 0 11px 10px; }
.flow-title { margin: 0; color: var(--text); font-size: 12px; font-weight: 600; }
.flow-quote { display: -webkit-box; margin: 0; overflow: hidden; color: var(--text-muted); font-size: 10px; line-height: 1.55; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.flow-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; color: var(--text-dim); font-family: var(--font-mono); font-size: 9px; }
.flow-media { display: block; width: 100%; height: 150px; object-fit: cover; background: #0f1515; border-radius: 4px; }
.flow-media-empty { display: grid; place-items: center; color: var(--text-dim); border: 1px dashed var(--line-strong); font-size: 10px; }
.flow-wave { display: flex; align-items: center; gap: 2px; height: 46px; padding: 0 2px; }
.flow-wave i { flex: 1; min-height: 3px; background: #3f6f63; border-radius: 1px; }
.flow-audio { width: 100%; height: 32px; }
.flow-note { margin: 0 11px 10px; padding-left: 9px; border-left: 2px solid var(--line-strong); }
.flow-note-mint { border-color: var(--mint); }
.flow-note-warm { border-color: var(--warm); }
.flow-node footer { display: flex; align-items: center; gap: 8px; padding: 6px 11px 7px; color: var(--text-dim); border-top: 1px solid var(--line); font-family: var(--font-mono); font-size: 9px; }
.flow-node footer span:nth-child(2) { margin-left: auto; }
.flow-node.is-selected { box-shadow: 0 0 0 1px var(--mint), 0 10px 28px rgba(0, 0, 0, .28); }
.flow-ports { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-top: 1px solid var(--line); }
.flow-ports-in, .flow-ports-out { display: grid; gap: 5px; }
.flow-ports-out { margin-left: auto; text-align: right; }
.flow-port { position: relative; color: var(--text-dim); font-size: 9px; white-space: nowrap; }
.flow-port-in { padding-left: 11px; }
.flow-port-out { padding-right: 11px; }
.flow-port .flow-handle { width: 9px; height: 9px; background: var(--panel); border: 1px solid var(--mint); }
.flow-port-in .flow-handle { top: 50%; left: -16px; transform: translateY(-50%); }
.flow-port-out .flow-handle { top: 50%; right: -16px; transform: translateY(-50%); }
.flow-node.is-group { width: auto; height: 100%; min-width: 260px; min-height: 180px; background: rgba(32, 41, 42, .55); border-style: dashed; }
.flow-node.is-group header { padding-bottom: 4px; }
.flow-node.is-group .flow-group-body { padding-bottom: 0; }
.flow-node-unknown { padding: 10px 12px; color: var(--danger); }
.canvas-toolbar-sep { width: 1px; height: 16px; margin: 0 4px; background: var(--line-strong); }
```

注意：`is-group` 的宽高由 `board` 里的 `size` 以内联样式覆盖；不要给 `.flow-node` 设置 `overflow: hidden`，否则端口手柄会被裁掉。

- [ ] **Step 10: 运行测试与构建**

Run:
```bash
pnpm test:unit
pnpm build
```
Expected: 摘要测试通过；构建无错。若 `NodeProps<Node<StudioNodeData>>` 泛型报错，按 Task 17 的说明退回 `NodeProps` 并给 `data` 断言 `StudioNodeData`。

- [ ] **Step 11: 手工验证**

Run: `pnpm tauri dev`
Expected:
1. 七类节点卡片标题、状态、端口、摘要各不相同；图片/视频/音频运行后卡片显示结果缩略图。
2. 选择两个节点后工具栏「编组」或 `Cmd/Ctrl+G` 生成虚线分组，拖动分组时子节点跟随；`Shift+Cmd/Ctrl+G` 解组后位置回到原处。
3. 删除分组后子节点保留（位置提升为绝对坐标），不会出现 React Flow 的 parent 丢失报错。
4. 多选后 Delete 删除全部选中节点；撤销可一次恢复。
5. 打开画布时运行历史被加载，卡片显示最近一次运行状态/耗时。

- [ ] **Step 12: 提交**

```bash
git add src/nodes src/stores/runStore.ts src/canvas src/styles/studio.css
git commit -m "feat(p0): 七类节点卡片与运行读模型"
```

---

### Task 19: Inspector、提示词预览与候选选择

**Files:**
- Create: `src/inspector/model.ts`
- Test: `src/inspector/model.test.ts`
- Create: `src/nodes/useTextAsset.ts`
- Create: `src/inspector/FieldEditor.tsx`
- Create: `src/inspector/RunHistory.tsx`
- Create: `src/inspector/CandidateList.tsx`
- Create: `src/inspector/Inspector.tsx`
- Modify: `src/app/StudioApp.tsx`
- Modify: `src/styles/studio.css`

**Interfaces:**
- Consumes: `compilePrompt`、`nodeIssues`、`GraphCommand`、`selectRunCandidate`、`useBoardStore`、`useRunStore`、`useStudioStore`、`readAssetText`。
- Produces:
  - `promptPreview(node, styleGuide?) -> PromptSnapshot`
  - `pruneCommandsForMode(doc, nodeId, mode) -> GraphCommand[]`（切换视频模式时断开不兼容端口，并写入新 mode）
  - `candidateKind(nodeType) -> 'image' | 'video' | 'audio' | 'text'`
  - `useTextAsset(assetId?) -> string`
  - `Inspector`（字段编辑、提示词预览/锁定、检查项、运行历史、候选选择、复制/删除节点）
  - `FieldEditor`、`CandidateList`、`RunHistory`

- [ ] **Step 1: 写失败的 Inspector 纯逻辑测试**

`src/inspector/model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { emptyStyleGuide } from '../domain/types';
import { edge, makeDoc, node } from '../domain/graph/testFixtures';
import { candidateKind, promptPreview, pruneCommandsForMode } from './model';

describe('inspector model', () => {
  it('compiles style variables and honors a locked override', () => {
    const style = { ...emptyStyleGuide(), visualStyle: '冷色电影感' };
    const image = node('n', 'image', { prompt: '{{style.visualStyle}}，雨夜' });
    expect(promptPreview(image, style).text).toBe('冷色电影感，雨夜');
    const locked = { ...image, data: { ...image.data, promptLocked: true, promptOverride: '锁定文本' } };
    expect(promptPreview(locked, style).text).toBe('锁定文本');
    expect(promptPreview(locked, style).locked).toBe(true);
  });

  it('prunes incompatible ports when the video mode changes', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('i', 'image'), node('v', 'video', { mode: 'reference', prompt: 'x' })],
      [
        edge('e1', 't', 'v'),
        edge('e2', 'i', 'v', 'image', 'references', 'reference_image'),
      ],
    );
    const commands = pruneCommandsForMode(doc, 'v', 'firstLast');
    expect(commands).toContainEqual({ type: 'disconnect', edgeId: 'e2' });
    expect(commands).toContainEqual({ type: 'setNodeData', nodeId: 'v', patch: { mode: 'firstLast' } });
    expect(commands.some((command) => command.type === 'disconnect' && command.edgeId === 'e1')).toBe(false);
  });

  it('maps node types to candidate kinds', () => {
    expect(candidateKind('video')).toBe('video');
    expect(candidateKind('audio')).toBe('audio');
    expect(candidateKind('text')).toBe('text');
    expect(candidateKind('image')).toBe('image');
    expect(candidateKind('note')).toBe('image');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./model`。

- [ ] **Step 3: 实现 Inspector 纯逻辑**

`src/inspector/model.ts`：

```ts
import type { GraphCommand } from '../domain/graph/commands';
import { compilePrompt } from '../domain/prompts/compile';
import type { BoardDoc, BoardNode, PromptSnapshot, StyleGuide } from '../domain/types';

export type CandidateKind = 'image' | 'video' | 'audio' | 'text';
export type VideoMode = 't2v' | 'firstLast' | 'reference';

const PORTS_BY_MODE: Record<VideoMode, string[]> = {
  t2v: ['prompt'],
  firstLast: ['prompt', 'start', 'end'],
  reference: ['prompt', 'references', 'referenceVideo', 'referenceAudio'],
};

export function promptPreview(node: BoardNode, styleGuide?: StyleGuide): PromptSnapshot {
  const template = String(node.data.prompt ?? node.data.text ?? '');
  const lockedText = node.data.promptLocked ? String(node.data.promptOverride ?? '') : undefined;
  return compilePrompt(template, { variables: {}, styleGuide, lockedText });
}

export function pruneCommandsForMode(doc: BoardDoc, nodeId: string, mode: VideoMode): GraphCommand[] {
  const keep = new Set(PORTS_BY_MODE[mode]);
  const commands: GraphCommand[] = Object.values(doc.edges)
    .filter((edge) => edge.target === nodeId && !keep.has(edge.targetPort))
    .map((edge) => ({ type: 'disconnect' as const, edgeId: edge.id }));
  commands.push({ type: 'setNodeData', nodeId, patch: { mode } });
  return commands;
}

export function candidateKind(nodeType: string): CandidateKind {
  if (nodeType === 'video') return 'video';
  if (nodeType === 'audio') return 'audio';
  if (nodeType === 'text') return 'text';
  return 'image';
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm test:unit`
Expected: PASS。

- [ ] **Step 5: 写文本资产读取钩子**

`src/nodes/useTextAsset.ts`：

```ts
import { useEffect, useState } from 'react';
import { readAssetText } from '../services/tauri';

export function useTextAsset(assetId?: string): string {
  const [text, setText] = useState('');

  useEffect(() => {
    if (!assetId) {
      setText('');
      return;
    }
    let alive = true;
    readAssetText(assetId)
      .then((value) => { if (alive) setText(value); })
      .catch(() => { if (alive) setText(''); });
    return () => { alive = false; };
  }, [assetId]);

  return text;
}
```

- [ ] **Step 6: 写字段编辑器**

`src/inspector/FieldEditor.tsx`：

```tsx
import type { FieldDef } from '../domain/nodes/types';
import { useBoardStore } from '../stores/boardStore';

export interface FieldChangeOptions {
  history: boolean;
}

interface FieldEditorProps {
  field: FieldDef;
  value: unknown;
  onChange(field: FieldDef, value: unknown, options: FieldChangeOptions): void;
}

export function FieldEditor({ field, value, onChange }: FieldEditorProps) {
  const textual = field.type === 'text' || field.type === 'textarea';

  function onTextChange(next: string) {
    onChange(field, next, { history: false });
  }

  return (
    <div className="inspector-field">
      <span>{field.label}</span>
      {field.type === 'textarea' && (
        <textarea
          className="nodrag"
          rows={4}
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onFocus={() => useBoardStore.getState().beginGesture()}
          onBlur={() => useBoardStore.getState().endGesture()}
          onChange={(event) => onTextChange(event.target.value)}
        />
      )}
      {field.type === 'text' && (
        <input
          className="nodrag"
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onFocus={() => useBoardStore.getState().beginGesture()}
          onBlur={() => useBoardStore.getState().endGesture()}
          onChange={(event) => onTextChange(event.target.value)}
        />
      )}
      {field.type === 'number' && (
        <input
          className="nodrag"
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={field.placeholder}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(field, raw === '' ? '' : Number(raw), { history: true });
          }}
        />
      )}
      {field.type === 'select' && (
        <select
          className="nodrag"
          value={String(value ?? '')}
          onChange={(event) => onChange(field, event.target.value, { history: true })}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      )}
      {field.type === 'toggle' && (
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          className="inspector-toggle"
          onClick={() => onChange(field, !value, { history: true })}
        >
          <span>{Boolean(value) ? '开启' : '关闭'}</span>
          <i />
        </button>
      )}
      {field.help && <small>{field.help}</small>}
      {textual && <small>编辑时自动合并为一个撤销步骤</small>}
    </div>
  );
}
```

- [ ] **Step 7: 写运行历史与候选列表**

`src/inspector/RunHistory.tsx`：

```tsx
import type { RunRecord } from '../domain/types';
import { statusOf } from '../nodes/summary';

export function RunHistory({ runs }: { runs: RunRecord[] }) {
  if (!runs.length) return <p className="inspector-note">还没有运行记录。</p>;
  return (
    <div className="run-history">
      {runs.map((run) => (
        <div className="run-row" key={run.id}>
          <span className={`run-dot tone-${statusOf(run).tone}`} />
          <span>{statusOf(run).label}</span>
          <span className="run-time">{new Date(run.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="run-model" title={run.model ?? run.action}>{run.model ?? run.action}</span>
          {run.error && <span className="run-error">{run.error.message}</span>}
        </div>
      ))}
    </div>
  );
}
```

`src/inspector/CandidateList.tsx`：

```tsx
import type { RunRecord } from '../domain/types';
import { statusOf } from '../nodes/summary';
import { useAssetUrl } from '../nodes/useAssetUrl';
import { useTextAsset } from '../nodes/useTextAsset';
import type { CandidateKind } from './model';

interface CandidateListProps {
  run?: RunRecord;
  kind: CandidateKind;
  busy: boolean;
  onSelect(assetId: string): void;
}

interface CandidateThumbProps {
  assetId: string;
  kind: CandidateKind;
  index: number;
  selected: boolean;
  busy: boolean;
  onSelect(): void;
}

function CandidateThumb({ assetId, kind, index, selected, busy, onSelect }: CandidateThumbProps) {
  const url = useAssetUrl(kind === 'text' ? undefined : assetId);
  const text = useTextAsset(kind === 'text' ? assetId : undefined);
  return (
    <div className={`candidate-card${selected ? ' is-selected' : ''}`}>
      {kind === 'audio' ? (
        <div className="candidate-media candidate-audio">
          {url ? <audio src={url} controls preload="metadata" /> : <span className="candidate-placeholder">音频</span>}
        </div>
      ) : (
        <button
          type="button"
          className="candidate-media"
          onClick={onSelect}
          disabled={busy}
          aria-label={`选择候选 ${index + 1}`}
        >
          {kind === 'image' && (url ? <img src={url} alt="" draggable={false} /> : <span className="candidate-placeholder">图片</span>)}
          {kind === 'video' && (url ? <video src={url} muted playsInline preload="metadata" /> : <span className="candidate-placeholder">视频</span>)}
          {kind === 'text' && <span className="candidate-text">{text || '文本结果'}</span>}
          {selected && <i className="candidate-check">已选</i>}
        </button>
      )}
      <div className="candidate-meta">
        <span>#{index + 1}</span>
        <button type="button" onClick={onSelect} disabled={busy}>{selected ? '当前' : '选择'}</button>
      </div>
    </div>
  );
}

export function CandidateList({ run, kind, busy, onSelect }: CandidateListProps) {
  if (!run) return <p className="inspector-note">运行完成后在这里选择候选。</p>;
  if (run.status === 'queued' || run.status === 'running') {
    return <p className="inspector-note">{statusOf(run).label}…完成后在这里选择候选。</p>;
  }
  if (run.status === 'failed') {
    return <p className="inspector-warning">最近一次运行失败：{run.error?.message ?? '未知错误'}</p>;
  }
  if (run.status === 'cancelled') return <p className="inspector-note">最近一次运行已取消。</p>;
  if (!run.outputAssetIds.length) return <p className="inspector-note">这次运行没有输出。</p>;
  return (
    <div className="candidate-grid">
      {run.outputAssetIds.map((assetId, index) => (
        <CandidateThumb
          key={assetId}
          assetId={assetId}
          kind={kind}
          index={index}
          selected={run.selectedAssetId === assetId}
          busy={busy}
          onSelect={() => onSelect(assetId)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 8: 写 Inspector**

`src/inspector/Inspector.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Copy, Lock, Trash2, Unlock } from 'lucide-react';
import { createNode, getNodeDefinition } from '../domain/nodes/definitions';
import type { FieldDef } from '../domain/nodes/types';
import { nodeIssues } from '../domain/graph/validate';
import { selectRunCandidate } from '../services/tauri';
import { useBoardStore } from '../stores/boardStore';
import { useRunStore } from '../stores/runStore';
import { useStudioStore } from '../stores/studioStore';
import { statusOf } from '../nodes/summary';
import { CandidateList } from './CandidateList';
import { FieldEditor, type FieldChangeOptions } from './FieldEditor';
import { RunHistory } from './RunHistory';
import { candidateKind, promptPreview, pruneCommandsForMode } from './model';

export function Inspector() {
  const board = useBoardStore((state) => state.board);
  const nodeId = useBoardStore((state) => state.selectedNodeId);
  const node = nodeId && board ? board.nodes[nodeId] : undefined;
  const project = useStudioStore((state) => state.projects.find((item) => item.id === state.currentProjectId));
  const runs = useRunStore((state) => state.runs);
  const [busy, setBusy] = useState(false);

  const def = node ? getNodeDefinition(node.type) : undefined;
  const nodeRuns = useMemo(
    () => Object.values(runs)
      .filter((run) => run.nodeId === nodeId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [runs, nodeId],
  );
  const latestRun = nodeRuns[0];
  const issues = useMemo(
    () => (board && node ? nodeIssues(board, node.id, { providers: [], styleGuide: project?.styleGuide }) : []),
    [board, node, project],
  );
  const promptable = node ? ['text', 'image', 'video', 'audio'].includes(node.type) : false;
  const preview = useMemo(
    () => (node && promptable ? promptPreview(node, project?.styleGuide) : undefined),
    [node, promptable, project],
  );

  useEffect(() => {
    setBusy(false);
  }, [nodeId]);

  if (!node || !def) {
    return (
      <aside className="studio-inspector">
        <header className="inspector-head">
          <div>
            <span className="studio-eyebrow">INSPECTOR</span>
            <h2>节点属性</h2>
          </div>
        </header>
        <div className="inspector-empty">
          <p className="inspector-note">在画布中选中节点后，在这里编辑字段、预览提示词、查看运行历史与候选。</p>
        </div>
      </aside>
    );
  }

  function updateField(field: FieldDef, value: unknown, options: FieldChangeOptions) {
    if (node.type === 'video' && field.key === 'mode') {
      const mode = value as 't2v' | 'firstLast' | 'reference';
      const commands = board ? pruneCommandsForMode(board, node.id, mode) : [];
      if (commands.length) useBoardStore.getState().applyMany(commands);
      return;
    }
    useBoardStore.getState().apply({ type: 'setNodeData', nodeId: node.id, patch: { [field.key]: value } }, options);
  }

  function duplicateNode() {
    const copy = createNode(node.type, { x: node.position.x + 40, y: node.position.y + 40 }, node.data);
    useBoardStore.getState().apply({ type: 'addNode', node: copy });
    useBoardStore.getState().select(copy.id);
  }

  function removeNode() {
    useBoardStore.getState().apply({ type: 'removeNode', nodeId: node.id });
    useBoardStore.getState().selectMany([]);
  }

  function togglePromptLock() {
    if (!preview) return;
    const locked = Boolean(node.data.promptLocked);
    useBoardStore.getState().apply({
      type: 'setNodeData',
      nodeId: node.id,
      patch: locked
        ? { promptLocked: false, promptOverride: '' }
        : { promptLocked: true, promptOverride: preview.text },
    });
  }

  async function chooseCandidate(assetId: string) {
    if (!latestRun) return;
    setBusy(true);
    try {
      const updated = await selectRunCandidate(latestRun.id, assetId);
      useRunStore.getState().upsertRun(updated);
    } catch (error) {
      useBoardStore.getState().notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="studio-inspector">
      <header className="inspector-head">
        <div>
          <span className="studio-eyebrow">{def.category}</span>
          <h2>{def.title}</h2>
        </div>
        <div className="inspector-actions">
          <button type="button" title="复制节点" onClick={duplicateNode}><Copy size={13} /></button>
          <button type="button" title="删除节点" onClick={removeNode}><Trash2 size={13} /></button>
        </div>
      </header>

      <section className="inspector-section">
        <h3>字段</h3>
        {def.fields.map((field) => (
          <FieldEditor key={field.key} field={field} value={node.data[field.key]} onChange={updateField} />
        ))}
        {!def.fields.length && <p className="inspector-note">该节点没有可编辑字段。</p>}
      </section>

      {preview && (
        <section className="inspector-section">
          <div className="inspector-section-head">
            <h3>提示词预览</h3>
            <button type="button" className="inspector-link" onClick={togglePromptLock}>
              {node.data.promptLocked ? <><Unlock size={11} /> 解锁</> : <><Lock size={11} /> 锁定</>}
            </button>
          </div>
          <p className="prompt-preview">{preview.text || '（空）'}</p>
          {preview.negative && <p className="inspector-note">负向：{preview.negative}</p>}
          {!!preview.segments.length && (
            <div className="prompt-segments">
              {preview.segments.map((segment, index) => (
                <span key={`${segment.key}-${index}`} title={segment.text}>{segment.label}</span>
              ))}
            </div>
          )}
          {!!preview.missingVariables?.length && (
            <p className="inspector-warning">缺少变量：{preview.missingVariables.join('、')}</p>
          )}
        </section>
      )}

      <section className="inspector-section">
        <div className="inspector-section-head">
          <h3>运行</h3>
          <span className="studio-badge">{latestRun ? statusOf(latestRun).label : '未运行'}</span>
        </div>
        <RunHistory runs={nodeRuns} />
        {latestRun && (
          <CandidateList
            run={latestRun}
            kind={candidateKind(node.type)}
            busy={busy}
            onSelect={(assetId) => { void chooseCandidate(assetId); }}
          />
        )}
      </section>

      <section className="inspector-section">
        <h3>检查</h3>
        <ul className="issue-list">
          {issues.length
            ? issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className={issue.severity}>{issue.message}</li>
            ))
            : <li className="ok">当前节点没有发现问题</li>}
        </ul>
      </section>
    </aside>
  );
}
```

- [ ] **Step 9: 挂载 Inspector**

`src/app/StudioApp.tsx`：在 import 区加入：

```tsx
import { Inspector } from '../inspector/Inspector';
```

把整个 `<aside className="studio-inspector"> ... </aside>` 占位替换为：

```tsx
<Inspector />
```

- [ ] **Step 10: 追加 Inspector 样式**

在 `src/styles/studio.css` 末尾追加：

```css
.inspector-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.inspector-head h2 { margin: 2px 0 0; color: var(--text); font-size: 14px; font-weight: 500; }
.inspector-actions { display: flex; gap: 3px; }
.inspector-actions button { display: grid; place-items: center; width: 26px; height: 26px; color: var(--text-muted); border-radius: 4px; }
.inspector-actions button:hover { color: var(--text); background: var(--panel-3); }
.inspector-actions button:last-child:hover { color: #ffd9d4; background: #4a2a27; }
.inspector-empty { padding-top: 12px; }
.inspector-section { display: grid; gap: 9px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.inspector-section:last-child { border-bottom: 0; }
.inspector-section h3 { margin: 0; color: var(--text-dim); font-size: 10px; font-weight: 500; letter-spacing: .7px; text-transform: uppercase; }
.inspector-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.inspector-link { display: inline-flex; align-items: center; gap: 4px; color: var(--mint); font-size: 10px; }
.inspector-link:hover { color: var(--mint-strong); }
.inspector-field { display: grid; gap: 5px; }
.inspector-field > span { color: var(--text-muted); font-size: 10px; }
.inspector-field input, .inspector-field select, .inspector-field textarea { width: 100%; padding: 7px 8px; color: var(--text); background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 4px; font-size: 12px; }
.inspector-field textarea { min-height: 72px; resize: vertical; line-height: 1.5; }
.inspector-field small { color: var(--text-dim); font-size: 9px; }
.inspector-toggle { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; color: var(--text-muted); background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 4px; font-size: 11px; }
.inspector-toggle i { display: flex; align-items: center; width: 30px; height: 17px; padding: 2px; background: #333f40; border-radius: 9px; }
.inspector-toggle i::before { content: ''; width: 13px; height: 13px; background: #9aa9a7; border-radius: 50%; transition: transform .15s ease; }
.inspector-toggle[aria-checked="true"] i { background: #2f5c4f; }
.inspector-toggle[aria-checked="true"] i::before { background: var(--mint); transform: translateX(13px); }
.prompt-preview { max-height: 190px; margin: 0; padding: 9px; overflow: auto; color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; font-family: var(--font-mono); font-size: 10px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.prompt-segments { display: flex; flex-wrap: wrap; gap: 4px; }
.prompt-segments span { padding: 2px 5px; color: var(--text-muted); background: var(--panel-3); border-radius: 3px; font-family: var(--font-mono); font-size: 9px; }
.inspector-note { margin: 0; color: var(--text-dim); font-size: 10px; line-height: 1.6; }
.inspector-warning { margin: 0; color: var(--warning); font-size: 10px; line-height: 1.6; }
.issue-list { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
.issue-list li { padding: 6px 8px; color: var(--text-muted); background: var(--panel-2); border-left: 2px solid var(--line-strong); font-size: 10px; line-height: 1.5; }
.issue-list li.error { color: #f0b3ab; border-color: var(--danger); }
.issue-list li.warning { color: #f0d58d; border-color: var(--warning); }
.issue-list li.ok { color: var(--mint); border-color: #2f4a44; }
.run-history { display: grid; gap: 2px; }
.run-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding: 5px 6px; color: var(--text-muted); border-radius: 3px; font-size: 10px; }
.run-row:hover { background: var(--panel-2); }
.run-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--text-dim); }
.run-dot.tone-ok { background: var(--mint); }
.run-dot.tone-error { background: var(--danger); }
.run-dot.tone-busy { background: var(--warning); }
.run-time { margin-left: auto; color: var(--text-dim); font-family: var(--font-mono); }
.run-model { max-width: 88px; overflow: hidden; color: var(--text-dim); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.run-error { width: 100%; color: #e39a92; font-size: 9px; line-height: 1.4; }
.candidate-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.candidate-card { overflow: hidden; background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; }
.candidate-card.is-selected { border-color: var(--mint); box-shadow: inset 0 0 0 1px var(--mint); }
.candidate-media { position: relative; display: block; width: 100%; height: 92px; padding: 0; overflow: hidden; background: #0f1515; }
.candidate-media img, .candidate-media video { width: 100%; height: 100%; display: block; object-fit: cover; }
.candidate-media:disabled { cursor: wait; opacity: .7; }
.candidate-placeholder { display: grid; place-items: center; width: 100%; height: 100%; color: var(--text-dim); font-size: 10px; }
.candidate-text { display: block; height: 100%; padding: 7px; overflow: hidden; color: var(--text-muted); font-size: 9px; line-height: 1.5; text-align: left; }
.candidate-check { position: absolute; top: 5px; right: 5px; padding: 2px 4px; color: #10201d; background: var(--mint); border-radius: 2px; font-size: 8px; font-style: normal; }
.candidate-meta { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px; color: var(--text-dim); font-family: var(--font-mono); font-size: 9px; }
.candidate-meta button { color: var(--mint); font-family: var(--font-ui); font-size: 9px; }
.candidate-audio { display: grid; place-items: center; }
.candidate-audio audio { width: 100%; height: 32px; }
```

- [ ] **Step 11: 运行测试与构建**

Run:
```bash
pnpm test:unit
pnpm build
```
Expected: Inspector 纯逻辑测试通过；构建无错。运行历史与候选的空态在 Task 21 之前是正常的。

- [ ] **Step 12: 手工验证**

Run: `pnpm tauri dev`
Expected:
1. 选中文本节点，修改提示词后自动保存；切换模式/尺寸等选择字段会生成一个撤销步骤。
2. 图片节点 `{{style.visualStyle}}` 在预览中被替换；锁定后编辑原提示词不影响预览，解锁恢复。
3. 视频节点把模式从「全能参考」改为「首尾帧」，已连接的参考图边被断开，检查项不再报告模式冲突。
4. 新节点显示「还没有运行记录」；没有必填输入时检查项显示缺失端口。
5. Inspector 的复制/删除按钮工作，删除后画布与 Inspector 同步清空。

- [ ] **Step 13: 提交**

```bash
git add src/inspector src/nodes/useTextAsset.ts src/app/StudioApp.tsx src/styles/studio.css
git commit -m "feat(p0): Inspector 字段编辑、提示词预览与候选选择"
```

---

### Task 20: Provider 设置、模型目录与素材外链

**Files:**
- Create: `src/settings/modelDraft.ts`
- Test: `src/settings/modelDraft.test.ts`
- Test: `src/inspector/modelCapability.test.ts`
- Modify: `src/inspector/model.ts`（追加能力映射与模型选项）
- Create: `src/stores/providerStore.ts`
- Create: `src/settings/ProviderForm.tsx`
- Create: `src/settings/AssetHostForm.tsx`
- Create: `src/settings/SettingsDialog.tsx`
- Modify: `src/inspector/Inspector.tsx`
- Modify: `src/app/StudioApp.tsx`
- Modify: `src/styles/studio.css`（追加设置面板样式）

**Interfaces:**
- Consumes: `DEFAULT_PROVIDERS`、`listProviderProfiles`、`saveProviderProfile`、`setProviderKey`、`providerHasKey`、`testProviderProfile`、`loadAssetHost`、`saveAssetHost`、`ProviderProfile`、`ModelConfig`。
- Produces:
  - `useProviderStore`：`profiles`、`hasKeys`、`assetHost`、`settingsOpen`、`boot()`、`saveProfile()`、`saveKey()`、`test()`、`saveHost()`、`openSettings()`、`closeSettings()`。
  - `draftFromModel` / `modelFromDraft` / `validDrafts` / `emptyModelDraft` / `capabilitySummary`。
  - `capabilityForNode(board, node)` / `modelOptions(profiles, capability)` / `capabilityLabel(capability)`。
  - `SettingsDialog`、`ProviderForm`、`AssetHostForm`。

- [ ] **Step 1: 写失败的模型草稿测试**

`src/settings/modelDraft.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../domain/types';
import { draftFromModel, emptyModelDraft, modelFromDraft, validDrafts } from './modelDraft';

const model: ModelConfig = {
  id: 'gpt-4o-mini',
  displayName: 'GPT-4o mini',
  capabilities: [
    {
      capability: 'text.chat', inputTransport: ['dataUrl'], async: false,
      price: { unit: 'request', amount: 0.01, currency: 'USD' },
    },
    { capability: 'video.generate', inputTransport: ['publicUrl'], async: true },
  ],
};

describe('model drafts', () => {
  it('keeps simple capabilities and price', () => {
    const draft = draftFromModel(model);
    expect(draft.capabilities).toEqual(['text.chat']);
    expect(draft.priceAmount).toBe(0.01);
    expect(draft.priceUnit).toBe('request');
  });

  it('builds a model with trimmed id and fallback display name', () => {
    const built = modelFromDraft({
      id: '  gpt-image-1 ', displayName: '  ', capabilities: ['image.generate'],
      priceAmount: 0.04, priceUnit: 'image',
    });
    expect(built.id).toBe('gpt-image-1');
    expect(built.displayName).toBe('gpt-image-1');
    expect(built.capabilities[0].price).toEqual({ unit: 'image', amount: 0.04, currency: 'USD' });
  });

  it('drops drafts without an id', () => {
    expect(validDrafts([emptyModelDraft(), { ...emptyModelDraft(), id: 'x' }])).toHaveLength(1);
  });
});
```

`src/inspector/modelCapability.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ProviderProfile } from '../domain/types';
import { edge, makeDoc, node } from '../domain/graph/testFixtures';
import { capabilityForNode, capabilityLabel, modelOptions } from './model';

const capability = (name: string) => ({ capability: name, inputTransport: ['dataUrl'] as const, async: false });

const profiles: ProviderProfile[] = [
  {
    id: 'oai', name: 'OpenAI 兼容', adapter: 'openai-compatible', baseUrl: 'https://example.com',
    auth: { type: 'bearer', keyRef: 'provider/oai' }, enabled: true, schemaVersion: 1,
    models: [{ id: 'gpt', displayName: 'GPT', capabilities: [{ ...capability('text.chat'), inputTransport: ['dataUrl'] }] }],
  },
  {
    id: 'off', name: '停用', adapter: 'openai-compatible', baseUrl: '',
    auth: { type: 'bearer', keyRef: 'provider/off' }, enabled: false, schemaVersion: 1,
    models: [{ id: 'x', displayName: 'X', capabilities: [{ ...capability('text.chat'), inputTransport: ['dataUrl'] }] }],
  },
];

describe('model capability routing', () => {
  it('lists enabled models by capability', () => {
    expect(modelOptions(profiles, 'text.chat')).toEqual([
      { providerId: 'oai', providerName: 'OpenAI 兼容', modelId: 'gpt', modelName: 'GPT' },
    ]);
    expect(modelOptions(profiles, 'video.generate')).toEqual([]);
  });

  it('maps node types and reference ports to capabilities', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('i', 'image'), node('v', 'video'), node('a', 'audio'), node('e', 'image')],
      [
        edge('e1', 't', 'e'),
        edge('e2', 'i', 'e', 'image', 'references', 'reference_image'),
      ],
    );
    expect(capabilityForNode(doc, doc.nodes.t)).toBe('text.chat');
    expect(capabilityForNode(doc, doc.nodes.i)).toBe('image.generate');
    expect(capabilityForNode(doc, doc.nodes.v)).toBe('video.generate');
    expect(capabilityForNode(doc, doc.nodes.a)).toBe('audio.tts');
    expect(capabilityForNode(doc, doc.nodes.e)).toBe('image.edit');
  });

  it('labels capabilities in Chinese', () => {
    expect(capabilityLabel('video.generate')).toBe('视频生成');
    expect(capabilityLabel('unknown.cap')).toBe('unknown.cap');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./modelDraft` 与 `capabilityForNode`。

- [ ] **Step 3: 实现模型草稿**

`src/settings/modelDraft.ts`：

```ts
import type { ModelCapability, ModelConfig, PriceRule } from '../domain/types';

export type SimpleCapability = 'text.chat' | 'image.generate' | 'image.edit' | 'audio.tts';
export type SimplePriceUnit = 'request' | 'image' | 'second' | 'character';

export interface ModelDraft {
  id: string;
  displayName: string;
  capabilities: SimpleCapability[];
  priceAmount?: number;
  priceUnit: SimplePriceUnit;
}

export const SIMPLE_CAPABILITIES: Array<{ value: SimpleCapability; label: string }> = [
  { value: 'text.chat', label: '文本' },
  { value: 'image.generate', label: '生图' },
  { value: 'image.edit', label: '改图' },
  { value: 'audio.tts', label: '语音' },
];

const SIMPLE_SET = new Set<string>(SIMPLE_CAPABILITIES.map((item) => item.value));

export function isSimpleCapability(value: string): value is SimpleCapability {
  return SIMPLE_SET.has(value);
}

export function draftFromModel(model: ModelConfig): ModelDraft {
  const firstPrice = model.capabilities.find((item) => item.price)?.price;
  return {
    id: model.id,
    displayName: model.displayName,
    capabilities: model.capabilities.map((item) => item.capability).filter(isSimpleCapability),
    priceAmount: firstPrice?.amount,
    priceUnit: firstPrice && firstPrice.unit !== 'token' ? firstPrice.unit : 'request',
  };
}

export function modelFromDraft(draft: ModelDraft): ModelConfig {
  const id = draft.id.trim();
  const price: PriceRule | undefined = draft.priceAmount && draft.priceAmount > 0
    ? { unit: draft.priceUnit, amount: draft.priceAmount, currency: 'USD' }
    : undefined;
  const capabilities: ModelCapability[] = draft.capabilities.map((item) => ({
    capability: item,
    inputTransport: ['dataUrl'],
    async: false,
    ...(price ? { price } : {}),
  }));
  return { id, displayName: draft.displayName.trim() || id, capabilities };
}

export function emptyModelDraft(): ModelDraft {
  return { id: '', displayName: '', capabilities: ['text.chat'], priceUnit: 'request' };
}

export function validDrafts(drafts: ModelDraft[]): ModelConfig[] {
  return drafts
    .map(modelFromDraft)
    .filter((model) => model.id.length > 0 && model.capabilities.length > 0);
}

export function capabilitySummary(item: ModelCapability): string {
  const parts = [item.capability];
  if (item.modes?.length) parts.push(item.modes.join('/'));
  if (item.durations) parts.push(`${item.durations.min}-${item.durations.max}s`);
  if (item.resolutions?.length) parts.push(item.resolutions.join('/'));
  if (item.inputTransport.length) parts.push(item.inputTransport.join('/'));
  return parts.join(' · ');
}
```

TypeScript 可能对 `firstPrice.unit !== 'token'` 的收窄不满意：若报错，改成 `firstPrice && ['request', 'image', 'second', 'character'].includes(firstPrice.unit) ? firstPrice.unit as SimplePriceUnit : 'request'`。

- [ ] **Step 4: 追加 Inspector 能力映射**

在 `src/inspector/model.ts` 末尾追加：

```ts
import type { ProviderProfile } from '../domain/types';

const CAPABILITY_LABEL: Record<string, string> = {
  'text.chat': '文本生成',
  'image.generate': '图片生成',
  'image.edit': '图片编辑',
  'video.generate': '视频生成',
  'audio.tts': '语音合成',
};

export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABEL[capability] ?? capability;
}

export function capabilityForNode(board: BoardDoc, node: BoardNode): string | undefined {
  if (node.type === 'text') return 'text.chat';
  if (node.type === 'image') {
    const hasReference = Object.values(board.edges).some((edge) =>
      edge.target === node.id && (edge.targetPort === 'references' || edge.targetPort === 'style'));
    return hasReference ? 'image.edit' : 'image.generate';
  }
  if (node.type === 'video') return 'video.generate';
  if (node.type === 'audio') return 'audio.tts';
  return undefined;
}

export interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

export function modelOptions(profiles: ProviderProfile[], capability: string): ModelOption[] {
  const options: ModelOption[] = [];
  for (const profile of profiles) {
    if (!profile.enabled) continue;
    for (const model of profile.models) {
      if (!model.capabilities.some((item) => item.capability === capability)) continue;
      options.push({
        providerId: profile.id,
        providerName: profile.name,
        modelId: model.id,
        modelName: model.displayName,
      });
    }
  }
  return options;
}
```

注意：`model.ts` 顶部已有 `BoardDoc`/`BoardNode` 的 type import，追加代码时不要重复导入；`ProviderProfile` 若已在顶部导入则删除这一行新增。

- [ ] **Step 5: 运行测试**

Run: `pnpm test:unit`
Expected: PASS。

- [ ] **Step 6: 写 Provider Store**

`src/stores/providerStore.ts`：

```ts
import { create } from 'zustand';
import { DEFAULT_PROVIDERS } from '../domain/providers/capabilities';
import type { ProviderProfile } from '../domain/types';
import {
  listProviderProfiles,
  loadAssetHost,
  providerHasKey,
  saveAssetHost,
  saveProviderProfile,
  setProviderKey,
  testProviderProfile,
  type AssetHostConfig,
  type ProviderTestResult,
} from '../services/tauri';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ProviderState {
  loaded: boolean;
  loading: boolean;
  error?: string;
  profiles: ProviderProfile[];
  hasKeys: Record<string, boolean>;
  assetHost?: AssetHostConfig & { hasCredentials?: boolean };
  settingsOpen: boolean;
  boot(): Promise<void>;
  saveProfile(profile: ProviderProfile): Promise<void>;
  saveKey(providerId: string, apiKey: string): Promise<void>;
  test(providerId: string): Promise<ProviderTestResult>;
  saveHost(config: AssetHostConfig): Promise<void>;
  openSettings(): void;
  closeSettings(): void;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  loaded: false,
  loading: false,
  profiles: [],
  hasKeys: {},
  settingsOpen: false,

  async boot() {
    if (get().loaded || get().loading) return;
    set({ loading: true, error: undefined });
    try {
      let profiles = await listProviderProfiles();
      if (!profiles.length) {
        for (const profile of DEFAULT_PROVIDERS) await saveProviderProfile(profile);
        profiles = await listProviderProfiles();
      }
      const hasKeys = Object.fromEntries(await Promise.all(
        profiles.map(async (profile) => [profile.id, await providerHasKey(profile.id)] as const),
      ));
      const assetHost = await loadAssetHost();
      set({ loaded: true, loading: false, profiles, hasKeys, assetHost });
    } catch (error) {
      set({ loaded: true, loading: false, error: messageOf(error) });
    }
  },

  async saveProfile(profile) {
    await saveProviderProfile(profile);
    set((state) => ({
      profiles: state.profiles.some((item) => item.id === profile.id)
        ? state.profiles.map((item) => (item.id === profile.id ? profile : item))
        : [...state.profiles, profile],
      error: undefined,
    }));
  },

  async saveKey(providerId, apiKey) {
    await setProviderKey(providerId, apiKey);
    set((state) => ({ hasKeys: { ...state.hasKeys, [providerId]: true }, error: undefined }));
  },

  async test(providerId) {
    return testProviderProfile(providerId);
  },

  async saveHost(config) {
    await saveAssetHost(config);
    const assetHost = await loadAssetHost();
    set({ assetHost, error: undefined });
  },

  openSettings() {
    set({ settingsOpen: true });
  },

  closeSettings() {
    set({ settingsOpen: false });
  },
}));
```

- [ ] **Step 7: 写 Provider 表单**

`src/settings/ProviderForm.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProviderProfile } from '../domain/types';
import { useProviderStore } from '../stores/providerStore';
import {
  SIMPLE_CAPABILITIES,
  capabilitySummary,
  draftFromModel,
  emptyModelDraft,
  validDrafts,
  type ModelDraft,
  type SimpleCapability,
  type SimplePriceUnit,
} from './modelDraft';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProviderForm({ profile }: { profile: ProviderProfile }) {
  const hasKey = useProviderStore((state) => Boolean(state.hasKeys[profile.id]));
  const saveProfile = useProviderStore((state) => state.saveProfile);
  const saveKey = useProviderStore((state) => state.saveKey);
  const test = useProviderStore((state) => state.test);
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl);
  const [enabled, setEnabled] = useState(profile.enabled);
  const [drafts, setDrafts] = useState<ModelDraft[]>(() => profile.models.map(draftFromModel));
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    setBaseUrl(profile.baseUrl);
    setEnabled(profile.enabled);
    setDrafts(profile.models.map(draftFromModel));
  }, [profile]);

  function patchDraft(index: number, patch: Partial<ModelDraft>) {
    setDrafts((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function toggleCapability(index: number, capability: SimpleCapability) {
    setDrafts((items) => items.map((item, i) => {
      if (i !== index) return item;
      const active = item.capabilities.includes(capability);
      return {
        ...item,
        capabilities: active
          ? item.capabilities.filter((value) => value !== capability)
          : [...item.capabilities, capability],
      };
    }));
  }

  async function save() {
    setBusy(true);
    setStatus(undefined);
    try {
      const models = profile.adapter === 'openai-compatible' ? validDrafts(drafts) : profile.models;
      await saveProfile({ ...profile, baseUrl: baseUrl.trim(), enabled, models });
      if (apiKey.trim()) {
        await saveKey(profile.id, apiKey.trim());
        setApiKey('');
      }
      setStatus({ ok: true, message: '已保存' });
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setStatus(undefined);
    try {
      const result = await test(profile.id);
      setStatus({ ok: result.ok, message: result.message });
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="settings-provider">
      <header className="settings-provider-head">
        <div>
          <b>{profile.name}</b>
          <span className="studio-badge">{profile.adapter}</span>
        </div>
        <label className="settings-check">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 启用
        </label>
      </header>

      <label className="studio-field">
        <span>Base URL</span>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={profile.adapter === 'minimax-h3' ? 'https://api.minimax.io' : 'https://api.example.com/v1'}
        />
      </label>

      <label className="studio-field">
        <span>API Key {hasKey ? '（已保存，留空不修改）' : '（未保存）'}</span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? '••••••••' : '粘贴 API Key'}
        />
      </label>

      {profile.adapter === 'openai-compatible' ? (
        <div className="settings-models">
          <div className="settings-models-head">
            <h4>模型</h4>
            <button type="button" className="inspector-link" onClick={() => setDrafts((items) => [...items, emptyModelDraft()])}>
              <Plus size={11} /> 添加模型
            </button>
          </div>
          {drafts.map((draft, index) => (
            <div className="settings-model" key={index}>
              <div className="settings-model-row">
                <input placeholder="模型 ID，例如 gpt-4o-mini" value={draft.id} onChange={(event) => patchDraft(index, { id: event.target.value })} />
                <input placeholder="显示名（可空）" value={draft.displayName} onChange={(event) => patchDraft(index, { displayName: event.target.value })} />
                <button type="button" className="settings-remove" title="删除模型" onClick={() => setDrafts((items) => items.filter((_, i) => i !== index))}>
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="settings-capabilities">
                {SIMPLE_CAPABILITIES.map((capability) => (
                  <label key={capability.value}>
                    <input
                      type="checkbox"
                      checked={draft.capabilities.includes(capability.value)}
                      onChange={() => toggleCapability(index, capability.value)}
                    />
                    {capability.label}
                  </label>
                ))}
              </div>
              <div className="settings-price">
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  placeholder="单价（可选）"
                  value={draft.priceAmount ?? ''}
                  onChange={(event) => patchDraft(index, { priceAmount: event.target.value === '' ? undefined : Number(event.target.value) })}
                />
                <select value={draft.priceUnit} onChange={(event) => patchDraft(index, { priceUnit: event.target.value as SimplePriceUnit })}>
                  <option value="request">每次</option>
                  <option value="image">每张</option>
                  <option value="second">每秒</option>
                  <option value="character">每字符</option>
                </select>
              </div>
            </div>
          ))}
          {!drafts.length && <p className="inspector-note">还没有模型。至少添加一个文本或生图模型。</p>}
        </div>
      ) : (
        <div className="settings-model-readonly">
          {profile.models.map((model) => (
            <div key={model.id}>
              <b>{model.displayName}</b>
              <span>{model.capabilities.map(capabilitySummary).join(' / ')}</span>
            </div>
          ))}
        </div>
      )}

      <div className="settings-actions">
        <button type="button" className="studio-button" onClick={() => { void save(); }} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="studio-button secondary" onClick={() => { void runTest(); }} disabled={testing || !hasKey}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        {!hasKey && <span className="inspector-note">先保存 Key 才能测试连接。</span>}
      </div>
      {status && <p className={status.ok ? 'settings-ok' : 'settings-error'}>{status.message}</p>}
    </section>
  );
}
```

- [ ] **Step 8: 写素材外链表单与设置弹窗**

`src/settings/AssetHostForm.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { useProviderStore } from '../stores/providerStore';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AssetHostForm() {
  const assetHost = useProviderStore((state) => state.assetHost);
  const saveHost = useProviderStore((state) => state.saveHost);
  const [strategy, setStrategy] = useState<'dataUrl' | 's3'>(assetHost?.strategy === 's3' ? 's3' : 'dataUrl');
  const [endpoint, setEndpoint] = useState(assetHost?.endpoint ?? '');
  const [bucket, setBucket] = useState(assetHost?.bucket ?? '');
  const [region, setRegion] = useState(assetHost?.region ?? '');
  const [prefix, setPrefix] = useState(assetHost?.prefix ?? 'frameforge');
  const [publicBaseUrl, setPublicBaseUrl] = useState(assetHost?.publicBaseUrl ?? '');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    if (!assetHost) return;
    setStrategy(assetHost.strategy === 's3' ? 's3' : 'dataUrl');
    setEndpoint(assetHost.endpoint ?? '');
    setBucket(assetHost.bucket ?? '');
    setRegion(assetHost.region ?? '');
    setPrefix(assetHost.prefix ?? 'frameforge');
    setPublicBaseUrl(assetHost.publicBaseUrl ?? '');
  }, [assetHost]);

  async function save() {
    setBusy(true);
    setStatus(undefined);
    try {
      await saveHost({
        strategy,
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        region: region.trim(),
        prefix: prefix.trim(),
        publicBaseUrl: publicBaseUrl.trim(),
        accessKey: accessKey.trim() || undefined,
        secretKey: secretKey.trim() || undefined,
      });
      setAccessKey('');
      setSecretKey('');
      setStatus({ ok: true, message: '素材外链设置已保存' });
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-provider">
      <header className="settings-provider-head">
        <div>
          <b>素材外链</b>
          <span className="studio-badge">{strategy === 's3' ? 'S3 兼容桶' : 'Data URL'}</span>
        </div>
      </header>

      <label className="studio-field">
        <span>传输策略</span>
        <select value={strategy} onChange={(event) => setStrategy(event.target.value as 'dataUrl' | 's3')}>
          <option value="dataUrl">Data URL（仅兼容中转）</option>
          <option value="s3">S3 兼容桶（H3 官方接口）</option>
        </select>
      </label>

      {strategy === 's3' && (
        <>
          <label className="studio-field"><span>Endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://s3.us-east-1.amazonaws.com" /></label>
          <label className="studio-field"><span>Bucket</span><input value={bucket} onChange={(event) => setBucket(event.target.value)} /></label>
          <label className="studio-field"><span>Region</span><input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="us-east-1" /></label>
          <label className="studio-field"><span>对象前缀</span><input value={prefix} onChange={(event) => setPrefix(event.target.value)} /></label>
          <label className="studio-field"><span>公网访问前缀</span><input value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="https://cdn.example.com" /></label>
          <label className="studio-field">
            <span>Access Key {assetHost?.hasCredentials ? '（已保存，留空不修改）' : ''}</span>
            <input type="password" autoComplete="off" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} />
          </label>
          <label className="studio-field">
            <span>Secret Key {assetHost?.hasCredentials ? '（已保存，留空不修改）' : ''}</span>
            <input type="password" autoComplete="off" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} />
          </label>
          <p className="inspector-note">桶必须允许公开读取，H3 才能拉取素材。密钥只写入系统钥匙串，不进入项目与日志。</p>
        </>
      )}

      {strategy === 'dataUrl' && (
        <p className="inspector-note">Data URL 仅适用于支持 base64 素材的 OpenAI 兼容中转；H3 官方接口需要 S3 公网 URL。</p>
      )}

      <div className="settings-actions">
        <button type="button" className="studio-button" onClick={() => { void save(); }} disabled={busy}>
          {busy ? '保存中…' : '保存外链设置'}
        </button>
      </div>
      {status && <p className={status.ok ? 'settings-ok' : 'settings-error'}>{status.message}</p>}
    </section>
  );
}
```

`src/settings/SettingsDialog.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useProviderStore } from '../stores/providerStore';
import { AssetHostForm } from './AssetHostForm';
import { ProviderForm } from './ProviderForm';

export function SettingsDialog() {
  const open = useProviderStore((state) => state.settingsOpen);
  const close = useProviderStore((state) => state.closeSettings);
  const profiles = useProviderStore((state) => state.profiles);
  const loaded = useProviderStore((state) => state.loaded);
  const loading = useProviderStore((state) => state.loading);
  const error = useProviderStore((state) => state.error);
  const [tab, setTab] = useState<'providers' | 'assets'>('providers');

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="设置">
      <div className="settings-dialog">
        <header className="settings-head">
          <h2>设置</h2>
          <button type="button" className="studio-icon-button" title="关闭" onClick={close}><X size={15} /></button>
        </header>
        <nav className="settings-tabs">
          <button type="button" className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>模型接入</button>
          <button type="button" className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>素材外链</button>
        </nav>
        <div className="settings-body">
          {error && <p className="settings-error">{error}</p>}
          {!loaded && <p className="inspector-note">{loading ? '正在加载设置…' : '设置尚未加载'}</p>}
          {loaded && tab === 'providers' && profiles.map((profile) => <ProviderForm key={profile.id} profile={profile} />)}
          {loaded && tab === 'assets' && <AssetHostForm />}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: 在 Inspector 中接入模型选择**

`src/inspector/Inspector.tsx` 做四处修改：

1）import 区追加：

```tsx
import { useProviderStore } from '../stores/providerStore';
import { capabilityForNode, capabilityLabel, modelOptions } from './model';
```

2）在 `preview` 的 `useMemo` 之后追加：

```tsx
const profiles = useProviderStore((state) => state.profiles);
const hasKeys = useProviderStore((state) => state.hasKeys);
const openSettings = useProviderStore((state) => state.openSettings);
const capability = board && node ? capabilityForNode(board, node) : undefined;
const options = useMemo(
  () => (capability ? modelOptions(profiles, capability) : []),
  [profiles, capability],
);
```

3）在「字段」section 之后、「提示词预览」section 之前插入：

```tsx
{capability && (
  <section className="inspector-section">
    <h3>模型</h3>
    <div className="inspector-field">
      <span>运行模型</span>
      <select
        value={(() => {
          const providerId = String(node.data.providerId ?? '');
          const modelId = String(node.data.model ?? '');
          return options.some((option) => option.providerId === providerId && option.modelId === modelId)
            ? `${providerId}|${modelId}`
            : '';
        })()}
        onChange={(event) => {
          const [providerId, modelId] = event.target.value.split('|');
          useBoardStore.getState().apply({
            type: 'setNodeData',
            nodeId: node.id,
            patch: { providerId: providerId ?? '', model: modelId ?? '' },
          });
        }}
      >
        <option value="">自动选择</option>
        {options.map((option) => (
          <option key={`${option.providerId}|${option.modelId}`} value={`${option.providerId}|${option.modelId}`}>
            {option.providerName} · {option.modelName}
          </option>
        ))}
      </select>
    </div>
    <div className="inspector-section-head">
      <span className="inspector-note">能力：{capabilityLabel(capability)}</span>
      <button type="button" className="inspector-link" onClick={openSettings}>打开设置</button>
    </div>
    {!options.length && <p className="inspector-warning">没有可用模型，请先在设置中添加模型并保存 Key。</p>}
    {String(node.data.providerId ?? '') && hasKeys[String(node.data.providerId)] === false && (
      <p className="inspector-warning">所选 Provider 尚未保存 API Key。</p>
    )}
  </section>
)}
```

4）无需其他改动；`capability` 与 `options` 已在所有 hook 之后、条件 return 之前声明。

- [ ] **Step 10: 在 StudioApp 中挂设置入口**

`src/app/StudioApp.tsx`：

1）import 改为：

```tsx
import { FolderKanban, Plus, Save, Settings } from 'lucide-react';
```

并追加：

```tsx
import { SettingsDialog } from '../settings/SettingsDialog';
import { useProviderStore } from '../stores/providerStore';
```

2）在组件内已有 hooks 之后追加：

```tsx
const bootProviders = useProviderStore((state) => state.boot);
const openSettings = useProviderStore((state) => state.openSettings);
```

3）在 `useEffect(() => { void boot(); }, [boot]);` 之后追加：

```tsx
useEffect(() => {
  void bootProviders();
}, [bootProviders]);
```

4）在 topbar 的保存状态之前插入：

```tsx
<button type="button" className="studio-icon-button" title="设置" onClick={openSettings}>
  <Settings size={15} />
</button>
```

5）在 `<footer className="studio-dock">` 之前插入：

```tsx
<SettingsDialog />
```

- [ ] **Step 11: 追加设置样式**

在 `src/styles/studio.css` 末尾追加：

```css
.studio-icon-button { display: grid; place-items: center; width: 30px; height: 30px; color: var(--text-muted); border-radius: 4px; }
.studio-icon-button:hover { color: var(--text); background: var(--panel-3); }
.settings-backdrop { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 24px; background: rgba(6, 10, 10, .72); backdrop-filter: blur(3px); }
.settings-dialog { display: grid; grid-template-rows: auto auto minmax(0, 1fr); width: min(860px, 100%); max-height: min(760px, calc(100vh - 48px)); overflow: hidden; background: var(--panel); border: 1px solid var(--line-strong); border-radius: 8px; box-shadow: 0 24px 64px rgba(0, 0, 0, .5); }
.settings-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.settings-head h2 { margin: 0; font-size: 15px; }
.settings-tabs { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.settings-tabs button { padding: 6px 10px; color: var(--text-muted); border-radius: 4px; font-size: 11px; }
.settings-tabs button.active { color: var(--mint); background: #1c2b28; }
.settings-body { display: grid; align-content: start; gap: 16px; min-height: 0; padding: 16px; overflow: auto; }
.settings-provider { display: grid; gap: 10px; padding: 14px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; }
.settings-provider-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.settings-provider-head > div { display: flex; align-items: center; gap: 8px; }
.settings-provider-head b { font-size: 13px; }
.settings-check { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 11px; }
.settings-models { display: grid; gap: 8px; }
.settings-models-head { display: flex; align-items: center; justify-content: space-between; }
.settings-models-head h4 { margin: 0; color: var(--text-dim); font-size: 10px; font-weight: 500; letter-spacing: .6px; text-transform: uppercase; }
.settings-model { display: grid; gap: 7px; padding: 9px; background: var(--panel); border: 1px solid var(--line); border-radius: 5px; }
.settings-model-row { display: flex; gap: 6px; }
.settings-model-row input { flex: 1; min-width: 0; padding: 6px 7px; color: var(--text); background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 3px; font-size: 11px; }
.settings-remove { display: grid; place-items: center; width: 28px; color: var(--text-dim); border-radius: 3px; }
.settings-remove:hover { color: #ffd9d4; background: #4a2a27; }
.settings-capabilities { display: flex; flex-wrap: wrap; gap: 10px; color: var(--text-muted); font-size: 10px; }
.settings-capabilities label { display: inline-flex; align-items: center; gap: 4px; }
.settings-price { display: flex; gap: 6px; }
.settings-price input { width: 120px; padding: 5px 7px; color: var(--text); background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 3px; font-size: 10px; }
.settings-price select { padding: 5px 7px; color: var(--text); background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 3px; font-size: 10px; }
.settings-model-readonly { display: grid; gap: 6px; }
.settings-model-readonly > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 9px; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; font-size: 10px; }
.settings-model-readonly span { color: var(--text-dim); font-family: var(--font-mono); font-size: 9px; }
.settings-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.settings-ok { margin: 0; color: var(--mint); font-size: 10px; }
.settings-error { margin: 0; color: var(--danger); font-size: 10px; }
```

- [ ] **Step 12: 运行测试与构建**

Run:
```bash
pnpm test:unit
pnpm build
```
Expected: 模型草稿与能力映射测试通过；构建无错。

- [ ] **Step 13: 手工验证**

Run: `pnpm tauri dev`
Expected:
1. 首次启动设置里出现「OpenAI 兼容中转」与「MiniMax H3」；H3 模型能力只读展示三种模式与 5–15 秒限制。
2. 为 OpenAI 兼容添加一个文本模型与一个生图模型，勾选能力并保存；Key 输入框保存后清空，再次打开只显示「已保存」。
3. 「测试连接」对 OpenAI 兼容返回模型数量；H3 返回配置已保存提示。
4. Inspector 的文本/图片/视频节点出现模型下拉，「自动选择」为默认；选中具体模型后保存并刷新仍在。
5. 图片节点接入参考图后，能力变为「图片编辑」；若没有改图模型，Inspector 明确提示。
6. 素材外链切到 S3 后保存 endpoint/bucket/密钥，重启应用后密钥显示为已保存且回读成功。

- [ ] **Step 14: 提交**

```bash
git add src/settings src/stores/providerStore.ts src/inspector src/app/StudioApp.tsx src/styles/studio.css
git commit -m "feat(p0): Provider 设置、模型目录与素材外链"
```

---

## 阶段 E — 运行编排

### Task 21: 运行编排、过期标记与成本确认

**Files:**
- Modify: `src/domain/nodes/definitions.ts`（文本节点不再要求本地提示词）
- Create: `src/domain/run/runtime.ts`
- Create: `src/domain/run/runFixtures.ts`
- Test: `src/domain/run/runtime.test.ts`
- Create: `src/domain/run/prepare.ts`
- Test: `src/domain/run/prepare.test.ts`
- Modify: `src/inspector/model.ts`（`capabilityForNode` 委托给 domain）
- Modify: `src/stores/runStore.ts`（终态不可回退）
- Create: `src/run/controller.ts`
- Create: `src/run/events.ts`
- Create: `src/run/useStaleNodeIds.ts`
- Create: `src/run/RunConfirmDialog.tsx`
- Modify: `src/canvas/mapping.ts`
- Modify: `src/canvas/CanvasView.tsx`
- Modify: `src/nodes/NodeCard.tsx`
- Modify: `src/inspector/Inspector.tsx`
- Modify: `src/app/StudioApp.tsx`
- Modify: `src/styles/studio.css`
- Modify: `src-tauri/src/runs.rs`（`prepare_inputs` 改用数据库中的 kind/mime）

**Interfaces:**
- Consumes: `getNodeDefinition`、`validateBoard`、`computeCacheKey`、`computeStaleSet`、`latestSucceededRun`、`selectedAssetOf`、`compilePrompt`、`capabilityOf`、`estimateCost`、`startRun`、`cancelRun`、`readAssetText`、`onRunUpdated`、`onAssetCreated`、`useBoardStore`、`useRunStore`、`useProviderStore`、`useStudioStore`、`GraphCommand.setNodeUi`。
- Produces:
  - `runCapability(doc, node): string | undefined`
  - `resolveModel(profiles, hasKeys, node, capability): { ok: true; resolved: ResolvedModel } | { ok: false; issue: Issue }`
  - `nodeParams(node, capability): Record<string, unknown>`
  - `buildCacheContext({ doc, runs, profiles, hasKeys, styleGuide? }): CacheContext`
  - `mergeRunRecord(runs, incoming): Record<string, RunRecord> | undefined`
  - `inboundTextAssetIds(doc, nodeId, runs, assets): string[]`
  - `prepareRun(doc, nodeId, deps): PrepareOutcome`
  - `useRunController`：`busy`、`pending`、`requestRun()`、`confirmRun()`、`dismissRun()`、`cancelRun()`
  - `attachRunEvents(): Promise<() => void>`
  - `useStaleNodeIds(): Set<string>`

**设计约束（不可省略）：**

1. 只有用户显式点击才会花钱；缓存命中直接落库（费用 0），不弹确认框。
2. 真实调用前必须弹确认框，未配置价格时明确写「无法估算费用」。
3. 过期传播不会自动重跑，只标角标；`ui.pinned` 的节点不参与过期。
4. `prepareRun` 是纯函数（依赖注入），不 import 任何 `src/services/*` 运行时模块；这样能在 node 环境下完整测试花钱前的校验链路。
5. 前端的花费前校验与 Rust `gateway::minimax::validate` 保持同一套错误码，前端只是提前拦截，Rust 仍是最终守门人。

- [ ] **Step 1: 放开文本节点的本地提示词硬校验**

Task 3 的 `src/domain/nodes/definitions.ts` 里，文本节点把「提示词非空」写在了节点级校验上，导致「上游文本 → 下游生成」这条主链路必须先手填一遍提示词。花钱前的空提示词检查统一挪到 `prepareRun`（`PARAM_PROMPT_EMPTY`），节点级校验只看参数。

把：

```ts
    validate: (node) => (String(node.data.prompt ?? '').trim() ? [] : [missing('PARAM_PROMPT_REQUIRED', '请填写文本提示词')]),
```

改为：

```ts
    validate: () => [],
```

Run: `pnpm test:unit`
Expected: PASS（Task 3/Task 4 的用例都不依赖 `PARAM_PROMPT_REQUIRED`；`missing` 仍被图片/视频节点使用，不要删）。

- [ ] **Step 2: 写失败的运行时测试**

`src/domain/run/runFixtures.ts`（测试夹具，非 `*.test.ts`，不会被 vitest 收集）：

```ts
import { emptyStyleGuide } from '../types';
import type { AssetRef, ProviderProfile, RunRecord, StudioProject } from '../types';

export const TEST_PROFILES: ProviderProfile[] = [
  {
    id: 'openai-compatible',
    name: 'OpenAI 兼容中转',
    adapter: 'openai-compatible',
    baseUrl: 'https://relay.example/v1',
    auth: { type: 'bearer', keyRef: 'provider/openai-compatible' },
    enabled: true,
    schemaVersion: 1,
    models: [
      {
        id: 'gpt-4o-mini',
        displayName: 'GPT-4o mini',
        capabilities: [{ capability: 'text.chat', inputTransport: ['dataUrl'], async: false }],
      },
      {
        id: 'gpt-image-1',
        displayName: 'GPT Image 1',
        capabilities: [
          {
            capability: 'image.generate',
            inputTransport: ['dataUrl'],
            async: false,
            maxPromptChars: 4000,
            price: { unit: 'image', amount: 0.04, currency: 'CNY' },
          },
          {
            capability: 'image.edit',
            inputTransport: ['dataUrl'],
            async: false,
            maxReferenceImages: 4,
          },
        ],
      },
      {
        id: 'tts-1',
        displayName: 'TTS-1',
        capabilities: [
          { capability: 'audio.tts', inputTransport: ['dataUrl'], async: false, price: { unit: 'character', amount: 0.0002, currency: 'CNY' } },
        ],
      },
    ],
  },
  {
    id: 'minimax-h3',
    name: 'MiniMax H3',
    adapter: 'minimax-h3',
    baseUrl: 'https://api.minimax.example',
    auth: { type: 'bearer', keyRef: 'provider/minimax-h3' },
    enabled: true,
    schemaVersion: 1,
    models: [
      {
        id: 'MiniMax-H3',
        displayName: 'MiniMax H3',
        capabilities: [
          {
            capability: 'video.generate',
            modes: ['t2v', 'firstLast', 'reference'],
            maxReferenceImages: 9,
            maxReferenceVideos: 3,
            maxReferenceAudios: 3,
            supportsFirstFrame: true,
            supportsLastFrame: true,
            supportsNativeAudio: true,
            durations: { min: 5, max: 15, step: 1 },
            ratios: ['adaptive', '16:9', '9:16', '1:1'],
            resolutions: ['768P', '2K'],
            maxPromptChars: 20480,
            inputTransport: ['publicUrl'],
            async: true,
          },
        ],
        defaults: {
          protocol: 'official',
          submitPath: '/v1/video_generation',
          pollPath: '/v1/query/video_generation?task_id={task_id}',
          fileRetrievePath: '/v1/files/retrieve?file_id={file_id}',
        },
      },
    ],
  },
];

export const TEST_KEYS: Record<string, boolean> = {
  'openai-compatible': true,
  'minimax-h3': true,
};

export const S3_HOST = { strategy: 's3', publicBaseUrl: 'https://cdn.example' };

export const testProject: StudioProject = {
  schemaVersion: 1,
  id: 'project_test',
  name: '测试项目',
  aspectRatio: '9:16',
  styleGuide: { ...emptyStyleGuide(), visualStyle: '冷色写实', version: 3 },
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

export function assetRef(id: string, kind: AssetRef['kind'], mime = 'text/plain'): AssetRef {
  return {
    id, kind, path: `assets/${id}`, mime, bytes: 12,
    createdAt: '2026-10-31T00:00:00.000Z',
    provenance: { projectId: 'project_test' },
  };
}

export function succeededRun(nodeId: string, assetId: string, cacheKey = 'cache-key'): RunRecord {
  return {
    id: `run_${nodeId}_${assetId}`,
    projectId: 'project_test',
    boardId: 'board_test',
    nodeId,
    action: 'generate',
    cacheKey,
    status: 'succeeded',
    providerId: 'openai-compatible',
    model: 'gpt-image-1',
    promptSnapshot: { text: 'x', segments: [], hash: 'h', locked: false },
    params: {},
    inputAssetIds: [],
    outputAssetIds: [assetId],
    selectedAssetId: assetId,
    startedAt: '2026-10-31T00:00:00.000Z',
    finishedAt: '2026-10-31T00:00:05.000Z',
  };
}

export function runningRun(nodeId: string, status: RunRecord['status'] = 'running'): RunRecord {
  return { ...succeededRun(nodeId, 'asset_x'), id: `run_${nodeId}`, status };
}
```

`src/domain/run/runtime.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node, videoNode } from '../graph/testFixtures';
import { emptyStyleGuide } from '../types';
import type { RunRecord } from '../types';
import { TEST_KEYS, TEST_PROFILES, runningRun } from './runFixtures';
import { buildCacheContext, mergeRunRecord, nodeParams, resolveModel, runCapability } from './runtime';

describe('runCapability', () => {
  it('switches an image node to the edit capability when a reference is connected', () => {
    const doc = makeDoc([node('img', 'image'), node('ref', 'image')], [edge('e1', 'ref', 'img', 'image', 'references', 'reference_image')]);
    expect(runCapability(doc, doc.nodes.img)).toBe('image.edit');
  });

  it('returns undefined for utility nodes', () => {
    const doc = makeDoc([node('note', 'note')], []);
    expect(runCapability(doc, doc.nodes.note)).toBeUndefined();
  });
});

describe('resolveModel', () => {
  it('auto-picks the first enabled provider that supports the capability', () => {
    const doc = makeDoc([node('t', 'text', { prompt: '写一段开场' })], []);
    const result = resolveModel(TEST_PROFILES, TEST_KEYS, doc.nodes.t, 'text.chat');
    expect(result.ok && result.resolved.providerId).toBe('openai-compatible');
    expect(result.ok && result.resolved.modelId).toBe('gpt-4o-mini');
  });

  it('prefers an actionable key error over CAP_NO_MODEL', () => {
    const doc = makeDoc([videoNode('v')], []);
    const result = resolveModel(TEST_PROFILES, { 'openai-compatible': true }, doc.nodes.v, 'video.generate');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('PROVIDER_KEY_MISSING');
  });

  it('rejects an explicit model that lacks the capability', () => {
    const doc = makeDoc([node('i', 'image', { providerId: 'openai-compatible', model: 'gpt-4o-mini' })], []);
    const result = resolveModel(TEST_PROFILES, TEST_KEYS, doc.nodes.i, 'image.generate');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('PARAM_MODEL_INVALID');
  });

  it('reports CAP_NO_MODEL when no model supports the capability', () => {
    const doc = makeDoc([node('a', 'audio', { text: '台词' })], []);
    const result = resolveModel(TEST_PROFILES, { ...TEST_KEYS, 'minimax-h3': false }, doc.nodes.a, 'video.generate');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue.code).toBe('CAP_NO_MODEL');
  });
});

describe('nodeParams', () => {
  it('maps the video ratio field onto the provider parameter name', () => {
    const doc = makeDoc([videoNode('v', { mode: 'firstLast', duration: 8, resolution: '2K', aspectRatio: '16:9', generateAudio: false })], []);
    expect(nodeParams(doc.nodes.v, 'video.generate')).toEqual({
      mode: 'firstLast', duration: 8, resolution: '2K', ratio: '16:9', generateAudio: false,
    });
  });

  it('clamps the candidate count into the adapter range', () => {
    const doc = makeDoc([node('i', 'image', { count: 9 })], []);
    expect(nodeParams(doc.nodes.i, 'image.generate').count).toBe(4);
  });

  it('carries the tts text so per-character pricing works', () => {
    const doc = makeDoc([node('a', 'audio', { text: '你好', voice: 'Chelsie', format: 'wav' })], []);
    expect(nodeParams(doc.nodes.a, 'audio.tts')).toEqual({ voice: 'Chelsie', format: 'wav', text: '你好' });
  });
});

describe('buildCacheContext', () => {
  it('keys runtime per node and leaves promptHashes empty', () => {
    const doc = makeDoc([node('t', 'text', { prompt: 'hi' }), node('note', 'note')], []);
    const ctx = buildCacheContext({ doc, runs: [], profiles: TEST_PROFILES, hasKeys: TEST_KEYS, styleGuide: emptyStyleGuide() });
    expect(ctx.runtime.t).toEqual({ providerId: 'openai-compatible', model: 'gpt-4o-mini', params: { system: '' } });
    expect(ctx.runtime.note).toBeUndefined();
    expect(ctx.promptHashes).toEqual({});
  });

  it('still records params when the model cannot be resolved', () => {
    const doc = makeDoc([videoNode('v', { duration: 9 })], []);
    const ctx = buildCacheContext({ doc, runs: [], profiles: TEST_PROFILES, hasKeys: {}, styleGuide: undefined });
    expect(ctx.runtime.v).toEqual({ providerId: undefined, model: undefined, params: nodeParams(doc.nodes.v, 'video.generate') });
  });
});

describe('mergeRunRecord', () => {
  it('drops a non-terminal update for an already terminal run', () => {
    const runs = { run_v: runningRun('v', 'succeeded') };
    expect(mergeRunRecord(runs, runningRun('v', 'running'))).toBeUndefined();
  });

  it('applies a terminal update over a running record', () => {
    const merged = mergeRunRecord({ run_v: runningRun('v') }, runningRun('v', 'failed'));
    expect(merged?.run_v.status satisfies RunRecord['status']).toBe('failed');
  });
});
```

注意：`merged?.run_v.status satisfies ...` 只是类型断言写法，若 TS 版本不支持 `satisfies`，改成：

```ts
    const merged = mergeRunRecord({ run_v: runningRun('v') }, runningRun('v', 'failed'));
    expect(merged ? merged.run_v.status : '').toBe('failed');
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./runtime`。

- [ ] **Step 4: 实现运行时解析与合并**

`src/domain/run/runtime.ts`：

```ts
import type { CacheContext, NodeRuntimeConfig } from '../graph/cacheKey';
import { capabilityOf } from '../providers/capabilities';
import type {
  BoardDoc, BoardNode, Issue, ModelConfig, ProviderProfile, RunRecord, RunStatus, StyleGuide,
} from '../types';

const error = (code: string, message: string): Issue => ({ code, message, severity: 'error' });

const TERMINAL_RUN_STATUSES: RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface ResolvedModel {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  profile: ProviderProfile;
  config: ModelConfig;
}

export type ModelResolution = { ok: true; resolved: ResolvedModel } | { ok: false; issue: Issue };

export function runCapability(doc: BoardDoc, node: BoardNode): string | undefined {
  if (node.type === 'text') return 'text.chat';
  if (node.type === 'audio') return 'audio.tts';
  if (node.type === 'video') return 'video.generate';
  if (node.type === 'image') {
    const edited = Object.values(doc.edges).some((edge) =>
      edge.target === node.id && (edge.targetPort === 'references' || edge.targetPort === 'style'));
    return edited ? 'image.edit' : 'image.generate';
  }
  return undefined;
}

export function resolveModel(
  profiles: ProviderProfile[],
  hasKeys: Record<string, boolean>,
  node: BoardNode,
  capability: string,
): ModelResolution {
  const pick = (profile: ProviderProfile): ModelConfig | undefined =>
    profile.models.find((model) => capabilityOf(model, capability));

  const wrap = (profile: ProviderProfile, config: ModelConfig): ResolvedModel => ({
    providerId: profile.id,
    providerName: profile.name,
    modelId: config.id,
    modelName: config.displayName,
    profile,
    config,
  });

  const providerId = String(node.data.providerId ?? '');
  const modelId = String(node.data.model ?? '');
  if (providerId && modelId) {
    const profile = profiles.find((item) => item.id === providerId);
    const config = profile?.models.find((item) => item.id === modelId);
    if (!profile || !config || !capabilityOf(config, capability) || !profile.enabled) {
      return { ok: false, issue: error('PARAM_MODEL_INVALID', '所选模型不支持该能力，请在 Inspector 中重新选择') };
    }
    if (!hasKeys[profile.id]) {
      return { ok: false, issue: error('PROVIDER_KEY_MISSING', `${profile.name} 尚未保存 API Key`) };
    }
    return { ok: true, resolved: wrap(profile, config) };
  }

  const candidates: Array<{ profile: ProviderProfile; config: ModelConfig }> = [];
  for (const profile of profiles) {
    if (!profile.enabled) continue;
    const config = pick(profile);
    if (config) candidates.push({ profile, config });
  }
  const usable = candidates.find((item) => hasKeys[item.profile.id]);
  if (usable) return { ok: true, resolved: wrap(usable.profile, usable.config) };
  if (candidates.length) {
    return { ok: false, issue: error('PROVIDER_KEY_MISSING', `${candidates[0].profile.name} 尚未保存 API Key`) };
  }
  return { ok: false, issue: error('CAP_NO_MODEL', '没有支持该能力的模型，请先在设置中添加') };
}

export function nodeParams(node: BoardNode, capability: string): Record<string, unknown> {
  switch (capability) {
    case 'text.chat':
      return { system: String(node.data.system ?? '') };
    case 'image.generate':
    case 'image.edit':
      return {
        count: Math.min(4, Math.max(1, Math.round(Number(node.data.count ?? 1)) || 1)),
        size: String(node.data.size ?? '1024x1536'),
      };
    case 'audio.tts':
      return {
        voice: String(node.data.voice ?? 'alloy'),
        format: String(node.data.format ?? 'mp3'),
        text: String(node.data.text ?? ''),
      };
    case 'video.generate':
      return {
        mode: String(node.data.mode ?? 't2v'),
        duration: Number(node.data.duration ?? 5),
        resolution: String(node.data.resolution ?? '768P'),
        ratio: String(node.data.aspectRatio ?? '9:16'),
        generateAudio: Boolean(node.data.generateAudio ?? true),
      };
    default:
      return {};
  }
}

export interface BuildCacheContextInput {
  doc: BoardDoc;
  runs: RunRecord[];
  profiles: ProviderProfile[];
  hasKeys: Record<string, boolean>;
  styleGuide?: StyleGuide;
}

export function buildCacheContext(input: BuildCacheContextInput): CacheContext {
  const runtime: Record<string, NodeRuntimeConfig> = {};
  for (const node of Object.values(input.doc.nodes)) {
    const capability = runCapability(input.doc, node);
    if (!capability) continue;
    const resolution = resolveModel(input.profiles, input.hasKeys, node, capability);
    runtime[node.id] = {
      providerId: resolution.ok ? resolution.resolved.providerId : undefined,
      model: resolution.ok ? resolution.resolved.modelId : undefined,
      params: nodeParams(node, capability),
    };
  }
  // promptHashes 留空：computeCacheKey 会退回到节点自身的 prompt/text，
  // 上游文本内容已经通过 inputHashes（上游选中资产）进入键中。
  return { styleGuide: input.styleGuide, runs: input.runs, runtime, promptHashes: {} };
}

export function mergeRunRecord(
  runs: Record<string, RunRecord>,
  incoming: RunRecord,
): Record<string, RunRecord> | undefined {
  const previous = runs[incoming.id];
  if (previous && TERMINAL_RUN_STATUSES.includes(previous.status) && !TERMINAL_RUN_STATUSES.includes(incoming.status)) {
    return undefined;
  }
  return { ...runs, [incoming.id]: incoming };
}
```

- [ ] **Step 5: 让 Inspector 复用 domain 的能力判定**

把 `src/inspector/model.ts` 里的 `capabilityForNode` 函数体整体替换为委托调用（避免两份真值）：

```ts
export { runCapability as capabilityForNode } from '../domain/run/runtime';
```

如果该文件已用 `capabilityForNode(` 在别处（Inspector 里只是 import 使用），无需其他改动；`src/inspector/modelCapability.test.ts` 必须仍然通过。

Run: `pnpm test:unit`
Expected: PASS。

- [ ] **Step 6: 写失败的 prepare 测试**

`src/domain/run/prepare.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { edge, makeDoc, node, videoNode } from '../graph/testFixtures';
import {
  S3_HOST, TEST_KEYS, TEST_PROFILES, assetRef, succeededRun, testProject,
} from './runFixtures';
import { inboundTextAssetIds, prepareRun, type PrepareDeps } from './prepare';

function deps(patch: Partial<PrepareDeps> = {}): PrepareDeps {
  return {
    project: testProject,
    profiles: TEST_PROFILES,
    hasKeys: TEST_KEYS,
    runs: [],
    assets: {},
    texts: {},
    ...patch,
  };
}

describe('prepareRun', () => {
  it('blocks an empty prompt before spending anything', () => {
    const doc = makeDoc([node('t', 'text')], []);
    const outcome = prepareRun(doc, 't', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_PROMPT_EMPTY');
  });

  it('injects upstream text and appends it when the prompt does not reference it', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('i', 'image', { prompt: '雨夜街头' })],
      [edge('e1', 't', 'i', 'text', 'prompt', 'prompt')],
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: [succeededRun('t', 'asset_text')],
      texts: { asset_text: '第一幕：告别的雨夜' },
    }));
    if (!outcome.ok) throw new Error(outcome.issues.map((issue) => issue.message).join('；'));
    expect(outcome.request.promptSnapshot.text).toBe('雨夜街头\n\n第一幕：告别的雨夜');
    expect(outcome.request.capability).toBe('image.generate');
    expect(outcome.request.providerId).toBe('openai-compatible');
    expect(outcome.request.model).toBe('gpt-image-1');
    expect(outcome.request.inputs).toEqual([]);
  });

  it('keeps an explicit variable reference instead of appending twice', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('i', 'image', { prompt: '氛围：{{prompt}}' })],
      [edge('e1', 't', 'i', 'text', 'prompt', 'prompt')],
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: [succeededRun('t', 'asset_text')],
      texts: { asset_text: '压抑' },
    }));
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.request.promptSnapshot.text).toBe('氛围：压抑');
  });

  it('routes media inputs with the edge role and flips the capability to edit', () => {
    const doc = makeDoc(
      [node('a', 'image'), node('i', 'image', { prompt: '换成红衣' })],
      [edge('e1', 'a', 'i', 'image', 'references', 'reference_image')],
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: [succeededRun('a', 'asset_img')],
      assets: { asset_img: assetRef('asset_img', 'image', 'image/png') },
    }));
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.request.capability).toBe('image.edit');
    expect(outcome.request.inputs).toEqual([
      { role: 'reference_image', assetId: 'asset_img', kind: 'image', mime: 'image/png' },
    ]);
    expect(outcome.request.inputAssetIds).toEqual(['asset_img']);
  });

  it('feeds a connected system port into params instead of the prompt', () => {
    const doc = makeDoc(
      [node('s', 'text'), node('t', 'text', { prompt: '写分镜' })],
      [edge('e1', 's', 't', 'text', 'system', 'prompt')],
    );
    const outcome = prepareRun(doc, 't', deps({
      runs: [succeededRun('s', 'asset_sys')],
      texts: { asset_sys: '你是短剧编剧' },
    }));
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.request.params.system).toBe('你是短剧编剧');
    expect(outcome.request.promptSnapshot.text).toBe('写分镜');
  });

  it('refuses a public-url-only model when the asset host is not configured', () => {
    const doc = makeDoc(
      [node('f', 'image'), videoNode('v', { mode: 'firstLast', prompt: '镜头推进' })],
      [edge('e1', 'f', 'v', 'image', 'start', 'first_frame')],
    );
    const base = deps({
      runs: [succeededRun('f', 'asset_frame')],
      assets: { asset_frame: assetRef('asset_frame', 'image', 'image/png') },
    });
    const blocked = prepareRun(doc, 'v', base);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.issues.map((issue) => issue.code)).toContain('CAP_PUBLIC_URL_REQUIRED');

    const allowed = prepareRun(doc, 'v', { ...base, assetHost: S3_HOST });
    if (!allowed.ok) throw new Error('expected ok with s3 host');
    expect(allowed.request.inputs[0]).toEqual({ role: 'first_frame', assetId: 'asset_frame', kind: 'image', mime: 'image/png' });
  });

  it('rejects an unsupported resolution before submitting', () => {
    const doc = makeDoc([videoNode('v', { resolution: '4K' })], []);
    const outcome = prepareRun(doc, 'v', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_RESOLUTION_UNSUPPORTED');
  });

  it('rejects reference images beyond the model limit', () => {
    const refs = Array.from({ length: 5 }, (_, index) => node(`r${index}`, 'image'));
    const doc = makeDoc(
      [...refs, node('i', 'image', { prompt: '融合参考' })],
      refs.map((ref, index) => edge(`e${index}`, ref.id, 'i', 'image', 'references', 'reference_image')),
    );
    const outcome = prepareRun(doc, 'i', deps({
      runs: refs.map((ref, index) => succeededRun(ref.id, `asset_${index}`)),
      assets: Object.fromEntries(refs.map((_, index) => [`asset_${index}`, assetRef(`asset_${index}`, 'image', 'image/png')])),
    }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_REFERENCE_LIMIT');
  });

  it('estimates cost from the priced capability', () => {
    const doc = makeDoc([node('i', 'image', { prompt: '海报', count: 3 })], []);
    const outcome = prepareRun(doc, 'i', deps());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.cost).toEqual({ amount: 0.12, currency: 'CNY', unit: '张', breakdown: { count: 3 } });
    expect(outcome.cached).toBe(false);
  });

  it('flags a missing price instead of silently estimating zero', () => {
    const doc = makeDoc([videoNode('v')], []);
    const outcome = prepareRun(doc, 'v', deps());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.cost).toBeUndefined();
  });

  it('reports unresolved prompt variables', () => {
    const doc = makeDoc([node('i', 'image', { prompt: '{{character.name}} 出场' })], []);
    const outcome = prepareRun(doc, 'i', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PROMPT_MISSING_VARIABLE');
  });

  it('reuses the previous run when the cache key matches', () => {
    const doc = makeDoc([node('i', 'image', { prompt: '海报' })], []);
    const first = prepareRun(doc, 'i', deps());
    if (!first.ok) throw new Error('expected ok');
    const stored = succeededRun('i', 'asset_out', first.request.cacheKey);
    const second = prepareRun(doc, 'i', deps({
      runs: [stored],
      assets: { asset_out: assetRef('asset_out', 'image', 'image/png') },
    }));
    if (!second.ok) throw new Error('expected cache hit');
    expect(second.cached).toBe(true);
    expect(second.request.cachedAssetId).toBe('asset_out');
    expect(second.request.cacheKey).toBe(first.request.cacheKey);
  });

  it('warns when an upstream node has no usable output yet', () => {
    const doc = makeDoc(
      [node('t', 'text', { prompt: '上游' }), node('i', 'image', { prompt: '海报' })],
      [edge('e1', 't', 'i', 'text', 'prompt', 'prompt')],
    );
    const outcome = prepareRun(doc, 'i', deps());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.warnings.map((issue) => issue.code)).toContain('RUN_UPSTREAM_MISSING');
  });

  it('returns the graph error when the node itself is invalid', () => {
    const doc = makeDoc([videoNode('v', { duration: 4 })], []);
    const outcome = prepareRun(doc, 'v', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('PARAM_DURATION_RANGE');
  });

  it('refuses nodes that cannot run', () => {
    const doc = makeDoc([node('n', 'note', { text: '备忘' })], []);
    const outcome = prepareRun(doc, 'n', deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues.map((issue) => issue.code)).toContain('RUN_NOT_RUNNABLE');
  });
});

describe('inboundTextAssetIds', () => {
  it('lists only upstream text assets the controller must read', () => {
    const doc = makeDoc(
      [node('t', 'text'), node('a', 'image'), node('i', 'image', { prompt: 'p' })],
      [
        edge('e1', 't', 'i', 'text', 'prompt', 'prompt'),
        edge('e2', 'a', 'i', 'image', 'references', 'reference_image'),
      ],
    );
    const runs = [succeededRun('t', 'asset_text'), succeededRun('a', 'asset_img')];
    const assets = { asset_img: assetRef('asset_img', 'image', 'image/png') };
    expect(inboundTextAssetIds(doc, 'i', runs, assets)).toEqual(['asset_text']);
  });
});
```

- [ ] **Step 7: 运行测试确认失败**

Run: `pnpm test:unit src/domain/run/prepare.test.ts`
Expected: FAIL，找不到 `./prepare`。

- [ ] **Step 8: 实现 prepareRun**

`src/domain/run/prepare.ts`：

```ts
import { computeCacheKey, latestSucceededRun, selectedAssetOf } from '../graph/cacheKey';
import { getNodeDefinition } from '../nodes/definitions';
import type { NodeContext } from '../nodes/types';
import { capabilityOf, estimateCost } from '../providers/capabilities';
import { compilePrompt } from '../prompts/compile';
import { validateBoard } from '../graph/validate';
import { buildCacheContext, nodeParams, resolveModel, runCapability } from './runtime';
import type {
  AssetRef, BoardDoc, BoardEdge, CostEstimate, DataType, Issue, ModelCapability, PromptSnapshot,
  ProviderProfile, RunRecord, StudioProject,
} from '../types';

const error = (code: string, message: string): Issue => ({ code, message, severity: 'error' });

const MODE_LABEL: Record<string, string> = {
  t2v: '文生视频', firstLast: '首尾帧', reference: '全能参考',
};

export interface RunRequestDraft {
  schemaVersion: 1;
  projectId: string;
  boardId: string;
  nodeId: string;
  capability: string;
  providerId: string;
  model: string;
  promptSnapshot: PromptSnapshot;
  params: Record<string, unknown>;
  inputs: Array<{ role: string; assetId: string; kind: string; mime: string }>;
  inputAssetIds: string[];
  cacheKey: string;
  cachedAssetId?: string;
}

export interface RunLabel {
  nodeTitle: string;
  capability: string;
  providerName: string;
  modelName: string;
}

export interface PrepareDeps {
  project?: StudioProject;
  profiles: ProviderProfile[];
  hasKeys: Record<string, boolean>;
  runs: RunRecord[];
  assets: Record<string, AssetRef>;
  texts: Record<string, string>;
  assetHost?: { strategy?: string; publicBaseUrl?: string };
}

export type PrepareOutcome =
  | { ok: true; request: RunRequestDraft; cost?: CostEstimate; cached: boolean; label: RunLabel; warnings: Issue[] }
  | { ok: false; issues: Issue[] };

interface Inbound {
  edge: BoardEdge;
  assetId: string;
  kind: AssetRef['kind'];
  mime: string;
}

function kindForPort(dataType?: DataType): AssetRef['kind'] {
  if (dataType === 'image' || dataType === 'frame') return 'image';
  if (dataType === 'video') return 'video';
  if (dataType === 'audio') return 'audio';
  return 'text';
}

function inboundAssets(doc: BoardDoc, nodeId: string, runs: RunRecord[], assets: Record<string, AssetRef>): Inbound[] {
  const def = getNodeDefinition(doc.nodes[nodeId]?.type ?? '');
  const items: Inbound[] = [];
  for (const edge of Object.values(doc.edges)) {
    if (edge.target !== nodeId) continue;
    const assetId = selectedAssetOf(latestSucceededRun(runs, edge.source));
    if (!assetId) continue;
    const stored = assets[assetId];
    const port = def?.inputs.find((item) => item.key === edge.targetPort);
    items.push({ edge, assetId, kind: stored?.kind ?? kindForPort(port?.dataType), mime: stored?.mime ?? '' });
  }
  return items;
}

export function inboundTextAssetIds(
  doc: BoardDoc,
  nodeId: string,
  runs: RunRecord[],
  assets: Record<string, AssetRef>,
): string[] {
  const ids = inboundAssets(doc, nodeId, runs, assets)
    .filter((item) => item.kind === 'text' || item.kind === 'json')
    .map((item) => item.assetId);
  return [...new Set(ids)];
}

function referenceOverflow(inputs: RunRequestDraft['inputs'], limit?: ModelCapability): string | undefined {
  const rules: Array<[string, number, string]> = [
    ['reference_image', limit?.maxReferenceImages ?? Number.POSITIVE_INFINITY, '参考图'],
    ['reference_video', limit?.maxReferenceVideos ?? Number.POSITIVE_INFINITY, '参考视频'],
    ['reference_audio', limit?.maxReferenceAudios ?? Number.POSITIVE_INFINITY, '参考音频'],
    ['first_frame', limit && limit.supportsFirstFrame === false ? 0 : Number.POSITIVE_INFINITY, '首帧'],
    ['last_frame', limit && limit.supportsLastFrame === false ? 0 : Number.POSITIVE_INFINITY, '尾帧'],
  ];
  for (const [role, max, label] of rules) {
    const count = inputs.filter((item) => item.role === role).length;
    if (count === 0 || count <= max) continue;
    return max === 0 ? `${label}不受支持` : `${label}超出模型上限（最多 ${max}）`;
  }
  return undefined;
}

export function prepareRun(doc: BoardDoc, nodeId: string, deps: PrepareDeps): PrepareOutcome {
  const node = doc.nodes[nodeId];
  if (!node) return { ok: false, issues: [error('GRAPH_UNKNOWN_NODE', '节点不存在，无法运行')] };

  const def = getNodeDefinition(node.type);
  if (!def || !def.actions.length) {
    return { ok: false, issues: [error('RUN_NOT_RUNNABLE', `${def?.title ?? node.type} 节点没有可执行动作`)] };
  }
  const capability = runCapability(doc, node);
  if (!capability) return { ok: false, issues: [error('RUN_NOT_RUNNABLE', '该节点没有可执行能力')] };

  const ctx: NodeContext = { providers: deps.profiles, styleGuide: deps.project?.styleGuide };
  const blocking = validateBoard(doc, ctx).filter(
    (issue) => issue.nodeId === nodeId && issue.severity === 'error',
  );
  if (blocking.length) return { ok: false, issues: blocking };

  const model = resolveModel(deps.profiles, deps.hasKeys, node, capability);
  if (!model.ok) return { ok: false, issues: [model.issue] };
  const { resolved } = model;
  const limit = capabilityOf(resolved.config, capability);

  const issues: Issue[] = [];
  const items = inboundAssets(doc, nodeId, deps.runs, deps.assets);
  const variables: Record<string, string> = {};
  const mediaInputs: RunRequestDraft['inputs'] = [];

  for (const item of items) {
    if (item.kind === 'text' || item.kind === 'json') {
      const value = (deps.texts[item.assetId] ?? '').trim();
      if (!value) continue;
      const key = item.edge.targetPort;
      variables[key] = variables[key] ? `${variables[key]}\n\n${value}` : value;
      if (key === 'prompt') variables.text = variables.prompt;
      continue;
    }
    mediaInputs.push({ role: item.edge.role, assetId: item.assetId, kind: item.kind, mime: item.mime });
  }

  for (const edge of Object.values(doc.edges)) {
    if (edge.target !== nodeId) continue;
    if (!selectedAssetOf(latestSucceededRun(deps.runs, edge.source))) {
      const sourceTitle = getNodeDefinition(doc.nodes[edge.source]?.type ?? '')?.title ?? edge.source;
      issues.push({
        code: 'RUN_UPSTREAM_MISSING',
        message: `上游「${sourceTitle}」还没有可用结果，本次会忽略这条连线`,
        severity: 'warning',
      });
    }
  }

  const template0 = String(node.data.prompt ?? node.data.text ?? '');
  const appendable = Object.keys(variables).filter(
    (key) => key !== 'system' && !(key === 'text' && variables.prompt),
  );
  const unreferenced = appendable.filter((key) => !template0.includes(`{{${key}}}`));
  let template = template0;
  if (unreferenced.length) {
    const suffix = unreferenced.map((key) => `{{${key}}}`).join('\n');
    template = template0.trim() ? `${template0}\n\n${suffix}` : suffix;
  }

  const snapshot = compilePrompt(template, {
    variables,
    styleGuide: deps.project?.styleGuide,
    negative: String(node.data.negative ?? ''),
    lockedText: node.data.promptLocked ? String(node.data.promptOverride ?? '') : undefined,
  });

  if (snapshot.missingVariables?.length) {
    issues.push(error('PROMPT_MISSING_VARIABLE', `提示词变量没有来源：${snapshot.missingVariables.join('、')}`));
  }
  const finalText = snapshot.text.trim();
  if (!finalText) issues.push(error('PARAM_PROMPT_EMPTY', '提示词为空，请填写或连接上游文本节点'));
  const chars = [...finalText].length;
  if (limit?.maxPromptChars && chars > limit.maxPromptChars) {
    issues.push(error('PARAM_PROMPT_TOO_LONG', `提示词 ${chars} 字符，超过模型上限 ${limit.maxPromptChars}`));
  }

  const params = nodeParams(node, capability);
  if (variables.system) params.system = variables.system;
  if (capability === 'audio.tts') params.text = finalText;

  if (capability === 'video.generate') {
    const mode = String(params.mode ?? 't2v');
    if (limit?.modes && !limit.modes.includes(mode)) {
      issues.push(error('PARAM_MODE_UNSUPPORTED', `${resolved.modelName} 不支持${MODE_LABEL[mode] ?? mode}模式`));
    }
    const duration = Number(params.duration ?? 0);
    const range = limit?.durations;
    if (range && (!Number.isInteger(duration) || duration < range.min || duration > range.max)) {
      issues.push(error('PARAM_DURATION_RANGE', `时长需在 ${range.min}–${range.max} 秒之间`));
    }
    const resolution = String(params.resolution ?? '');
    if (limit?.resolutions && !limit.resolutions.includes(resolution)) {
      issues.push(error('PARAM_RESOLUTION_UNSUPPORTED', `${resolved.modelName} 不支持 ${resolution || '空'} 分辨率`));
    }
    const ratio = String(params.ratio ?? '');
    if (limit?.ratios && !limit.ratios.includes(ratio)) {
      issues.push(error('PARAM_RATIO_UNSUPPORTED', `${resolved.modelName} 不支持 ${ratio || '空'} 比例`));
    }
  }

  const overflow = referenceOverflow(mediaInputs, limit);
  if (overflow) issues.push(error('PARAM_REFERENCE_LIMIT', overflow));

  const needsPublicUrl = mediaInputs.length > 0 && limit
    && limit.inputTransport.includes('publicUrl')
    && !limit.inputTransport.includes('dataUrl');
  if (needsPublicUrl && !(deps.assetHost?.strategy === 's3' && deps.assetHost.publicBaseUrl)) {
    issues.push(error('CAP_PUBLIC_URL_REQUIRED', '该模型只接受公网素材链接，请在「设置 → 素材外链」配置 S3 兼容桶'));
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length) return { ok: false, issues: errors };

  const cacheCtx = buildCacheContext({
    doc,
    runs: deps.runs,
    profiles: deps.profiles,
    hasKeys: deps.hasKeys,
    styleGuide: deps.project?.styleGuide,
  });
  const cacheKey = computeCacheKey(doc, nodeId, cacheCtx);
  const reusable = deps.runs
    .filter((run) => run.nodeId === nodeId && run.status === 'succeeded' && run.cacheKey === cacheKey && selectedAssetOf(run))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const cachedAssetId = selectedAssetOf(reusable);

  const request: RunRequestDraft = {
    schemaVersion: 1,
    projectId: doc.projectId,
    boardId: doc.id,
    nodeId,
    capability,
    providerId: resolved.providerId,
    model: resolved.modelId,
    promptSnapshot: snapshot,
    params,
    inputs: mediaInputs,
    inputAssetIds: items.map((item) => item.assetId),
    cacheKey,
    cachedAssetId,
  };

  return {
    ok: true,
    request,
    cost: estimateCost(resolved.config, capability, params),
    cached: Boolean(cachedAssetId),
    label: {
      nodeTitle: def.title,
      capability,
      providerName: resolved.providerName,
      modelName: resolved.modelName,
    },
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}
```

- [ ] **Step 9: 运行测试确认通过**

Run: `pnpm test:unit`
Expected: PASS。若 `refuses a public-url-only model…` 失败，先确认 `videoNode('v', { mode: 'firstLast' })` 生成的 `validateVideoMode` 不报错（首帧已连）；若 `image.edit` 用例失败，检查 `deps.assets` 里是否注册了 `asset_img`（未注册时 kind 会退回端口类型 `image`，仍然成立）。

- [ ] **Step 10: runStore 不允许终态回退**

`src/stores/runStore.ts` 的 `upsertRun` 整体替换（事件可能乱序，晚到的 `running` 不能覆盖已完成的 `succeeded`）：

```ts
  upsertRun(run) {
    set((state) => {
      const runs = mergeRunRecord(state.runs, run);
      if (!runs) return state;
      return { runs, latestByNode: indexLatest(Object.values(runs)) };
    });
  },
```

并在文件顶部 import 区追加：

```ts
import { mergeRunRecord } from '../domain/run/runtime';
```

Run: `pnpm build`
Expected: 类型检查与构建通过（`upsertRun` 的返回类型仍是 `void`，`mergeRunRecord` 的 `undefined` 分支被 `if` 消化）。

- [ ] **Step 11: 运行控制器与事件桥**

`src/run/controller.ts`：

```ts
import { create } from 'zustand';
import {
  inboundTextAssetIds, prepareRun, type PrepareDeps, type RunLabel, type RunRequestDraft,
} from '../domain/run/prepare';
import type { BoardDoc, CostEstimate, Issue } from '../domain/types';
import { cancelRun as cancelRemoteRun, readAssetText, startRun } from '../services/tauri';
import { useBoardStore } from '../stores/boardStore';
import { useProviderStore } from '../stores/providerStore';
import { useRunStore } from '../stores/runStore';
import { useStudioStore } from '../stores/studioStore';

export interface PendingRun {
  nodeId: string;
  request: RunRequestDraft;
  label: RunLabel;
  cost?: CostEstimate;
  warnings: Issue[];
  inputCount: number;
}

interface RunControllerState {
  busy: Record<string, boolean>;
  pending?: PendingRun;
  requestRun(nodeId: string): Promise<void>;
  confirmRun(): Promise<void>;
  dismissRun(): void;
  cancelRun(nodeId: string): Promise<void>;
}

const textCache = new Map<string, string>();

async function readTexts(assetIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(assetIds.map(async (assetId) => {
    const hit = textCache.get(assetId);
    if (hit !== undefined) {
      out[assetId] = hit;
      return;
    }
    try {
      const value = await readAssetText(assetId);
      textCache.set(assetId, value);
      out[assetId] = value;
    } catch {
      out[assetId] = '';
    }
  }));
  return out;
}

function snapshotDeps(doc: BoardDoc): PrepareDeps {
  const studio = useStudioStore.getState();
  const providers = useProviderStore.getState();
  const runs = useRunStore.getState();
  return {
    project: studio.projects.find((item) => item.id === studio.currentProjectId),
    profiles: providers.profiles,
    hasKeys: providers.hasKeys,
    runs: Object.values(runs.runs),
    assets: runs.assets,
    texts: {},
    assetHost: providers.assetHost
      ? { strategy: providers.assetHost.strategy, publicBaseUrl: providers.assetHost.publicBaseUrl }
      : undefined,
  };
}

function notify(message: string) {
  useBoardStore.getState().notify(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useRunController = create<RunControllerState>((set, get) => ({
  busy: {},

  async requestRun(nodeId) {
    const doc = useBoardStore.getState().board;
    if (!doc) return;
    set((state) => ({ busy: { ...state.busy, [nodeId]: true } }));
    try {
      const deps = snapshotDeps(doc);
      const texts = await readTexts(inboundTextAssetIds(doc, nodeId, deps.runs, deps.assets));
      const outcome = prepareRun(doc, nodeId, { ...deps, texts });
      if (!outcome.ok) {
        notify(outcome.issues.map((issue) => issue.message).join('；'));
        return;
      }
      if (outcome.cached) {
        const run = await startRun(outcome.request);
        useRunStore.getState().upsertRun(run);
        await useRunStore.getState().load(doc.id);
        notify('缓存命中，未产生费用');
        return;
      }
      set({
        pending: {
          nodeId,
          request: outcome.request,
          label: outcome.label,
          cost: outcome.cost,
          warnings: outcome.warnings,
          inputCount: outcome.request.inputs.length,
        },
      });
    } catch (error) {
      notify(messageOf(error));
    } finally {
      set((state) => ({ busy: { ...state.busy, [nodeId]: false } }));
    }
  },

  async confirmRun() {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: undefined, busy: { ...get().busy, [pending.nodeId]: true } });
    try {
      const run = await startRun(pending.request);
      useRunStore.getState().upsertRun(run);
    } catch (error) {
      notify(messageOf(error));
    } finally {
      set((state) => ({ busy: { ...state.busy, [pending.nodeId]: false } }));
    }
  },

  dismissRun() {
    set({ pending: undefined });
  },

  async cancelRun(nodeId) {
    const runs = useRunStore.getState().runs;
    const latest = Object.values(runs)
      .filter((run) => run.nodeId === nodeId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    if (!latest) return;
    if (latest.status !== 'queued' && latest.status !== 'running') {
      notify('该运行已经结束，无需取消');
      return;
    }
    try {
      await cancelRemoteRun(latest.id);
    } catch (error) {
      notify(messageOf(error));
    }
  },
}));
```

`src/run/events.ts`：

```ts
import { onAssetCreated, onRunUpdated } from '../services/events';
import { useRunStore } from '../stores/runStore';

export async function attachRunEvents(): Promise<() => void> {
  const unlisteners = await Promise.all([
    onRunUpdated((event) => {
      const store = useRunStore.getState();
      store.upsertRun(event.run);
      store.mergeAssets(event.assets);
    }),
    onAssetCreated((asset) => {
      useRunStore.getState().mergeAssets([asset]);
    }),
  ]);
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}
```

不要在前端调用 `resumeJobs()`：Rust 的 `setup` 已经调用过 `resume_pending_on_start`，重复调用会让同一个任务被轮询两次。

- [ ] **Step 12: 过期集合 hook 与画布注入**

`src/run/useStaleNodeIds.ts`：

```ts
import { useMemo } from 'react';
import { latestSucceededRun } from '../domain/graph/cacheKey';
import { computeStaleSet } from '../domain/graph/stale';
import { buildCacheContext } from '../domain/run/runtime';
import { useBoardStore } from '../stores/boardStore';
import { useProviderStore } from '../stores/providerStore';
import { useRunStore } from '../stores/runStore';
import { useStudioStore } from '../stores/studioStore';

export function useStaleNodeIds(): Set<string> {
  const board = useBoardStore((state) => state.board);
  const runs = useRunStore((state) => state.runs);
  const styleGuide = useStudioStore((state) =>
    state.projects.find((item) => item.id === state.currentProjectId)?.styleGuide);
  const profiles = useProviderStore((state) => state.profiles);
  const hasKeys = useProviderStore((state) => state.hasKeys);
  const loaded = useProviderStore((state) => state.loaded);

  return useMemo(() => {
    if (!board || !loaded) return new Set<string>();
    const runList = Object.values(runs);
    const ctx = buildCacheContext({ doc: board, runs: runList, profiles, hasKeys, styleGuide });
    const pinned = new Set(Object.values(board.nodes).filter((node) => node.ui?.pinned).map((node) => node.id));
    const stale = computeStaleSet(board, ctx, pinned);
    // 只标记「跑过但结果已过期」；从未运行的节点用「未运行」状态表达，不叠加过期角标。
    return new Set([...stale].filter((nodeId) => latestSucceededRun(runList, nodeId)));
  }, [board, runs, profiles, hasKeys, loaded, styleGuide]);
}
```

`loaded` 之前返回空集合，是为了避免设置尚未读完时 `providerId/model` 为空导致整画布闪一遍「过期」。

`src/canvas/mapping.ts`：`StudioNodeData` 与 `toFlowNodes` 各改一处。

```ts
export interface StudioNodeData extends Record<string, unknown> {
  domain: BoardNode;
  stale: boolean;
}
```

```ts
export function toFlowNodes(doc: BoardDoc, stale?: Set<string>): Node<StudioNodeData>[] {
  return Object.values(doc.nodes)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: { domain: node, stale: stale?.has(node.id) ?? false },
      parentId: node.parentId,
      extent: node.parentId ? 'parent' as const : undefined,
      zIndex: node.z,
      style: node.size ? { width: node.size.width, height: node.size.height } : undefined,
      draggable: true,
      selectable: true,
    }));
}
```

`src/canvas/CanvasView.tsx`：import 区追加 `import { useStaleNodeIds } from '../run/useStaleNodeIds';`，并把

```tsx
  const nodes = useMemo(() => (board ? toFlowNodes(board) : []), [board]);
```

改为：

```tsx
  const staleNodeIds = useStaleNodeIds();
  const nodes = useMemo(() => (board ? toFlowNodes(board, staleNodeIds) : []), [board, staleNodeIds]);
```

- [ ] **Step 13: 节点卡片上的运行/取消与过期角标**

`src/nodes/NodeCard.tsx` 三处改动。

1）import 区追加：

```tsx
import { Play, Square } from 'lucide-react';
import { useRunController } from '../run/controller';
```

2）在 `const run = useRunStore(...)` 之后追加（必须留在 `if (!def)` 提前 return 之前）：

```tsx
  const busy = useRunController((state) => Boolean(state.busy[node.id]));
  const requestRun = useRunController((state) => state.requestRun);
  const cancelActiveRun = useRunController((state) => state.cancelRun);
  const active = run?.status === 'queued' || run?.status === 'running';
```

3）把 header 改为（`data.stale` 角标 + 运行按钮）：

```tsx
      <header>
        <span className="flow-node-type" style={{ background: accent }} />
        <b>{def.title}</b>
        {node.ui?.pinned && <span className="flow-node-lock">锁定</span>}
        {data.stale && <span className="flow-node-stale">结果已过期</span>}
        <span className={`flow-status tone-${badge.tone}`}>{badge.label}</span>
        {!!def.actions.length && (
          <button
            type="button"
            className="nodrag flow-node-run"
            title={active ? '取消运行' : '运行'}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void (active ? cancelActiveRun(node.id) : requestRun(node.id));
            }}
          >
            {active ? <Square size={11} /> : <Play size={11} />}
          </button>
        )}
      </header>
```

并把根节点 className 追加过期态：

```tsx
      className={`flow-node type-${node.type}${selected ? ' is-selected' : ''}${data.stale ? ' is-stale' : ''}${node.type === 'group' ? ' is-group' : ''}`}
```

- [ ] **Step 14: Inspector 的运行 / 取消 / 锁定**

`src/inspector/Inspector.tsx` 四处改动。

1）import 区追加：

```tsx
import { CircleSlash, Pin, Play } from 'lucide-react';
import { useRunController } from '../run/controller';
import { useStaleNodeIds } from '../run/useStaleNodeIds';
```

2）在 `const [busy, setBusy] = useState(false);` 之后追加：

```tsx
  const requestRun = useRunController((state) => state.requestRun);
  const cancelActiveRun = useRunController((state) => state.cancelRun);
  const runBusy = useRunController((state) => Boolean(nodeId && state.busy[nodeId]));
  const staleNodeIds = useStaleNodeIds();
  const isStale = Boolean(nodeId && staleNodeIds.has(nodeId));
  const activeRun = latestRun && (latestRun.status === 'queued' || latestRun.status === 'running');
```

3）在 `运行` section 内、`<RunHistory runs={nodeRuns} />` 之前插入：

```tsx
        {isStale && <p className="inspector-warning">上游已更新，当前结果已过期；确认后再运行，不会自动重跑。</p>}
        <div className="inspector-run">
          <button
            type="button"
            className="studio-button"
            disabled={!def.actions.length || runBusy || Boolean(activeRun)}
            onClick={() => nodeId && void requestRun(nodeId)}
          >
            <Play size={12} /> {runBusy ? '准备中…' : '运行'}
          </button>
          <button
            type="button"
            className="studio-button secondary"
            disabled={!activeRun}
            onClick={() => nodeId && void cancelActiveRun(nodeId)}
          >
            <CircleSlash size={12} /> 取消
          </button>
          <button
            type="button"
            className="inspector-link"
            title="锁定后不再被标记为过期"
            onClick={() => useBoardStore.getState().apply({
              type: 'setNodeUi',
              nodeId: node.id,
              patch: { pinned: !node.ui?.pinned },
            })}
          >
            <Pin size={11} /> {node.ui?.pinned ? '解除锁定' : '锁定结果'}
          </button>
        </div>
```

4）`inspector-empty` 分支不需要改动：`useStaleNodeIds` 等 hooks 已在提前 return 之前调用。

- [ ] **Step 15: 费用确认对话框与挂载**

`src/run/RunConfirmDialog.tsx`：

```tsx
import type { RunRequestDraft } from '../domain/run/prepare';
import { useRunController } from './controller';

const CAPABILITY_LABEL: Record<string, string> = {
  'text.chat': '文本生成',
  'image.generate': '图片生成',
  'image.edit': '图片编辑',
  'video.generate': '视频生成',
  'audio.tts': '语音合成',
};

const MODE_LABEL: Record<string, string> = { t2v: '文生视频', firstLast: '首尾帧', reference: '全能参考' };

function paramLines(request: RunRequestDraft): string[] {
  const params = request.params;
  switch (request.capability) {
    case 'video.generate':
      return [
        `${MODE_LABEL[String(params.mode ?? '')] ?? String(params.mode ?? '')} · ${String(params.duration ?? '')} 秒 · ${String(params.resolution ?? '')} · ${String(params.ratio ?? '')}`,
        params.generateAudio ? '包含原生音频' : '不生成音频',
      ];
    case 'image.generate':
    case 'image.edit':
      return [`候选 ${String(params.count ?? 1)} 张 · ${String(params.size ?? '')}`];
    case 'audio.tts':
      return [`音色 ${String(params.voice ?? '')} · ${String(params.format ?? '')} · ${[...String(params.text ?? '')].length} 字符`];
    case 'text.chat':
      return [params.system ? '带系统提示' : '无系统提示'];
    default:
      return [];
  }
}

export function RunConfirmDialog() {
  const pending = useRunController((state) => state.pending);
  const confirmRun = useRunController((state) => state.confirmRun);
  const dismissRun = useRunController((state) => state.dismissRun);

  if (!pending) return null;

  return (
    <div className="confirm-backdrop" role="dialog" aria-modal="true" aria-label="运行确认">
      <div className="confirm-dialog">
        <header>
          <h2>运行「{pending.label.nodeTitle}」</h2>
          <p className="confirm-sub">这次会真实调用模型并产生费用。</p>
        </header>
        <dl className="confirm-body">
          <div><dt>能力</dt><dd>{CAPABILITY_LABEL[pending.request.capability] ?? pending.request.capability}</dd></div>
          <div><dt>模型</dt><dd>{pending.label.providerName} · {pending.label.modelName}</dd></div>
          <div><dt>参数</dt><dd>{paramLines(pending.request).join(' · ') || '默认'}</dd></div>
          <div><dt>提示词</dt><dd className="confirm-prompt">{pending.request.promptSnapshot.text}</dd></div>
          <div><dt>素材输入</dt><dd>{pending.inputCount ? `${pending.inputCount} 个` : '无'}</dd></div>
          <div><dt>预计费用</dt><dd>
            {pending.cost
              ? `${pending.cost.currency} ${pending.cost.amount} / ${pending.cost.unit}`
              : '未配置价格，无法估算；按实际用量计费'}
          </dd></div>
        </dl>
        {!!pending.warnings.length && (
          <ul className="confirm-warnings">
            {pending.warnings.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}
          </ul>
        )}
        <footer className="confirm-actions">
          <button type="button" className="studio-button secondary" onClick={dismissRun}>取消</button>
          <button type="button" className="studio-button" onClick={() => void confirmRun()}>确认运行</button>
        </footer>
      </div>
    </div>
  );
}
```

`src/app/StudioApp.tsx`：

1）import 区追加：

```tsx
import { attachRunEvents } from '../run/events';
import { RunConfirmDialog } from '../run/RunConfirmDialog';
```

2）在 `useEffect(() => { void bootProviders(); }, [bootProviders]);` 之后追加：

```tsx
useEffect(() => {
  let alive = true;
  let dispose: (() => void) | undefined;
  void attachRunEvents().then((fn) => {
    if (alive) dispose = fn;
    else fn();
  });
  return () => {
    alive = false;
    dispose?.();
  };
}, []);
```

3）在 `<SettingsDialog />` 之后追加：

```tsx
<RunConfirmDialog />
```

- [ ] **Step 16: Rust 侧以数据库资产元数据为准**

`src-tauri/src/runs.rs` 的 `prepare_inputs` 目前把前端传来的 `kind`/`mime` 直接塞进 `PreparedInput`。重启后前端 `assets` 读模型是空的，图片编辑与首尾帧会拿到空 MIME。改成以数据库里的资产为准（前端只负责告诉 Rust「用哪个资产、扮演什么角色」）：

把：

```rust
        prepared.push(gateway::PreparedInput {
            role: input.role.clone(),
            kind: input.kind.clone(),
            mime: input.mime.clone(),
            value: transport.value,
        });
```

改为：

```rust
        prepared.push(gateway::PreparedInput {
            role: input.role.clone(),
            kind: asset.kind.clone(),
            mime: asset.mime.clone(),
            value: transport.value,
        });
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml runs::`
Expected: PASS（Task 13 的 3 个用例仍通过；`RunInput.kind/mime` 保留为兼容字段，Rust 不再信任它们）。

- [ ] **Step 17: 追加样式**

在 `src/styles/studio.css` 末尾追加：

```css
.flow-node.is-stale { border-style: dashed; border-color: var(--warning); }
.flow-node-stale { color: var(--warning); font-size: 9px; white-space: nowrap; }
.flow-node-run { display: grid; place-items: center; width: 22px; height: 22px; color: var(--mint); background: var(--panel-3); border: 1px solid var(--line-strong); border-radius: 4px; }
.flow-node-run:hover { border-color: var(--mint); background: #26302f; }
.flow-node-run:disabled { opacity: .45; cursor: not-allowed; }
.inspector-run { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.confirm-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 24px; background: rgba(6, 10, 10, .74); backdrop-filter: blur(3px); }
.confirm-dialog { display: grid; gap: 14px; width: min(560px, 100%); max-height: min(680px, calc(100vh - 48px)); overflow: auto; padding: 18px; background: var(--panel); border: 1px solid var(--line-strong); border-radius: 8px; box-shadow: 0 24px 64px rgba(0, 0, 0, .55); }
.confirm-dialog header h2 { margin: 0; font-size: 15px; }
.confirm-sub { margin: 4px 0 0; color: var(--text-muted); font-size: 11px; }
.confirm-body { display: grid; gap: 7px; margin: 0; }
.confirm-body > div { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; align-items: baseline; }
.confirm-body dt { color: var(--text-dim); font-size: 10px; }
.confirm-body dd { margin: 0; color: var(--text); font-size: 11px; overflow-wrap: anywhere; }
.confirm-prompt { max-height: 132px; overflow: auto; padding: 8px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; font-family: var(--font-mono); font-size: 10px; line-height: 1.55; }
.confirm-warnings { display: grid; gap: 4px; margin: 0; padding-left: 16px; color: #f0d58d; font-size: 10px; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 18: 全量测试与构建**

Run:
```bash
pnpm test:unit
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: 前端与 Rust 测试全部通过，构建无错。

- [ ] **Step 19: 手工验收**

Run: `pnpm tauri dev`
Expected:
1. 文本节点接图片节点：文本运行成功后，图片节点直接点运行 → 弹出确认框，提示词里已带上游文本，费用按「张」显示；点「取消」不产生任何运行记录。
2. 图片节点重复点运行且图未变：确认框不再出现，节点立刻「完成」，右下角提示「缓存命中，未产生费用」，运行历史新增一条 `cost.estimated.unit = 缓存命中` 的记录。
3. 改上游文本 → 下游图片/视频节点出现虚线边框与「结果已过期」角标，且没有任何自动运行；Inspector 出现过期说明。
4. Inspector「锁定结果」后，该节点角标消失、上游变化不再标记它；取消锁定后恢复。
5. 视频节点选 4K/时长 4 秒：运行被拦截并提示对应错误码文案，`list_runs` 里没有新记录（花钱前拦截）。
6. 只配 H3 且未配素材外链：接了首帧的视频节点运行时报「该模型只接受公网素材链接…」；纯文生视频（无素材输入）不受该限制。
7. 视频运行中：节点按钮变成方块（取消），点取消后状态停在「已取消」；期间画布内其它节点运行结果不被覆盖，运行历史按时间倒序。
8. 生成中途关掉窗口再打开：`pnpm tauri dev` 重启后视频任务继续轮询并落库（Task 14 的 `resume_pending_on_start`），前端不再额外触发 `resume_jobs`。
9. 未保存 Key 时运行 → 提示「尚未保存 API Key」，不会发出请求。

- [ ] **Step 20: 提交**

```bash
git add src/domain/run src/domain/nodes/definitions.ts src/run src/stores/runStore.ts src/canvas src/nodes/NodeCard.tsx src/inspector src/app/StudioApp.tsx src/styles/studio.css src-tauri/src/runs.rs
git commit -m "feat(p0): 运行编排、过期标记与费用确认"
```

---

### Task 22: 旧项目导入

**Files:**
- Create: `src-tauri/src/import.rs`
- Modify: `src-tauri/src/lib.rs`（`mod import;`、`import_legacy_project` 命令与注册）
- Modify: `src-tauri/src/runs.rs`（`save_asset` 改 `pub(crate)`）
- Reuse: `src-tauri/src/lib.rs` 的 `pub(crate) fn strip_sensitive_fields`（Task 15 已定义为 `pub(crate)`，本 Task 只调用）
- Create: `src/import/legacy.ts`
- Test: `src/import/legacy.test.ts`
- Create: `src/import/LegacyImportDialog.tsx`
- Modify: `src/services/tauri.ts`
- Modify: `src/stores/studioStore.ts`（`boot(force?)`）
- Modify: `src/app/ProjectLibrary.tsx`
- Modify: `src/styles/studio.css`

**Interfaces:**
- Consumes: `assets::store_bytes`、`assets::decode_data_url`、`runs::RunRecord`、`runs::save_run`、`runs::save_asset`、`security::validate_remote_url`、`db::open`、`crate::http_client`、`@tauri-apps/plugin-dialog` 的 `open`、`useStudioStore`。
- Produces:
  - `import::LegacyImportResult { project, board, asset_count, run_count, warnings }`
  - `import::collect_asset_sources(value) -> Vec<LegacySource>`
  - `import::build_legacy_board(value, project_id, board_id, asset_ids) -> (Value, Vec<RunRecord>, Vec<String>)`
  - 命令 `import_legacy_project(path)`
  - 前端 `importLegacyProject(path)`、`pickLegacyFile()`、`summarizeImport(result)`、`LegacyImportDialog`

**P0 边界（写死在实现里，避免越界）：**

- 只映射到 P0 原语节点：characters → 文本 + 图片节点，scenes → 文本节点，shots → 视频节点，storyboards / referenceBindings → 图片节点 + 边。P1 的 CharacterEntity / ShotEntity / 三视图 / 时间线不在本 Task（设计 14.5 的完整迁移属于 P2）。
- 导入的素材一律复制进 CAS，不引用原路径。
- 导入产生的节点全部 `ui.pinned = true`：它们是既有成果，不参与过期传播；改动上游后由用户手动解锁重生成。
- 每个镜头的视频模式必须自洽：有首/尾帧 → `firstLast` 并丢弃参考；无帧但有参考 → `reference`；两者都无 → `t2v`。这样导入出来的画布不会一进 `validateBoard` 就报 `GRAPH_PORT_HIDDEN` / `VIDEO_MODE_CONFLICT`。

- [ ] **Step 1: 写失败的 Rust 内联测试**

`src-tauri/src/import.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn legacy() -> Value {
        json!({
            "id": "legacy_1", "name": "旧短剧", "logline": "雨夜告别", "aspectRatio": "9:16",
            "styleGuide": {
                "genre": "悬疑", "visualStyle": "冷色写实", "colorLanguage": "青灰",
                "cameraLanguage": "手持", "era": "当代", "constraints": "不见血", "negativeConstraints": "卡通感"
            },
            "characters": [
                { "id": "c1", "name": "林淮", "role": "男主", "bio": "沉默寡言的法医", "portraitUrl": "https://cdn.example/portrait.png",
                  "status": "approved", "referenceIds": [], "variants": [] }
            ],
            "scenes": [
                { "id": "s1", "heading": "内景 法医室 - 夜", "action": "林淮盯着屏幕", "dialogue": "他已经死了很久。",
                  "emotionalBeat": "压抑", "hook": "尸体开口", "status": "approved" }
            ],
            "shots": [
                { "id": "sh1", "sceneId": "s1", "number": 1, "duration": 24, "framing": "特写", "cameraMotion": "推进",
                  "action": "瞳孔收缩", "characters": ["c1"], "audioCue": "雨声", "aspectRatio": "9:16", "status": "approved" },
                { "id": "sh2", "sceneId": "s1", "number": 2, "duration": 6, "framing": "中景",
                  "action": "转身离开", "characters": [], "audioCue": "", "aspectRatio": "9:16", "status": "draft" }
            ],
            "storyboards": [
                { "id": "sb1", "shotId": "sh1", "role": "storyboard", "url": "/Users/xiic/frameforge/sb1.png",
                  "version": 1, "selected": true, "createdAt": "2026-10-01T00:00:00Z" }
            ],
            "referenceBindings": [
                { "id": "rb1", "shotId": "sh1", "slot": 0, "role": "start", "sourceUrl": "https://cdn.example/start.png",
                  "label": "首帧", "locked": true }
            ],
            "candidates": [
                { "id": "ca1", "jobId": "j1", "kind": "video", "label": "镜头 1 成片", "url": "https://cdn.example/shot1.mp4",
                  "promptId": "p1", "provider": "h3", "model": "MiniMax-H3", "createdAt": "2026-10-01T00:00:00Z",
                  "selected": true, "metadata": {} }
            ]
        })
    }

    fn asset_map() -> HashMap<String, String> {
        [
            ("https://cdn.example/portrait.png".to_string(), "asset_portrait".to_string()),
            ("https://cdn.example/start.png".to_string(), "asset_start".to_string()),
            ("/Users/xiic/frameforge/sb1.png".to_string(), "asset_sb1".to_string()),
            ("https://cdn.example/shot1.mp4".to_string(), "asset_video1".to_string()),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn collects_portrait_frame_storyboard_and_candidate_sources() {
        let sources = collect_asset_sources(&legacy());
        let urls: Vec<&str> = sources.iter().map(|item| item.url.as_str()).collect();
        assert!(urls.contains(&"https://cdn.example/portrait.png"));
        assert!(urls.contains(&"https://cdn.example/start.png"));
        assert!(urls.contains(&"/Users/xiic/frameforge/sb1.png"));
        assert!(urls.contains(&"https://cdn.example/shot1.mp4"));
        assert_eq!(sources.len(), sources.iter().map(|item| item.url.clone()).collect::<HashSet<_>>().len());
    }

    #[test]
    fn frames_win_and_references_are_dropped_with_a_warning() {
        let (board, runs, warnings) = build_legacy_board(&legacy(), "project_1", "board_1", &asset_map());
        let shot = &board["nodes"]["node_shot_1"];
        assert_eq!(shot["data"]["mode"], "firstLast");
        assert!(warnings.iter().any(|item| item.contains("首尾帧")));
        let references = board["edges"]
            .as_object()
            .unwrap()
            .values()
            .filter(|edge| edge["target"] == "node_shot_1" && edge["targetPort"] == "references")
            .count();
        assert_eq!(references, 0);
        let start = board["edges"]
            .as_object()
            .unwrap()
            .values()
            .any(|edge| edge["target"] == "node_shot_1" && edge["targetPort"] == "start");
        assert!(start);
        assert!(runs.iter().any(|run| run.node_id == "node_shot_1" && run.selected_asset_id.as_deref() == Some("asset_video1")));
    }

    #[test]
    fn text_to_video_when_no_media() {
        let (board, _, _) = build_legacy_board(&legacy(), "project_1", "board_1", &asset_map());
        assert_eq!(board["nodes"]["node_shot_2"]["data"]["mode"], "t2v");
    }

    #[test]
    fn duration_is_clamped_into_the_model_range() {
        let (board, _, warnings) = build_legacy_board(&legacy(), "project_1", "board_1", &asset_map());
        assert_eq!(board["nodes"]["node_shot_1"]["data"]["duration"], json!(15));
        assert!(warnings.iter().any(|item| item.contains("时长")));
    }

    #[test]
    fn imported_nodes_are_pinned_and_style_guide_moves_the_negative_constraints() {
        let (board, _, _) = build_legacy_board(&legacy(), "project_1", "board_1", &asset_map());
        assert_eq!(board["nodes"]["node_portrait_1"]["ui"]["pinned"], json!(true));
        assert_eq!(board["nodes"]["node_shot_1"]["ui"]["pinned"], json!(true));
        let project = build_legacy_project(&legacy(), "project_1");
        assert_eq!(project["styleGuide"]["negative"], json!("卡通感"));
        assert_eq!(project["styleGuide"]["version"], json!(1));
        assert_eq!(project["aspectRatio"], json!("9:16"));
    }

    #[test]
    fn reference_mode_is_used_when_only_references_exist() {
        let mut doc = legacy();
        doc["referenceBindings"] = json!([]);
        doc["storyboards"] = json!([]);
        let (board, _, warnings) = build_legacy_board(&doc, "project_1", "board_1", &asset_map());
        assert_eq!(board["nodes"]["node_shot_1"]["data"]["mode"], "reference");
        assert!(warnings.iter().any(|item| item.contains("未导入")));
    }

    #[test]
    fn reference_list_is_trimmed_to_the_model_limit() {
        let mut doc = legacy();
        doc["referenceBindings"] = json!([]);
        doc["storyboards"] = json!([]);
        doc["characters"] = Value::Array((0..12).map(|index| json!({
            "id": format!("c{index}"), "name": format!("角色 {index}"), "role": "", "bio": "",
            "portraitUrl": format!("https://cdn.example/p{index}.png"), "status": "draft", "referenceIds": [], "variants": []
        })).collect());
        doc["shots"][0]["characters"] = json!((0..12).map(|index| format!("c{index}")).collect::<Vec<_>>());
        let mut map = HashMap::new();
        for index in 0..12 {
            map.insert(format!("https://cdn.example/p{index}.png"), format!("asset_{index}"));
        }
        let (board, _, warnings) = build_legacy_board(&doc, "project_1", "board_1", &map);
        let references = board["edges"].as_object().unwrap().values()
            .filter(|edge| edge["target"] == "node_shot_1" && edge["targetPort"] == "references")
            .count();
        assert_eq!(references, MAX_H3_REFERENCES);
        assert!(warnings.iter().any(|item| item.contains("参考")));
    }

    #[test]
    fn missing_asset_ids_degrade_to_unpinned_nodes_instead_of_panicking() {
        let (board, runs, warnings) = build_legacy_board(&legacy(), "project_1", "board_1", &HashMap::new());
        assert!(runs.is_empty());
        assert!(board["nodes"]["node_shot_1"]["ui"].is_null() || board["nodes"]["node_shot_1"]["ui"]["pinned"].is_null());
        assert!(warnings.iter().any(|item| item.contains("素材")));
    }

    #[test]
    fn local_paths_outside_the_allowed_roots_are_rejected() {
        let root = std::env::temp_dir().join(format!("ff_import_root_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("root");
        let outside = Path::new("/etc/hosts");
        let error = resolve_local_bytes(outside, &[root.clone()]).expect_err("rejected");
        assert_eq!(error.code, "IMPORT_PATH_ESCAPE");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_document_must_be_a_json_object_with_known_sections() {
        let dir = std::env::temp_dir().join(format!("ff_import_doc_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let wrong_extension = dir.join("project.txt");
        std::fs::write(&wrong_extension, "{}").expect("write");
        assert_eq!(read_legacy_document(&wrong_extension, &[dir.clone()]).expect_err("ext").code, "IMPORT_TYPE_INVALID");

        let not_legacy = dir.join("other.json");
        std::fs::write(&not_legacy, "{\"hello\":1}").expect("write");
        assert_eq!(read_legacy_document(&not_legacy, &[dir.clone()]).expect_err("schema").code, "IMPORT_SCHEMA_UNKNOWN");

        let ok = dir.join("project.json");
        std::fs::write(&ok, legacy().to_string()).expect("write");
        assert!(read_legacy_document(&ok, &[dir]).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml import::`
Expected: FAIL，`mod import` 不存在。

- [ ] **Step 3: 实现纯映射**

`src-tauri/src/import.rs`：

```rust
use crate::runs::RunRecord;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const MAX_H3_REFERENCES: usize = 9;
pub const MAX_LEGACY_JSON_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;
pub const NODE_BUDGET_WARNING: usize = 500;

const COLUMN: f64 = 340.0;
const ORIGIN_X: f64 = 40.0;
const ROW_CHARACTER: f64 = 40.0;
const ROW_PORTRAIT: f64 = 240.0;
const ROW_SCENE: f64 = 470.0;
const ROW_SHOT: f64 = 700.0;
const ROW_MEDIA: f64 = 930.0;
const MEDIA_STEP: f64 = 200.0;

#[derive(Debug, Clone, PartialEq)]
pub struct LegacySource {
    pub url: String,
    pub kind: &'static str,
}

fn str_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn as_array<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn kind_for_candidate(value: &Value) -> &'static str {
    match str_field(value, "kind").as_str() {
        "video" => "video",
        "audio" => "audio",
        _ => "image",
    }
}

fn kind_for_url(url: &str) -> &'static str {
    let lowered = url.to_ascii_lowercase();
    if [".mp4", ".mov", ".webm", ".mkv"].iter().any(|suffix| lowered.ends_with(suffix)) {
        "video"
    } else if [".mp3", ".wav", ".m4a", ".aac", ".ogg"].iter().any(|suffix| lowered.ends_with(suffix)) {
        "audio"
    } else {
        "image"
    }
}

pub fn collect_asset_sources(value: &Value) -> Vec<LegacySource> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut sources: Vec<LegacySource> = Vec::new();
    let mut push = |url: &str, kind: &'static str| {
        let trimmed = url.trim();
        if trimmed.is_empty() || trimmed.starts_with("blob:") {
            return;
        }
        if seen.insert(trimmed.to_string()) {
            sources.push(LegacySource { url: trimmed.to_string(), kind });
        }
    };

    for character in as_array(value, "characters") {
        push(&str_field(character, "portraitUrl"), "image");
    }
    for storyboard in as_array(value, "storyboards") {
        if storyboard.get("selected").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        push(&str_field(storyboard, "url"), "image");
    }
    let candidates: HashMap<String, &Value> = as_array(value, "candidates")
        .into_iter()
        .filter_map(|item| str_field(item, "id").into_option_helper())
        .collect();
    for binding in as_array(value, "referenceBindings") {
        let asset_id = str_field(binding, "assetId");
        match candidates.get(&asset_id) {
            Some(candidate) => push(&str_field(candidate, "url"), kind_for_candidate(candidate)),
            None => push(&str_field(binding, "sourceUrl"), kind_for_url(&str_field(binding, "sourceUrl"))),
        }
    }
    for candidate in as_array(value, "candidates") {
        if candidate.get("selected").and_then(Value::as_bool) == Some(true) {
            push(&str_field(candidate, "url"), kind_for_candidate(candidate));
        }
    }
    sources
}
```

`String::into_option_helper` 不存在——那行是错的，把 `candidates` 的构造改成直接过滤：

```rust
    let mut candidates: HashMap<String, &Value> = HashMap::new();
    for candidate in as_array(value, "candidates") {
        let id = str_field(candidate, "id");
        if !id.is_empty() {
            candidates.insert(id, candidate);
        }
    }
```

继续实现项目与画布映射：

```rust
pub fn build_legacy_project(value: &Value, project_id: &str) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    let guide = value.get("styleGuide").cloned().unwrap_or_else(|| json!({}));
    let ratio = match str_field(value, "aspectRatio").as_str() {
        "16:9" => "16:9",
        "1:1" => "1:1",
        _ => "9:16",
    };
    json!({
        "schemaVersion": 1,
        "id": project_id,
        "name": {
            let name = str_field(value, "name");
            if name.is_empty() { "导入的旧项目".to_string() } else { name }
        },
        "aspectRatio": ratio,
        "styleGuide": {
            "genre": str_field(&guide, "genre"),
            "visualStyle": str_field(&guide, "visualStyle"),
            "colorLanguage": str_field(&guide, "colorLanguage"),
            "cameraLanguage": str_field(&guide, "cameraLanguage"),
            "era": str_field(&guide, "era"),
            "constraints": str_field(&guide, "constraints"),
            "negative": str_field(&guide, "negativeConstraints"),
            "version": 1
        },
        "createdAt": now,
        "updatedAt": now
    })
}

fn column(index: usize) -> f64 {
    ORIGIN_X + index as f64 * COLUMN
}

fn node(id: &str, node_type: &str, x: f64, y: f64, data: Value, pinned: bool) -> Value {
    let mut node = json!({
        "id": id, "type": node_type, "typeVersion": 1,
        "position": { "x": x, "y": y }, "z": 0, "data": data
    });
    if pinned {
        node["ui"] = json!({ "pinned": true });
    }
    node
}

fn edge(id: &str, source: &str, source_port: &str, target: &str, target_port: &str, role: &str) -> Value {
    json!({
        "id": id, "source": source, "sourcePort": source_port,
        "target": target, "targetPort": target_port, "role": role,
        "createdAt": chrono::Utc::now().to_rfc3339()
    })
}

fn imported_run(project_id: &str, board_id: &str, node_id: &str, asset_id: &str, prompt: &str) -> RunRecord {
    let now = chrono::Utc::now().to_rfc3339();
    RunRecord {
        id: format!("run_{}", uuid::Uuid::new_v4()),
        project_id: project_id.to_string(),
        board_id: board_id.to_string(),
        node_id: node_id.to_string(),
        entity_id: None,
        action: "import".to_string(),
        cache_key: format!("imported-{node_id}"),
        status: "succeeded".to_string(),
        provider_id: None,
        model: None,
        prompt_snapshot: json!({
            "text": prompt, "segments": [], "hash": format!("imported-{asset_id}"), "locked": true
        }),
        params: json!({}),
        input_asset_ids: vec![],
        output_asset_ids: vec![asset_id.to_string()],
        selected_asset_id: Some(asset_id.to_string()),
        cost: Some(json!({ "estimated": { "amount": 0, "currency": "", "unit": "导入" } })),
        error: None,
        started_at: now.clone(),
        finished_at: Some(now),
    }
}

pub fn build_legacy_board(
    value: &Value,
    project_id: &str,
    board_id: &str,
    asset_ids: &HashMap<String, String>,
) -> (Value, Vec<RunRecord>, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();
    let mut nodes: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut edges: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut runs: Vec<RunRecord> = Vec::new();

    let mut attach = |node_id: &str, label: &str, url: Option<&str>, kind: &str| -> Option<String> {
        let asset_id = url.and_then(|raw| asset_ids.get(raw.trim()).cloned());
        if url.is_some() && asset_id.is_none() {
            warnings.push(format!("「{label}」的素材未能导入，节点保留为空"));
        }
        let _ = kind;
        asset_id
    };

    let mut push_node = |id: String, node: Value| {
        nodes.insert(id, node);
    };
    let mut push_edge = |id: String, item: Value| {
        edges.insert(id, item);
    };

    // 角色：简介文本节点 + 定妆图片节点
    let characters = as_array(value, "characters");
    for (index, character) in characters.iter().enumerate() {
        let key = str_field(character, "id");
        let brief_id = format!("node_char_{}", index + 1);
        let portrait_id = format!("node_portrait_{}", index + 1);
        let name = str_field(character, "name");
        let brief = format!(
            "角色：{name}\n定位：{}\n背景：{}",
            str_field(character, "role"),
            str_field(character, "bio")
        );
        push_node(brief_id.clone(), node("text", &brief_id, column(index), ROW_CHARACTER, json!({
            "prompt": brief, "system": "", "mode": "generate", "providerId": "", "model": ""
        }), false));

        let portrait_url = str_field(character, "portraitUrl");
        let asset_id = attach(
            &portrait_id,
            &if name.is_empty() { "角色".to_string() } else { name.clone() },
            Some(portrait_url.as_str()).filter(|raw| !raw.is_empty()),
            "image",
        );
        push_node(portrait_id.clone(), node("image", &portrait_id, column(index), ROW_PORTRAIT, json!({
            "prompt": format!("{name} 的标准三视图与定妆照，{brief}"),
            "negative": "", "size": "1024x1536", "count": 1,
            "selectedAssetId": asset_id
        }), asset_id.is_some()));
        push_edge(
            format!("edge_{}", uuid::Uuid::new_v4()),
            edge("edge-legacy", &brief_id, "text", &portrait_id, "prompt", "prompt"),
        );
        if let Some(asset) = asset_id {
            runs.push(imported_run(project_id, board_id, &portrait_id, &asset, "导入自旧项目角色定妆照"));
        }
    }

    // 场景：文本节点（P0 先不落 Script 实体）
    let scenes = as_array(value, "scenes");
    for (index, scene) in scenes.iter().enumerate() {
        let scene_id = format!("node_scene_{}", index + 1);
        let body = format!(
            "{}\n{}\n台词：{}\n情绪：{}\n钩子：{}",
            str_field(scene, "heading"),
            str_field(scene, "action"),
            str_field(scene, "dialogue"),
            str_field(scene, "emotionalBeat"),
            str_field(scene, "hook")
        );
        push_node(scene_id.clone(), node("text", &scene_id, column(index), ROW_SCENE, json!({
            "prompt": body, "system": "", "mode": "generate", "providerId": "", "model": ""
        }), false));
    }

    // 分镜参考：binding + storyboard，按镜头归组
    let mut binding_asset: HashMap<String, String> = HashMap::new();
    let candidates: HashMap<String, &Value> = {
        let mut map: HashMap<String, &Value> = HashMap::new();
        for candidate in as_array(value, "candidates") {
            let id = str_field(candidate, "id");
            if !id.is_empty() {
                map.insert(id, candidate);
            }
        }
        map
    };
    let mut shot_frames: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut shot_references: HashMap<String, Vec<String>> = HashMap::new();
    let mut skipped_middle: usize = 0;

    for binding in as_array(value, "referenceBindings") {
        let shot_id = str_field(binding, "shotId");
        if shot_id.is_empty() {
            continue;
        }
        let asset_id = str_field(binding, "assetId");
        let url = match candidates.get(&asset_id) {
            Some(candidate) => str_field(candidate, "url"),
            None => str_field(binding, "sourceUrl"),
        };
        if url.is_empty() {
            continue;
        }
        match str_field(binding, "role").as_str() {
            "start" | "end" => shot_frames.entry(shot_id).or_default().push((str_field(binding, "role"), url)),
            "middle" => skipped_middle += 1,
            _ => shot_references.entry(shot_id).or_default().push(url),
        }
    }
    for storyboard in as_array(value, "storyboards") {
        let shot_id = str_field(storyboard, "shotId");
        let url = str_field(storyboard, "url");
        if shot_id.is_empty() || url.is_empty() {
            continue;
        }
        if str_field(storyboard, "role") == "clean" {
            shot_frames.entry(shot_id).or_default().push(("start".to_string(), url));
        } else {
            shot_references.entry(shot_id).or_default().push(url);
        }
    }
    if skipped_middle > 0 {
        warnings.push(format!("{skipped_middle} 个中间帧未导入：P0 视频节点没有中间帧端口"));
    }

    // 选中视频候选按镜头 id 前缀尽力归组（旧数据没有 shotId，只能靠 label 兜底）
    let mut shot_videos: HashMap<String, Vec<String>> = HashMap::new();
    for candidate in as_array(value, "candidates") {
        if candidate.get("selected").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if kind_for_candidate(candidate) != "video" {
            continue;
        }
        let url = str_field(candidate, "url");
        let label = str_field(candidate, "label");
        for shot in as_array(value, "shots") {
            let shot_id = str_field(shot, "id");
            let number = shot.get("number").and_then(Value::as_i64).unwrap_or(0);
            if !shot_id.is_empty() && (label.contains(&shot_id) || label.contains(&format!("镜头 {number}"))) {
                shot_videos.entry(shot_id).or_default().push(url);
            }
        }
    }

    let shots = as_array(value, "shots");
    let scene_index: HashMap<String, usize> = scenes
        .iter()
        .enumerate()
        .map(|(index, scene)| (str_field(scene, "id"), index))
        .collect();
    let character_index: HashMap<String, usize> = characters
        .iter()
        .enumerate()
        .map(|(index, character)| (str_field(character, "id"), index))
        .collect();

    for (index, shot) in shots.iter().enumerate() {
        if shot.get("archived").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let shot_id = str_field(shot, "id");
        let number = shot.get("number").and_then(Value::as_i64).unwrap_or((index + 1) as i64);
        let node_id = format!("node_shot_{}", index + 1);
        let frames = shot_frames.remove(&shot_id).unwrap_or_default();
        let raw_references = shot_references.remove(&shot_id).unwrap_or_default();
        let character_portraits: Vec<String> = shot
            .get("characters")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| character_index.get(id.as_str()?).map(|at| format!("node_portrait_{}", at + 1)))
                    .collect()
            })
            .unwrap_or_default();

        let mut mode = "t2v";
        let mut media: Vec<(String, String, &'static str)> = Vec::new();
        let mut prompt_port: Option<String> = None;

        let duration_raw = shot.get("duration").and_then(Value::as_f64).unwrap_or(6.0);
        let duration = duration_raw.round().clamp(5.0, 15.0) as i64;
        if duration != duration_raw.round() as i64 {
            warnings.push(format!("镜头 {number} 时长 {duration_raw} 秒被夹到 H3 支持的 {duration} 秒"));
        }

        if !frames.is_empty() {
            mode = "firstLast";
            for (role, url) in frames.iter().take(2) {
                let port = if role == "end" { "end" } else { "start" };
                media.push((port.to_string(), url.clone(), "frame"));
            }
            if !raw_references.is_empty() || !character_portraits.is_empty() {
                warnings.push(format!(
                    "镜头 {number} 已用首尾帧模式，{}/{} 个参考素材未导入（H3 首尾帧与参考互斥）",
                    raw_references.len() + character_portraits.len(),
                    raw_references.len() + character_portraits.len()
                ));
            }
        } else {
            let mut references: Vec<String> = Vec::new();
            references.extend(raw_references.iter().cloned());
            let portrait_by_index: HashMap<usize, String> = characters
                .iter()
                .enumerate()
                .map(|(at, character)| (at, str_field(character, "portraitUrl")))
                .collect();
            for id in shot.get("characters").and_then(Value::as_array).map(|v| v.clone()).unwrap_or_default() {
                if let Some(url) = id.as_str().and_then(|key| character_index.get(key)).and_then(|at| portrait_by_index.get(at)) {
                    if !url.is_empty() && !references.contains(url) {
                        references.push(url.clone());
                    }
                }
            }
            if references.len() > MAX_H3_REFERENCES {
                warnings.push(format!(
                    "镜头 {number} 参考素材 {} 个，超过 H3 上限 {}，只导入前 {} 个",
                    references.len(),
                    MAX_H3_REFERENCES,
                    MAX_H3_REFERENCES
                ));
                references.truncate(MAX_H3_REFERENCES);
            }
            if !references.is_empty() {
                mode = "reference";
                for url in references {
                    media.push(("references".to_string(), url, "image"));
                }
            }
        }

        // 场景文本作为提示词来源
        if let Some(scene_at) = scene_index.get(&str_field(shot, "sceneId")) {
            prompt_port = Some(format!("node_scene_{}", scene_at + 1));
        }

        let prompt = format!(
            "镜头 {number}：{}{}，{}。角色：{}。声音：{}",
            str_field(shot, "framing"),
            {
                let motion = str_field(shot, "cameraMotion");
                if motion.is_empty() { String::new() } else { format!("，{motion}") }
            },
            str_field(shot, "action"),
            {
                let names: Vec<String> = shot
                    .get("characters")
                    .and_then(Value::as_array)
                    .map(|ids| ids.iter().filter_map(|id| id.as_str()).map(ToString::to_string).collect())
                    .unwrap_or_default();
                if names.is_empty() { "无".to_string() } else { names.join("、") }
            },
            {
                let cue = str_field(shot, "audioCue");
                if cue.is_empty() { "环境声".to_string() } else { cue }
            }
        );

        let videos = shot_videos.remove(&shot_id).unwrap_or_default();
        let selected_video = videos.iter().find_map(|url| asset_ids.get(url.trim()).cloned());
        let media_nodes: Vec<(String, String)> = media
            .iter()
            .enumerate()
            .filter_map(|(slot, (port, url, _))| {
                let asset_id = asset_ids.get(url.trim())?;
                Some((port.clone(), asset_id.clone()))
            })
            .collect();
        // 同一资产可能同时出现在 start 与 references，端口去重后只建一个上游节点
        let mut unique: Vec<(String, String)> = Vec::new();
        for (port, asset_id) in media_nodes {
            if !unique.iter().any(|(_, existing)| *existing == asset_id) {
                unique.push((port, asset_id));
            }
        }

        let mut media_ids: Vec<String> = Vec::new();
        for (slot, (port, asset_id)) in unique.iter().enumerate() {
            let media_node = format!("node_media_{}_{}", index + 1, slot + 1);
            push_node(media_node.clone(), node("image", &media_node, column(index), ROW_MEDIA + slot as f64 * MEDIA_STEP, json!({
                "prompt": format!("镜头 {number} 的{port}素材（旧项目导入）", port = if port == "end" { "尾帧" } else { "首帧/参考" }),
                "negative": "", "size": "1024x1536", "count": 1,
                "selectedAssetId": asset_id
            }), true));
            push_edge(
                format!("edge_{}", uuid::Uuid::new_v4()),
                edge("edge-legacy-media", &media_node, "image", &node_id, port, if port == "end" { "last_frame" } else if port == "start" { "first_frame" } else { "reference_image" }),
            );
            runs.push(imported_run(project_id, board_id, &media_node, asset_id, "导入自旧项目分镜素材"));
            media_ids.push(media_node);
        }

        push_node(node_id.clone(), node("video", &node_id, column(index), ROW_SHOT, json!({
            "prompt": prompt, "negative": "", "mode": mode, "duration": duration,
            "resolution": "768P", "aspectRatio": if str_field(shot, "aspectRatio") == "16:9" { "16:9" } else { "9:16" },
            "generateAudio": true, "selectedAssetId": selected_video
        }), selected_video.is_some()));

        if let Some(source) = prompt_port {
            push_edge(
                format!("edge_{}", uuid::Uuid::new_v4()),
                edge("edge-legacy-scene", &source, "text", &node_id, "prompt", "prompt"),
            );
        }
        for media_id in &media_ids {
            let _ = media_id;
        }
        if let Some(asset) = selected_video {
            runs.push(imported_run(project_id, board_id, &node_id, &asset, "导入自旧项目成片候选"));
        }
        let _ = &character_portraits;
    }

    if !shot_frames.is_empty() || !shot_references.is_empty() || !shot_videos.is_empty() {
        warnings.push("部分旧镜头没有对应节点，其素材已导入但未连线".to_string());
    }
    let node_count = nodes.len();
    if node_count > NODE_BUDGET_WARNING {
        warnings.push(format!("导入生成 {node_count} 个节点，画布会明显变重，建议按集拆分项目"));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let board = json!({
        "schemaVersion": 1,
        "id": board_id,
        "projectId": project_id,
        "name": format!("{} · 导入", {
            let name = str_field(value, "name");
            if name.is_empty() { "旧项目".to_string() } else { name }
        }),
        "nodes": Value::Object(nodes),
        "edges": Value::Object(edges),
        "viewport": { "x": 0, "y": 0, "zoom": 0.55 },
        "createdAt": now,
        "updatedAt": now
    });
    (board, runs, warnings)
}
```

上面这段里 `attach` 闭包只做了一件事、且 `let _ = kind;` 与 `let _ = &character_portraits;`、空的 `for media_id in &media_ids` 循环都是为占位而写的废代码——实现时按下面三条清理，否则 `cargo clippy` 会报：

1. 删掉 `attach` 闭包，把角色定妆照那段直接写成 `let asset_id = if portrait_url.is_empty() { None } else { asset_ids.get(&portrait_url).cloned() };` 并在 `Some(url) => asset_ids.get(...).is_none()` 时 `warnings.push(format!("「{name}」的素材未能导入，节点保留为空"))`。
2. 删掉 `for media_id in &media_ids { let _ = media_id; }` 与 `let _ = &character_portraits;`。`character_portraits` 仍然要算：在 `mode == "reference"` 分支里，如果它非空但对应资产没能导入（`asset_ids` 查不到），补一条 `warnings.push(format!("镜头 {number} 的角色参考素材未能导入"))`。
3. `node()` 的第一个形参在测试断言里叫 `node_type`，调用处已按 `(type, id, x, y, data, pinned)` 顺序传参；保持签名 `fn node(node_type: &str, id: &str, x: f64, y: f64, data: Value, pinned: bool) -> Value` 一致。

Run: `cargo test --manifest-path src-tauri/Cargo.toml import::`
Expected: FAIL，`read_legacy_document` / `resolve_local_bytes` 未定义（映射类测试应已通过）。

- [ ] **Step 4: 补 IO 与下载（含路径与 SSRF 守卫）**

`src-tauri/src/import.rs` 继续追加：

```rust
use crate::assets;
use crate::db;
use crate::gateway::AppError;
use crate::runs;
use crate::security;
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportResult {
    pub project: Value,
    pub board: Value,
    pub asset_count: usize,
    pub run_count: usize,
    pub warnings: Vec<String>,
}

fn storage_error(message: impl Into<String>) -> AppError {
    AppError::new("STORAGE_IO", message, false)
}

pub fn read_legacy_document(path: &Path, _roots: &[PathBuf]) -> Result<Value, AppError> {
    let meta = std::fs::symlink_metadata(path).map_err(|error| storage_error(error.to_string()))?;
    if !meta.is_file() {
        return Err(AppError::new("IMPORT_TYPE_INVALID", "只能导入普通 JSON 文件", false));
    }
    if meta.len() > MAX_LEGACY_JSON_BYTES {
        return Err(AppError::new("IMPORT_TOO_LARGE", "旧项目 JSON 超过 8 MB", false));
    }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if extension != "json" {
        return Err(AppError::new("IMPORT_TYPE_INVALID", "只支持 .json 旧项目文件", false));
    }
    let text = std::fs::read_to_string(path).map_err(|error| storage_error(error.to_string()))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| AppError::new("IMPORT_JSON_INVALID", error.to_string(), false))?;
    if as_array(&value, "characters").is_empty() && as_array(&value, "shots").is_empty() {
        return Err(AppError::new("IMPORT_SCHEMA_UNKNOWN", "文件里没有 characters / shots，可能不是旧项目 JSON", false));
    }
    let mut document = value;
    crate::strip_sensitive_fields(&mut document);
    Ok(document)
}

pub fn resolve_local_bytes(path: &Path, roots: &[PathBuf]) -> Result<Vec<u8>, AppError> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| AppError::new("IMPORT_ASSET_MISSING", format!("素材文件不存在：{}", path.display()), false))?;
    if meta.is_symlink() || !meta.is_file() {
        return Err(AppError::new("IMPORT_TYPE_INVALID", "素材必须是普通文件", false));
    }
    if meta.len() > MAX_ASSET_BYTES {
        return Err(AppError::new("IMPORT_TOO_LARGE", "单个素材超过 256 MB", false));
    }
    let resolved = path.canonicalize().map_err(|error| storage_error(error.to_string()))?;
    if !roots.iter().filter_map(|root| root.canonicalize().ok()).any(|root| resolved.starts_with(&root)) {
        return Err(AppError::new("IMPORT_PATH_ESCAPE", format!("素材路径越界：{}", resolved.display()), false));
    }
    std::fs::read(&resolved).map_err(|error| storage_error(error.to_string()))
}

fn guess_kind(mime: &str, url: &str) -> &'static str {
    if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("audio/") {
        "audio"
    } else if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("text/") || mime.ends_with("/json") {
        "text"
    } else {
        match kind_for_url(url) {
            "video" => "video",
            "audio" => "audio",
            _ => "image",
        }
    }
}

async fn fetch_remote(client: &reqwest::Client, raw: &str) -> Result<(Vec<u8>, String), AppError> {
    let url = security::validate_remote_url(raw)?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| AppError::new("PROVIDER_NETWORK", error.to_string(), true))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new("PROVIDER_HTTP_STATUS", format!("素材下载失败：{status}"), status.is_server_error()));
    }
    // 重定向后必须再校验一次，避免 https 公网地址把请求带到私网。
    security::validate_remote_url(response.url().as_str())?;
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response.bytes().await.map_err(|error| AppError::new("PROVIDER_NETWORK", error.to_string(), true))?;
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err(AppError::new("IMPORT_TOO_LARGE", "远端素材超过 256 MB", false));
    }
    Ok((bytes.to_vec(), mime))
}

fn local_source(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if let Some(stripped) = trimmed.strip_prefix("file://") {
        return Some(PathBuf::from(percent_decode(stripped)));
    }
    if trimmed.starts_with('/') || (trimmed.len() > 2 && trimmed.as_bytes()[1] == b':') {
        return Some(PathBuf::from(trimmed));
    }
    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&input[index + 1..index + 3], 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub async fn import_document(
    state: &AppState,
    document: &Value,
    roots: &[PathBuf],
) -> Result<LegacyImportResult, AppError> {
    let project_id = format!("project_{}", uuid::Uuid::new_v4());
    let board_id = format!("board_{}", uuid::Uuid::new_v4());
    let data_dir = state.data_dir.clone();
    let client = crate::http_client().map_err(|message| AppError::new("UNAVAILABLE_HTTP", message, false))?;

    let mut asset_ids: HashMap<String, String> = HashMap::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut asset_count = 0usize;

    for source in collect_asset_sources(document) {
        let raw = source.url.as_str();
        let stored: Result<(Vec<u8>, String), AppError> = if let Some((mime, bytes)) = assets::decode_data_url(raw) {
            Ok((bytes, mime))
        } else if raw.starts_with("https://") {
            fetch_remote(&client, raw).await
        } else if let Some(path) = local_source(raw) {
            let mime = mime_guess(&path);
            resolve_local_bytes(&path, roots).map(|bytes| (bytes, mime))
        } else {
            Err(AppError::new("IMPORT_TYPE_INVALID", format!("不支持的素材地址：{raw}"), false))
        };
        match stored {
            Ok((bytes, mime)) => {
                let provenance = json!({
                    "projectId": project_id,
                    "legacy": { "source": raw }
                });
                let kind = guess_kind(&mime, raw);
                let mut asset = assets::store_bytes(&data_dir, &bytes, kind, &mime, provenance)
                    .map_err(|message| AppError::new("STORAGE_ASSET_FAILED", message, false))?;
                asset.provenance["legacy"]["sourceKind"] = json!(source.kind);
                runs::save_asset(state, &asset).map_err(|error| error)?;
                asset_ids.insert(raw.to_string(), asset.id.clone());
                asset_count += 1;
            }
            Err(error) => warnings.push(format!("素材 {} 未能导入：{}", raw, error.message)),
        }
    }

    let project = build_legacy_project(document, &project_id);
    let (board, imported_runs, mut board_warnings) = build_legacy_board(&document, &project_id, &board_id, &asset_ids);
    warnings.append(&mut board_warnings);

    let path = runs::db_path(state).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let connection = db::open(&path).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let now = chrono::Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO studio_projects (id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
            rusqlite::params![
                project_id,
                project.get("name").and_then(Value::as_str).unwrap_or("导入的旧项目"),
                serde_json::to_string(&project).map_err(|error| storage_error(error.to_string()))?,
                now
            ],
        )
        .map_err(|error| storage_error(error.to_string()))?;
    connection
        .execute(
            "INSERT INTO boards (id, project_id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
            rusqlite::params![
                board_id,
                project_id,
                board.get("name").and_then(Value::as_str).unwrap_or("导入画布"),
                serde_json::to_string(&board).map_err(|error| storage_error(error.to_string()))?,
                now
            ],
        )
        .map_err(|error| storage_error(error.to_string()))?;
    for run in &imported_runs {
        runs::save_run(state, run).map_err(|message| storage_error(message))?;
    }

    Ok(LegacyImportResult {
        project,
        board,
        asset_count,
        run_count: imported_runs.len(),
        warnings,
    })
}

fn mime_guess(path: &Path) -> String {
    match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "mp4" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "txt" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
    .to_string()
}
```

`percent_decode` 是自写的极简实现，只处理 `%XX`；旧项目里的本地路径来自应用自身写入的 `app_data`，不含查询串，够用。若你更保守，可以把 `file://` 直接拒绝——但那样旧项目里所有本地定妆照都会掉进 warning，所以保留解码。

- [ ] **Step 5: 放开必要可见性并注册命令**

1）`src-tauri/src/runs.rs`：把 `fn save_asset(` 改为 `pub(crate) fn save_asset(`。
2）`src-tauri/src/lib.rs`：Task 15 已定义 `pub(crate) fn strip_sensitive_fields(value: &mut Value)`，本 Task 直接以 `crate::strip_sensitive_fields(...)` 调用，不要复制第二份实现。
3）`src-tauri/src/lib.rs` 顶部模块声明追加 `mod import;`，命令区追加：

```rust
#[tauri::command]
async fn import_legacy_project(
    path: String,
    state: State<'_, AppState>,
) -> Result<import::LegacyImportResult, String> {
    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let owned = AppState {
        db_path: std::sync::Mutex::new(db_path),
        data_dir: data_dir.clone(),
    };
    let target = std::path::PathBuf::from(&path);
    let roots = vec![data_dir.clone(), target.parent().map(PathBuf::from).unwrap_or_else(|| data_dir.clone())];
    let document = import::read_legacy_document(&target, &roots).map_err(|error| error.message)?;
    import::import_document(&owned, &document, &roots)
        .await
        .map_err(|error| error.message)
}
```

并在 `invoke_handler(tauri::generate_handler![...])` 列表里追加 `import_legacy_project,`。

4）`src-tauri/capabilities/default.json` 的 `permissions` 里确认含 `dialog:default`（它已覆盖 `allow-open`；`tauri.conf.json` 里没有权限表，只有 `assetProtocol.scope`）。旧 App 已在用 plugin-dialog，通常无需改动，但必须实际确认，否则前端 `open()` 会被拒。

Run: `cargo test --manifest-path src-tauri/Cargo.toml import::`
Expected: PASS（10 个用例）。

- [ ] **Step 6: 写失败的前端汇总测试**

`src/import/legacy.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { summarizeImport } from './legacy';

describe('summarizeImport', () => {
  it('reports counts and truncates warnings', () => {
    const text = summarizeImport({
      project: { id: 'project_1' },
      board: { id: 'board_1' },
      assetCount: 12,
      runCount: 9,
      warnings: ['警告一', '警告二', '警告三', '警告四', '警告五', '警告六'],
    });
    expect(text).toContain('导入 12 个素材');
    expect(text).toContain('生成 9 条导入记录');
    expect(text).toContain('警告四');
    expect(text).toContain('还有 2 条');
  });

  it('says nothing went wrong when warnings are empty', () => {
    expect(summarizeImport({ project: {}, board: {}, assetCount: 0, runCount: 0, warnings: [] }))
      .toBe('没有导入任何素材：旧项目可能还没有生成结果。');
  });
});
```

- [ ] **Step 7: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL，找不到 `./legacy`。

- [ ] **Step 8: 实现前端桥与对话框**

`src/services/tauri.ts` 末尾追加：

```ts
export interface LegacyImportResult {
  project: { id: string; name?: string };
  board: { id: string; name?: string };
  assetCount: number;
  runCount: number;
  warnings: string[];
}

export async function importLegacyProject(path: string): Promise<LegacyImportResult> {
  if (!isTauri()) throw new Error('旧项目导入只能在桌面应用中运行');
  return invoke<LegacyImportResult>('import_legacy_project', { path });
}
```

`src/import/legacy.ts`：

```ts
import { open } from '@tauri-apps/plugin-dialog';
import type { LegacyImportResult } from '../services/tauri';

export async function pickLegacyFile(): Promise<string | undefined> {
  const picked = await open({
    multiple: false,
    directory: false,
    title: '选择旧项目 JSON',
    filters: [{ name: '旧项目 JSON', extensions: ['json'] }],
  });
  return typeof picked === 'string' ? picked : undefined;
}

export function summarizeImport(result: LegacyImportResult): string {
  if (!result.warnings.length) {
    if (!result.assetCount) return '没有导入任何素材：旧项目可能还没有生成结果。';
    return `导入 ${result.assetCount} 个素材，生成 ${result.runCount} 条导入记录，没有告警。`;
  }
  const head = result.warnings.slice(0, 3).join('；');
  const rest = result.warnings.length - 3;
  return `导入 ${result.assetCount} 个素材，生成 ${result.runCount} 条导入记录。告警：${head}${rest > 0 ? `（还有 ${rest} 条）` : ''}`;
}
```

`src/import/LegacyImportDialog.tsx`：

```tsx
import { useState } from 'react';
import { importLegacyProject } from '../services/tauri';
import { useStudioStore } from '../stores/studioStore';
import { pickLegacyFile, summarizeImport } from './legacy';

interface Props {
  open: boolean;
  onClose(): void;
}

export function LegacyImportDialog({ open, onClose }: Props) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  if (!open) return null;

  async function choose() {
    const picked = await pickLegacyFile();
    if (picked) {
      setPath(picked);
      setMessage('');
    }
  }

  async function run() {
    setBusy(true);
    setMessage('');
    try {
      const result = await importLegacyProject(path);
      setMessage(summarizeImport(result));
      await useStudioStore.getState().boot(true);
      await useStudioStore.getState().selectProject(result.project.id);
      const board = useStudioStore.getState().boards.find((item) => item.id === result.board.id);
      if (board) await useStudioStore.getState().selectBoard(board.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="confirm-backdrop" role="dialog" aria-modal="true" aria-label="导入旧项目">
      <div className="confirm-dialog">
        <header>
          <h2>导入旧项目</h2>
          <p className="confirm-sub">读取旧 Frameforge 项目 JSON，素材复制进本地资产库并自动生成一张画布。</p>
        </header>
        <div className="inspector-field">
          <span>项目文件</span>
          <div className="import-path">
            <input readOnly value={path} placeholder="尚未选择文件" />
            <button type="button" className="studio-button secondary" onClick={() => void choose()}>浏览…</button>
          </div>
        </div>
        <p className="inspector-note">导入的节点会被锁定（pinned），改动上游后不会自动重跑，需要手动解锁再生成。</p>
        {message && <p className="inspector-warning">{message}</p>}
        <footer className="confirm-actions">
          <button type="button" className="studio-button secondary" onClick={onClose}>关闭</button>
          <button type="button" className="studio-button" disabled={!path || busy} onClick={() => void run()}>
            {busy ? '导入中…' : '开始导入'}
          </button>
        </footer>
      </div>
    </div>
  );
}
```

`src/stores/studioStore.ts`：把接口里的 `boot(): Promise<void>;` 改为 `boot(force?: boolean): Promise<void>;`，并把实现首行

```ts
  async boot() {
    if (get().booted || get().loading) return;
```

改为

```ts
  async boot(force) {
    if (!force && (get().booted || get().loading)) return;
```

- [ ] **Step 9: 项目库入口**

`src/app/ProjectLibrary.tsx`：

1）import 区追加：

```tsx
import { useState } from 'react';
import { FileInput } from 'lucide-react';
import { LegacyImportDialog } from '../import/LegacyImportDialog';
```

（`useState` 若已存在则不重复 import。）

2）组件内追加 `const [importOpen, setImportOpen] = useState(false);`，并在「新建项目」按钮之后追加：

```tsx
<button type="button" className="studio-button secondary" onClick={() => setImportOpen(true)}>
  <FileInput size={13} /> 导入旧项目
</button>
```

3）组件 return 的最外层末尾追加 `<LegacyImportDialog open={importOpen} onClose={() => setImportOpen(false)} />`。

4）在 `src/styles/studio.css` 末尾追加：

```css
.import-path { display: flex; gap: 6px; }
.import-path input { flex: 1; min-width: 0; padding: 6px 7px; color: var(--text-muted); background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 3px; font-family: var(--font-mono); font-size: 10px; }
```

- [ ] **Step 10: 全量测试与手工验收**

Run:
```bash
pnpm test:unit
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: 全部通过。

Run: `pnpm tauri dev`
Expected:
1. 用旧版界面导出一份项目 JSON（或直接用 `src/demo.ts` 的结构手工存成 json），点「导入旧项目」→ 选择文件 → 完成后自动进入新项目与画布。
2. 画布上按行看到「角色简介 / 定妆照 / 场景 / 镜头视频 / 分镜素材」，镜头视频节点带「锁定」标记，图片与视频能直接预览。
3. 有首帧绑定的镜头是「首尾帧」模式且没有参考连线；只有角色参考的镜头是「全能参考」模式；两者皆无的是「文生视频」。Inspector 的检查项里没有 `GRAPH_*` 报错。
4. 超过 9 张参考的镜头被裁剪，导入总结里出现「超过 H3 上限」告警；旧 JSON 里 `blob:` 与缺失文件进 warning 而不是让导入整体失败。
5. 手工把 JSON 里某个 `portraitUrl` 改成 `http://localhost/x.png` 或 `/etc/passwd`：该素材报「只允许 https 远端地址」/「素材路径越界」，其余节点照常导入。
6. 导入后的项目设置里没有旧 JSON 残留的 key/credential 字段（数据库 `studio_projects.payload` 里 grep 不到 `apiKey`）。

- [ ] **Step 11: 提交**

```bash
git add src-tauri/src/import.rs src-tauri/src/lib.rs src-tauri/src/runs.rs src/import src/services/tauri.ts src/stores/studioStore.ts src/app/ProjectLibrary.tsx src/styles/studio.css
git commit -m "feat(p0): 旧 Frameforge 项目导入"
```

---

## 阶段 F — 收尾：导出、性能与 P0 验收

### Task 23: 项目导出、500 节点性能与 P0 退出验收

**Files:**
- Create: `src-tauri/src/export.rs`（含 `#[cfg(test)] mod tests`）
- Modify: `src-tauri/src/lib.rs`（`mod export;`、`export_project` 命令、注册）
- Create: `src/app/exportName.ts`
- Test: `src/app/exportName.test.ts`
- Modify: `src/services/tauri.ts`（`exportProject`、`pickExportPath`）
- Modify: `src/app/ProjectLibrary.tsx`（导出入口与结果提示）
- Test: `src/canvas/mapping.test.ts`
- Modify: `src/canvas/mapping.ts`（节点 `data` 身份缓存）
- Modify: `src/nodes/registry.tsx`（`memo` 包裹节点卡片）
- Modify: `src/canvas/CanvasView.tsx`（`onlyRenderVisibleElements` 等渲染开销）
- Modify: `src/app/StudioApp.tsx`（dock 进行中任务计数）
- Modify: `src/styles/studio.css`
- Verify: `src-tauri/capabilities/default.json`（`dialog:default` 是否覆盖 `allow-save`）

**Interfaces:**
- Consumes: `crate::strip_sensitive_fields`（Task 15 定义）、`db::open`、`AppState { db_path, data_dir }`、`assets` 表列 `id/kind/path/mime/bytes/width/height/duration`、`runs` 表的 `project_id`、`@tauri-apps/plugin-dialog` 的 `save`、`useRunStore`（`runs`）、`computeStaleSet`/`validateBoard`/`topoSort`、`makeDoc`/`node`/`edge` fixtures。
- Produces:
  - Rust：`export::build_package(connection: &Connection, project_id: &str) -> Result<Value, String>`、`export::validate_destination(dest: &Path, data_dir: &Path) -> Result<PathBuf, String>`、`export::export_project(state: &AppState, project_id: &str, dest: &Path) -> Result<ExportSummary, String>`；`ExportSummary { path, projectId, boards, runs, assets }`（camelCase）。
  - 前端：`exportProject(projectId: string, path: string): Promise<ExportSummary>`、`pickExportPath(defaultName: string): Promise<string | null>`、`safeExportName(project: { name: string; id: string }): string`。
  - `toFlowNodes(doc, stale?)` 对未变化的节点返回**同一个 `data` 对象引用**（这是 `memo` 生效的前提）。

**设计约束（不可省略）：**

1. 导出包只含元数据：不打包素材二进制、不打包 keychain 内容、不含任何绝对路径。`assetBodiesIncluded: false` 是给后续导入端的显式信号，不要删。
2. `strip_sensitive_fields` 用**精确字段名匹配**：`cacheKey` 必须原样保留，否则导出→导入后所有节点缓存全废。测试里专门断言这一点。
3. P0 的导出是「备份/取证」用途，跨机导入（素材重建、包内引用改写）留在 P2；本 Task 不实现导入导出闭环。
4. 性能改动只允许「减少无谓渲染」，不允许为了跑分砍功能（不做虚拟滚动替代 React Flow、不关小地图、不降节点分辨率）。

- [ ] **Step 1: 写失败的导出测试**

`src-tauri/src/export.rs` 先只写测试（实现留到 Step 3，此时 `cargo test` 会因模块不存在而失败）：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn seed(connection: &rusqlite::Connection) {
        connection
            .execute(
                "INSERT INTO studio_projects (id, name, payload, created_at, updated_at)
                 VALUES ('p1', '测试项目', ?1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')",
                [r#"{"id":"p1","name":"测试项目","settings":{"apiKey":"sk-leak","baseUrl":"https://relay.example/v1"}}"#],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO boards (id, project_id, name, payload, created_at, updated_at)
                 VALUES ('b1', 'p1', '主画布', ?1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')",
                [r#"{"id":"b1","projectId":"p1","name":"主画布","schemaVersion":1,"cacheKey":"board-cache-key-stays","nodes":{"n1":{"id":"n1","type":"image","data":{"selectedAssetId":"a1"}}},"edges":{},"viewport":{"x":0,"y":0,"zoom":1}}"#],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runs (id, project_id, board_id, node_id, status, cache_key, payload, created_at, updated_at)
                 VALUES ('r1', 'p1', 'b1', 'n1', 'succeeded', 'ck1', ?1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')",
                [r#"{"id":"r1","boardId":"b1","nodeId":"n1","status":"succeeded","cacheKey":"ck1","inputAssetIds":[],"outputAssetIds":["a1"],"apiKey":"sk-run-leak"}"#],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO assets (id, kind, path, mime, bytes, width, height, duration, payload, created_at)
                 VALUES ('a1', 'image', 'assets/ab/ab12.png', 'image/png', 120, 1024, 1024, NULL, '{}', '2026-10-31T00:00:00Z')",
                [],
            )
            .unwrap();
    }

    #[test]
    fn package_drops_credentials_but_keeps_cache_keys_and_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let connection = crate::db::open(&dir.path().join("db.sqlite3")).unwrap();
        seed(&connection);

        let package = build_package(&connection, "p1").unwrap();
        let raw = serde_json::to_string(&package).unwrap();

        assert!(!raw.contains("sk-leak"), "项目设置里的 apiKey 必须被剥掉");
        assert!(!raw.contains("sk-run-leak"), "运行记录里的 apiKey 必须被剥掉");
        assert!(raw.contains("board-cache-key-stays"), "cacheKey 不能被子串匹配误伤");
        assert!(!raw.contains(dir.path().to_str().unwrap()), "导出不得含本机绝对路径");
        assert_eq!(package["boards"].as_array().map(Vec::len), Some(1));
        assert_eq!(package["assets"][0]["relativePath"], serde_json::json!("assets/ab/ab12.png"));
        assert_eq!(package["assetBodiesIncluded"], serde_json::json!(false));
    }

    #[test]
    fn unknown_project_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let connection = crate::db::open(&dir.path().join("db.sqlite3")).unwrap();
        let error = build_package(&connection, "nope").unwrap_err();
        assert!(error.contains("项目不存在"), "实际错误：{error}");
    }

    #[test]
    fn destination_rejects_escape_text_and_data_dir() {
        let data_dir = tempfile::tempdir().unwrap();
        let out_dir = tempfile::tempdir().unwrap();

        let ok = validate_destination(&out_dir.path().join("包.json"), data_dir.path()).unwrap();
        assert!(ok.to_string_lossy().ends_with("包.json"));

        assert!(validate_destination(std::path::Path::new("../evil.json"), data_dir.path()).is_err());
        assert!(validate_destination(&out_dir.path().join("evil.txt"), data_dir.path()).is_err());
        assert!(validate_destination(&data_dir.path().join("inside.json"), data_dir.path()).is_err());
        assert!(validate_destination(&out_dir.path().join("nope/missing.json"), data_dir.path()).is_err());
        // 普通文件可以覆盖（保存对话框已确认），软链接不行。
        std::fs::write(&out_dir.path().join("again.json"), b"{}").unwrap();
        assert!(validate_destination(&out_dir.path().join("again.json"), data_dir.path()).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", &out_dir.path().join("link.json")).unwrap();
            assert!(validate_destination(&out_dir.path().join("link.json"), data_dir.path()).is_err());
        }
    }

    #[test]
    fn export_writes_a_parseable_file_and_counts() {
        let data_dir = tempfile::tempdir().unwrap();
        let out_dir = tempfile::tempdir().unwrap();
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(data_dir.path().join("db.sqlite3")),
            data_dir: data_dir.path().to_path_buf(),
        };
        {
            let connection = crate::db::open(&data_dir.path().join("db.sqlite3")).unwrap();
            seed(&connection);
        }

        let summary = export_project(&state, "p1", &out_dir.path().join("project.json")).unwrap();
        assert_eq!((summary.boards, summary.runs, summary.assets), (1, 1, 1));
        let text = std::fs::read_to_string(&summary.path).unwrap();
        assert!(!text.contains("sk-leak"));
        serde_json::from_str::<serde_json::Value>(&text).unwrap();
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml export::tests`
Expected: FAIL，`mod export` 不存在（`couldn't read src/export.rs`）。

- [ ] **Step 3: 实现 export.rs**

把 Step 1 的测试块保留在文件末尾，在其上方写入实现：

```rust
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

use crate::db;
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub path: String,
    pub project_id: String,
    pub boards: usize,
    pub runs: usize,
    pub assets: usize,
}

pub fn build_package(connection: &Connection, project_id: &str) -> Result<Value, String> {
    let project_text: String = connection
        .query_row(
            "SELECT payload FROM studio_projects WHERE id=?1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(|_| format!("项目不存在：{project_id}"))?;
    let mut project: Value = serde_json::from_str(&project_text).map_err(|error| error.to_string())?;
    crate::strip_sensitive_fields(&mut project);

    let mut boards: Vec<Value> = Vec::new();
    {
        let mut statement = connection
            .prepare("SELECT payload FROM boards WHERE project_id=?1 ORDER BY updated_at ASC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([project_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            let mut board: Value =
                serde_json::from_str(&row.map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            crate::strip_sensitive_fields(&mut board);
            boards.push(board);
        }
    }

    let mut runs: Vec<Value> = Vec::new();
    {
        let mut statement = connection
            .prepare("SELECT payload FROM runs WHERE project_id=?1 ORDER BY created_at ASC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([project_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            let mut run: Value =
                serde_json::from_str(&row.map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            crate::strip_sensitive_fields(&mut run);
            runs.push(run);
        }
    }

    let mut asset_ids: Vec<String> = Vec::new();
    for entry in boards.iter().chain(runs.iter()) {
        collect_referenced_assets(entry, &mut asset_ids);
    }
    let assets: Vec<Value> = asset_ids
        .iter()
        .filter_map(|id| asset_entry(connection, id))
        .collect();

    Ok(json!({
        "schemaVersion": 1,
        "packageKind": "frameforge.project",
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "project": project,
        "boards": boards,
        "runs": runs,
        "assets": assets,
        "assetBodiesIncluded": false,
    }))
}

// 导出规模是「数百资产」量级，线性去重足够；不要为它引入 IndexSet 之类新依赖。
fn push_asset_id(id: &str, sink: &mut Vec<String>) {
    if id.is_empty() || sink.iter().any(|existing| existing == id) {
        return;
    }
    sink.push(id.to_string());
}

fn collect_referenced_assets(value: &Value, sink: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(id) = map.get("selectedAssetId").and_then(Value::as_str) {
                push_asset_id(id, sink);
            }
            for key in ["inputAssetIds", "outputAssetIds"] {
                if let Some(ids) = map.get(key).and_then(Value::as_array) {
                    for id in ids.iter().filter_map(Value::as_str) {
                        push_asset_id(id, sink);
                    }
                }
            }
            for nested in map.values() {
                collect_referenced_assets(nested, sink);
            }
        }
        Value::Array(items) => {
            for nested in items {
                collect_referenced_assets(nested, sink);
            }
        }
        _ => {}
    }
}

fn asset_entry(connection: &Connection, id: &str) -> Option<Value> {
    connection
        .query_row(
            "SELECT id, kind, path, mime, bytes, width, height, duration FROM assets WHERE id=?1",
            [id],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0).unwrap_or_default(),
                    "kind": row.get::<_, String>(1).unwrap_or_default(),
                    "relativePath": row.get::<_, String>(2).unwrap_or_default(),
                    "mime": row.get::<_, String>(3).unwrap_or_default(),
                    "bytes": row.get::<_, i64>(4).unwrap_or_default(),
                    "width": row.get::<_, Option<i64>>(5).unwrap_or(None),
                    "height": row.get::<_, Option<i64>>(6).unwrap_or(None),
                    "duration": row.get::<_, Option<f64>>(7).unwrap_or(None),
                }))
            },
        )
        .ok()
}

pub fn validate_destination(dest: &Path, data_dir: &Path) -> Result<PathBuf, String> {
    if dest.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("导出路径不合法".to_string());
    }
    if dest.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("导出文件必须以 .json 结尾".to_string());
    }
    let file_name = dest.file_name().ok_or_else(|| "导出路径缺少文件名".to_string())?;
    let parent = dest
        .parent()
        .ok_or_else(|| "导出路径缺少目录".to_string())?
        .canonicalize()
        .map_err(|_| "导出目录不存在".to_string())?;
    let resolved = parent.join(file_name);
    let data_root = data_dir.canonicalize().map_err(|error| error.to_string())?;
    if resolved.starts_with(&data_root) {
        return Err("不能导出到应用数据目录内".to_string());
    }
    if resolved.symlink_metadata().is_ok() {
        let metadata = resolved.symlink_metadata().map_err(|error| error.to_string())?;
        // 覆盖本身交给保存对话框确认；这里只挡住软链接和目录，避免把导出重定向到别处。
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("导出目标已存在且不是普通文件，已拒绝".to_string());
        }
    }
    Ok(resolved)
}

pub fn export_project(state: &AppState, project_id: &str, dest: &Path) -> Result<ExportSummary, String> {
    let db_path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let package = {
        let connection = db::open(&db_path)?;
        build_package(&connection, project_id)?
    };
    let resolved = validate_destination(dest, &state.data_dir)?;
    let raw = serde_json::to_string_pretty(&package).map_err(|error| error.to_string())?;
    std::fs::write(&resolved, raw.as_bytes()).map_err(|error| error.to_string())?;

    let count = |key: &str| {
        package
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default()
    };
    Ok(ExportSummary {
        path: resolved.to_string_lossy().to_string(),
        project_id: project_id.to_string(),
        boards: count("boards"),
        runs: count("runs"),
        assets: count("assets"),
    })
}
```

`validate_destination` 允许覆盖普通文件（保存对话框已经让用户确认过一次），但挡住软链接与目录：软链接会把「导出到某路径」变成写到路径背后的文件，属于路径逃逸的变体。测试 `destination_rejects_escape_text_and_data_dir` 里用 `/etc/passwd` 软链接把这个行为钉住。

- [ ] **Step 4: 注册命令**

`src-tauri/src/lib.rs`：顶部模块声明追加 `mod export;`（与 `mod import;` 放一起，保持字母序）。命令区追加（同步命令，直接借用 `State`，不需要 Task 22 那种克隆 `AppState` 的写法）：

```rust
#[tauri::command]
fn export_project(project_id: String, path: String, state: State<'_, AppState>) -> Result<export::ExportSummary, String> {
    export::export_project(&state, &project_id, std::path::Path::new(&path))
}
```

并在 `invoke_handler(tauri::generate_handler![...])` 里追加 `export_project,`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml export::tests`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 确认对话框权限**

`src-tauri/capabilities/default.json`（注意：权限在这里，不在 `tauri.conf.json`）当前是：

```json
"permissions": ["core:default", "dialog:default", "opener:default"]
```

`dialog:default` 已含 `allow-save`（以及 Task 22 需要的 `allow-open`），因此这里预期不需要改动，只是确认；若权限表被改窄过，只补 `dialog:allow-save`。

- [ ] **Step 6: 前端桥与文件名纯函数（先写失败测试）**

`src/app/exportName.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { safeExportName } from './exportName';

describe('safeExportName', () => {
  it('replaces reserved characters and appends the id tail', () => {
    expect(safeExportName({ name: '雨夜/追凶:第一集', id: 'project_abc123' })).toBe('雨夜_追凶_第一集-abc123.json');
  });

  it('falls back when the project name has nothing usable', () => {
    expect(safeExportName({ name: '   ', id: 'project_zzz999' })).toBe('frameforge-project-zzz999.json');
  });

  it('caps the length so long names stay writable', () => {
    const long = safeExportName({ name: 'x'.repeat(200), id: 'project_111111' });
    expect(long.length).toBeLessThanOrEqual(70);
  });
});
```

Run: `pnpm test:unit -- src/app/exportName`
Expected: FAIL，找不到 `./exportName`。

`src/app/exportName.ts`：

```ts
const RESERVED = /[\\/:*?"<>|]/g;

export function safeExportName(project: { name: string; id: string }): string {
  const cleaned = project.name
    .replace(RESERVED, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48)
    .replace(/^_+|_+$/g, '');
  return `${cleaned || 'frameforge-project'}-${project.id.slice(-6)}.json`;
}
```

`src/services/tauri.ts` 末尾追加（`save` 用动态 import，保持与非 Tauri 环境一致的懒加载）：

```ts
export interface ExportSummary {
  path: string;
  projectId: string;
  boards: number;
  runs: number;
  assets: number;
}

export async function exportProject(projectId: string, path: string): Promise<ExportSummary> {
  if (!isTauri()) throw new Error('导出只能在桌面应用中运行');
  return invoke<ExportSummary>('export_project', { projectId, path });
}

export async function pickExportPath(defaultName: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({
    defaultPath: defaultName,
    filters: [{ name: 'Frameforge 项目', extensions: ['json'] }],
  });
}
```

Run: `pnpm test:unit -- src/app/exportName`
Expected: PASS（3 tests）。

- [ ] **Step 7: 项目库导出入口**

`src/app/ProjectLibrary.tsx` 四处改动。

1）import 区追加：

```tsx
import { Download } from 'lucide-react';
import { exportProject, pickExportPath } from '../services/tauri';
import { safeExportName } from './exportName';
```

2）组件内追加状态与函数（放在 `submitBoard` 之后）：

```tsx
  const [notice, setNotice] = useState('');

  async function exportCurrent() {
    if (!current || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const target = await pickExportPath(safeExportName(current));
      if (!target) return;
      const summary = await exportProject(current.id, target);
      setNotice(`已导出 ${summary.boards} 张画布 / ${summary.runs} 次运行 / ${summary.assets} 个资产索引；包内不含密钥与素材文件本体。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
```

3）把 `studio-library-head` 里的

```tsx
        <span className="studio-badge mint">项目 {current.id.slice(-6)}</span>
```

替换为：

```tsx
        <div className="studio-library-actions">
          <span className="studio-badge mint">项目 {current.id.slice(-6)}</span>
          <button type="button" className="studio-button secondary" disabled={busy} onClick={() => { void exportCurrent(); }}>
            <Download size={13} /> 导出项目
          </button>
        </div>
```

并在 `</form>`（新建画布表单）之后、`</div>` 之前追加：

```tsx
      {notice && <p className="studio-notice">{notice}</p>}
```

4）`src/styles/studio.css` 末尾追加：

```css
.studio-library-actions { display: flex; align-items: center; gap: 10px; }
.studio-notice { margin: 14px 0 0; color: var(--text-muted); font-size: 11px; line-height: 1.6; }
.studio-dock .busy { color: #f0d58d; }
```

- [ ] **Step 8: 写失败的映射测试**

`src/canvas/mapping.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../domain/types';
import { computeStaleSet } from '../domain/graph/stale';
import type { CacheContext } from '../domain/graph/cacheKey';
import { edge, makeDoc, node } from '../domain/graph/testFixtures';
import { topoSort } from '../domain/graph/topo';
import { validateBoard } from '../domain/graph/validate';
import { toFlowNodes } from './mapping';

function run(nodeId: string, id: string): RunRecord {
  return {
    id, projectId: 'project_test', boardId: 'board_test', nodeId,
    action: 'generate', cacheKey: 'stale-on-purpose', status: 'succeeded',
    promptSnapshot: { text: '', segments: [], hash: 'h', locked: false },
    params: {}, inputAssetIds: [], outputAssetIds: ['asset_1'], selectedAssetId: 'asset_1',
    startedAt: '2026-10-31T00:00:00.000Z',
  };
}

function wideBoard(count: number) {
  const nodes = Array.from({ length: count }, (_, index) => {
    const type = index % 3 === 0 ? 'text' : index % 3 === 1 ? 'image' : 'video';
    const col = Math.floor(index / 25);
    return { ...node(`n${index}`, type, { prompt: `提示 ${index}` }), position: { x: col * 320, y: (index % 25) * 220 } };
  });
  const links = nodes.slice(1).map((item, index) => edge(`e${index}`, `n${index}`, item.id));
  const doc = makeDoc(nodes, links);
  const ctx: CacheContext = {
    runs: nodes.map((item, index) => run(item.id, `run_${index}`)),
    runtime: Object.fromEntries(nodes.map((item) => [item.id, { providerId: 'openai-compatible', model: 'm', params: {} }])),
    promptHashes: Object.fromEntries(nodes.map((item) => [item.id, `hash-${item.id}`])),
  };
  return { doc, ctx };
}

describe('toFlowNodes', () => {
  it('reuses the same data object for unchanged nodes', () => {
    const { doc } = wideBoard(3);
    const first = toFlowNodes(doc);
    const second = toFlowNodes(doc);
    expect(second[0].data).toBe(first[0].data);
  });

  it('only replaces the data object of nodes whose stale flag changed', () => {
    const { doc } = wideBoard(3);
    const before = toFlowNodes(doc, new Set());
    const after = toFlowNodes(doc, new Set(['n1']));
    expect(after[0].data).toBe(before[0].data);
    expect(after[1].data).not.toBe(before[1].data);
    expect(after[1].data.stale).toBe(true);
    expect(after[1].data.domain).toBe(before[1].data.domain);
  });

  it('maps a 500 node board inside the regression budget', () => {
    const { doc, ctx } = wideBoard(500);
    const started = performance.now();
    const order = topoSort(doc);
    const issues = validateBoard(doc, { providers: [] });
    const stale = computeStaleSet(doc, ctx, new Set());
    const flow = toFlowNodes(doc, stale);
    const elapsed = performance.now() - started;

    expect(order.order).toHaveLength(500);
    expect(flow).toHaveLength(500);
    expect(stale.size).toBe(500);
    expect(Array.isArray(issues)).toBe(true);
    // 这是「别再退化成 O(n²)」的绊线，不是性能基准；真机手感在 Step 12 手工验收。
    expect(elapsed).toBeLessThan(1500);
  });
});
```

Run: `pnpm test:unit -- src/canvas/mapping`
Expected: 前两个用例 FAIL（每次调用都新建 `data`，`toBe` 身份断言不成立）；第三个用例 PASS（规模本身不是问题，身份才是）。

- [ ] **Step 9: 实现 data 身份缓存**

`src/canvas/mapping.ts` 里，把 Task 21 后的 `toFlowNodes` 头部改成走缓存工厂。领域节点是不可变的（`applyGraphCommand` 对被改的节点新建对象），所以用节点对象本身作 `WeakMap` 键是安全的：未改动的节点保持引用，改动过的节点自然换键。

```ts
const dataCache = new WeakMap<BoardNode, { stale: boolean; data: StudioNodeData }>();

function nodeData(node: BoardNode, stale: boolean): StudioNodeData {
  const cached = dataCache.get(node);
  if (cached && cached.stale === stale) return cached.data;
  const data: StudioNodeData = { domain: node, stale };
  dataCache.set(node, { stale, data });
  return data;
}

export function toFlowNodes(doc: BoardDoc, stale?: Set<string>): Node<StudioNodeData>[] {
  return Object.values(doc.nodes)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: nodeData(node, stale?.has(node.id) ?? false),
      parentId: node.parentId,
      extent: node.parentId ? 'parent' as const : undefined,
      zIndex: node.z,
      style: node.size ? { width: node.size.width, height: node.size.height } : undefined,
      draggable: true,
```

只替换 `data:` 这一行为 `data: nodeData(node, stale?.has(node.id) ?? false),`，其余字段（`draggable` 之后的部分）保持 Task 21 的现状不动。

Run: `pnpm test:unit -- src/canvas/mapping`
Expected: PASS（3 tests）。

- [ ] **Step 10: 收敛 React Flow 渲染开销**

`src/nodes/registry.tsx`（注意扩展名是 `.tsx`，文件里只有这一个导出）：

```tsx
import { memo } from 'react';
import type { NodeTypes } from '@xyflow/react';
import { NodeCard } from './NodeCard';

const MemoNodeCard = memo(NodeCard);

export const nodeTypes: NodeTypes = {
  text: MemoNodeCard, image: MemoNodeCard, video: MemoNodeCard,
  audio: MemoNodeCard, script: MemoNodeCard, note: MemoNodeCard, group: MemoNodeCard,
};
```

若 `NodeTypes` 对 `memo` 的返回类型报不兼容，在 `nodeTypes` 声明末尾用一次 `as unknown as NodeTypes` 收敛（一次即可，不要逐个节点类型 cast）。

`src/canvas/CanvasView.tsx` 的 `<ReactFlow ...>` 属性区：把 `minZoom={0.2}` 改为 `minZoom={0.12}`（500 节点时能缩到能看清全板），并追加一项：

```tsx
        elevateNodesOnSelect={false}
```

`onlyRenderVisibleElements`、`selectionOnDrag`、`panOnScroll`、`maxZoom={2.5}`、`fitView={false}`、`deleteKeyCode={null}` 是 Task 17/18 已有的，不要重复添加也不要删除；`<MiniMap>`、`<Background>`、`<Controls>` 一律保持不变——小地图和背景是产品要求，不为性能砍掉。

本 Task 的性能收益主要来自前两步：`memo` 掉的节点卡片（Step 10）与稳定的 `data` 身份（Step 9），它们让「改一个节点」不再触发整板重渲染。

- [ ] **Step 11: 重启后的进行中任务可见**

`src/app/StudioApp.tsx`：

1）import 追加：

```tsx
import { useRunStore } from '../stores/runStore';
```

2）组件内已有 hooks 之后追加（selector 返回数字，天然按值比较，不会引起额外重渲染）：

```tsx
  const activeRuns = useRunStore((state) =>
    Object.values(state.runs).filter((item) => item.status === 'queued' || item.status === 'running').length,
  );
```

3）`<footer className="studio-dock">` 内，在 `{error && <span className="error">{error}</span>}` 之前插入：

```tsx
        {activeRuns > 0 && <span className="busy">{activeRuns} 个任务进行中</span>}
```

前端不调用 `resume_jobs`：Rust 在 `setup` 里已经恢复过轮询（Task 14），`selectBoard` → `listRuns` 会把 `queued/running` 的运行读回来，这里只是把它显示出来。

- [ ] **Step 12: 全量测试、构建与 P0 退出验收**

Run:
```bash
pnpm test:unit
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: 全部通过，构建无错。

Run: `pnpm tauri dev`

对照 spec 17.1 的四条退出标准逐条打勾（每条都要写实际观察结果，不能凭代码推断）：

1. **新建 → 运行 → 候选 → 保存 → 重启恢复**
   新建项目「验收」→ 加文本节点写提示词 → 运行 → 加图片节点连过去 → 运行 → 在候选里选第 2 张 → 顶栏「已保存」→ `Cmd+Q` 退出 → 重新 `pnpm tauri dev`：项目/画布/两个节点/已选候选全部还在。
2. **关窗不丢未完成视频任务**
   视频节点跑一个 15 秒 H3 任务，任务进行中直接关窗；重开后 dock 显示「1 个任务进行中」，节点角标从「排队中」走到「生成中」，最终视频落库可播放。等待期间不要在前端触发任何 `resume_jobs`。
3. **项目导出不含 Key**
   设置里存好真实 Key → 项目库「导出项目」→ 选路径 → 看摘要文案；然后：
   ```bash
   grep -Eio '"(api[_]?key|secret[_]?key|access[_]?key|token|password)"' 验收-*.json
   grep -c 'sk-' 验收-*.json
   ```
   Expected: 第一条无输出，第二条为 `0`。再用 `grep -o 'cacheKey' 验收-*.json | wc -l` 确认 `cacheKey` 仍在（导出后缓存语义没被破坏）。
   再导出到同一个文件名 → 覆盖成功且文件仍是合法 JSON；把某个 `link.json` 软链接指向 `~/Downloads` 里的别的文件后导出到它 → 被拒绝（「导出目标已存在且不是普通文件」）。
4. **500 节点可平移缩放**
   打开一张空画布，在 DevTools 控制台执行（Vite dev 下模块可用源码路径直接 import）：

   ```js
   const { useBoardStore } = await import('/src/stores/boardStore.ts');
   const { createNode } = await import('/src/domain/nodes/definitions.ts');
   const nodes = Array.from({ length: 500 }, (_, i) => ({
     ...createNode('note', { x: (i % 25) * 320, y: Math.floor(i / 25) * 240 }, { text: `压测便签 ${i}` }),
     id: `perf_${i}`,
   }));
   useBoardStore.getState().apply({ type: 'addNodes', nodes });
   ```

   预期：500 个便签铺成 20 行；顶栏计数与 dock 的 `500 nodes` 一致；拖拽平移与滚轮缩放跟手，DevTools Performance 录一次平移没有 > 200ms 的长任务；`<MiniMap>` 仍显示整板 500 个节点的缩略，而不是只有当前可视区（`onlyRenderVisibleElements` 是 Task 17 就开着的，这里只是确认它与 MiniMap 在本版本下不冲突）。
   验证完把这批临时节点撤销干净（`Cmd+Z` 或 `useBoardStore.getState().apply({ type: 'removeNode', nodeId })`），别把它们提交进任何 fixture。
   若小地图只剩可视节点：停下用 systematic-debugging 定位（先确认 React Flow 版本行为，再决定是保留开关并换 MiniMap 实现，还是走分级渲染），不要用「直接关掉这个开关」交差。

另外三条 P0 期间容易被漏掉的检查：

5. 图片节点接入参考图 → 能力变「图片编辑」，运行前确认框文案随参数变化（Task 21 的延续，导出/导入没把它带偏）。
6. 上游文本改动 → 下游图片/视频出现「结果已过期」，且**没有**任何自动运行；锁定的节点不标过期。
7. 未配置任何 Provider Key 时点运行 → 只出现拦截提示，`list_runs` 无新记录（花钱前就失败）。

- [ ] **Step 13: 提交**

```bash
git add src-tauri/src/export.rs src-tauri/src/lib.rs src/app src/services/tauri.ts src/canvas src/nodes/registry.ts src/styles/studio.css src-tauri/capabilities/default.json
git commit -m "feat(p0): 项目导出、画布性能与 P0 验收"
```

---
