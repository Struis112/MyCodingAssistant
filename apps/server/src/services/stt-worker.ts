// STT (Speech-to-Text) Service Worker
// Provides speech recognition via Web Speech API or Whisper

import { ServiceWorker } from './service-worker-base.js';

class STTServiceWorker extends ServiceWorker {
  private engine: 'web-speech' | 'whisper' = 'web-speech';
  private language: string = 'en-US';
  private isActive: boolean = false;

  async initialize(): Promise<void> {
    console.log(`[${this.name}] Initializing STT service...`);
    this.healthDetails.engine = this.engine;
    this.healthDetails.language = this.language;
    console.log(`[${this.name}] STT service ready (engine: ${this.engine}, lang: ${this.language})`);
  }

  async shutdown(): Promise<void> {
    console.log(`[${this.name}] Shutting down STT service...`);
  }

  getHealthDetails(): Record<string, any> {
    return {
      engine: this.engine,
      language: this.language,
      isActive: this.isActive,
    };
  }
}

const worker = new STTServiceWorker();
worker.start().catch(console.error);
