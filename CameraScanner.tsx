import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createWorker, Worker } from 'tesseract.js';
import { CloseIcon, FlipCameraIcon } from './Icons';

interface DetectedWord {
  text: string;
  x0: number; y0: number; x1: number; y1: number;
  meaning: string | null;
}

interface Props {
  onTextDetected: (text: string) => void;
  onClose: () => void;
  lookupWord: (word: string) => string | null;
  accentColor: string;
  bgColor: string;
  cardColor: string;
  textColor: string;
  text3Color: string;
}

export default function CameraScanner({
  onTextDetected,
  onClose,
  lookupWord,
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

  const [cameraError,   setCameraError]   = useState<string | null>(null);
  const [scanning,      setScanning]      = useState(false);
  const [words,         setWords]         = useState<DetectedWord[]>([]);
  const [selectedWord,  setSelectedWord]  = useState<DetectedWord | null>(null);
  const [statusMsg,     setStatusMsg]     = useState('Starting…');

  // ── Preprocess video frame for better OCR ────────────────────────────────
  const preprocessFrame = useCallback((dst: HTMLCanvasElement): { vw: number; vh: number } | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    dst.width  = vw;
    dst.height = vh;
    const ctx = dst.getContext('2d');
    if (!ctx) return null;

    // Grayscale + higher contrast → dramatically helps Tesseract
    ctx.filter = 'grayscale(1) contrast(1.8) brightness(1.05)';
    ctx.drawImage(video, 0, 0, vw, vh);
    ctx.filter = 'none';
    return { vw, vh };
  }, []);

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

      const inDict  = w.meaning !== null;
      const boxColor = inDict ? accentColor : 'rgba(255,255,255,0.4)';
      const fillAlpha = inDict ? 0.22 : 0.08;

      // Box fill
      ctx.fillStyle = inDict
        ? `rgba(91,132,196,${fillAlpha})`
        : `rgba(255,255,255,${fillAlpha})`;
      ctx.beginPath();
      ctx.roundRect(x - 2, y - 2, bw + 4, bh + 4, 4);
      ctx.fill();

      // Box stroke
      ctx.strokeStyle = boxColor;
      ctx.lineWidth = inDict ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(x - 2, y - 2, bw + 4, bh + 4, 4);
      ctx.stroke();

      // Underline (only for dictionary words)
      if (inDict) {
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, y + bh + 4);
        ctx.lineTo(x + bw, y + bh + 4);
        ctx.stroke();
      }

      // Show meaning label above the box for dictionary words
      if (inDict && w.meaning) {
        const labelText = w.meaning.length > 30 ? w.meaning.slice(0, 28) + '…' : w.meaning;
        const fontSize  = Math.max(9, Math.min(13, bh * 0.5));
        ctx.font = `bold ${fontSize}px system-ui, sans-serif`;

        const labelW = ctx.measureText(labelText).width + 10;
        const labelH = fontSize + 8;
        const lx = Math.max(2, x);
        const ly = Math.max(labelH + 2, y - labelH - 4);

        // Label background
        ctx.fillStyle = accentColor;
        ctx.beginPath();
        ctx.roundRect(lx, ly, labelW, labelH, 4);
        ctx.fill();

        // Label text
        ctx.fillStyle = '#fff';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur  = 3;
        ctx.fillText(labelText, lx + 5, ly + labelH - 4);
        ctx.shadowBlur  = 0;
      }
    });
  }, [accentColor]);

  // ── OCR loop ─────────────────────────────────────────────────────────────
  const runOCRLoop = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture || !workerRef.current) return;

    while (loopRef.current) {
      const frame = preprocessFrame(capture);
      if (!frame) {
        await sleep(200);
        continue;
      }
      const { vw, vh } = frame;

      setScanning(true);
      setStatusMsg('Scanning…');

      try {
        const { data } = await workerRef.current.recognize(capture);
        const detected: DetectedWord[] = (data.words || [])
          .filter((w: any) => w.confidence > 15 && w.text.trim().length > 1)
          .map((w: any) => {
            const text = w.text.trim().replace(/[^a-zA-Z'-]/g, '');
            const meaning = text.length > 1 ? lookupWord(text) : null;
            return {
              text,
              x0: w.bbox.x0, y0: w.bbox.y0,
              x1: w.bbox.x1, y1: w.bbox.y1,
              meaning,
            };
          })
          .filter((w: DetectedWord) => w.text.length > 1);

        wordsRef.current = detected;
        setWords(detected);

        const dictHits = detected.filter(w => w.meaning !== null).length;
        if (detected.length > 0) {
          setStatusMsg(dictHits > 0
            ? `${dictHits} word${dictHits !== 1 ? 's' : ''} found in dictionary — tap to see meaning`
            : `${detected.length} word${detected.length !== 1 ? 's' : ''} detected — not in dictionary`);
        } else {
          setStatusMsg('No text found — hold steady, point at printed text');
        }
        drawOverlay(detected, vw, vh);
      } catch {
        // ignore transient errors
      }

      setScanning(false);
      await sleep(1000);
    }
  }, [drawOverlay, lookupWord, preprocessFrame]);

  // ── Start/stop camera ────────────────────────────────────────────────────
  const startCamera = useCallback(async (facing: 'environment' | 'user') => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); }
        catch (e: any) { if (e.name !== 'AbortError') throw e; }
      }
      setCameraError(null);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setCameraError(
        err.name === 'NotAllowedError' ? 'Camera access denied. Please allow camera permission.' :
        err.name === 'NotFoundError'   ? 'No camera found on this device.' :
        'Could not open camera: ' + (err.message || err.name)
      );
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

        // PSM 6 = assume a uniform block of text — better for documents
        await worker.setParameters({
          tessedit_pageseg_mode: '6' as any,
          preserve_interword_spaces: '1' as any,
        });

        workerRef.current = worker;
        await startCamera('environment');
        if (!mounted) return;
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
  }, []);

  // ── Handle click on overlay canvas ────────────────────────────────────────
  const handleOverlayClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayRef.current;
    const video  = videoRef.current;
    if (!canvas || !video) return;

    const rect   = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const scaleX = canvas.width / (video.videoWidth || 1);
    const scaleY = canvas.height / (video.videoHeight || 1);

    const hit = wordsRef.current.find(w => {
      const x  = w.x0 * scaleX - 6;
      const y  = w.y0 * scaleY - 6;
      const bw = (w.x1 - w.x0) * scaleX + 12;
      const bh = (w.y1 - w.y0) * scaleY + 12;
      return clickX >= x && clickX <= x + bw && clickY >= y && clickY <= y + bh;
    });

    if (hit) setSelectedWord(hit);
  }, []);

  const flipCamera = useCallback(() => {
    const next = streamRef.current?.getVideoTracks()[0]?.getSettings().facingMode === 'user'
      ? 'environment' : 'user';
    startCamera(next);
  }, [startCamera]);

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
        <button onClick={onClose} style={btnStyle}><CloseIcon size={18} color="#fff" /></button>
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
        <button onClick={flipCamera} style={btnStyle} title="Flip camera">
          <FlipCameraIcon size={20} color="#fff" />
        </button>
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
            <canvas
              ref={overlayRef}
              onClick={handleOverlayClick}
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                cursor: 'crosshair',
              }}
            />
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

      {/* Bottom panel */}
      <div style={{
        padding: '14px 20px 28px',
        backgroundColor: 'rgba(0,0,0,0.88)',
        backdropFilter: 'blur(10px)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        zIndex: 2,
        minHeight: 80,
      }}>
        {selectedWord ? (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Word + meaning card */}
            <div style={{
              backgroundColor: 'rgba(91,132,196,0.18)',
              border: `1.5px solid ${accentColor}`,
              borderRadius: 12, padding: '10px 16px',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ color: '#fff', fontSize: 17, fontWeight: 700 }}>
                {selectedWord.text}
              </div>
              {selectedWord.meaning ? (
                <div style={{ color: accentColor, fontSize: 14, direction: 'rtl', textAlign: 'right' }}>
                  {selectedWord.meaning}
                </div>
              ) : (
                <div style={{ color: '#888', fontSize: 13 }}>
                  Not in dictionary
                </div>
              )}
            </div>
            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8, width: '100%' }}>
              <button
                onClick={() => setSelectedWord(null)}
                style={{ ...actionBtn, flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', color: '#ccc' }}
              >
                Cancel
              </button>
              <button
                onClick={() => { onTextDetected(selectedWord.text); onClose(); }}
                style={{ ...actionBtn, flex: 2, backgroundColor: accentColor, color: '#fff' }}
              >
                Open in Dictionary →
              </button>
            </div>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: '#777', textAlign: 'center' }}>
            {words.length > 0
              ? 'Tap a highlighted word to see its Kurdish meaning'
              : 'Hold camera steady over printed text'}
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
  border: 'none', borderRadius: 10, padding: '10px 16px',
  fontSize: 14, fontWeight: 700, cursor: 'pointer',
};
