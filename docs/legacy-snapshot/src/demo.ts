import type { Project, ProviderProfile } from './types';

const portraitA = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=720&q=86';
const portraitB = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=720&q=86';
const scene1 = 'https://images.unsplash.com/photo-1514565131-fce0801e5785?auto=format&fit=crop&w=1000&q=86';
const scene2 = 'https://images.unsplash.com/photo-1500375592092-40eb2168fd21?auto=format&fit=crop&w=1000&q=86';
const scene3 = 'https://images.unsplash.com/photo-1513836279014-a89f7a76ae86?auto=format&fit=crop&w=1000&q=86';
const scene4 = 'https://images.unsplash.com/photo-1500534623283-312aade485b7?auto=format&fit=crop&w=1000&q=86';

export const providers: ProviderProfile[] = [
  { id: 'gpt-image', name: 'OpenAI 文本/图像', model: 'gpt-image-2', mode: 'ready', capabilities: { text: true, image: true, video: false, voice: false, music: false, soundEffect: false, referenceImages: true, supportedRatios: ['16:9', '9:16'], maxCandidates: 4, asyncTasks: false, firstLastFrames: false, nativeAudio: false } },
  { id: 'openai-voice', name: 'OpenAI 配音', model: 'gpt-4o-mini-tts', mode: 'configure', capabilities: { text: false, image: false, video: false, voice: true, music: false, soundEffect: false, referenceImages: false, supportedRatios: [], maxCandidates: 1, asyncTasks: false, firstLastFrames: false, nativeAudio: false } },
  { id: 'bytedance-video', name: '字节视频', model: 'Seedance', mode: 'configure', capabilities: { text: false, image: false, video: true, voice: false, music: false, soundEffect: false, referenceImages: true, supportedRatios: ['16:9', '9:16'], maxCandidates: 4, asyncTasks: true, firstLastFrames: true, nativeAudio: true } },
  { id: 'grok-video', name: 'Grok Video', model: 'grok-imagine-video', mode: 'configure', capabilities: { text: false, image: false, video: true, voice: false, music: false, soundEffect: false, referenceImages: true, supportedRatios: ['16:9', '9:16'], maxCandidates: 4, asyncTasks: true, firstLastFrames: false, nativeAudio: false } },
  { id: 'gemini-video', name: 'Gemini / Veo', model: 'veo-3.1-generate-preview', mode: 'configure', capabilities: { text: false, image: false, video: true, voice: false, music: false, soundEffect: false, referenceImages: true, supportedRatios: ['16:9', '9:16'], maxCandidates: 4, asyncTasks: true, firstLastFrames: true, nativeAudio: true } },
];

export const demoProject: Project = {
  id: 'proj_demo', name: '雾港来信', logline: '失忆的女摄影师回到海港小镇，在一卷未冲洗的胶片里发现自己失踪的真相。', aspectRatio: '9:16',
  source: { id: 'src_1', name: '雾港来信_原著.md', format: 'md', importedAt: '2026-07-26', body: '第一章 潮汐退去...' },
  chapters: [
    { id: 'ch_1', number: 1, title: '潮汐退去', summary: '苏晚回到雾港，在旧暗房发现写有自己名字的胶卷。', wordCount: 3480, selected: true },
    { id: 'ch_2', number: 2, title: '没有寄出的信', summary: '她追查寄信人，与警长周沉发生第一次冲突。', wordCount: 4120, selected: true },
    { id: 'ch_3', number: 3, title: '暗房里的影子', summary: '胶片出现陌生男人，苏晚想起事故当晚的一段记忆。', wordCount: 3890, selected: false },
  ],
  styleGuide: { genre: '悬疑情感短剧', visualStyle: '电影感写实，细腻颗粒', colorLanguage: '冷青海雾 / 暖琥珀室内', cameraLanguage: '手持近景、慢推镜、压迫性留白', era: '当代沿海小镇', constraints: '人物五官稳定，服装符合剧情阶段，竖屏主体居中安全区', negativeConstraints: '卡通感、畸形手指、文字水印、过曝皮肤' },
  characters: [
    { id: 'char_suwan', name: '苏晚', role: '女主角', bio: '28 岁摄影师。克制、敏锐，失忆后仍对真相有近乎偏执的执念。', portraitUrl: portraitA, status: 'approved', referenceIds: ['asset_ref_suwan'], variants: [{ id: 'look_suwan_1', label: '归港', storyRange: '第 1-2 集', description: '深灰风衣、微湿黑发、疲惫的浅色妆容', status: 'approved' }, { id: 'look_suwan_2', label: '旧伤', storyRange: '第 3 集', description: '风衣沾雨、左额轻微擦伤', status: 'draft' }] },
    { id: 'char_zhoucheng', name: '周沉', role: '男主角', bio: '32 岁小镇警长。表面疏离，暗中保护苏晚。', portraitUrl: portraitB, status: 'review', referenceIds: ['asset_ref_zhoucheng'], variants: [{ id: 'look_zhou_1', label: '值夜', storyRange: '第 1-2 集', description: '藏蓝夹克、旧银色腕表、夜班倦意', status: 'approved' }] },
  ],
  scenes: [{ id: 'scene_1', heading: '外景 / 雾港码头 / 傍晚', action: '苏晚拖着行李穿过潮湿的木栈道，手机收到一张来自未知号码的暗房照片。', dialogue: '苏晚（低声）：这张照片，谁拍的？', emotionalBeat: '不安被唤醒', hook: '照片中，她正站在身后的暗房门前。', status: 'approved' }],
  shots: [{ id: 'shot_1', sceneId: 'scene_1', number: 1, duration: 3, framing: '低机位跟拍 / 中近景', cameraMotion: '缓慢跟随，最后轻推到暗房门', action: '苏晚走向暗房，风吹起风衣下摆。', characters: ['char_suwan'], audioCue: '海浪 + 低频悬疑音乐', aspectRatio: '9:16', status: 'approved' }, { id: 'shot_2', sceneId: 'scene_1', number: 2, duration: 2, framing: '手部特写', cameraMotion: '静止镜头，保持屏幕居中', action: '手机屏幕亮起，未知照片加载完成。', characters: ['char_suwan'], audioCue: '手机震动 + 音乐停顿', aspectRatio: '9:16', status: 'review' }],
  prompts: [{ id: 'prompt_1', assetId: 'shot_1', text: 'Cinematic vertical shot of Su Wan walking through a foggy coastal pier at dusk, wet wooden pier, charcoal trench coat, realistic Chinese woman, cold teal sea mist, warm amber dock lights, shallow depth of field, subtle film grain.', negativeText: 'cartoon, watermark, text, distorted hands', styleGuideId: 'style_1', characterVariantIds: ['look_suwan_1'], createdAt: '2026-07-26T10:22:00Z' }],
  candidates: [
    { id: 'asset_1', jobId: 'job_1', kind: 'image', label: '候选 01', url: scene1, promptId: 'prompt_1', provider: 'GPT Image', model: 'gpt-image-2', createdAt: '2026-07-26T10:23:00Z', selected: true, metadata: { ratio: '9:16', reference: true, seed: 82193 } },
    { id: 'asset_2', jobId: 'job_1', kind: 'image', label: '候选 02', url: scene2, promptId: 'prompt_1', provider: 'GPT Image', model: 'gpt-image-2', createdAt: '2026-07-26T10:23:00Z', selected: false, metadata: { ratio: '9:16', reference: true, seed: 12734 } },
    { id: 'asset_3', jobId: 'job_1', kind: 'image', label: '候选 03', url: scene3, promptId: 'prompt_1', provider: 'GPT Image', model: 'gpt-image-2', createdAt: '2026-07-26T10:23:00Z', selected: false, metadata: { ratio: '9:16', reference: true, seed: 60456 } },
    { id: 'asset_4', jobId: 'job_1', kind: 'image', label: '候选 04', url: scene4, promptId: 'prompt_1', provider: 'GPT Image', model: 'gpt-image-2', createdAt: '2026-07-26T10:23:00Z', selected: false, metadata: { ratio: '9:16', reference: true, seed: 34019 } },
  ],
  jobs: [{ id: 'job_1', kind: 'image', title: '镜头 01 · 起始帧', provider: 'GPT Image', model: 'gpt-image-2', status: 'succeeded', progress: 100, candidateCount: 4, createdAt: '2026-07-26T10:22:00Z' }],
  audioTracks: [{ id: 'aud_1', kind: 'dialogue', label: '苏晚 · 台词草配', duration: 2.8, enabled: true }, { id: 'aud_2', kind: 'music', label: '雾港主题 · 低频版', duration: 15, enabled: true }, { id: 'aud_3', kind: 'subtitle', label: '简体中文字幕', duration: 15, enabled: true }],
};
