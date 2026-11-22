import { useEffect, useState } from 'react';
import { assetUrl } from '../services/tauri';
import { useStudioStore } from '../stores/studioStore';

const cache = new Map<string, string>();

export function useAssetUrl(assetId?: string, projectId?: string): string | undefined {
  const currentProjectId = useStudioStore((state) => state.currentProjectId);
  const scope = projectId ?? currentProjectId;
  const cacheKey = scope && assetId ? `${scope}:${assetId}` : undefined;
  const [state, setState] = useState<{ id?: string; url?: string }>(() => ({
    id: assetId,
    url: cacheKey ? cache.get(cacheKey) : undefined,
  }));

  useEffect(() => {
    if (!assetId) {
      setState({ id: undefined, url: undefined });
      return;
    }
    const cached = cacheKey ? cache.get(cacheKey) : undefined;
    if (cached) {
      setState({ id: assetId, url: cached });
      return;
    }
    let alive = true;
    if (!scope) return undefined;
    assetUrl(scope, assetId)
      .then((value) => {
        if (!value) return;
        if (cacheKey) cache.set(cacheKey, value);
        if (alive) setState({ id: assetId, url: value });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [assetId, scope, cacheKey]);

  if (!assetId) return undefined;
  if (state.id === assetId) return state.url;
  return cacheKey ? cache.get(cacheKey) : undefined;
}
