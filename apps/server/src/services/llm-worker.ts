// LLM Service Worker
// Wraps Pi SDK for AI agent capabilities

import { ServiceWorker } from './service-worker-base.js';
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';

class LLMServiceWorker extends ServiceWorker {
  private authStorage?: AuthStorage;
  private modelRegistry?: ModelRegistry;
  private availableModels: number = 0;

  async initialize(): Promise<void> {
    console.log(`[${this.name}] Initializing Pi SDK...`);
    try {
      this.authStorage = AuthStorage.create();
      this.modelRegistry = ModelRegistry.create(this.authStorage);
      const models = await this.modelRegistry.getAvailable();
      this.availableModels = models.length;
      console.log(`[${this.name}] Found ${this.availableModels} available models`);
    } catch (err: any) {
      console.warn(`[${this.name}] Could not initialize Pi SDK: ${err.message}`);
    }
  }

  async shutdown(): Promise<void> {
    console.log(`[${this.name}] Shutting down LLM service...`);
  }

  getHealthDetails(): Record<string, any> {
    return {
      availableModels: this.availableModels,
      piSdkReady: !!this.modelRegistry,
    };
  }
}

const worker = new LLMServiceWorker();
worker.start().catch(console.error);
