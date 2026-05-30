'use client';

import { useState, useEffect } from 'react';
import { useTheme } from '@/lib/theme';
import { getSocket } from '@/lib/socket';
import { useAppStore } from '@/lib/store';
import { Settings as SettingsIcon, Palette, Brain, Cpu, CheckCircle2 } from 'lucide-react';

interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  reasoning: boolean;
}

export function Settings() {
  const { theme, toggleTheme } = useTheme();
  const { sessionId } = useAppStore();
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [thinkingLevel, setThinkingLevel] = useState<string>('medium');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchModels();
  }, []);

  async function fetchModels() {
    try {
      const response = await fetch('http://localhost:3001/api/models');
      const data = await response.json();
      setModels(data);
      if (data.length > 0 && !selectedModel) {
        setSelectedModel(data[0].id);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
    }
  }

  async function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    setLoading(true);
    try {
      const socket = getSocket();
      socket.emit('session:setModel', { sessionId, modelId });
    } catch (err) {
      console.error('Failed to set model:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleThinkingLevelChange(level: string) {
    setThinkingLevel(level);
    const socket = getSocket();
    socket.emit('session:setThinkingLevel', { sessionId, level });
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="max-w-4xl mx-auto p-8">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <SettingsIcon className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-bold text-foreground">Settings</h1>
          </div>
          <p className="text-muted-foreground">
            Configure your coding assistant preferences
          </p>
        </div>

        <div className="space-y-6">
          {/* Appearance */}
          <section className="bg-card border border-border rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <Palette className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-semibold text-card-foreground">Appearance</h2>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-card-foreground mb-2">
                  Theme
                </label>
                <button
                  onClick={toggleTheme}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                >
                  Switch to {theme === 'dark' ? 'Light' : 'Dark'} Mode
                </button>
                <p className="text-sm text-muted-foreground mt-2">
                  Current theme: {theme === 'dark' ? 'Dark' : 'Light'} (WCAG AAA compliant)
                </p>
              </div>
            </div>
          </section>

          {/* AI Model */}
          <section className="bg-card border border-border rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <Brain className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-semibold text-card-foreground">AI Model</h2>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-card-foreground mb-2">
                  Model
                </label>
                {models.length > 0 ? (
                  <div className="space-y-2">
                    {models.map((model) => (
                      <label
                        key={model.id}
                        className="flex items-center gap-3 p-3 border border-border rounded-md hover:bg-accent/50 cursor-pointer transition-colors"
                      >
                        <input
                          type="radio"
                          name="model"
                          value={model.id}
                          checked={selectedModel === model.id}
                          onChange={(e) => handleModelChange(e.target.value)}
                          className="w-4 h-4"
                        />
                        <div className="flex-1">
                          <div className="font-medium text-card-foreground">{model.name}</div>
                          <div className="text-sm text-muted-foreground">
                            {model.provider} • {Math.round(model.contextWindow / 1000)}K context
                            {model.reasoning && ' • Reasoning'}
                          </div>
                        </div>
                        {selectedModel === model.id && (
                          <CheckCircle2 className="w-5 h-5 text-primary" />
                        )}
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">No models available. Check your API keys.</p>
                )}
              </div>
            </div>
          </section>

          {/* Thinking Level */}
          <section className="bg-card border border-border rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <Cpu className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-semibold text-card-foreground">Thinking Level</h2>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-card-foreground mb-2">
                  Reasoning Depth
                </label>
                <div className="space-y-2">
                  {['off', 'low', 'medium', 'high'].map((level) => (
                    <label
                      key={level}
                      className="flex items-center gap-3 p-3 border border-border rounded-md hover:bg-accent/50 cursor-pointer transition-colors"
                    >
                      <input
                        type="radio"
                        name="thinking"
                        value={level}
                        checked={thinkingLevel === level}
                        onChange={(e) => handleThinkingLevelChange(e.target.value)}
                        className="w-4 h-4"
                      />
                      <div className="flex-1">
                        <div className="font-medium text-card-foreground capitalize">{level}</div>
                        <div className="text-sm text-muted-foreground">
                          {level === 'off' && 'No extended thinking'}
                          {level === 'low' && 'Quick responses'}
                          {level === 'medium' && 'Balanced reasoning'}
                          {level === 'high' && 'Deep analysis'}
                        </div>
                      </div>
                      {thinkingLevel === level && (
                        <CheckCircle2 className="w-5 h-5 text-primary" />
                      )}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
