"use client";

// Unlock screen for the LAN access gate. Invisible in the common case:
// localhost is exempt server-side, and once a device has the key in
// localStorage every transport attaches it automatically. This overlay only
// appears when the socket handshake is rejected with "access key required".

import { FormEvent, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { getSocket } from "@/lib/socket";
import { setAccessKey } from "@/lib/access-key";

export function AccessGate() {
  const [locked, setLocked] = useState(false);
  const [value, setValue] = useState("");
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    const onError = (err: Error) => {
      if (err?.message?.includes("access key")) {
        // Already showing + user just tried a key → that key was wrong.
        setRejected((prev) => prev || locked);
        setLocked(true);
      }
    };
    const onConnect = () => {
      setLocked(false);
      setRejected(false);
    };
    socket.on("connect_error", onError);
    socket.on("connect", onConnect);
    return () => {
      socket.off("connect_error", onError);
      socket.off("connect", onConnect);
    };
  }, [locked]);

  if (!locked) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setAccessKey(value);
    setRejected(false);
    const socket = getSocket();
    socket.disconnect();
    socket.connect(); // auth callback re-reads the stored key
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-background">
      <form
        onSubmit={submit}
        className="w-full max-w-sm mx-4 rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <div className="flex items-center gap-2 mb-2">
          <KeyRound className="w-4 h-4 text-primary" aria-hidden />
          <h1 className="text-sm font-semibold text-foreground">Access key required</h1>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          This device isn&apos;t the server machine. Paste the key from{" "}
          <code className="text-foreground">logs/mca-access-key.txt</code> on the server.
        </p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Access key"
          aria-label="Access key"
          className="w-full mb-3 px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
        {rejected && (
          <p role="alert" className="text-xs text-destructive mb-3">
            That key was rejected — check for typos or a stale key file.
          </p>
        )}
        <button
          type="submit"
          className="w-full px-3 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
        >
          Unlock
        </button>
      </form>
    </div>
  );
}
