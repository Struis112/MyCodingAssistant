// Root page renders the app directly — no marketing page.
// Force dynamic so client-only hooks (useTheme, WebSocket) work without prerender.
export const dynamic = "force-dynamic";

import { AppShell } from "@/components/AppShell";

export default function Page() {
  return <AppShell />;
}
