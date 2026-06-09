// Thin REST client for the MCA server. The chat transport is WebSocket (see
// lib/socket.ts); these are the few request/response endpoints that don't fit
// the streaming model. SERVER_URL mirrors the socket/useModels default so a
// single env var (NEXT_PUBLIC_SERVER_URL) configures every transport.

// Resolve the API/WebSocket base URL. When NEXT_PUBLIC_SERVER_URL isn't set,
// derive it from the page's own host so the app works over the LAN (a remote
// device must NOT talk to its own "localhost"). Falls back to localhost during
// SSR (no window) and for the default local case.
function resolveServerUrl(): string {
  if (process.env.NEXT_PUBLIC_SERVER_URL) return process.env.NEXT_PUBLIC_SERVER_URL;
  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:7641`;
  }
  return "http://localhost:7641";
}

export const SERVER_URL = resolveServerUrl();

export interface ApiResult {
  ok: boolean;
  error?: string;
}

/**
 * Revert a single `edit` change by reverse-applying its standard unified patch
 * (`details.patch`). The server only writes when the file still contains the
 * edited block verbatim, so a stale revert fails cleanly (409) instead of
 * corrupting the file.
 */
export async function revertEdit(path: string, patch: string): Promise<ApiResult> {
  try {
    const res = await fetch(`${SERVER_URL}/api/files/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, patch }),
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (res.ok && body.success) return { ok: true };
    return { ok: false, error: body.error || `Revert failed (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
