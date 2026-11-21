import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CATALOG, capabilityProtocols, protocolLabel } from '../domain/providers/catalog';
import type { ModelConfig, ProtocolId, ProviderProfile } from '../domain/types';
import { normalizedKeys, useProviderStore } from '../stores/providerStore';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CAPABILITY_LABEL: Record<string, string> = {
  'text.chat': '文本',
  'image.generate': '生图',
  'image.edit': '图片编辑',
  'video.generate': '视频',
  'audio.tts': '语音',
};

export function ProviderForm({ profile }: { profile: ProviderProfile }) {
  const saveProfile = useProviderStore((state) => state.saveProfile);
  const saveKeyById = useProviderStore((state) => state.saveKeyById);
  const deleteKey = useProviderStore((state) => state.deleteKey);
  const addKey = useProviderStore((state) => state.addKey);
  const upsertBinding = useProviderStore((state) => state.upsertBinding);
  const removeBinding = useProviderStore((state) => state.removeBinding);
  const test = useProviderStore((state) => state.test);

  const [name, setName] = useState(profile.name);
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl);
  const [enabled, setEnabled] = useState(profile.enabled);
  const [keys, setKeys] = useState(() => normalizedKeys(profile));
  const [models, setModels] = useState<ModelConfig[]>(profile.models);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    setName(profile.name);
    setBaseUrl(profile.baseUrl);
    setEnabled(profile.enabled);
    setKeys(normalizedKeys(profile));
    setModels(profile.models);
    setKeyInputs({});
  }, [profile]);

  const selectedIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);

  function currentProfile(next: Partial<ProviderProfile> = {}): ProviderProfile {
    return {
      ...profile,
      name: name.trim() || profile.name,
      baseUrl: baseUrl.trim(),
      enabled,
      schemaVersion: 2,
      keys: keys.map((key) => ({ ...key, hasSecret: undefined })),
      models,
      ...next,
    };
  }

  function toggleModel(modelId: string) {
    if (selectedIds.has(modelId)) {
      setModels((items) => items.filter((model) => model.id !== modelId));
      return;
    }
    const next = upsertBinding(currentProfile(), modelId, {});
    setModels(next.models);
  }

  function patchModel(modelId: string, patch: Partial<ModelConfig>) {
    const next = upsertBinding(currentProfile(), modelId, patch);
    setModels(next.models);
  }

  function patchProtocol(modelId: string, capability: string, protocol: string) {
    const binding = models.find((model) => model.id === modelId);
    const protocols = { ...(binding?.protocols ?? {}), [capability]: protocol as ProtocolId };
    patchModel(modelId, { protocols });
  }

  function patchKeyLabel(keyId: string, label: string) {
    setKeys((items) => items.map((key) => (key.id === keyId ? { ...key, label } : key)));
  }

  async function save() {
    setBusy(true);
    setStatus(undefined);
    try {
      // 填了新密钥的 Key：把引用切到新约定（provider/{id}/key/{keyId}），
      // 旧版单 Key 的账户名（provider/{id}）就此退役。
      const filled = keys.filter((key) => keyInputs[key.id]?.trim());
      const nextKeys = keys.map((key) => (filled.some((item) => item.id === key.id)
        ? { ...key, keyRef: `provider/${profile.id}/key/${key.id}`, hasSecret: true }
        : key));
      await saveProfile({ ...currentProfile(), keys: nextKeys });
      for (const key of filled) {
        await saveKeyById(profile.id, key.id, keyInputs[key.id].trim());
      }
      setKeys(nextKeys);
      setKeyInputs({});
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

  async function removeKeyRow(keyId: string) {
    await deleteKey(profile.id, keyId);
    setKeys((items) => items.filter((key) => key.id !== keyId));
  }

  return (
    <section className="settings-provider">
      <header className="settings-provider-head">
        <div>
          <b>{profile.name}</b>
          <span className="studio-badge">{profile.id}</span>
        </div>
        <label className="settings-check">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 启用
        </label>
      </header>

      <label className="studio-field">
        <span>名称</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：火山方舟" />
      </label>

      <label className="studio-field">
        <span>Base URL</span>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.example.com/v1"
        />
      </label>

      <div className="settings-models">
        <div className="settings-models-head">
          <h4>API Key</h4>
          <button
            type="button"
            className="inspector-link"
            onClick={() => setKeys((items) => [...items, {
              id: `key_${items.length + 1}_${Math.random().toString(36).slice(2, 7)}`,
              label: `Key ${items.length + 1}`,
              keyRef: `provider/${profile.id}/key/key_${items.length + 1}`,
              enabled: true,
              status: 'active',
              hasSecret: false,
            }])}
          >
            <Plus size={11} /> 添加 Key
          </button>
        </div>
        {keys.map((key) => (
          <div className="settings-key" key={key.id}>
            <input
              className="settings-key-label"
              value={key.label}
              onChange={(event) => patchKeyLabel(key.id, event.target.value)}
              placeholder="Key 名称"
            />
            <span className={`studio-badge ${key.status === 'invalid' ? 'warn' : ''}`}>
              {key.hasSecret ? key.status : '未保存'}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={keyInputs[key.id] ?? ''}
              onChange={(event) => setKeyInputs((items) => ({ ...items, [key.id]: event.target.value }))}
              placeholder={key.hasSecret ? '••••••••（留空不修改）' : '粘贴 API Key'}
            />
            <button
              type="button"
              className="settings-remove"
              title="删除 Key"
              onClick={() => { void removeKeyRow(key.id); }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <p className="inspector-note">多个 Key 按顺序尝试：某个 Key 鉴权失败或限流时自动换下一个。</p>
      </div>

      <div className="settings-models">
        <div className="settings-models-head">
          <h4>提供的模型</h4>
          <span className="inspector-note">只勾选这家供应商实际提供的模型</span>
        </div>
        <div className="settings-capabilities">
          {CATALOG.map((catalog) => (
            <label key={catalog.id}>
              <input
                type="checkbox"
                checked={selectedIds.has(catalog.id)}
                onChange={() => toggleModel(catalog.id)}
              />
              {catalog.displayName}
              <span className="inspector-note"> · {catalog.vendor}</span>
            </label>
          ))}
        </div>
        {models.map((model) => {
          const catalog = CATALOG.find((item) => item.id === model.id);
          return (
            <div className="settings-model" key={model.id}>
              <div className="settings-model-row">
                <b>{model.displayName || model.id}</b>
                <button
                  type="button"
                  className="settings-remove"
                  title="移除该模型"
                  onClick={() => setModels((items) => items.filter((item) => item.id !== model.id))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="settings-capabilities">
                {(catalog?.capabilities ?? model.capabilities).map((capability) => {
                  const options = capabilityProtocols(model.id, capability.capability);
                  const current = model.protocols?.[capability.capability]
                    ?? options[0]
                    ?? 'openai-chat';
                  return (
                    <label key={capability.capability}>
                      {CAPABILITY_LABEL[capability.capability] ?? capability.capability}
                      <select
                        value={current}
                        onChange={(event) => patchProtocol(model.id, capability.capability, event.target.value)}
                      >
                        {options.map((protocol) => (
                          <option key={protocol} value={protocol}>{protocolLabel(protocol)}</option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="settings-actions">
        <button type="button" className="studio-button" onClick={() => { void save(); }} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="studio-button secondary" onClick={() => { void runTest(); }} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>
      {status && <p className={status.ok ? 'settings-ok' : 'settings-error'}>{status.message}</p>}
    </section>
  );
}
