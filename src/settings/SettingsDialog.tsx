import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useProviderStore } from '../stores/providerStore';
import { Dialog } from '../ui/Dialog';
import { AssetHostForm } from './AssetHostForm';
import { ModelManager } from './ModelManager';
import { ProviderCatalogDialog } from './ProviderCatalogDialog';
import { ProviderForm } from './ProviderForm';

export function SettingsDialog() {
  const open = useProviderStore((state) => state.settingsOpen);
  const close = useProviderStore((state) => state.closeSettings);
  const profiles = useProviderStore((state) => state.profiles);
  const loaded = useProviderStore((state) => state.loaded);
  const loading = useProviderStore((state) => state.loading);
  const error = useProviderStore((state) => state.error);
  const addProvider = useProviderStore((state) => state.addProvider);
  const addCustomProvider = useProviderStore((state) => state.addCustomProvider);
  const [tab, setTab] = useState<'providers' | 'models' | 'assets'>('providers');
  const [catalogOpen, setCatalogOpen] = useState(false);

  // Esc、遮罩点击、焦点陷阱都由共享的 Dialog 统一处理，这里不再重复监听。
  return (
    <Dialog open={open} onClose={close} label="设置" className="settings-dialog">
      <header className="settings-head">
        <h2>设置</h2>
        <button type="button" className="studio-icon-button" title="关闭" onClick={close}><X size={15} /></button>
      </header>
      <nav className="settings-tabs">
        <button type="button" className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>供应商</button>
        <button type="button" className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>模型管理</button>
        <button type="button" className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>素材外链</button>
      </nav>
      <div className="settings-body">
        {error && <p className="settings-error">{error}</p>}
        {!loaded && <p className="inspector-note">{loading ? '正在加载设置…' : '设置尚未加载'}</p>}
        {loaded && tab === 'providers' && (
          <>
            <div className="settings-section-head">
              <div>
                <b>供应商</b>
                <p className="inspector-note">从内置目录里挑一家，填入 API Key 即接入；接入后它的模型才会出现在模型列表里。自建网关、中转站可以选「自定义供应商」。</p>
              </div>
              <button type="button" className="studio-button" onClick={() => setCatalogOpen(true)}>
                <Plus size={13} /> 添加供应商
              </button>
            </div>
            {profiles.map((profile) => <ProviderForm key={profile.id} profile={profile} />)}
            {!profiles.length && (
              <p className="inspector-note">还没有供应商。点「添加供应商」开始接入。</p>
            )}
          </>
        )}
        {loaded && tab === 'models' && <ModelManager />}
        {loaded && tab === 'assets' && <AssetHostForm />}
      </div>

      <ProviderCatalogDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onPick={(templateId) => { void addProvider(templateId); }}
        onPickCustom={(input) => { void addCustomProvider(input); }}
      />
    </Dialog>
  );
}
