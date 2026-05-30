// Connector registry.
//
// Holds every harness adapter the server knows about and exposes a default
// one. Today there's exactly one entry (Pi). When more harnesses ship —
// Claude Code, Opencode Go, … — they register themselves here and the
// frontend gains a per-session picker that addresses them by id.

import type { Connector, ConnectorManager } from "./types.js";

export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();
  private defaultId: string | null = null;

  /** Register a connector. The first one registered becomes the default. */
  register(connector: Connector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error(`Connector "${connector.id}" already registered`);
    }
    this.connectors.set(connector.id, connector);
    if (this.defaultId === null) this.defaultId = connector.id;
  }

  /** Explicitly pick which connector is the default. */
  setDefault(id: string): void {
    if (!this.connectors.has(id)) {
      throw new Error(`Cannot set default — unknown connector "${id}"`);
    }
    this.defaultId = id;
  }

  has(id: string): boolean {
    return this.connectors.has(id);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  /** The currently-active connector. Throws if no connectors are registered. */
  getDefault(): Connector {
    if (this.defaultId === null) {
      throw new Error("ConnectorRegistry has no connectors registered");
    }
    const c = this.connectors.get(this.defaultId);
    if (!c) throw new Error(`Default connector "${this.defaultId}" is missing`);
    return c;
  }

  /** Convenience: the manager from the default connector. */
  getDefaultManager(): ConnectorManager {
    return this.getDefault().manager;
  }

  /** Lightweight metadata for the UI (id + name only). */
  list(): Array<{ id: string; name: string; isDefault: boolean }> {
    return Array.from(this.connectors.values()).map((c) => ({
      id: c.id,
      name: c.name,
      isDefault: c.id === this.defaultId,
    }));
  }

  /** Call dispose on every manager. Used during server shutdown. */
  disposeAll(): void {
    for (const c of this.connectors.values()) {
      try {
        c.manager.disposeAll();
      } catch {
        /* best effort */
      }
    }
  }
}
