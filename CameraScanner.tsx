import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { createWorker, Worker } from 'tesseract.js';
import { CloseIcon, FlipCameraIcon } from './Icons';

// ── Types ─────────────────────────────────────────────────────────────────────

type ScanStep   = 'live' | 'crop' | 'scanning' | 'results';
type FilterMode = 'enhance' | 'bw' | 'grayscale' | 'original';

interface Corner { x: number; y: number; }

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

// ── Homography helpers ────────────────────────────────────────────────────────

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r][col]) > Math.abs(M[maxRow][col])) maxRow = r;
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    const piv = M[col][col];
    if (Math.abs(piv) < 1e-10) continue;
    for (let j = col; j <= n; j++) M[col][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row[n]);
}

// Compute 3×3 homography mapping srcPts → dstPts (returns flat [h0..h8])
function computeHomography(srcPts: [number,number][], dstPts: [number,number][]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = srcPts[i];
    const [u, v] = dstPts[i];
    A.push([x, y, 1, 0, 0, 0, -u*x, -u*y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v*x, -v*y]); b.push(v);
  }
  const h = solveLinear(A, b);
  return [...h, 1];
}

function dist(a: Corner, b: Corner) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// Perspective-warp corners of src to a rectangle; returns new canvas
function perspectiveWarp(src: HTMLCanvasElement, corners: Corner[]): HTMLCanvasElement {
  // corners order: TL, TR, BR, BL
  const outW = Math.round(Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2])));
  const outH = Math.round(Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2])));

  const dst = document.createElement('canvas');
  dst.width  = Math.max(outW, 1);
  dst.height = Math.max(outH, 1);

  // Inverse map: for each dst pixel, find src pixel
  const dstPts: [number,number][] = [[0,0],[outW,0],[outW,outH],[0,outH]];
  const srcPts: [number,number][] = corners.map(c => [c.x, c.y] as [number,number]);
  const H = computeHomography(dstPts, srcPts); // dst → src

  const srcCtx = src.getContext('2d')!;
  const srcImg = srcCtx.getImageData(0, 0, src.width, src.height);
  const sd = srcImg.data;

  const dstCtx = dst.getContext('2d')!;
  const dstImg = dstCtx.createImageData(dst.width, dst.height);
  const dd = dstImg.data;
  const sw = src.width, sh = src.height;

  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const den = H[6]*u + H[7]*v + H[8];
      const sx  = (H[0]*u + H[1]*v + H[2]) / den;
      const sy  = (H[3]*u + H[4]*v + H[5]) / den;
      if (sx < 0 || sx >= sw - 1 || sy < 0 || sy >= sh - 1) continue;
      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const di  = (v * outW + u) * 4;
      for (let c = 0; c < 3; c++) {
        dd[di+c] = (sd[i00+c]*(1-fx)*(1-fy) + sd[i10+c]*fx*(1-fy) +
                    sd[i01+c]*(1-fx)*fy     + sd[i11+c]*fx*fy) | 0;
      }
      dd[di+3] = 255;
    }
  }
  dstCtx.putImageData(dstImg, 0, 0);
  return dst;
}

// Apply filter preset and return a new canvas
function applyFilter(src: HTMLCanvasElement, mode: FilterMode): HTMLCanvasElement {
  const dst = document.createElement('canvas');
  dst.width  = src.width;
  dst.height = src.height;
  const ctx  = dst.getContext('2d')!;
  const filters: Record<FilterMode, string> = {
    enhance:   'contrast(1.9) brightness(1.08) saturate(0.5)',
    bw:        'grayscale(1) contrast(2.2) brightness(1.1)',
    grayscale: 'grayscale(1) contrast(1.3)',
    original:  'none',
  };
  ctx.filter = filters[mode];
  ctx.drawImage(src, 0, 0);
  return dst;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CameraScanner({
  onTextDetected, onClose, lookupWord,
  accentColor, bgColor, cardColor, textColor, text3Color,
}: Props) {

  const videoRef     = useRef<HTMLVideoElement>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const workerRef    = useRef<Worker | null>(null);
  const cropContRef  = useRef<HTMLDivElement>(null);
  const overlayRef   = useRef<HTMLCanvasElement>(null);

  const [step,         setStep]         = useState<ScanStep>('live');
  const [captured,     setCaptured]     = useState<HTMLCanvasElement | null>(null);
  const [processed,    setProcessed]    = useState<HTMLCanvasElement | null>(null);
  const [corners,      setCorners]      = useState<Corner[]>([]);
  const [filter,       setFilter]       = useState<FilterMode>('enhance');
  const [dragIdx,      setDragIdx]      = useState<number>(-1);
  const [words,        setWords]        = useState<DetectedWord[]>([]);
  const [selectedWord, setSelectedWord] = useState<DetectedWord | null>(null);
  const [scanning,     setScanning]     = useState(false);
  const [statusMsg,    setStatusMsg]    = useState('Loading camera…');
  const [workerReady,  setWorkerReady]  = useState(false);
  const [facing,       setFacing]       = useState<'environment'|'user'>('environment');

  // ── Camera start/stop ────────────────────────────────────────────────────
  const startCamera = useCallback(async (f: 'environment' | 'user') => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: f, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); } catch(e: any) { if (e.name !== 'AbortError') throw e; }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setStatusMsg(
        err.name === 'NotAllowedError' ? 'Camera access denied — allow camera permission' :
        err.name === 'NotFoundError'   ? 'No camera found on this device' :
        'Camera error: ' + err.message
      );
    }
  }, []);

  // ── Init: start camera + Tesseract worker in parallel ────────────────────
  useEffect(() => {
    let mounted = true;
    startCamera('environment');

    (async () => {
      try {
        const w = await createWorker('eng', 1, { logger: () => {} });
        if (!mounted) { await w.terminate(); return; }
        await w.setParameters({ tessedit_pageseg_mode: '6' as any });
        workerRef.current = w;
        setWorkerReady(true);
        setStatusMsg('Hold device over document');
      } catch {
        if (mounted) setStatusMsg('OCR engine failed to load');
      }
    })();

    return () => {
      mounted = false;
      streamRef.current?.getTracks().forEach(t => t.stop());
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // ── Capture frame from video ─────────────────────────────────────────────
  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    const c = document.createElement('canvas');
    c.width = vw; c.height = vh;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(video, 0, 0, vw, vh);

    // Default corners: 8% inset from each corner
    const insetX = vw * 0.08, insetY = vh * 0.08;
    setCaptured(c);
    setCorners([
      { x: insetX,      y: insetY      },  // TL
      { x: vw - insetX, y: insetY      },  // TR
      { x: vw - insetX, y: vh - insetY },  // BR
      { x: insetX,      y: vh - insetY },  // BL
    ]);
    setStep('crop');
  }, []);

  // ── Apply warp + filter then run OCR ─────────────────────────────────────
  const processAndScan = useCallback(async () => {
    if (!captured || !workerRef.current) return;
    setStep('scanning');
    setStatusMsg('Cropping & enhancing…');
    setWords([]);
    setSelectedWord(null);

    await sleep(50); // let UI update

    const warped   = perspectiveWarp(captured, corners);
    const filtered = applyFilter(warped, filter);
    setProcessed(filtered);

    setStatusMsg('Scanning text…');
    setScanning(true);

    try {
      const { data } = await workerRef.current.recognize(filtered);
      const detected: DetectedWord[] = (data.words || [])
        .filter((w: any) => w.confidence > 20 && w.text.trim().length > 1)
        .map((w: any) => {
          const text    = w.text.trim().replace(/[^a-zA-Z'-]/g, '');
          const meaning = text.length > 1 ? lookupWord(text) : null;
          return { text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, meaning };
        })
        .filter((w: DetectedWord) => w.text.length > 1);

      const hits = detected.filter(w => w.meaning !== null).length;
      setWords(detected);
      setStatusMsg(detected.length > 0
        ? hits > 0
          ? `${hits} dictionary word${hits !== 1 ? 's' : ''} found — tap to see meaning`
          : `${detected.length} word${detected.length !== 1 ? 's' : ''} detected — none in dictionary`
        : 'No text detected — try a different filter or re-capture');
    } catch {
      setStatusMsg('OCR failed — try again');
    }

    setScanning(false);
    setStep('results');
  }, [captured, corners, filter, lookupWord]);

  // ── Draw OCR word overlay on the results canvas ──────────────────────────
  useEffect(() => {
    if (step !== 'results' || !processed || !overlayRef.current) return;
    const canvas = overlayRef.current;
    const ctx    = canvas.getContext('2d')!;
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scaleX = canvas.width  / processed.width;
    const scaleY = canvas.height / processed.height;

    words.forEach(w => {
      const x  = w.x0 * scaleX, y  = w.y0 * scaleY;
      const bw = (w.x1 - w.x0) * scaleX, bh = (w.y1 - w.y0) * scaleY;
      const inDict = w.meaning !== null;

      ctx.fillStyle = inDict ? `rgba(91,132,196,0.25)` : `rgba(255,255,255,0.08)`;
      ctx.beginPath(); ctx.roundRect(x-2, y-2, bw+4, bh+4, 4); ctx.fill();

      ctx.strokeStyle = inDict ? accentColor : 'rgba(255,255,255,0.3)';
      ctx.lineWidth   = inDict ? 2 : 1;
      ctx.beginPath(); ctx.roundRect(x-2, y-2, bw+4, bh+4, 4); ctx.stroke();

      if (inDict) {
        ctx.strokeStyle = accentColor;
        ctx.lineWidth   = 2.5;
        ctx.beginPath(); ctx.moveTo(x, y+bh+4); ctx.lineTo(x+bw, y+bh+4); ctx.stroke();

        if (w.meaning) {
          const label = w.meaning.length > 28 ? w.meaning.slice(0, 26) + '…' : w.meaning;
          const fs    = Math.max(9, Math.min(13, bh * 0.5));
          ctx.font    = `bold ${fs}px system-ui, sans-serif`;
          const lw    = ctx.measureText(label).width + 10;
          const lh    = fs + 8;
          const lx    = Math.max(2, x);
          const ly    = Math.max(lh + 2, y - lh - 4);
          ctx.fillStyle = accentColor;
          ctx.beginPath(); ctx.roundRect(lx, ly, lw, lh, 4); ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 2;
          ctx.fillText(label, lx + 5, ly + lh - 4);
          ctx.shadowBlur = 0;
        }
      }
    });
  }, [step, words, processed, accentColor]);

  // ── Corner drag handling ─────────────────────────────────────────────────
  const getImgLayout = useCallback(() => {
    const el = cropContRef.current;
    if (!el || !captured) return null;
    const rect = el.getBoundingClientRect();
    const cw = rect.width, ch = rect.height;
    const scale = Math.min(cw / captured.width, ch / captured.height);
    const dispW = captured.width * scale;
    const dispH = captured.height * scale;
    const offX  = (cw - dispW) / 2;
    const offY  = (ch - dispH) / 2;
    return { scale, offX, offY, dispW, dispH };
  }, [captured]);

  const imgToScreen = useCallback((c: Corner) => {
    const l = getImgLayout();
    if (!l) return { x: 0, y: 0 };
    return { x: c.x * l.scale + l.offX, y: c.y * l.scale + l.offY };
  }, [getImgLayout]);

  const screenToImg = useCallback((sx: number, sy: number, rect: DOMRect) => {
    const l = getImgLayout();
    if (!l) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(captured!.width,  (sx - rect.left - l.offX) / l.scale)),
      y: Math.max(0, Math.min(captured!.height, (sy - rect.top  - l.offY) / l.scale)),
    };
  }, [getImgLayout, captured]);

  const onPointerDown = useCallback((idx: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragIdx(idx);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragIdx < 0 || !cropContRef.current) return;
    const rect = cropContRef.current.getBoundingClientRect();
    const img  = screenToImg(e.clientX, e.clientY, rect);
    setCorners(cs => cs.map((c, i) => i === dragIdx ? img : c));
  }, [dragIdx, screenToImg]);

  const onPointerUp = useCallback(() => setDragIdx(-1), []);

  // ── Overlay click for results ────────────────────────────────────────────
  const onOverlayClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!processed || !overlayRef.current) return;
    const canvas = overlayRef.current;
    const rect   = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const sx = canvas.width / processed.width, sy = canvas.height / processed.height;
    const hit = words.find(w => {
      const x = w.x0*sx - 6, y = w.y0*sy - 6;
      const bw = (w.x1-w.x0)*sx + 12, bh = (w.y1-w.y0)*sy + 12;
      return cx >= x && cx <= x+bw && cy >= y && cy <= y+bh;
    });
    if (hit) setSelectedWord(hit);
  }, [words, processed]);

  const flipCamera = useCallback(() => {
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    startCamera(next);
  }, [facing, startCamera]);

  const reset = useCallback(() => {
    setStep('live');
    setCaptured(null);
    setProcessed(null);
    setCorners([]);
    setWords([]);
    setSelectedWord(null);
    setStatusMsg('Hold device over document');
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, backgroundColor: '#000', display: 'flex', flexDirection: 'column' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', backgroundColor: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(8px)', zIndex: 10,
      }}>
        <button onClick={step === 'live' ? onClose : reset} style={btnS}>
          <CloseIcon size={18} color="#fff" />
        </button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>
            {step === 'live'     ? 'Document Scanner' :
             step === 'crop'     ? 'Adjust Corners'   :
             step === 'scanning' ? 'Processing…'      : 'Scan Results'}
          </div>
          <div style={{ fontSize: 11, marginTop: 2, color: scanning ? accentColor : '#999' }}>
            {statusMsg}
          </div>
        </div>
        {step === 'live'
          ? <button onClick={flipCamera} style={btnS}><FlipCameraIcon size={20} color="#fff" /></button>
          : <div style={{ width: 42 }} />}
      </div>

      {/* ── Main content area ───────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>

        {/* LIVE VIEW */}
        {step === 'live' && (
          <>
            <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              playsInline muted />
            {/* Document guide frame */}
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              <defs>
                <mask id="hole">
                  <rect width="100%" height="100%" fill="white" />
                  <rect x="8%" y="10%" width="84%" height="80%" rx="8" fill="black" />
                </mask>
              </defs>
              <rect width="100%" height="100%" fill="rgba(0,0,0,0.35)" mask="url(#hole)" />
              <rect x="8%" y="10%" width="84%" height="80%" rx="8"
                fill="none" stroke={accentColor} strokeWidth="2" strokeDasharray="8 5" />
              {/* Corner brackets */}
              {[['8%','10%',1,1],['92%','10%',-1,1],['92%','90%',-1,-1],['8%','90%',1,-1]].map(([cx,cy,dx,dy], i) => (
                <g key={i} transform={`translate(${cx},${cy})`}>
                  <line x1="0" y1="0" x2={`${(dx as number)*24}px`} y2="0" stroke={accentColor} strokeWidth="3" strokeLinecap="round" />
                  <line x1="0" y1="0" x2="0" y2={`${(dy as number)*24}px`} stroke={accentColor} strokeWidth="3" strokeLinecap="round" />
                </g>
              ))}
            </svg>
            <div style={{ position: 'absolute', bottom: 100, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
              Align document within the frame
            </div>
          </>
        )}

        {/* CROP / ADJUST CORNERS */}
        {step === 'crop' && captured && (
          <div
            ref={cropContRef}
            style={{ width: '100%', height: '100%', position: 'relative', cursor: dragIdx >= 0 ? 'none' : 'crosshair' }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            {/* Document image */}
            <img
              src={captured.toDataURL()}
              style={{
                position: 'absolute',
                ...(() => {
                  const el = cropContRef.current;
                  if (!el) return { inset: 0, width: '100%', height: '100%', objectFit: 'contain' };
                  return { inset: 0, width: '100%', height: '100%', objectFit: 'contain' };
                })(),
                pointerEvents: 'none', display: 'block',
              }}
              alt="captured"
            />
            {/* Quadrilateral overlay */}
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              {corners.length === 4 && (() => {
                const pts = corners.map(c => imgToScreen(c));
                const d   = pts.map((p,i) => `${i===0?'M':'L'}${p.x},${p.y}`).join(' ') + ' Z';
                return (
                  <>
                    <path d={d} fill="rgba(91,132,196,0.15)" stroke={accentColor} strokeWidth="2" />
                    {pts.map((p, i) => (
                      <circle key={i} cx={p.x} cy={p.y} r="12" fill={accentColor} stroke="#fff" strokeWidth="2" opacity="0.9" />
                    ))}
                  </>
                );
              })()}
            </svg>
            {/* Draggable corner handles (invisible but hit-testable) */}
            {corners.map((c, i) => {
              const sp = imgToScreen(c);
              return (
                <div
                  key={i}
                  onPointerDown={e => onPointerDown(i, e)}
                  style={{
                    position: 'absolute',
                    left: sp.x - 24, top: sp.y - 24,
                    width: 48, height: 48,
                    borderRadius: '50%',
                    cursor: 'grab',
                    touchAction: 'none',
                  }}
                />
              );
            })}
          </div>
        )}

        {/* SCANNING */}
        {step === 'scanning' && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 20 }}>
            <div style={{ width: 60, height: 60, borderRadius: '50%', border: `4px solid ${accentColor}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ color: '#aaa', fontSize: 15 }}>{statusMsg}</div>
          </div>
        )}

        {/* RESULTS */}
        {step === 'results' && processed && (
          <>
            <img
              src={processed.toDataURL()}
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none' }}
              alt="scanned"
            />
            <canvas
              ref={overlayRef}
              onClick={onOverlayClick}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'pointer' }}
            />
          </>
        )}
      </div>

      {/* ── Bottom bar ─────────────────────────────────────────────────────── */}
      <div style={{
        backgroundColor: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(10px)',
        padding: step === 'live' ? '16px 20px 32px' : '14px 20px 28px',
        zIndex: 10,
      }}>

        {/* LIVE: capture button */}
        {step === 'live' && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              onClick={captureFrame}
              disabled={!workerReady}
              style={{
                width: 72, height: 72, borderRadius: '50%',
                backgroundColor: workerReady ? '#fff' : '#555',
                border: `4px solid ${accentColor}`,
                cursor: workerReady ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: workerReady ? `0 0 20px ${accentColor}55` : 'none',
                transition: 'all 0.2s',
              }}
            >
              <div style={{ width: 52, height: 52, borderRadius: '50%', backgroundColor: workerReady ? accentColor : '#888' }} />
            </button>
          </div>
        )}

        {/* CROP: filter selector + scan button */}
        {step === 'crop' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Filter chips */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              {([
                { mode: 'enhance'  as FilterMode, label: '✦ Enhance' },
                { mode: 'bw'       as FilterMode, label: 'B & W'     },
                { mode: 'grayscale'as FilterMode, label: 'Grayscale' },
                { mode: 'original' as FilterMode, label: 'Original'  },
              ]).map(({ mode, label }) => (
                <button
                  key={mode}
                  onClick={() => setFilter(mode)}
                  style={{
                    padding: '6px 14px', borderRadius: 20, border: 'none',
                    fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    backgroundColor: filter === mode ? accentColor : 'rgba(255,255,255,0.12)',
                    color: filter === mode ? '#fff' : '#aaa',
                    transition: 'all 0.2s',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={reset}
                style={{ ...actionBtnS, flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', color: '#ccc' }}>
                Re-capture
              </button>
              <button onClick={processAndScan}
                style={{ ...actionBtnS, flex: 2, backgroundColor: accentColor, color: '#fff' }}>
                Scan Document →
              </button>
            </div>
          </div>
        )}

        {/* RESULTS: word detail panel or hint */}
        {step === 'results' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {selectedWord ? (
              <>
                <div style={{
                  backgroundColor: 'rgba(91,132,196,0.18)', border: `1.5px solid ${accentColor}`,
                  borderRadius: 12, padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <div style={{ color: '#fff', fontSize: 17, fontWeight: 700 }}>{selectedWord.text}</div>
                  {selectedWord.meaning
                    ? <div style={{ color: accentColor, fontSize: 14, direction: 'rtl', textAlign: 'right' }}>{selectedWord.meaning}</div>
                    : <div style={{ color: '#777', fontSize: 13 }}>Not in dictionary</div>}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setSelectedWord(null)}
                    style={{ ...actionBtnS, flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', color: '#ccc' }}>
                    Close
                  </button>
                  <button onClick={() => { onTextDetected(selectedWord.text); onClose(); }}
                    style={{ ...actionBtnS, flex: 2, backgroundColor: accentColor, color: '#fff' }}>
                    Open in Dictionary →
                  </button>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={reset}
                  style={{ ...actionBtnS, flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', color: '#ccc' }}>
                  Scan Again
                </button>
                <div style={{ flex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ color: '#777', fontSize: 12, textAlign: 'center' }}>
                    {words.length > 0
                      ? 'Tap a highlighted word to see its Kurdish meaning'
                      : statusMsg}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

const btnS: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: '#fff', padding: '6px 10px', borderRadius: 8, lineHeight: 1,
};

const actionBtnS: React.CSSProperties = {
  border: 'none', borderRadius: 10, padding: '11px 16px',
  fontSize: 14, fontWeight: 700, cursor: 'pointer',
};
