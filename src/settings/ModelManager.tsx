import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { CATALOG, protocolLabel } from '../domain/providers/catalog';
import { protocolOptionsFor } from '../domain/providers/customModels';
import { isProviderConnected } from '../domain/providers/providerCatalog';
import type { ModelCapability, ModelConfig, ProviderProfile } from '../domain/types';
import { useProviderStore } from '../stores/providerStore';

const CAPABILITY_LABEL: Record<string, string> = {
  'text.chat': '文本',
  'image.generate': '生图',
  'image.edit': '图片编辑',
  'video.generate': '视频',
  'audio.tts': '语音',
};

/**
 * 模型管理：按模型看有哪些供应商在供���，可排序、可停用、可换协议。
 *
 * 改动先落在本地草稿里，点「保存变更」才写库：
 * 以前每个勾选、每一下排序都立刻 persist，频繁写库且误触即生效，
 * 用户想临时试一个模型顺序也来不及撤销。
 */
/** 模型管理里的一行：一个模型 + 提供它的供应商。 */
interface ModelRow {
  id: string;
  displayName: string;
  vendor: string;
  capabilities: ModelCapability[];
  providers: Array<{ profile: ProviderProfile; binding: ModelConfig }>;
}

export function ModelManager() {
  const profiles = useProviderStore((state) => state.profiles);
  const saveProfile = useProviderStore((state) => state.saveProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState('');
  // 草稿：providerId → 该供应商的模型绑定。
  const [draft, setDraft] = useState<Record<string, ModelConfig[]>>({});

  // 只在外部数据真正变化时重置草稿：避免自己保存成功后草稿被覆盖。
  useEffect(() => {
    setDraft(Object.fromEntries(profiles.map((profile) => [profile.id, profile.models])));
  }, [profiles]);

  /**
   * 只列已接入的模型。
   *
   * 「已接入」= 至少有一家已保存 Key 的供应商在提供它。
   * 没接入的模型列出来也没法用，还会让人以为配置坏了：OpenCode 的模型
   * 选择器同样只显示已连接供应商的模型。
   *
   * 目录里的模型和自定义供应商的模型一起列：后者不在 CATALOG 里，
   * 但只要接了供应商，它就该在模型管理里能被看到和排序。
   */
  const rows = useMemo<ModelRow[]>(() => {
    const connected = profiles.filter((profile) => isProviderConnected(profile));
    const byModel = new Map<string, ModelRow>();
    const ensure = (modelId: string): ModelRow => {
      const existing = byModel.get(modelId);
      if (existing) return existing;
      const catalog = CATALOG.find((item) => item.id === modelId);
      const row: ModelRow = {
        id: modelId,
        displayName: catalog?.displayName ?? modelId,
        vendor: catalog?.vendor ?? '自定义',
        capabilities: catalog?.capabilities ?? [],
        providers: [],
      };
      byModel.set(modelId, row);
      return row;
    };
    for (const catalog of CATALOG) ensure(catalog.id);
    for (const profile of connected) {
      for (const binding of draft[profile.id] ?? []) {
        const row = ensure(binding.id);
        if (!row.capabilities.length) row.capabilities = binding.capabilities;
        row.providers.push({ profile, binding });
      }
    }
    return [...byModel.values()]
      .filter((row) => row.providers.length > 0)
      .map((row) => ({
        ...row,
        providers: row.providers.sort((left, right) =>
          (left.binding.priority ?? 100) - (right.binding.priority ?? 100)),
      }));
  }, [profiles, draft]);

  const dirty = useMemo(() => profiles.some((profile) => {
    const current = profile.models.map((model) => JSON.stringify(model)).join('|');
    const next = (draft[profile.id] ?? []).map((model) => JSON.stringify(model)).join('|');
    return current !== next;
  }), [profiles, draft]);

  function patchBinding(profile: ProviderProfile, modelId: string, patch: Record<string, unknown>) {
    setSaved('');
    setDraft((current) => {
      const models = (current[profile.id] ?? profile.models).map((model) => (
        model.id === modelId ? { ...model, ...patch } : model
      ));
      return { ...current, [profile.id]: models };
    });
  }

  function move(profile: ProviderProfile, modelId: string, delta: number) {
    setSaved('');
    setDraft((current) => {
      const models = [...(current[profile.id] ?? profile.models)];
      const index = models.findIndex((model) => model.id === modelId);
      if (index < 0) return current;
      const priority = (models[index].priority ?? 100) + delta;
      models[index] = { ...models[index], priority };
      return { ...current, [profile.id]: models };
    });
  }

  async function saveAll() {
    setBusy(true);
    setError(undefined);
    setSaved('');
    try {
      for (const profile of profiles) {
        const models = draft[profile.id];
        if (!models) continue;
        await saveProfile({ ...profile, schemaVersion: 2, models });
      }
      setSaved('已保存模型配置');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(false);
    }
  }

  function resetDraft() {
    setDraft(Object.fromEntries(profiles.map((profile) => [profile.id, profile.models])));
    setSaved('');
    setError(undefined);
  }

  return (
    <div className="settings-models-list">
      {error && <p className="settings-error">{error}</p>}
      {saved && <p className="settings-ok">{saved}</p>}
      <div className="settings-actions">
        <button type="button" className="studio-button" onClick={() => { void saveAll(); }} disabled={busy || !dirty}>
          {busy ? '保存中…' : '保存变更'}
        </button>
        <button type="button" className="studio-button secondary" onClick={resetDraft} disabled={busy || !dirty}>
          放弃改动
        </button>
        {dirty && <span className="inspector-note">有未保存的模型配置改动</span>}
      </div>
      {rows.map((row) => (
        <section className="settings-model-group" key={row.id}>
          <header>
            <b>{row.displayName}</b>
            <span className="studio-badge">{row.vendor}</span>
            <span className="inspector-note">{row.providers.length} 家供应商</span>
          </header>
          {row.providers.map(({ profile, binding }, index) => (
            <div className="settings-model-row" key={profile.id}>
              <span className="settings-model-provider">{profile.name}</span>
              <span className="inspector-note">优先级 {binding.priority ?? 100}</span>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={binding.enabled !== false}
                  onChange={(event) => patchBinding(profile, row.id, { enabled: event.target.checked })}
                />
                启用
              </label>
              {row.capabilities.map((capability) => {
                const options = protocolOptionsFor(binding, capability.capability);
                if (!options.length) return null;
                const current = binding.protocols?.[capability.capability] ?? options[0];
                return (
                  <label key={capability.capability} className="settings-protocol">
                    {CAPABILITY_LABEL[capability.capability] ?? capability.capability}
                    <select
                      value={current}
                      onChange={(event) => patchBinding(profile, row.id, {
                        protocols: { ...(binding.protocols ?? {}), [capability.capability]: event.target.value },
                      })}
                    >
                      {options.map((protocol) => (
                        <option key={protocol} value={protocol}>{protocolLabel(protocol)}</option>
                      ))}
                    </select>
                  </label>
                );
              })}
              <button
                type="button"
                className="settings-remove"
                title="上移（优先调用）"
                disabled={index === 0}
                onClick={() => move(profile, row.id, -1)}
              >
                <ArrowUp size={12} />
              </button>
              <button
                type="button"
                className="settings-remove"
                title="下移"
                disabled={index === row.providers.length - 1}
                onClick={() => move(profile, row.id, 1)}
              >
                <ArrowDown size={12} />
              </button>
            </div>
          ))}
        </section>
      ))}
      {!rows.length && (
        <p className="inspector-note">
          还没有已接入的模型。先到「供应商」里添加一家并填入 API Key，接上的模型会出现在这里。
        </p>
      )}
    </div>
  );
}
