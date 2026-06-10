"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Loader2,
  Package,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { getSocket } from "@/lib/socket";
import { SERVER_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

type ServiceState =
  | "stopped"
  | "starting"
  | "running"
  | "validating"
  | "rebuilding"
  | "repairing"
  | "backoff"
  | "failed";

interface ServiceStatus {
  name: string;
  description: string;
  state: ServiceState;
  pid?: number;
  port?: number;
  startedAt?: number;
  uptimeMs?: number;
  restarts: number;
  maxRestarts: number;
  nextRestartAt?: number;
  lastError?: string;
  lastRepair?: string;
  hotReloadEnabled: boolean;
  mode?: string;
}

interface LogLine {
  ts: number;
  stream: "out" | "err" | "sys";
  text: string;
}

/**
 * Services inventory. Lists every supervised service the server reports
 * (`GET /api/services`, live updates via the `services:status` socket event)
 * and lets you restart each one. Designed to be low-cognitive-load: one card
 * per service, a plain-language status line, and details on demand.
 */
export function ServicesView() {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/services`);
      if (res.ok) setServices(await res.json());
    } catch {
      /* server unreachable — leave last-known list */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const socket = getSocket();
    const onStatus = (list: ServiceStatus[]) => setServices(list);
    socket.on("services:status", onStatus);
    refresh();
    // Light polling backstop for uptime ticking + missed events.
    const id = setInterval(refresh, 5_000);
    return () => {
      socket.off("services:status", onStatus);
      clearInterval(id);
    };
  }, [refresh]);

  return (
    <div className="flex flex-col h-full bg-background">
      <header className="h-8 border-b border-border flex items-center px-3 gap-2 shrink-0">
        <Activity className="w-4 h-4 text-primary" />
        <h1 className="text-xs font-semibold text-foreground">Services</h1>
        <div className="flex-1" />
        <button
          onClick={refresh}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
          aria-label="Refresh services"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto mb-3">
          <RunModeControl />
        </div>
        {loading && services.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Loader2 className="w-8 h-8 mb-3 animate-spin opacity-60" />
            <p className="text-sm">Loading services…</p>
          </div>
        ) : services.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <CircleSlash className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">No services reported</p>
            <p className="text-xs mt-2">Is the API server running on {SERVER_URL}?</p>
          </div>
        ) : (
          <div className="space-y-3 max-w-3xl mx-auto">
            {services.map((svc) => (
              <ServiceCard key={svc.name} svc={svc} />
            ))}
            <HealingFeed />
          </div>
        )}
      </div>
    </div>
  );
}

// ----- self-healing event feed -----

interface HealingEvent {
  at: number;
  source: string;
  kind: string;
  message: string;
}

function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * Recent self-healing actions (deploy promote/rollback/park, watch-safe
 * restarts, model quarantine). Makes "is self-healing doing anything?"
 * answerable at a glance. Newest first; quiet when there's nothing.
 */
function HealingFeed() {
  const [events, setEvents] = useState<HealingEvent[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/healing-events`);
        if (r.ok && alive) setEvents(((await r.json()) as { events: HealingEvent[] }).events ?? []);
      } catch {
        /* unreachable — keep last list */
      }
    };
    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="border border-border rounded-lg p-4 bg-card">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold text-foreground">Self-healing events</h2>
        <span className="text-xs text-muted-foreground">last {events.length}</span>
      </div>
      {events.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing yet — events appear here when the system restarts, rolls back, or quarantines
          something on its own.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {events.slice(0, 20).map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex items-start gap-2 text-xs">
              <span className="shrink-0 mt-0.5 px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                {e.source}
              </span>
              <span className="text-foreground min-w-0">{e.message}</span>
              <span
                className="ml-auto shrink-0 text-muted-foreground"
                title={new Date(e.at).toLocaleString()}
              >
                {timeAgo(e.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----- run mode (dev/HMR ↔ prod) -----

type RunMode = "dev" | "prod";

function ModeButton({
  label,
  Icon,
  active,
  disabled,
  busy,
  onClick,
}: {
  label: string;
  Icon: typeof Zap;
  active: boolean;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || active}
      title={active ? `Currently running in ${label}` : `Switch to ${label}`}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border transition-colors",
        active
          ? "border-primary/50 text-primary bg-primary/10"
          : disabled
            ? "opacity-50 cursor-not-allowed border-border text-muted-foreground"
            : "border-border text-foreground hover:border-primary/40 hover:text-primary",
      )}
    >
      <Icon className={cn("w-3.5 h-3.5", busy && "animate-spin")} />
      {label}
    </button>
  );
}

/**
 * Switch the whole stack between dev/HMR (instant edits) and a production build.
 * Flipping the mode reconfigures + restarts the NSSM service, so the page will
 * briefly disconnect (and auto-reload if the web bundle changed).
 */
function RunModeControl() {
  const [mode, setMode] = useState<RunMode | null>(null);
  const [canSwitch, setCanSwitch] = useState(false);
  const [busy, setBusy] = useState<RunMode | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${SERVER_URL}/api/runmode`);
      if (r.ok) {
        const d = await r.json();
        setMode(d.mode);
        setCanSwitch(!!d.canSwitch);
      }
    } catch {
      /* server unreachable */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While a switch is in flight the service restarts; poll until it reports the
  // target mode, then clear the busy state.
  useEffect(() => {
    if (!switching || !busy) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/runmode`);
        if (r.ok) {
          const d = await r.json();
          if (d.mode === busy) {
            setMode(d.mode);
            setSwitching(false);
            setBusy(null);
          }
        }
      } catch {
        /* still restarting */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [switching, busy]);

  const switchTo = useCallback(
    async (target: RunMode) => {
      if (target === mode) return;
      setBusy(target);
      setError(null);
      try {
        const r = await fetch(`${SERVER_URL}/api/runmode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: target }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) {
          setError(d.error || `Switch failed (${r.status})`);
          setBusy(null);
          return;
        }
        if (d.restarting) setSwitching(true);
        else {
          setBusy(null);
          load();
        }
      } catch (e) {
        setError(String(e));
        setBusy(null);
      }
    },
    [mode, load],
  );

  return (
    <div className="border border-border rounded-lg bg-card p-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-card-foreground">Run mode</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {mode === "dev"
              ? "Dev / HMR — edits appear instantly (next dev + server auto-restart)."
              : mode === "prod"
                ? "Production build — optimized bundle; changes need a rebuild + restart."
                : "—"}
          </p>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <ModeButton
            label="Dev (HMR)"
            Icon={Zap}
            active={mode === "dev"}
            disabled={!canSwitch || !!busy || switching}
            busy={busy === "dev"}
            onClick={() => switchTo("dev")}
          />
          <ModeButton
            label="Prod"
            Icon={Package}
            active={mode === "prod"}
            disabled={!canSwitch || !!busy || switching}
            busy={busy === "prod"}
            onClick={() => switchTo("prod")}
          />
        </div>
      </div>
      {switching && (
        <p className="text-xs text-warning mt-2 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Switching to {busy === "prod" ? "Prod" : "Dev"}… the service is restarting
          {busy === "prod" ? " (building first, ~15s)" : ""}.
        </p>
      )}
      {!canSwitch && (
        <p className="text-xs text-muted-foreground mt-2">
          Mode switching needs the NSSM-managed service (running as Administrator).
        </p>
      )}
      {error && <p className="text-xs text-error mt-2 break-words">{error}</p>}
    </div>
  );
}

// ----- presentation helpers -----

const STATE_META: Record<
  ServiceState,
  { label: string; tone: string; Icon: typeof CircleCheck; spin?: boolean }
> = {
  running: {
    label: "Running",
    tone: "text-success border-success/40 bg-success/10",
    Icon: CircleCheck,
  },
  starting: {
    label: "Starting",
    tone: "text-warning border-warning/40 bg-warning/10",
    Icon: Loader2,
    spin: true,
  },
  validating: {
    label: "Validating",
    tone: "text-info border-info/40 bg-info/10",
    Icon: Loader2,
    spin: true,
  },
  rebuilding: {
    label: "Rebuilding",
    tone: "text-info border-info/40 bg-info/10",
    Icon: Loader2,
    spin: true,
  },
  repairing: {
    label: "Self-repairing",
    tone: "text-info border-info/40 bg-info/10",
    Icon: Loader2,
    spin: true,
  },
  backoff: {
    label: "Restarting soon",
    tone: "text-warning border-warning/40 bg-warning/10",
    Icon: TriangleAlert,
  },
  failed: { label: "Failed", tone: "text-error border-error/40 bg-error/10", Icon: TriangleAlert },
  stopped: {
    label: "Stopped",
    tone: "text-muted-foreground border-border bg-muted/40",
    Icon: CircleSlash,
  },
};

function formatUptime(ms?: number): string {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

type Action = "start" | "stop" | "restart";

/** A compact, consistent lifecycle button (Start / Stop / Restart). */
function ActionButton({
  label,
  Icon,
  onClick,
  disabled,
  spinning,
  title,
  ariaLabel,
}: {
  label: string;
  Icon: typeof RotateCw;
  onClick: () => void;
  disabled: boolean;
  spinning: boolean;
  title: string;
  ariaLabel: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border transition-colors w-full justify-center",
        disabled
          ? "opacity-50 cursor-not-allowed border-border text-muted-foreground"
          : "border-border text-foreground hover:border-primary/40 hover:text-primary",
      )}
    >
      <Icon className={cn("w-3.5 h-3.5", spinning && "animate-spin")} />
      {label}
    </button>
  );
}

function ServiceCard({ svc }: { svc: ServiceStatus }) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const meta = STATE_META[svc.state];
  const StateIcon = meta.Icon;
  const selfManaged = svc.maxRestarts === 0; // the API server reports on itself
  // "Active" = the supervisor is trying to keep it up; Stop applies here and
  // Start is a no-op. Stopped/failed are the only states where Start makes sense.
  const active = [
    "running",
    "starting",
    "validating",
    "rebuilding",
    "repairing",
    "backoff",
  ].includes(svc.state);

  const runAction = useCallback(
    async (action: Action) => {
      setBusy(action);
      setError(null);
      try {
        const res = await fetch(`${SERVER_URL}/api/services/${svc.name}/${action}`, {
          method: "POST",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || `${action} failed (${res.status})`);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [svc.name],
  );

  const loadLogs = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/services/${svc.name}/logs`);
      if (res.ok) setLogs(await res.json());
    } catch {
      /* ignore */
    }
  }, [svc.name]);

  const toggleLogs = useCallback(() => {
    setLogsOpen((open) => {
      if (!open) void loadLogs();
      return !open;
    });
  }, [loadLogs]);

  const summary = useMemo(() => describeStatus(svc), [svc]);

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium shrink-0",
            meta.tone,
          )}
        >
          <StateIcon className={cn("w-3.5 h-3.5", meta.spin && "animate-spin")} />
          {meta.label}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-card-foreground truncate">{svc.name}</h2>
            {svc.mode && (
              <span
                className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 py-0.5"
                title={
                  svc.mode === "dev"
                    ? "Dev profile — fast-refresh, served by `next dev`"
                    : svc.mode === "prod"
                      ? "Production profile — built bundle, served by `next start`"
                      : `Run profile: ${svc.mode}`
                }
              >
                {svc.mode}
              </span>
            )}
            {svc.hotReloadEnabled && (
              <span
                className="text-[10px] uppercase tracking-wide text-info border border-info/40 rounded px-1 py-0.5"
                title="Serves the latest code automatically on change"
              >
                hot-reload
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">{svc.description}</p>
          <p className="text-xs text-muted-foreground mt-1">{summary}</p>

          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
            {svc.port !== undefined && <span>port {svc.port}</span>}
            {svc.pid !== undefined && <span>pid {svc.pid}</span>}
            {svc.state === "running" && <span>up {formatUptime(svc.uptimeMs)}</span>}
            {svc.maxRestarts > 0 && (
              <span>
                restarts {svc.restarts}/{svc.maxRestarts}
              </span>
            )}
          </div>

          {svc.lastRepair && (
            <p className="text-xs text-info mt-2">
              <span className="font-medium">Self-repair:</span> {svc.lastRepair}
            </p>
          )}
          {svc.state === "failed" && svc.lastError && (
            <p className="text-xs text-error mt-2 break-words">{svc.lastError}</p>
          )}
          {error && <p className="text-xs text-error mt-2 break-words">{error}</p>}
        </div>

        <div className="flex flex-col gap-1.5 shrink-0 w-[88px]">
          <ActionButton
            label="Start"
            Icon={Play}
            onClick={() => runAction("start")}
            spinning={busy === "start"}
            disabled={!!busy || selfManaged || active}
            title={
              selfManaged
                ? "This service manages its own process and can't be controlled from here"
                : active
                  ? "Already running"
                  : `Start ${svc.name}`
            }
            ariaLabel={`Start ${svc.name}`}
          />
          <ActionButton
            label="Stop"
            Icon={Square}
            onClick={() => runAction("stop")}
            spinning={busy === "stop"}
            disabled={!!busy || selfManaged || !active}
            title={
              selfManaged
                ? "This service manages its own process and can't be controlled from here"
                : !active
                  ? "Not running"
                  : `Stop ${svc.name}`
            }
            ariaLabel={`Stop ${svc.name}`}
          />
          <ActionButton
            label="Restart"
            Icon={RotateCw}
            onClick={() => runAction("restart")}
            spinning={busy === "restart"}
            disabled={!!busy || selfManaged}
            title={
              selfManaged
                ? "This service manages its own process and can't be controlled from here"
                : `Restart ${svc.name}`
            }
            ariaLabel={`Restart ${svc.name}`}
          />
        </div>
      </div>

      <button
        onClick={toggleLogs}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border-t border-border transition-colors"
        aria-expanded={logsOpen}
      >
        {logsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Recent logs
      </button>
      {logsOpen && (
        <pre className="max-h-64 overflow-auto bg-background border-t border-border px-3 py-2 text-[11px] leading-relaxed font-mono">
          {logs.length === 0 ? (
            <span className="text-muted-foreground">No logs captured yet.</span>
          ) : (
            logs.map((l, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-words",
                  l.stream === "err" && "text-error",
                  l.stream === "sys" && "text-info",
                  l.stream === "out" && "text-foreground",
                )}
              >
                {l.text}
              </div>
            ))
          )}
        </pre>
      )}
    </div>
  );
}

/** One calm sentence describing what the service is doing right now. */
function describeStatus(svc: ServiceStatus): string {
  switch (svc.state) {
    case "running":
      return "Healthy and serving requests.";
    case "starting":
      return "Spinning up…";
    case "validating":
      return "Checking your latest change builds cleanly before activating it…";
    case "rebuilding":
      return "Rebuilding to serve your latest changes…";
    case "repairing":
      return "Crashed — checking logs and attempting an automatic fix…";
    case "backoff": {
      const secs = svc.nextRestartAt
        ? Math.max(0, Math.round((svc.nextRestartAt - Date.now()) / 1000))
        : null;
      return secs !== null
        ? `Crashed — retrying in ${secs}s (attempt ${svc.restarts}/${svc.maxRestarts}).`
        : `Crashed — retrying (attempt ${svc.restarts}/${svc.maxRestarts}).`;
    }
    case "failed":
      return `Gave up after ${svc.restarts} attempt${svc.restarts === 1 ? "" : "s"}. Fix the cause, then restart manually.`;
    case "stopped":
      return "Not running.";
    default:
      return "";
  }
}
