import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createWorker, Worker } from 'tesseract.js';
import { CloseIcon, FlipCameraIcon } from './Icons';

// ── Types ─────────────────────────────────────────────────────────────────────

type ScanStep   = 'live' | 'crop' | 'processing' | 'results';
type FilterMode = 'enhance' | 'magic' | 'bw' | 'grayscale' | 'original';
type DocType    = 'document' | 'book' | 'id' | 'receipt';
type ViewMode   = 'image' | 'text';

interface Corner { x: number; y: number; }

interface DetectedWord {
  text: string;
  confidence: number;
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

// ── Image processing ──────────────────────────────────────────────────────────

function scaleCanvas(src: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
  if (src.width <= maxDim && src.height <= maxDim) return src;
  const s = maxDim / Math.max(src.width, src.height);
  const c = document.createElement('canvas');
  c.width = src.width * s | 0; c.height = src.height * s | 0;
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function rotateCanvas(src: HTMLCanvasElement, deg: 90 | -90 | 180): HTMLCanvasElement {
  const rad = deg * Math.PI / 180;
  const sin = Math.abs(Math.sin(rad)), cos = Math.abs(Math.cos(rad));
  const c = document.createElement('canvas');
  c.width  = (src.width * cos + src.height * sin) | 0;
  c.height = (src.width * sin + src.height * cos) | 0;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function detectDocumentCorners(canvas: HTMLCanvasElement): Corner[] {
  const small = scaleCanvas(canvas, 480);
  const w = small.width, h = small.height;
  const invS = canvas.width / w;
  const ctx = small.getContext('2d')!;
  const d = ctx.getImageData(0, 0, w, h).data;

  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    g[i] = (d[i*4]*77 + d[i*4+1]*150 + d[i*4+2]*29) >> 8;

  const e = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = (-g[(y-1)*w+x-1] + g[(y-1)*w+x+1] - 2*g[y*w+x-1] + 2*g[y*w+x+1] - g[(y+1)*w+x-1] + g[(y+1)*w+x+1]);
      const gy = (-g[(y-1)*w+x-1] - 2*g[(y-1)*w+x] - g[(y-1)*w+x+1] + g[(y+1)*w+x-1] + 2*g[(y+1)*w+x] + g[(y+1)*w+x+1]);
      e[y*w+x] = Math.min(255, Math.sqrt(gx*gx + gy*gy) | 0);
    }
  }

  let sum = 0, sumSq = 0, cnt = 0;
  for (let i = 0; i < e.length; i++) { if (e[i] > 0) { sum += e[i]; sumSq += e[i]*e[i]; cnt++; } }
  const mean = cnt ? sum / cnt : 80;
  const std  = cnt ? Math.sqrt(Math.max(0, sumSq / cnt - mean * mean)) : 40;
  const thresh = Math.max(40, mean + std * 0.4);

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
  const pad = 0.015, px = w*pad, py = h*pad;
  const sc = (c: Corner, dx: number, dy: number): Corner =>
    ({ x: Math.max(0, Math.min(canvas.width,  (c.x+dx)*invS)),
       y: Math.max(0, Math.min(canvas.height, (c.y+dy)*invS)) });
  return [sc(tl,-px,-py), sc(tr,px,-py), sc(br,px,py), sc(bl,-px,py)];
}

function cornersValid(cs: Corner[], w: number, h: number): boolean {
  if (cs.length !== 4) return false;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i+1) % 4;
    area += cs[i].x * cs[j].y - cs[j].x * cs[i].y;
  }
  return Math.abs(area) / 2 > w * h * 0.05;
}

function computeHomography(src: [number,number][], dst: [number,number][]): number[] {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x,y] = src[i], [u,v] = dst[i];
    A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
    A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v);
  }
  const n = 8, M = A.map((row,i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let mx = col;
    for (let r = col+1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[mx][col])) mx = r;
    [M[col],M[mx]] = [M[mx],M[col]];
    const piv = M[col][col];
    if (Math.abs(piv) < 1e-10) continue;
    for (let j = col; j <= n; j++) M[col][j] /= piv;
    for (let r = 0; r < n; r++) { if (r===col) continue; const f=M[r][col]; for (let j=col;j<=n;j++) M[r][j]-=f*M[col][j]; }
  }
  return [...M.map(r => r[n]), 1];
}

function perspectiveWarp(src: HTMLCanvasElement, corners: Corner[]): HTMLCanvasElement {
  const d01 = Math.hypot(corners[1].x-corners[0].x, corners[1].y-corners[0].y);
  const d32 = Math.hypot(corners[2].x-corners[3].x, corners[2].y-corners[3].y);
  const d03 = Math.hypot(corners[3].x-corners[0].x, corners[3].y-corners[0].y);
  const d12 = Math.hypot(corners[2].x-corners[1].x, corners[2].y-corners[1].y);
  const outW = Math.round(Math.max(d01,d32)), outH = Math.round(Math.max(d03,d12));
  const dst = document.createElement('canvas');
  dst.width = Math.max(outW,1); dst.height = Math.max(outH,1);
  const dstPts: [number,number][] = [[0,0],[outW,0],[outW,outH],[0,outH]];
  const srcPts: [number,number][] = corners.map(c => [c.x,c.y] as [number,number]);
  const H = computeHomography(dstPts, srcPts);
  const sd = src.getContext('2d')!.getImageData(0, 0, src.width, src.height).data;
  const di = dst.getContext('2d')!.createImageData(dst.width, dst.height);
  const dd = di.data;
  const sw = src.width, sh = src.height;
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const den = H[6]*u+H[7]*v+H[8];
      const sx  = (H[0]*u+H[1]*v+H[2])/den, sy = (H[3]*u+H[4]*v+H[5])/den;
      if (sx<0||sx>=sw-1||sy<0||sy>=sh-1) continue;
      const x0=sx|0, y0=sy|0, fx=sx-x0, fy=sy-y0;
      const i00=(y0*sw+x0)*4, i10=i00+4, i01=i00+sw*4, i11=i01+4, dp=(v*outW+u)*4;
      for (let c=0;c<3;c++) dd[dp+c]=(sd[i00+c]*(1-fx)*(1-fy)+sd[i10+c]*fx*(1-fy)+sd[i01+c]*(1-fx)*fy+sd[i11+c]*fx*fy)|0;
      dd[dp+3]=255;
    }
  }
  dst.getContext('2d')!.putImageData(di, 0, 0);
  return dst;
}

const FILTER_CSS: Record<FilterMode, (b: number, c: number) => string> = {
  enhance:  (b,c) => `contrast(${c*1.7}) brightness(${b*1.05}) saturate(0.4)`,
  magic:    (b,c) => `contrast(${c*1.4}) brightness(${b*1.1}) saturate(1.3)`,
  bw:       (b,c) => `grayscale(1) contrast(${c*1.8}) brightness(${b*1.05})`,
  grayscale:(b,c) => `grayscale(1) contrast(${c*1.2}) brightness(${b})`,
  original: (b,c) => `brightness(${b}) contrast(${c})`,
};

function applyFilter(src: HTMLCanvasElement, mode: FilterMode, brightness=1.0, contrast=1.0): HTMLCanvasElement {
  const dst = document.createElement('canvas');
  dst.width = src.width; dst.height = src.height;
  const ctx = dst.getContext('2d')!;
  ctx.filter = FILTER_CSS[mode](brightness, contrast);
  ctx.drawImage(src, 0, 0);
  return dst;
}

function prepareForOCR(src: HTMLCanvasElement): string {
  const scaled = scaleCanvas(src, 1500);
  const c = document.createElement('canvas');
  c.width = scaled.width; c.height = scaled.height;
  const ctx = c.getContext('2d')!;
  ctx.filter = 'grayscale(1) contrast(1.4) brightness(1.08)';
  ctx.drawImage(scaled, 0, 0);
  ctx.filter = 'none';
  return c.toDataURL('image/png');
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CameraScanner({ onTextDetected, onClose, lookupWord, accentColor }: Props) {

  // Refs
  const videoRef      = useRef<HTMLVideoElement>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const workerRef     = useRef<Worker | null>(null);
  const cropContRef   = useRef<HTMLDivElement>(null);
  const overlayRef    = useRef<HTMLCanvasElement>(null);
  const loupeRef      = useRef<HTMLCanvasElement>(null);
  const liveTimerRef  = useRef<number>(0);
  const stableRef     = useRef(0);
  const prevCornerRef = useRef<Corner[] | null>(null);
  const capturedRef   = useRef<HTMLCanvasElement | null>(null); // keep for loupe without state re-render

  // State
  const [step,          setStep]          = useState<ScanStep>('live');
  const [captured,      setCaptured]      = useState<HTMLCanvasElement | null>(null);
  const [processed,     setProcessed]     = useState<HTMLCanvasElement | null>(null);
  const [corners,       setCorners]       = useState<Corner[]>([]);
  const [liveCorners,   setLiveCorners]   = useState<Corner[] | null>(null);
  const [autoProgress,  setAutoProgress]  = useState(0);
  const [filter,        setFilter]        = useState<FilterMode>('enhance');
  const [brightness,    setBrightness]    = useState(1.0);
  const [contrast,      setContrast]      = useState(1.0);
  const [docType,       setDocType]       = useState<DocType>('document');
  const [dragIdx,       setDragIdx]       = useState(-1);
  const [loupeVisible,  setLoupeVisible]  = useState(false);
  const [words,         setWords]         = useState<DetectedWord[]>([]);
  const [allText,       setAllText]       = useState('');
  const [selectedWord,  setSelectedWord]  = useState<DetectedWord | null>(null);
  const [scanning,      setScanning]      = useState(false);
  const [statusMsg,     setStatusMsg]     = useState('Starting camera…');
  const [processStep,   setProcessStep]   = useState(0);
  const [viewMode,      setViewMode]      = useState<ViewMode>('image');
  const [workerReady,   setWorkerReady]   = useState(false);
  const [facing,        setFacing]        = useState<'environment'|'user'>('environment');
  const [torchOn,       setTorchOn]       = useState(false);
  const [torchSupport,  setTorchSupport]  = useState(false);
  const [copied,        setCopied]        = useState(false);
  const [autoCapture,   setAutoCapture]   = useState(true);
  const [thumbnailUrl,  setThumbnailUrl]  = useState('');

  // ── Camera ──────────────────────────────────────────────────────────────
  const startCamera = useCallback(async (f: 'environment'|'user') => {
    clearInterval(liveTimerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: f, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = s;
      const track = s.getVideoTracks()[0];
      const caps = track.getCapabilities?.() as any;
      setTorchSupport(!!(caps?.torch));
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        try { await videoRef.current.play(); } catch(e: any) { if (e.name !== 'AbortError') throw e; }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setStatusMsg(err.name === 'NotAllowedError' ? 'Camera access denied' : 'Camera error');
    }
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
      setTorchOn(next);
    } catch {}
  }, [torchOn]);

  // ── Init ────────────────────────────────────────────────────────────────
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
        setStatusMsg('Align document, then capture');
      } catch { if (mounted) setStatusMsg('OCR engine failed'); }
    })();
    return () => {
      mounted = false;
      clearInterval(liveTimerRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // ── Live edge detection + auto-capture ──────────────────────────────────
  useEffect(() => {
    if (step !== 'live') { clearInterval(liveTimerRef.current); return; }
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      const tmp = document.createElement('canvas');
      tmp.width = video.videoWidth; tmp.height = video.videoHeight;
      tmp.getContext('2d')!.drawImage(video, 0, 0);
      const detected = detectDocumentCorners(tmp);
      const valid = cornersValid(detected, tmp.width, tmp.height);
      if (valid) {
        const prev = prevCornerRef.current;
        const stable = prev && detected.every((c,i) =>
          Math.hypot(c.x-prev[i].x, c.y-prev[i].y) < tmp.width * 0.04);
        if (stable) {
          stableRef.current = Math.min(stableRef.current + 1, 3);
          setAutoProgress(Math.min(100, stableRef.current * 34));
          if (stableRef.current >= 3 && autoCapture) {
            // Auto-capture!
            const c2 = document.createElement('canvas');
            c2.width = tmp.width; c2.height = tmp.height;
            c2.getContext('2d')!.drawImage(tmp, 0, 0);
            const finalCorners = cornersValid(detected, c2.width, c2.height) ? detected : [
              {x:c2.width*0.06,y:c2.height*0.06},{x:c2.width*0.94,y:c2.height*0.06},
              {x:c2.width*0.94,y:c2.height*0.94},{x:c2.width*0.06,y:c2.height*0.94},
            ];
            capturedRef.current = c2;
            setCaptured(c2);
            setCorners(finalCorners);
            setThumbnailUrl(scaleCanvas(c2, 300).toDataURL());
            setLiveCorners(null);
            setAutoProgress(0);
            stableRef.current = 0;
            prevCornerRef.current = null;
            setStep('crop');
            clearInterval(id);
            return;
          }
        } else {
          stableRef.current = 0;
          setAutoProgress(0);
        }
        prevCornerRef.current = detected;
        setLiveCorners(detected.map(c => ({ x: c.x/tmp.width, y: c.y/tmp.height })));
      } else {
        stableRef.current = 0;
        setAutoProgress(0);
        prevCornerRef.current = null;
        setLiveCorners(null);
      }
    }, 900);
    liveTimerRef.current = id;
    return () => clearInterval(id);
  }, [step, autoCapture]);

  // ── Capture frame ────────────────────────────────────────────────────────
  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d')!.drawImage(video, 0, 0);
    const detected = detectDocumentCorners(c);
    const valid = cornersValid(detected, c.width, c.height);
    const finalCorners = valid ? detected : [
      {x:c.width*0.06,y:c.height*0.06},{x:c.width*0.94,y:c.height*0.06},
      {x:c.width*0.94,y:c.height*0.94},{x:c.width*0.06,y:c.height*0.94},
    ];
    capturedRef.current = c;
    setCaptured(c);
    setCorners(finalCorners);
    setThumbnailUrl(scaleCanvas(c, 300).toDataURL());
    setLiveCorners(null);
    setAutoProgress(0);
    stableRef.current = 0;
    setStep('crop');
  }, []);

  // ── Rotate captured image ────────────────────────────────────────────────
  const rotateCaptured = useCallback((deg: 90 | -90) => {
    const c = capturedRef.current;
    if (!c) return;
    const rotated = rotateCanvas(c, deg);
    capturedRef.current = rotated;
    setCaptured(rotated);
    setThumbnailUrl(scaleCanvas(rotated, 300).toDataURL());
    const detected = detectDocumentCorners(rotated);
    const valid = cornersValid(detected, rotated.width, rotated.height);
    setCorners(valid ? detected : [
      {x:rotated.width*0.06,y:rotated.height*0.06},{x:rotated.width*0.94,y:rotated.height*0.06},
      {x:rotated.width*0.94,y:rotated.height*0.94},{x:rotated.width*0.06,y:rotated.height*0.94},
    ]);
  }, []);

  const reDetectCorners = useCallback(() => {
    const c = capturedRef.current;
    if (!c) return;
    const detected = detectDocumentCorners(c);
    const valid = cornersValid(detected, c.width, c.height);
    setCorners(valid ? detected : [
      {x:c.width*0.06,y:c.height*0.06},{x:c.width*0.94,y:c.height*0.06},
      {x:c.width*0.94,y:c.height*0.94},{x:c.width*0.06,y:c.height*0.94},
    ]);
  }, []);

  // ── Process + OCR ────────────────────────────────────────────────────────
  const processAndScan = useCallback(async () => {
    if (!captured || !workerRef.current) return;
    setStep('processing');
    setWords([]); setAllText(''); setSelectedWord(null); setViewMode('image');

    try {
      setProcessStep(0); await sleep(80);
      const warped = perspectiveWarp(captured, corners);

      setProcessStep(1); await sleep(80);
      const filtered = applyFilter(warped, filter, brightness, contrast);
      setProcessed(filtered);

      setProcessStep(2);
      setScanning(true);
      const ocrUrl = prepareForOCR(warped);
      const { data } = await workerRef.current.recognize(ocrUrl);

      setProcessStep(3);
      const rawText: string = data.text || '';
      setAllText(rawText);

      const detected: DetectedWord[] = (data.words || [])
        .filter((w: any) => w.confidence > 15 && w.text.trim().length > 1)
        .map((w: any) => {
          const text    = w.text.trim().replace(/[^a-zA-Z'-]/g, '');
          const meaning = text.length > 1 ? lookupWord(text) : null;
          return { text: text || w.text.trim(), confidence: w.confidence,
                   x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, meaning };
        })
        .filter((w: DetectedWord) => w.text.length > 1);

      const hits = detected.filter(w => w.meaning !== null).length;
      setWords(detected);
      setStatusMsg(detected.length > 0
        ? hits > 0 ? `${hits} dictionary word${hits!==1?'s':''} found — tap to see Kurdish meaning`
                   : `${detected.length} word${detected.length!==1?'s':''} detected`
        : 'No text found — try Enhance filter or better lighting');
    } catch {
      setStatusMsg('Processing failed — try again');
    }
    setScanning(false);
    setStep('results');
  }, [captured, corners, filter, brightness, contrast, lookupWord]);

  // ── OCR word overlay ─────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'results' || !processed || !overlayRef.current || !words.length) return;
    const canvas = overlayRef.current;
    canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sx = canvas.width / processed.width, sy = canvas.height / processed.height;
    words.forEach(w => {
      const x = w.x0*sx, y = w.y0*sy, bw = (w.x1-w.x0)*sx, bh = (w.y1-w.y0)*sy;
      const inDict = w.meaning !== null;
      const conf   = w.confidence / 100;
      ctx.fillStyle   = inDict ? `rgba(91,132,196,${0.15+conf*0.1})` : `rgba(255,255,255,${conf*0.06})`;
      ctx.strokeStyle = inDict ? accentColor : `rgba(255,255,255,${conf*0.3})`;
      ctx.lineWidth   = inDict ? 2 : 1;
      ctx.beginPath(); ctx.roundRect(x-2, y-2, bw+4, bh+4, 4); ctx.fill(); ctx.stroke();
      if (inDict) {
        ctx.strokeStyle = accentColor; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(x, y+bh+4); ctx.lineTo(x+bw, y+bh+4); ctx.stroke();
        if (w.meaning) {
          const label = w.meaning.length > 30 ? w.meaning.slice(0, 28) + '…' : w.meaning;
          const fs = Math.max(9, Math.min(13, bh * 0.55));
          ctx.font = `bold ${fs}px system-ui, sans-serif`;
          const lw = ctx.measureText(label).width + 10, lh = fs + 8;
          const lx = Math.min(Math.max(2, x), canvas.width - lw - 2);
          const ly = Math.max(lh + 2, y - lh - 4);
          ctx.fillStyle = accentColor;
          ctx.beginPath(); ctx.roundRect(lx, ly, lw, lh, 4); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3;
          ctx.fillText(label, lx+5, ly+lh-4); ctx.shadowBlur = 0;
        }
      }
    });
  }, [step, words, processed, accentColor]);

  // ── Corner drag layout ───────────────────────────────────────────────────
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

  // Draw loupe magnifier
  const drawLoupe = useCallback((imgX: number, imgY: number) => {
    const loupeCvs = loupeRef.current;
    const cap = capturedRef.current;
    if (!loupeCvs || !cap) return;
    const ctx = loupeCvs.getContext('2d')!;
    const size = loupeCvs.width;
    const zoom = 3;
    const srcSize = size / zoom;
    ctx.clearRect(0, 0, size, size);
    // Circular clip
    ctx.save();
    ctx.beginPath(); ctx.arc(size/2, size/2, size/2 - 2, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(cap,
      imgX - srcSize/2, imgY - srcSize/2, srcSize, srcSize,
      0, 0, size, size);
    ctx.restore();
    // Crosshair
    ctx.strokeStyle = accentColor; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(size/2, size/2-12); ctx.lineTo(size/2, size/2+12); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(size/2-12, size/2); ctx.lineTo(size/2+12, size/2); ctx.stroke();
    // Border
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(size/2, size/2, size/2 - 2, 0, Math.PI * 2); ctx.stroke();
  }, [accentColor]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragIdx < 0 || !captured) return;
    const l = getLayout();
    if (!l) return;
    const imgX = Math.max(0, Math.min(captured.width,  (e.clientX - l.r.left - l.ox) / l.s));
    const imgY = Math.max(0, Math.min(captured.height, (e.clientY - l.r.top  - l.oy) / l.s));
    setCorners(cs => cs.map((c,i) => i !== dragIdx ? c : { x: imgX, y: imgY }));
    drawLoupe(imgX, imgY);
  }, [dragIdx, getLayout, captured, drawLoupe]);

  // ── Overlay click ────────────────────────────────────────────────────────
  const onOverlayClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!processed || !overlayRef.current) return;
    const canvas = overlayRef.current;
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const sx = canvas.width / processed.width, sy = canvas.height / processed.height;
    const hit = words.find(w => {
      const x = w.x0*sx - 8, y = w.y0*sy - 8;
      return cx >= x && cx <= x+(w.x1-w.x0)*sx+16 && cy >= y && cy <= y+(w.y1-w.y0)*sy+16;
    });
    if (hit) setSelectedWord(hit);
  }, [words, processed]);

  // ── Copy text ────────────────────────────────────────────────────────────
  const copyText = useCallback(async () => {
    if (!allText) return;
    try { await navigator.clipboard.writeText(allText); } catch { /* fallback */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [allText]);

  // ── Download scan ────────────────────────────────────────────────────────
  const downloadScan = useCallback(() => {
    if (!processed) return;
    const link = document.createElement('a');
    link.href = processed.toDataURL('image/jpeg', 0.95);
    link.download = `scan_${Date.now()}.jpg`;
    link.click();
  }, [processed]);

  const flipCamera = useCallback(() => {
    const f: 'environment'|'user' = facing === 'environment' ? 'user' : 'environment';
    setFacing(f); startCamera(f);
  }, [facing, startCamera]);

  const reset = useCallback(() => {
    setStep('live'); setCaptured(null); setProcessed(null);
    setCorners([]); setWords([]); setAllText(''); setSelectedWord(null);
    setAutoProgress(0); stableRef.current = 0;
    setStatusMsg('Align document, then capture');
  }, []);

  // ── Computed values ──────────────────────────────────────────────────────
  const screenCorners = corners.map(c => imgToScreen(c));
  const dictHits      = words.filter(w => w.meaning !== null).length;

  // ── Loupe position: upper-left or upper-right depending on dragged corner ──
  const loupeQuadrant = dragIdx >= 0 ? dragIdx : -1;
  const loupeRight    = loupeQuadrant === 1 || loupeQuadrant === 2;
  const loupeBottom   = loupeQuadrant === 2 || loupeQuadrant === 3;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ position:'fixed', inset:0, zIndex:9999, backgroundColor:'#000', display:'flex', flexDirection:'column', userSelect:'none', WebkitUserSelect:'none' }}>

      {/* ─── Header ──────────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 14px', backgroundColor:'rgba(0,0,0,0.88)', backdropFilter:'blur(10px)', zIndex:10 }}>
        <button onClick={step === 'live' ? onClose : reset} style={btnS}><CloseIcon size={18} color="#fff" /></button>
        <div style={{ flex:1, textAlign:'center' }}>
          <div style={{ color:'#fff', fontWeight:700, fontSize:15, letterSpacing:0.2 }}>
            {step==='live' ? 'Document Scanner' : step==='crop' ? 'Adjust & Filter' : step==='processing' ? 'Processing…' : 'Scan Results'}
          </div>
          <div style={{ fontSize:11, marginTop:1, color: scanning ? accentColor : '#888', transition:'color 0.3s' }}>
            {step==='processing'
              ? ['Correcting perspective…','Applying filter…','Running OCR…','Building word map…'][processStep]
              : statusMsg}
          </div>
        </div>
        {step === 'live' ? (
          <div style={{ display:'flex', gap:4 }}>
            {torchSupport && (
              <button onClick={toggleTorch} style={{ ...btnS, color: torchOn ? '#FFD700' : '#fff' }}>
                ⚡
              </button>
            )}
            <button onClick={flipCamera} style={btnS}><FlipCameraIcon size={20} color="#fff" /></button>
          </div>
        ) : step === 'crop' ? (
          <div style={{ display:'flex', gap:6 }}>
            <button onClick={reDetectCorners} title="Auto-detect corners" style={{ ...btnS, fontSize:17 }}>⌖</button>
          </div>
        ) : step === 'results' ? (
          <button onClick={downloadScan} style={{ ...btnS, fontSize:11, color: accentColor, fontWeight:700 }}>↓ JPG</button>
        ) : <div style={{ width:44 }} />}
      </div>

      {/* ─── Main area ───────────────────────────────────────────────── */}
      <div style={{ flex:1, position:'relative', overflow:'hidden' }}>

        {/* LIVE VIEW */}
        {step === 'live' && (
          <>
            <video ref={videoRef} style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} playsInline muted />
            <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none' }}>
              {liveCorners && liveCorners.length === 4 ? (
                <>
                  <defs>
                    <mask id="liveMask">
                      <rect width="100%" height="100%" fill="white" />
                      <polygon points={(liveCorners as any[]).map((c:any) => `${c.x*100}% ${c.y*100}%`).join(' ')} fill="black" />
                    </mask>
                  </defs>
                  <rect width="100%" height="100%" fill="rgba(0,0,0,0.28)" mask="url(#liveMask)" />
                  <polygon points={(liveCorners as any[]).map((c:any) => `${c.x*100}% ${c.y*100}%`).join(' ')}
                    fill="none" stroke={accentColor} strokeWidth="2.5" strokeLinejoin="round" />
                  {(liveCorners as any[]).map((c:any, i:number) => (
                    <circle key={i} cx={`${c.x*100}%`} cy={`${c.y*100}%`} r="5" fill={accentColor} />
                  ))}
                </>
              ) : (
                <>
                  <defs>
                    <mask id="guideMask">
                      <rect width="100%" height="100%" fill="white" />
                      <rect x="7%" y="9%" width="86%" height="82%" rx="8" fill="black" />
                    </mask>
                  </defs>
                  <rect width="100%" height="100%" fill="rgba(0,0,0,0.28)" mask="url(#guideMask)" />
                  <rect x="7%" y="9%" width="86%" height="82%" rx="8" fill="none" stroke={accentColor} strokeWidth="1.5" strokeDasharray="12 7" />
                  {([[7,9,1,1],[93,9,-1,1],[93,91,-1,-1],[7,91,1,-1]] as [number,number,number,number][]).map(([cx,cy,dx,dy],i) => (
                    <g key={i}>
                      <line x1={`${cx}%`} y1={`${cy}%`} x2={`${cx+dx*3.5}%`} y2={`${cy}%`} stroke={accentColor} strokeWidth="3.5" strokeLinecap="round"/>
                      <line x1={`${cx}%`} y1={`${cy}%`} x2={`${cx}%`} y2={`${cy+dy*4.5}%`} stroke={accentColor} strokeWidth="3.5" strokeLinecap="round"/>
                    </g>
                  ))}
                </>
              )}
            </svg>

            {/* Auto-capture ring + badge */}
            {liveCorners && (
              <div style={{ position:'absolute', top:14, left:0, right:0, display:'flex', justifyContent:'center', gap:10, alignItems:'center' }}>
                <div style={{ position:'relative', width:28, height:28 }}>
                  <svg width="28" height="28" style={{ transform:'rotate(-90deg)' }}>
                    <circle cx="14" cy="14" r="11" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
                    <circle cx="14" cy="14" r="11" fill="none" stroke={accentColor} strokeWidth="3"
                      strokeDasharray={`${autoProgress/100 * 69.1} 69.1`} strokeLinecap="round" />
                  </svg>
                </div>
                <span style={{ backgroundColor: accentColor, color:'#fff', fontSize:12, fontWeight:700, padding:'4px 12px', borderRadius:20 }}>
                  Document detected ✓
                </span>
              </div>
            )}
          </>
        )}

        {/* CROP / ADJUST */}
        {step === 'crop' && captured && (
          <div
            ref={cropContRef}
            style={{ width:'100%', height:'100%', position:'relative', touchAction:'none' }}
            onPointerMove={onPointerMove}
            onPointerUp={() => { setDragIdx(-1); setLoupeVisible(false); }}
            onPointerLeave={() => { setDragIdx(-1); setLoupeVisible(false); }}
          >
            <img src={thumbnailUrl || captured.toDataURL()} alt="captured"
              style={{ width:'100%', height:'100%', objectFit:'contain', display:'block', pointerEvents:'none' }} />

            {/* Quad + handles */}
            <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', overflow:'visible' }}>
              {screenCorners.length === 4 && (() => {
                const pts = screenCorners.map(p => `${p.x},${p.y}`).join(' ');
                return (
                  <>
                    <defs>
                      <filter id="handleShadow">
                        <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="rgba(0,0,0,0.4)" />
                      </filter>
                    </defs>
                    <polygon points={pts} fill="rgba(91,132,196,0.15)" stroke={accentColor} strokeWidth="2.5" strokeLinejoin="round" />
                    {/* Edge midpoint dots */}
                    {screenCorners.map((p, i) => {
                      const q = screenCorners[(i+1)%4];
                      return <circle key={`m${i}`} cx={(p.x+q.x)/2} cy={(p.y+q.y)/2} r="4" fill={accentColor} opacity="0.5" />;
                    })}
                    {/* Corner handles */}
                    {screenCorners.map((p, i) => (
                      <g key={i}>
                        <circle cx={p.x} cy={p.y} r="22" fill="transparent" style={{ cursor:'grab', touchAction:'none' }}
                          onPointerDown={e => {
                            e.preventDefault();
                            (e.target as any).setPointerCapture(e.pointerId);
                            setDragIdx(i);
                            setLoupeVisible(true);
                            drawLoupe(corners[i].x, corners[i].y);
                          }} />
                        <circle cx={p.x} cy={p.y} r="11" fill={accentColor} stroke="#fff" strokeWidth="2.5"
                          filter="url(#handleShadow)" style={{ pointerEvents:'none' }} />
                        <text x={p.x} y={p.y+5} textAnchor="middle" fill="#fff" fontSize="11" fontWeight="bold" style={{ pointerEvents:'none' }}>
                          {['↖','↗','↘','↙'][i]}
                        </text>
                      </g>
                    ))}
                  </>
                );
              })()}
            </svg>

            {/* Loupe magnifier */}
            {loupeVisible && (
              <canvas ref={loupeRef} width={130} height={130}
                style={{
                  position:'absolute', borderRadius:'50%',
                  boxShadow:'0 4px 20px rgba(0,0,0,0.5)',
                  [loupeRight ? 'right' : 'left']: 20,
                  [loupeBottom ? 'bottom' : 'top']: 20,
                  pointerEvents:'none',
                }} />
            )}
          </div>
        )}

        {/* PROCESSING */}
        {step === 'processing' && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', flexDirection:'column', gap:24 }}>
            <div style={{ width:60, height:60, borderRadius:'50%', border:`4px solid ${accentColor}`, borderTopColor:'transparent', animation:'spin 0.9s linear infinite' }} />
            <div style={{ display:'flex', gap:20 }}>
              {['Warp','Filter','OCR','Map'].map((label, i) => (
                <div key={i} style={{ textAlign:'center', opacity: i <= processStep ? 1 : 0.3, transition:'opacity 0.3s' }}>
                  <div style={{ width:32, height:32, borderRadius:'50%', border:`2px solid ${accentColor}`, backgroundColor: i < processStep ? accentColor : i === processStep ? 'rgba(91,132,196,0.3)' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 4px', transition:'all 0.3s' }}>
                    <span style={{ color: i < processStep ? '#fff' : accentColor, fontSize:13, fontWeight:700 }}>{i < processStep ? '✓' : i+1}</span>
                  </div>
                  <div style={{ color: i <= processStep ? '#ddd' : '#555', fontSize:10 }}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* RESULTS */}
        {step === 'results' && processed && (
          <>
            {/* View toggle tabs */}
            <div style={{ position:'absolute', top:0, left:0, right:0, zIndex:5, display:'flex', backgroundColor:'rgba(0,0,0,0.7)', backdropFilter:'blur(8px)' }}>
              {(['image','text'] as ViewMode[]).map(m => (
                <button key={m} onClick={() => setViewMode(m)} style={{
                  flex:1, padding:'9px 0', border:'none', cursor:'pointer', fontSize:13, fontWeight:700,
                  backgroundColor: viewMode===m ? accentColor : 'transparent',
                  color: viewMode===m ? '#fff' : '#777', transition:'all 0.2s',
                }}>
                  {m === 'image' ? '🖼 Image' : '📄 Text'}
                  {m === 'image' && words.length > 0 && (
                    <span style={{ marginLeft:6, backgroundColor:'rgba(255,255,255,0.2)', borderRadius:10, padding:'1px 7px', fontSize:10 }}>
                      {dictHits > 0 ? `${dictHits} words` : words.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {viewMode === 'image' ? (
              <>
                <img src={processed.toDataURL()} alt="scanned"
                  style={{ width:'100%', height:'100%', objectFit:'contain', display:'block', pointerEvents:'none', paddingTop:36 }} />
                <canvas ref={overlayRef} onClick={onOverlayClick}
                  style={{ position:'absolute', inset:0, width:'100%', height:'100%', cursor:'pointer', top:36 }} />
              </>
            ) : (
              <div style={{ position:'absolute', inset:0, top:36, overflowY:'auto', padding:'16px', backgroundColor:'rgba(10,10,20,0.97)', lineHeight:1.8 }}>
                {allText ? allText.split('\n').map((line, li) => (
                  <div key={li} style={{ color:'#e0e0e0', fontSize:14, marginBottom:4, fontFamily:'monospace' }}>
                    {line.split(/(\s+)/).map((tok, ti) => {
                      const clean = tok.replace(/[^a-zA-Z'-]/g,'');
                      const meaning = clean.length > 1 ? lookupWord(clean) : null;
                      return meaning
                        ? <span key={ti} onClick={() => setSelectedWord({ text:clean, confidence:90, x0:0,y0:0,x1:0,y1:0, meaning })}
                            style={{ backgroundColor:`${accentColor}33`, color:accentColor, borderRadius:3, padding:'0 2px', cursor:'pointer', textDecoration:'underline' }}>
                            {tok}
                          </span>
                        : <span key={ti}>{tok}</span>;
                    })}
                  </div>
                )) : <div style={{ color:'#555', textAlign:'center', marginTop:60 }}>No text recognized</div>}
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── Bottom bar ──────────────────────────────────────────────── */}
      <div style={{ backgroundColor:'rgba(0,0,0,0.92)', backdropFilter:'blur(12px)', padding:'12px 16px 26px', zIndex:10 }}>

        {/* LIVE */}
        {step === 'live' && (
          <>
            {/* Doc type chips */}
            <div style={{ display:'flex', gap:6, justifyContent:'center', marginBottom:12 }}>
              {([['document','📄 Doc'],['book','📚 Book'],['id','🪪 ID'],['receipt','🧾 Receipt']] as [DocType,string][]).map(([type,label]) => (
                <button key={type} onClick={() => setDocType(type)} style={{
                  padding:'5px 12px', borderRadius:16, border:'none', fontSize:11, fontWeight:700, cursor:'pointer',
                  backgroundColor: docType===type ? accentColor : 'rgba(255,255,255,0.1)',
                  color: docType===type ? '#fff' : '#888', transition:'all 0.18s',
                }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ display:'flex', justifyContent:'center', alignItems:'center', gap:28 }}>
              {/* Auto toggle */}
              <button onClick={() => setAutoCapture(a => !a)} style={{ ...btnS, display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                <span style={{ fontSize:20 }}>{autoCapture ? '🤖' : '👆'}</span>
                <span style={{ fontSize:9, color: autoCapture ? accentColor : '#666' }}>{autoCapture ? 'AUTO' : 'MANUAL'}</span>
              </button>
              {/* Capture button */}
              <button onClick={captureFrame} disabled={!workerReady} style={{
                width:72, height:72, borderRadius:'50%', border:`4px solid ${accentColor}`,
                backgroundColor:'transparent', cursor: workerReady ? 'pointer' : 'not-allowed',
                display:'flex', alignItems:'center', justifyContent:'center',
                boxShadow: workerReady ? `0 0 20px ${accentColor}55` : 'none', transition:'all 0.2s',
              }}>
                <div style={{ width:52, height:52, borderRadius:'50%', backgroundColor: workerReady ? '#fff' : '#444' }} />
              </button>
              {/* Torch button */}
              {torchSupport
                ? <button onClick={toggleTorch} style={{ ...btnS, display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                    <span style={{ fontSize:20 }}>🔦</span>
                    <span style={{ fontSize:9, color: torchOn ? '#FFD700' : '#666' }}>{torchOn ? 'ON' : 'OFF'}</span>
                  </button>
                : <div style={{ width:44 }} />}
            </div>
          </>
        )}

        {/* CROP */}
        {step === 'crop' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {/* Filter chips */}
            <div style={{ display:'flex', gap:6, justifyContent:'center', flexWrap:'wrap' }}>
              {([['enhance','✦ Enhance'],['magic','✨ Magic'],['bw','B & W'],['grayscale','Gray'],['original','Original']] as [FilterMode,string][]).map(([m,label]) => (
                <button key={m} onClick={() => setFilter(m)} style={{
                  padding:'6px 13px', borderRadius:18, border:'none', fontSize:12, fontWeight:700, cursor:'pointer',
                  backgroundColor: filter===m ? accentColor : 'rgba(255,255,255,0.1)',
                  color: filter===m ? '#fff' : '#888', transition:'all 0.18s',
                }}>
                  {label}
                </button>
              ))}
            </div>
            {/* Brightness slider */}
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ fontSize:15 }}>☀️</span>
              <span style={{ color:'#666', fontSize:11, width:60 }}>Brightness</span>
              <input type="range" min="0.5" max="1.6" step="0.05" value={brightness}
                onChange={e => setBrightness(parseFloat(e.target.value))}
                style={{ flex:1, accentColor }} />
              <span style={{ color:'#888', fontSize:11, width:28, textAlign:'right' }}>{brightness.toFixed(1)}×</span>
            </div>
            {/* Contrast slider */}
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ fontSize:15 }}>◑</span>
              <span style={{ color:'#666', fontSize:11, width:60 }}>Contrast</span>
              <input type="range" min="0.5" max="2.2" step="0.05" value={contrast}
                onChange={e => setContrast(parseFloat(e.target.value))}
                style={{ flex:1, accentColor }} />
              <span style={{ color:'#888', fontSize:11, width:28, textAlign:'right' }}>{contrast.toFixed(1)}×</span>
            </div>
            {/* Rotate + Scan */}
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <button onClick={() => rotateCaptured(-90)} style={{ ...actionBtnS, backgroundColor:'rgba(255,255,255,0.1)', color:'#bbb', padding:'10px 14px', fontSize:16 }}>↺</button>
              <button onClick={() => rotateCaptured(90)}  style={{ ...actionBtnS, backgroundColor:'rgba(255,255,255,0.1)', color:'#bbb', padding:'10px 14px', fontSize:16 }}>↻</button>
              <button onClick={reset} style={{ ...actionBtnS, flex:1, backgroundColor:'rgba(255,255,255,0.08)', color:'#bbb' }}>Re-capture</button>
              <button onClick={processAndScan} style={{ ...actionBtnS, flex:2, backgroundColor:accentColor, color:'#fff' }}>Scan →</button>
            </div>
          </div>
        )}

        {/* RESULTS */}
        {step === 'results' && (
          <div style={{ display:'flex', flexDirection:'column', gap:9 }}>
            {selectedWord ? (
              <>
                <div style={{ backgroundColor:'rgba(91,132,196,0.15)', border:`1.5px solid ${accentColor}`, borderRadius:12, padding:'10px 14px', display:'flex', flexDirection:'column', gap:4 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <span style={{ color:'#fff', fontSize:17, fontWeight:700 }}>{selectedWord.text}</span>
                    <span style={{ color:'#555', fontSize:10 }}>{selectedWord.confidence|0}% confidence</span>
                  </div>
                  {selectedWord.meaning
                    ? <div style={{ color:accentColor, fontSize:14, direction:'rtl', textAlign:'right', lineHeight:1.6 }}>{selectedWord.meaning}</div>
                    : <div style={{ color:'#666', fontSize:13 }}>Not in dictionary</div>}
                </div>
                <div style={{ display:'flex', gap:7 }}>
                  <button onClick={() => setSelectedWord(null)} style={{ ...actionBtnS, flex:1, backgroundColor:'rgba(255,255,255,0.08)', color:'#aaa' }}>Close</button>
                  <button onClick={() => { onTextDetected(selectedWord.text); onClose(); }}
                    style={{ ...actionBtnS, flex:2, backgroundColor:accentColor, color:'#fff' }}>Open in Dictionary →</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display:'flex', gap:7, alignItems:'center' }}>
                  <div style={{ flex:1, fontSize:11, color:'#666', lineHeight:1.4 }}>
                    {words.length > 0
                      ? `${words.length} words detected${dictHits>0 ? `, ${dictHits} in dictionary` : ''}`
                      : 'No text detected'}
                  </div>
                </div>
                <div style={{ display:'flex', gap:7 }}>
                  <button onClick={reset} style={{ ...actionBtnS, flex:1, backgroundColor:'rgba(255,255,255,0.08)', color:'#aaa' }}>Scan Again</button>
                  {allText && (
                    <button onClick={copyText} style={{ ...actionBtnS, flex:1, backgroundColor: copied ? '#2a7a2a' : 'rgba(255,255,255,0.1)', color: copied ? '#fff' : '#aaa', transition:'all 0.3s' }}>
                      {copied ? '✓ Copied' : '📋 Copy Text'}
                    </button>
                  )}
                  <button onClick={downloadScan} style={{ ...actionBtnS, flex:1, backgroundColor:accentColor, color:'#fff' }}>↓ Save</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

const btnS: React.CSSProperties = { background:'none', border:'none', cursor:'pointer', color:'#fff', padding:'6px 10px', borderRadius:8, lineHeight:1 };
const actionBtnS: React.CSSProperties = { border:'none', borderRadius:10, padding:'10px 14px', fontSize:13, fontWeight:700, cursor:'pointer' };
