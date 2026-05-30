import { describe, expect, it } from "vitest";
import {
  classifyFile,
  composeMessageWithAttachments,
  formatBytes,
  makePendingFile,
  readFileAsText,
  readImageAsBase64,
  toSdkImages,
  type PendingFile,
} from "./files";

// jsdom doesn't implement Blob.arrayBuffer() / Blob.text() on its File
// polyfill, so we patch them ourselves before returning the File.
function patch(file: File, text: string, bytes: Uint8Array): File {
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", { value: () => Promise.resolve(text) });
  }
  if (typeof file.arrayBuffer !== "function") {
    // Copy into a fresh ArrayBuffer so subarray views stay valid.
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    Object.defineProperty(file, "arrayBuffer", { value: () => Promise.resolve(buf) });
  }
  return file;
}

// Newer TS lib types narrow `BlobPart` to `Uint8Array<ArrayBuffer>` while
// `new Uint8Array(n)` widens to `Uint8Array<ArrayBufferLike>` (it could be a
// SharedArrayBuffer). At runtime these are interchangeable; we cast to keep
// the test fixtures readable.
function toBlobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart;
}

function mockFile(name: string, type: string, size = 100): File {
  const bytes = new Uint8Array(size);
  return patch(new File([toBlobPart(bytes)], name, { type }), "", bytes);
}

function fileWithBytes(name: string, type: string, bytes: Uint8Array): File {
  return patch(new File([toBlobPart(bytes)], name, { type }), "", bytes);
}

function fileWithText(name: string, type: string, text: string): File {
  return patch(new File([text], name, { type }), text, new TextEncoder().encode(text));
}

describe("classifyFile", () => {
  it("classifies image MIME types as image", () => {
    expect(classifyFile(mockFile("photo.png", "image/png")).kind).toBe("image");
    expect(classifyFile(mockFile("photo.jpg", "image/jpeg")).kind).toBe("image");
  });

  it("classifies text MIME types as text", () => {
    expect(classifyFile(mockFile("notes.txt", "text/plain")).kind).toBe("text");
  });

  it("classifies application/json as text", () => {
    expect(classifyFile(mockFile("config.json", "application/json")).kind).toBe("text");
  });

  it("classifies by extension when MIME is empty", () => {
    expect(classifyFile(mockFile("script.ts", "")).kind).toBe("text");
    expect(classifyFile(mockFile("README.md", "")).kind).toBe("text");
  });

  it("rejects unsupported MIME with a reason", () => {
    const { kind, reason } = classifyFile(mockFile("video.mp4", "video/mp4"));
    expect(kind).toBe("unsupported");
    expect(reason).toMatch(/unsupported/i);
  });

  it("rejects files larger than the cap", () => {
    const big = mockFile("big.txt", "text/plain", 11 * 1024 * 1024);
    const { kind, reason } = classifyFile(big);
    expect(kind).toBe("unsupported");
    expect(reason).toMatch(/too large/i);
  });
});

describe("composeMessageWithAttachments", () => {
  const text1: PendingFile = {
    id: "1",
    name: "a.ts",
    size: 10,
    mediaType: "text/plain",
    kind: "text",
    text: "console.log('hi');",
  };
  const text2: PendingFile = {
    id: "2",
    name: "b.md",
    size: 5,
    mediaType: "text/markdown",
    kind: "text",
    text: "# Hello",
  };
  const image: PendingFile = {
    id: "3",
    name: "p.png",
    size: 1000,
    mediaType: "image/png",
    kind: "image",
    base64: "abc",
  };

  it("returns the message unchanged when no text files attached", () => {
    expect(composeMessageWithAttachments("hi", [image])).toBe("hi");
    expect(composeMessageWithAttachments("hi", [])).toBe("hi");
  });

  it("appends each text file as a fenced attachment block", () => {
    const out = composeMessageWithAttachments("explain this", [text1]);
    expect(out).toContain("explain this");
    expect(out).toContain("--- attachment: a.ts");
    expect(out).toContain("console.log('hi');");
    expect(out).toContain("--- end ---");
  });

  it("handles multiple text files", () => {
    const out = composeMessageWithAttachments("review", [text1, text2]);
    expect(out).toContain("a.ts");
    expect(out).toContain("b.md");
    expect(out).toContain("# Hello");
  });

  it("uses just the attachments when message is empty", () => {
    const out = composeMessageWithAttachments("", [text1]);
    expect(out.startsWith("--- attachment: a.ts")).toBe(true);
  });
});

describe("toSdkImages", () => {
  it("returns only image-kind files in SDK shape", () => {
    const text: PendingFile = {
      id: "1",
      name: "a.ts",
      size: 1,
      mediaType: "text/plain",
      kind: "text",
      text: "x",
    };
    const image: PendingFile = {
      id: "2",
      name: "p.png",
      size: 1,
      mediaType: "image/png",
      kind: "image",
      base64: "ABC",
    };
    const out = toSdkImages([text, image]);
    expect(out).toEqual([{ data: "ABC", mediaType: "image/png" }]);
  });

  it("skips images without base64", () => {
    const broken: PendingFile = {
      id: "1",
      name: "p.png",
      size: 1,
      mediaType: "image/png",
      kind: "image",
    };
    expect(toSdkImages([broken])).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });
  it("formats KB", () => {
    expect(formatBytes(2048)).toMatch(/2.0 KB/);
  });
  it("formats MB", () => {
    expect(formatBytes(3 * 1024 * 1024)).toMatch(/3.0 MB/);
  });
});

describe("readImageAsBase64", () => {
  it("converts bytes to standard base64", async () => {
    // 'hello' in ASCII -> 'aGVsbG8='
    const file = fileWithBytes(
      "hello.bin",
      "application/octet-stream",
      new TextEncoder().encode("hello"),
    );
    expect(await readImageAsBase64(file)).toBe("aGVsbG8=");
  });

  it("handles arrays larger than one chunk (>32KB)", async () => {
    // 64KB of zeros
    const big = new Uint8Array(64 * 1024);
    const file = fileWithBytes("big.bin", "application/octet-stream", big);
    const b64 = await readImageAsBase64(file);
    // Standard base64 of 65536 zero bytes is well-formed and a multiple of 4 chars.
    expect(b64.length % 4).toBe(0);
    expect(b64.length).toBeGreaterThan(80_000);
  });

  it("handles empty files", async () => {
    const file = fileWithBytes("empty.bin", "application/octet-stream", new Uint8Array(0));
    expect(await readImageAsBase64(file)).toBe("");
  });
});

describe("readFileAsText", () => {
  it("returns the file's text content", async () => {
    const file = fileWithText("a.txt", "text/plain", "hello world");
    expect(await readFileAsText(file)).toBe("hello world");
  });
});

describe("makePendingFile", () => {
  it("produces an image PendingFile with base64 set", async () => {
    const f = fileWithBytes("p.png", "image/png", new TextEncoder().encode("hi"));
    const pf = await makePendingFile(f);
    expect(pf.kind).toBe("image");
    expect(pf.base64).toBe("aGk=");
    expect(pf.text).toBeUndefined();
    expect(pf.rejection).toBeUndefined();
    expect(pf.name).toBe("p.png");
    expect(pf.mediaType).toBe("image/png");
  });

  it("produces a text PendingFile with text set", async () => {
    const f = fileWithText("a.ts", "", "export const x = 1;");
    const pf = await makePendingFile(f);
    expect(pf.kind).toBe("text");
    expect(pf.text).toBe("export const x = 1;");
    expect(pf.base64).toBeUndefined();
  });

  it("falls back to application/octet-stream when MIME is empty", async () => {
    const f = fileWithText("a.ts", "", "x");
    const pf = await makePendingFile(f);
    expect(pf.mediaType).toBe("application/octet-stream");
  });

  it("produces an unsupported PendingFile with a rejection reason", async () => {
    const f = mockFile("clip.mp4", "video/mp4");
    const pf = await makePendingFile(f);
    expect(pf.kind).toBe("unsupported");
    expect(pf.rejection).toMatch(/unsupported/i);
    expect(pf.text).toBeUndefined();
    expect(pf.base64).toBeUndefined();
  });

  it("assigns a unique-looking id", async () => {
    const a = await makePendingFile(fileWithText("a.ts", "", "x"));
    const b = await makePendingFile(fileWithText("b.ts", "", "y"));
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThan(0);
  });
});
