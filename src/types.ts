export type ApprovalStatus = 'draft' | 'review' | 'approved';
export type JobStatus = 'queued' | 'preparing' | 'generating' | 'polling' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type AspectRatio = '16:9' | '9:16';
export type AssetKind = 'image' | 'video' | 'audio';
export type StoryboardRole = 'storyboard' | 'clean';
export type ReferenceRole = 'storyboard' | 'clean' | 'character' | 'scene' | 'prop' | 'start' | 'end' | 'middle';
export type QcStatus = 'not-run' | 'processing' | 'ready' | 'approved' | 'rejected' | 'failed';

export interface SourceDocument { id: string; name: string; format: 'txt' | 'md' | 'docx'; importedAt: string; body: string; }
export interface Chapter { id: string; number: number; title: string; summary: string; content?: string; wordCount: number; selected: boolean; }
export interface StyleGuide { genre: string; visualStyle: string; colorLanguage: string; cameraLanguage: string; era: string; constraints: string; negativeConstraints: string; }
export interface AppearanceVariant { id: string; label: string; storyRange: string; description: string; status: ApprovalStatus; }
export interface Character { id: string; name: string; role: string; bio: string; portraitUrl: string; status: ApprovalStatus; referenceIds: string[]; variants: AppearanceVariant[]; activeVariantId?: string; }
export interface Scene { id: string; heading: string; action: string; dialogue: string; emotionalBeat: string; hook: string; status: ApprovalStatus; }
export interface Episode { id: string; number: number; title: string; chapterIds: string[]; synopsis: string; sceneId?: string; status: ApprovalStatus; }
export interface Shot { id: string; sceneId: string; number: number; duration: number; framing: string; cameraMotion?: string; action: string; characters: string[]; audioCue: string; aspectRatio: AspectRatio; status: ApprovalStatus; archived?: boolean; }
export interface PromptRevision { id: string; assetId: string; text: string; negativeText: string; styleGuideId: string; characterVariantIds: string[]; createdAt: string; }
export interface CandidateAsset { id: string; jobId: string; kind: AssetKind; label: string; url: string; promptId: string; provider: string; model: string; createdAt: string; selected: boolean; metadata: Record<string, string | number | boolean>; }
export interface StoryboardAsset { id: string; shotId: string; role: StoryboardRole; sourceAssetId?: string; url: string; version: number; selected: boolean; createdAt: string; }
export interface ReferenceBinding { id: string; shotId: string; slot: number; role: ReferenceRole; assetId?: string; sourceUrl: string; label: string; locked: boolean; }
export interface MediaQcReport { id: string; assetId: string; status: QcStatus; duration?: number; width?: number; height?: number; hasAudio?: boolean; frameCount?: number; contactSheetUrl?: string; warnings: string[]; errors: string[]; checkedAt?: string; }
export interface GenerationJob { id: string; kind: AssetKind; title: string; provider: string; model: string; status: JobStatus; progress: number; candidateCount: number; createdAt: string; error?: string; }
export interface AudioTrack { id: string; kind: 'dialogue' | 'music' | 'sfx' | 'subtitle'; label: string; duration: number; enabled: boolean; sourceUrl?: string; start?: number; volume?: number; episodeId?: string; sceneId?: string; }
export interface SubtitleCue { id: string; text: string; start: number; end: number; episodeId?: string; sceneId?: string; }
export interface TimelineClip { id: string; shotId: string; enabled: boolean; duration: number; }
export interface ReviewBatch { id: string; number: number; shotIds: string[]; status: 'draft' | 'previewed' | 'approved'; previewPath?: string; updatedAt: string; }
export interface ProjectExport { id: string; path: string; thumbnailPath?: string; format: 'mp4'; kind?: 'final' | 'batch-preview'; aspectRatio: AspectRatio; clipCount: number; duration: number; createdAt: string; }
export interface Project { id: string; name: string; logline: string; aspectRatio: AspectRatio; source?: SourceDocument; chapters: Chapter[]; episodes?: Episode[]; styleGuide: StyleGuide; characters: Character[]; scenes: Scene[]; shots: Shot[]; timeline?: TimelineClip[]; prompts: PromptRevision[]; candidates: CandidateAsset[]; storyboards?: StoryboardAsset[]; referenceBindings?: ReferenceBinding[]; qcReports?: MediaQcReport[]; reviewBatches?: ReviewBatch[]; jobs: GenerationJob[]; audioTracks: AudioTrack[]; subtitles?: SubtitleCue[]; exports?: ProjectExport[]; }

export interface ProviderCapabilities { text: boolean; image: boolean; video: boolean; voice: boolean; music: boolean; soundEffect: boolean; referenceImages: boolean; supportedRatios: AspectRatio[]; maxCandidates: number; }
export interface ProviderProfile { id: string; name: string; model: string; mode: 'ready' | 'configure'; capabilities: ProviderCapabilities; }

export const stageNames = ['故事', '角色', '分镜', '素材', '合成', '画布'] as const;
export type Stage = typeof stageNames[number];
