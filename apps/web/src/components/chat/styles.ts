// Central styling configuration for the chat surface.
//
// Single source of truth for the visual identity (color + label + icon) of
// every category and subcategory of chat item. Every renderer in
// components/chat/ reads from here, so:
//
//   1. Categories are visually distinct AT A GLANCE (each has its own
//      accent color, badge label, and lucide icon).
//   2. Adding a new tool / sub-block type or recolouring an existing one
//      is a one-file change -- nothing else needs to know about it.
//   3. Customising at runtime without touching code is a CSS-only edit:
//      override --user-accent / --assistant-accent / --tool-accent /
//      --system-accent in globals.css (or in your own override
//      stylesheet) and the whole chat re-themes for that category.
//
// HOW TO CUSTOMISE
//
//   Per category (user / assistant / tool / system):
//     edit ITEM_STYLES below to change badge label, icon, or accent token.
//     For colour-only changes, prefer editing the CSS variables in
//     globals.css so light + dark stay coherent.
//
//   Per tool (bash / read / edit / write / glob / grep / your own):
//     edit TOOL_STYLES to give a specific tool name its own icon and
//     accent. Tools without an entry fall back to TOOL_DEFAULT_STYLE.
//
//   Per tool-execution status (running / success / error):
//     edit TOOL_STATUS_STYLES. The icon and accent of the status dot
//     come from here.
//
//   Assistant sub-blocks (text vs thinking):
//     edit ASSISTANT_BLOCK_STYLES.
//
// HOW THIS MAPS TO TAILWIND
//
// `accentClasses(token)` returns a bundle of literal tailwind class
// strings (text-foo, bg-foo/15, border-foo/40, ...). The classes are
// written out by name in the switch below so Tailwind's content scanner
// picks them up at build time; do NOT switch to a template literal like
// `text-${token}` -- those classes would silently be purged from the
// final CSS bundle.

import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  Edit3,
  FileText,
  Loader2,
  Search,
  Sparkles,
  Terminal,
  User,
  Wrench,
  X,
} from "lucide-react";

// =============================================================================
// Accent tokens
// =============================================================================
//
// Each AccentToken corresponds to a tailwind colour name (which in turn
// resolves to an `rgb(var(--token) / <alpha>)` value at build time).
// Adding a new accent: add the CSS variable in globals.css, register the
// matching tailwind colour in tailwind.config.js, add the token to this
// union and to the switch in accentClasses() below.

export type AccentToken =
  // Per-category aliases (the recommended customisation surface).
  | "user-accent"
  | "assistant-accent"
  | "tool-accent"
  | "system-accent"
  // Direct references to the base palette, useful for sub-categories
  // (per-tool overrides, status colours, etc.).
  | "primary"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "muted-foreground";

export interface AccentClasses {
  /** Foreground text colour. */
  text: string;
  /** Subtle background tint (~10-15% alpha). Use for badge backgrounds. */
  bgTint: string;
  /** Slightly stronger background (~25% alpha). Use for highlighted pills. */
  bgSolid: string;
  /** Border with reduced alpha for soft outlines. */
  border: string;
  /** Border at full opacity for the left rail / strong dividers. */
  rail: string;
}

/**
 * Turn an accent token into a bundle of tailwind class strings.
 *
 * We write each branch out by hand (instead of `text-${token}`) so the
 * tailwind content scanner sees the full class names at build time. If
 * you add a new AccentToken, add a matching `case` below or the styling
 * will silently fall back to the muted defaults.
 */
export function accentClasses(token: AccentToken): AccentClasses {
  switch (token) {
    case "user-accent":
      return {
        text: "text-user-accent",
        bgTint: "bg-user-accent/15",
        bgSolid: "bg-user-accent/25",
        border: "border-user-accent/40",
        rail: "border-user-accent",
      };
    case "assistant-accent":
      return {
        text: "text-assistant-accent",
        bgTint: "bg-assistant-accent/15",
        bgSolid: "bg-assistant-accent/25",
        border: "border-assistant-accent/40",
        rail: "border-assistant-accent",
      };
    case "tool-accent":
      return {
        text: "text-tool-accent",
        bgTint: "bg-tool-accent/15",
        bgSolid: "bg-tool-accent/25",
        border: "border-tool-accent/40",
        rail: "border-tool-accent",
      };
    case "system-accent":
      return {
        text: "text-system-accent",
        bgTint: "bg-system-accent/15",
        bgSolid: "bg-system-accent/25",
        border: "border-system-accent/40",
        rail: "border-system-accent",
      };
    case "primary":
      return {
        text: "text-primary",
        bgTint: "bg-primary/15",
        bgSolid: "bg-primary/25",
        border: "border-primary/40",
        rail: "border-primary",
      };
    case "success":
      return {
        text: "text-success",
        bgTint: "bg-success/15",
        bgSolid: "bg-success/25",
        border: "border-success/40",
        rail: "border-success",
      };
    case "warning":
      return {
        text: "text-warning",
        bgTint: "bg-warning/15",
        bgSolid: "bg-warning/25",
        border: "border-warning/40",
        rail: "border-warning",
      };
    case "error":
      return {
        text: "text-error",
        bgTint: "bg-error/15",
        bgSolid: "bg-error/25",
        border: "border-error/40",
        rail: "border-error",
      };
    case "info":
      return {
        text: "text-info",
        bgTint: "bg-info/15",
        bgSolid: "bg-info/25",
        border: "border-info/40",
        rail: "border-info",
      };
    case "muted-foreground":
      return {
        text: "text-muted-foreground",
        bgTint: "bg-muted/30",
        bgSolid: "bg-muted/50",
        border: "border-border",
        rail: "border-muted-foreground",
      };
  }
}

// =============================================================================
// Per-category styles
// =============================================================================

export type ItemKind = "user" | "assistant" | "tool" | "system";

export interface ItemStyle {
  /** Accent token for the role badge + left rail. */
  accent: AccentToken;
  /** Pill label ("You", "Assistant", "Tool", "System"). */
  label: string;
  /** Lucide icon shown inside the badge -- helps recognition with colour off. */
  icon: LucideIcon;
}

export const ITEM_STYLES: Record<ItemKind, ItemStyle> = {
  user: { accent: "user-accent", label: "You", icon: User },
  assistant: { accent: "assistant-accent", label: "Assistant", icon: Sparkles },
  tool: { accent: "tool-accent", label: "Tool", icon: Wrench },
  system: { accent: "system-accent", label: "System", icon: AlertCircle },
};

// =============================================================================
// Per-tool styles (subcategory)
// =============================================================================

export interface ToolKindStyle {
  accent: AccentToken;
  icon: LucideIcon;
  /**
   * When true, ToolItem omits the tool name from the collapsed header
   * because the icon + the first arg are self-explanatory. Used for the
   * Bash case where "Bash <command>" is noisier than just "<command>".
   */
  hideName?: boolean;
}

/** Per-tool overrides, keyed by lowercase tool name. */
export const TOOL_STYLES: Record<string, ToolKindStyle> = {
  bash: { accent: "muted-foreground", icon: Terminal, hideName: true },
  read: { accent: "info", icon: BookOpen },
  edit: { accent: "primary", icon: Edit3 },
  write: { accent: "warning", icon: FileText },
  glob: { accent: "muted-foreground", icon: Search },
  grep: { accent: "muted-foreground", icon: Search },
};

export const TOOL_DEFAULT_STYLE: ToolKindStyle = {
  accent: "tool-accent",
  icon: Wrench,
};

/** Lookup helper. Case-insensitive. */
export function getToolStyle(toolName: string | undefined): ToolKindStyle {
  if (!toolName) return TOOL_DEFAULT_STYLE;
  return TOOL_STYLES[toolName.toLowerCase()] ?? TOOL_DEFAULT_STYLE;
}

// =============================================================================
// Tool status (running / success / error)
// =============================================================================

export type ToolStatus = "running" | "success" | "error";

export interface ToolStatusStyle {
  accent: AccentToken;
  icon: LucideIcon;
}

export const TOOL_STATUS_STYLES: Record<ToolStatus, ToolStatusStyle> = {
  running: { accent: "warning", icon: Loader2 },
  success: { accent: "success", icon: Check },
  error: { accent: "error", icon: X },
};

// =============================================================================
// Assistant sub-blocks
// =============================================================================

export interface AssistantBlockStyle {
  accent: AccentToken;
  icon?: LucideIcon;
  /** Used by ThinkingBlock's expand/collapse caret. */
  expandIcon?: LucideIcon;
}

export const ASSISTANT_BLOCK_STYLES: Record<"text" | "thinking", AssistantBlockStyle> = {
  text: { accent: "assistant-accent" },
  thinking: { accent: "muted-foreground", icon: Brain, expandIcon: ChevronRight },
};
