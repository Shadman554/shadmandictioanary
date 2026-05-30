import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createWorker, Worker } from 'tesseract.js';

interface DetectedWord {
  text: string;
  x0: number; y0: number; x1: number; y1: number;
}

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
  const videoRef    = useRef<HTMLVideoElement>(null);
  const overlayRef  = useRef<HTMLCanvasElement>(null);
  const captureRef  = useRef<HTMLCanvasElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const workerRef   = useRef<Worker | null>(null);
  const loopRef     = useRef<boolean>(false);
  const wordsRef    = useRef<DetectedWord[]>([]);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanning,    setScanning]    = useState(false);
  const [facingMode,  setFacingMode]  = useState<'environment' | 'user'>('environment');
  const [words,       setWords]       = useState<DetectedWord[]>([]);
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [statusMsg,   setStatusMsg]   = useState('Starting…');

  // ── Draw word overlay on canvas ──────────────────────────────────────────
  const drawOverlay = useCallback((detected: DetectedWord[], vw: number, vh: number) => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!detected.length || !vw || !vh) return;

    const scaleX = canvas.width  / vw;
    const scaleY = canvas.height / vh;

    detected.forEach(w => {
      const x  = w.x0 * scaleX;
      const y  = w.y0 * scaleY;
      const bw = (w.x1 - w.x0) * scaleX;
      const bh = (w.y1 - w.y0) * scaleY;

      // Box fill
      ctx.fillStyle = 'rgba(91,132,196,0.18)';
      ctx.beginPath();
      ctx.roundRect(x - 2, y - 2, bw + 4, bh + 4, 4);
      ctx.fill();

      // Box stroke
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x - 2, y - 2, bw + 4, bh + 4, 4);
      ctx.stroke();

      // Underline
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y + bh + 3);
      ctx.lineTo(x + bw, y + bh + 3);
      ctx.stroke();

      // Text label
      const fontSize = Math.max(10, Math.min(bh * 0.55, 16));
      ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur  = 4;
      ctx.fillText(w.text, x + 2, y + bh - 2);
      ctx.shadowBlur = 0;
    });
  }, [accentColor]);

  // ── OCR loop ─────────────────────────────────────────────────────────────
  const runOCRLoop = useCallback(async () => {
    const video   = videoRef.current;
    const capture = captureRef.current;
    if (!video || !capture || !workerRef.current) return;

    while (loopRef.current) {
      if (video.readyState < 2 || video.videoWidth === 0) {
        await sleep(200);
        continue;
      }

      setScanning(true);
      setStatusMsg('Scanning…');

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      capture.width  = vw;
      capture.height = vh;
      const ctx = capture.getContext('2d');
      if (!ctx) break;
      ctx.drawImage(video, 0, 0, vw, vh);

      try {
        const { data } = await workerRef.current.recognize(capture);
        const detected: DetectedWord[] = (data.words || [])
          .filter((w: any) => w.confidence > 40 && w.text.trim().length > 1)
          .map((w: any) => ({
            text: w.text.trim(),
            x0: w.bbox.x0, y0: w.bbox.y0,
            x1: w.bbox.x1, y1: w.bbox.y1,
          }));

        wordsRef.current = detected;
        setWords(detected);
        setStatusMsg(detected.length > 0
          ? `${detected.length} word${detected.length !== 1 ? 's' : ''} detected — tap to search`
          : 'No text found — point at printed text');
        drawOverlay(detected, vw, vh);
      } catch {
        // ignore transient errors, keep looping
      }

      setScanning(false);
      await sleep(800); // pause between scans
    }
  }, [drawOverlay]);

  // ── Start/stop camera ────────────────────────────────────────────────────
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
        err.name === 'NotAllowedError' ? 'Camera access denied. Please allow camera permission and try again.' :
        err.name === 'NotFoundError'   ? 'No camera found on this device.' :
        'Could not open camera: ' + (err.message || err.name);
      setCameraError(msg);
    }
  }, []);

  // ── Init worker + camera ─────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    (async () => {
      setStatusMsg('Loading OCR engine…');
      try {
        const worker = await createWorker('eng', 1, { logger: () => {} });
        if (!mounted) { await worker.terminate(); return; }
        workerRef.current = worker;
        await startCamera(facingMode);
        setStatusMsg('Point camera at text');
        loopRef.current = true;
        runOCRLoop();
      } catch {
        if (mounted) setStatusMsg('Failed to load OCR engine');
      }
    })();

    return () => {
      mounted = false;
      loopRef.current = false;
      streamRef.current?.getTracks().forEach(t => t.stop());
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);  // only on mount

  // ── Re-init camera when facing mode changes ───────────────────────────────
  useEffect(() => {
    startCamera(facingMode);
  }, [facingMode, startCamera]);

  // ── Handle click on overlay canvas → find word under pointer ─────────────
  const handleOverlayClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayRef.current;
    const video  = videoRef.current;
    if (!canvas || !video) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const scaleX = canvas.width / video.videoWidth;
    const scaleY = canvas.height / video.videoHeight;

    const hit = wordsRef.current.find(w => {
      const x  = w.x0 * scaleX - 4;
      const y  = w.y0 * scaleY - 4;
      const bw = (w.x1 - w.x0) * scaleX + 8;
      const bh = (w.y1 - w.y0) * scaleY + 8;
      return clickX >= x && clickX <= x + bw && clickY >= y && clickY <= y + bh;
    });

    if (hit) {
      setSelectedWord(hit.text);
    }
  }, []);

  const confirmWord = useCallback(() => {
    if (selectedWord) {
      onTextDetected(selectedWord);
      onClose();
    }
  }, [selectedWord, onTextDetected, onClose]);

  const flipCamera = useCallback(() => {
    setFacingMode(f => f === 'environment' ? 'user' : 'environment');
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      backgroundColor: '#000',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px',
        backgroundColor: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(8px)',
        zIndex: 2,
      }}>
        <button onClick={onClose} style={btnStyle}>✕</button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>Live Text Scanner</div>
          <div style={{
            fontSize: 11, marginTop: 2,
            color: scanning ? accentColor : '#aaa',
            transition: 'color 0.3s',
          }}>
            {statusMsg}
          </div>
        </div>
        <button onClick={flipCamera} style={btnStyle} title="Flip camera">🔄</button>
      </div>

      {/* Camera + overlay */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {cameraError ? (
          <div style={errorContainer}>
            <span style={{ fontSize: 48 }}>📷</span>
            <span style={{ color: '#ff5555', textAlign: 'center', fontSize: 15, padding: '0 24px' }}>
              {cameraError}
            </span>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              playsInline
              muted
            />
            {/* Transparent overlay canvas for bounding boxes */}
            <canvas
              ref={overlayRef}
              onClick={handleOverlayClick}
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                cursor: 'crosshair',
              }}
            />
            {/* Scanning pulse indicator */}
            {scanning && (
              <div style={{
                position: 'absolute', top: 12, right: 12,
                width: 10, height: 10, borderRadius: '50%',
                backgroundColor: accentColor,
                boxShadow: `0 0 8px ${accentColor}`,
                animation: 'pulse 1s infinite',
              }} />
            )}
          </>
        )}
      </div>

      {/* Hidden capture canvas */}
      <canvas ref={captureRef} style={{ display: 'none' }} />

      {/* Bottom bar */}
      <div style={{
        padding: '14px 20px 28px',
        backgroundColor: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
        zIndex: 2,
      }}>
        {selectedWord ? (
          <>
            <div style={{
              backgroundColor: 'rgba(91,132,196,0.2)',
              border: `1.5px solid ${accentColor}`,
              borderRadius: 10, padding: '8px 18px',
              color: '#fff', fontSize: 16, fontWeight: 700,
            }}>
              "{selectedWord}"
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setSelectedWord(null)}
                style={{ ...actionBtn, backgroundColor: 'rgba(255,255,255,0.1)', color: '#ccc' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmWord}
                style={{ ...actionBtn, backgroundColor: accentColor, color: '#fff' }}
              >
                Search this word →
              </button>
            </div>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: '#888', textAlign: 'center' }}>
            Tap a highlighted word to search it in the dictionary
          </p>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

const btnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: 20, color: '#fff', padding: '6px 10px',
  borderRadius: 8, lineHeight: 1,
};

const errorContainer: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', height: '100%', gap: 16,
};

const actionBtn: React.CSSProperties = {
  border: 'none', borderRadius: 10, padding: '10px 20px',
  fontSize: 14, fontWeight: 700, cursor: 'pointer',
};
