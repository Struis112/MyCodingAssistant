// Server Component - prevents static prerendering
export const dynamic = 'force-dynamic';

import { AppShell } from './AppShell';

export default function AppPage() {
  return <AppShell />;
}
