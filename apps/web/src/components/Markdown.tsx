"use client";

import { memo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";

// Recursively flatten a node tree back to plain text. With rehype-highlight the
// code children are React <span> elements (the highlighted tokens), so we can't
// just String() them — we walk the tree to recover the raw source for the
// copy button and the block/inline heuristic.
function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return nodeText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

// Renders assistant markdown using the app's AAA theme tokens. Kept as a
// component map (rather than relying on a bundled highlight.js theme) so every
// element stays theme-aware and contrast-compliant in both light and dark.
//
// Streaming-safe: react-markdown re-parses the partial string on each delta and
// tolerates unclosed fences / half-written syntax.

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy code"
      title="Copy code"
      className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const match = /language-(\w+)/.exec(className ?? "");
  const raw = nodeText(children).replace(/\n$/, "");
  const isBlock = Boolean(match) || raw.includes("\n");

  if (!isBlock) {
    return (
      <code className="rounded border border-primary/25 bg-primary/10 px-1 py-0.5 font-mono text-[0.9em] text-primary">
        {children}
      </code>
    );
  }

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1">
        <span className="font-mono text-xs font-semibold text-primary">{match?.[1] ?? "text"}</span>
        <span className="flex-1" />
        <CopyButton text={raw} />
      </div>
      <pre className="overflow-x-auto bg-muted/15 p-3 text-[13px] leading-relaxed">
        {/* className carries `hljs language-*`; token <span>s inside `children`
            are styled via the .hljs-* rules in globals.css (AAA tokens). */}
        <code className={cn("font-mono text-foreground", className)}>{children}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  p: ({ children }) => <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mb-2 mt-3 text-lg font-bold text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-3 text-base font-bold text-foreground first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-2.5 text-sm font-bold text-foreground first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-2 text-sm font-semibold text-foreground first:mt-0">{children}</h4>
  ),
  ul: ({ children }) => <ul className="my-1.5 ml-5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 ml-5 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-bold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through opacity-80">{children}</del>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  code: CodeBlock,
  // react-markdown wraps block code in <pre>; CodeBlock already renders its own
  // styled container, so collapse the default <pre> to avoid double nesting.
  pre: ({ children }) => <>{children}</>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
};

function MarkdownImpl({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // `ignoreMissing` keeps streaming safe: half-written fences or unknown
        // languages won't throw mid-stream.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
