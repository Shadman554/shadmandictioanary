import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createWorker, Worker } from 'tesseract.js';
import { CloseIcon, FlipCameraIcon } from './Icons';

// ── Types ─────────────────────────────────────────────────────────────────────

type ScanStep   = 'live' | 'crop' | 'processing' | 'results';
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

// ── Image processing utilities ────────────────────────────────────────────────

/** Scale canvas to fit within maxDim, preserving aspect ratio */
function scaleCanvas(src: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
  if (src.width <= maxDim && src.height <= maxDim) return src;
  const s = maxDim / Math.max(src.width, src.height);
  const c = document.createElement('canvas');
  c.width = src.width * s | 0; c.height = src.height * s | 0;
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Auto-detect document corners using Sobel edge detection */
function detectDocumentCorners(canvas: HTMLCanvasElement): Corner[] {
  // Work on a small version for speed
  const small = scaleCanvas(canvas, 480);
  const w = small.width, h = small.height;
  const invS = canvas.width / w; // scale back factor

  const ctx = small.getContext('2d')!;
  ctx.filter = 'blur(1px)';
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d')!.drawImage(small, 0, 0);
  ctx.filter = 'none';

  const d = tmp.getContext('2d')!.getImageData(0, 0, w, h).data;

  // Grayscale
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    g[i] = (d[i*4]*77 + d[i*4+1]*150 + d[i*4+2]*29) >> 8;

  // Sobel edges
  const e = new Uint8Array(w * h);
  for (let y = 1; y < h-1; y++) {
    for (let x = 1; x < w-1; x++) {
      const gx = (-g[(y-1)*w+x-1] + g[(y-1)*w+x+1]
                  -2*g[y*w+x-1]   + 2*g[y*w+x+1]
                  -g[(y+1)*w+x-1] + g[(y+1)*w+x+1]);
      const gy = (-g[(y-1)*w+x-1] - 2*g[(y-1)*w+x] - g[(y-1)*w+x+1]
                  +g[(y+1)*w+x-1] + 2*g[(y+1)*w+x] + g[(y+1)*w+x+1]);
      e[y*w+x] = Math.min(255, Math.sqrt(gx*gx + gy*gy) | 0);
    }
  }

  // Dynamic threshold: mean + 0.5 * std of edges
  let sum = 0, sumSq = 0, cnt = 0;
  for (let i = 0; i < e.length; i++) { if (e[i] > 0) { sum += e[i]; sumSq += e[i]*e[i]; cnt++; } }
  const mean = cnt ? sum / cnt : 80;
  const std  = cnt ? Math.sqrt(sumSq / cnt - mean * mean) : 40;
  const thresh = Math.max(40, mean + std * 0.4);

  // Find 4 extremal corners of strong edge pixels
  // TL: min(x+y)  TR: max(x-y)  BR: max(x+y)  BL: min(x-y)
  let tlS = Infinity, trS = -Infinity, brS = -Infinity, blS = Infinity;
  let tl = {x:w*0.08,y:h*0.08}, tr = {x:w*0.92,y:h*0.08};
  let br = {x:w*0.92,y:h*0.92}, bl = {x:w*0.08,y:h*0.92};

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (e[y*w+x] < thresh) continue;
      const s = x+y, df = x-y;
      if (s  < tlS) { tlS = s;  tl = {x,y}; }
      if (df > trS) { trS = df; tr = {x,y}; }
      if (s  > brS) { brS = s;  br = {x,y}; }
      if (df < blS) { blS = df; bl = {x,y}; }
    }
  }

  // Add a small outward nudge so the document edge is fully included
  const pad = 0.015;
  const px = w * pad, py = h * pad;

  const scale = (c: Corner, dx: number, dy: number): Corner =>
    ({ x: Math.max(0, Math.min(canvas.width,  (c.x + dx) * invS)),
       y: Math.max(0, Math.min(canvas.height, (c.y + dy) * invS)) });

  return [
    scale(tl, -px, -py),  // TL
    scale(tr,  px, -py),  // TR
    scale(br,  px,  py),  // BR
    scale(bl, -px,  py),  // BL
  ];
}

/** Validate that 4 corners form a reasonable quadrilateral */
function cornersValid(cs: Corner[], imgW: number, imgH: number): boolean {
  if (cs.length !== 4) return false;
  const minArea = imgW * imgH * 0.05;
  // Shoelace formula
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i+1) % 4;
    area += cs[i].x * cs[j].y - cs[j].x * cs[i].y;
  }
  return Math.abs(area) / 2 > minArea;
}

/** Compute 3×3 homography that maps srcPts → dstPts */
function computeHomography(srcPts: [number,number][], dstPts: [number,number][]): number[] {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x,y] = srcPts[i], [u,v] = dstPts[i];
    A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
    A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v);
  }
  // Gaussian elimination
  const n = 8, M = A.map((row,i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let mx = col;
    for (let r = col+1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[mx][col])) mx = r;
    [M[col],M[mx]] = [M[mx],M[col]];
    const piv = M[col][col];
    if (Math.abs(piv) < 1e-10) continue;
    for (let j = col; j <= n; j++) M[col][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return [...M.map(row => row[n]), 1];
}

function dist(a: Corner, b: Corner) { return Math.hypot(b.x-a.x, b.y-a.y); }

/** Perspective-correct warp of corners → rectangle */
function perspectiveWarp(src: HTMLCanvasElement, corners: Corner[]): HTMLCanvasElement {
  const outW = Math.round(Math.max(dist(corners[0],corners[1]), dist(corners[3],corners[2])));
  const outH = Math.round(Math.max(dist(corners[0],corners[3]), dist(corners[1],corners[2])));

  const dst = document.createElement('canvas');
  dst.width = Math.max(outW, 1); dst.height = Math.max(outH, 1);

  // Inverse mapping: for each dst pixel, find src pixel
  const dstPts: [number,number][] = [[0,0],[outW,0],[outW,outH],[0,outH]];
  const srcPts: [number,number][] = corners.map(c => [c.x, c.y] as [number,number]);
  const H = computeHomography(dstPts, srcPts);

  const srcCtx = src.getContext('2d')!;
  const sd = srcCtx.getImageData(0, 0, src.width, src.height).data;

  const dstCtx = dst.getContext('2d')!;
  const di = dstCtx.createImageData(dst.width, dst.height);
  const dd = di.data;
  const sw = src.width, sh = src.height;

  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const den = H[6]*u + H[7]*v + H[8];
      const sx  = (H[0]*u + H[1]*v + H[2]) / den;
      const sy  = (H[3]*u + H[4]*v + H[5]) / den;
      if (sx < 0 || sx >= sw-1 || sy < 0 || sy >= sh-1) continue;
      const x0 = sx|0, y0 = sy|0, fx = sx-x0, fy = sy-y0;
      const i00 = (y0*sw+x0)*4, i10 = i00+4, i01 = i00+sw*4, i11 = i01+4;
      const dp  = (v*outW+u)*4;
      for (let c = 0; c < 3; c++)
        dd[dp+c] = (sd[i00+c]*(1-fx)*(1-fy)+sd[i10+c]*fx*(1-fy)+
                    sd[i01+c]*(1-fx)*fy    +sd[i11+c]*fx*fy) | 0;
      dd[dp+3] = 255;
    }
  }
  dstCtx.putImageData(di, 0, 0);
  return dst;
}

/** Apply display filter preset */
function applyFilter(src: HTMLCanvasElement, mode: FilterMode): HTMLCanvasElement {
  const dst = document.createElement('canvas');
  dst.width = src.width; dst.height = src.height;
  const ctx = dst.getContext('2d')!;
  ctx.filter = {
    enhance:   'contrast(1.7) brightness(1.05) saturate(0.4)',
    bw:        'grayscale(1) contrast(1.8) brightness(1.05)',
    grayscale: 'grayscale(1) contrast(1.2)',
    original:  'none',
  }[mode];
  ctx.drawImage(src, 0, 0);
  return dst;
}

/** Prepare image for Tesseract: scale to max 1500px, convert to PNG data URL */
function prepareForOCR(src: HTMLCanvasElement): string {
  // Scale down if needed — large images cause Tesseract to fail or hang
  const scaled = scaleCanvas(src, 1500);
  // Apply OCR-specific preprocessing: grayscale + moderate contrast (not too harsh)
  const ocr = document.createElement('canvas');
  ocr.width = scaled.width; ocr.height = scaled.height;
  const ctx = ocr.getContext('2d')!;
  ctx.filter = 'grayscale(1) contrast(1.4) brightness(1.08)';
  ctx.drawImage(scaled, 0, 0);
  ctx.filter = 'none';
  return ocr.toDataURL('image/png');
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CameraScanner({
  onTextDetected, onClose, lookupWord,
  accentColor,
}: Props) {

  const videoRef    = useRef<HTMLVideoElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const workerRef   = useRef<Worker | null>(null);
  const cropContRef = useRef<HTMLDivElement>(null);
  const overlayRef  = useRef<HTMLCanvasElement>(null);
  const liveDetRef  = useRef<number>(0); // setInterval id for live detection

  const [step,         setStep]         = useState<ScanStep>('live');
  const [captured,     setCaptured]     = useState<HTMLCanvasElement | null>(null);
  const [processed,    setProcessed]    = useState<HTMLCanvasElement | null>(null);
  const [corners,      setCorners]      = useState<Corner[]>([]);
  const [liveCorners,  setLiveCorners]  = useState<Corner[] | null>(null);
  const [filter,       setFilter]       = useState<FilterMode>('enhance');
  const [dragIdx,      setDragIdx]      = useState(-1);
  const [words,        setWords]        = useState<DetectedWord[]>([]);
  const [selectedWord, setSelectedWord] = useState<DetectedWord | null>(null);
  const [scanning,     setScanning]     = useState(false);
  const [statusMsg,    setStatusMsg]    = useState('Starting camera…');
  const [workerReady,  setWorkerReady]  = useState(false);
  const [facing,       setFacing]       = useState<'environment'|'user'>('environment');
  const [processMsg,   setProcessMsg]   = useState('');

  // ── Camera ───────────────────────────────────────────────────────────────
  const startCamera = useCallback(async (f: 'environment' | 'user') => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: f, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = s;
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        try { await videoRef.current.play(); } catch(e: any) { if (e.name !== 'AbortError') throw e; }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setStatusMsg(err.name === 'NotAllowedError' ? 'Camera access denied' : 'Camera error: ' + err.message);
    }
  }, []);

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    startCamera('environment');
    (async () => {
      try {
        const w = await createWorker('eng', 1, { logger: () => {} });
        if (!mounted) { await w.terminate(); return; }
        await w.setParameters({ tessedit_pageseg_mode: '1' as any });
        workerRef.current = w;
        setWorkerReady(true);
        setStatusMsg('Align document in the frame, then capture');
      } catch {
        if (mounted) setStatusMsg('OCR engine failed to load');
      }
    })();
    return () => {
      mounted = false;
      clearInterval(liveDetRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // ── Live document edge detection every 1.5s ───────────────────────────────
  useEffect(() => {
    if (step !== 'live') { clearInterval(liveDetRef.current); return; }
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      const tmp = document.createElement('canvas');
      tmp.width  = video.videoWidth;
      tmp.height = video.videoHeight;
      tmp.getContext('2d')!.drawImage(video, 0, 0);
      const detected = detectDocumentCorners(tmp);
      if (cornersValid(detected, tmp.width, tmp.height)) {
        // Convert image coords to % of video display area for SVG overlay
        const toVid = (c: Corner) => ({ x: c.x / tmp.width, y: c.y / tmp.height });
        setLiveCorners(detected.map(toVid) as any);
      } else {
        setLiveCorners(null);
      }
    }, 1500);
    liveDetRef.current = id;
    return () => clearInterval(id);
  }, [step]);

  // ── Capture frame ─────────────────────────────────────────────────────────
  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);

    // Auto-detect document corners
    const detected = detectDocumentCorners(c);
    const valid    = cornersValid(detected, c.width, c.height);
    const finalCorners = valid ? detected : [
      { x: c.width * 0.06,  y: c.height * 0.06  },
      { x: c.width * 0.94,  y: c.height * 0.06  },
      { x: c.width * 0.94,  y: c.height * 0.94  },
      { x: c.width * 0.06,  y: c.height * 0.94  },
    ];

    setCaptured(c);
    setCorners(finalCorners);
    setLiveCorners(null);
    setStep('crop');
  }, []);

  // ── Process: warp + filter + OCR ─────────────────────────────────────────
  const processAndScan = useCallback(async () => {
    if (!captured || !workerRef.current) return;
    setStep('processing');
    setWords([]); setSelectedWord(null);

    try {
      // 1. Perspective warp
      setProcessMsg('Correcting perspective…');
      await sleep(30);
      const warped = perspectiveWarp(captured, corners);

      // 2. Apply display filter
      setProcessMsg('Applying enhancement…');
      await sleep(30);
      const filtered = applyFilter(warped, filter);
      setProcessed(filtered);

      // 3. Prepare image for OCR (separate preprocessing)
      setProcessMsg('Running OCR…');
      setScanning(true);
      const ocrDataUrl = prepareForOCR(warped); // use unfiltered warped for better OCR

      const { data } = await workerRef.current.recognize(ocrDataUrl);

      const detected: DetectedWord[] = (data.words || [])
        .filter((w: any) => w.confidence > 15 && w.text.trim().length > 1)
        .map((w: any) => {
          const rawText = w.text.trim();
          const text    = rawText.replace(/[^a-zA-Z'-]/g, '');
          const meaning = text.length > 1 ? lookupWord(text) : null;
          return {
            text: text || rawText,
            x0: w.bbox.x0, y0: w.bbox.y0,
            x1: w.bbox.x1, y1: w.bbox.y1,
            meaning,
          };
        })
        .filter((w: DetectedWord) => w.text.length > 1);

      const hits = detected.filter(w => w.meaning !== null).length;
      setWords(detected);
      setStatusMsg(detected.length > 0
        ? hits > 0
          ? `${hits} dictionary word${hits !== 1 ? 's' : ''} found — tap to see meaning`
          : `${detected.length} word${detected.length !== 1 ? 's' : ''} detected`
        : 'No text found — try re-capture with better lighting');

    } catch (err) {
      setStatusMsg('Processing failed — try again');
    }

    setScanning(false);
    setStep('results');
  }, [captured, corners, filter, lookupWord]);

  // ── Draw OCR overlay ──────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'results' || !processed || !overlayRef.current || !words.length) return;
    const canvas = overlayRef.current;
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // OCR coords are relative to the WARPED (unfiltered) image. Scale to display.
    // The warp output dimensions may differ from processed (which has same dims as warped).
    const sx = canvas.width  / processed.width;
    const sy = canvas.height / processed.height;

    words.forEach(w => {
      const x  = w.x0*sx, y  = w.y0*sy;
      const bw = (w.x1-w.x0)*sx, bh = (w.y1-w.y0)*sy;
      const inDict = w.meaning !== null;

      ctx.fillStyle   = inDict ? 'rgba(91,132,196,0.22)' : 'rgba(255,255,255,0.06)';
      ctx.strokeStyle = inDict ? accentColor : 'rgba(255,255,255,0.25)';
      ctx.lineWidth   = inDict ? 2 : 1;
      ctx.beginPath(); ctx.roundRect(x-2, y-2, bw+4, bh+4, 4);
      ctx.fill(); ctx.stroke();

      if (inDict) {
        // Underline
        ctx.strokeStyle = accentColor; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(x, y+bh+4); ctx.lineTo(x+bw, y+bh+4); ctx.stroke();

        // Meaning label above the word
        if (w.meaning) {
          const label = w.meaning.length > 30 ? w.meaning.slice(0, 28) + '…' : w.meaning;
          const fs    = Math.max(9, Math.min(13, bh * 0.55));
          ctx.font    = `bold ${fs}px system-ui, sans-serif`;
          const lw    = ctx.measureText(label).width + 10;
          const lh    = fs + 8;
          const lx    = Math.min(Math.max(2, x), canvas.width - lw - 2);
          const ly    = Math.max(lh + 2, y - lh - 4);
          ctx.fillStyle = accentColor;
          ctx.beginPath(); ctx.roundRect(lx, ly, lw, lh, 4); ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3;
          ctx.fillText(label, lx+5, ly+lh-4);
          ctx.shadowBlur = 0;
        }
      }
    });
  }, [step, words, processed, accentColor]);

  // ── Corner drag layout helpers ────────────────────────────────────────────
  const getLayout = useCallback(() => {
    const el = cropContRef.current;
    if (!el || !captured) return null;
    const r = el.getBoundingClientRect();
    const s = Math.min(r.width / captured.width, r.height / captured.height);
    const dW = captured.width * s, dH = captured.height * s;
    return { s, ox: (r.width - dW) / 2, oy: (r.height - dH) / 2, r };
  }, [captured]);

  const imgToScreen = (c: Corner) => {
    const l = getLayout();
    return l ? { x: c.x * l.s + l.ox, y: c.y * l.s + l.oy } : { x: 0, y: 0 };
  };

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragIdx < 0 || !cropContRef.current || !captured) return;
    const l = getLayout();
    if (!l) return;
    setCorners(cs => cs.map((c, i) => i !== dragIdx ? c : {
      x: Math.max(0, Math.min(captured.width,  (e.clientX - l.r.left  - l.ox) / l.s)),
      y: Math.max(0, Math.min(captured.height, (e.clientY - l.r.top - l.oy) / l.s)),
    }));
  }, [dragIdx, getLayout, captured]);

  // ── Overlay click → select word ───────────────────────────────────────────
  const onOverlayClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!processed || !overlayRef.current) return;
    const canvas = overlayRef.current;
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const sx = canvas.width / processed.width, sy = canvas.height / processed.height;
    const hit = words.find(w => {
      const x = w.x0*sx - 8, y = w.y0*sy - 8;
      const bw = (w.x1-w.x0)*sx + 16, bh = (w.y1-w.y0)*sy + 16;
      return cx >= x && cx <= x+bw && cy >= y && cy <= y+bh;
    });
    if (hit) setSelectedWord(hit);
  }, [words, processed]);

  const flipCamera = useCallback(() => {
    const f: 'environment'|'user' = facing === 'environment' ? 'user' : 'environment';
    setFacing(f); startCamera(f);
  }, [facing, startCamera]);

  const reset = useCallback(() => {
    setStep('live'); setCaptured(null); setProcessed(null);
    setCorners([]); setWords([]); setSelectedWord(null);
    setStatusMsg('Align document in the frame, then capture');
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const screenCorners = corners.map(c => imgToScreen(c));

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, backgroundColor: '#000', display: 'flex', flexDirection: 'column', userSelect: 'none' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)', zIndex: 10,
      }}>
        <button onClick={step === 'live' ? onClose : reset} style={btnS}>
          <CloseIcon size={18} color="#fff" />
        </button>
        <div style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>
            {step === 'live' ? 'Document Scanner' : step === 'crop' ? 'Adjust Corners' : step === 'processing' ? 'Processing…' : 'Scan Results'}
          </div>
          <div style={{ fontSize: 11, marginTop: 2, color: scanning ? accentColor : '#999', transition: 'color 0.3s' }}>
            {step === 'processing' ? processMsg : statusMsg}
          </div>
        </div>
        {step === 'live'
          ? <button onClick={flipCamera} style={btnS}><FlipCameraIcon size={20} color="#fff" /></button>
          : <div style={{ width: 44 }} />}
      </div>

      {/* ── Main area ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>

        {/* LIVE VIEW */}
        {step === 'live' && (
          <>
            <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} playsInline muted />
            {/* Live detected quad */}
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              {liveCorners && liveCorners.length === 4 ? (
                <>
                  {/* Semi-transparent mask */}
                  <defs>
                    <mask id="docMask">
                      <rect width="100%" height="100%" fill="white" />
                      <polygon
                        points={(liveCorners as any[]).map((c: any) => `${c.x*100}% ${c.y*100}%`).join(' ')}
                        fill="black"
                      />
                    </mask>
                  </defs>
                  <rect width="100%" height="100%" fill="rgba(0,0,0,0.3)" mask="url(#docMask)" />
                  <polygon
                    points={(liveCorners as any[]).map((c: any) => `${c.x*100}% ${c.y*100}%`).join(' ')}
                    fill="none" stroke={accentColor} strokeWidth="2.5" strokeLinejoin="round"
                  />
                  {(liveCorners as any[]).map((c: any, i: number) => (
                    <circle key={i} cx={`${c.x*100}%`} cy={`${c.y*100}%`} r="6" fill={accentColor} />
                  ))}
                </>
              ) : (
                <>
                  {/* Default guide frame */}
                  <defs>
                    <mask id="guideMask">
                      <rect width="100%" height="100%" fill="white" />
                      <rect x="7%" y="10%" width="86%" height="80%" rx="6" fill="black" />
                    </mask>
                  </defs>
                  <rect width="100%" height="100%" fill="rgba(0,0,0,0.3)" mask="url(#guideMask)" />
                  <rect x="7%" y="10%" width="86%" height="80%" rx="6" fill="none" stroke={accentColor} strokeWidth="2" strokeDasharray="10 6" />
                  {/* Corner brackets */}
                  {([[7,10,1,1],[93,10,-1,1],[93,90,-1,-1],[7,90,1,-1]] as [number,number,number,number][]).map(([cx,cy,dx,dy],i) => (
                    <g key={i}>
                      <line x1={`${cx}%`} y1={`${cy}%`} x2={`${cx+dx*3}%`} y2={`${cy}%`} stroke={accentColor} strokeWidth="3.5" strokeLinecap="round"/>
                      <line x1={`${cx}%`} y1={`${cy}%`} x2={`${cx}%`} y2={`${cy+dy*4}%`} stroke={accentColor} strokeWidth="3.5" strokeLinecap="round"/>
                    </g>
                  ))}
                </>
              )}
            </svg>
            {liveCorners && (
              <div style={{ position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center' }}>
                <span style={{ backgroundColor: accentColor, color: '#fff', fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 20 }}>
                  Document detected ✓
                </span>
              </div>
            )}
          </>
        )}

        {/* CROP: adjust corners */}
        {step === 'crop' && captured && (
          <div
            ref={cropContRef}
            style={{ width: '100%', height: '100%', position: 'relative', touchAction: 'none' }}
            onPointerMove={onPointerMove}
            onPointerUp={() => setDragIdx(-1)}
            onPointerLeave={() => setDragIdx(-1)}
          >
            <img src={captured.toDataURL()} alt="captured"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none' }} />
            {/* Quad overlay + handles */}
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
              {screenCorners.length === 4 && (() => {
                const pts = screenCorners.map(p => `${p.x},${p.y}`).join(' ');
                return (
                  <>
                    <polygon points={pts} fill="rgba(91,132,196,0.18)" stroke={accentColor} strokeWidth="2.5" strokeLinejoin="round" />
                    {screenCorners.map((p, i) => (
                      <g key={i}>
                        <circle cx={p.x} cy={p.y} r="18" fill="transparent"
                          style={{ cursor: 'grab', touchAction: 'none' }}
                          onPointerDown={e => { e.preventDefault(); (e.target as any).setPointerCapture(e.pointerId); setDragIdx(i); }} />
                        <circle cx={p.x} cy={p.y} r="10" fill={accentColor} stroke="#fff" strokeWidth="2.5"
                          style={{ pointerEvents: 'none' }} />
                        <text x={p.x} y={p.y+4} textAnchor="middle" fill="#fff" fontSize="10" fontWeight="bold" style={{ pointerEvents: 'none' }}>
                          {['↖','↗','↘','↙'][i]}
                        </text>
                      </g>
                    ))}
                  </>
                );
              })()}
            </svg>
          </div>
        )}

        {/* PROCESSING */}
        {step === 'processing' && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 20 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', border: `4px solid ${accentColor}`, borderTopColor: 'transparent', animation: 'spin 0.9s linear infinite' }} />
            <div style={{ color: '#bbb', fontSize: 15 }}>{processMsg}</div>
          </div>
        )}

        {/* RESULTS */}
        {step === 'results' && processed && (
          <>
            <img src={processed.toDataURL()} alt="scanned"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none' }} />
            <canvas ref={overlayRef} onClick={onOverlayClick}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'pointer' }} />
          </>
        )}
      </div>

      {/* ── Bottom bar ─────────────────────────────────────────────────── */}
      <div style={{ backgroundColor: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(12px)', padding: '14px 20px 28px', zIndex: 10 }}>

        {/* LIVE */}
        {step === 'live' && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 24 }}>
            <div style={{ width: 44 }} />
            <button onClick={captureFrame} disabled={!workerReady}
              style={{
                width: 70, height: 70, borderRadius: '50%', border: `4px solid ${accentColor}`,
                backgroundColor: 'transparent', cursor: workerReady ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: workerReady ? `0 0 18px ${accentColor}66` : 'none',
              }}>
              <div style={{ width: 50, height: 50, borderRadius: '50%', backgroundColor: workerReady ? '#fff' : '#444' }} />
            </button>
            <div style={{ color: '#777', fontSize: 11, textAlign: 'center', width: 44 }}>
              {workerReady ? '' : 'Loading…'}
            </div>
          </div>
        )}

        {/* CROP */}
        {step === 'crop' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 7, justifyContent: 'center', flexWrap: 'wrap' }}>
              {([['enhance','✦ Enhance'],['bw','B & W'],['grayscale','Grayscale'],['original','Original']] as [FilterMode,string][]).map(([m,label]) => (
                <button key={m} onClick={() => setFilter(m)} style={{
                  padding: '7px 16px', borderRadius: 20, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  backgroundColor: filter === m ? accentColor : 'rgba(255,255,255,0.12)',
                  color: filter === m ? '#fff' : '#999', transition: 'all 0.18s',
                }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={reset}
                style={{ ...actionBtnS, flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', color: '#bbb' }}>
                Re-capture
              </button>
              <button onClick={processAndScan}
                style={{ ...actionBtnS, flex: 2, backgroundColor: accentColor, color: '#fff' }}>
                Scan Document →
              </button>
            </div>
          </div>
        )}

        {/* RESULTS */}
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
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={reset}
                  style={{ ...actionBtnS, flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', color: '#ccc' }}>
                  Scan Again
                </button>
                <div style={{ flex: 2, color: '#666', fontSize: 12, textAlign: 'center' }}>
                  {words.length > 0 ? 'Tap any highlighted word for Kurdish meaning' : statusMsg}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

const btnS: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: '#fff', padding: '6px 10px', borderRadius: 8, lineHeight: 1,
};
const actionBtnS: React.CSSProperties = {
  border: 'none', borderRadius: 10, padding: '11px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
};
