import { useWorkerPool, WorkerPoolContextProvider } from '@pierre/diffs/react';
import PierreWorker from '@pierre/diffs/worker/worker.js?worker';
import { useEffect, type ReactNode } from 'react';
import { useAppSettings } from '../state/settings';

/** With a pool, Pierre highlights with the pool's theme (not each component's), so follow the code theme setting. */
function ThemeSync() {
  const pool = useWorkerPool();
  const theme = useAppSettings((s) => s.codeTheme);
  useEffect(() => {
    void pool?.setRenderOptions({ theme });
  }, [pool, theme]);
  return null;
}

const POOL_SIZE = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));

/**
 * Syntax highlighting runs in web workers, so large files (diffs now carry full contents) don't freeze the UI.
 * If the workers fail to start, Pierre falls back to highlighting on the main thread.
 */
export function HighlightWorkers({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={{ workerFactory: () => new PierreWorker(), poolSize: POOL_SIZE }} highlighterOptions={{ theme: useAppSettings.getState().codeTheme }}>
      <ThemeSync />
      {children}
    </WorkerPoolContextProvider>
  );
}
