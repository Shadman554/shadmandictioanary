import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createWorker } from 'tesseract.js';

interface Props {
  onTextDetected: (text: string) => void;
  onClose: () => void;
  accentColor: string;
  bgColor: string;
  cardColor: string;
  textColor: string;
  text3Color: string;
}

export default function CameraScanner({
  onTextDetected,
  onClose,
  accentColor,
  bgColor,
  cardColor,
  textColor,
  text3Color,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>('idle');
  const [statusMsg, setStatusMsg] = useState('Point the camera at text and tap Scan');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  const startCamera = useCallback(async (facing: 'environment' | 'user') => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setCameraError(null);
    } catch (err: any) {
      const msg =
        err.name === 'NotAllowedError'
          ? 'Camera access denied. Please allow camera permission and try again.'
          : err.name === 'NotFoundError'
          ? 'No camera found on this device.'
          : 'Could not open camera: ' + (err.message || err.name);
      setCameraError(msg);
    }
  }, []);

  useEffect(() => {
    startCamera(facingMode);
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, [facingMode, startCamera]);

  const handleScan = useCallback(async () => {
    if (scanning || !videoRef.current || !canvasRef.current) return;
    setScanning(true);
    setStatus('processing');
    setStatusMsg('Reading text…');

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      setStatusMsg('Running OCR…');
      const worker = await createWorker('eng', 1, {
        logger: () => {},
      });
      const { data } = await worker.recognize(canvas);
      await worker.terminate();

      const extracted = data.text.trim().replace(/\n+/g, ' ').trim();
      if (!extracted) {
        setStatus('error');
        setStatusMsg('No text found. Try holding the camera steadier.');
        setScanning(false);
        return;
      }

      setStatus('done');
      setStatusMsg(`Found: "${extracted.slice(0, 60)}${extracted.length > 60 ? '…' : ''}"`);
      setTimeout(() => {
        onTextDetected(extracted);
        onClose();
      }, 600);
    } catch (err: any) {
      setStatus('error');
      setStatusMsg('OCR failed: ' + (err.message || 'unknown error'));
      setScanning(false);
    }
  }, [scanning, onTextDetected, onClose]);

  const flipCamera = useCallback(() => {
    setFacingMode(f => (f === 'environment' ? 'user' : 'environment'));
  }, []);

  const statusColor =
    status === 'error'   ? '#ff5555' :
    status === 'done'    ? '#55cc88' :
    status === 'processing' ? accentColor :
    text3Color;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      backgroundColor: bgColor,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px',
        backgroundColor: cardColor,
        borderBottom: `1px solid rgba(255,255,255,0.08)`,
      }}>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 22, color: textColor, padding: '4px 8px',
            borderRadius: 8, lineHeight: 1,
          }}
        >
          ✕
        </button>
        <span style={{ color: textColor, fontWeight: 700, fontSize: 16 }}>Scan Text</span>
        <button
          onClick={flipCamera}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 20, color: accentColor, padding: '4px 8px',
            borderRadius: 8, lineHeight: 1,
          }}
          title="Flip camera"
        >
          🔄
        </button>
      </div>

      {/* Camera view */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', backgroundColor: '#000' }}>
        {cameraError ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', padding: 32, gap: 16,
          }}>
            <span style={{ fontSize: 48 }}>📷</span>
            <span style={{ color: '#ff5555', textAlign: 'center', fontSize: 15 }}>{cameraError}</span>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              playsInline
              muted
            />
            {/* Scan frame overlay */}
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              <div style={{
                width: '80%', maxWidth: 400, height: 140,
                border: `2px solid ${accentColor}`,
                borderRadius: 12,
                boxShadow: `0 0 0 4000px rgba(0,0,0,0.45)`,
                position: 'relative',
              }}>
                {/* Corner accents */}
                {[
                  { top: -2, left: -2, borderTop: `4px solid ${accentColor}`, borderLeft: `4px solid ${accentColor}`, borderTopLeftRadius: 12 },
                  { top: -2, right: -2, borderTop: `4px solid ${accentColor}`, borderRight: `4px solid ${accentColor}`, borderTopRightRadius: 12 },
                  { bottom: -2, left: -2, borderBottom: `4px solid ${accentColor}`, borderLeft: `4px solid ${accentColor}`, borderBottomLeftRadius: 12 },
                  { bottom: -2, right: -2, borderBottom: `4px solid ${accentColor}`, borderRight: `4px solid ${accentColor}`, borderBottomRightRadius: 12 },
                ].map((style, i) => (
                  <div key={i} style={{ position: 'absolute', width: 24, height: 24, ...style }} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Hidden canvas for capture */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Bottom controls */}
      <div style={{
        padding: '20px 24px 32px',
        backgroundColor: cardColor,
        borderTop: `1px solid rgba(255,255,255,0.08)`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
      }}>
        <p style={{
          margin: 0, fontSize: 13, color: statusColor,
          textAlign: 'center', minHeight: 18,
          transition: 'color 0.3s',
        }}>
          {statusMsg}
        </p>

        <button
          onClick={handleScan}
          disabled={scanning || !!cameraError}
          style={{
            width: 68, height: 68, borderRadius: '50%',
            backgroundColor: scanning ? 'rgba(255,255,255,0.1)' : accentColor,
            border: `3px solid ${scanning ? 'rgba(255,255,255,0.2)' : accentColor}`,
            cursor: scanning || !!cameraError ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28,
            boxShadow: scanning ? 'none' : `0 0 20px ${accentColor}88`,
            transition: 'all 0.25s',
            outline: 'none',
          }}
          title="Scan text"
        >
          {scanning ? '⏳' : '📷'}
        </button>

        <p style={{ margin: 0, fontSize: 11, color: text3Color, textAlign: 'center' }}>
          Align text inside the frame, then tap the button
        </p>
      </div>
    </div>
  );
}
