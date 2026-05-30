// Pi SDK connector entry point.
//
// Construct a `Connector` ready to register with the ConnectorRegistry. The
// underlying PiSessionManager handles auth via @earendil-works/pi-coding-agent
// (reads ~/.pi/agent/auth.json or env vars like ANTHROPIC_API_KEY).

import type { Connector } from "../types.js";
import { PiSessionManager } from "./manager.js";

export const PI_CONNECTOR_ID = "pi";

export function createPiConnector(cwd?: string): Connector {
  return {
    id: PI_CONNECTOR_ID,
    name: "Pi SDK",
    manager: new PiSessionManager(cwd),
  };
}

// Re-export the implementation so tests that need to assert against the
// concrete class (e.g. pi-session.test.ts) can still find it.
export { PiSessionManager } from "./manager.js";
