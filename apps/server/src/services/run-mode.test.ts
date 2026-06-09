import { describe, expect, it } from "vitest";
import { appParametersFor, buildTargetFor, currentRunMode } from "./run-mode.js";

describe("run-mode", () => {
  it("currentRunMode: prod when MCA_WEB_DEV is not 1", () => {
    expect(currentRunMode({}, ["node", "dist/start-prod.js"])).toBe("prod");
    expect(currentRunMode({ MCA_WEB_DEV: "0" }, ["node", "x.js"])).toBe("prod");
  });

  it("currentRunMode: dev when web-dev AND running under tsx watch", () => {
    const argv = [
      "node",
      "/r/node_modules/tsx/dist/cli.mjs",
      "watch",
      "/r/src/start-dev-supervised.ts",
    ];
    expect(currentRunMode({ MCA_WEB_DEV: "1" }, argv)).toBe("dev");
  });

  it("currentRunMode: hybrid when web-dev but NOT under tsx watch (built server)", () => {
    const argv = ["node", "/r/apps/server/dist/start-dev-supervised.js"];
    expect(currentRunMode({ MCA_WEB_DEV: "1" }, argv)).toBe("hybrid");
  });

  it("appParametersFor(prod) points node at the built prod entry", () => {
    const p = appParametersFor("prod", "/repo");
    expect(p).toContain("start-prod.js");
    expect(p).not.toContain("tsx");
  });

  it("appParametersFor(hybrid) points node at the built dev-supervised entry, no tsx", () => {
    const p = appParametersFor("hybrid", "/repo");
    expect(p).toContain("start-dev-supervised.js");
    expect(p).not.toContain("tsx");
    expect(p).not.toContain("watch");
  });

  it("appParametersFor(dev) runs tsx watch against the dev-supervised source", () => {
    const p = appParametersFor("dev", "/repo");
    expect(p).toContain("tsx");
    expect(p).toContain("watch");
    expect(p).toContain("start-dev-supervised.ts");
  });

  it("buildTargetFor: none for dev, server for hybrid, full for prod", () => {
    expect(buildTargetFor("dev")).toBe("none");
    expect(buildTargetFor("hybrid")).toBe("server");
    expect(buildTargetFor("prod")).toBe("full");
  });
});
