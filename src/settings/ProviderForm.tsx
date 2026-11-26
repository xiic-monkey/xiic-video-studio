import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CATALOG, catalogModel, protocolLabel } from '../domain/providers/catalog';
import {
  CUSTOM_CAPABILITIES,
  customCapabilityOption,
  customModelBinding,
  protocolOptionsFor,
} from '../domain/providers/customModels';
import { isCustomProvider, isProviderConnected, templateForProfile } from '../domain/providers/providerCatalog';
import type { CatalogModel, ModelConfig, ProtocolId, ProviderProfile } from '../domain/types';
import { normalizedKeys, useProviderStore } from '../stores/providerStore';
import { confirmAction } from '../ui/confirmStore';
import { keyStatusLabel } from '../domain/production/labels';
import { ActionSelect } from '../ui/ActionSelect';

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
  const removeProvider = useProviderStore((state) => state.removeProvider);
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
  const [customModelId, setCustomModelId] = useState('');
  const [customCapability, setCustomCapability] = useState(CUSTOM_CAPABILITIES[0].capability);
  const [customProtocol, setCustomProtocol] = useState<ProtocolId>(CUSTOM_CAPABILITIES[0].protocols[0]);
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
  const connected = isProviderConnected(profile);
  const template = useMemo(() => templateForProfile(profile), [profile]);
  const custom = useMemo(() => isCustomProvider(profile), [profile]);

  /** 自定义模型可选的协议：跟着所选能力走。 */
  const customProtocols = useMemo(
    () => customCapabilityOption(customCapability)?.protocols ?? [],
    [customCapability],
  );

  /**
   * 这家能提供的模型：目录里给它的那些，加上用户自己加的。
   *
   * 不再列全部内置模型：接入一家供应商不等于提供 25 个模型，
   * 逐个勾全量目录既没意义也容易配错。
   */
  const offeredModels = useMemo<CatalogModel[]>(() => {
    const list: CatalogModel[] = [];
    const seen = new Set<string>();
    for (const item of template?.models ?? []) {
      const catalog = catalogModel(item.id);
      if (!catalog || seen.has(catalog.id)) continue;
      seen.add(catalog.id);
      list.push(catalog);
    }
    for (const model of models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const catalog = catalogModel(model.id);
      list.push(catalog ?? {
        id: model.id,
        displayName: model.displayName || model.id,
        vendor: model.vendor ?? '自定义',
        capabilities: model.capabilities,
      });
    }
    return list;
  }, [template, models]);

  const addableModels = useMemo(() => CATALOG.filter((catalog) => !selectedIds.has(catalog.id)), [selectedIds]);

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

  /**
   * 加一个目录里没有的模型。
   *
   * 自定义供应商的模型往往不在内置目录中（自建微调模型、代理网关的别名），
   * 用户自己给模型 id、说清干什么活、用什么协议就够了。
   */
  function addCustomModel() {
    const modelId = customModelId.trim();
    if (!modelId) return;
    if (selectedIds.has(modelId)) {
      setStatus({ ok: false, message: `「${modelId}」已经在列表里了` });
      return;
    }
    const binding = customModelBinding(modelId, customCapability, customProtocol);
    const next = upsertBinding(currentProfile(), modelId, binding);
    setModels(next.models);
    setCustomModelId('');
    setStatus({ ok: true, message: `已添加模型 ${modelId}` });
  }

  function patchProtocol(modelId: string, capability: string, protocol: string) {
    const binding = models.find((model) => model.id === modelId);
    const protocols = { ...(binding?.protocols ?? {}), [capability]: protocol as ProtocolId };
    patchModel(modelId, { protocols });
  }

  function patchKeyLabel(keyId: string, label: string) {
    setKeys((items) => items.map((key) => (key.id === keyId ? { ...key, label } : key)));
  }

  async function save(): Promise<boolean> {
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
      return true;
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * 测试连接。
   *
   * 后端只能测「已保存的配置」，所以这里先把当前草稿落库再测：
   * 否则用户改了 Base URL 或换了 Key 却没点保存时，测的是旧配置，
   * 会得到「我明明改对了怎么还连不上」的误判。
   */
  async function runTest() {
    setTesting(true);
    setStatus(undefined);
    try {
      const saved = await save();
      if (!saved) return;
      const result = await test(profile.id);
      setStatus({ ok: result.ok, message: result.message });
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
    } finally {
      setTesting(false);
    }
  }

  async function removeKeyRow(keyId: string) {
    const label = keys.find((key) => key.id === keyId)?.label || keyId;
    const confirmed = await confirmAction({
      title: '删除 API Key',
      message: `确定删除「${label}」？`,
      detail: '密钥会从系统钥匙串中移除，需要重新填写才能使用。此操作不可撤销。',
      tone: 'danger',
      confirmText: '删除 Key',
    });
    if (!confirmed) return;
    try {
      await deleteKey(profile.id, keyId);
      setKeys((items) => items.filter((key) => key.id !== keyId));
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
    }
  }

  async function removeProviderRow() {
    const confirmed = await confirmAction({
      title: '删除供应商',
      message: `确定删除「${profile.name}」？`,
      detail: '这家供应商的配置和钥匙串里的 API Key 都会一并删除，需要重新接入才能使用。',
      tone: 'danger',
      confirmText: '删除供应商',
    });
    if (!confirmed) return;
    try {
      await removeProvider(profile.id);
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
    }
  }

  return (
    <section className="settings-provider">
      <header className="settings-provider-head">
        <div>
          <b>{profile.name}</b>
          <span className="studio-badge">{profile.id}</span>
          {custom && <span className="studio-badge">自定义</span>}
          <span className={`studio-badge ${connected ? 'mint' : 'warn'}`}>
            {connected ? '已连接' : '未连接'}
          </span>
        </div>
        <div className="settings-provider-tools">
          <label className="settings-check">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 启用
          </label>
          <button
            type="button"
            className="settings-remove"
            title="删除供应商"
            aria-label={`删除供应商 ${profile.name}`}
            onClick={() => { void removeProviderRow(); }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </header>

      {!connected && (
        <p className="inspector-warning">
          还没有 API Key：填入并保存后，这家供应商才会被调用，它的模型也会出现在模型列表里。
        </p>
      )}

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
              {keyStatusLabel(key.status, Boolean(key.hasSecret))}
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
          <ActionSelect
            label="添加其它模型"
            placeholder="添加其它模型"
            options={addableModels.map((catalog) => ({ value: catalog.id, label: catalog.displayName }))}
            onPick={(modelId) => toggleModel(modelId)}
          />
        </div>
        <div className="settings-custom-model">
          <input
            value={customModelId}
            onChange={(event) => setCustomModelId(event.target.value)}
            placeholder="模型 ID，例如 gpt-4o-mini"
            aria-label="自定义模型 ID"
          />
          <select
            value={customCapability}
            aria-label="自定义模型能力"
            onChange={(event) => {
              const capability = event.target.value;
              setCustomCapability(capability);
              const first = customCapabilityOption(capability)?.protocols[0];
              if (first) setCustomProtocol(first);
            }}
          >
            {CUSTOM_CAPABILITIES.map((option) => (
              <option key={option.capability} value={option.capability}>{option.label}</option>
            ))}
          </select>
          <select
            value={customProtocol}
            aria-label="自定义模型协议"
            onChange={(event) => setCustomProtocol(event.target.value as ProtocolId)}
          >
            {customProtocols.map((protocol) => (
              <option key={protocol} value={protocol}>{protocolLabel(protocol)}</option>
            ))}
          </select>
          <button
            type="button"
            className="studio-button secondary"
            onClick={addCustomModel}
            disabled={!customModelId.trim()}
          >
            添加
          </button>
        </div>
        <div className="settings-capabilities">
          {offeredModels.map((catalog) => (
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
          {!offeredModels.length && (
            <p className="inspector-note">这家还没有绑定模型，从右上角挑一个加进来。</p>
          )}
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
                  const options = protocolOptionsFor(model, capability.capability);
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
