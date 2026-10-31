import { useEffect, useState } from 'react';
import { useProviderStore } from '../stores/providerStore';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AssetHostForm() {
  const assetHost = useProviderStore((state) => state.assetHost);
  const saveHost = useProviderStore((state) => state.saveHost);
  const [strategy, setStrategy] = useState<'dataUrl' | 's3'>(assetHost?.strategy === 's3' ? 's3' : 'dataUrl');
  const [endpoint, setEndpoint] = useState(assetHost?.endpoint ?? '');
  const [bucket, setBucket] = useState(assetHost?.bucket ?? '');
  const [region, setRegion] = useState(assetHost?.region ?? '');
  const [prefix, setPrefix] = useState(assetHost?.prefix ?? 'frameforge');
  const [publicBaseUrl, setPublicBaseUrl] = useState(assetHost?.publicBaseUrl ?? '');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    if (!assetHost) return;
    setStrategy(assetHost.strategy === 's3' ? 's3' : 'dataUrl');
    setEndpoint(assetHost.endpoint ?? '');
    setBucket(assetHost.bucket ?? '');
    setRegion(assetHost.region ?? '');
    setPrefix(assetHost.prefix ?? 'frameforge');
    setPublicBaseUrl(assetHost.publicBaseUrl ?? '');
  }, [assetHost]);

  async function save() {
    setBusy(true);
    setStatus(undefined);
    try {
      await saveHost({
        strategy,
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        region: region.trim(),
        prefix: prefix.trim(),
        publicBaseUrl: publicBaseUrl.trim(),
        accessKey: accessKey.trim() || undefined,
        secretKey: secretKey.trim() || undefined,
      });
      setAccessKey('');
      setSecretKey('');
      setStatus({ ok: true, message: '素材外链设置已保存' });
    } catch (error) {
      setStatus({ ok: false, message: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-provider">
      <header className="settings-provider-head">
        <div>
          <b>素材外链</b>
          <span className="studio-badge">{strategy === 's3' ? 'S3 兼容桶' : 'Data URL'}</span>
        </div>
      </header>

      <label className="studio-field">
        <span>传输策略</span>
        <select value={strategy} onChange={(event) => setStrategy(event.target.value as 'dataUrl' | 's3')}>
          <option value="dataUrl">Data URL（仅兼容中转）</option>
          <option value="s3">S3 兼容桶（H3 官方接口）</option>
        </select>
      </label>

      {strategy === 's3' && (
        <>
          <label className="studio-field"><span>Endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://s3.us-east-1.amazonaws.com" /></label>
          <label className="studio-field"><span>Bucket</span><input value={bucket} onChange={(event) => setBucket(event.target.value)} /></label>
          <label className="studio-field"><span>Region</span><input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="us-east-1" /></label>
          <label className="studio-field"><span>对象前缀</span><input value={prefix} onChange={(event) => setPrefix(event.target.value)} /></label>
          <label className="studio-field"><span>公网访问前缀</span><input value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="https://cdn.example.com" /></label>
          <label className="studio-field">
            <span>Access Key {assetHost?.hasCredentials ? '（已保存，留空不修改）' : ''}</span>
            <input type="password" autoComplete="off" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} />
          </label>
          <label className="studio-field">
            <span>Secret Key {assetHost?.hasCredentials ? '（已保存，留空不修改）' : ''}</span>
            <input type="password" autoComplete="off" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} />
          </label>
          <p className="inspector-note">桶必须允许公开读取，H3 才能拉取素材。密钥只写入系统钥匙串，不进入项目与日志。</p>
        </>
      )}

      {strategy === 'dataUrl' && (
        <p className="inspector-note">Data URL 仅适用于支持 base64 素材的 OpenAI 兼容中转；H3 官方接口需要 S3 公网 URL。</p>
      )}

      <div className="settings-actions">
        <button type="button" className="studio-button" onClick={() => { void save(); }} disabled={busy}>
          {busy ? '保存中…' : '保存外链设置'}
        </button>
      </div>
      {status && <p className={status.ok ? 'settings-ok' : 'settings-error'}>{status.message}</p>}
    </section>
  );
}
