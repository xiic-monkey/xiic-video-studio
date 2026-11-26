import { useMemo, useState } from 'react';
import { Check, Plus, Server } from 'lucide-react';
import { providerTemplates } from '../domain/providers/providerCatalog';
import type { CustomProviderInput } from '../domain/providers/providerCatalog';
import { useProviderStore } from '../stores/providerStore';
import { Dialog } from '../ui/Dialog';

interface ProviderCatalogDialogProps {
  open: boolean;
  onClose(): void;
  /** 选中的供应商目录 id。 */
  onPick(templateId: string): void;
  /** 新增一家自定义供应商（自建网关 / 中转站 / 本地推理服务）。 */
  onPickCustom(input: CustomProviderInput): void;
}

/**
 * 供应商目录。
 *
 * 和 OpenCode 的 `auth login` 一个思路：先从内置目录里挑一家供应商，
 * 再填 API Key——接入即用，它的模型立刻进入可选列表。
 * 目录条目由模型目录派生，不是另写一份名单。
 *
 * 目录覆盖不到的情况（自建网关、中转站、本地推理服务）走「自定义供应商」，
 * 用户自己给 Base URL 和鉴权方式，模型之后再往里加。
 */
export function ProviderCatalogDialog({ open, onClose, onPick, onPickCustom }: ProviderCatalogDialogProps) {
  const profiles = useProviderStore((state) => state.profiles);
  const templates = useMemo(() => providerTemplates(), []);
  const [custom, setCustom] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authType, setAuthType] = useState<'bearer' | 'header'>('bearer');

  function close() {
    setCustom(false);
    setName('');
    setBaseUrl('');
    setAuthType('bearer');
    onClose();
  }

  function submitCustom() {
    if (!name.trim() || !baseUrl.trim()) return;
    onPickCustom({ name: name.trim(), baseUrl: baseUrl.trim(), authType });
    close();
  }

  return (
    <Dialog open={open} onClose={close} label="添加供应商" className="provider-catalog-dialog">
      <header className="settings-head">
        <h2>添加供应商</h2>
      </header>
      {custom ? (
        <div className="provider-catalog-form">
          <p className="inspector-note">
            自建网关、中转站、本地推理服务都可以接。Base URL 填到接口根路径，模型在创建后再往里加。
          </p>
          <label className="studio-field">
            <span>名称</span>
            <input
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的推理网关"
            />
          </label>
          <label className="studio-field">
            <span>Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="studio-field">
            <span>鉴权方式</span>
            <select value={authType} onChange={(event) => setAuthType(event.target.value as 'bearer' | 'header')}>
              <option value="bearer">Bearer（Authorization: Bearer …）</option>
              <option value="header">Header（x-api-key）</option>
            </select>
          </label>
          <footer className="run-queue-foot">
            <button
              type="button"
              className="studio-button"
              onClick={submitCustom}
              disabled={!name.trim() || !baseUrl.trim()}
            >
              创建
            </button>
            <button type="button" className="studio-button secondary" onClick={() => setCustom(false)}>
              返回目录
            </button>
          </footer>
        </div>
      ) : (
        <>
          <div className="provider-catalog-list">
            {templates.map((template) => {
              const added = profiles.some((profile) => profile.id === template.id
                || (profile.name === template.name && profile.baseUrl === template.baseUrl));
              return (
                <button
                  key={template.id}
                  type="button"
                  className="provider-catalog-item"
                  disabled={added}
                  onClick={() => { onPick(template.id); close(); }}
                >
                  <div className="provider-catalog-main">
                    <b>{template.name}</b>
                    <span className="inspector-note">{template.baseUrl}</span>
                    <span className="inspector-note">{template.models.length} 个模型</span>
                  </div>
                  {added
                    ? <span className="studio-badge"><Check size={11} /> 已添加</span>
                    : <span className="studio-icon-button"><Plus size={14} /></span>}
                </button>
              );
            })}
            {!templates.length && <p className="inspector-note">内置目录里还没有供应商。</p>}
            <button
              type="button"
              className="provider-catalog-item"
              onClick={() => setCustom(true)}
            >
              <div className="provider-catalog-main">
                <b>自定义供应商</b>
                <span className="inspector-note">自建网关 / 中转站 / 本地推理服务，自己填 Base URL</span>
              </div>
              <span className="studio-icon-button"><Server size={14} /></span>
            </button>
          </div>
          <footer className="run-queue-foot">
            <button type="button" className="studio-button secondary" onClick={close}>取消</button>
          </footer>
        </>
      )}
    </Dialog>
  );
}
