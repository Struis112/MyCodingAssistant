// Thin REST client for the MCA server. The chat transport is WebSocket (see
// lib/socket.ts); these are the few request/response endpoints that don't fit
// the streaming model. SERVER_URL mirrors the socket/useModels default so a
// single env var (NEXT_PUBLIC_SERVER_URL) configures every transport.

export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:7641";

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
