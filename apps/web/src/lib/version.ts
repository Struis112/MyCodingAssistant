// Single source of truth for the app version that the SWR provider keys
// its browser cache on. A version bump auto-invalidates any persisted
// localStorage caches (because the cache key includes this string).
//
// MUST stay in sync with the root package.json `version` field. The unit
// test in `version.test.ts` enforces this so CI fails if one is bumped
// without the other.
//
// Versioning: standard semver — MAJOR.MINOR.PATCH.
//   - PATCH (0.1.0 -> 0.1.1): bugfix, no UX change. Cache wipe is harmless.
//   - MINOR (0.1.0 -> 0.2.0): new feature.
//   - MAJOR (0.x.y -> 1.0.0): breaking change.
export const APP_VERSION = "0.1.0";
