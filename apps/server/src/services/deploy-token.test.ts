import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deployTokenPath, resolveDeployToken } from "./deploy-token.js";

describe("resolveDeployToken", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), "mca-deploy-token-"));
  });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("uses MCA_DEPLOY_TOKEN env when set", () => {
    const t = resolveDeployToken({ repoDir, env: { MCA_DEPLOY_TOKEN: "from-env" } });
    expect(t).toBe("from-env");
  });

  it("reads an existing on-disk token when env is empty", () => {
    mkdirSync(path.join(repoDir, "logs"));
    writeFileSync(deployTokenPath(repoDir), "existing-token\n");
    const t = resolveDeployToken({ repoDir, env: {} });
    expect(t).toBe("existing-token");
  });

  it("generates and persists a fresh token when neither source exists", () => {
    const t1 = resolveDeployToken({ repoDir, env: {} });
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    // Persisted for next run.
    expect(readFileSync(deployTokenPath(repoDir), "utf8").trim()).toBe(t1);
    // Second call (no env) re-reads disk — same token.
    const t2 = resolveDeployToken({ repoDir, env: {} });
    expect(t2).toBe(t1);
  });

  it("env beats disk", () => {
    mkdirSync(path.join(repoDir, "logs"));
    writeFileSync(deployTokenPath(repoDir), "on-disk\n");
    const t = resolveDeployToken({ repoDir, env: { MCA_DEPLOY_TOKEN: "env-wins" } });
    expect(t).toBe("env-wins");
    // Disk file is left alone.
    expect(readFileSync(deployTokenPath(repoDir), "utf8").trim()).toBe("on-disk");
  });
});
