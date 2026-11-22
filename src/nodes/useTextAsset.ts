import { useEffect, useState } from 'react';
import { readAssetText } from '../services/tauri';
import { useStudioStore } from '../stores/studioStore';

export function useTextAsset(assetId?: string): string {
  const projectId = useStudioStore((state) => state.currentProjectId);
  const [text, setText] = useState('');

  useEffect(() => {
    if (!assetId) {
      setText('');
      return;
    }
    let alive = true;
    if (!projectId) return undefined;
    readAssetText(projectId, assetId)
      .then((value) => { if (alive) setText(value); })
      .catch(() => { if (alive) setText(''); });
    return () => { alive = false; };
  }, [assetId, projectId]);

  return text;
}
