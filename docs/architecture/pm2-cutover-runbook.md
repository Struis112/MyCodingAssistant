# PM2 cutover runbook (Phase 1)

Turn the live system from NSSM over to PM2. Every step is reversible; the
rollback is one block at the bottom. Companion to `pm2-single-runmode.md`
(the why) — this is the how. **Do this when you can watch it** (it briefly
flips the running stack).

## Pre-flight (no live impact)

```
# from the repo root, as Administrator, with NODE_ENV unset
npm install --include=dev          # ensure full toolchain (see .npmrc)
npm run build --workspace=@mca/server
npm test                           # 220 server + 96 web green
git status -sb                     # clean + pushed
```

Confirm the ecosystem resolves all three scripts:

```
node -e "const c=require('./ecosystem.config.cjs');c.apps.forEach(a=>console.log(a.name,require('node:fs').existsSync(a.script)))"
```

## Optional: zero-risk smoke test on alternate ports

Proves PM2 can boot the apps WITHOUT touching the live NSSM services (different
ports). NOTE: skip the deployer here — two deployers must never run at once, and
a second `mca-server` shares `logs/` + `~/.pi/agent` with the live one, so keep
this short and don't exercise chat against it.

```
set MCA_API_PORT=7651
set MCA_WEB_PORT=7652
npx pm2 start ecosystem.config.cjs --only mca-server,mca-web
node scripts/pm2/verify.mjs        # uses MCA_API_PORT/MCA_WEB_PORT
npx pm2 delete mca-server mca-web  # tear down
set MCA_API_PORT=
set MCA_WEB_PORT=
```

## Cutover — Windows

```
# 1. Stop NSSM (frees ports 7641/7642 and stops the NSSM deployer)
tools\nssm\nssm.exe stop MyCodingAssistantDeployer
tools\nssm\nssm.exe stop MyCodingAssistant

# 2. Bring the stack up under PM2 (default ports 7641/7642)
npx pm2 start ecosystem.config.cjs

# 3. Verify BEFORE persisting
node scripts/pm2/verify.mjs        # must print ALL CHECKS PASSED

# 4. Persist the process list so it survives reboots
npx pm2 save
```

Boot persistence + account (see `pm2-single-runmode.md §5`): install
**pm2-installer** so the PM2 daemon runs as an Administrator Windows service and
self-heals; then `npx pm2 save` again. Don't uninstall NSSM until a real reboot
test passes.

## Cutover — Linux

```
npm install --include=dev && npm run build --workspace=@mca/server
pm2 start ecosystem.config.cjs
node scripts/pm2/verify.mjs
pm2 save
pm2 startup systemd                # run the sudo line it prints
```

Run as a dedicated non-root `mca` user that owns the repo, `~/.pm2`, and
`~/.pi/agent`.

## Rollback (if verify fails, or anytime)

```
# Windows
npx pm2 delete all
tools\nssm\nssm.exe start MyCodingAssistant
tools\nssm\nssm.exe start MyCodingAssistantDeployer
node -e "require('node:http').get('http://127.0.0.1:7641/healthz',r=>console.log('api',r.statusCode))"
```

NSSM still owns everything until you uninstall it (deferred to a later phase),
so this fully restores the prior state.

## Invariants (don't break these)

- **One deployer at a time.** NSSM deployer and PM2 `mca-deployer` must never
  both run — they'd both reset `staging`.
- **PM2 is the only thing that starts/stops app processes** after cutover. The
  deployer + reload orchestrator only ever call `pm2 reload/restart`.
- **Never `npm install` with `NODE_ENV=production`** (the `.npmrc include=dev`
  guards this; don't remove it).
- `pm2 save` after every change to the running app set, or a reboot loses it.
