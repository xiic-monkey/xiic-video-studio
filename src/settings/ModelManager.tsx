import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { CATALOG, capabilityProtocols, protocolLabel } from '../domain/providers/catalog';
import { providersForModel } from '../domain/providers/routing';
import type { ProviderProfile } from '../domain/types';
import { useProviderStore } from '../stores/providerStore';

const CAPABILITY_LABEL: Record<string, string> = {
  'text.chat': '文本',
  'image.generate': '生图',
  'image.edit': '图片编辑',
  'video.generate': '视频',
  'audio.tts': '语音',
};

/** 模型管理：按模型看有哪些供应商在供��，可排序、可停用、可换协议。 */
export function ModelManager() {
  const profiles = useProviderStore((state) => state.profiles);
  const saveProfile = useProviderStore((state) => state.saveProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const rows = useMemo(() => CATALOG.map((catalog) => ({
    catalog,
    providers: providersForModel(profiles, catalog.id)
      .sort((left, right) => (left.binding.priority ?? 100) - (right.binding.priority ?? 100)),
  })), [profiles]);

  async function persist(next: ProviderProfile) {
    setBusy(true);
    setError(undefined);
    try {
      await saveProfile(next);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(false);
    }
  }

  function patchBinding(profile: ProviderProfile, modelId: string, patch: Record<string, unknown>) {
    const models = profile.models.map((model) => (model.id === modelId ? { ...model, ...patch } : model));
    void persist({ ...profile, schemaVersion: 2, models });
  }

  function move(profile: ProviderProfile, modelId: string, delta: number) {
    const models = [...profile.models];
    const index = models.findIndex((model) => model.id === modelId);
    if (index < 0) return;
    const current = models[index].priority ?? 100;
    const target = current + delta;
    models[index] = { ...models[index], priority: target };
    void persist({ ...profile, schemaVersion: 2, models });
  }

  return (
    <div className="settings-models-list">
      {error && <p className="settings-error">{error}</p>}
      {rows.map(({ catalog, providers }) => (
        <section className="settings-model-group" key={catalog.id}>
          <header>
            <b>{catalog.displayName}</b>
            <span className="studio-badge">{catalog.vendor}</span>
            <span className="inspector-note">
              {providers.length ? `${providers.length} 家供应商` : '尚未接入任何供应商'}
            </span>
          </header>
          {providers.map(({ profile, binding }, index) => (
            <div className="settings-model-row" key={profile.id}>
              <span className="settings-model-provider">{profile.name}</span>
              <span className="inspector-note">优先级 {binding.priority ?? 100}</span>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={binding.enabled !== false}
                  onChange={(event) => patchBinding(profile, catalog.id, { enabled: event.target.checked })}
                />
                启用
              </label>
              {catalog.capabilities.map((capability) => {
                const options = capabilityProtocols(catalog.id, capability.capability);
                if (!options.length) return null;
                const current = binding.protocols?.[capability.capability] ?? options[0];
                return (
                  <label key={capability.capability} className="settings-protocol">
                    {CAPABILITY_LABEL[capability.capability] ?? capability.capability}
                    <select
                      value={current}
                      disabled={busy}
                      onChange={(event) => patchBinding(profile, catalog.id, {
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
                onClick={() => move(profile, catalog.id, -1)}
              >
                <ArrowUp size={12} />
              </button>
              <button
                type="button"
                className="settings-remove"
                title="下移"
                disabled={index === providers.length - 1}
                onClick={() => move(profile, catalog.id, 1)}
              >
                <ArrowDown size={12} />
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
