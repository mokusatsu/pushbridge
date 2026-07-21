export interface ServiceWorkerController {
  registration?: ServiceWorkerRegistration;
  updateAvailable: boolean;
  applyUpdate(): void;
}

export async function registerPushbridgeServiceWorker(
  onUpdate: (controller: ServiceWorkerController) => void,
): Promise<ServiceWorkerController> {
  const state: ServiceWorkerController = {
    updateAvailable: false,
    applyUpdate() {
      state.registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
    },
  };

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return state;

  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  state.registration = registration;

  const announceUpdate = () => {
    if (!registration.waiting) return;
    state.updateAvailable = true;
    onUpdate({ ...state });
  };

  if (registration.waiting) announceUpdate();
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) announceUpdate();
    });
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.setInterval(() => void registration.update(), 60 * 60 * 1000);
  return state;
}
