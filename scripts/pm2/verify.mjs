// Read-only PM2 cutover verifier. Run after `pm2 start ecosystem.config.cjs` to
// confirm the stack is actually healthy before you `pm2 save` (and before you
// uninstall NSSM). Cross-platform (pure Node + http). Exits non-zero on any
// failure so it can gate a script.
//
//   node scripts/pm2/verify.mjs
//   MCA_API_PORT=7651 MCA_WEB_PORT=7652 node scripts/pm2/verify.mjs   # alt-port smoke test
//
// Checks:
//   1. `pm2 jlist` shows mca-server, mca-web, mca-deployer all "online".
//   2. The API answers GET /healthz with 200.
//   3. The web server answers GET / with 200.

import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const API_PORT = process.env.MCA_API_PORT || "7641";
const WEB_PORT = process.env.MCA_WEB_PORT || "7642";
const EXPECTED = ["mca-server", "mca-web", "mca-deployer"];

function get(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 8000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
  });
}

async function pm2Statuses() {
  // `pm2 jlist` prints a JSON array of processes. Run the pm2 bin JS directly
  // with node (no shell) so it's cross-platform and avoids the shell-args
  // deprecation; require.resolve finds pm2 wherever npm placed it.
  const pm2Bin = require.resolve("pm2/bin/pm2");
  const { stdout } = await execFileP(process.execPath, [pm2Bin, "jlist"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const list = JSON.parse(stdout);
  return new Map(list.map((p) => [p.name, p.pm2_env?.status]));
}

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

let statuses = new Map();
try {
  statuses = await pm2Statuses();
} catch (err) {
  check("pm2 jlist", false, String(err.message || err));
}
for (const name of EXPECTED) {
  const st = statuses.get(name);
  check(`pm2 app ${name}`, st === "online", st ? `status=${st}` : "not found");
}

check(`API /healthz (:${API_PORT})`, (await get(API_PORT, "/healthz")) === 200);
check(`Web / (:${WEB_PORT})`, (await get(WEB_PORT, "/")) === 200);

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`}`);
process.exit(failed.length === 0 ? 0 : 1);
