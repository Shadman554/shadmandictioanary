import React, { useRef, useState, useEffect, useCallback } from 'react';
import { createWorker, Worker } from 'tesseract.js';
import { CloseIcon, FlipCameraIcon } from './Icons';

// ── Types ─────────────────────────────────────────────────────────────────────

type ScanStep   = 'live' | 'crop' | 'processing' | 'results';
type FilterMode = 'enhance' | 'magic' | 'bw' | 'grayscale' | 'original';
type ViewMode   = 'image' | 'text' | 'words';

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

function rotateCanvas(src: HTMLCanvasElement, deg: 90 | -90): HTMLCanvasElement {
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
  const d = small.getContext('2d')!.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    g[i] = (d[i*4]*77 + d[i*4+1]*150 + d[i*4+2]*29) >> 8;
  const e = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = (-g[(y-1)*w+x-1]+g[(y-1)*w+x+1]-2*g[y*w+x-1]+2*g[y*w+x+1]-g[(y+1)*w+x-1]+g[(y+1)*w+x+1]);
      const gy = (-g[(y-1)*w+x-1]-2*g[(y-1)*w+x]-g[(y-1)*w+x+1]+g[(y+1)*w+x-1]+2*g[(y+1)*w+x]+g[(y+1)*w+x+1]);
      e[y*w+x] = Math.min(255, Math.sqrt(gx*gx+gy*gy)|0);
    }
  }
  let sum = 0, sumSq = 0, cnt = 0;
  for (let i = 0; i < e.length; i++) { if (e[i]>0) { sum+=e[i]; sumSq+=e[i]*e[i]; cnt++; } }
  const mean = cnt ? sum/cnt : 80;
  const std  = cnt ? Math.sqrt(Math.max(0, sumSq/cnt - mean*mean)) : 40;
  const thresh = Math.max(40, mean + std*0.4);
  let tlS=Infinity, trS=-Infinity, brS=-Infinity, blS=Infinity;
  let tl={x:w*0.08,y:h*0.08}, tr={x:w*0.92,y:h*0.08}, br={x:w*0.92,y:h*0.92}, bl={x:w*0.08,y:h*0.92};
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    if (e[y*w+x]<thresh) continue;
    const s=x+y, df=x-y;
    if (s<tlS){tlS=s;tl={x,y};} if(df>trS){trS=df;tr={x,y};}
    if (s>brS){brS=s;br={x,y};} if(df<blS){blS=df;bl={x,y};}
  }
  const pad=0.015, px=w*pad, py=h*pad;
  const sc=(c:Corner,dx:number,dy:number):Corner=>({
    x:Math.max(0,Math.min(canvas.width,(c.x+dx)*invS)),
    y:Math.max(0,Math.min(canvas.height,(c.y+dy)*invS))
  });
  return [sc(tl,-px,-py),sc(tr,px,-py),sc(br,px,py),sc(bl,-px,py)];
}

function cornersValid(cs: Corner[], w: number, h: number): boolean {
  if (cs.length!==4) return false;
  let area=0;
  for(let i=0;i<4;i++){const j=(i+1)%4; area+=cs[i].x*cs[j].y-cs[j].x*cs[i].y;}
  return Math.abs(area)/2 > w*h*0.05;
}

function computeHomography(src:[number,number][], dst:[number,number][]): number[] {
  const A:number[][]=[], b:number[]=[];
  for(let i=0;i<4;i++){
    const [x,y]=src[i],[u,v]=dst[i];
    A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
    A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v);
  }
  const n=8, M=A.map((row,i)=>[...row,b[i]]);
  for(let col=0;col<n;col++){
    let mx=col;
    for(let r=col+1;r<n;r++) if(Math.abs(M[r][col])>Math.abs(M[mx][col])) mx=r;
    [M[col],M[mx]]=[M[mx],M[col]];
    const piv=M[col][col]; if(Math.abs(piv)<1e-10) continue;
    for(let j=col;j<=n;j++) M[col][j]/=piv;
    for(let r=0;r<n;r++){if(r===col)continue;const f=M[r][col];for(let j=col;j<=n;j++)M[r][j]-=f*M[col][j];}
  }
  return [...M.map(r=>r[n]),1];
}

function perspectiveWarp(src: HTMLCanvasElement, corners: Corner[]): HTMLCanvasElement {
  const d01=Math.hypot(corners[1].x-corners[0].x,corners[1].y-corners[0].y);
  const d32=Math.hypot(corners[2].x-corners[3].x,corners[2].y-corners[3].y);
  const d03=Math.hypot(corners[3].x-corners[0].x,corners[3].y-corners[0].y);
  const d12=Math.hypot(corners[2].x-corners[1].x,corners[2].y-corners[1].y);
  const outW=Math.round(Math.max(d01,d32)), outH=Math.round(Math.max(d03,d12));
  const dst=document.createElement('canvas');
  dst.width=Math.max(outW,1); dst.height=Math.max(outH,1);
  const H=computeHomography([[0,0],[outW,0],[outW,outH],[0,outH]], corners.map(c=>[c.x,c.y]) as [number,number][]);
  const sd=src.getContext('2d')!.getImageData(0,0,src.width,src.height).data;
  const di=dst.getContext('2d')!.createImageData(dst.width,dst.height);
  const dd=di.data, sw=src.width, sh=src.height;
  for(let v=0;v<outH;v++) for(let u=0;u<outW;u++){
    const den=H[6]*u+H[7]*v+H[8];
    const sx=(H[0]*u+H[1]*v+H[2])/den, sy=(H[3]*u+H[4]*v+H[5])/den;
    if(sx<0||sx>=sw-1||sy<0||sy>=sh-1)continue;
    const x0=sx|0,y0=sy|0,fx=sx-x0,fy=sy-y0;
    const i00=(y0*sw+x0)*4,i10=i00+4,i01=i00+sw*4,i11=i01+4,dp=(v*outW+u)*4;
    for(let c=0;c<3;c++) dd[dp+c]=(sd[i00+c]*(1-fx)*(1-fy)+sd[i10+c]*fx*(1-fy)+sd[i01+c]*(1-fx)*fy+sd[i11+c]*fx*fy)|0;
    dd[dp+3]=255;
  }
  dst.getContext('2d')!.putImageData(di,0,0);
  return dst;
}

function applySharpen(src: HTMLCanvasElement, amount: number): HTMLCanvasElement {
  if (amount <= 0) return src;
  const dst = document.createElement('canvas');
  dst.width = src.width; dst.height = src.height;
  const ctx = dst.getContext('2d')!;
  // Unsharp mask: result = original + amount * (original - blurred)
  ctx.filter = 'blur(1px)';
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  const blurData = ctx.getImageData(0, 0, dst.width, dst.height).data;
  const srcData  = src.getContext('2d')!.getImageData(0, 0, src.width, src.height).data;
  const result   = ctx.createImageData(dst.width, dst.height);
  for (let i = 0; i < srcData.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      result.data[i+c] = Math.max(0, Math.min(255, (srcData[i+c] + amount * (srcData[i+c] - blurData[i+c])) | 0));
    }
    result.data[i+3] = 255;
  }
  ctx.putImageData(result, 0, 0);
  return dst;
}

const FILTER_CSS: Record<FilterMode, (b:number,c:number)=>string> = {
  enhance:   (b,c) => `contrast(${c*1.7}) brightness(${b*1.05}) saturate(0.4)`,
  magic:     (b,c) => `contrast(${c*1.35}) brightness(${b*1.08}) saturate(1.4)`,
  bw:        (b,c) => `grayscale(1) contrast(${c*1.8}) brightness(${b*1.05})`,
  grayscale: (b,c) => `grayscale(1) contrast(${c*1.2}) brightness(${b})`,
  original:  (b,c) => `brightness(${b}) contrast(${c})`,
};

function applyFilter(src: HTMLCanvasElement, mode: FilterMode, brightness=1.0, contrast=1.0): HTMLCanvasElement {
  const dst=document.createElement('canvas');
  dst.width=src.width; dst.height=src.height;
  const ctx=dst.getContext('2d')!;
  ctx.filter=FILTER_CSS[mode](brightness,contrast);
  ctx.drawImage(src,0,0);
  return dst;
}

function prepareForOCR(src: HTMLCanvasElement): string {
  const scaled=scaleCanvas(src,1500);
  const c=document.createElement('canvas');
  c.width=scaled.width; c.height=scaled.height;
  const ctx=c.getContext('2d')!;
  ctx.filter='grayscale(1) contrast(1.4) brightness(1.08)';
  ctx.drawImage(scaled,0,0);
  ctx.filter='none';
  return c.toDataURL('image/png');
}

function fmtDim(w: number, h: number): string {
  // Estimate physical size at 300dpi
  const wi = (w/300).toFixed(1), hi = (h/300).toFixed(1);
  return `${w} × ${h} px  (${wi}" × ${hi}" @ 300 dpi)`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CameraScanner({ onTextDetected, onClose, lookupWord, accentColor }: Props) {

  const videoRef      = useRef<HTMLVideoElement>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const workerRef     = useRef<Worker | null>(null);
  const cropContRef   = useRef<HTMLDivElement>(null);
  const overlayRef    = useRef<HTMLCanvasElement>(null);
  const loupeRef      = useRef<HTMLCanvasElement>(null);
  const liveTimerRef  = useRef<number>(0);
  const stableRef     = useRef(0);
  const prevCornerRef = useRef<Corner[]|null>(null);
  const capturedRef   = useRef<HTMLCanvasElement|null>(null);
  const timingsRef    = useRef<number[]>([0,0,0,0]);

  const [step,         setStep]         = useState<ScanStep>('live');
  const [captured,     setCaptured]     = useState<HTMLCanvasElement|null>(null);
  const [processed,    setProcessed]    = useState<HTMLCanvasElement|null>(null);
  const [corners,      setCorners]      = useState<Corner[]>([]);
  const [liveCorners,  setLiveCorners]  = useState<Corner[]|null>(null);
  const [autoProgress, setAutoProgress] = useState(0);
  const [filter,       setFilter]       = useState<FilterMode>('enhance');
  const [brightness,   setBrightness]   = useState(1.0);
  const [contrast,     setContrast]     = useState(1.0);
  const [sharpen,      setSharpen]      = useState(0.5);
  const [showGrid,     setShowGrid]     = useState(false);
  const [dragIdx,      setDragIdx]      = useState(-1);
  const [loupeVisible, setLoupeVisible] = useState(false);
  const [words,        setWords]        = useState<DetectedWord[]>([]);
  const [allText,      setAllText]      = useState('');
  const [selectedWord, setSelectedWord] = useState<DetectedWord|null>(null);
  const [scanning,     setScanning]     = useState(false);
  const [statusMsg,    setStatusMsg]    = useState('Starting camera…');
  const [processStep,  setProcessStep]  = useState(0);
  const [processNote,  setProcessNote]  = useState('');
  const [viewMode,     setViewMode]     = useState<ViewMode>('image');
  const [workerReady,  setWorkerReady]  = useState(false);
  const [facing,       setFacing]       = useState<'environment'|'user'>('environment');
  const [torchOn,      setTorchOn]      = useState(false);
  const [torchOK,      setTorchOK]      = useState(false);
  const [autoMode,     setAutoMode]     = useState(true);
  const [copied,       setCopied]       = useState(false);
  const [zoomLevel,    setZoomLevel]    = useState(1.0);
  const [thumbUrl,     setThumbUrl]     = useState('');
  const [warpedDims,   setWarpedDims]   = useState({w:0,h:0});

  // ── Camera ───────────────────────────────────────────────────────────────
  const startCamera = useCallback(async (f: 'environment'|'user') => {
    clearInterval(liveTimerRef.current);
    streamRef.current?.getTracks().forEach(t=>t.stop());
    streamRef.current=null;
    if (videoRef.current) videoRef.current.srcObject=null;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: f, width:{ideal:1920}, height:{ideal:1080} }, audio: false,
      });
      streamRef.current=s;
      const track=s.getVideoTracks()[0];
      const caps=(track.getCapabilities?.()) as any;
      setTorchOK(!!(caps?.torch));
      if (videoRef.current) {
        videoRef.current.srcObject=s;
        try { await videoRef.current.play(); } catch(e:any){if(e.name!=='AbortError')throw e;}
      }
    } catch(err:any) {
      if(err.name==='AbortError') return;
      setStatusMsg(err.name==='NotAllowedError' ? 'Camera permission denied' : 'Camera unavailable');
    }
  }, []);

  const toggleTorch = useCallback(async () => {
    const track=streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next=!torchOn;
    try { await track.applyConstraints({advanced:[{torch:next}as any]}); setTorchOn(next); } catch{}
  }, [torchOn]);

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted=true;
    startCamera('environment');
    (async () => {
      try {
        const w=await createWorker('eng',1,{logger:()=>{}});
        if (!mounted){await w.terminate();return;}
        await w.setParameters({tessedit_pageseg_mode:'1'as any});
        workerRef.current=w;
        setWorkerReady(true);
        setStatusMsg('Align document within the frame, then capture');
      } catch { if(mounted) setStatusMsg('OCR engine failed to load'); }
    })();
    return ()=>{
      mounted=false;
      clearInterval(liveTimerRef.current);
      streamRef.current?.getTracks().forEach(t=>t.stop());
      workerRef.current?.terminate();
      workerRef.current=null;
    };
  }, []);

  // ── Live detection + auto-capture ────────────────────────────────────────
  useEffect(() => {
    if (step!=='live'){clearInterval(liveTimerRef.current);return;}
    const id=window.setInterval(()=>{
      const video=videoRef.current;
      if(!video||video.readyState<2||!video.videoWidth) return;
      const tmp=document.createElement('canvas');
      tmp.width=video.videoWidth; tmp.height=video.videoHeight;
      tmp.getContext('2d')!.drawImage(video,0,0);
      const detected=detectDocumentCorners(tmp);
      const valid=cornersValid(detected,tmp.width,tmp.height);
      if (valid) {
        const prev=prevCornerRef.current;
        const stable=prev&&detected.every((c,i)=>Math.hypot(c.x-prev[i].x,c.y-prev[i].y)<tmp.width*0.04);
        if (stable) {
          stableRef.current=Math.min(stableRef.current+1,3);
          setAutoProgress(Math.min(100,stableRef.current*34));
          if (stableRef.current>=3&&autoMode) {
            // Auto-capture
            const c2=document.createElement('canvas');
            c2.width=tmp.width;c2.height=tmp.height;
            c2.getContext('2d')!.drawImage(tmp,0,0);
            const fc=cornersValid(detected,c2.width,c2.height)?detected:defaultCorners(c2);
            capturedRef.current=c2;
            setCaptured(c2);
            setCorners(fc);
            setThumbUrl(scaleCanvas(c2,400).toDataURL());
            setLiveCorners(null); setAutoProgress(0); stableRef.current=0; prevCornerRef.current=null;
            setStep('crop'); clearInterval(id); return;
          }
        } else { stableRef.current=0; setAutoProgress(0); }
        prevCornerRef.current=detected;
        setLiveCorners(detected.map(c=>({x:c.x/tmp.width,y:c.y/tmp.height})));
      } else {
        stableRef.current=0; setAutoProgress(0);
        prevCornerRef.current=null; setLiveCorners(null);
      }
    },900);
    liveTimerRef.current=id;
    return ()=>clearInterval(id);
  },[step,autoMode]);

  // ── Capture ───────────────────────────────────────────────────────────────
  const captureFrame=useCallback(()=>{
    const video=videoRef.current;
    if(!video||video.readyState<2||!video.videoWidth) return;
    const c=document.createElement('canvas');
    c.width=video.videoWidth;c.height=video.videoHeight;
    c.getContext('2d')!.drawImage(video,0,0);
    const detected=detectDocumentCorners(c);
    const fc=cornersValid(detected,c.width,c.height)?detected:defaultCorners(c);
    capturedRef.current=c;
    setCaptured(c); setCorners(fc); setThumbUrl(scaleCanvas(c,400).toDataURL());
    setLiveCorners(null); setAutoProgress(0); stableRef.current=0; setStep('crop');
  },[]);

  const rotateCaptured=useCallback((deg:90|-90)=>{
    const c=capturedRef.current; if(!c) return;
    const rot=rotateCanvas(c,deg);
    capturedRef.current=rot; setCaptured(rot); setThumbUrl(scaleCanvas(rot,400).toDataURL());
    const det=detectDocumentCorners(rot);
    setCorners(cornersValid(det,rot.width,rot.height)?det:defaultCorners(rot));
  },[]);

  const reDetect=useCallback(()=>{
    const c=capturedRef.current; if(!c) return;
    const det=detectDocumentCorners(c);
    setCorners(cornersValid(det,c.width,c.height)?det:defaultCorners(c));
  },[]);

  // ── Process & OCR ─────────────────────────────────────────────────────────
  const processAndScan=useCallback(async()=>{
    if(!captured||!workerRef.current) return;
    setStep('processing'); setWords([]); setAllText(''); setSelectedWord(null); setViewMode('image'); setZoomLevel(1.0);
    timingsRef.current=[0,0,0,0];
    try {
      let t0=performance.now();
      setProcessStep(0); setProcessNote('');
      await sleep(60);
      const warped=perspectiveWarp(captured,corners);
      timingsRef.current[0]=performance.now()-t0;
      setWarpedDims({w:warped.width,h:warped.height});
      setProcessNote(`${warped.width}×${warped.height} px`);

      t0=performance.now();
      setProcessStep(1);
      await sleep(60);
      const sharpened=applySharpen(warped,sharpen);
      const filtered=applyFilter(sharpened,filter,brightness,contrast);
      setProcessed(filtered);
      timingsRef.current[1]=performance.now()-t0;

      t0=performance.now();
      setProcessStep(2); setProcessNote('Recognizing text…');
      setScanning(true);
      const ocrUrl=prepareForOCR(warped); // OCR on unfiltered warp
      const {data}=await workerRef.current.recognize(ocrUrl);
      timingsRef.current[2]=performance.now()-t0;
      setAllText(data.text||'');

      t0=performance.now();
      setProcessStep(3); setProcessNote('Matching dictionary…');
      const detected:DetectedWord[]=(data.words||[])
        .filter((w:any)=>w.confidence>15&&w.text.trim().length>1)
        .map((w:any)=>{
          const text=w.text.trim().replace(/[^a-zA-Z'-]/g,'');
          const meaning=text.length>1?lookupWord(text):null;
          return{text:text||w.text.trim(),confidence:w.confidence,
                 x0:w.bbox.x0,y0:w.bbox.y0,x1:w.bbox.x1,y1:w.bbox.y1,meaning};
        })
        .filter((w:DetectedWord)=>w.text.length>1);
      timingsRef.current[3]=performance.now()-t0;

      const hits=detected.filter(w=>w.meaning!==null).length;
      const avgConf=detected.length?Math.round(detected.reduce((a,w)=>a+w.confidence,0)/detected.length):0;
      setWords(detected);
      setStatusMsg(detected.length>0
        ?`${detected.length} words  ·  ${hits} in dictionary  ·  avg ${avgConf}% confidence`
        :'No text recognized — try Enhance filter or better lighting');
    } catch {
      setStatusMsg('Processing failed — please try again');
    }
    setScanning(false); setStep('results');
  },[captured,corners,filter,brightness,contrast,sharpen,lookupWord]);

  // ── OCR overlay ───────────────────────────────────────────────────────────
  useEffect(()=>{
    if(step!=='results'||!processed||!overlayRef.current||!words.length) return;
    const canvas=overlayRef.current;
    canvas.width=canvas.offsetWidth; canvas.height=canvas.offsetHeight;
    const ctx=canvas.getContext('2d')!;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const sx=canvas.width/processed.width, sy=canvas.height/processed.height;
    words.forEach(w=>{
      const x=w.x0*sx,y=w.y0*sy,bw=(w.x1-w.x0)*sx,bh=(w.y1-w.y0)*sy;
      const inDict=w.meaning!==null, conf=w.confidence/100;
      ctx.fillStyle=inDict?`rgba(91,132,196,${0.12+conf*0.1})`:`rgba(255,255,255,${conf*0.05})`;
      ctx.strokeStyle=inDict?accentColor:`rgba(255,255,255,${conf*0.3})`;
      ctx.lineWidth=inDict?2:1;
      ctx.beginPath(); ctx.roundRect(x-2,y-2,bw+4,bh+4,4); ctx.fill(); ctx.stroke();
      if(inDict){
        ctx.strokeStyle=accentColor; ctx.lineWidth=2.5;
        ctx.beginPath(); ctx.moveTo(x,y+bh+4); ctx.lineTo(x+bw,y+bh+4); ctx.stroke();
        if(w.meaning){
          const label=w.meaning.length>28?w.meaning.slice(0,26)+'…':w.meaning;
          const fs=Math.max(9,Math.min(13,bh*0.55));
          ctx.font=`bold ${fs}px system-ui,sans-serif`;
          const lw=ctx.measureText(label).width+10,lh=fs+8;
          const lx=Math.min(Math.max(2,x),canvas.width-lw-2);
          const ly=Math.max(lh+2,y-lh-4);
          ctx.fillStyle=accentColor;
          ctx.beginPath(); ctx.roundRect(lx,ly,lw,lh,4); ctx.fill();
          ctx.fillStyle='#fff'; ctx.shadowColor='rgba(0,0,0,0.6)'; ctx.shadowBlur=3;
          ctx.fillText(label,lx+5,ly+lh-4); ctx.shadowBlur=0;
        }
      }
    });
  },[step,words,processed,accentColor]);

  // ── Corner drag ───────────────────────────────────────────────────────────
  const getLayout=useCallback(()=>{
    const el=cropContRef.current; if(!el||!captured) return null;
    const r=el.getBoundingClientRect();
    const s=Math.min(r.width/captured.width,r.height/captured.height);
    const dW=captured.width*s,dH=captured.height*s;
    return{s,ox:(r.width-dW)/2,oy:(r.height-dH)/2,r};
  },[captured]);

  const imgToSc=(c:Corner)=>{const l=getLayout();return l?{x:c.x*l.s+l.ox,y:c.y*l.s+l.oy}:{x:0,y:0};};

  const drawLoupe=useCallback((ix:number,iy:number)=>{
    const lc=loupeRef.current,cap=capturedRef.current;
    if(!lc||!cap) return;
    const ctx=lc.getContext('2d')!,size=lc.width,zoom=3.5;
    const srcSz=size/zoom;
    ctx.clearRect(0,0,size,size);
    ctx.save();
    ctx.beginPath(); ctx.arc(size/2,size/2,size/2-1,0,Math.PI*2); ctx.clip();
    ctx.drawImage(cap,ix-srcSz/2,iy-srcSz/2,srcSz,srcSz,0,0,size,size);
    ctx.restore();
    // Crosshair
    ctx.strokeStyle=accentColor; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(size/2,size/2-14); ctx.lineTo(size/2,size/2+14); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(size/2-14,size/2); ctx.lineTo(size/2+14,size/2); ctx.stroke();
    // Ring
    ctx.strokeStyle='rgba(255,255,255,0.8)'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(size/2,size/2,size/2-1,0,Math.PI*2); ctx.stroke();
  },[accentColor]);

  const onPointerMove=useCallback((e:React.PointerEvent<HTMLDivElement>)=>{
    if(dragIdx<0||!captured) return;
    const l=getLayout(); if(!l) return;
    const ix=Math.max(0,Math.min(captured.width,(e.clientX-l.r.left-l.ox)/l.s));
    const iy=Math.max(0,Math.min(captured.height,(e.clientY-l.r.top-l.oy)/l.s));
    setCorners(cs=>cs.map((c,i)=>i!==dragIdx?c:{x:ix,y:iy}));
    drawLoupe(ix,iy);
  },[dragIdx,getLayout,captured,drawLoupe]);

  const onOverlayClick=useCallback((e:React.MouseEvent<HTMLCanvasElement>)=>{
    if(!processed||!overlayRef.current) return;
    const canvas=overlayRef.current, r=canvas.getBoundingClientRect();
    const cx=e.clientX-r.left,cy=e.clientY-r.top;
    const sx=canvas.width/processed.width,sy=canvas.height/processed.height;
    const hit=words.find(w=>{
      const x=w.x0*sx-8,y=w.y0*sy-8;
      return cx>=x&&cx<=x+(w.x1-w.x0)*sx+16&&cy>=y&&cy<=y+(w.y1-w.y0)*sy+16;
    });
    if(hit) setSelectedWord(hit);
  },[words,processed]);

  const copyText=useCallback(async()=>{
    if(!allText) return;
    try{await navigator.clipboard.writeText(allText);}catch{}
    setCopied(true); setTimeout(()=>setCopied(false),2200);
  },[allText]);

  const downloadScan=useCallback((fmt:'jpeg'|'png')=>{
    if(!processed) return;
    const a=document.createElement('a');
    a.href=processed.toDataURL(`image/${fmt}`,fmt==='jpeg'?0.95:undefined);
    a.download=`scan_${Date.now()}.${fmt}`;
    a.click();
  },[processed]);

  const flipCamera=useCallback(()=>{
    const f:'environment'|'user'=facing==='environment'?'user':'environment';
    setFacing(f); startCamera(f);
  },[facing,startCamera]);

  const reset=useCallback(()=>{
    setStep('live'); setCaptured(null); setProcessed(null); setCorners([]); setWords([]);
    setAllText(''); setSelectedWord(null); setAutoProgress(0); stableRef.current=0;
    setStatusMsg('Align document within the frame, then capture');
  },[]);

  // ── Derived values ────────────────────────────────────────────────────────
  const screenCorners=corners.map(c=>imgToSc(c));
  const dictWords=words.filter(w=>w.meaning!==null);
  const avgConf=words.length?Math.round(words.reduce((a,w)=>a+w.confidence,0)/words.length):0;

  // Quad area % of image
  let quadAreaPct = 0;
  if (corners.length===4&&captured) {
    let area=0;
    for(let i=0;i<4;i++){const j=(i+1)%4;area+=corners[i].x*corners[j].y-corners[j].x*corners[i].y;}
    quadAreaPct=Math.round(Math.abs(area)/2/(captured.width*captured.height)*100);
  }

  // Estimated aspect label
  const aspectLabel=corners.length===4&&captured?()=>{
    const d01=Math.hypot(corners[1].x-corners[0].x,corners[1].y-corners[0].y);
    const d03=Math.hypot(corners[3].x-corners[0].x,corners[3].y-corners[0].y);
    const ratio=d01/d03;
    if(Math.abs(ratio-0.707)<0.12) return 'A4 / Letter';
    if(Math.abs(ratio-0.638)<0.08) return 'A5';
    if(Math.abs(ratio-1.586)<0.12) return 'ID Card (CR80)';
    if(Math.abs(ratio-1)<0.1) return 'Square';
    return `${ratio.toFixed(2)} : 1`;
  }():null;

  const loupeRight  = dragIdx===1||dragIdx===2;
  const loupeBottom = dragIdx===2||dragIdx===3;

  const PROCESS_STEPS=[
    {label:'Perspective Correction',note:'Warping quad to rectangle'},
    {label:'Filter & Enhancement',note:'Applying color adjustments'},
    {label:'Text Recognition',note:'Tesseract OCR engine'},
    {label:'Dictionary Mapping',note:'Matching English → Kurdish'},
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{position:'fixed',inset:0,zIndex:9999,backgroundColor:'#000',display:'flex',flexDirection:'column',userSelect:'none',WebkitUserSelect:'none'}}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{display:'flex',alignItems:'center',padding:'10px 14px',gap:10,backgroundColor:'rgba(0,0,0,0.9)',backdropFilter:'blur(12px)',zIndex:10,borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
        <button onClick={step==='live'?onClose:reset} style={btnS}><CloseIcon size={18} color="#fff"/></button>
        <div style={{flex:1,textAlign:'center'}}>
          <div style={{color:'#fff',fontWeight:700,fontSize:15,letterSpacing:0.3}}>
            {step==='live'?'Document Scanner':step==='crop'?'Adjust Corners & Filter':step==='processing'?'Processing Document':'Scan Results'}
          </div>
          <div style={{fontSize:11,marginTop:2,color:scanning?accentColor:'#777',transition:'color 0.3s'}}>
            {step==='processing'
              ? processNote||PROCESS_STEPS[processStep]?.note
              : statusMsg}
          </div>
        </div>
        <div style={{display:'flex',gap:6}}>
          {step==='live'&&torchOK&&(
            <button onClick={toggleTorch} style={{...btnS,backgroundColor:torchOn?'rgba(255,215,0,0.15)':undefined,borderRadius:8,border:torchOn?'1px solid rgba(255,215,0,0.4)':'1px solid transparent',color:torchOn?'#FFD700':'#888',fontSize:11,fontWeight:700}}>
              {torchOn?'TORCH ON':'TORCH'}
            </button>
          )}
          {step==='live'&&<button onClick={flipCamera} style={btnS}><FlipCameraIcon size={20} color="#fff"/></button>}
          {step==='crop'&&<button onClick={reDetect} style={{...btnS,fontSize:12,color:accentColor,fontWeight:700,border:`1px solid ${accentColor}44`,borderRadius:6}}>Re-detect</button>}
          {step==='results'&&(
            <div style={{display:'flex',gap:6}}>
              <button onClick={()=>downloadScan('jpeg')} style={{...btnS,fontSize:11,color:'#aaa',border:'1px solid rgba(255,255,255,0.15)',borderRadius:6}}>JPEG</button>
              <button onClick={()=>downloadScan('png')}  style={{...btnS,fontSize:11,color:'#aaa',border:'1px solid rgba(255,255,255,0.15)',borderRadius:6}}>PNG</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Main ──────────────────────────────────────────────────────── */}
      <div style={{flex:1,position:'relative',overflow:'hidden'}}>

        {/* LIVE */}
        {step==='live'&&(
          <>
            <video ref={videoRef} style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}} playsInline muted/>
            <svg style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none'}}>
              {liveCorners&&liveCorners.length===4?(
                <>
                  <defs>
                    <mask id="lm"><rect width="100%" height="100%" fill="white"/>
                      <polygon points={(liveCorners as any[]).map((c:any)=>`${c.x*100}% ${c.y*100}%`).join(' ')} fill="black"/>
                    </mask>
                  </defs>
                  <rect width="100%" height="100%" fill="rgba(0,0,0,0.3)" mask="url(#lm)"/>
                  <polygon points={(liveCorners as any[]).map((c:any)=>`${c.x*100}% ${c.y*100}%`).join(' ')}
                    fill="rgba(91,132,196,0.08)" stroke={accentColor} strokeWidth="2.5" strokeLinejoin="round"/>
                  {(liveCorners as any[]).map((c:any,i:number)=>(
                    <circle key={i} cx={`${c.x*100}%`} cy={`${c.y*100}%`} r="5.5" fill={accentColor}/>
                  ))}
                </>
              ):(
                <>
                  <defs>
                    <mask id="gm"><rect width="100%" height="100%" fill="white"/>
                      <rect x="7%" y="9%" width="86%" height="82%" rx="8" fill="black"/>
                    </mask>
                  </defs>
                  <rect width="100%" height="100%" fill="rgba(0,0,0,0.32)" mask="url(#gm)"/>
                  <rect x="7%" y="9%" width="86%" height="82%" rx="8" fill="none" stroke={accentColor} strokeWidth="1.5" strokeDasharray="12 6"/>
                  {([[7,9,1,1],[93,9,-1,1],[93,91,-1,-1],[7,91,1,-1]] as [number,number,number,number][]).map(([cx,cy,dx,dy],i)=>(
                    <g key={i}>
                      <line x1={`${cx}%`} y1={`${cy}%`} x2={`${cx+dx*3.5}%`} y2={`${cy}%`} stroke={accentColor} strokeWidth="3.5" strokeLinecap="round"/>
                      <line x1={`${cx}%`} y1={`${cy}%`} x2={`${cx}%`} y2={`${cy+dy*4.5}%`} stroke={accentColor} strokeWidth="3.5" strokeLinecap="round"/>
                    </g>
                  ))}
                </>
              )}
            </svg>
            {/* Status overlay */}
            <div style={{position:'absolute',top:14,left:0,right:0,display:'flex',flexDirection:'column',alignItems:'center',gap:8}}>
              {liveCorners?(
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <svg width="30" height="30" style={{transform:'rotate(-90deg)'}}>
                    <circle cx="15" cy="15" r="12" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="3"/>
                    <circle cx="15" cy="15" r="12" fill="none" stroke={accentColor} strokeWidth="3"
                      strokeDasharray={`${autoProgress/100*75.4} 75.4`} strokeLinecap="round" style={{transition:'stroke-dasharray 0.3s'}}/>
                  </svg>
                  <div style={{backgroundColor:'rgba(0,0,0,0.6)',backdropFilter:'blur(6px)',border:`1px solid ${accentColor}66`,borderRadius:20,padding:'5px 14px'}}>
                    <span style={{color:accentColor,fontSize:12,fontWeight:700}}>Document detected</span>
                    {autoMode&&<span style={{color:'#888',fontSize:11,marginLeft:6}}>— hold steady to auto-capture</span>}
                  </div>
                </div>
              ):(
                <div style={{backgroundColor:'rgba(0,0,0,0.55)',backdropFilter:'blur(6px)',borderRadius:20,padding:'5px 14px',border:'1px solid rgba(255,255,255,0.1)'}}>
                  <span style={{color:'#999',fontSize:12}}>Searching for document edges…</span>
                </div>
              )}
            </div>
            {/* Mode indicator */}
            <div style={{position:'absolute',bottom:120,left:0,right:0,display:'flex',justifyContent:'center'}}>
              <div style={{backgroundColor:'rgba(0,0,0,0.55)',backdropFilter:'blur(6px)',borderRadius:6,padding:'4px 12px',border:'1px solid rgba(255,255,255,0.1)'}}>
                <span style={{color:'#777',fontSize:11}}>Mode: </span>
                <span style={{color:autoMode?accentColor:'#aaa',fontSize:11,fontWeight:700}}>{autoMode?'AUTO-CAPTURE':'MANUAL'}</span>
              </div>
            </div>
          </>
        )}

        {/* CROP */}
        {step==='crop'&&captured&&(
          <div ref={cropContRef} style={{width:'100%',height:'100%',position:'relative',touchAction:'none'}}
            onPointerMove={onPointerMove}
            onPointerUp={()=>{setDragIdx(-1);setLoupeVisible(false);}}
            onPointerLeave={()=>{setDragIdx(-1);setLoupeVisible(false);}}>
            <img src={thumbUrl||captured.toDataURL()} alt="captured"
              style={{width:'100%',height:'100%',objectFit:'contain',display:'block',pointerEvents:'none'}}/>
            {/* Grid overlay */}
            {showGrid&&(()=>{
              const l=getLayout();
              if(!l) return null;
              const lines=[];
              for(let i=1;i<3;i++){
                const x=l.ox+l.s*captured.width/3*i;
                const y=l.oy+l.s*captured.height/3*i;
                lines.push(<line key={`gv${i}`} x1={x} y1={l.oy} x2={x} y2={l.oy+l.s*captured.height} stroke="rgba(91,132,196,0.35)" strokeWidth="1"/>);
                lines.push(<line key={`gh${i}`} x1={l.ox} y1={y} x2={l.ox+l.s*captured.width} y2={y} stroke="rgba(91,132,196,0.35)" strokeWidth="1"/>);
              }
              return <svg style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none'}}>{lines}</svg>;
            })()}
            {/* Quad + handles */}
            <svg style={{position:'absolute',inset:0,width:'100%',height:'100%',overflow:'visible'}}>
              {screenCorners.length===4&&(()=>{
                const pts=screenCorners.map(p=>`${p.x},${p.y}`).join(' ');
                return (
                  <>
                    <defs>
                      <filter id="hs"><feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="rgba(0,0,0,0.5)"/></filter>
                    </defs>
                    <polygon points={pts} fill="rgba(91,132,196,0.12)" stroke={accentColor} strokeWidth="2.5" strokeLinejoin="round"/>
                    {/* Edge midpoints */}
                    {screenCorners.map((p,i)=>{const q=screenCorners[(i+1)%4];return(
                      <circle key={`m${i}`} cx={(p.x+q.x)/2} cy={(p.y+q.y)/2} r="4" fill={accentColor} opacity="0.4"/>
                    );})}
                    {screenCorners.map((p,i)=>(
                      <g key={i}>
                        <circle cx={p.x} cy={p.y} r="24" fill="transparent" style={{cursor:'grab',touchAction:'none'}}
                          onPointerDown={e=>{e.preventDefault();(e.target as any).setPointerCapture(e.pointerId);
                            setDragIdx(i);setLoupeVisible(true);drawLoupe(corners[i].x,corners[i].y);}}/>
                        <circle cx={p.x} cy={p.y} r="11" fill={accentColor} stroke="#fff" strokeWidth="2.5"
                          filter="url(#hs)" style={{pointerEvents:'none'}}/>
                        <text x={p.x} y={p.y+5} textAnchor="middle" fill="#fff" fontSize="11" fontWeight="bold" style={{pointerEvents:'none'}}>
                          {['◤','◥','◢','◣'][i]}
                        </text>
                      </g>
                    ))}
                    {/* Dimension labels */}
                    {(()=>{
                      const tl=screenCorners[0],tr=screenCorners[1];
                      const topLen=Math.hypot(tr.x-tl.x,tr.y-tl.y)|0;
                      const midX=(tl.x+tr.x)/2, midY=Math.min(tl.y,tr.y)-14;
                      const lh=screenCorners[0],ll=screenCorners[3];
                      const leftLen=Math.hypot(ll.x-lh.x,ll.y-lh.y)|0;
                      const mx2=Math.min(lh.x,ll.x)-8, my2=(lh.y+ll.y)/2;
                      return(
                        <>
                          <text x={midX} y={midY} textAnchor="middle" fill={accentColor} fontSize="10" fontWeight="600">{topLen}px</text>
                          <text x={mx2} y={my2+4} textAnchor="end" fill={accentColor} fontSize="10" fontWeight="600">{leftLen}px</text>
                        </>
                      );
                    })()}
                  </>
                );
              })()}
            </svg>
            {/* Loupe */}
            {loupeVisible&&(
              <canvas ref={loupeRef} width={140} height={140}
                style={{position:'absolute',borderRadius:'50%',boxShadow:'0 4px 20px rgba(0,0,0,0.6)',
                  [loupeRight?'right':'left']:20,[loupeBottom?'bottom':'top']:20,pointerEvents:'none'}}/>
            )}
            {/* Corner coord readout */}
            {dragIdx>=0&&corners[dragIdx]&&(
              <div style={{position:'absolute',bottom:10,left:0,right:0,textAlign:'center',pointerEvents:'none'}}>
                <span style={{backgroundColor:'rgba(0,0,0,0.7)',color:'#aaa',fontSize:10,padding:'3px 10px',borderRadius:10}}>
                  Corner {dragIdx+1}:  {corners[dragIdx].x|0}, {corners[dragIdx].y|0} px
                </span>
              </div>
            )}
          </div>
        )}

        {/* PROCESSING */}
        {step==='processing'&&(
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%',flexDirection:'column',gap:30}}>
            <div style={{width:56,height:56,borderRadius:'50%',border:`4px solid ${accentColor}`,borderTopColor:'transparent',animation:'spin 0.9s linear infinite'}}/>
            <div style={{display:'flex',gap:0,backgroundColor:'rgba(255,255,255,0.04)',borderRadius:12,overflow:'hidden',border:'1px solid rgba(255,255,255,0.08)'}}>
              {PROCESS_STEPS.map((s,i)=>(
                <div key={i} style={{padding:'14px 20px',textAlign:'center',borderRight:i<3?'1px solid rgba(255,255,255,0.07)':undefined,backgroundColor:i===processStep?'rgba(91,132,196,0.15)':'transparent',transition:'background 0.3s'}}>
                  <div style={{width:28,height:28,borderRadius:'50%',margin:'0 auto 8px',display:'flex',alignItems:'center',justifyContent:'center',
                    backgroundColor:i<processStep?accentColor:i===processStep?'rgba(91,132,196,0.3)':'rgba(255,255,255,0.06)',
                    border:`1.5px solid ${i<=processStep?accentColor:'rgba(255,255,255,0.1)'}`,transition:'all 0.3s'}}>
                    <span style={{color:i<processStep?'#fff':accentColor,fontSize:12,fontWeight:700}}>{i<processStep?'✓':i+1}</span>
                  </div>
                  <div style={{color:i===processStep?'#ddd':i<processStep?'#888':'#444',fontSize:11,fontWeight:i===processStep?700:400,transition:'color 0.3s'}}>{s.label}</div>
                  {i===processStep&&processNote&&<div style={{color:accentColor,fontSize:9,marginTop:4}}>{processNote}</div>}
                </div>
              ))}
            </div>
            {warpedDims.w>0&&<div style={{color:'#555',fontSize:11}}>Output: {warpedDims.w} × {warpedDims.h} px</div>}
          </div>
        )}

        {/* RESULTS */}
        {step==='results'&&processed&&(
          <>
            {/* View tabs */}
            <div style={{position:'absolute',top:0,left:0,right:0,zIndex:5,display:'flex',backgroundColor:'rgba(0,0,0,0.75)',backdropFilter:'blur(10px)',borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
              {(['image','text','words'] as ViewMode[]).map(m=>(
                <button key={m} onClick={()=>setViewMode(m)} style={{flex:1,padding:'9px 0',border:'none',cursor:'pointer',fontSize:12,fontWeight:700,
                  backgroundColor:viewMode===m?accentColor:'transparent',color:viewMode===m?'#fff':'#666',transition:'all 0.2s',letterSpacing:0.5}}>
                  {m==='image'?'IMAGE':m==='text'?'RAW TEXT':`VOCABULARY (${dictWords.length})`}
                </button>
              ))}
            </div>

            {viewMode==='image'&&(
              <>
                <div style={{position:'absolute',inset:0,top:36,overflow:'hidden',display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <img src={processed.toDataURL()} alt="scanned"
                    style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain',transform:`scale(${zoomLevel})`,transformOrigin:'center',transition:'transform 0.2s',pointerEvents:'none'}}/>
                </div>
                <canvas ref={overlayRef} onClick={onOverlayClick}
                  style={{position:'absolute',inset:0,width:'100%',height:'100%',cursor:'pointer',top:36}}/>
                {/* Zoom controls */}
                <div style={{position:'absolute',right:12,top:50,display:'flex',flexDirection:'column',gap:4,zIndex:10}}>
                  <button onClick={()=>setZoomLevel(z=>Math.min(z+0.25,3))}
                    style={{width:34,height:34,borderRadius:8,border:'1px solid rgba(255,255,255,0.15)',backgroundColor:'rgba(0,0,0,0.65)',color:'#fff',fontSize:18,cursor:'pointer',lineHeight:1}}>+</button>
                  <div style={{textAlign:'center',color:'#666',fontSize:9,fontWeight:600}}>{Math.round(zoomLevel*100)}%</div>
                  <button onClick={()=>setZoomLevel(z=>Math.max(z-0.25,0.5))}
                    style={{width:34,height:34,borderRadius:8,border:'1px solid rgba(255,255,255,0.15)',backgroundColor:'rgba(0,0,0,0.65)',color:'#fff',fontSize:18,cursor:'pointer',lineHeight:1}}>−</button>
                  <button onClick={()=>setZoomLevel(1)} style={{width:34,height:16,borderRadius:5,border:'1px solid rgba(255,255,255,0.1)',backgroundColor:'rgba(0,0,0,0.55)',color:'#555',fontSize:9,cursor:'pointer'}}>RESET</button>
                </div>
              </>
            )}

            {viewMode==='text'&&(
              <div style={{position:'absolute',inset:0,top:36,overflowY:'auto',padding:'14px 16px',backgroundColor:'rgba(8,8,16,0.98)'}}>
                <div style={{color:'#555',fontSize:10,marginBottom:12,fontFamily:'monospace',borderBottom:'1px solid rgba(255,255,255,0.05)',paddingBottom:8}}>
                  {words.length} words detected  ·  avg confidence {avgConf}%  ·  {allText.split('\n').filter(Boolean).length} lines
                </div>
                {allText?allText.split('\n').map((line,li)=>(
                  <div key={li} style={{color:'#ccc',fontSize:13,marginBottom:6,lineHeight:1.9,fontFamily:'system-ui,sans-serif'}}>
                    {line.split(/(\s+)/).map((tok,ti)=>{
                      const clean=tok.replace(/[^a-zA-Z'-]/g,'');
                      const meaning=clean.length>1?lookupWord(clean):null;
                      return meaning
                        ?<span key={ti} onClick={()=>setSelectedWord({text:clean,confidence:90,x0:0,y0:0,x1:0,y1:0,meaning})}
                            style={{backgroundColor:`${accentColor}28`,color:accentColor,borderRadius:3,padding:'1px 3px',cursor:'pointer',borderBottom:`1px solid ${accentColor}66`}}>{tok}</span>
                        :<span key={ti} style={{color:tok.trim().length>0?'#ccc':'#333'}}>{tok}</span>;
                    })}
                  </div>
                )):<div style={{color:'#444',textAlign:'center',marginTop:60,fontSize:13}}>No text recognized</div>}
              </div>
            )}

            {viewMode==='words'&&(
              <div style={{position:'absolute',inset:0,top:36,overflowY:'auto',backgroundColor:'rgba(8,8,16,0.98)'}}>
                {/* Stats row */}
                <div style={{display:'flex',gap:0,borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                  {[
                    {label:'Words',val:words.length},
                    {label:'In Dictionary',val:dictWords.length},
                    {label:'Avg Confidence',val:`${avgConf}%`},
                  ].map((stat,i)=>(
                    <div key={i} style={{flex:1,padding:'12px 0',textAlign:'center',borderRight:i<2?'1px solid rgba(255,255,255,0.06)':undefined}}>
                      <div style={{color:accentColor,fontSize:18,fontWeight:700}}>{stat.val}</div>
                      <div style={{color:'#555',fontSize:10,marginTop:2}}>{stat.label}</div>
                    </div>
                  ))}
                </div>
                {dictWords.length>0?(
                  <div>
                    <div style={{padding:'10px 14px 6px',color:'#555',fontSize:10,fontWeight:700,letterSpacing:1}}>DICTIONARY MATCHES</div>
                    {dictWords.map((w,i)=>(
                      <div key={i} onClick={()=>setSelectedWord(w)}
                        style={{display:'flex',alignItems:'center',padding:'10px 14px',borderBottom:'1px solid rgba(255,255,255,0.04)',cursor:'pointer',backgroundColor:selectedWord?.text===w.text?'rgba(91,132,196,0.12)':'transparent',transition:'background 0.15s'}}>
                        <div style={{flex:1}}>
                          <div style={{color:'#fff',fontSize:14,fontWeight:600}}>{w.text}</div>
                          <div style={{color:'#555',fontSize:10,marginTop:2}}>Confidence: {w.confidence|0}%</div>
                        </div>
                        <div style={{textAlign:'right',direction:'rtl',maxWidth:'55%'}}>
                          <div style={{color:accentColor,fontSize:13,lineHeight:1.5}}>{w.meaning}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ):(
                  <div style={{color:'#444',textAlign:'center',marginTop:60,fontSize:13}}>No dictionary matches found</div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Bottom bar ─────────────────────────────────────────────────── */}
      <div style={{backgroundColor:'rgba(0,0,0,0.93)',backdropFilter:'blur(14px)',padding:'12px 16px 26px',zIndex:10,borderTop:'1px solid rgba(255,255,255,0.06)'}}>

        {/* LIVE */}
        {step==='live'&&(
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:32}}>
              <button onClick={()=>setAutoMode(a=>!a)} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4,...btnS}}>
                <div style={{width:36,height:20,borderRadius:10,backgroundColor:autoMode?accentColor:'rgba(255,255,255,0.15)',position:'relative',transition:'all 0.2s'}}>
                  <div style={{width:16,height:16,borderRadius:'50%',backgroundColor:'#fff',position:'absolute',top:2,left:autoMode?18:2,transition:'left 0.2s'}}/>
                </div>
                <span style={{color:autoMode?accentColor:'#555',fontSize:9,fontWeight:700,letterSpacing:0.5}}>AUTO-CAPTURE</span>
              </button>
              <button onClick={captureFrame} disabled={!workerReady} style={{width:70,height:70,borderRadius:'50%',border:`4px solid ${accentColor}`,
                backgroundColor:'transparent',cursor:workerReady?'pointer':'not-allowed',display:'flex',alignItems:'center',justifyContent:'center',
                boxShadow:workerReady?`0 0 22px ${accentColor}44`:'none',transition:'all 0.2s'}}>
                <div style={{width:50,height:50,borderRadius:'50%',backgroundColor:workerReady?'#fff':'#444',transition:'all 0.2s'}}/>
              </button>
              <button onClick={flipCamera} style={{...btnS,display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                <FlipCameraIcon size={22} color="#aaa"/>
                <span style={{color:'#555',fontSize:9,fontWeight:700,letterSpacing:0.5}}>FLIP</span>
              </button>
            </div>
          </div>
        )}

        {/* CROP */}
        {step==='crop'&&(
          <div style={{display:'flex',flexDirection:'column',gap:9}}>
            {/* Filter chips */}
            <div style={{display:'flex',gap:6,justifyContent:'center',flexWrap:'wrap'}}>
              {([['enhance','Enhance'],['magic','Magic Color'],['bw','Black & White'],['grayscale','Grayscale'],['original','Original']] as [FilterMode,string][]).map(([m,label])=>(
                <button key={m} onClick={()=>setFilter(m)} style={{padding:'6px 14px',borderRadius:6,border:`1px solid ${filter===m?accentColor:'rgba(255,255,255,0.1)'}`,
                  fontSize:11,fontWeight:700,cursor:'pointer',backgroundColor:filter===m?`${accentColor}22`:'transparent',
                  color:filter===m?accentColor:'#777',transition:'all 0.18s',letterSpacing:0.3}}>
                  {label}
                </button>
              ))}
            </div>
            {/* Sliders */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {[
                {label:'Brightness',val:brightness,min:0.5,max:1.6,step:0.05,set:setBrightness},
                {label:'Contrast',val:contrast,min:0.5,max:2.2,step:0.05,set:setContrast},
                {label:'Sharpen',val:sharpen,min:0,max:2,step:0.1,set:setSharpen},
              ].map(sl=>(
                <div key={sl.label} style={{display:'flex',alignItems:'center',gap:6}}>
                  <span style={{color:'#555',fontSize:10,width:56,flexShrink:0}}>{sl.label}</span>
                  <input type="range" min={sl.min} max={sl.max} step={sl.step} value={sl.val}
                    onChange={e=>sl.set(parseFloat(e.target.value))}
                    style={{flex:1,accentColor}}/>
                  <span style={{color:'#666',fontSize:10,width:26,textAlign:'right'}}>{sl.val.toFixed(1)}</span>
                </div>
              ))}
              {/* Info column */}
              <div style={{display:'flex',flexDirection:'column',justifyContent:'center',gap:2,padding:'2px 0'}}>
                {aspectLabel&&<div style={{color:'#555',fontSize:10}}>Format: <span style={{color:'#888'}}>{aspectLabel}</span></div>}
                {captured&&<div style={{color:'#555',fontSize:10}}>Coverage: <span style={{color:'#888'}}>{quadAreaPct}% of frame</span></div>}
              </div>
            </div>
            {/* Rotate + Grid + Actions */}
            <div style={{display:'flex',gap:7}}>
              <button onClick={()=>rotateCaptured(-90)} style={{...actionBtnS,backgroundColor:'rgba(255,255,255,0.07)',color:'#bbb',padding:'9px 12px',fontSize:15,border:'1px solid rgba(255,255,255,0.1)'}}>↺ CCW</button>
              <button onClick={()=>rotateCaptured(90)}  style={{...actionBtnS,backgroundColor:'rgba(255,255,255,0.07)',color:'#bbb',padding:'9px 12px',fontSize:15,border:'1px solid rgba(255,255,255,0.1)'}}>CW ↻</button>
              <button onClick={()=>setShowGrid(g=>!g)} style={{...actionBtnS,backgroundColor:showGrid?`${accentColor}22`:'rgba(255,255,255,0.07)',color:showGrid?accentColor:'#888',padding:'9px 12px',border:`1px solid ${showGrid?accentColor:'rgba(255,255,255,0.1)'}`,fontSize:11}}>Grid</button>
              <button onClick={reset} style={{...actionBtnS,flex:1,backgroundColor:'rgba(255,255,255,0.06)',color:'#999',border:'1px solid rgba(255,255,255,0.08)'}}>Re-capture</button>
              <button onClick={processAndScan} style={{...actionBtnS,flex:2,backgroundColor:accentColor,color:'#fff'}}>Scan Document</button>
            </div>
          </div>
        )}

        {/* RESULTS */}
        {step==='results'&&(
          <div style={{display:'flex',flexDirection:'column',gap:9}}>
            {selectedWord?(
              <>
                <div style={{backgroundColor:'rgba(91,132,196,0.12)',border:`1px solid ${accentColor}44`,borderRadius:10,padding:'10px 14px',display:'flex',flexDirection:'column',gap:5}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
                    <span style={{color:'#fff',fontSize:16,fontWeight:700}}>{selectedWord.text}</span>
                    <span style={{color:'#444',fontSize:10}}>{selectedWord.confidence|0}% confidence</span>
                  </div>
                  {selectedWord.meaning
                    ?<div style={{color:accentColor,fontSize:14,direction:'rtl',textAlign:'right',lineHeight:1.7,borderTop:'1px solid rgba(255,255,255,0.06)',paddingTop:6}}>{selectedWord.meaning}</div>
                    :<div style={{color:'#555',fontSize:12,borderTop:'1px solid rgba(255,255,255,0.06)',paddingTop:6}}>Not found in dictionary</div>}
                </div>
                <div style={{display:'flex',gap:7}}>
                  <button onClick={()=>setSelectedWord(null)} style={{...actionBtnS,flex:1,backgroundColor:'rgba(255,255,255,0.06)',color:'#999',border:'1px solid rgba(255,255,255,0.08)'}}>Close</button>
                  <button onClick={()=>{onTextDetected(selectedWord.text);onClose();}}
                    style={{...actionBtnS,flex:2,backgroundColor:accentColor,color:'#fff'}}>Open in Dictionary</button>
                </div>
              </>
            ):(
              <div style={{display:'flex',gap:7}}>
                <button onClick={reset} style={{...actionBtnS,flex:1,backgroundColor:'rgba(255,255,255,0.06)',color:'#999',border:'1px solid rgba(255,255,255,0.08)'}}>Scan Again</button>
                {allText&&(
                  <button onClick={copyText} style={{...actionBtnS,flex:1,backgroundColor:copied?'rgba(40,120,40,0.3)':'rgba(255,255,255,0.07)',
                    color:copied?'#6f6':'#aaa',border:`1px solid ${copied?'rgba(100,200,100,0.3)':'rgba(255,255,255,0.1)'}`,transition:'all 0.3s'}}>
                    {copied?'Copied':'Copy Text'}
                  </button>
                )}
                <button onClick={()=>downloadScan('jpeg')} style={{...actionBtnS,flex:1,backgroundColor:`${accentColor}22`,color:accentColor,border:`1px solid ${accentColor}44`}}>Save JPEG</button>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg);}}`}</style>
    </div>
  );
}

function defaultCorners(c: HTMLCanvasElement): Corner[] {
  return [{x:c.width*0.06,y:c.height*0.06},{x:c.width*0.94,y:c.height*0.06},
          {x:c.width*0.94,y:c.height*0.94},{x:c.width*0.06,y:c.height*0.94}];
}
function sleep(ms:number){return new Promise<void>(r=>setTimeout(r,ms));}

const btnS:React.CSSProperties={background:'none',border:'none',cursor:'pointer',color:'#fff',padding:'6px 10px',borderRadius:8,lineHeight:1};
const actionBtnS:React.CSSProperties={border:'none',borderRadius:8,padding:'10px 14px',fontSize:12,fontWeight:700,cursor:'pointer',letterSpacing:0.3};
