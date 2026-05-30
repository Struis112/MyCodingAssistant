// File handling helpers for the chat drag/drop UX.
//
// Two file categories are supported:
//   - image/* → sent to the LLM as a base64 image attachment (Pi SDK
//     `prompt(text, { images })`).
//   - text/* + known code/text extensions → inlined into the prompt body
//     so the model sees the content directly.
//
// Anything else is rejected with a friendly message.

export type PendingFileKind = "image" | "text" | "unsupported";

export interface PendingFile {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  kind: PendingFileKind;
  /** base64 (no data: prefix) for images. */
  base64?: string;
  /** UTF-8 string for text files. */
  text?: string;
  /** populated only when kind === "unsupported". */
  rejection?: string;
}

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "scala",
  "clj",
  "cljs",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cxx",
  "m",
  "mm",
  "cs",
  "fs",
  "vb",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "gql",
  "proto",
  "dockerfile",
  "makefile",
  "gitignore",
  "env",
  "lock",
]);

export function classifyFile(file: File): { kind: PendingFileKind; reason?: string } {
  if (file.size > MAX_BYTES) {
    return { kind: "unsupported", reason: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` };
  }
  if (file.type.startsWith("image/")) return { kind: "image" };
  if (file.type.startsWith("text/") || file.type === "application/json") return { kind: "text" };
  // Sniff by extension if MIME is empty/octet-stream
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return { kind: "text" };
  // Dotfiles like .env / Dockerfile have no extension after split
  const lowerName = file.name.toLowerCase();
  if (TEXT_EXTENSIONS.has(lowerName)) return { kind: "text" };
  return { kind: "unsupported", reason: `Unsupported file type (${file.type || "unknown"})` };
}

export async function readImageAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  // chunked to avoid call-stack overflow on large arrays
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

export async function readFileAsText(file: File): Promise<string> {
  return file.text();
}

export async function makePendingFile(file: File): Promise<PendingFile> {
  const id = Math.random().toString(36).slice(2, 10);
  const { kind, reason } = classifyFile(file);
  const base: PendingFile = {
    id,
    name: file.name,
    size: file.size,
    mediaType: file.type || "application/octet-stream",
    kind,
  };
  if (kind === "image") {
    base.base64 = await readImageAsBase64(file);
  } else if (kind === "text") {
    base.text = await readFileAsText(file);
  } else {
    base.rejection = reason;
  }
  return base;
}

/**
 * Build a single string to send as the user message that includes any inlined
 * text-file attachments. Image attachments are NOT included here — they go
 * via the structured `images` field instead.
 */
export function composeMessageWithAttachments(message: string, files: readonly PendingFile[]): string {
  const textFiles = files.filter((f) => f.kind === "text" && f.text !== undefined);
  if (textFiles.length === 0) return message;

  const blocks = textFiles
    .map((f) => `--- attachment: ${f.name} (${formatBytes(f.size)}) ---\n${f.text}\n--- end ---`)
    .join("\n\n");

  if (!message.trim()) return blocks;
  return `${message}\n\n${blocks}`;
}

/** PendingFiles in the shape the Pi SDK expects via `prompt(text, { images })`. */
export function toSdkImages(files: readonly PendingFile[]): Array<{ data: string; mediaType: string }> {
  return files.filter((f) => f.kind === "image" && f.base64).map((f) => ({ data: f.base64!, mediaType: f.mediaType }));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
