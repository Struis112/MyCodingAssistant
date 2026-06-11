// Client half of the LAN access gate. The key (from logs/mca-access-key.txt
// on the server box) is stored once in localStorage and attached to every
// API request automatically:
//  - fetch: a one-time global patch adds the x-mca-key header to SERVER_URL
//    requests, so the many existing call sites don't need touching.
//  - socket.io: lib/socket.ts sends it in the handshake auth payload.
// On localhost the server exempts loopback, so the key is only ever needed
// from other devices.

import { SERVER_URL } from "@/lib/api";

const STORAGE_KEY = "mca:accessKey";

export function getAccessKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAccessKey(key: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, key.trim());
  } catch {
    /* private mode etc. — gate prompt will just reappear next visit */
  }
}

let patched = false;

/** Attach the access key to all fetches against the API origin. Idempotent. */
export function installAccessKeyFetch(): void {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(SERVER_URL)) {
      const key = getAccessKey();
      if (key) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        if (!headers.has("x-mca-key")) headers.set("x-mca-key", key);
        return original(input, { ...init, headers });
      }
    }
    return original(input, init);
  };
}
