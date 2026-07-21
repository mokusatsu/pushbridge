import { createContext, type PropsWithChildren, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ClientSettings, RuntimeSnapshot } from '@/types';
import { AppRuntime } from '@/services/runtime';

const RuntimeContext = createContext<AppRuntime | undefined>(undefined);

export function AppProvider({ settings, children }: PropsWithChildren<{ settings: ClientSettings }>) {
  const runtime = useMemo(() => new AppRuntime(settings), [settings]);

  useEffect(() => {
    void runtime.start();
    return () => runtime.stop();
  }, [runtime]);

  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useAppRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useAppRuntime must be used within AppProvider');
  return runtime;
}

export function useAppSnapshot(): RuntimeSnapshot {
  const runtime = useAppRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
}
