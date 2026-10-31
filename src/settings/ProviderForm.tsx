import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProviderProfile } from '../domain/types';
import { useProviderStore } from '../stores/providerStore';
import {
  SIMPLE_CAPABILITIES,
  capabilitySummary,
  draftFromModel,
  emptyModelDraft,
  mergeModelDrafts,
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
      const models = profile.adapter === 'openai-compatible'
        ? mergeModelDrafts(profile.models, drafts)
        : profile.models;
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
