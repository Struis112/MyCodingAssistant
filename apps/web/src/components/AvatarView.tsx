'use client';

import { useRef, useEffect, useState } from 'react';
import { Bot, RotateCcw, Camera, Maximize2, Minimize2 } from 'lucide-react';

export function AvatarView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [expression, setExpression] = useState<'neutral' | 'happy' | 'thinking'>('neutral');
  const animationFrameRef = useRef<number | undefined>(undefined);
  const timeRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const resize = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };
    resize();
    window.addEventListener('resize', resize);

    // Simple 2D avatar animation loop
    const animate = () => {
      timeRef.current += 0.016;
      const t = timeRef.current;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Background gradient
      const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grad.addColorStop(0, 'rgba(88, 166, 255, 0.1)');
      grad.addColorStop(1, 'rgba(88, 166, 255, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Head bob
      const bobY = Math.sin(t * 2) * 3;
      const headX = w / 2;
      const headY = h / 2 - 40 + bobY;

      // Head
      ctx.save();
      ctx.translate(headX, headY);

      // Face (circle)
      ctx.beginPath();
      ctx.arc(0, 0, 80, 0, Math.PI * 2);
      ctx.fillStyle = '#f5d0a9';
      ctx.fill();
      ctx.strokeStyle = '#d4a574';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Eyes
      const blinkPhase = Math.sin(t * 0.5);
      const eyeOpenness = blinkPhase > 0.95 ? 0.1 : 1;
      
      ctx.fillStyle = '#2c3e50';
      // Left eye
      ctx.beginPath();
      ctx.ellipse(-25, -10, 8, 10 * eyeOpenness, 0, 0, Math.PI * 2);
      ctx.fill();
      // Right eye
      ctx.beginPath();
      ctx.ellipse(25, -10, 8, 10 * eyeOpenness, 0, 0, Math.PI * 2);
      ctx.fill();

      // Eye shine
      if (eyeOpenness > 0.5) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(-22, -13, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(28, -13, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Mouth based on expression
      ctx.strokeStyle = '#2c3e50';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (expression === 'happy') {
        ctx.arc(0, 15, 20, 0.1 * Math.PI, 0.9 * Math.PI);
      } else if (expression === 'thinking') {
        ctx.moveTo(-15, 25);
        ctx.lineTo(15, 25);
      } else {
        ctx.arc(0, 20, 15, 0.1 * Math.PI, 0.9 * Math.PI);
      }
      ctx.stroke();

      ctx.restore();

      // Body
      ctx.fillStyle = '#58a6ff';
      ctx.beginPath();
      ctx.ellipse(headX, headY + 130, 60, 40, 0, 0, Math.PI * 2);
      ctx.fill();

      // Arms waving
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 20;
      ctx.lineCap = 'round';
      const armWave = Math.sin(t * 3) * 0.3;
      // Left arm
      ctx.beginPath();
      ctx.moveTo(headX - 50, headY + 110);
      ctx.lineTo(headX - 90, headY + 80 + Math.sin(t * 3) * 20);
      ctx.stroke();
      // Right arm
      ctx.beginPath();
      ctx.moveTo(headX + 50, headY + 110);
      ctx.lineTo(headX + 90, headY + 80 - Math.sin(t * 3) * 20);
      ctx.stroke();

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [expression]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="h-12 border-b border-border flex items-center px-4 gap-3">
        <Bot className="w-5 h-5 text-primary" />
        <h1 className="text-sm font-semibold text-foreground">3D Avatar</h1>
        <div className="flex-1" />
        <button
          onClick={() => setIsFullscreen(!isFullscreen)}
          className="p-2 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </header>

      {/* Avatar canvas */}
      <div className="flex-1 relative">
        <canvas
          ref={canvasRef}
          className="w-full h-full"
          style={{ imageRendering: 'auto' }}
        />
        
        {/* Overlay controls */}
        <div className="absolute bottom-4 left-4 flex gap-2">
          <button
            onClick={() => setExpression('neutral')}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              expression === 'neutral'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            Neutral
          </button>
          <button
            onClick={() => setExpression('happy')}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              expression === 'happy'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            Happy
          </button>
          <button
            onClick={() => setExpression('thinking')}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${
              expression === 'thinking'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            Thinking
          </button>
        </div>

        {/* Info overlay */}
        <div className="absolute top-4 right-4 text-xs text-muted-foreground bg-background/80 backdrop-blur-sm rounded-lg px-3 py-2 border border-border">
          <p>Placeholder 2D avatar</p>
          <p>Three.js 3D avatar coming soon</p>
        </div>
      </div>
    </div>
  );
}
