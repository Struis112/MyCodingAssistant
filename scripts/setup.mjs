#!/usr/bin/env node
//
// MyCodingAssistant — first-run setup wizard.
//
// Asks the user whether to install MCA as a service so it auto-starts on
// boot and survives restarts. Records the answer in `.mca-setup-done` at
// the repo root so subsequent runs don't keep nagging.
//
// Today this implements service installation on Windows only (via
// scripts/service/install-windows.ps1). On macOS / Linux it prints a short
// pointer toward the manual options (launchd / systemd / pm2) and marks
// setup done.
//
// Invocations:
//   npm run setup            — interactive
//   npm run setup -- --yes   — non-interactive, install service
//   npm run setup -- --skip  — non-interactive, skip service install
//   npm run setup -- --status — just print whether setup has been done

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { platform } from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = join(ROOT, ".mca-setup-done");
const INSTALLER_PS1 = join(ROOT, "scripts", "service", "install-windows.ps1");

const args = process.argv.slice(2);
const FLAG_YES = args.includes("--yes") || args.includes("-y");
const FLAG_SKIP = args.includes("--skip") || args.includes("-n");
const FLAG_STATUS = args.includes("--status");

function readMarker() {
  if (!existsSync(MARKER)) return null;
  try {
    return JSON.parse(readFileSync(MARKER, "utf8"));
  } catch {
    return { raw: readFileSync(MARKER, "utf8") };
  }
}

function writeMarker(payload) {
  writeFileSync(MARKER, JSON.stringify({ ...payload, when: new Date().toISOString() }, null, 2));
}

if (FLAG_STATUS) {
  const m = readMarker();
  if (m) {
    console.log("Setup has been completed.");
    console.log(m);
    process.exit(0);
  }
  console.log("Setup has NOT been completed. Run `npm run setup` to start it.");
  process.exit(0);
}

console.log("\nMyCodingAssistant — first-run setup\n");

// --- Platform dispatch ---

async function ask(prompt, defaultYes) {
  if (FLAG_YES) return true;
  if (FLAG_SKIP) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await rl.question(prompt + suffix)).trim().toLowerCase();
  rl.close();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

async function maybeBuild() {
  const distEntry = join(ROOT, "apps", "server", "dist", "start-prod.js");
  if (existsSync(distEntry)) return;
  console.log("Production build not found — running `npm run build`...");
  await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: true });
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`npm run build exited ${code}`)),
    );
  });
}

async function runWindowsServiceInstaller() {
  if (!existsSync(INSTALLER_PS1)) {
    console.error("Cannot find " + INSTALLER_PS1);
    process.exit(1);
  }

  // The installer requires admin. We can't elevate from this child process
  // safely without losing stdio, so we hand the user a copy-paste command.
  console.log("\nThe Windows service installer must be run from an *elevated* PowerShell.");
  console.log("Open PowerShell as Administrator, then paste:\n");
  console.log(`  cd "${ROOT}"`);
  console.log(`  powershell -ExecutionPolicy Bypass -File scripts\\service\\install-windows.ps1\n`);
  console.log("When it finishes, the service will be running and set to auto-start on boot.\n");

  const tryNow = await ask(
    "Want me to try launching that elevated PowerShell for you now (UAC prompt)?",
    true,
  );
  if (tryNow) {
    // Spawn an elevated PowerShell via `Start-Process -Verb RunAs`. Sourced
    // from the user's PowerShell so UAC integrates cleanly. This returns
    // immediately; we cannot capture stdout from the elevated process.
    spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-NoExit','-File','${INSTALLER_PS1.replace(/'/g, "''")}'`,
      ],
      { cwd: ROOT, stdio: "inherit", shell: false },
    ).on("error", (err) => {
      console.error("Couldn't launch elevated PowerShell:", err.message);
    });
    console.log(
      "An elevated PowerShell window has been requested. Approve the UAC prompt; the installer logs in that new window.",
    );
  }
}

async function main() {
  const existing = readMarker();
  if (existing && !FLAG_YES && !FLAG_SKIP) {
    console.log("Setup has already been completed (" + existing.when + ").");
    const redo = await ask("Run setup again?", false);
    if (!redo) {
      console.log("Nothing to do. Pass --status to inspect, or delete .mca-setup-done to reset.");
      process.exit(0);
    }
  }

  const os = platform();
  console.log(`Detected OS: ${os}\n`);

  let serviceInstalled = false;

  if (os === "win32") {
    const wantsService = await ask(
      "Install MyCodingAssistant as a Windows Service so it auto-starts on boot?",
      true,
    );
    if (wantsService) {
      try {
        await maybeBuild();
      } catch (err) {
        console.error("Build failed:", err.message);
        console.error("Setup aborted. Fix the build and re-run `npm run setup`.");
        process.exit(1);
      }
      await runWindowsServiceInstaller();
      serviceInstalled = true;
    } else {
      console.log("Skipping service install. You can run `npm run setup` again any time.");
    }
  } else {
    console.log(
      "Automated service installation is currently Windows-only. On macOS / Linux you can:",
    );
    console.log("  - macOS:  use launchd — put a plist in ~/Library/LaunchAgents/");
    console.log("  - Linux:  use systemd — a user unit in ~/.config/systemd/user/");
    console.log("  - Either: use pm2 (npm i -g pm2) — `pm2 start npm -- run start:server`\n");
    console.log("Open an issue or PR if you'd like the wizard to do this automatically.");
  }

  writeMarker({ os, serviceInstalled });
  console.log("\nSetup complete. Wrote " + MARKER);
  if (!serviceInstalled) {
    console.log("To run the app right now: `npm run dev` (then open http://localhost:7642/)");
  }
}

main().catch((err) => {
  console.error("\nSetup failed:", err);
  process.exit(1);
});
