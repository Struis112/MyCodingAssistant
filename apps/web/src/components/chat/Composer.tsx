"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertCircle,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { generateId, cn } from "@/lib/utils";
import {
  composeMessageWithAttachments,
  formatBytes,
  makePendingFile,
  toSdkImages,
  type PendingFile,
} from "@/lib/files";

/**
 * Bottom-of-screen input area. Owns the textarea, the pending-files list,
 * drag-and-drop targeting the input region, the file picker button, and the
 * send / abort buttons. Pushes user messages to the store and emits
 * `chat:send` / `chat:abort` over the socket.
 */
export function Composer() {
  const { addItem, isStreaming, setIsStreaming, sessionId } = useAppStore();

  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  // ----- File ingestion -----

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      const processed = await Promise.all(list.map((f) => makePendingFile(f)));

      // Surface any rejections as system items so the user knows why a file
      // didn't attach.
      const rejected = processed.filter((f) => f.kind === "unsupported");
      const accepted = processed.filter((f) => f.kind !== "unsupported");
      for (const r of rejected) {
        addItem({
          kind: "system",
          id: generateId(),
          text: `Skipped attachment "${r.name}": ${r.rejection}`,
          timestamp: Date.now(),
        });
      }
      if (accepted.length > 0) {
        setPendingFiles((prev) => [...prev, ...accepted]);
      }
    },
    [addItem],
  );

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const onFilePickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) addFiles(files);
      // Reset the input so the same file can be re-attached after removing.
      e.target.value = "";
    },
    [addFiles],
  );

  // Drag/drop handlers. Use a counter to avoid the flicker where entering
  // a child element fires `dragleave` on the parent.
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      dragCounterRef.current += 1;
      setIsDragging(true);
    }
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      const files = e.dataTransfer.files;
      if (files && files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  // ----- Send / abort -----

  // Core send: render an optimistic user item and emit over the socket.
  // Shared by the normal send button, the Enter key, and the right-click
  // "Continue" shortcut. Does not touch the textarea draft or pending files —
  // callers decide whether to clear them.
  const sendMessage = useCallback(
    (text: string, files: PendingFile[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && files.length === 0) return;

      const messageToSend = composeMessageWithAttachments(trimmed, files);
      const images = toSdkImages(files);

      // Optimistically render the user message. Show a short summary of any
      // attachments so the user can see what was sent.
      const attachmentSummary = files.length
        ? files.map((f) => `· ${f.name} (${formatBytes(f.size)})`).join("\n")
        : "";
      const displayText = attachmentSummary
        ? `${trimmed}${trimmed ? "\n\n" : ""}📎 ${files.length} attachment${files.length > 1 ? "s" : ""}:\n${attachmentSummary}`
        : trimmed;

      addItem({ kind: "user", id: generateId(), text: displayText, timestamp: Date.now() });
      if (!isStreaming) setIsStreaming(true);
      getSocket().emit("chat:send", {
        sessionId,
        message: messageToSend,
        images: images.length > 0 ? images : undefined,
      });
    },
    [isStreaming, sessionId, addItem, setIsStreaming],
  );

  const handleSend = useCallback(() => {
    const trimmed = input.trim();

    // Slash command: `/name <new name>` renames the session (updates the chat
    // header, the browser tab, and the persisted session name). Handled
    // locally instead of being sent to the model.
    if (trimmed.toLowerCase() === "/name" || trimmed.toLowerCase().startsWith("/name ")) {
      const name = trimmed.slice("/name".length).trim();
      if (!name) {
        addItem({
          kind: "system",
          id: generateId(),
          text: "Usage: /name <session name>",
          timestamp: Date.now(),
        });
      } else {
        getSocket().emit("session:setName", { sessionId, name });
      }
      setInput("");
      inputRef.current?.focus();
      return;
    }

    if (!trimmed && pendingFiles.length === 0) return;
    sendMessage(input, pendingFiles);
    setInput("");
    setPendingFiles([]);
    inputRef.current?.focus();
  }, [input, pendingFiles, sendMessage, addItem, sessionId]);

  // Right-click the send/queue button to instantly send "Continue" without
  // clobbering whatever is currently in the textarea.
  const handleQuickContinue = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault(); // suppress the browser context menu
      sendMessage("Continue");
    },
    [sendMessage],
  );

  const handleAbort = useCallback(() => {
    getSocket().emit("chat:abort", { sessionId });
    setIsStreaming(false);
  }, [sessionId, setIsStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className={cn("relative p-2 shrink-0 transition-colors", isDragging && "bg-primary/5")}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drop-zone overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-2 rounded-lg border-2 border-dashed border-primary/60 bg-background/80 flex items-center justify-center text-sm font-medium text-primary">
          Drop files here to attach
        </div>
      )}

      {/* Constrain to the same centered column as the message list (see .chat-column). */}
      <div className="chat-column">
        {/* Pending-attachments row */}
        {pendingFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingFiles.map((f) => (
              <PendingFileChip key={f.id} file={f} onRemove={() => removeFile(f.id)} />
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={onFilePickerChange}
          aria-hidden="true"
          tabIndex={-1}
        />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-2 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
            aria-label="Attach files"
            title="Attach files (or drag files into this area)"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isStreaming
                ? "Queue a message... (Enter to steer, Shift+Enter for newline)"
                : "Type your message... (Enter to send, Shift+Enter for newline)"
            }
            className="flex-1 bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary resize-none min-h-[36px] max-h-[160px] transition-colors"
            rows={1}
            aria-label="Message input"
          />
          {isStreaming && (
            <button
              onClick={handleAbort}
              className="px-3 py-1.5 bg-error/20 text-error rounded-lg hover:bg-error/30 transition-colors"
              aria-label="Stop streaming"
              title="Stop the current response"
            >
              <Square className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={handleSend}
            onContextMenu={handleQuickContinue}
            // Use aria-disabled rather than the native `disabled` attribute: a
            // disabled button swallows every mouse event (including
            // contextmenu), which would break the right-click “Continue”
            // shortcut when the textarea is empty. handleSend itself no-ops on an
            // empty draft, so left-click stays safe.
            aria-disabled={!input.trim() && pendingFiles.length === 0}
            className={cn(
              "px-3 py-1.5 bg-primary text-primary-foreground rounded-lg transition-colors",
              !input.trim() && pendingFiles.length === 0
                ? "opacity-50 cursor-not-allowed"
                : "hover:bg-primary/90",
            )}
            aria-label={isStreaming ? "Queue message" : "Send message"}
            title={
              isStreaming
                ? "Queue this message — delivered after the current assistant turn (right-click to send “Continue”)"
                : "Send message (right-click to send “Continue”)"
            }
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Small chip rendered for each pending attachment above the textarea. */
function PendingFileChip({ file, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const Icon = file.kind === "image" ? ImageIcon : file.kind === "text" ? FileText : AlertCircle;
  const tone =
    file.kind === "unsupported"
      ? "border-error/40 text-error bg-error/10"
      : "border-border text-foreground bg-muted/40";
  return (
    <span
      className={`inline-flex items-center gap-1.5 max-w-[260px] pl-2 pr-1 py-1 rounded-md border text-xs ${tone}`}
      title={`${file.name} · ${formatBytes(file.size)}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{file.name}</span>
      <span className="text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 p-0.5 rounded hover:bg-background"
        aria-label={`Remove ${file.name}`}
        title="Remove"
      >
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}
