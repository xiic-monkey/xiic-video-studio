import { useEffect, useState } from 'react';
import { assetUrl } from '../services/tauri';

const cache = new Map<string, string>();

export function useAssetUrl(assetId?: string): string | undefined {
  const [state, setState] = useState<{ id?: string; url?: string }>(() => ({
    id: assetId,
    url: assetId ? cache.get(assetId) : undefined,
  }));

  useEffect(() => {
    if (!assetId) {
      setState({ id: undefined, url: undefined });
      return;
    }
    const cached = cache.get(assetId);
    if (cached) {
      setState({ id: assetId, url: cached });
      return;
    }
    let alive = true;
    assetUrl(assetId)
      .then((value) => {
        if (!value) return;
        cache.set(assetId, value);
        if (alive) setState({ id: assetId, url: value });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [assetId]);

  if (!assetId) return undefined;
  if (state.id === assetId) return state.url;
  return cache.get(assetId);
}
