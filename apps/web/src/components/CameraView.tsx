'use client';

import { useState, useEffect } from 'react';
import { Camera, CameraOff, AlertCircle, Loader2 } from 'lucide-react';
import { useCamera } from '@/hooks/useCamera';

export function CameraView() {
  const {
    videoRef,
    canvasRef,
    isActive,
    error,
    startCamera,
    stopCamera,
    isSupported,
  } = useCamera({ facingMode: 'user', width: 1280, height: 720 });

  const [faceDetections, setFaceDetections] = useState<Array<{ x: number; y: number; width: number; height: number }>>([]);
  const [isDetecting, setIsDetecting] = useState(false);

  // Placeholder for face detection - would integrate with face-detection service
  useEffect(() => {
    if (!isActive) {
      setFaceDetections([]);
      setIsDetecting(false);
      return;
    }

    // Simulate face detection polling
    const interval = setInterval(() => {
      // In production, this would call the face-detection service
      // For now, just show that detection is "active"
      setIsDetecting(true);
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive]);

  if (!isSupported) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-background text-muted-foreground">
        <AlertCircle className="w-16 h-16 mb-4 opacity-50" />
        <p className="text-lg font-semibold">Camera Not Supported</p>
        <p className="text-sm mt-2">Your browser does not support camera access</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Camera className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold text-foreground">Camera View</h2>
        </div>
        <div className="flex items-center gap-2">
          {isDetecting && (
            <span className="text-xs text-success flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Detecting
            </span>
          )}
          {isActive ? (
            <button
              onClick={stopCamera}
              className="px-4 py-2 bg-error/20 text-error rounded-lg hover:bg-error/30 transition-colors flex items-center gap-2"
            >
              <CameraOff className="w-4 h-4" />
              Stop Camera
            </button>
          ) : (
            <button
              onClick={startCamera}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2"
            >
              <Camera className="w-4 h-4" />
              Start Camera
            </button>
          )}
        </div>
      </div>

      {/* Camera feed */}
      <div className="flex-1 relative bg-muted/20 overflow-hidden">
        {!isActive && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
            <Camera className="w-24 h-24 mb-4 opacity-20" />
            <p className="text-lg font-semibold">Camera Inactive</p>
            <p className="text-sm mt-2">Click "Start Camera" to begin</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-error">
            <AlertCircle className="w-16 h-16 mb-4" />
            <p className="text-lg font-semibold">Camera Error</p>
            <p className="text-sm mt-2 max-w-md text-center">{error}</p>
          </div>
        )}

        <video
          ref={videoRef}
          className={`w-full h-full object-cover ${isActive ? 'block' : 'hidden'}`}
          playsInline
          muted
        />

        {/* Face detection overlay */}
        {isActive && faceDetections.length > 0 && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            {faceDetections.map((face, i) => (
              <rect
                key={i}
                x={`${face.x}%`}
                y={`${face.y}%`}
                width={`${face.width}%`}
                height={`${face.height}%`}
                fill="none"
                stroke="rgb(var(--primary))"
                strokeWidth="3"
                rx="8"
              />
            ))}
          </svg>
        )}

        {/* Hidden canvas for frame capture */}
        <canvas ref={canvasRef} className="hidden" />
      </div>

      {/* Info bar */}
      {isActive && (
        <div className="p-3 border-t border-border bg-muted/10">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Face Detection: {isDetecting ? 'Active' : 'Inactive'}</span>
            <span>Faces Detected: {faceDetections.length}</span>
          </div>
        </div>
      )}
    </div>
  );
}
