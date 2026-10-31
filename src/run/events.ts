import { onAssetCreated, onRunUpdated } from '../services/events';
import { useRunStore } from '../stores/runStore';

export async function attachRunEvents(): Promise<() => void> {
  const unlisteners = await Promise.all([
    onRunUpdated((event) => {
      const store = useRunStore.getState();
      store.upsertRun(event.run);
      store.mergeAssets(event.assets);
    }),
    onAssetCreated((asset) => {
      useRunStore.getState().mergeAssets([asset]);
    }),
  ]);
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}
