// Production entrypoint. Sets supervised-web mode and delegates to the
// regular server bootstrap. Used by `npm run start` at the repo root.
//
// In dev you typically run `npm run dev` which starts the two servers
// side-by-side; supervision is off so they don't fight. Here we flip it
// on so the API server brings the Next.js server back up after crashes
// or updates without manual intervention.
process.env.MCA_SUPERVISE_WEB = "1";
process.env.NODE_ENV = "production";
await import("./index.js");
