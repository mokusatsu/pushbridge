import { AppShell } from '@/components/AppShell';
import { useHashRoute } from '@/hooks/useHashRoute';
import { ComposePage } from '@/pages/ComposePage';
import { DevicesPage } from '@/pages/DevicesPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TimelinePage } from '@/pages/TimelinePage';

export default function App() {
  const route = useHashRoute();
  const page = route === 'compose'
    ? <ComposePage />
    : route === 'devices'
      ? <DevicesPage />
      : route === 'settings'
        ? <SettingsPage />
        : <TimelinePage />;

  return <AppShell route={route}>{page}</AppShell>;
}
