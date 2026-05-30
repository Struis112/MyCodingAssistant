import { describe, expect, it } from "vitest";
import { PiSessionManager } from "./manager.js";

// These tests intentionally avoid network or LLM activity. They only exercise
// the bookkeeping surface of PiSessionManager so CI is fast and offline-safe.

describe("PiSessionManager", () => {
  it("constructs without throwing", () => {
    const mgr = new PiSessionManager();
    expect(mgr).toBeInstanceOf(PiSessionManager);
    mgr.disposeAll();
  });

  it("listActiveSessions is empty before any session is created", () => {
    const mgr = new PiSessionManager();
    expect(mgr.listActiveSessions()).toEqual([]);
    mgr.disposeAll();
  });

  it("getSession returns undefined for an unknown id", () => {
    const mgr = new PiSessionManager();
    expect(mgr.getSession("nope")).toBeUndefined();
    mgr.disposeAll();
  });

  it("disposeSession on an unknown id is a safe no-op", () => {
    const mgr = new PiSessionManager();
    expect(() => mgr.disposeSession("nope")).not.toThrow();
    expect(mgr.listActiveSessions()).toEqual([]);
    mgr.disposeAll();
  });

  it("disposeAll on an empty manager is a safe no-op", () => {
    const mgr = new PiSessionManager();
    expect(() => mgr.disposeAll()).not.toThrow();
  });

  it("setSessionThinkingLevel throws on unknown session id", () => {
    const mgr = new PiSessionManager();
    expect(() => mgr.setSessionThinkingLevel("nope", "off")).toThrow(/not found/);
    mgr.disposeAll();
  });
});
