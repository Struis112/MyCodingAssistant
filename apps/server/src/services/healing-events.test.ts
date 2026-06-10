import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configureHealingEventStore,
  recordHealingEvent,
  listHealingEvents,
} from "./healing-events.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mca-healing-"));
  configureHealingEventStore(path.join(dir, "events.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("healing events", () => {
  it("records and lists newest first", () => {
    recordHealingEvent({ source: "deploy", kind: "promoted", message: "one", at: 1 });
    recordHealingEvent({ source: "watch-safe", kind: "restart", message: "two", at: 2 });
    const list = listHealingEvents();
    expect(list.map((e) => e.message)).toEqual(["two", "one"]);
  });

  it("persists across a simulated restart (store reload)", () => {
    const file = path.join(dir, "events.json");
    recordHealingEvent({ source: "deploy", kind: "rolled-back", message: "survives" });
    configureHealingEventStore(file); // wipes memory, reloads from disk
    expect(listHealingEvents()[0]?.message).toBe("survives");
  });
});
