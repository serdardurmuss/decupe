// Faz 1: arka plan silme + tam çözünürlükte kenar rafine etme + şeffaf PNG.
// Her şey tarayıcıda çalışır; sunucu yok, ücret yok.
let ort; // onnxruntime, ilk fotoğrafta yüklenir (yüklenemezse arayüz yine çalışır, hata yazılır)
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

// Model: U²-Net (Apache-2.0), 320x320 giriş. WebGPU yerine WASM ile her cihazda çalışır.
const MODEL_URL = 'https://huggingface.co/skillsafe-ai/u2net/resolve/main/u2net.onnx';
const MS = 320;           // modelin giriş boyutu
const TILE = 1024;        // rafine ve export parça boyutu
const PAD = 32;           // parça taşma payı

const $ = id => document.getElementById(id);
const status = t => ($('status').textContent = t);
let stage = '';
const errText = e => typeof e === 'number' ? 'bellek hatası (kod ' + e + ')' : (e && (e.message || e.name)) || String(e);
const OPT = { graphOptimizationLevel: 'basic', enableMemPattern: false, enableCpuMemArena: false };
const progress = f => ($('bar').firstElementChild.style.width = Math.round(f * 100) + '%');

let session, src, W, H, maskLow, alpha, lut, name = 'urun';

// ---------- model ----------
async function getModel() {
  let cache, res;
  try { cache = await caches.open('retouch-models'); res = await cache.match(MODEL_URL); } catch {}
  if (!res) {
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error('Model indirilemedi (' + r.status + ')');
    const total = +r.headers.get('content-length') || 0, rd = r.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      parts.push(value); got += value.length;
      progress(total ? got / total : 0);
      status('Model indiriliyor: ' + (got / 1e6 | 0) + ' MB' + (total ? ' / ' + (total / 1e6 | 0) + ' MB' : ''));
    }
    const blob = new Blob(parts);
    try { await cache?.put(MODEL_URL, new Response(blob)); } catch {}
    res = new Response(blob);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function ensureSession() {
  if (session) return;
  stage = 'kütüphane yükleme'; status('Yapay zeka kütüphanesi yükleniyor…');
  ort = await import(ORT_URL + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = ORT_URL; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
  stage = 'model indirme'; const bytes = await getModel();
  stage = 'model hazırlama'; status('Model hazırlanıyor… (birkaç dakika sürebilir)');
  try { session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], ...OPT }); }
  catch { session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], ...OPT }); }
}

// ---------- maske (düşük çözünürlük) ----------
async function predictMask(bitmap) {
  const c = new OffscreenCanvas(MS, MS), g = c.getContext('2d');
  g.drawImage(bitmap, 0, 0, MS, MS);
  const d = g.getImageData(0, 0, MS, MS).data, n = MS * MS, t = new Float32Array(3 * n);
  const mean = [.485, .456, .406], std = [.229, .224, .225];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) t[k * n + i] = (d[i * 4 + k] / 255 - mean[k]) / std[k];
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, MS, MS]) });
  const data = out[session.outputNames[0]].data;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) { if (data[i] < mn) mn = data[i]; if (data[i] > mx) mx = data[i]; }
  const m = new Float32Array(n), logits = mn < 0 || mx > 1;
  for (let i = 0; i < n; i++) m[i] = logits ? 1 / (1 + Math.exp(-data[i])) : (data[i] - mn) / ((mx - mn) || 1);
  return m;
}

const sample = (m, x, y) => {           // bilinear, x,y: 0..MS-1 koordinatı
  x = Math.min(MS - 1, Math.max(0, x)); y = Math.min(MS - 1, Math.max(0, y));
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(MS - 1, x0 + 1), y1 = Math.min(MS - 1, y0 + 1), fx = x - x0, fy = y - y0;
  return (m[y0 * MS + x0] * (1 - fx) + m[y0 * MS + x1] * fx) * (1 - fy) + (m[y1 * MS + x0] * (1 - fx) + m[y1 * MS + x1] * fx) * fy;
};

// ---------- guided filter (kenarı gerçek fotoğraf kenarına oturtur) ----------
function box(a, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h), d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let s = 0;
    for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { t[row + x] = s / d; s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { o[y * w + x] = s / d; s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; }
  }
  return o;
}
function guided(I, p, w, h, r, eps) {
  const n = w * h, Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = box(I, w, h, r), mp = box(p, w, h, r), mIp = box(Ip, w, h, r), mII = box(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { a[i] = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps); b[i] = mp[i] - a[i] * mI[i]; }
  const ma = box(a, w, h, r), mb = box(b, w, h, r), q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

// ---------- tam çözünürlükte parça parça rafine ----------
async function refine() {
  alpha = new Uint8ClampedArray(W * H);
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const r = Math.min(24, Math.max(4, Math.round(Math.max(W, H) / MS * 2)));
  const nx = Math.ceil(W / TILE), ny = Math.ceil(H / TILE);
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const x0 = tx * TILE, y0 = ty * TILE, x1 = Math.min(W, x0 + TILE), y1 = Math.min(H, y0 + TILE);
    const px0 = Math.max(0, x0 - PAD), py0 = Math.max(0, y0 - PAD), px1 = Math.min(W, x1 + PAD), py1 = Math.min(H, y1 + PAD);
    const w = px1 - px0, h = py1 - py0, img = ctx.getImageData(px0, py0, w, h).data;
    const I = new Float32Array(w * h), p = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      I[i] = (0.299 * img[i * 4] + 0.587 * img[i * 4 + 1] + 0.114 * img[i * 4 + 2]) / 255;
      p[i] = sample(maskLow, (px0 + x + .5) / W * MS - .5, (py0 + y + .5) / H * MS - .5);
    }
    const q = guided(I, p, w, h, r, 1e-3);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++)
      alpha[y * W + x] = Math.min(1, Math.max(0, q[(y - py0) * w + (x - px0)])) * 255;
    progress((ty * nx + tx + 1) / (nx * ny));
    status(`Kenarlar tam çözünürlükte inceleniyor: parça ${ty * nx + tx + 1}/${nx * ny}`);
    await new Promise(r => setTimeout(r));   // arayüz donmasın
  }
}

// ---------- alfa eğrisi (kaydırıcılar) ----------
function buildLut() {
  const hard = $('hard').value / 100, c = 0.5 + $('choke').value / 100 * 0.3;
  const w = 0.5 * (1 - hard) + 0.02, lo = c - w, hi = c + w;
  lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const t = Math.min(1, Math.max(0, (i / 255 - lo) / (hi - lo)));
    lut[i] = t * t * (3 - 2 * t) * 255;
  }
}

function drawPreview() {
  const k = Math.min(1, 1200 / Math.max(W, H)), pw = Math.round(W * k), ph = Math.round(H * k);
  for (const id of ['orig', 'res']) { $(id).width = pw; $(id).height = ph; }
  $('orig').getContext('2d').drawImage(src, 0, 0, pw, ph);
  const g = $('res').getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, pw, ph);
  const im = g.getImageData(0, 0, pw, ph);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++)
    im.data[(y * pw + x) * 4 + 3] = lut[alpha[Math.min(H - 1, (y / k) | 0) * W + Math.min(W - 1, (x / k) | 0)]];
  g.putImageData(im, 0, 0);
}

// ---------- ana akış ----------
window.addEventListener('unhandledrejection', e => status('Hata (' + stage + '): ' + errText(e.reason)));
window.addEventListener('error', e => status('Hata (' + stage + '): ' + errText(e.error || e.message)));

$('file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  stage = 'fotoğraf okuma'; status('Fotoğraf okunuyor: ' + f.name);
  name = f.name.replace(/\.[^.]+$/, '');
  for (const id of ['hard', 'choke', 'dl']) $(id).disabled = true;
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    W = bmp.width; H = bmp.height;
    src = document.createElement('canvas'); src.width = W; src.height = H;
    src.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0);
    await ensureSession();
    stage = 'maske hesaplama'; status('Ürün aranıyor…'); progress(0);
    maskLow = await predictMask(bmp);
    stage = 'kenar inceleme'; await refine();
    buildLut(); drawPreview();
    for (const id of ['hard', 'choke', 'dl']) $(id).disabled = false;
    progress(1); status(`Hazır: ${W}×${H} piksel. Kenar kaydırıcılarıyla ayarla, sonra indir.`);
  } catch (err) {
    console.error(err);
    status('Hata (' + stage + '): ' + errText(err) + (W * H > 1e8 ? ' (Fotoğraf bu tarayıcı için çok büyük olabilir.)' : ''));
  }
});
for (const id of ['hard', 'choke']) $(id).addEventListener('input', () => { if (alpha) { buildLut(); drawPreview(); } });

$('dl').addEventListener('click', async () => {
  $('dl').disabled = true; status('PNG hazırlanıyor (tam çözünürlük)…');
  try {
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const sg = src.getContext('2d', { willReadFrequently: true }), og = out.getContext('2d');
    for (let y0 = 0; y0 < H; y0 += TILE) for (let x0 = 0; x0 < W; x0 += TILE) {
      const w = Math.min(TILE, W - x0), h = Math.min(TILE, H - y0), im = sg.getImageData(x0, y0, w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) im.data[(y * w + x) * 4 + 3] = lut[alpha[(y0 + y) * W + x0 + x]];
      og.putImageData(im, x0, y0);
      await new Promise(r => setTimeout(r));
    }
    const blob = await new Promise(res => out.toBlob(res, 'image/png'));
    if (!blob) throw new Error('Tarayıcı bu boyutta PNG üretemedi.');
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '_seffaf.png'; a.click();
    status('İndirildi.');
  } catch (err) { status('Hata: ' + err.message); }
  $('dl').disabled = false;
});
