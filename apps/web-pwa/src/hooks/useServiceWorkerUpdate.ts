import { useEffect, useState } from 'react';
import { registerPushbridgeServiceWorker, type ServiceWorkerController } from '@/services/pwa';

const initial: ServiceWorkerController = {
  updateAvailable: false,
  applyUpdate() {},
};

export function useServiceWorkerUpdate(): ServiceWorkerController {
  const [controller, setController] = useState<ServiceWorkerController>(initial);

  useEffect(() => {
    let active = true;
    void registerPushbridgeServiceWorker((next) => {
      if (active) setController(next);
    }).then((next) => {
      if (active) setController(next);
    }).catch(() => {
      // An unavailable service worker must not block the REST client.
    });
    return () => { active = false; };
  }, []);

  return controller;
}
