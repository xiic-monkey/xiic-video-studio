import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useProviderStore } from '../stores/providerStore';
import { AssetHostForm } from './AssetHostForm';
import { ProviderForm } from './ProviderForm';

export function SettingsDialog() {
  const open = useProviderStore((state) => state.settingsOpen);
  const close = useProviderStore((state) => state.closeSettings);
  const profiles = useProviderStore((state) => state.profiles);
  const loaded = useProviderStore((state) => state.loaded);
  const loading = useProviderStore((state) => state.loading);
  const error = useProviderStore((state) => state.error);
  const [tab, setTab] = useState<'providers' | 'assets'>('providers');

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="设置">
      <div className="settings-dialog">
        <header className="settings-head">
          <h2>设置</h2>
          <button type="button" className="studio-icon-button" title="关闭" onClick={close}><X size={15} /></button>
        </header>
        <nav className="settings-tabs">
          <button type="button" className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>模型接入</button>
          <button type="button" className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>素材外链</button>
        </nav>
        <div className="settings-body">
          {error && <p className="settings-error">{error}</p>}
          {!loaded && <p className="inspector-note">{loading ? '正在加载设置…' : '设置尚未加载'}</p>}
          {loaded && tab === 'providers' && profiles.map((profile) => <ProviderForm key={profile.id} profile={profile} />)}
          {loaded && tab === 'assets' && <AssetHostForm />}
        </div>
      </div>
    </div>
  );
}
