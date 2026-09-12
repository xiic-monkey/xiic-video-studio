import { useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  ArrowDown, ArrowUp, ArrowUpRight, BookOpenText, Captions, Check, ChevronDown, ChevronRight, Clapperboard,
  Clock3, Copy, Download, FileText, Film, FolderOpen, Gauge, ImagePlus, Layers3, Menu, MoreHorizontal,
  Mic2, Music2, PanelLeftClose, Play, Plus, RotateCcw, ScanFace, Settings2, SlidersHorizontal,
  Sparkles, Upload, Video, Volume2, WandSparkles, X, Workflow, ZoomIn, ZoomOut, Maximize2,
  RefreshCw, AlertTriangle, Eye, EyeOff, RotateCw,
} from 'lucide-react';
import { demoProject, providers } from './demo';
import { appendGenerationTaskId, cancelVideoGeneration, enqueueGenerationJob, exportFinalCut, exportProjectPackage, generateGptImage, generateSpeech, generateText, importProjectPackage, listGenerationJobs, listProjects, listProviderSettings, loadCurrentProjectId, loadProject, loadProviderCredential, pollVideoGeneration, runMediaQc, saveCurrentProjectId, saveProject, saveProviderCredential, saveProviderSettings, storeAudioAsset, storeMediaAsset, submitVideoGeneration, updateGenerationJobStatus } from './bridge';
import type { DurableGenerationJob } from './bridge';
import { importStoryFile } from './story';
import type { ApprovalStatus, AudioTrack, CandidateAsset, Character, MediaQcReport, Project, ProviderProfile, QcStatus, ReferenceBinding, Stage, SubtitleCue, TimelineClip } from './types';

type ModelConnection = { baseUrl: string; apiKey: string; model: string; textModel?: string; voice?: string };
type ProviderConnections = Record<string, ModelConnection>;
type FinalCutExportOptions = { kind?: 'final' | 'batch-preview'; coverDuration?: number; endCardDuration?: number };

function mediaDisplayUrl(source: string) {
  if (!source || /^(https?:|data:|blob:|asset:)/.test(source)) return source;
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) return convertFileSrc(source);
  return source;
}

function mediaProviderSource(asset: CandidateAsset) {
  const sourceUrl = asset.metadata.sourceUrl;
  return typeof sourceUrl === 'string' && sourceUrl ? sourceUrl : asset.url;
}

const stageMeta: { id: Stage; icon: typeof BookOpenText; caption: string }[] = [
  { id: '故事', icon: BookOpenText, caption: '改编与剧本' },
  { id: '角色', icon: ScanFace, caption: '人物与造型' },
  { id: '分镜', icon: Clapperboard, caption: '镜头规划' },
  { id: '素材', icon: ImagePlus, caption: '抽卡与生成' },
  { id: '合成', icon: Film, caption: '声音与成片' },
  { id: '画布', icon: Workflow, caption: '连线工作流' },
];

function Status({ value }: { value: ApprovalStatus }) {
  const label = value === 'approved' ? '已确认' : value === 'review' ? '待审核' : '草稿';
  return <span className={`status status-${value}`}>{value === 'approved' && <Check size={12} />}{label}</span>;
}

function IconButton({ label, children, onClick, active = false }: { label: string; children: React.ReactNode; onClick?: () => void; active?: boolean }) {
  return <button className={`icon-button ${active ? 'is-active' : ''}`} onClick={onClick} aria-label={label} title={label}>{children}</button>;
}

function orderShots(project: Project) {
  const episodeOrder = new Map((project.episodes ?? []).map((episode, index) => [episode.sceneId, { number: episode.number, index }]));
  const sceneOrder = new Map(project.scenes.map((scene, index) => [scene.id, index]));
  return project.shots.filter((shot) => !shot.archived).sort((left, right) => {
    const leftEpisode = episodeOrder.get(left.sceneId);
    const rightEpisode = episodeOrder.get(right.sceneId);
    const leftKey = leftEpisode?.number ?? Number.MAX_SAFE_INTEGER;
    const rightKey = rightEpisode?.number ?? Number.MAX_SAFE_INTEGER;
    if (leftKey !== rightKey) return leftKey - rightKey;
    const leftScene = leftEpisode?.index ?? sceneOrder.get(left.sceneId) ?? Number.MAX_SAFE_INTEGER;
    const rightScene = rightEpisode?.index ?? sceneOrder.get(right.sceneId) ?? Number.MAX_SAFE_INTEGER;
    if (leftScene !== rightScene) return leftScene - rightScene;
    return left.number - right.number;
  });
}

type TimelineEntry = { clip: TimelineClip; shot: Project['shots'][number]; asset?: CandidateAsset };

function timelineClipsFor(project: Project): TimelineClip[] {
  const activeShots = orderShots(project);
  const activeShotIds = new Set(activeShots.map((shot) => shot.id));
  const stored = (project.timeline ?? []).filter((clip) => activeShotIds.has(clip.shotId));
  const storedIds = new Set(stored.map((clip) => clip.shotId));
  const missing = activeShots
    .filter((shot) => !storedIds.has(shot.id))
    .map((shot) => ({ id: `timeline_${shot.id}`, shotId: shot.id, enabled: true, duration: shot.duration }));
  return [...stored, ...missing].map((clip) => {
    const shot = project.shots.find((item) => item.id === clip.shotId);
    const fallbackDuration = shot?.duration ?? 1;
    return {
      ...clip,
      enabled: clip.enabled !== false,
      duration: Number.isFinite(clip.duration) ? Math.max(0.5, Math.min(30, clip.duration)) : fallbackDuration,
    };
  });
}

function selectedAssetForShot(project: Project, shotId: string) {
  const prompt = [...project.prompts].reverse().find((item) => item.assetId === shotId);
  if (!prompt) return undefined;
  const selected = project.candidates.filter((asset) => asset.promptId === prompt.id && asset.selected);
  const approvedVideo = selected.find((item) => item.kind === 'video' && project.qcReports?.some((report) => report.assetId === item.id && report.status === 'approved'));
  return approvedVideo ?? selected.find((item) => item.kind === 'image');
}

function timelineEntries(project: Project): TimelineEntry[] {
  return timelineClipsFor(project).flatMap((clip) => {
    const shot = project.shots.find((item) => item.id === clip.shotId);
    return shot ? [{ clip, shot, asset: selectedAssetForShot(project, shot.id) }] : [];
  });
}

function selectedTimelineItems(project: Project) {
  return timelineEntries(project).filter((entry): entry is TimelineEntry & { asset: CandidateAsset } => entry.clip.enabled && Boolean(entry.asset));
}

function qcReportFor(project: Project, assetId: string) {
  return project.qcReports?.find((report) => report.assetId === assetId);
}

function referenceBindingsFor(project: Project, shot: Project['shots'][number], promptId: string, excludedFrameRole?: string) {
  const bindings: ReferenceBinding[] = [];
  const seen = new Set<string>();
  const add = (role: ReferenceBinding['role'], sourceUrl: string | undefined, label: string, assetId?: string) => {
    if (!sourceUrl || seen.has(sourceUrl)) return;
    seen.add(sourceUrl);
    bindings.push({ id: `ref_${shot.id}_${bindings.length + 1}`, shotId: shot.id, slot: bindings.length, role, assetId, sourceUrl, label, locked: true });
  };
  for (const storyboard of (project.storyboards ?? []).filter((item) => item.shotId === shot.id && item.selected).sort((left, right) => Number(left.role === 'clean') - Number(right.role === 'clean') || left.version - right.version)) {
    add(storyboard.role, storyboard.url, storyboard.role === 'clean' ? 'clean continuity frame' : 'storyboard frame', storyboard.sourceAssetId);
  }
  for (const characterId of shot.characters) {
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) continue;
    const portrait = character.referenceIds.map((id) => project.candidates.find((asset) => asset.id === id)).find((asset): asset is CandidateAsset => Boolean(asset));
    add('character', portrait ? mediaProviderSource(portrait) : character.portraitUrl, `${character.name} canonical reference`, portrait?.id);
  }
  const supportAssets = project.candidates.filter((asset) => asset.promptId === promptId && asset.selected && ['scene', 'prop'].includes(String(asset.metadata.referenceRole)));
  for (const asset of supportAssets) add(String(asset.metadata.referenceRole) as ReferenceBinding['role'], mediaProviderSource(asset), asset.label, asset.id);
  const frameAssets = project.candidates
    .filter((asset) => asset.promptId === promptId && asset.selected && ['start', 'end', 'middle'].includes(String(asset.metadata.frameRole)) && String(asset.metadata.frameRole) !== excludedFrameRole)
    .sort((left, right) => ['start', 'end', 'middle'].indexOf(String(left.metadata.frameRole)) - ['start', 'end', 'middle'].indexOf(String(right.metadata.frameRole)));
  for (const asset of frameAssets) add(String(asset.metadata.frameRole) as ReferenceBinding['role'], mediaProviderSource(asset), asset.label, asset.id);
  return bindings;
}

function withReferenceBindings(project: Project, shotId: string, bindings: ReferenceBinding[]): Project {
  return { ...project, referenceBindings: [...(project.referenceBindings ?? []).filter((binding) => binding.shotId !== shotId), ...bindings] };
}

function timelineOffsets(project: Project, transitionDuration = 0, includedShotIds?: ReadonlySet<string>) {
  const sceneOffsets = new Map<string, number>();
  let cursor = 0;
  let hasPreviousShot = false;
  for (const { clip, shot } of timelineEntries(project)) {
    if (!clip.enabled || (includedShotIds && !includedShotIds.has(shot.id))) continue;
    if (hasPreviousShot) cursor = Math.max(0, cursor - transitionDuration);
    if (!sceneOffsets.has(shot.sceneId)) sceneOffsets.set(shot.sceneId, cursor);
    cursor += clip.duration;
    hasPreviousShot = true;
  }
  const episodeOffsets = new Map<string, number>();
  for (const episode of project.episodes ?? []) {
    if (episode.sceneId) {
      const offset = sceneOffsets.get(episode.sceneId);
      if (offset !== undefined) episodeOffsets.set(episode.id, offset);
    }
  }
  return { sceneOffsets, episodeOffsets };
}

export function App() {
  const [project, setProject] = useState<Project>(demoProject);
  const [availableProjects, setAvailableProjects] = useState<Project[]>([demoProject]);
  const [stage, setStage] = useState<Stage>('素材');
  const [activeShot, setActiveShot] = useState(project.shots[0].id);
  const [activeEpisodeId, setActiveEpisodeId] = useState(project.episodes?.[0]?.id ?? project.scenes[0]?.id ?? '');
  const [candidateCount, setCandidateCount] = useState(4);
  const [showSettings, setShowSettings] = useState(false);
  const [showAssetLibrary, setShowAssetLibrary] = useState(false);
  const [provider] = useState<ProviderProfile>(providers[0]);
  const [settingsProvider, setSettingsProvider] = useState<ProviderProfile>(providers[0]);
  const [connections, setConnections] = useState<ProviderConnections>({
    'gpt-image': { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: providers[0].model, textModel: 'gpt-4.1-mini' },
    'openai-voice': { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: providers[1].model, voice: 'alloy' },
    'bytedance-video': { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: '', model: providers[2].model },
    'grok-video': { baseUrl: 'https://api.x.ai/v1', apiKey: '', model: providers[3].model },
    'gemini-video': { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '', model: providers[4].model },
  });
  const [isAdapting, setIsAdapting] = useState(false);
  const [isExtractingCharacters, setIsExtractingCharacters] = useState(false);
  const [portraitJob, setPortraitJob] = useState<string | null>(null);
  const [isPlanningShots, setIsPlanningShots] = useState(false);
  const [assetMode, setAssetMode] = useState<'image' | 'video'>('image');
  const [generateNativeAudio, setGenerateNativeAudio] = useState(false);
  const [frameRole, setFrameRole] = useState<'start' | 'end' | 'middle'>('start');
  const [videoProvider, setVideoProvider] = useState<ProviderProfile>(providers[2]);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [isProjectPackageBusy, setIsProjectPackageBusy] = useState(false);
  const [isFinalCutExporting, setIsFinalCutExporting] = useState(false);
  const [isVoiceGenerating, setIsVoiceGenerating] = useState(false);
  const [durableJobs, setDurableJobs] = useState<DurableGenerationJob[]>([]);
  const [qcBusyAssetId, setQcBusyAssetId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const pendingVideoTasks = useRef<Record<string, { providerId: 'bytedance-video' | 'grok-video' | 'gemini-video'; baseUrl: string; apiKey: string; taskIds: string[] }>>({});
  const cancelledVideoJobs = useRef(new Set<string>());
  const resumedVideoJobs = useRef(new Set<string>());
  const pendingProjectSave = useRef<{ next: Project | null; running: boolean }>({ next: null, running: false });
  const saveFailureNotified = useRef(false);
  const jobPersistenceFailureNotified = useRef(false);

  useEffect(() => {
    let disposed = false;
    void listProviderSettings().then((settings) => {
      if (disposed) return;
      setConnections((current) => {
        const next = { ...current };
        for (const setting of settings) {
          if (next[setting.providerId]) next[setting.providerId] = { ...next[setting.providerId], baseUrl: setting.baseUrl, model: setting.model, ...(setting.textModel ? { textModel: setting.textModel } : {}), ...(setting.voice ? { voice: setting.voice } : {}) };
        }
        return next;
      });
    }).catch(() => undefined);
    void Promise.all(providers.map(async (provider) => [provider.id, await loadProviderCredential(provider.id)] as const)).then((credentials) => {
      if (disposed) return;
      setConnections((current) => {
        const next = { ...current };
        for (const [providerId, apiKey] of credentials) {
          if (apiKey) next[providerId] = { ...next[providerId], apiKey };
        }
        return next;
      });
    }).catch(() => undefined);
    void (async () => {
      try {
        const currentProjectId = await loadCurrentProjectId().catch(() => null);
        const stored = await loadProject(currentProjectId ?? demoProject.id);
        if (disposed) return;
        if (stored) {
          const jobs = await listGenerationJobs(stored.id).catch(() => []);
          if (disposed) return;
          const interruptedImageJobs = new Set(jobs
            .filter((job) => job.kind !== 'video' && ['queued', 'preparing', 'generating', 'polling'].includes(job.status))
            .map((job) => job.id));
          await Promise.all([...interruptedImageJobs].map((jobId) => updateGenerationJobStatus(jobId, 'failed').catch(() => undefined)));
          const durableStatus = new Map(jobs.map((job) => [job.id, job.status]));
          const restored = {
            ...stored,
            jobs: stored.jobs.map((job) => interruptedImageJobs.has(job.id)
              ? { ...job, status: 'failed' as const, error: '应用重启前图片任务未完成，已停止自动重试以避免重复计费。请重新生成。' }
              : durableStatus.has(job.id)
                ? { ...job, status: durableStatus.get(job.id) as Project['jobs'][number]['status'] }
                : job),
          };
          setProject(restored);
          await saveCurrentProjectId(restored.id).catch(() => undefined);
          setDurableJobs(jobs.filter((job) => job.kind === 'video' && ['queued', 'generating', 'polling', 'unknown'].includes(job.status)));
          setActiveShot(restored.shots[0]?.id ?? '');
          setActiveEpisodeId(restored.episodes?.[0]?.id ?? restored.scenes[0]?.id ?? '');
        } else {
          await saveProject(demoProject);
          await saveCurrentProjectId(demoProject.id).catch(() => undefined);
        }
        const projects = await listProjects().catch(() => []);
        if (!disposed) setAvailableProjects(projects.length ? projects : [stored ?? demoProject]);
      } catch {
        // The demo remains usable when local persistence is unavailable.
      }
    })();
    return () => { disposed = true; };
  }, []);

  const activePrompt = useMemo(() => [...project.prompts].reverse().find((prompt) => prompt.assetId === activeShot), [project.prompts, activeShot]);
  const activeScene = useMemo(() => {
    const episode = project.episodes?.find((item) => item.id === activeEpisodeId);
    return project.scenes.find((scene) => scene.id === episode?.sceneId) ?? project.scenes.find((scene) => scene.id === activeEpisodeId) ?? project.scenes[0];
  }, [project.episodes, project.scenes, activeEpisodeId]);
  useEffect(() => {
    const sceneShots = activeScene ? project.shots.filter((shot) => shot.sceneId === activeScene.id && !shot.archived) : [];
    if (!sceneShots.some((shot) => shot.id === activeShot)) setActiveShot(sceneShots[0]?.id ?? '');
  }, [activeScene?.id, project.shots, activeShot]);
  const selectedAsset = useMemo(() => {
    const selected = project.candidates.filter((asset) => asset.promptId === activePrompt?.id && asset.selected);
    return selected.find((asset) => asset.kind === 'video')
      ?? selected.find((asset) => asset.kind === 'image' && (!asset.metadata.frameRole || asset.metadata.frameRole === frameRole))
      ?? selected[0];
  }, [project.candidates, activePrompt, frameRole]);
  const imageConnection = connections['gpt-image'];
  const videoConnection = connections[videoProvider.id];
  const activeShots = project.shots.filter((shot) => !shot.archived);
  const totalDuration = timelineClipsFor(project).filter((clip) => clip.enabled).reduce((total, clip) => total + clip.duration, 0);
  const notice = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2600); };
  const persistProject = (next: Project) => {
    pendingProjectSave.current.next = next;
    if (pendingProjectSave.current.running) return;
    pendingProjectSave.current.running = true;
    void (async () => {
      while (pendingProjectSave.current.next) {
        const snapshot = pendingProjectSave.current.next;
        pendingProjectSave.current.next = null;
        try {
          await saveProject(snapshot);
          saveFailureNotified.current = false;
        } catch {
          if (!saveFailureNotified.current) {
            saveFailureNotified.current = true;
            notice('本地保存失败，当前改动仍在内存中，请检查应用数据目录。');
          }
        }
      }
      pendingProjectSave.current.running = false;
    })();
  };
  const cacheMediaAsset = async (source: string, kind: 'image' | 'video' | 'audio', fileName: string) => {
    try {
      return await storeMediaAsset({ source, kind, fileName });
    } catch {
      return source;
    }
  };
  const commit = (next: Project, message?: string) => {
    setProject(next);
    setAvailableProjects((current) => current.some((item) => item.id === next.id)
      ? current.map((item) => item.id === next.id ? next : item)
      : [next, ...current]);
    persistProject(next);
    if (message) notice(message);
  };
  const setQcReport = (assetId: string, changes: Partial<MediaQcReport> & Pick<MediaQcReport, 'status'>) => {
    setProject((current) => {
      const existing = qcReportFor(current, assetId);
      const report: MediaQcReport = {
        id: existing?.id ?? `qc_${assetId}`,
        assetId,
        status: changes.status,
        duration: changes.duration ?? existing?.duration,
        width: changes.width ?? existing?.width,
        height: changes.height ?? existing?.height,
        hasAudio: changes.hasAudio ?? existing?.hasAudio,
        frameCount: changes.frameCount ?? existing?.frameCount,
        contactSheetUrl: changes.contactSheetUrl ?? existing?.contactSheetUrl,
        warnings: changes.warnings ?? existing?.warnings ?? [],
        errors: changes.errors ?? existing?.errors ?? [],
        checkedAt: changes.checkedAt ?? existing?.checkedAt,
      };
      const next = { ...current, qcReports: [...(current.qcReports ?? []).filter((item) => item.assetId !== assetId), report] };
      setAvailableProjects((items) => items.map((item) => item.id === next.id ? next : item));
      persistProject(next);
      return next;
    });
  };
  const runAssetQc = async (asset: CandidateAsset, silent = false) => {
    if (asset.kind === 'audio') return;
    setQcBusyAssetId(asset.id);
    setQcReport(asset.id, { status: 'processing', errors: [], warnings: [] });
    try {
      const result = await runMediaQc({ assetId: asset.id, source: mediaProviderSource(asset), kind: asset.kind });
      setQcReport(asset.id, {
        status: 'ready',
        duration: result.duration,
        width: result.width,
        height: result.height,
        hasAudio: result.hasAudio,
        frameCount: result.frameCount,
        contactSheetUrl: result.contactSheetPath,
        warnings: result.warnings,
        errors: result.errors,
        checkedAt: new Date().toISOString(),
      });
      if (!silent) notice(result.errors.length ? '质检完成，但存在阻断问题，请驳回或重新生成' : '质检完成，请人工检查接触表后通过');
    } catch (error) {
      setQcReport(asset.id, { status: 'failed', errors: [error instanceof Error ? error.message : String(error)], checkedAt: new Date().toISOString() });
      if (!silent) notice('媒体质检失败，请检查 FFmpeg/FFprobe 和素材路径');
    } finally {
      setQcBusyAssetId((current) => current === asset.id ? null : current);
    }
  };
  const setAssetQcStatus = (assetId: string, status: Extract<QcStatus, 'approved' | 'rejected'>) => {
    const report = qcReportFor(project, assetId);
    if (!report || report.status !== 'ready') { notice('请先完成质检，再进行人工判定'); return; }
    if (status === 'approved' && report.errors.length) { notice('质检报告存在阻断问题，不能通过'); return; }
    setQcReport(assetId, { status, checkedAt: new Date().toISOString() });
    notice(status === 'approved' ? '质检已通过，视频可以进入终剪' : '质检已驳回，视频不会进入终剪');
  };
  const switchProject = async (projectId: string) => {
    if (projectId === project.id) return;
    try {
      const next = await loadProject(projectId);
      if (!next) throw new Error('项目不存在或已损坏');
      const jobs = await listGenerationJobs(next.id).catch(() => []);
      setProject(next);
      setAvailableProjects((current) => current.map((item) => item.id === next.id ? next : item));
      setDurableJobs(jobs.filter((job) => job.kind === 'video' && ['queued', 'generating', 'polling', 'unknown'].includes(job.status)));
      setActiveShot(next.shots[0]?.id ?? '');
      setActiveEpisodeId(next.episodes?.[0]?.id ?? next.scenes[0]?.id ?? '');
      await saveCurrentProjectId(next.id);
      setStage('故事');
      notice(`已切换项目：${next.name}`);
    } catch (error) {
      notice(error instanceof Error ? error.message : '项目切换失败');
    }
  };
  const persistGenerationJob = (job: Project['jobs'][number], payload: Record<string, unknown>) => {
    return enqueueGenerationJob({ id: job.id, projectId: project.id, kind: job.kind, status: job.status, payload: { ...payload, title: job.title, provider: job.provider, model: job.model, candidateCount: job.candidateCount }, createdAt: job.createdAt, updatedAt: new Date().toISOString() });
  };
  const persistJobStatus = (jobId: string, status: Project['jobs'][number]['status']) => {
    void updateGenerationJobStatus(jobId, status).then(() => {
      jobPersistenceFailureNotified.current = false;
    }).catch(() => {
      if (jobPersistenceFailureNotified.current) return;
      jobPersistenceFailureNotified.current = true;
      notice('生成任务状态暂时未写入本地数据库，任务仍会保留并在下次启动时尝试恢复。');
    });
  };
  const failLocalGenerationJob = (jobId: string, message: string) => {
    setProject((current) => {
      const next = { ...current, jobs: current.jobs.map((item) => item.id === jobId ? { ...item, status: 'failed' as const, progress: 0, error: message } : item) };
      persistProject(next);
      return next;
    });
    notice(message);
  };
  const cancelVideoJob = async (jobId: string) => {
    cancelledVideoJobs.current.add(jobId);
    const pending = pendingVideoTasks.current[jobId];
    if (pending) await Promise.allSettled(pending.taskIds.map((taskId) => cancelVideoGeneration({ providerId: pending.providerId, baseUrl: pending.baseUrl, apiKey: pending.apiKey, taskId })));
    setProject((current) => {
      const jobs = current.jobs.map((job) => job.id === jobId ? { ...job, status: 'cancelled' as const, progress: 0 } : job);
      const next = { ...current, jobs };
      persistProject(next);
      return next;
    });
    persistJobStatus(jobId, 'cancelled');
    notice('视频生成任务已取消');
  };

  const selectCandidate = (assetId: string) => {
    const target = project.candidates.find((asset) => asset.id === assetId);
    if (!target) return;
    const targetRole = target.metadata.frameRole;
    const candidates = project.candidates.map((asset) => ({
      ...asset,
      selected: asset.promptId === target.promptId && asset.kind === target.kind && (asset.kind !== 'image' || asset.metadata.frameRole === targetRole) ? asset.id === assetId : asset.selected,
    }));
    const prompt = project.prompts.find((item) => item.id === target.promptId);
    const shot = project.shots.find((item) => item.id === prompt?.assetId);
    const shouldSeedStoryboard = target.kind === 'image' && shot && (!targetRole || targetRole === 'start');
    const next = shouldSeedStoryboard
      ? withReferenceBindings({
        ...project,
        candidates,
        storyboards: [{ id: `storyboard_${shot.id}`, shotId: shot.id, role: 'storyboard' as const, sourceAssetId: target.id, url: mediaProviderSource(target), version: 1, selected: true, createdAt: new Date().toISOString() }, ...(project.storyboards ?? []).filter((item) => item.shotId !== shot.id)],
      }, shot.id, referenceBindingsFor({ ...project, candidates }, shot, target.promptId))
      : { ...project, candidates };
    commit(next, `已设为镜头素材首选：${target.label}`);
  };
  const setStoryboard = (asset: CandidateAsset) => {
    const prompt = project.prompts.find((item) => item.id === asset.promptId);
    const shot = project.shots.find((item) => item.id === prompt?.assetId);
    if (!shot || asset.kind !== 'image') return;
    const storyboards = [{ id: `storyboard_${shot.id}`, shotId: shot.id, role: 'storyboard' as const, sourceAssetId: asset.id, url: mediaProviderSource(asset), version: (project.storyboards?.filter((item) => item.shotId === shot.id).length ?? 0) + 1, selected: true, createdAt: new Date().toISOString() }, ...(project.storyboards ?? []).filter((item) => item.shotId !== shot.id)];
    commit(withReferenceBindings({ ...project, storyboards }, shot.id, referenceBindingsFor({ ...project, storyboards }, shot, asset.promptId)), '已将当前图片设为故事板参考');
  };
  const toggleChapter = (id: string) => commit({ ...project, chapters: project.chapters.map((chapter) => chapter.id === id ? { ...chapter, selected: !chapter.selected } : chapter) });
  const importStory = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const { source, chapters } = await importStoryFile(file);
      const sceneIds = chapters.map(() => `scene_${crypto.randomUUID()}`);
      const importedScenes: Project['scenes'] = chapters.map((chapter, index) => ({
        id: sceneIds[index], heading: `待改编 / ${chapter.title}`, action: chapter.summary, dialogue: '', emotionalBeat: '待生成', hook: '待生成', status: 'draft',
      }));
      const next: Project = {
        ...project,
        source,
        chapters,
        episodes: chapters.map((chapter, index) => ({ id: `episode_${crypto.randomUUID()}`, number: index + 1, title: chapter.title, chapterIds: [chapter.id], synopsis: chapter.summary, sceneId: sceneIds[index], status: 'draft' as const })),
        scenes: importedScenes,
        characters: [], shots: [], prompts: [], candidates: [], jobs: [], audioTracks: [],
      };
      commit(next, `已导入 ${file.name}，识别到 ${chapters.length} 个章节`);
      setActiveEpisodeId(next.episodes?.[0]?.id ?? next.scenes[0]?.id ?? '');
      setStage('故事');
    } catch (error) {
      notice(error instanceof Error ? error.message : '导入失败，请检查文件格式');
    }
  };
  const updateChapter = (chapterId: string, changes: Partial<Project['chapters'][number]>) => commit({ ...project, chapters: project.chapters.map((chapter) => chapter.id === chapterId ? { ...chapter, ...changes } : chapter) });
  const updateScene = (sceneId: string, changes: Partial<Project['scenes'][number]>) => {
    const scenes = project.scenes.map((scene) => scene.id === sceneId ? { ...scene, ...changes, status: 'draft' as const } : scene);
    const episodes = (project.episodes ?? []).map((episode) => episode.sceneId === sceneId ? { ...episode, status: 'draft' as const } : episode);
    commit({ ...project, scenes, episodes });
  };
  const approveScene = () => {
    const sceneId = activeScene?.id;
    if (!sceneId) return;
    const shotIds = new Set(project.shots.filter((shot) => shot.sceneId === sceneId && !shot.archived).map((shot) => shot.id));
    const promptIds = new Set(project.prompts.filter((prompt) => shotIds.has(prompt.assetId)).map((prompt) => prompt.id));
    const jobIds = new Set(project.candidates.filter((asset) => promptIds.has(asset.promptId)).map((asset) => asset.jobId));
    const hasDownstreamWork = shotIds.size > 0 || promptIds.size > 0 || jobIds.size > 0;
    const scenes = project.scenes.map((scene) => scene.id === sceneId ? { ...scene, status: 'approved' as const } : scene);
    const episodes = (project.episodes ?? []).map((episode) => episode.sceneId === sceneId ? { ...episode, status: 'approved' as const } : episode);
    const next = {
      ...project,
      scenes,
      episodes,
      ...(hasDownstreamWork ? {
        shots: project.shots.map((shot) => shotIds.has(shot.id) ? { ...shot, archived: true } : shot),
        audioTracks: project.audioTracks.filter((track) => track.sceneId !== sceneId && track.episodeId !== activeEpisodeId),
        subtitles: (project.subtitles ?? []).filter((cue) => cue.sceneId !== sceneId && cue.episodeId !== activeEpisodeId),
      } : {}),
    };
    commit(next, hasDownstreamWork ? '本集剧本已确认，已清除本集旧镜头与素材，其他集保持不变' : '本集剧本已确认，可继续拆分镜头');
  };
  const adaptStory = async () => {
    const selected = project.chapters.filter((chapter) => chapter.selected);
    if (!selected.length) { notice('请至少选择一个章节再改编'); return; }
    if (!imageConnection.apiKey) { setShowSettings(true); notice('请先配置文本模型 API key'); return; }
    setIsAdapting(true);
    try {
      const existingEpisodes = project.episodes ?? [];
      const selectedChapterIds = new Set(selected.map((chapter) => chapter.id));
      const field = (draft: string, label: string, fallback: string) => draft.match(new RegExp(`(?:^|\\n)${label}\\s*[：:]\\s*([\\s\\S]*?)(?=\\n(?:场景|动作|台词|情绪|钩子)\\s*[：:]|$)`))?.[1].trim() || fallback;
      const adapted = await Promise.all(selected.map(async (chapter, index) => {
        const currentEpisode = existingEpisodes.find((episode) => episode.chapterIds.includes(chapter.id));
        const currentScene = project.scenes.find((scene) => scene.id === currentEpisode?.sceneId);
        const draft = await generateText({
          baseUrl: imageConnection.baseUrl, apiKey: imageConnection.apiKey, model: imageConnection.textModel ?? 'gpt-4.1-mini',
          systemPrompt: '你是短剧编剧。将一个小说章节压缩为适合 1-3 分钟竖屏短剧的一集：保留主线冲突、人物动机、可视动作和结尾钩子；删去冗余叙述。必须用中文，并严格使用“场景：”“动作：”“台词：”“情绪：”“钩子：”五个小节。',
          userPrompt: `项目视觉风格：${project.styleGuide.visualStyle}。\n\n第 ${index + 1} 集来源章节：${chapter.title}\n${chapter.content ?? chapter.summary}`,
        });
        const scene = {
          id: currentScene?.id ?? `scene_${crypto.randomUUID()}`,
          heading: field(draft, '场景', currentScene?.heading ?? `场景 01 / ${chapter.title}`), action: field(draft, '动作', currentScene?.action ?? draft),
          dialogue: field(draft, '台词', currentScene?.dialogue ?? '待补充'), emotionalBeat: field(draft, '情绪', currentScene?.emotionalBeat ?? '待确认'),
          hook: field(draft, '钩子', currentScene?.hook ?? '待确认'), status: 'review' as const,
        };
        const episode = {
          id: currentEpisode?.id ?? `episode_${crypto.randomUUID()}`, number: currentEpisode?.number ?? chapter.number ?? index + 1, title: chapter.title, chapterIds: [chapter.id], synopsis: chapter.summary, sceneId: scene.id, status: 'review' as const,
        };
        return { episode, scene };
      }));
      const adaptedSceneIds = new Set(adapted.map((item) => item.scene.id));
      const adaptedEpisodeIds = new Set(adapted.map((item) => item.episode.id));
      const preservedEpisodes = existingEpisodes.filter((episode) => !episode.chapterIds.some((id) => selectedChapterIds.has(id)) && !adaptedEpisodeIds.has(episode.id));
      const preservedSceneIds = new Set(preservedEpisodes.map((episode) => episode.sceneId).filter((id): id is string => Boolean(id)));
      const preservedScenes = project.scenes.filter((scene) => preservedSceneIds.has(scene.id) || (!project.episodes?.length && !adaptedSceneIds.has(scene.id)));
      const scenes = [...preservedScenes, ...adapted.map((item) => item.scene)];
      const adaptedEpisodeIdsForCleanup = new Set(adapted.map((item) => item.episode.id));
      const adaptedShotIds = new Set(project.shots.filter((shot) => adaptedSceneIds.has(shot.sceneId) && !shot.archived).map((shot) => shot.id));
      const episodes = [...preservedEpisodes, ...adapted.map((item) => item.episode)].sort((a, b) => a.number - b.number);
      commit({
        ...project,
        episodes,
        scenes,
        shots: project.shots.map((shot) => adaptedShotIds.has(shot.id) ? { ...shot, archived: true } : shot),
        audioTracks: project.audioTracks.filter((track) => !adaptedSceneIds.has(track.sceneId ?? '') && !adaptedEpisodeIdsForCleanup.has(track.episodeId ?? '')),
        subtitles: (project.subtitles ?? []).filter((cue) => !adaptedSceneIds.has(cue.sceneId ?? '') && !adaptedEpisodeIdsForCleanup.has(cue.episodeId ?? '')),
      }, `已按 ${adapted.length} 个选中章节生成 ${adapted.length} 集短剧初稿，其他集保持不变`);
      setActiveEpisodeId(adapted[0]?.episode.id ?? episodes[0]?.id ?? '');
    } catch (error) {
      notice(error instanceof Error ? error.message : '文本改编失败，请检查模型配置');
    } finally { setIsAdapting(false); }
  };
  const extractCharacters = async () => {
    const scene = activeScene;
    if (!scene) { notice('请先生成短剧初稿'); return; }
    if (!imageConnection.apiKey) { setShowSettings(true); notice('请先配置文本模型 API key'); return; }
    setIsExtractingCharacters(true);
    try {
      const raw = await generateText({
        baseUrl: imageConnection.baseUrl, apiKey: imageConnection.apiKey, model: imageConnection.textModel ?? 'gpt-4.1-mini',
        systemPrompt: '你是影视选角与角色设定师。根据短剧剧本提取 1 到 6 名需要出镜的角色。只返回 JSON 数组，不要 Markdown。每一项必须有 name、role、bio、appearance、firstLook。appearance 应描述稳定的脸型、发型、年龄气质和体态；firstLook 描述本集首个剧情阶段的服装与状态。',
        userPrompt: `项目风格：${project.styleGuide.visualStyle}。\n场景：${scene.heading}\n动作：${scene.action}\n台词：${scene.dialogue}`,
      });
      const normalized = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed: unknown = JSON.parse(normalized);
      if (!Array.isArray(parsed)) throw new Error('模型没有返回角色数组');
      const extracted: Character[] = parsed.slice(0, 6).map((item, index) => {
        const source = item as Record<string, unknown>;
        const name = typeof source.name === 'string' ? source.name : `角色 ${index + 1}`;
        const appearance = typeof source.appearance === 'string' ? source.appearance : '等待补充稳定外观描述';
        const firstLook = typeof source.firstLook === 'string' ? source.firstLook : '首集常服';
        return {
          id: `char_${crypto.randomUUID()}`, name,
          role: typeof source.role === 'string' ? source.role : '主要角色',
          bio: `${typeof source.bio === 'string' ? source.bio : '等待补充人物背景。'}\n视觉锚点：${appearance}`,
          portraitUrl: '', status: 'draft', referenceIds: [],
          variants: [{ id: `look_${crypto.randomUUID()}`, label: '首集造型', storyRange: 'EP01', description: firstLook, status: 'draft' }],
        };
      });
      if (!extracted.length) throw new Error('没有识别到可出镜角色');
      const activeEpisode = project.episodes?.find((episode) => episode.id === activeEpisodeId);
      const storyRange = `EP${String(activeEpisode?.number ?? 1).padStart(2, '0')}`;
      const existingByName = new Map(project.characters.map((character) => [character.name.trim().toLocaleLowerCase(), character]));
      const merged = extracted.map((draft) => {
        const existing = existingByName.get(draft.name.trim().toLocaleLowerCase());
        if (!existing) return { ...draft, variants: draft.variants.map((variant) => ({ ...variant, storyRange })) };
        const look = draft.variants[0];
        const hasLook = existing.variants.some((variant) => variant.storyRange === storyRange);
        const variants = hasLook ? existing.variants : [...existing.variants, { ...look, id: `look_${crypto.randomUUID()}`, label: `${storyRange} 造型`, storyRange }];
        return { ...existing, role: draft.role || existing.role, bio: existing.bio || draft.bio, variants, activeVariantId: hasLook ? (existing.activeVariantId ?? variants[0]?.id) : variants[variants.length - 1]?.id };
      });
      const extractedNames = new Set(extracted.map((character) => character.name.trim().toLocaleLowerCase()));
      const characters = [...project.characters.filter((character) => !extractedNames.has(character.name.trim().toLocaleLowerCase())), ...merged];
      commit({ ...project, characters }, `已从剧本提取 ${extracted.length} 个角色，请生成标准形象`);
    } catch (error) {
      notice(error instanceof Error ? error.message : '角色提取失败，请检查模型配置');
    } finally { setIsExtractingCharacters(false); }
  };
  const generatePortraits = async (characterId: string) => {
    const character = project.characters.find((item) => item.id === characterId);
    if (!character) return;
    if (!imageConnection.apiKey) { setShowSettings(true); notice('请先配置 GPT Image API key'); return; }
    setPortraitJob(characterId);
    try {
      const look = character.variants.find((variant) => variant.id === character.activeVariantId) ?? character.variants[0];
      const prompt = `Professional character design portrait for an AI short drama. ${character.name}, ${character.role}. ${character.bio}. Current look: ${look?.description ?? 'default appearance'}. ${project.styleGuide.visualStyle}. Neutral studio half-body portrait, clear face, consistent anatomy, no text, no watermark.`;
      const responses = (await Promise.all(Array.from({ length: 4 }, () => generateGptImage({
        baseUrl: imageConnection.baseUrl, apiKey: imageConnection.apiKey, model: imageConnection.model, prompt, size: '1024x1536', quality: 'medium',
      })))).flat();
      if (!responses.length) throw new Error('未收到角色图，请在桌面端检查模型连接');
      const jobId = `portrait_${Date.now()}`;
      const cachedUrls = await Promise.all(responses.map((result, index) => cacheMediaAsset(result.url, 'image', `${jobId}-${index}.png`)));
      const assets: CandidateAsset[] = responses.map((result, index) => ({
        id: `${jobId}_${index}`, jobId, kind: 'image', label: `${character.name} · 形象 ${String(index + 1).padStart(2, '0')}`,
        url: cachedUrls[index], promptId: `portrait_prompt_${character.id}`, provider: result.provider, model: result.model,
        createdAt: new Date().toISOString(), selected: index === 0, metadata: { characterId, assetRole: 'canonical-portrait', candidate: index + 1, sourceUrl: result.url },
      }));
      const first = assets[0];
      commit({ ...project, candidates: [...assets, ...project.candidates], characters: project.characters.map((item) => item.id === characterId ? { ...item, portraitUrl: first.url, referenceIds: [first.id], status: 'review' } : item) }, `已生成 ${assets.length} 张 ${character.name} 的标准形象候选`);
    } catch (error) {
      notice(error instanceof Error ? error.message : '角色图生成失败，请检查模型配置');
    } finally { setPortraitJob(null); }
  };
  const selectPortrait = (characterId: string, asset: CandidateAsset) => {
    const candidates = project.candidates.map((item) => item.metadata.characterId === characterId && item.metadata.assetRole === 'canonical-portrait' ? { ...item, selected: item.id === asset.id } : item);
    const characters = project.characters.map((item) => item.id === characterId ? { ...item, portraitUrl: asset.url, referenceIds: [asset.id], status: 'review' as const } : item);
    commit({ ...project, candidates, characters }, '已设为角色标准形象，后续镜头会绑定此参考图');
  };
  const addCharacter = () => {
    const characterId = `char_${crypto.randomUUID()}`;
    const variantId = `look_${crypto.randomUUID()}`;
    const character: Character = { id: characterId, name: '新角色', role: '待定义角色', bio: '请补充人物动机、稳定外观与故事功能。', portraitUrl: '', status: 'draft', referenceIds: [], activeVariantId: variantId, variants: [{ id: variantId, label: '首集造型', storyRange: 'EP01', description: '请补充服装、发型、妆容和剧情状态', status: 'draft' }] };
    commit({ ...project, characters: [...project.characters, character] }, '已新增角色，请补充设定并抽取标准形象');
  };
  const updateCharacter = (characterId: string, changes: Pick<Character, 'name' | 'role' | 'bio'>) => commit({ ...project, characters: project.characters.map((character) => character.id === characterId ? { ...character, ...changes, status: character.status === 'approved' ? 'review' : character.status } : character) });
  const addAppearanceVariant = (characterId: string) => commit({ ...project, characters: project.characters.map((character) => {
    if (character.id !== characterId) return character;
    const id = `look_${crypto.randomUUID()}`;
    const nextNumber = character.variants.length + 1;
    return { ...character, activeVariantId: id, variants: [...character.variants, { id, label: `剧情阶段 ${nextNumber}`, storyRange: '待指定章节', description: '待根据剧情补充服装、妆容、皮肤状态或受伤细节', status: 'draft' }] };
  }) }, '已新增剧情造型版本，并设为后续镜头默认版本');
  const composeShotPrompt = (shot: Project['shots'][number], variantOverrides: Record<string, string> = {}, styleGuide = project.styleGuide) => {
    const cast = shot.characters.map((id) => {
      const character = project.characters.find((item) => item.id === id);
      const variantId = variantOverrides[id] ?? character?.activeVariantId;
      const variant = character?.variants.find((item) => item.id === variantId) ?? character?.variants[0];
      return character ? `${character.name}: stable face, age, body shape, hair and wardrobe; ${variant?.description ?? 'default look'}` : '';
    }).filter(Boolean).join('; ') || 'no named characters';
    return [
      `Cinematic ${project.aspectRatio} shot, ${styleGuide.visualStyle}`,
      `Framing: ${shot.framing}; camera movement: ${shot.cameraMotion ?? styleGuide.cameraLanguage}`,
      `Visible action: ${shot.action}`,
      `Positive visual elements: ${cast}`,
      `Color and era: ${styleGuide.colorLanguage}; ${styleGuide.era}`,
      `Continuity constraints: ${styleGuide.constraints}`,
      'Lock the named subjects and setting across frames. No readable text, logos, subtitles, watermarks or UI. Keep hands anatomically correct and the primary subject inside the safe area.',
    ].join(' ');
  };
  const updateStyleGuide = (styleGuide: Project['styleGuide']) => {
    const revisions = project.shots.filter((shot) => !shot.archived).flatMap((shot) => {
      const source = [...project.prompts].reverse().find((prompt) => prompt.assetId === shot.id);
      if (!source) return [];
      return [{ ...source, id: `prompt_${crypto.randomUUID()}`, text: composeShotPrompt(shot, {}, styleGuide), negativeText: styleGuide.negativeConstraints, createdAt: new Date().toISOString() }];
    });
    commit({ ...project, styleGuide, prompts: [...project.prompts, ...revisions] }, revisions.length ? '风格手册已更新，已为每个镜头创建新的提示词版本' : '风格手册已更新');
  };
  const selectAppearanceVariant = (characterId: string, variantId: string) => {
    const characters = project.characters.map((character) => character.id === characterId ? { ...character, activeVariantId: variantId } : character);
    const prompts = project.prompts.map((prompt) => {
      const shot = project.shots.find((item) => item.id === prompt.assetId);
      if (!shot || !shot.characters.includes(characterId)) return prompt;
      const promptCharacters = characters.filter((item) => shot.characters.includes(item.id));
      return { ...prompt, text: composeShotPrompt(shot, { [characterId]: variantId }), characterVariantIds: promptCharacters.flatMap((character) => {
        const id = character.id === characterId ? variantId : character.activeVariantId;
        const variant = character.variants.find((item) => item.id === id) ?? character.variants[0];
        return variant ? [variant.id] : [];
      }), createdAt: new Date().toISOString() };
    });
    commit({ ...project, characters, prompts }, '已切换剧情造型，并更新相关镜头提示词');
  };
  const updateAppearanceVariant = (characterId: string, variantId: string, changes: Partial<Character['variants'][number]>) => commit({ ...project, characters: project.characters.map((character) => character.id === characterId ? { ...character, variants: character.variants.map((variant) => variant.id === variantId ? { ...variant, ...changes, status: variant.status === 'approved' ? 'review' : variant.status } : variant) } : character) });
  const approveAppearanceVariant = (characterId: string, variantId: string) => commit({ ...project, characters: project.characters.map((character) => character.id === characterId ? { ...character, variants: character.variants.map((variant) => variant.id === variantId ? { ...variant, status: 'approved' } : variant) } : character) }, '剧情造型已确认，可用于后续镜头与素材生成');
  const updateShot = (shotId: string, changes: Partial<Project['shots'][number]>) => {
    const original = project.shots.find((shot) => shot.id === shotId);
    if (!original) return;
    const shot = { ...original, ...changes, status: 'draft' as const };
    const shots = project.shots.map((item) => item.id === shotId ? shot : item);
    const prompt = {
      id: `prompt_${crypto.randomUUID()}`, assetId: shotId, text: composeShotPrompt(shot), negativeText: project.styleGuide.negativeConstraints,
      styleGuideId: 'style_1', characterVariantIds: shot.characters.flatMap((id) => {
        const character = project.characters.find((item) => item.id === id);
        const variant = character?.variants.find((item) => item.id === character.activeVariantId) ?? character?.variants[0];
        return variant ? [variant.id] : [];
      }), createdAt: new Date().toISOString(),
    };
    commit({ ...project, shots, prompts: [...project.prompts, prompt] }, `镜头 ${String(shot.number).padStart(2, '0')} 已更新，已创建新的提示词版本`);
  };
  const approveShot = (shotId: string) => commit({ ...project, shots: project.shots.map((shot) => shot.id === shotId ? { ...shot, status: 'approved' } : shot) }, '镜头已确认，可以进入素材抽卡');
  const revisePrompt = (promptId: string, text: string, negativeText: string) => {
    const source = project.prompts.find((prompt) => prompt.id === promptId);
    if (!source || !text.trim()) { notice('提示词不能为空'); return; }
    const revision = { ...source, id: `prompt_${crypto.randomUUID()}`, text: text.trim(), negativeText: negativeText.trim(), createdAt: new Date().toISOString() };
    commit({ ...project, prompts: [...project.prompts, revision] }, '提示词新版本已保存，后续抽卡将使用新版本');
    setEditingPrompt(false);
  };
  const exportPackage = async () => {
    setIsProjectPackageBusy(true);
    try {
      const safeName = project.name.replace(/[\\/:*?"<>|]/g, '_');
      const path = await save({ title: '导出 Frameforge 项目包', defaultPath: `${safeName}.frameforge.json`, filters: [{ name: 'Frameforge 项目包', extensions: ['json'] }] });
      if (!path) return;
      await exportProjectPackage(path, project);
      notice('项目包已导出，不包含任何供应商密钥');
    } catch (error) {
      notice(error instanceof Error ? error.message : '项目包导出失败');
    } finally { setIsProjectPackageBusy(false); }
  };
  const exportFinalCutToFile = async ({ kind = 'final', coverDuration = 0.6, endCardDuration = 0.6 }: FinalCutExportOptions = {}) => {
    const allSelectedTimeline = selectedTimelineItems(project);
    if (kind === 'batch-preview' && allSelectedTimeline.length < 3) { notice('批次预览至少需要 3 个已通过质检的视频或已选图片帧'); return; }
    const selectedTimeline = kind === 'batch-preview' ? allSelectedTimeline.slice(0, 5) : allSelectedTimeline;
    const clips = selectedTimeline.map(({ clip, asset }) => ({ source: asset.url, kind: asset.kind as 'video' | 'image', duration: clip.duration, preserveAudio: asset.kind === 'video' ? qcReportFor(project, asset.id)?.hasAudio === true : false }));
    if (!clips.length) { notice('请至少为一个镜头选定视频或图片帧后再导出'); return; }
    const safeName = project.name.replace(/[\\/:*?"<>|]/g, '_') || 'frameforge-final-cut';
    const batchNumber = (project.reviewBatches?.length ?? 0) + 1;
    const defaultName = kind === 'batch-preview' ? `${safeName}-batch-${String(batchNumber).padStart(2, '0')}.mp4` : `${safeName}.mp4`;
    const path = await save({ title: kind === 'batch-preview' ? '导出批次预览' : '导出 H.264 MP4 成片', defaultPath: defaultName, filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] });
    if (!path) return;
    setIsFinalCutExporting(true);
    try {
      const transitionDuration = clips.length > 1 ? 0.35 : 0;
      const selectedShotIds = new Set(selectedTimeline.map(({ shot }) => shot.id));
      const { sceneOffsets, episodeOffsets } = timelineOffsets(project, transitionDuration, selectedShotIds);
      const offsetFor = (sceneId?: string, episodeId?: string) => {
        if (sceneId) return sceneOffsets.get(sceneId);
        if (episodeId) return episodeOffsets.get(episodeId);
        return 0;
      };
      const contentDuration = Math.max(0.1, clips.reduce((total, clip) => total + clip.duration, 0) - transitionDuration * Math.max(0, clips.length - 1));
      const audioTracks = project.audioTracks.flatMap((track) => {
        if (!track.enabled || !track.sourceUrl) return [];
        const offset = offsetFor(track.sceneId, track.episodeId);
        if (offset === undefined) return [];
        const rawStart = Number.isFinite(track.start ?? 0) ? track.start ?? 0 : 0;
        const start = Math.max(0, rawStart + offset);
        if (start >= contentDuration) return [];
        const duration = Number.isFinite(track.duration) ? Math.max(0.1, track.duration) : 0.1;
        const volume = Number.isFinite(track.volume ?? 1) ? Math.min(4, Math.max(0, track.volume ?? 1)) : 1;
        return [{ source: track.sourceUrl, start, duration: Math.min(duration, Math.max(0.1, contentDuration - start)), volume }];
      });
      const subtitles = (project.subtitles ?? []).flatMap((cue) => {
        const offset = offsetFor(cue.sceneId, cue.episodeId);
        if (offset === undefined || !cue.text.trim()) return [];
        const rawStart = Number.isFinite(cue.start) ? cue.start : 0;
        const rawEnd = Number.isFinite(cue.end) ? cue.end : rawStart;
        const start = Math.max(0, rawStart + offset);
        const end = Math.min(contentDuration, rawEnd + offset);
        return end > start ? [{ text: cue.text, start, end }] : [];
      });
      const result = await exportFinalCut({ outputPath: path, aspectRatio: project.aspectRatio, clips, transitionDuration, coverDuration, endCardDuration, thumbnailSource: clips[0].source, contentDuration, audioTracks, subtitles });
      const exported = { id: `export_${crypto.randomUUID()}`, path: result.path, thumbnailPath: result.thumbnailPath, format: 'mp4' as const, kind, aspectRatio: project.aspectRatio, clipCount: result.clipCount, duration: result.duration, createdAt: new Date().toISOString() };
      const reviewBatch = kind === 'batch-preview' ? { id: `batch_${crypto.randomUUID()}`, number: batchNumber, shotIds: selectedTimeline.map(({ shot }) => shot.id), status: 'previewed' as const, previewPath: result.path, updatedAt: new Date().toISOString() } : undefined;
      commit({ ...project, exports: [exported, ...(project.exports ?? [])], ...(reviewBatch ? { reviewBatches: [reviewBatch, ...(project.reviewBatches ?? [])] } : {}) }, kind === 'batch-preview' ? `已导出第 ${batchNumber} 批预览，共 ${result.clipCount} 段` : `已导出 ${result.clipCount} 段镜头的 H.264 MP4${result.thumbnailPath ? '，并生成封面缩略图' : ''}`);
    } catch (error) {
      notice(error instanceof Error ? error.message : 'MP4 导出失败');
    } finally { setIsFinalCutExporting(false); }
  };
  const importAudioTrack = async (kind: AudioTrack['kind']) => {
    if (kind === 'subtitle') return;
    try {
      const selection = await open({ title: kind === 'dialogue' ? '导入配音' : kind === 'music' ? '导入音乐' : '导入音效', multiple: false, filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }] });
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;
      const label = path.split(/[\\/]/).pop() || (kind === 'dialogue' ? '配音轨道' : kind === 'music' ? '音乐轨道' : '音效轨道');
      const duration = Math.max(1, project.shots.filter((shot) => shot.sceneId === activeScene?.id && !shot.archived).reduce((total, shot) => total + shot.duration, 0));
      const track: AudioTrack = { id: `audio_${crypto.randomUUID()}`, kind, label, duration, enabled: true, sourceUrl: path, start: 0, volume: kind === 'music' ? 0.45 : 1, episodeId: activeEpisodeId, sceneId: activeScene?.id };
      commit({ ...project, audioTracks: [...project.audioTracks, track] }, `已添加${kind === 'dialogue' ? '配音' : kind === 'music' ? '音乐' : '音效'}：${label}`);
    } catch (error) {
      notice(error instanceof Error ? error.message : '音频导入失败');
    }
  };
  const toggleAudioTrack = (trackId: string) => commit({ ...project, audioTracks: project.audioTracks.map((track) => track.id === trackId ? { ...track, enabled: !track.enabled } : track) });
  const updateAudioTrack = (trackId: string, changes: Partial<AudioTrack>) => commit({ ...project, audioTracks: project.audioTracks.map((track) => track.id === trackId ? { ...track, ...changes } : track) });
  const updateTimeline = (timeline: TimelineClip[], message?: string) => commit({ ...project, timeline }, message);
  const toggleTimelineClip = (shotId: string) => {
    const timeline = timelineClipsFor(project).map((clip) => clip.shotId === shotId ? { ...clip, enabled: !clip.enabled } : clip);
    updateTimeline(timeline);
  };
  const moveTimelineClip = (shotId: string, direction: -1 | 1) => {
    const timeline = timelineClipsFor(project);
    const index = timeline.findIndex((clip) => clip.shotId === shotId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= timeline.length) return;
    [timeline[index], timeline[nextIndex]] = [timeline[nextIndex], timeline[index]];
    updateTimeline(timeline, '镜头序列已更新，导出将使用新的顺序');
  };
  const updateTimelineDuration = (shotId: string, duration: number) => {
    const timeline = timelineClipsFor(project).map((clip) => clip.shotId === shotId ? { ...clip, duration: Math.max(0.5, Math.min(30, duration)) } : clip);
    updateTimeline(timeline);
  };
  const resetTimeline = () => updateTimeline(orderShots(project).map((shot) => ({ id: `timeline_${shot.id}`, shotId: shot.id, enabled: true, duration: shot.duration })), '已恢复剧本镜头顺序');
  const generateVoiceTrack = async () => {
    const dialogue = activeScene?.dialogue.trim();
    if (!dialogue) { notice('当前剧本没有台词，无法生成配音'); return; }
    const voiceProvider = providers.find((item) => item.id === 'openai-voice');
    const connection = connections['openai-voice'];
    if (!voiceProvider || !connection?.apiKey) { if (voiceProvider) setSettingsProvider(voiceProvider); setShowSettings(true); notice('请先配置 OpenAI 配音连接'); return; }
    setIsVoiceGenerating(true);
    try {
      const dataUrl = await generateSpeech({ baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model, voice: connection.voice ?? 'alloy', input: dialogue, responseFormat: 'mp3' });
      const sourceUrl = await storeAudioAsset(dataUrl, `dialogue_${Date.now()}.mp3`);
      const duration = Math.max(1, project.shots.filter((shot) => shot.sceneId === activeScene?.id && !shot.archived).reduce((total, shot) => total + shot.duration, 0));
      const track: AudioTrack = { id: `audio_${crypto.randomUUID()}`, kind: 'dialogue', label: 'AI 配音 · OpenAI', duration, enabled: true, sourceUrl, start: 0, volume: 1, episodeId: activeEpisodeId, sceneId: activeScene?.id };
      commit({ ...project, audioTracks: [...project.audioTracks, track] }, '已生成 AI 配音并加入台词轨道');
    } catch (error) {
      notice(error instanceof Error ? error.message : 'AI 配音生成失败');
    } finally { setIsVoiceGenerating(false); }
  };
  const generateSubtitleDraft = () => {
    const dialogue = activeScene?.dialogue.trim();
    if (!dialogue) { notice('当前剧本没有台词，无法生成字幕草稿'); return; }
    const lines = dialogue.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const duration = Math.max(1, project.shots.filter((shot) => shot.sceneId === activeScene?.id && !shot.archived).reduce((total, shot) => total + shot.duration, 0));
    const subtitles: SubtitleCue[] = lines.map((text, index) => ({ id: `subtitle_${crypto.randomUUID()}`, text, start: Number((duration * index / lines.length).toFixed(2)), end: Number((duration * (index + 1) / lines.length).toFixed(2)), episodeId: activeEpisodeId, sceneId: activeScene?.id }));
    commit({ ...project, subtitles }, `已生成 ${subtitles.length} 条字幕草稿，请检查时间和文本`);
  };
  const updateSubtitle = (subtitleId: string, changes: Partial<SubtitleCue>) => commit({ ...project, subtitles: (project.subtitles ?? []).map((cue) => cue.id === subtitleId ? { ...cue, ...changes } : cue) });
  const importPackage = async () => {
    setIsProjectPackageBusy(true);
    try {
      const selection = await open({ title: '导入 Frameforge 项目包', multiple: false, filters: [{ name: 'Frameforge 项目包', extensions: ['json'] }] });
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;
      const imported = await importProjectPackage(path);
      setProject(imported);
      const importedJobs = await listGenerationJobs(imported.id).catch(() => []);
      setDurableJobs(importedJobs.filter((job) => job.kind === 'video' && ['queued', 'generating', 'polling', 'unknown'].includes(job.status)));
      resumedVideoJobs.current.clear();
      cancelledVideoJobs.current.clear();
      await saveCurrentProjectId(imported.id).catch(() => undefined);
      setAvailableProjects((current) => current.some((item) => item.id === imported.id)
        ? current.map((item) => item.id === imported.id ? imported : item)
        : [imported, ...current]);
      setActiveShot(imported.shots[0]?.id ?? '');
      setActiveEpisodeId(imported.episodes?.[0]?.id ?? imported.scenes[0]?.id ?? '');
      setStage('故事');
      notice(`已导入项目：${imported.name}`);
    } catch (error) {
      notice(error instanceof Error ? error.message : '项目包导入失败');
    } finally { setIsProjectPackageBusy(false); }
  };
  const planShots = async () => {
    const scene = activeScene;
    if (!scene) { notice('请先生成并确认短剧剧本'); return; }
    if (!imageConnection.apiKey) { setShowSettings(true); notice('请先配置文本模型 API key'); return; }
    setIsPlanningShots(true);
    try {
      const cast = project.characters.map((character) => `${character.name}（${character.role}）：${character.bio}`).join('\n');
      const raw = await generateText({
        baseUrl: imageConnection.baseUrl, apiKey: imageConnection.apiKey, model: imageConnection.textModel ?? 'gpt-4.1-mini',
        systemPrompt: '你是短剧分镜导演。根据一个短剧场景输出 3 到 12 个镜头。只返回 JSON 数组，不要 Markdown。每一项必须有 framing、cameraMotion、duration（整数秒，1 到 8）、action、characters（角色名数组）、audioCue。cameraMotion 要明确写出静止、跟拍、推拉、摇移或手持等镜头运动；action 只写主体和环境动作。镜头必须竖屏构图友好、可视、连续，且总时长控制在 90 秒以内。',
        userPrompt: `项目风格：${project.styleGuide.visualStyle}\n场景：${scene.heading}\n动作：${scene.action}\n台词：${scene.dialogue}\n情绪：${scene.emotionalBeat}\n角色：\n${cast || '尚无角色档案'}`,
      });
      const normalized = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed: unknown = JSON.parse(normalized);
      if (!Array.isArray(parsed)) throw new Error('模型没有返回镜头数组');
      const shots = parsed.slice(0, 12).map((item, index) => {
        const source = item as Record<string, unknown>;
        const names = Array.isArray(source.characters) ? source.characters.filter((name): name is string => typeof name === 'string') : [];
        const characters = project.characters.filter((character) => names.includes(character.name)).map((character) => character.id);
        return {
          id: `shot_${crypto.randomUUID()}`, sceneId: scene.id, number: index + 1,
          duration: typeof source.duration === 'number' ? Math.min(8, Math.max(1, Math.round(source.duration))) : 3,
          framing: typeof source.framing === 'string' ? source.framing : '中近景',
          cameraMotion: typeof source.cameraMotion === 'string' ? source.cameraMotion : '稳定镜头，轻微自然运动',
          action: typeof source.action === 'string' ? source.action : '待补充主体动作', characters,
          audioCue: typeof source.audioCue === 'string' ? source.audioCue : '环境氛围声', aspectRatio: project.aspectRatio, status: 'draft' as const,
        };
      });
      if (!shots.length) throw new Error('没有生成可用镜头');
      const prompts = shots.map((shot) => ({
        id: `prompt_${crypto.randomUUID()}`, assetId: shot.id,
        text: composeShotPrompt(shot),
        negativeText: project.styleGuide.negativeConstraints, styleGuideId: 'style_1',
        characterVariantIds: shot.characters.flatMap((id) => { const character = project.characters.find((item) => item.id === id); const variant = character?.variants.find((item) => item.id === character.activeVariantId) ?? character?.variants[0]; return variant ? [variant.id] : []; }), createdAt: new Date().toISOString(),
      }));
      const replacedShotIds = new Set(project.shots.filter((item) => item.sceneId === scene.id).map((item) => item.id));
      commit({ ...project, shots: [...project.shots.map((item) => replacedShotIds.has(item.id) ? { ...item, archived: true } : item), ...shots], prompts: [...project.prompts, ...prompts], audioTracks: project.audioTracks.filter((track) => track.sceneId !== scene.id && track.episodeId !== activeEpisodeId), subtitles: (project.subtitles ?? []).filter((cue) => cue.sceneId !== scene.id && cue.episodeId !== activeEpisodeId) }, `已为当前集生成 ${shots.length} 个镜头与对应提示词，请逐个审核，旧版本已归档`);
      setActiveShot(shots[0].id);
    } catch (error) {
      notice(error instanceof Error ? error.message : '镜头拆解失败，请检查模型配置');
    } finally { setIsPlanningShots(false); }
  };
  const generateVideoCards = async () => {
    if (!activePrompt) { notice('请先生成当前镜头的提示词'); return; }
    const activeShotPlan = project.shots.find((shot) => shot.id === activePrompt.assetId);
    if (!activeShotPlan) { notice('当前提示词没有对应镜头'); return; }
    if (activeShotPlan.status !== 'approved') { notice('请先确认当前镜头，再提交视频生成'); return; }
    const sourceFrames = project.candidates.filter((asset) => asset.kind === 'image' && asset.promptId === activePrompt.id);
    const selectedSourceFrames = sourceFrames.filter((asset) => asset.selected);
    if (!selectedSourceFrames.length) { notice('请先选定至少一张起始帧、末帧或中间帧，再生成视频'); return; }
    if (!videoConnection?.apiKey) { setSettingsProvider(videoProvider); setShowSettings(true); notice(`请先配置 ${videoProvider.name} 的端点和 API key`); return; }
    const confirmed = window.confirm(`即将向 ${videoProvider.name} 提交 ${candidateCount} 个视频任务。\n镜头：${activeShotPlan.number} · ${activeShotPlan.duration} 秒\n提交后可能产生供应商费用，是否继续？`);
    if (!confirmed) return;
    const jobId = `video_${crypto.randomUUID()}`;
    const job = { id: jobId, kind: 'video' as const, title: `镜头 ${String(activeShotPlan?.number ?? 1).padStart(2, '0')} · 视频候选`, provider: videoProvider.name, model: videoConnection.model, status: 'queued' as const, progress: 0, candidateCount, createdAt: new Date().toISOString() };
    const byRole = (role: 'start' | 'end' | 'middle') => sourceFrames.find((asset) => asset.metadata.frameRole === role && asset.selected)
      ?? sourceFrames.find((asset) => asset.metadata.frameRole === role);
    const startFrame = byRole('start') ?? selectedSourceFrames[0];
    const endFrame = byRole('end');
    const middleFrame = byRole('middle');
    const prompt = activePrompt;
    const referenceBindings = referenceBindingsFor(project, activeShotPlan, prompt.id);
    const projectWithRefs = withReferenceBindings(project, activeShotPlan.id, referenceBindings);
    commit({ ...projectWithRefs, jobs: [job, ...projectWithRefs.jobs] }, `已创建 ${candidateCount} 个${videoProvider.name}视频候选任务`);
    const durablePayload = { promptId: prompt.id, shotId: prompt.assetId, providerId: videoProvider.id, frameReferences: { start: startFrame.id, end: endFrame?.id ?? null, middle: middleFrame?.id ?? null }, referenceBindings, aspectRatio: project.aspectRatio, duration: activeShotPlan?.duration ?? 5, generateAudio: generateNativeAudio, taskIds: [] as string[] };
    try {
      await persistGenerationJob(job, durablePayload);
    } catch (error) {
      failLocalGenerationJob(jobId, `本地任务记录失败，未提交视频供应商：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setProject((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === jobId ? { ...item, status: 'generating' as const, progress: 5 } : item) }));
    persistJobStatus(jobId, 'generating');
    const sleep = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
    const request = {
      providerId: videoProvider.id as 'bytedance-video' | 'grok-video' | 'gemini-video', baseUrl: videoConnection.baseUrl, apiKey: videoConnection.apiKey,
      model: videoConnection.model, prompt: `${prompt.text}\nNegative constraints: ${prompt.negativeText}`,
      aspectRatio: project.aspectRatio, duration: Math.min(8, Math.max(2, activeShotPlan?.duration ?? 5)),
      startFrameUrl: mediaProviderSource(startFrame), endFrameUrl: endFrame ? mediaProviderSource(endFrame) : undefined, middleFrameUrl: middleFrame ? mediaProviderSource(middleFrame) : undefined,
      referenceImageUrls: referenceBindings.map((binding) => binding.sourceUrl), generateAudio: generateNativeAudio,
    };
    pendingVideoTasks.current[jobId] = { providerId: request.providerId, baseUrl: request.baseUrl, apiKey: request.apiKey, taskIds: [] };
    let pollingPersisted = false;
    const results = await Promise.allSettled(Array.from({ length: candidateCount }, async (_, candidateIndex) => {
      let task = await submitVideoGeneration({ ...request, clientRequestId: `${jobId}-${candidateIndex + 1}` });
      const pending = pendingVideoTasks.current[jobId];
      if (pending && !pending.taskIds.includes(task.taskId)) pending.taskIds.push(task.taskId);
      try {
        await appendGenerationTaskId(jobId, task.taskId);
      } catch (error) {
        await cancelVideoGeneration({ providerId: request.providerId, baseUrl: request.baseUrl, apiKey: request.apiKey, taskId: task.taskId }).catch(() => undefined);
        throw new Error(`视频任务已提交，但本地任务记录失败：${error instanceof Error ? error.message : String(error)}。已尝试取消远端任务。`);
      }
      if (cancelledVideoJobs.current.has(jobId)) {
        await cancelVideoGeneration({ providerId: request.providerId, baseUrl: request.baseUrl, apiKey: request.apiKey, taskId: task.taskId });
        return { ...task, status: 'cancelled' as const, outputUrls: [] };
      }
      for (let attempt = 0; attempt < 90 && !['succeeded', 'failed', 'cancelled'].includes(task.status); attempt += 1) {
        if (cancelledVideoJobs.current.has(jobId)) return { ...task, status: 'cancelled' as const, outputUrls: [] };
        await sleep(2500);
        if (cancelledVideoJobs.current.has(jobId)) return { ...task, status: 'cancelled' as const, outputUrls: [] };
        task = await pollVideoGeneration({ providerId: request.providerId, baseUrl: request.baseUrl, apiKey: request.apiKey, taskId: task.taskId });
        const progress = Math.min(95, task.progress ?? 10 + Math.round((attempt / 90) * 80));
        setProject((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === jobId ? { ...item, status: 'polling' as const, progress } : item) }));
        if (!pollingPersisted) { pollingPersisted = true; persistJobStatus(jobId, 'polling'); }
      }
      if (task.status !== 'succeeded' || !task.outputUrls.length) throw new Error(task.error || `视频任务 ${task.taskId} 未返回可用视频`);
      return task;
    }));
    const succeeded = results.flatMap((result) => result.status === 'fulfilled' && result.value.status === 'succeeded' ? [result.value] : []);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    const wasCancelled = cancelledVideoJobs.current.has(jobId);
    const terminalStatus = wasCancelled ? 'cancelled' as const : succeeded.length ? 'succeeded' as const : errors.length ? 'unknown' as const : 'failed' as const;
    const cachedVideos = await Promise.all(succeeded.map(async (task, index) => ({ task, url: await cacheMediaAsset(task.outputUrls[0], 'video', `${jobId}-${index}.mp4`) })));
    let generatedVideoAssets: CandidateAsset[] = [];
    setProject((current) => {
      const videos: CandidateAsset[] = cachedVideos.map(({ task, url }, index) => ({
        id: `${jobId}_${index}`, jobId, kind: 'video', label: `视频候选 ${String(index + 1).padStart(2, '0')}`,
        url, promptId: prompt.id, provider: task.provider, model: task.model ?? videoConnection.model,
        createdAt: new Date().toISOString(), selected: false,
        metadata: { duration: request.duration, ratio: current.aspectRatio, startFrame: startFrame.id, endFrame: endFrame?.id ?? 'none', middleFrame: middleFrame?.id ?? 'none', referenceBindingIds: referenceBindings.map((binding) => binding.id).join(','), generateAudio: generateNativeAudio, providerTaskId: task.taskId, sourceUrl: task.outputUrls[0], localCached: url !== task.outputUrls[0] },
      }));
      generatedVideoAssets = videos;
      const jobs = current.jobs.map((item) => item.id === jobId ? { ...item, status: terminalStatus, progress: terminalStatus === 'cancelled' ? 0 : 100, error: errors.join('\n') || undefined } : item);
      const next = { ...current, jobs, candidates: [...videos, ...current.candidates] };
      persistProject(next);
      return next;
    });
    await Promise.all(generatedVideoAssets.map((asset) => runAssetQc(asset, true)));
    const knownTaskIds = pendingVideoTasks.current[jobId]?.taskIds ?? [];
    if (terminalStatus === 'unknown') {
      setDurableJobs((current) => [...current.filter((item) => item.id !== jobId), { id: jobId, projectId: project.id, kind: 'video', status: 'unknown', payload: { ...durablePayload, taskIds: knownTaskIds }, createdAt: job.createdAt, updatedAt: new Date().toISOString() }]);
    }
    delete pendingVideoTasks.current[jobId];
    cancelledVideoJobs.current.delete(jobId);
    persistJobStatus(jobId, terminalStatus);
    notice(terminalStatus === 'cancelled' ? '视频生成已取消' : succeeded.length ? `已返回 ${succeeded.length} 个 ${videoProvider.name} 视频候选` : terminalStatus === 'unknown' ? '视频提交结果未知，请先检查供应商任务，再决定是否重试' : '视频生成失败，请检查供应商端点、模型和密钥');
  };
  const generateCards = async () => {
    if (!activePrompt) { notice('请先为当前镜头创建提示词'); return; }
    if (!imageConnection.apiKey) { setSettingsProvider(provider); setShowSettings(true); notice('请先配置 GPT Image API key'); return; }
    const activeShotPlan = project.shots.find((shot) => shot.id === activePrompt.assetId);
    if (!activeShotPlan) { notice('当前提示词没有对应镜头'); return; }
    const jobId = `job_${crypto.randomUUID()}`;
    const frameLabel = frameRole === 'start' ? '起始帧' : frameRole === 'end' ? '末帧' : '中间帧';
    const frameInstruction = frameRole === 'start' ? 'Establish the opening composition and character placement.' : frameRole === 'end' ? 'Resolve the action in its final composition while preserving the same characters and setting.' : 'Capture the pivotal mid-action beat while preserving continuity from the opening frame.';
    const referenceBindings = referenceBindingsFor(project, activeShotPlan, activePrompt.id, frameRole);
    const referenceImages = referenceBindings.map((binding) => binding.sourceUrl);
    const referenceAssetIds = referenceBindings.map((binding) => binding.assetId).filter((id): id is string => Boolean(id));
    const job = { id: jobId, kind: 'image' as const, title: `镜头 ${String(activeShotPlan?.number ?? 1).padStart(2, '0')} · ${frameLabel}`, provider: provider.name, model: imageConnection.model, status: 'queued' as const, progress: 0, candidateCount, createdAt: new Date().toISOString() };
    const projectWithRefs = withReferenceBindings(project, activeShotPlan.id, referenceBindings);
    commit({ ...projectWithRefs, jobs: [job, ...projectWithRefs.jobs] }, `已创建 ${candidateCount} 个候选生成任务`);
    try {
      await persistGenerationJob(job, { promptId: activePrompt.id, shotId: activePrompt.assetId, frameRole, aspectRatio: project.aspectRatio, characterVariantIds: activePrompt.characterVariantIds, referenceAssetIds, referenceBindings });
    } catch (error) {
      failLocalGenerationJob(jobId, `本地任务记录失败，未提交图片供应商：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setProject((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === jobId ? { ...item, status: 'generating' as const, progress: 5 } : item) }));
    persistJobStatus(jobId, 'generating');
    try {
      const results = (await Promise.all(Array.from({ length: candidateCount }, () => generateGptImage({
        baseUrl: imageConnection.baseUrl, apiKey: imageConnection.apiKey, model: imageConnection.model,
        prompt: `${activePrompt.text}\n${frameInstruction}\nUse the attached canonical character references and continuity frames when provided.`, size: project.aspectRatio === '9:16' ? '1024x1536' : '1536x1024', quality: 'medium',
        referenceImages,
      })))).flat();
      if (!results.length) throw new Error('未收到图片候选，请在桌面端检查模型连接');
      const cachedUrls = await Promise.all(results.map((result, index) => cacheMediaAsset(result.url, 'image', `${jobId}-${index}.png`)));
      setProject((current) => {
        const completedJobs = current.jobs.map((item) => item.id === jobId ? { ...item, status: 'succeeded' as const, progress: 100 } : item);
        const returned = results.map((result, index) => ({ id: `${jobId}_asset_${index}`, jobId, kind: 'image' as const, label: `${frameLabel}候选 ${String(index + 1).padStart(2, '0')}`, url: cachedUrls[index], promptId: activePrompt.id, provider: result.provider, model: result.model, createdAt: new Date().toISOString(), selected: false, metadata: { ratio: current.aspectRatio, reference: referenceImages.length > 0, frameRole, referenceAssetIds: referenceAssetIds.join(','), seed: 'provider-managed', sourceUrl: result.url, localCached: cachedUrls[index] !== result.url } }));
        const next = { ...current, jobs: completedJobs, candidates: [...returned, ...current.candidates] };
        persistProject(next);
        return next;
      });
      persistJobStatus(jobId, 'succeeded');
      notice(`已返回 ${results.length} 个 GPT Image 候选`);
    } catch (error) {
      setProject((current) => {
        const next = { ...current, jobs: current.jobs.map((item) => item.id === jobId ? { ...item, status: 'failed' as const, error: error instanceof Error ? error.message : String(error) } : item) };
        persistProject(next);
        return next;
      });
      persistJobStatus(jobId, 'failed');
      notice('GPT Image 请求失败，请检查端点、模型和 API key');
    }
  };
  const resumeVideoJob = async (durable: DurableGenerationJob) => {
    const payload = durable.payload;
    const providerId = payload.providerId;
    if (providerId !== 'bytedance-video' && providerId !== 'grok-video' && providerId !== 'gemini-video') return;
    const connection = connections[providerId];
    if (!connection?.apiKey) return;
    if (resumedVideoJobs.current.has(durable.id)) return;
    resumedVideoJobs.current.add(durable.id);
    const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
    const promptId = typeof payload.promptId === 'string' ? payload.promptId : '';
    const prompt = project.prompts.find((item) => item.id === promptId);
    const duration = typeof payload.duration === 'number' && payload.duration > 0 ? payload.duration : 5;
    const generateAudio = payload.generateAudio === true;
    const failRecovery = (message: string) => {
      setProject((current) => {
        const next = { ...current, jobs: current.jobs.map((item) => item.id === durable.id ? { ...item, status: 'failed' as const, error: message } : item) };
        persistProject(next);
        return next;
      });
      persistJobStatus(durable.id, 'failed');
      setDurableJobs((current) => current.filter((item) => item.id !== durable.id));
      notice(message);
    };
    if (!prompt || !taskIds.length) {
      failRecovery('视频任务在提交前被中断，未重新提交以避免重复计费。请在该镜头重新生成。');
      return;
    }
    const currentProvider = providers.find((item) => item.id === providerId);
    pendingVideoTasks.current[durable.id] = { providerId, baseUrl: connection.baseUrl, apiKey: connection.apiKey, taskIds };
    setProject((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === durable.id ? { ...item, status: 'polling' as const, progress: Math.max(item.progress, 10) } : item) }));
    persistJobStatus(durable.id, 'polling');
    const sleep = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
    const results = await Promise.allSettled(taskIds.map(async (taskId) => {
      let task = await pollVideoGeneration({ providerId, baseUrl: connection.baseUrl, apiKey: connection.apiKey, taskId });
      for (let attempt = 0; attempt < 90 && !['succeeded', 'failed', 'cancelled'].includes(task.status); attempt += 1) {
        if (cancelledVideoJobs.current.has(durable.id)) return { ...task, status: 'cancelled' as const, outputUrls: [] };
        await sleep(2500);
        task = await pollVideoGeneration({ providerId, baseUrl: connection.baseUrl, apiKey: connection.apiKey, taskId });
        const progress = Math.min(95, task.progress ?? 10 + Math.round((attempt / 90) * 80));
        setProject((current) => ({ ...current, jobs: current.jobs.map((item) => item.id === durable.id ? { ...item, status: 'polling' as const, progress } : item) }));
      }
      if (task.status !== 'succeeded' || !task.outputUrls.length) throw new Error(task.error || `视频任务 ${task.taskId} 未返回可用视频`);
      return task;
    }));
    const succeeded = results.flatMap((result) => result.status === 'fulfilled' && result.value.status === 'succeeded' && result.value.outputUrls.length ? [result.value] : []);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    const terminalStatus = cancelledVideoJobs.current.has(durable.id) ? 'cancelled' as const : succeeded.length ? 'succeeded' as const : errors.length ? 'unknown' as const : 'failed' as const;
    const cachedVideos = await Promise.all(succeeded.map(async (task, index) => ({ task, url: await cacheMediaAsset(task.outputUrls[0], 'video', `${durable.id}-recovered-${index}.mp4`) })));
    let recoveredVideoAssets: CandidateAsset[] = [];
    setProject((current) => {
      const videos: CandidateAsset[] = cachedVideos.map(({ task, url }, index) => ({
        id: `${durable.id}_recovered_${index}`, jobId: durable.id, kind: 'video', label: `视频候选 ${String(index + 1).padStart(2, '0')}`,
        url, promptId, provider: task.provider, model: task.model ?? connection.model, createdAt: new Date().toISOString(), selected: false,
        metadata: { duration, ratio: current.aspectRatio, generateAudio, providerTaskId: task.taskId, recoveredAfterRestart: true, localCached: url !== task.outputUrls[0] },
      }));
      recoveredVideoAssets = videos;
      const jobs = current.jobs.map((item) => item.id === durable.id ? { ...item, status: terminalStatus, progress: terminalStatus === 'cancelled' ? 0 : 100, error: errors.join('\n') || undefined } : item);
      const next = { ...current, jobs, candidates: [...videos, ...current.candidates.filter((asset) => asset.jobId !== durable.id)] };
      persistProject(next);
      return next;
    });
    await Promise.all(recoveredVideoAssets.map((asset) => runAssetQc(asset, true)));
    delete pendingVideoTasks.current[durable.id];
    cancelledVideoJobs.current.delete(durable.id);
    persistJobStatus(durable.id, terminalStatus);
    setDurableJobs((current) => terminalStatus === 'unknown'
      ? current.map((item) => item.id === durable.id ? { ...item, status: 'unknown' as const, updatedAt: new Date().toISOString() } : item)
      : current.filter((item) => item.id !== durable.id));
    notice(terminalStatus === 'cancelled' ? '恢复的视频任务已取消' : succeeded.length ? `已恢复 ${succeeded.length} 个 ${currentProvider?.name ?? '视频'} 候选` : terminalStatus === 'unknown' ? '远端任务状态仍未知，可使用任务列表重新轮询' : '恢复的视频任务未返回候选');
  };

  const recheckVideoJob = (jobId: string) => {
    const durable = durableJobs.find((item) => item.id === jobId);
    if (!durable) { notice('找不到可重新轮询的视频任务记录'); return; }
    const taskIds = Array.isArray(durable.payload.taskIds) ? durable.payload.taskIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
    if (!taskIds.length) { notice('没有远端任务 ID，无法安全重新轮询；请重新提交生成'); return; }
    resumedVideoJobs.current.delete(jobId);
    void resumeVideoJob({ ...durable, status: 'unknown' });
  };

  useEffect(() => {
    for (const durable of durableJobs) {
      if (durable.kind === 'video' && ['queued', 'generating', 'polling'].includes(durable.status)) void resumeVideoJob(durable);
    }
  }, [durableJobs, connections, project.id]);

  return <div className="app-shell">
    <aside className="rail">
      <div className="brand"><div className="brand-mark"><img src="/frameforge-logo-v3.svg" alt="Frameforge" /></div><span>FRAMEFORGE</span></div>
      <div className="project-switcher"><span>项目</span><label><span className="project-initial">{project.name.slice(0, 1)}</span><select value={project.id} onChange={(event) => void switchProject(event.target.value)} aria-label="切换项目">{availableProjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={14} /></label></div>
      <nav className="stage-nav" aria-label="创作阶段">
        {stageMeta.map(({ id, icon: Icon, caption }) => <button key={id} className={stage === id ? 'active' : ''} onClick={() => setStage(id)}><Icon size={18} /><span><b>{id}</b><small>{caption}</small></span>{stage === id && <ChevronRight size={15} />}</button>)}
      </nav>
      <div className="rail-bottom">
        <button onClick={() => setShowAssetLibrary(true)}><FolderOpen size={17} />素材库</button>
        <button onClick={() => setShowSettings(true)}><Settings2 size={17} />模型与设置</button>
        <div className="usage"><span><Gauge size={15} /> 本月生成</span><b>38 / 自带密钥</b></div>
      </div>
    </aside>

    <main className="workbench">
      <input ref={sourceInput} className="visually-hidden" type="file" accept=".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => void importStory(event)} />
      <header className="topbar">
        <div className="breadcrumbs"><button className="mobile-menu" aria-label="菜单"><Menu size={20} /></button><span>项目</span><ChevronRight size={14} /><b>{project.name}</b><span className="sync-dot">已保存到本地</span></div>
        <div className="top-actions"><IconButton label="撤销"><RotateCcw size={17} /></IconButton><IconButton label="导入项目包" onClick={() => void importPackage()}><FolderOpen size={17} /></IconButton><button className="export-button" disabled={isProjectPackageBusy} onClick={() => void exportPackage()}><Upload size={16} />{isProjectPackageBusy ? '处理中...' : '导出项目包'}</button></div>
      </header>

      <section className="project-head">
        <div><div className="eyebrow">{project.episodes?.length ? `EP${String(project.episodes[0].number).padStart(2, '0')} · ${project.episodes[0].status === 'approved' ? '已确认' : '改编中'}` : 'STORY ROOM · 改编中'}</div><h1>{project.name}</h1><p>{project.logline}</p></div>
        <div className="project-metrics"><div><b>{Math.floor(totalDuration / 60).toString().padStart(2, '0')}:{Math.round(totalDuration % 60).toString().padStart(2, '0')}</b><span>预计片长</span></div><div><b>{activeShots.length}</b><span>已拆镜头</span></div><div><b>{project.aspectRatio}</b><span>主画幅</span></div></div>
      </section>

      <section className="approval-strip">
        <div className="workflow-steps">{stageMeta.map(({ id, icon: Icon }, index) => <button key={id} onClick={() => setStage(id)} className={stage === id ? 'current' : index < stageMeta.findIndex((item) => item.id === stage) ? 'complete' : ''}><span>{index < stageMeta.findIndex((item) => item.id === stage) ? <Check size={13} /> : <Icon size={14} />}</span>{id}</button>)}</div>
        <div className="approval-callout"><Sparkles size={15} /><span>每一步确认后，素材和提示词都会保留版本记录。</span></div>
      </section>

      <div className="canvas">
        <section className="primary-panel">
          {stage === '故事' && <StoryStage project={project} activeEpisodeId={activeEpisodeId} setActiveEpisodeId={setActiveEpisodeId} toggleChapter={toggleChapter} updateChapter={updateChapter} updateScene={updateScene} approveScene={approveScene} adaptStory={() => void adaptStory()} adapting={isAdapting} openImport={() => sourceInput.current?.click()} />}
          {stage === '角色' && <CharacterStage project={project} extracting={isExtractingCharacters} onExtract={() => void extractCharacters()} portraitJob={portraitJob} onGeneratePortrait={(id) => void generatePortraits(id)} onAddCharacter={addCharacter} onUpdateCharacter={updateCharacter} onSelectPortrait={selectPortrait} onAddVariant={addAppearanceVariant} onSelectVariant={selectAppearanceVariant} onUpdateVariant={updateAppearanceVariant} onApproveVariant={approveAppearanceVariant} onSaveStyleGuide={updateStyleGuide} onApprove={(id) => commit({ ...project, characters: project.characters.map((person) => person.id === id ? { ...person, status: 'approved' } : person) }, '角色标准形象已确认')}/>}
          {stage === '分镜' && <StoryboardStage project={project} activeEpisodeId={activeEpisodeId} setActiveEpisodeId={setActiveEpisodeId} activeShot={activeShot} setActiveShot={setActiveShot} planning={isPlanningShots} onPlan={() => void planShots()} onUpdateShot={updateShot} onApproveShot={approveShot} />}
          {stage === '素材' && <AssetsStage project={project} activeShot={activeShot} prompt={activePrompt} selectedAsset={selectedAsset} candidateCount={candidateCount} setCandidateCount={setCandidateCount} selectCandidate={selectCandidate} generateCards={() => void generateCards()} assetMode={assetMode} setAssetMode={setAssetMode} generateNativeAudio={generateNativeAudio} setGenerateNativeAudio={setGenerateNativeAudio} frameRole={frameRole} setFrameRole={setFrameRole} videoProvider={videoProvider} setVideoProvider={setVideoProvider} generateVideoCards={() => void generateVideoCards()} provider={provider} editingPrompt={editingPrompt} setEditingPrompt={setEditingPrompt} revisePrompt={revisePrompt} qcBusyAssetId={qcBusyAssetId} onRunQc={(asset) => void runAssetQc(asset)} onSetQcStatus={setAssetQcStatus} onSetStoryboard={setStoryboard} />}
          {stage === '合成' && <AssemblyStage project={project} notice={notice} exporting={isFinalCutExporting} voiceGenerating={isVoiceGenerating} onExport={(options) => void exportFinalCutToFile(options)} onGenerateVoice={() => void generateVoiceTrack()} onImportAudio={(kind) => void importAudioTrack(kind)} onToggleAudio={toggleAudioTrack} onUpdateAudio={updateAudioTrack} onToggleTimeline={toggleTimelineClip} onMoveTimeline={moveTimelineClip} onUpdateTimelineDuration={updateTimelineDuration} onResetTimeline={resetTimeline} onGenerateSubtitles={generateSubtitleDraft} onUpdateSubtitle={updateSubtitle} />}
          {stage === '画布' && <WorkspaceCanvas key={project.id} project={project} activeShot={activeShot} onSelectShot={(shotId) => {
            const shot = project.shots.find((item) => item.id === shotId);
            if (!shot) return;
            const episode = project.episodes?.find((item) => item.sceneId === shot.sceneId);
            setActiveEpisodeId(episode?.id ?? shot.sceneId);
            setActiveShot(shotId);
            setStage('素材');
          }} />}
        </section>
        <Inspector project={project} stage={stage} activeShot={activeShot} selectedAsset={selectedAsset} setShowSettings={setShowSettings} cancelVideoJob={cancelVideoJob} recheckVideoJob={recheckVideoJob} />
      </div>
      {toast && <div className="toast"><Check size={17} />{toast}</div>}
      {showAssetLibrary && <AssetLibrary project={project} close={() => setShowAssetLibrary(false)} onOpenAsset={(asset) => {
        const prompt = project.prompts.find((item) => item.id === asset.promptId);
        const shot = project.shots.find((item) => item.id === prompt?.assetId);
        if (shot) {
          const episode = project.episodes?.find((item) => item.sceneId === shot.sceneId);
          setActiveEpisodeId(episode?.id ?? shot.sceneId);
          setActiveShot(shot.id);
          setStage('素材');
        }
        setShowAssetLibrary(false);
      }} />}
      {showSettings && <ProviderSettings key={settingsProvider.id} provider={settingsProvider} setProvider={setSettingsProvider} connection={connections[settingsProvider.id]} setConnections={setConnections} close={() => setShowSettings(false)} notice={notice} />}
    </main>
  </div>;
}

function SectionTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) { return <div className="section-title"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div>{children}</div>; }

function StoryStage({ project, activeEpisodeId, setActiveEpisodeId, toggleChapter, updateChapter, updateScene, approveScene, adaptStory, adapting, openImport }: { project: Project; activeEpisodeId: string; setActiveEpisodeId: (id: string) => void; toggleChapter: (id: string) => void; updateChapter: (id: string, changes: Partial<Project['chapters'][number]>) => void; updateScene: (id: string, changes: Partial<Project['scenes'][number]>) => void; approveScene: () => void; adaptStory: () => void; adapting: boolean; openImport: () => void }) {
  const fallbackEpisode = project.scenes[0] ? [{ id: project.scenes[0].id, number: 1, title: 'EP01', chapterIds: [], synopsis: '', sceneId: project.scenes[0].id, status: project.scenes[0].status }] : [];
  const episodes = project.episodes?.length ? project.episodes : fallbackEpisode;
  const episode = episodes.find((item) => item.id === activeEpisodeId) ?? episodes[0];
  const scene = project.scenes.find((item) => item.id === episode?.sceneId) ?? project.scenes[0];
  if (!scene) return <><SectionTitle eyebrow="STORY ROOM" title="章节改编"><button className="quiet-action" onClick={openImport}><Upload size={15} />导入文本</button></SectionTitle><div className="empty-story"><FileText size={28} /><h3>导入小说或剧本</h3><p>支持 TXT、Markdown 与 DOCX。导入后会自动识别章节，并为短剧改编创建初稿。</p><button className="primary-button" onClick={openImport}><Upload size={16} />选择本地文件</button></div></>;
  return <><SectionTitle eyebrow="STORY ROOM" title="章节改编"><div className="section-actions"><button className="quiet-action" onClick={openImport}><Upload size={15} />导入文本</button><button className="primary-button" disabled={adapting} onClick={adaptStory}><WandSparkles size={15} />{adapting ? '改编中...' : 'AI 改编初稿'}</button></div></SectionTitle>
    <div className="episode-tabs" role="tablist" aria-label="短剧集数">{episodes.map((item) => <button key={item.id} className={item.id === episode?.id ? 'active' : ''} onClick={() => setActiveEpisodeId(item.id)} role="tab" aria-selected={item.id === episode?.id}><span>EP{String(item.number).padStart(2, '0')}</span><b>{item.title}</b></button>)}</div><div className="source-card"><div className="source-file"><FileText size={22} /><div><b>{project.source?.name}</b><span>{project.source?.format.toUpperCase()} · 已解析 {project.chapters.length} 章 · 当前第 {episode?.number ?? 1} 集</span></div></div><button className="text-button" onClick={openImport}>更换</button></div>
    <div className="chapter-list">{project.chapters.map((chapter) => <article key={chapter.id} className={`chapter ${chapter.selected ? 'chosen' : ''}`}><button className="chapter-toggle" onClick={() => toggleChapter(chapter.id)} aria-pressed={chapter.selected}><span className="chapter-number">{String(chapter.number).padStart(2, '0')}</span><div><b>{chapter.title}</b><small>{chapter.wordCount.toLocaleString()} 字</small></div><span className="check-circle">{chapter.selected && <Check size={14} />}</span></button><label className="chapter-summary">短剧保留摘要<textarea value={chapter.summary} onChange={(event) => updateChapter(chapter.id, { summary: event.target.value })} /></label></article>)}</div>
    <div className="script-card"><div className="script-card-head"><div><span className="pill">EP{String(episode?.number ?? 1).padStart(2, '0')} 初稿</span><Status value={scene.status} /></div><button className="text-button" disabled={adapting} onClick={adaptStory}><WandSparkles size={15} />重新改写全部选中集</button></div><div className="script-editor"><label>场景<input value={scene.heading} onChange={(event) => updateScene(scene.id, { heading: event.target.value })} /></label><label>动作<textarea value={scene.action} onChange={(event) => updateScene(scene.id, { action: event.target.value })} /></label><label>台词<textarea value={scene.dialogue} onChange={(event) => updateScene(scene.id, { dialogue: event.target.value })} /></label><div className="script-editor-pair"><label>情绪<textarea value={scene.emotionalBeat} onChange={(event) => updateScene(scene.id, { emotionalBeat: event.target.value })} /></label><label>结尾钩子<textarea value={scene.hook} onChange={(event) => updateScene(scene.id, { hook: event.target.value })} /></label></div></div><div className="script-foot"><span>编辑后需重新确认，才可进入镜头拆分</span><button className="primary-button" onClick={approveScene}><Check size={16} />确认剧本</button></div></div>
  </>;
}

function CharacterStage({ project, extracting, onExtract, portraitJob, onGeneratePortrait, onAddCharacter, onUpdateCharacter, onSelectPortrait, onAddVariant, onSelectVariant, onUpdateVariant, onApproveVariant, onSaveStyleGuide, onApprove }: { project: Project; extracting: boolean; onExtract: () => void; portraitJob: string | null; onGeneratePortrait: (id: string) => void; onAddCharacter: () => void; onUpdateCharacter: (characterId: string, changes: Pick<Character, 'name' | 'role' | 'bio'>) => void; onSelectPortrait: (id: string, asset: CandidateAsset) => void; onAddVariant: (id: string) => void; onSelectVariant: (characterId: string, variantId: string) => void; onUpdateVariant: (characterId: string, variantId: string, changes: Partial<Character['variants'][number]>) => void; onApproveVariant: (characterId: string, variantId: string) => void; onSaveStyleGuide: (styleGuide: Project['styleGuide']) => void; onApprove: (id: string) => void }) {
  if (!project.characters.length) return <><SectionTitle eyebrow="CAST BIBLE" title="角色与造型"><div className="section-actions"><button className="quiet-action" onClick={onAddCharacter}><Plus size={15} />新建角色</button><button className="primary-button" disabled={extracting} onClick={onExtract}><Sparkles size={15} />{extracting ? '提取中...' : '从剧本提取角色'}</button></div></SectionTitle><StyleGuidePanel key={`${project.styleGuide.genre}-${project.styleGuide.visualStyle}`} styleGuide={project.styleGuide} onSave={onSaveStyleGuide} /><div className="empty-stage"><ScanFace size={28} /><h3>尚未生成角色档案</h3><p>确认短剧剧本后，系统会提取角色画像、标准形象与剧情阶段造型。</p></div></>;
  return <><SectionTitle eyebrow="CAST BIBLE" title="角色与造型"><div className="section-actions"><button className="quiet-action" onClick={onAddCharacter}><Plus size={15} />新建角色</button><button className="primary-button" disabled={extracting} onClick={onExtract}><Sparkles size={15} />{extracting ? '提取中...' : '重新提取角色'}</button></div></SectionTitle><StyleGuidePanel key={`${project.styleGuide.genre}-${project.styleGuide.visualStyle}`} styleGuide={project.styleGuide} onSave={onSaveStyleGuide} /><div className="cast-grid">{project.characters.map((person) => {
    const portraitOptions = project.candidates.filter((asset) => asset.metadata.characterId === person.id && asset.metadata.assetRole === 'canonical-portrait');
    const activeVariant = person.variants.find((variant) => variant.id === person.activeVariantId) ?? person.variants[0];
    return <article className="character-card" key={person.id}>{person.portraitUrl ? <img src={mediaDisplayUrl(person.portraitUrl)} alt={`${person.name}角色画像`} /> : <div className="portrait-placeholder"><ScanFace size={32} /><span>{person.name.slice(0, 1)}</span></div>}<div className="character-card-body"><div className="row-between"><div className="character-editor"><label>人物定位<input defaultValue={person.role} onBlur={(event) => onUpdateCharacter(person.id, { name: person.name, role: event.target.value, bio: person.bio })} /></label><label>角色名称<input defaultValue={person.name} onBlur={(event) => onUpdateCharacter(person.id, { name: event.target.value, role: person.role, bio: person.bio })} /></label></div><Status value={person.status} /></div><label className="character-bio">人物设定<textarea defaultValue={person.bio} onBlur={(event) => onUpdateCharacter(person.id, { name: person.name, role: person.role, bio: event.target.value })} /></label><div className="variant-list">{person.variants.map((variant) => <button key={variant.id} className={activeVariant?.id === variant.id ? 'active' : ''} onClick={() => onSelectVariant(person.id, variant.id)}><i></i>{variant.label} · {variant.storyRange}</button>)}<button className="add-variant" onClick={() => onAddVariant(person.id)}><Plus size={12} />新增剧情造型</button></div>{activeVariant && <div className="variant-editor"><div className="variant-editor-head"><b>当前剧情造型</b><Status value={activeVariant.status} /></div><label>名称<input value={activeVariant.label} onChange={(event) => onUpdateVariant(person.id, activeVariant.id, { label: event.target.value })} /></label><label>剧情段<input value={activeVariant.storyRange} onChange={(event) => onUpdateVariant(person.id, activeVariant.id, { storyRange: event.target.value })} /></label><label>服装、妆容、皮肤与状态<textarea value={activeVariant.description} onChange={(event) => onUpdateVariant(person.id, activeVariant.id, { description: event.target.value })} /></label><div className="variant-editor-actions"><button className="text-button" onClick={() => onSelectVariant(person.id, activeVariant.id)}>应用到镜头</button>{activeVariant.status !== 'approved' && <button className="small-primary" onClick={() => onApproveVariant(person.id, activeVariant.id)}><Check size={14} />确认造型</button>}</div></div>}{portraitOptions.length > 0 && <div className="portrait-options">{portraitOptions.map((asset, index) => <button key={asset.id} className={person.referenceIds.includes(asset.id) ? 'active' : ''} onClick={() => onSelectPortrait(person.id, asset)} title={`选用形象 ${index + 1}`}><img src={mediaDisplayUrl(asset.url)} alt={`${person.name}形象候选 ${index + 1}`} /></button>)}</div>}<div className="card-actions"><button className="text-button" disabled={portraitJob === person.id} onClick={() => onGeneratePortrait(person.id)}><ImagePlus size={15} />{portraitJob === person.id ? '生成中...' : person.referenceIds.length ? '重抽角色图' : '抽取角色图'}</button>{person.status !== 'approved' && person.referenceIds.length > 0 && <button className="small-primary" onClick={() => onApprove(person.id)}><Check size={14} />确认形象</button>}</div></div></article>;
  })}</div></>;
}

function StyleGuidePanel({ styleGuide, onSave }: { styleGuide: Project['styleGuide']; onSave: (styleGuide: Project['styleGuide']) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(styleGuide);
  const update = (field: keyof Project['styleGuide'], value: string) => setDraft((current) => ({ ...current, [field]: value }));
  return <div className={`style-guide ${editing ? 'editing' : ''}`}><div className="style-icon"><WandSparkles size={19} /></div>{editing ? <div className="style-guide-editor"><div className="style-guide-grid"><label>类型<input value={draft.genre} onChange={(event) => update('genre', event.target.value)} /></label><label>时代<input value={draft.era} onChange={(event) => update('era', event.target.value)} /></label></div><label>视觉风格<textarea value={draft.visualStyle} onChange={(event) => update('visualStyle', event.target.value)} /></label><label>色彩语言<textarea value={draft.colorLanguage} onChange={(event) => update('colorLanguage', event.target.value)} /></label><label>镜头语言<textarea value={draft.cameraLanguage} onChange={(event) => update('cameraLanguage', event.target.value)} /></label><label>画面约束<textarea value={draft.constraints} onChange={(event) => update('constraints', event.target.value)} /></label><label>负面约束<textarea value={draft.negativeConstraints} onChange={(event) => update('negativeConstraints', event.target.value)} /></label><div className="style-guide-actions"><button className="quiet-action" onClick={() => setEditing(false)}>取消</button><button className="primary-button" onClick={() => { onSave(draft); setEditing(false); }}><Check size={16} />保存并更新镜头</button></div></div> : <><div><b>{styleGuide.visualStyle}</b><p>{styleGuide.colorLanguage} · {styleGuide.cameraLanguage}</p></div><button className="text-button" onClick={() => setEditing(true)}>编辑风格手册</button></>}</div>;
}

function StoryboardStage({ project, activeEpisodeId, setActiveEpisodeId, activeShot, setActiveShot, planning, onPlan, onUpdateShot, onApproveShot }: { project: Project; activeEpisodeId: string; setActiveEpisodeId: (id: string) => void; activeShot: string; setActiveShot: (id: string) => void; planning: boolean; onPlan: () => void; onUpdateShot: (id: string, changes: Partial<Project['shots'][number]>) => void; onApproveShot: (id: string) => void }) {
  if (!project.scenes.length) return <><SectionTitle eyebrow="SHOT DESIGN" title="镜头规划" /><div className="empty-stage"><Clapperboard size={28} /><h3>等待已确认的剧本</h3><p>先在故事阶段确认短剧剧本，再自动拆解为可编辑镜头。</p></div></>;
  const fallbackEpisode = [{ id: project.scenes[0].id, number: 1, title: 'EP01', chapterIds: [], synopsis: '', sceneId: project.scenes[0].id, status: project.scenes[0].status }];
  const episodes = project.episodes?.length ? project.episodes : fallbackEpisode;
  const episode = episodes.find((item) => item.id === activeEpisodeId) ?? episodes[0];
  const scene = project.scenes.find((item) => item.id === episode?.sceneId) ?? project.scenes[0];
  const visibleShots = project.shots.filter((shot) => shot.sceneId === scene.id && !shot.archived);
  const selected = visibleShots.find((shot) => shot.id === activeShot) ?? visibleShots[0];
  return <><SectionTitle eyebrow="SHOT DESIGN" title="镜头规划"><div className="section-actions"><button className="quiet-action" disabled={planning} onClick={onPlan}><Sparkles size={15} />{planning ? '拆解中...' : visibleShots.length ? '重新拆分本集' : 'AI 拆分本集'}</button></div></SectionTitle><div className="episode-tabs" role="tablist" aria-label="分镜集数">{episodes.map((item) => <button key={item.id} className={item.id === episode?.id ? 'active' : ''} onClick={() => setActiveEpisodeId(item.id)} role="tab" aria-selected={item.id === episode?.id}><span>EP{String(item.number).padStart(2, '0')}</span><b>{item.title}</b></button>)}</div><div className="scene-banner"><div><span className="pill">EP{String(episode?.number ?? 1).padStart(2, '0')} · 场景 01</span><h3>{scene.heading}</h3><p>{scene.action}</p></div><Status value={scene.status} /></div>{visibleShots.length ? <><div className="shot-stack">{visibleShots.map((shot) => <button key={shot.id} onClick={() => setActiveShot(shot.id)} className={`shot-row ${activeShot === shot.id ? 'selected' : ''}`}><span className="shot-index">{String(shot.number).padStart(2, '0')}</span><div className="frame-mini"><span></span></div><div className="shot-main"><div><b>{shot.framing}</b><small><Clock3 size={12} /> {shot.duration}s · {shot.aspectRatio}</small></div><p>{shot.action}</p><span className="audio-label"><Music2 size={13} />{shot.audioCue}</span></div><Status value={shot.status} /><ChevronRight size={17} /></button>)}</div>{selected && <ShotEditor key={selected.id} shot={selected} characters={project.characters} onSave={onUpdateShot} onApprove={onApproveShot} />}</> : <div className="inline-empty"><Clapperboard size={20} /><span>本集尚未生成镜头。先审核本集剧本，再使用 AI 拆分镜头。</span></div>}</>;
}

function ShotEditor({ shot, characters, onSave, onApprove }: { shot: Project['shots'][number]; characters: Character[]; onSave: (id: string, changes: Partial<Project['shots'][number]>) => void; onApprove: (id: string) => void }) {
  const [draft, setDraft] = useState({ framing: shot.framing, cameraMotion: shot.cameraMotion ?? '', duration: shot.duration, action: shot.action, audioCue: shot.audioCue, characters: shot.characters });
  const toggleCharacter = (characterId: string) => setDraft((current) => ({ ...current, characters: current.characters.includes(characterId) ? current.characters.filter((id) => id !== characterId) : [...current.characters, characterId] }));
  return <section className="shot-editor"><div className="shot-editor-head"><div><span className="eyebrow">SHOT {String(shot.number).padStart(2, '0')}</span><h3>镜头详情</h3></div><Status value={shot.status} /></div><div className="shot-editor-grid"><label>景别<input value={draft.framing} onChange={(event) => setDraft((current) => ({ ...current, framing: event.target.value }))} /></label><label>时长（秒）<input type="number" min="1" max="8" value={draft.duration} onChange={(event) => setDraft((current) => ({ ...current, duration: Math.max(1, Math.min(8, Number(event.target.value) || 1)) }))} /></label></div><label>镜头运动<input value={draft.cameraMotion} placeholder="例如：缓慢推近、跟拍、静止或手持" onChange={(event) => setDraft((current) => ({ ...current, cameraMotion: event.target.value }))} /></label><label>主体动作<textarea value={draft.action} onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))} /></label><label>声音提示<input value={draft.audioCue} onChange={(event) => setDraft((current) => ({ ...current, audioCue: event.target.value }))} /></label><div className="shot-cast"><span>出镜角色</span><div>{characters.map((character) => <label key={character.id}><input type="checkbox" checked={draft.characters.includes(character.id)} onChange={() => toggleCharacter(character.id)} />{character.name}</label>)}</div></div><div className="shot-editor-actions"><button className="quiet-action" onClick={() => onSave(shot.id, draft)}>保存并更新提示词</button>{shot.status !== 'approved' && <button className="primary-button" onClick={() => onApprove(shot.id)}><Check size={16} />确认镜头</button>}</div></section>;
}

function AssetsStage({ project, activeShot, prompt, selectedAsset, candidateCount, setCandidateCount, selectCandidate, generateCards, assetMode, setAssetMode, generateNativeAudio, setGenerateNativeAudio, frameRole, setFrameRole, videoProvider, setVideoProvider, generateVideoCards, provider, editingPrompt, setEditingPrompt, revisePrompt, qcBusyAssetId, onRunQc, onSetQcStatus, onSetStoryboard }: { project: Project; activeShot: string; prompt?: Project['prompts'][number]; selectedAsset?: CandidateAsset; candidateCount: number; setCandidateCount: (value: number) => void; selectCandidate: (id: string) => void; generateCards: () => void; assetMode: 'image' | 'video'; setAssetMode: (mode: 'image' | 'video') => void; generateNativeAudio: boolean; setGenerateNativeAudio: (value: boolean) => void; frameRole: 'start' | 'end' | 'middle'; setFrameRole: (role: 'start' | 'end' | 'middle') => void; videoProvider: ProviderProfile; setVideoProvider: (provider: ProviderProfile) => void; generateVideoCards: () => void; provider: ProviderProfile; editingPrompt: boolean; setEditingPrompt: (value: boolean) => void; revisePrompt: (promptId: string, text: string, negativeText: string) => void; qcBusyAssetId: string | null; onRunQc: (asset: CandidateAsset) => void; onSetQcStatus: (assetId: string, status: 'approved' | 'rejected') => void; onSetStoryboard: (asset: CandidateAsset) => void }) {
  const shot = project.shots.find((item) => item.id === activeShot);
  if (!prompt) return <><SectionTitle eyebrow="ASSET LAB" title="素材抽卡" /><div className="empty-stage"><ImagePlus size={28} /><h3>等待当前镜头的提示词</h3><p>请先在分镜阶段选择一个镜头并完成提示词拆解，再为起始帧、末帧和中间帧抽卡。</p></div></>;
  const visibleAssets = project.candidates.filter((asset) => asset.kind === assetMode && asset.promptId === prompt.id && (assetMode === 'video' || !asset.metadata.frameRole || asset.metadata.frameRole === frameRole));
  const activeProvider = assetMode === 'image' ? provider : videoProvider;
  return <><SectionTitle eyebrow="ASSET LAB" title={`镜头 ${String(shot?.number ?? 1).padStart(2, '0')} · ${assetMode === 'image' ? '图片抽卡' : '视频抽卡'}`}><div className="section-controls"><button className={`segmented ${assetMode === 'image' ? 'active' : ''}`} onClick={() => setAssetMode('image')}><ImagePlus size={15} />图片帧</button><button className={`segmented ${assetMode === 'video' ? 'active' : ''}`} onClick={() => setAssetMode('video')}><Video size={15} />视频</button></div></SectionTitle>
    {assetMode === 'image' && <div className="frame-role-tabs"><button className={frameRole === 'start' ? 'active' : ''} onClick={() => setFrameRole('start')}>起始帧</button><button className={frameRole === 'end' ? 'active' : ''} onClick={() => setFrameRole('end')}>末帧</button><button className={frameRole === 'middle' ? 'active' : ''} onClick={() => setFrameRole('middle')}>中间帧</button></div>}
    <div className="prompt-box"><div className="prompt-top"><span className="provider-dot"></span><b>{activeProvider.name} / {activeProvider.model}</b>{assetMode === 'image' ? <span className="reference-tag"><ScanFace size={13} />角色参考图已绑定</span> : <span className="reference-tag"><ImagePlus size={13} />起始帧与角色参考将随任务传入</span>}</div><p>{assetMode === 'image' ? prompt.text : `根据镜头动作生成连续视频：${prompt.text}`}</p><div className="prompt-foot"><button className="text-button" onClick={() => setEditingPrompt(!editingPrompt)}><SlidersHorizontal size={15} />{editingPrompt ? '收起编辑' : '编辑提示词'}</button>{assetMode === 'video' && <select value={videoProvider.id} onChange={(event) => { const next = providers.find((item) => item.id === event.target.value); if (next) setVideoProvider(next); }}><option value="bytedance-video">字节视频</option><option value="grok-video">Grok Video</option><option value="gemini-video">Gemini / Veo</option></select>}{assetMode === 'video' && <label className="inline-toggle"><input type="checkbox" checked={generateNativeAudio} onChange={(event) => setGenerateNativeAudio(event.target.checked)} /><Volume2 size={13} />原生音频</label>}<span>负面约束已应用</span></div></div>
    {editingPrompt && <PromptEditor key={prompt.id} prompt={prompt} onCancel={() => setEditingPrompt(false)} onSave={revisePrompt} />}
    <div className="generation-bar"><div><span>候选数量</span><div className="stepper"><button onClick={() => setCandidateCount(Math.max(1, candidateCount - 1))}>−</button><b>{candidateCount}</b><button onClick={() => setCandidateCount(Math.min(activeProvider.capabilities.maxCandidates, candidateCount + 1))}>+</button></div><span className="muted">可随时追加</span></div><button className="primary-button" onClick={assetMode === 'image' ? generateCards : generateVideoCards}><Sparkles size={16} />生成 {candidateCount} 个候选</button></div>
    <div className="candidate-grid">{visibleAssets.map((asset, index) => {
      const report = qcReportFor(project, asset.id);
      const qcLabel = report?.status === 'approved' ? '质检通过' : report?.status === 'rejected' ? '已驳回' : report?.status === 'processing' ? '质检中' : report?.status === 'ready' ? '待人工确认' : report?.status === 'failed' ? '质检失败' : '未质检';
      return <article key={asset.id} className={`candidate-card ${asset.selected ? 'selected' : ''}`}><button className="candidate-image" onClick={() => selectCandidate(asset.id)}>{asset.kind === 'video' ? <video src={mediaDisplayUrl(asset.url)} muted playsInline preload="metadata" aria-label={`${asset.label}视频预览`} /> : <img src={mediaDisplayUrl(asset.url)} alt={`${asset.label}候选`} />}{asset.kind === 'video' && <span className="video-mark"><Play size={16} fill="currentColor" /></span>}<span className="candidate-index">0{index + 1}</span>{asset.selected && <span className="selected-mark"><Check size={16} />已选</span>}</button><div className="candidate-details"><div><b>{asset.label}</b><span>{asset.kind === 'video' ? `${asset.metadata.duration ?? 5}s · ${asset.provider}` : `种子 ${asset.metadata.seed ?? 'provider'}`}</span></div><button className="select-button" onClick={() => selectCandidate(asset.id)}>{asset.selected ? '当前首选' : '选用此张'}</button></div><div className={`qc-strip qc-${report?.status ?? 'not-run'}`}><span className="qc-label">{asset.kind === 'video' && report?.status !== 'approved' && <AlertTriangle size={12} />}{qcLabel}</span>{report?.contactSheetUrl && <img src={mediaDisplayUrl(report.contactSheetUrl)} alt={`${asset.label}抽帧接触表`} />}{report && <small>{report.width && report.height ? `${report.width} × ${report.height}` : ''}{report.hasAudio ? ' · 原生音频' : asset.kind === 'video' ? ' · 无原生音频' : ''}{report.errors.length ? ` · ${report.errors.length} 个问题` : report.warnings.length ? ` · ${report.warnings.length} 个提醒` : ''}</small>}<div className="qc-actions"><button className="text-button" disabled={qcBusyAssetId === asset.id} onClick={() => onRunQc(asset)}><RefreshCw size={13} />{qcBusyAssetId === asset.id ? '质检中' : report ? '重新质检' : '质检'}</button>{asset.kind === 'video' && report?.status === 'ready' && <><button className="text-button qc-approve" onClick={() => onSetQcStatus(asset.id, 'approved')}><Check size={13} />通过</button><button className="text-button qc-reject" onClick={() => onSetQcStatus(asset.id, 'rejected')}>驳回</button></>}{asset.kind === 'image' && <button className="text-button" onClick={() => onSetStoryboard(asset)}>故事板</button>}</div></div></article>;
    })}</div>
    {!visibleAssets.length && <div className="inline-empty"><Video size={20} /><span>{assetMode === 'video' ? '尚无视频候选。选择图片帧后即可生成。' : '尚无图片候选。'}</span></div>}
    <div className="lineage"><Layers3 size={16} /><span>素材血缘：镜头 {String(shot?.number ?? 1).padStart(2, '0')}</span><ChevronRight size={14} /><span>提示词 {prompt.id.slice(-6)}</span><ChevronRight size={14} /><span>{assetMode === 'video' ? '首尾帧约束' : '角色造型参考'}</span><ChevronRight size={14} /><span>{selectedAsset?.label ?? '未选择'}</span><button className="text-button">查看全部记录</button></div>
  </>;
}

function PromptEditor({ prompt, onCancel, onSave }: { prompt: Project['prompts'][number]; onCancel: () => void; onSave: (id: string, text: string, negativeText: string) => void }) {
  const [text, setText] = useState(prompt.text);
  const [negativeText, setNegativeText] = useState(prompt.negativeText);
  return <section className="prompt-editor"><div><span className="eyebrow">PROMPT REVISION</span><h3>编辑当前镜头提示词</h3></div><label>正向提示词<textarea value={text} onChange={(event) => setText(event.target.value)} /></label><label>负面约束<textarea value={negativeText} onChange={(event) => setNegativeText(event.target.value)} /></label><div className="prompt-editor-actions"><button className="quiet-action" onClick={onCancel}>取消</button><button className="primary-button" onClick={() => onSave(prompt.id, text, negativeText)}><Check size={16} />保存为新版本</button></div></section>;
}

function TimelineEditor({ project, onToggle, onMove, onUpdateDuration, onReset }: { project: Project; onToggle: (shotId: string) => void; onMove: (shotId: string, direction: -1 | 1) => void; onUpdateDuration: (shotId: string, duration: number) => void; onReset: () => void }) {
  const entries = timelineEntries(project);
  const exportableCount = entries.filter((entry) => entry.clip.enabled && entry.asset).length;
  return <section className="sequence-editor"><div className="sequence-editor-head"><div><span className="eyebrow">SHOT SEQUENCE</span><h3>镜头序列</h3></div><div className="sequence-editor-summary"><b>{exportableCount}</b> 段可导出<span>/</span>{entries.length} 个镜头</div></div>{entries.length ? <div className="sequence-list">{entries.map(({ clip, shot, asset }, index) => <article className={`sequence-item ${clip.enabled ? '' : 'disabled'} ${asset ? '' : 'unready'}`} key={clip.id}><span className="sequence-index">{String(index + 1).padStart(2, '0')}</span><div className="sequence-thumb">{asset?.kind === 'video' ? <video src={mediaDisplayUrl(asset.url)} muted playsInline preload="metadata" aria-label={`${shot.framing}视频预览`} /> : asset ? <img src={mediaDisplayUrl(asset.url)} alt={`${shot.framing}预览`} /> : <Clapperboard size={17} />}</div><div className="sequence-info"><b>{shot.framing}</b><span>镜头 {String(shot.number).padStart(2, '0')} · {asset ? asset.label : '尚未选定素材'}</span><small>{asset ? asset.kind === 'video' ? '视频候选' : '图片帧' : '完成素材选择后才能导出'}</small></div><label className="sequence-duration">时长<input type="number" min="0.5" max="30" step="0.1" value={clip.duration} aria-label={`镜头 ${shot.number} 序列时长`} onChange={(event) => onUpdateDuration(shot.id, Number(event.target.value) || 0.5)} /><span>s</span></label><div className="sequence-actions"><IconButton label="上移镜头" onClick={() => onMove(shot.id, -1)} active={index > 0}><ArrowUp size={14} /></IconButton><IconButton label="下移镜头" onClick={() => onMove(shot.id, 1)} active={index < entries.length - 1}><ArrowDown size={14} /></IconButton><IconButton label={clip.enabled ? '移出导出序列' : '加入导出序列'} onClick={() => onToggle(shot.id)} active={clip.enabled}>{clip.enabled ? <Eye size={14} /> : <EyeOff size={14} />}</IconButton></div></article>)}</div> : <div className="inline-empty"><Clapperboard size={18} /><span>还没有可编排的镜头。</span></div>}<div className="sequence-editor-foot"><span>关闭的镜头、未选素材的镜头不会进入导出；顺序和时长会保存到项目。</span><button className="text-button" onClick={onReset}><RotateCw size={13} />恢复剧本顺序</button></div></section>;
}

function AssemblyStage({ project, notice, exporting, voiceGenerating, onExport, onGenerateVoice, onImportAudio, onToggleAudio, onUpdateAudio, onToggleTimeline, onMoveTimeline, onUpdateTimelineDuration, onResetTimeline, onGenerateSubtitles, onUpdateSubtitle }: { project: Project; notice: (message: string) => void; exporting: boolean; voiceGenerating: boolean; onExport: (options?: FinalCutExportOptions) => void; onGenerateVoice: () => void; onImportAudio: (kind: Exclude<AudioTrack['kind'], 'subtitle'>) => void; onToggleAudio: (trackId: string) => void; onUpdateAudio: (trackId: string, changes: Partial<AudioTrack>) => void; onToggleTimeline: (shotId: string) => void; onMoveTimeline: (shotId: string, direction: -1 | 1) => void; onUpdateTimelineDuration: (shotId: string, duration: number) => void; onResetTimeline: () => void; onGenerateSubtitles: () => void; onUpdateSubtitle: (subtitleId: string, changes: Partial<SubtitleCue>) => void }) {
  const [coverDuration, setCoverDuration] = useState(0.6);
  const [endCardDuration, setEndCardDuration] = useState(0.6);
  const selectedTimeline = selectedTimelineItems(project);
  const preview = selectedTimeline[0]?.asset;
  const sequenceDuration = selectedTimeline.reduce((total, item) => total + item.clip.duration, 0);
  const transitionDuration = selectedTimeline.length > 1 ? 0.35 : 0;
  const totalDuration = Math.max(0.1, sequenceDuration - transitionDuration * Math.max(0, selectedTimeline.length - 1));
  const exportDuration = totalDuration + coverDuration + endCardDuration;
  const latestExport = project.exports?.[0];
  const timelineEditor = <TimelineEditor project={project} onToggle={onToggleTimeline} onMove={onMoveTimeline} onUpdateDuration={onUpdateTimelineDuration} onReset={onResetTimeline} />;
  if (!preview) return <><SectionTitle eyebrow="FINAL CUT" title="声音与成片" />{timelineEditor}<div className="empty-stage"><Film size={28} /><h3>尚无可导出的镜头素材</h3><p>在序列中保留至少一个已选视频或图片帧，再继续检查声音和导出设置。</p></div></>;
  return <><SectionTitle eyebrow="FINAL CUT" title="声音与成片"><div className="section-actions"><button className="quiet-action" disabled={voiceGenerating} onClick={onGenerateVoice}><Mic2 size={15} />{voiceGenerating ? '生成配音中...' : '生成 AI 配音'}</button><button className="quiet-action" onClick={() => onImportAudio('dialogue')}><Mic2 size={15} />导入配音</button><button className="quiet-action" onClick={() => onImportAudio('music')}><Music2 size={15} />导入音乐</button><button className="quiet-action" onClick={() => onImportAudio('sfx')}><Volume2 size={15} />导入音效</button><button className="quiet-action" onClick={onGenerateSubtitles}><Captions size={15} />{project.subtitles?.length ? '重新生成字幕' : '生成字幕草稿'}</button><button className="quiet-action" onClick={() => notice(`当前成片将按 ${selectedTimeline.length} 个已选镜头顺序导出`)}><Play size={15} />检查序列</button><button className="quiet-action" disabled={exporting || selectedTimeline.length < 3} onClick={() => onExport({ kind: 'batch-preview', coverDuration, endCardDuration })}><Layers3 size={15} />批次预览</button><button className="primary-button" disabled={exporting} onClick={() => onExport({ coverDuration, endCardDuration })}><Download size={16} />{exporting ? '正在导出...' : '导出 H.264 MP4'}</button></div></SectionTitle>{timelineEditor}<div className="assembly-preview">{preview.kind === 'video' ? <video src={mediaDisplayUrl(preview.url)} controls playsInline preload="metadata" aria-label="成片首段预览"/> : <img src={mediaDisplayUrl(preview.url)} alt="成片首段预览"/>}<div className="safe-area">{project.aspectRatio} 字幕安全区</div></div><div className="selected-sequence">{selectedTimeline.map(({ shot, clip, asset }) => <div key={shot.id}><span>镜头 {String(shot.number).padStart(2, '0')}</span><b>{asset.label}</b><small>{clip.duration}s · {asset.kind === 'video' ? '视频' : '静帧转场'}</small></div>)}</div><section className="subtitle-editor"><div className="subtitle-editor-head"><div><span className="eyebrow">SUBTITLES</span><h3>字幕时间轴</h3></div><span>{project.subtitles?.length ?? 0} 条</span></div>{project.subtitles?.length ? project.subtitles.map((cue) => <div className="subtitle-row" key={cue.id}><input value={cue.start} type="number" min="0" step="0.1" aria-label="字幕开始时间" onChange={(event) => onUpdateSubtitle(cue.id, { start: Math.max(0, Number(event.target.value) || 0) })} /><span>至</span><input value={cue.end} type="number" min="0.1" step="0.1" aria-label="字幕结束时间" onChange={(event) => onUpdateSubtitle(cue.id, { end: Math.max(0.1, Number(event.target.value) || 0.1) })} /><textarea value={cue.text} aria-label="字幕文本" onChange={(event) => onUpdateSubtitle(cue.id, { text: event.target.value })} /></div>) : <div className="inline-empty"><Captions size={18} /><span>从剧本台词生成字幕草稿，之后可逐条调整。</span></div>}</section><div className="timeline"><div className="timeline-ruler"><span>00:00</span><span>{Math.round(exportDuration / 3)}s</span><span>{Math.round(exportDuration / 3 * 2)}s</span><span>{Math.round(exportDuration)}s</span></div>{project.audioTracks.map((track) => <div className={`track ${track.enabled ? '' : 'disabled'}`} key={track.id}><span>{track.kind === 'dialogue' ? '台词' : track.kind === 'music' ? '配乐' : track.kind === 'sfx' ? '音效' : '字幕'}</span><div className="track-clip"><b>{track.label}</b><small>{track.sourceUrl ? '本机文件' : '待导入'}</small><div className="track-controls"><label>开始<input type="number" min="0" step="0.1" value={track.start ?? 0} onChange={(event) => onUpdateAudio(track.id, { start: Math.max(0, Number(event.target.value) || 0) })} /></label><label>时长<input type="number" min="0.1" step="0.1" value={track.duration} onChange={(event) => onUpdateAudio(track.id, { duration: Math.max(0.1, Number(event.target.value) || 0.1) })} /></label><label>音量<input type="number" min="0" max="4" step="0.05" value={track.volume ?? 1} onChange={(event) => onUpdateAudio(track.id, { volume: Math.min(4, Math.max(0, Number(event.target.value) || 0)) })} /></label></div></div><button aria-label={`${track.enabled ? '静音' : '启用'} ${track.label}`} onClick={() => onToggleAudio(track.id)}>{track.enabled ? <Music2 size={15} /> : <X size={15} />}</button></div>)}</div><div className="export-options"><div><b>导出设置</b><span>H.264 MP4 · {project.aspectRatio === '9:16' ? '1080 × 1920' : '1920 × 1080'} · {selectedTimeline.length} 段镜头 · {exportDuration.toFixed(1)} 秒{latestExport ? ` · 上次导出 ${latestExport.clipCount} 段` : ''}</span><div className="export-controls"><label>封面冻结 <input type="number" min="0" max="10" step="0.1" value={coverDuration} onChange={(event) => setCoverDuration(Math.max(0, Math.min(10, Number(event.target.value) || 0)))} />s</label><label>片尾冻结 <input type="number" min="0" max="10" step="0.1" value={endCardDuration} onChange={(event) => setEndCardDuration(Math.max(0, Math.min(10, Number(event.target.value) || 0)))} />s</label></div></div><button className="quiet-action" disabled={exporting} onClick={() => onExport({ coverDuration, endCardDuration })}><Download size={15} />导出</button></div></>;
}

function Inspector({ project, stage, activeShot, selectedAsset, setShowSettings, cancelVideoJob, recheckVideoJob }: { project: Project; stage: Stage; activeShot: string; selectedAsset?: CandidateAsset; setShowSettings: (value: boolean) => void; cancelVideoJob: (jobId: string) => void; recheckVideoJob: (jobId: string) => void }) {
  const recentJobs = project.jobs.slice(0, 6);
  const jobStatusLabel = (status: Project['jobs'][number]['status']) => status === 'succeeded' ? '已完成' : status === 'cancelled' ? '已取消' : status === 'failed' ? '失败' : status === 'unknown' ? '提交结果待确认' : '进行中';
  const adaptedEpisodes = project.episodes?.filter((episode) => episode.status !== 'draft').length ?? project.scenes.filter((scene) => scene.status !== 'draft').length;
  const approvedCharacters = project.characters.filter((character) => character.status === 'approved').length;
  const approvedShots = project.shots.filter((shot) => !shot.archived && shot.status === 'approved').length;
  const selectedQc = selectedAsset ? qcReportFor(project, selectedAsset.id) : undefined;
  const activeShotRecord = project.shots.find((shot) => shot.id === activeShot && !shot.archived);
  const activePrompt = activeShotRecord ? [...project.prompts].reverse().find((prompt) => prompt.assetId === activeShotRecord.id) : undefined;
  const continuityBindings = activeShotRecord ? referenceBindingsFor(project, activeShotRecord, activePrompt?.id ?? '') : [];
  return <aside className="inspector"><div className="inspector-header"><span>检查器</span><IconButton label="收起检查器"><PanelLeftClose size={16} /></IconButton></div>{stage === '素材' && <><div className="inspect-section"><h3>生成设置</h3><label>画幅 <select defaultValue={project.aspectRatio}><option>9:16</option><option>16:9</option></select></label><label>分辨率 <select defaultValue="1024 × 1536"><option>1024 × 1536</option><option>1536 × 1024</option></select></label><label>角色一致性 <div className="toggle on"><span></span>绑定参考图</div></label></div><div className="inspect-section"><h3>当前选择</h3>{selectedAsset ? <img className="inspect-image" src={mediaDisplayUrl(selectedAsset.url)} alt="当前选择"/> : <div className="inspect-image empty-preview">未选择素材</div>}<div className="metadata"><span>供应商<b>{selectedAsset?.provider ?? '—'}</b></span><span>模型<b>{selectedAsset?.model ?? '—'}</b></span><span>版本<b>{activePrompt ? `提示词 ${activePrompt.id.slice(-6)}` : '—'}</b></span>{selectedAsset?.kind === 'video' && <span>质检<b>{selectedQc?.status === 'approved' ? '通过' : selectedQc?.status === 'ready' ? '待确认' : '未通过'}</b></span>}</div>{selectedQc?.contactSheetUrl && <img className="qc-inspect-sheet" src={mediaDisplayUrl(selectedQc.contactSheetUrl)} alt="当前视频接触表" />}</div></>}<div className="inspect-section continuity-section"><h3>当前镜头约束</h3>{activeShotRecord ? <><p className="muted">{activeShotRecord.framing} · {activeShotRecord.action}</p><div className="continuity-tags">{continuityBindings.length ? continuityBindings.map((binding) => <span className="continuity-tag" key={binding.id}>{binding.role === 'character' ? '角色' : binding.role === 'scene' ? '场景' : binding.role === 'prop' ? '道具' : '帧'} · {binding.label}</span>) : <span className="muted">尚未绑定角色或参考帧</span>}</div><p className="muted">项目约束：{project.styleGuide.constraints}</p></> : <p className="muted">选择一个镜头后显示引用和连续性约束。</p>}</div>{stage !== '素材' && <><div className="inspect-section"><h3>项目风格</h3><p className="readable">{project.styleGuide.visualStyle}</p><p className="muted">{project.styleGuide.constraints}</p></div><div className="inspect-section"><h3>创作进度</h3><div className="progress-list"><span>章节改编 <b>{adaptedEpisodes}/{project.episodes?.length ?? project.chapters.length}</b></span><span>角色确认 <b>{approvedCharacters}/{project.characters.length}</b></span><span>镜头确认 <b>{approvedShots}/{project.shots.filter((shot) => !shot.archived).length}</b></span></div></div></>}<div className="inspect-section jobs"><h3>生成队列</h3>{recentJobs.length ? <div className="job-list">{recentJobs.map((queuedJob) => <div className="job" key={queuedJob.id}><span className={`job-state ${queuedJob.status}`}></span><div><b>{queuedJob.title}</b><small>{queuedJob.provider} · {jobStatusLabel(queuedJob.status)}</small>{queuedJob.error && <small className="job-error">{queuedJob.error}</small>}</div>{queuedJob.kind === 'video' && ['queued', 'generating', 'polling'].includes(queuedJob.status) ? <button className="cancel-job" onClick={() => cancelVideoJob(queuedJob.id)} title="取消视频任务"><X size={15} /></button> : queuedJob.kind === 'video' && queuedJob.status === 'unknown' ? <button className="cancel-job recheck-job" onClick={() => recheckVideoJob(queuedJob.id)} title="重新轮询远端任务"><RefreshCw size={15} /></button> : <MoreHorizontal size={16} />}</div>)}</div> : <p className="muted">暂无生成任务</p>}</div><button className="provider-link" onClick={() => setShowSettings(true)}><Settings2 size={15} />管理模型连接<ArrowUpRight size={14} /></button></aside>;
}

type WorkspaceNode = { id: string; type: 'project' | 'scene' | 'shot' | 'prompt' | 'asset' | 'qc' | 'export'; title: string; meta: string; x: number; y: number; shotId?: string; status?: string };
type WorkspaceEdge = { from: string; to: string; tone?: string };

function workspaceStatusLabel(status?: string) {
  switch (status) {
    case 'approved': return '已确认';
    case 'review': return '待审核';
    case 'draft': return '草稿';
    case 'ready': return '已生成';
    case 'selected': return '已选素材';
    case 'empty': return '待生成';
    case 'not-run': return '未质检';
    case 'processing': return '质检中';
    case 'rejected': return '已驳回';
    case 'failed': return '质检失败';
    case 'exported': return '已导出';
    default: return status ?? '';
  }
}

function WorkspaceCanvas({ project, activeShot, onSelectShot }: { project: Project; activeShot: string; onSelectShot: (shotId: string) => void }) {
  const [zoom, setZoom] = useState(0.82);
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const stored = JSON.parse(window.localStorage.getItem(`frameforge:canvas-layout:${project.id}`) ?? '{}') as Record<string, unknown>;
      return Object.fromEntries(Object.entries(stored).flatMap(([id, value]) => {
        if (!value || typeof value !== 'object') return [];
        const { x, y } = value as { x?: unknown; y?: unknown };
        return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? [[id, { x, y }]] : [];
      }));
    } catch {
      return {};
    }
  });
  const dragRef = useRef<{ id: string; x: number; y: number; originX: number; originY: number } | null>(null);
  useEffect(() => {
    try {
      window.localStorage.setItem(`frameforge:canvas-layout:${project.id}`, JSON.stringify(offsets));
    } catch {
      // Local layout persistence is best effort in restricted webviews.
    }
  }, [offsets, project.id]);
  const { nodes, edges, width, height } = useMemo(() => {
    const nodes: WorkspaceNode[] = [{ id: 'project', type: 'project', title: project.name, meta: '项目根节点', x: 28, y: 28 }];
    const edges: WorkspaceEdge[] = [];
    const activeShots = orderShots(project);
    const timelineByShot = new Map(timelineClipsFor(project).map((clip) => [clip.shotId, clip]));
    const sceneIds = [...new Set(activeShots.map((shot) => shot.sceneId))];
    let sceneCursor = 118;
    sceneIds.forEach((sceneId) => {
      const scene = project.scenes.find((item) => item.id === sceneId);
      if (!scene) return;
      const sceneNodeId = `scene:${scene.id}`;
      const sceneShots = activeShots.filter((shot) => shot.sceneId === sceneId);
      const sceneY = sceneCursor;
      nodes.push({ id: sceneNodeId, type: 'scene', title: scene.heading, meta: scene.action, x: 300, y: sceneY, status: scene.status });
      edges.push({ from: 'project', to: sceneNodeId });
      sceneShots.forEach((shot, shotIndex) => {
        const rowY = sceneY + shotIndex * 188;
        const shotNodeId = `shot:${shot.id}`;
        const prompt = [...project.prompts].reverse().find((item) => item.assetId === shot.id);
        const selected = prompt ? project.candidates.filter((asset) => asset.promptId === prompt.id && asset.selected) : [];
        const asset = selected.find((item) => item.kind === 'video') ?? selected.find((item) => item.kind === 'image');
        const timelineClip = timelineByShot.get(shot.id);
        const promptNodeId = `prompt:${shot.id}`;
        const assetNodeId = `asset:${shot.id}`;
        nodes.push({ id: shotNodeId, type: 'shot', title: `镜头 ${String(shot.number).padStart(2, '0')} · ${shot.framing}`, meta: `${timelineClip?.duration ?? shot.duration}s · ${timelineClip?.enabled === false ? '已移出序列' : '序列中'} · ${shot.action}`, x: 580, y: rowY, shotId: shot.id, status: shot.status });
        nodes.push({ id: promptNodeId, type: 'prompt', title: '提示词版本', meta: prompt ? prompt.text.slice(0, 68) : '尚未创建提示词', x: 860, y: rowY, shotId: shot.id, status: prompt ? 'ready' : 'draft' });
        nodes.push({ id: assetNodeId, type: 'asset', title: asset?.label ?? '未选择素材', meta: asset ? `${asset.kind === 'video' ? '视频' : '图片'} · ${asset.provider}` : '等待抽卡', x: 1140, y: rowY, shotId: shot.id, status: asset ? 'selected' : 'empty' });
        edges.push({ from: sceneNodeId, to: shotNodeId });
        edges.push({ from: shotNodeId, to: promptNodeId });
        edges.push({ from: promptNodeId, to: assetNodeId });
        if (asset?.kind === 'video') {
          const qc = qcReportFor(project, asset.id);
          const qcNodeId = `qc:${shot.id}`;
          nodes.push({ id: qcNodeId, type: 'qc', title: qc?.status === 'approved' ? 'QC 已通过' : 'QC 门禁', meta: qc ? `${qc.width ?? '?'} × ${qc.height ?? '?'}${qc.hasAudio ? ' · 音频' : ''}` : '未完成抽帧质检', x: 1420, y: rowY, shotId: shot.id, status: qc?.status ?? 'not-run' });
          edges.push({ from: assetNodeId, to: qcNodeId, tone: qc?.status === 'approved' ? 'approved' : 'warning' });
        }
      });
      sceneCursor += Math.max(246, sceneShots.length * 188 + 40);
    });
    const selectedTimeline = selectedTimelineItems(project);
    if (selectedTimeline.length) {
      const exportNodeId = 'export:latest';
      nodes.push({ id: exportNodeId, type: 'export', title: project.exports?.[0]?.kind === 'batch-preview' ? '批次预览' : '终剪导出', meta: `${selectedTimeline.length} 段已进入序列`, x: 1700, y: 76, status: project.exports?.[0] ? 'exported' : 'ready' });
      for (const { shot, asset } of selectedTimeline) edges.push({ from: asset.kind === 'video' ? `qc:${shot.id}` : `asset:${shot.id}`, to: exportNodeId, tone: 'approved' });
    }
    return { nodes, edges, width: 2010, height: Math.max(520, sceneCursor + 80) };
  }, [project]);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const nodePosition = (node: WorkspaceNode) => {
    const offset = offsets[node.id] ?? { x: 0, y: 0 };
    return { x: node.x + offset.x, y: node.y + offset.y };
  };
  const startDrag = (event: React.PointerEvent<HTMLDivElement>, node: WorkspaceNode) => {
    event.preventDefault();
    event.stopPropagation();
    const position = nodePosition(node);
    dragRef.current = { id: node.id, x: event.clientX, y: event.clientY, originX: position.x, originY: position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffsets((current) => ({ ...current, [drag.id]: { x: drag.originX - nodeMap.get(drag.id)!.x + (event.clientX - drag.x) / zoom, y: drag.originY - nodeMap.get(drag.id)!.y + (event.clientY - drag.y) / zoom } }));
  };
  const stopDrag = () => { dragRef.current = null; };
  return <section className="workspace-canvas-panel"><SectionTitle eyebrow="WORK CANVAS" title="连线工作画布"><div className="canvas-toolbar"><button className="icon-button" onClick={() => setZoom((value) => Math.min(1.3, value + 0.1))} aria-label="放大画布" title="放大画布"><ZoomIn size={16} /></button><span>{Math.round(zoom * 100)}%</span><button className="icon-button" onClick={() => setZoom((value) => Math.max(0.55, value - 0.1))} aria-label="缩小画布" title="缩小画布"><ZoomOut size={16} /></button><button className="icon-button" onClick={() => { setZoom(0.82); setOffsets({}); }} aria-label="重置画布" title="重置画布"><Maximize2 size={16} /></button></div></SectionTitle><div className="canvas-legend"><span><i className="legend-dot scene"></i>剧情</span><span><i className="legend-dot asset"></i>素材</span><span><i className="legend-dot qc"></i>质检</span><span><i className="legend-dot export"></i>输出</span><small>{nodes.length} 个节点 · {edges.length} 条连接 · 点击镜头节点进入素材</small></div><div className="workspace-canvas-viewport" onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}><div className="workspace-board" style={{ width, height, transform: `scale(${zoom})` }}><svg className="workspace-edges" width={width} height={height} aria-hidden="true"><defs><marker id="canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#9bb2d1" /></marker></defs>{edges.map((edge, index) => { const from = nodeMap.get(edge.from); const to = nodeMap.get(edge.to); if (!from || !to) return null; const start = nodePosition(from); const end = nodePosition(to); const x1 = start.x + 210; const y1 = start.y + 55; const x2 = end.x; const y2 = end.y + 55; const curve = Math.max(50, (x2 - x1) * 0.45); return <path key={`${edge.from}-${edge.to}-${index}`} className={`canvas-edge ${edge.tone ?? ''}`} d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`} markerEnd="url(#canvas-arrow)" />; })}</svg>{nodes.map((node) => { const position = nodePosition(node); const nodeLabel = `${node.type === 'project' ? '项目' : node.type === 'scene' ? '场景' : node.type === 'shot' ? '镜头' : node.type === 'prompt' ? '提示词' : node.type === 'asset' ? '素材' : node.type === 'qc' ? 'QC' : '导出'}：${node.title}`; return <div key={node.id} className={`workspace-node node-${node.type} ${node.shotId === activeShot ? 'is-active' : ''}`} style={{ left: position.x, top: position.y }} role={node.shotId ? 'button' : undefined} tabIndex={node.shotId ? 0 : undefined} aria-label={node.shotId ? nodeLabel : undefined} onPointerDown={(event) => startDrag(event, node)} onClick={() => node.shotId && onSelectShot(node.shotId)} onKeyDown={(event) => { if (event.key === 'Enter' && node.shotId) onSelectShot(node.shotId); }}><div className="workspace-node-head"><span>{node.type === 'project' ? '项目' : node.type === 'scene' ? '场景' : node.type === 'shot' ? '镜头' : node.type === 'prompt' ? '提示词' : node.type === 'asset' ? '素材' : node.type === 'qc' ? 'QC' : '导出'}</span>{node.status && <b>{node.status === 'approved' || node.status === 'exported' ? <Check size={12} /> : workspaceStatusLabel(node.status)}</b>}</div><strong>{node.title}</strong><p>{node.meta}</p></div>; })}</div></div></section>;
}

function AssetLibrary({ project, close, onOpenAsset }: { project: Project; close: () => void; onOpenAsset: (asset: CandidateAsset) => void }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | CandidateAsset['kind']>('all');
  const assets = project.candidates.filter((asset) => {
    if (kind !== 'all' && asset.kind !== kind) return false;
    const prompt = project.prompts.find((item) => item.id === asset.promptId);
    const shot = project.shots.find((item) => item.id === prompt?.assetId);
    const haystack = [asset.label, asset.provider, asset.model, shot?.framing, shot?.action].filter(Boolean).join(' ').toLowerCase();
    return !query.trim() || haystack.includes(query.trim().toLowerCase());
  });
  const kindLabel = (value: CandidateAsset['kind']) => value === 'video' ? '视频' : value === 'audio' ? '音频' : '图片';
  return <div className="modal-backdrop" role="presentation"><section className="asset-library-modal" role="dialog" aria-modal="true" aria-labelledby="asset-library-title"><div className="modal-header"><div><span className="eyebrow">PROJECT ASSETS</span><h2 id="asset-library-title">素材库</h2></div><IconButton label="关闭素材库" onClick={close}><X size={19} /></IconButton></div><div className="asset-library-toolbar"><label className="asset-library-search"><span>搜索</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按素材、供应商或镜头搜索" /></label><label className="asset-library-kind"><span>类型</span><select value={kind} onChange={(event) => setKind(event.target.value as 'all' | CandidateAsset['kind'])}><option value="all">全部</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select></label><span className="asset-library-count">{assets.length} 项</span></div>{assets.length ? <div className="asset-library-grid">{assets.map((asset) => { const report = qcReportFor(project, asset.id); const prompt = project.prompts.find((item) => item.id === asset.promptId); const shot = project.shots.find((item) => item.id === prompt?.assetId); return <button className="asset-library-item" key={asset.id} onClick={() => onOpenAsset(asset)}><div className="asset-library-thumb">{asset.kind === 'video' ? <video src={mediaDisplayUrl(asset.url)} muted playsInline preload="metadata" aria-label={`${asset.label}视频`} /> : asset.kind === 'audio' ? <Volume2 size={24} /> : <img src={mediaDisplayUrl(asset.url)} alt={`${asset.label}素材`} />}{asset.selected && <span className="asset-library-selected"><Check size={12} /></span>}</div><div className="asset-library-details"><b>{asset.label}</b><span>{kindLabel(asset.kind)} · {asset.provider}</span><small>{shot ? `镜头 ${String(shot.number).padStart(2, '0')} · ${shot.framing}` : '未关联镜头'}</small><small>{asset.kind === 'video' ? report?.status === 'approved' ? '质检通过' : report?.status === 'ready' ? '待人工确认' : '未质检' : asset.selected ? '当前首选' : '候选素材'}</small></div></button>; })}</div> : <div className="inline-empty"><FolderOpen size={20} /><span>没有匹配的素材。</span></div>}<div className="asset-library-foot"><span>点击素材会回到它所属的镜头和生成记录。</span><button className="quiet-action" onClick={close}>关闭</button></div></section></div>;
}

function ProviderSettings({ provider, setProvider, connection, setConnections, close, notice }: { provider: ProviderProfile; setProvider: (provider: ProviderProfile) => void; connection: ModelConnection; setConnections: React.Dispatch<React.SetStateAction<ProviderConnections>>; close: () => void; notice: (message: string) => void }) {
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [key, setKey] = useState(connection.apiKey);
  const [model, setModel] = useState(connection.model);
  const [textModel, setTextModel] = useState(connection.textModel ?? 'gpt-4.1-mini');
  const [voice, setVoice] = useState(connection.voice ?? 'alloy');
  const save = async () => {
    if (!key.trim()) { notice('请输入 API key 后再保存'); return; }
    try {
      await saveProviderCredential(provider.id, key);
      await saveProviderSettings({ providerId: provider.id, baseUrl, model, ...(provider.id === 'gpt-image' ? { textModel } : {}), ...(provider.id === 'openai-voice' ? { voice } : {}) });
      setConnections((current) => ({ ...current, [provider.id]: { baseUrl, apiKey: key, model, ...(provider.id === 'gpt-image' ? { textModel } : {}), ...(provider.id === 'openai-voice' ? { voice } : {}) } }));
      notice('模型连接已保存到系统钥匙串');
      close();
    } catch (error) {
      notice(error instanceof Error ? error.message : '模型连接保存失败');
    }
  };
  const endpointPlaceholder = provider.id === 'gpt-image' || provider.id === 'openai-voice' ? 'https://api.openai.com/v1' : provider.id === 'bytedance-video' ? 'https://ark.cn-beijing.volces.com/api/v3' : provider.id === 'gemini-video' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.x.ai/v1';
  const providerNote = provider.id === 'gpt-image' ? '密钥仅保存在当前设备的系统钥匙串中。' : provider.id === 'openai-voice' ? '使用 Speech 接口生成台词音频，音频会保存到本机素材目录。' : provider.id === 'bytedance-video' ? '字节使用 Ark 异步任务接口。端点、模型与密钥分别保存。' : provider.id === 'gemini-video' ? 'Gemini / Veo 使用 Google 长任务接口；请填写可用的 Veo 模型名称与 Google API key。' : 'Grok 使用视频任务接口。端点、模型与密钥分别保存。';
  return <div className="modal-backdrop" role="presentation"><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><div><span className="eyebrow">MODEL CONNECTIONS</span><h2 id="settings-title">模型与密钥</h2></div><IconButton label="关闭" onClick={close}><X size={19} /></IconButton></div><div className="provider-tabs">{providers.map((item) => <button key={item.id} onClick={() => setProvider(item)} className={provider.id === item.id ? 'active' : ''}><span className={`provider-tab-dot ${item.mode}`}></span>{item.name}</button>)}</div><div className="config-note"><Sparkles size={17} /><div><b>{provider.id === 'gpt-image' ? 'GPT Image 可直接使用自定义兼容端点' : provider.id === 'openai-voice' ? 'OpenAI Speech 配音连接' : `${provider.name} 专属视频适配器`}</b><span>{providerNote}</span></div></div><label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={endpointPlaceholder} /></label><label>API Key<input value={key} type="password" onChange={(event) => setKey(event.target.value)} placeholder="仅保存在本机钥匙串" /></label><label>模型<input value={model} onChange={(event) => setModel(event.target.value)} /></label>{provider.id === 'gpt-image' && <label>文本模型<input value={textModel} onChange={(event) => setTextModel(event.target.value)} /></label>}{provider.id === 'openai-voice' && <label>声音<input value={voice} onChange={(event) => setVoice(event.target.value)} placeholder="alloy" /></label>}<div className="capabilities"><span>支持能力</span>{Object.entries(provider.capabilities).filter(([, enabled]) => enabled === true).slice(0, 4).map(([capability]) => <b key={capability}>{capability === 'referenceImages' ? '参考图' : capability === 'voice' ? '配音' : capability}</b>)}</div><div className="modal-actions"><button className="quiet-action" onClick={close}>取消</button><button className="primary-button" onClick={() => void save()}><Check size={16} />保存连接</button></div></section></div>;
}
