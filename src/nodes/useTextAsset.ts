import { useEffect, useState } from 'react';
import { readAssetText } from '../services/tauri';

export function useTextAsset(assetId?: string): string {
  const [text, setText] = useState('');

  useEffect(() => {
    if (!assetId) {
      setText('');
      return;
    }
    let alive = true;
    readAssetText(assetId)
      .then((value) => { if (alive) setText(value); })
      .catch(() => { if (alive) setText(''); });
    return () => { alive = false; };
  }, [assetId]);

  return text;
}
