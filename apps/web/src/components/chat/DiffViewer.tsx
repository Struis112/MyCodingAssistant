"use client";

import { useMemo, useState } from "react";
import { Check, Columns2, Copy, Loader2, Rows3, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { revertEdit } from "@/lib/api";
import { readString, writeString } from "@/lib/store";
import { diffStats, parseDiff, toSplitRows, type SplitCell } from "./diff";

type ViewMode = "split" | "unified";
const VIEW_KEY = "mca-diff-view";

/**
 * JetBrains-style diff viewer for a file edit. Renders the SDK's display diff
 * (`details.diff`) either side-by-side ("Split") or inline ("Unified"), with
 * line-number gutters, +/- stats, and a copy-to-clipboard action.
 */
export function DiffViewer({
  diff,
  fileName,
  filePath,
  patch,
}: {
  diff: string;
  fileName?: string;
  /** Project-relative path used by the revert endpoint. */
  filePath?: string;
  /** Standard unified patch (`details.patch`); enables the Revert action. */
  patch?: string;
}) {
  const rows = useMemo(() => parseDiff(diff), [diff]);
  const split = useMemo(() => toSplitRows(rows), [rows]);
  const stats = useMemo(() => diffStats(rows), [rows]);

  const [view, setView] = useState<ViewMode>(() =>
    readString(VIEW_KEY, "split") === "unified" ? "unified" : "split",
  );
  const [copied, setCopied] = useState(false);
  const [revert, setRevert] = useState<
    { state: "idle" | "reverting" | "done" } | { state: "error"; message: string }
  >({ state: "idle" });

  const canRevert = Boolean(filePath && patch);
  const doRevert = async () => {
    if (!filePath || !patch || revert.state === "reverting" || revert.state === "done") return;
    setRevert({ state: "reverting" });
    const result = await revertEdit(filePath, patch);
    setRevert(
      result.ok ? { state: "done" } : { state: "error", message: result.error ?? "Revert failed." },
    );
  };

  const setMode = (mode: ViewMode) => {
    setView(mode);
    writeString(VIEW_KEY, mode);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  if (rows.length === 0) return null;

  return (
    <div className="rounded-md border border-border overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border bg-card/60 text-xs">
        {fileName && <span className="font-semibold text-foreground truncate">{fileName}</span>}
        <span className="flex items-center gap-1.5 font-mono shrink-0">
          {stats.additions > 0 && <span className="text-success">+{stats.additions}</span>}
          {stats.deletions > 0 && <span className="text-error">−{stats.deletions}</span>}
        </span>
        <div className="flex-1" />
        <div className="flex items-center rounded border border-border overflow-hidden shrink-0">
          <ToggleButton
            active={view === "split"}
            onClick={() => setMode("split")}
            label="Side-by-side view"
          >
            <Columns2 className="w-3.5 h-3.5" />
          </ToggleButton>
          <ToggleButton
            active={view === "unified"}
            onClick={() => setMode("unified")}
            label="Unified view"
          >
            <Rows3 className="w-3.5 h-3.5" />
          </ToggleButton>
        </div>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy diff"
          className="flex items-center justify-center w-6 h-6 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
        {canRevert && (
          <button
            type="button"
            onClick={doRevert}
            disabled={revert.state === "reverting" || revert.state === "done"}
            aria-label="Revert this change"
            title={
              revert.state === "error"
                ? revert.message
                : revert.state === "done"
                  ? "Change reverted"
                  : "Revert this change"
            }
            className={cn(
              "flex items-center gap-1 h-6 px-1.5 rounded border text-xs transition-colors shrink-0",
              revert.state === "done"
                ? "border-success/40 text-success"
                : revert.state === "error"
                  ? "border-error/40 text-error hover:bg-error/10"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-accent",
            )}
          >
            {revert.state === "reverting" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : revert.state === "done" ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <Undo2 className="w-3.5 h-3.5" />
            )}
            <span>{revert.state === "done" ? "Reverted" : "Revert"}</span>
          </button>
        )}
      </div>
      {revert.state === "error" && (
        <div className="px-2.5 py-1 border-b border-border bg-error/10 text-error text-xs">
          {revert.message}
        </div>
      )}

      {/* Body */}
      <div className="overflow-x-auto">
        {view === "split" ? <SplitView rows={split} /> : <UnifiedView rows={rows} />}
      </div>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        "flex items-center justify-center w-6 h-6 transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

const NUM_CELL = "select-none text-right align-top px-2 text-muted-foreground tabular-nums w-px";
const CODE_CELL = "align-top pr-3 pl-1 whitespace-pre";

function cellBg(kind: SplitCell["kind"] | "empty"): string {
  if (kind === "add") return "bg-success/10";
  if (kind === "del") return "bg-error/10";
  if (kind === "empty") return "bg-muted/20";
  return "";
}

function numBg(kind: SplitCell["kind"]): string {
  if (kind === "add") return "bg-success/15 text-success";
  if (kind === "del") return "bg-error/15 text-error";
  return "";
}

function SplitView({ rows }: { rows: ReturnType<typeof toSplitRows> }) {
  return (
    <table className="border-collapse font-mono text-xs leading-relaxed w-full">
      <tbody>
        {rows.map((row, i) => {
          if ("gap" in row && row.gap) {
            return (
              <tr key={i}>
                <td
                  colSpan={4}
                  className="px-3 py-0.5 text-center text-muted-foreground/60 select-none"
                >
                  ⋯
                </td>
              </tr>
            );
          }
          const left = row.left;
          const right = row.right;
          return (
            <tr key={i}>
              <td className={cn(NUM_CELL, left ? numBg(left.kind) : "")}>{left?.num ?? ""}</td>
              <td
                className={cn(CODE_CELL, "border-r border-border", cellBg(left?.kind ?? "empty"))}
              >
                {left?.text ?? ""}
              </td>
              <td className={cn(NUM_CELL, right ? numBg(right.kind) : "")}>{right?.num ?? ""}</td>
              <td className={cn(CODE_CELL, cellBg(right?.kind ?? "empty"))}>{right?.text ?? ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function UnifiedView({ rows }: { rows: ReturnType<typeof parseDiff> }) {
  return (
    <table className="border-collapse font-mono text-xs leading-relaxed w-full">
      <tbody>
        {rows.map((row, i) => {
          if (row.type === "gap") {
            return (
              <tr key={i}>
                <td
                  colSpan={4}
                  className="px-3 py-0.5 text-center text-muted-foreground/60 select-none"
                >
                  ⋯
                </td>
              </tr>
            );
          }
          const kind = row.type === "context" ? "context" : row.type;
          const sign = row.type === "add" ? "+" : row.type === "del" ? "−" : " ";
          const oldNum = row.type === "add" ? "" : row.oldNum;
          const newNum = row.type === "del" ? "" : row.newNum;
          return (
            <tr key={i} className={cellBg(kind)}>
              <td className={cn(NUM_CELL, kind === "del" && numBg("del"))}>{oldNum}</td>
              <td className={cn(NUM_CELL, kind === "add" && numBg("add"))}>{newNum}</td>
              <td
                className={cn(
                  "select-none text-center w-px px-1 align-top",
                  kind === "add" && "text-success",
                  kind === "del" && "text-error",
                )}
              >
                {sign}
              </td>
              <td className={cn(CODE_CELL, "pl-1")}>{row.text}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
