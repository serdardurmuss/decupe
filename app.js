// Faz 1 (v4): düz stüdyo zemininde, fotoğrafın kendi zemin rengini öğrenerek tam çözünürlükte arka plan silme.
// Yapay zeka modeli yok, indirme yok; ince zincir detayları kaybolmaz. Her şey tarayıcıda çalışır.
import { fitBackground, diffTile, makeLut, holeMap, evalBg, lab2rgb } from './matte.js?v=4';

const TILE = 1024, PAD = 2;
const $ = id => document.getElementById(id);
const status = t => ($('status').textContent = t);
const progress = f => ($('bar').firstElementChild.style.width = Math.round(f * 100) + '%');
const tick = () => new Promise(r => setTimeout(r));

let src, W, H, coef, dq, lut, holes, name = 'urun';
const ctrl = ['lo', 'soft', 'fill', 'dl'];

// ---------- analiz ----------
async function analyze(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  W = bmp.width; H = bmp.height;
  src = document.createElement('canvas'); src.width = W; src.height = H;
  const sg = src.getContext('2d', { willReadFrequently: true });
  sg.drawImage(bmp, 0, 0);

  status('Zemin rengi öğreniliyor…');
  const k = Math.min(1, 320 / Math.max(W, H)), sw = Math.max(16, Math.round(W * k)), sh = Math.max(16, Math.round(H * k));
  const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
  const cg = sc.getContext('2d', { willReadFrequently: true });
  cg.imageSmoothingQuality = 'high'; cg.drawImage(src, 0, 0, sw, sh);
  coef = fitBackground(cg.getImageData(0, 0, sw, sh).data, sw, sh);

  dq = new Uint8Array(W * H);
  const nx = Math.ceil(W / TILE), ny = Math.ceil(H / TILE);
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const x0 = tx * TILE, y0 = ty * TILE, x1 = Math.min(W, x0 + TILE), y1 = Math.min(H, y0 + TILE);
    const px0 = Math.max(0, x0 - PAD), py0 = Math.max(0, y0 - PAD), px1 = Math.min(W, x1 + PAD), py1 = Math.min(H, y1 + PAD);
    const w = px1 - px0, h = py1 - py0, im = sg.getImageData(px0, py0, w, h);
    diffTile(im.data, w, h, px0, py0, W, H, coef, x0 - px0, y0 - py0, x1 - x0, y1 - y0, dq);
    progress((ty * nx + tx + 1) / (nx * ny));
    status(`Ürün tam çözünürlükte ayrılıyor: parça ${ty * nx + tx + 1}/${nx * ny}`);
    await tick();
  }
}

// ---------- alfa ----------
function refresh() {
  const lo = +$('lo').value, soft = +$('soft').value;
  lut = makeLut(lo, lo + soft);
  holes = $('fill').checked ? holeMap(dq, W, H, lut) : null;
  drawPreview();
}
function alphaAt(x, y) {
  const a = lut[dq[y * W + x]];
  if (a < 128 && holes && holes.fill[((y / holes.k) | 0) * holes.lw + ((x / holes.k) | 0)]) return 255;
  return a;
}
// im: kaynak renkleri taşıyan ImageData; mx/my: çıktı pikselinin tam çözünürlükteki karşılığı.
// Yarı saydam kenar piksellerinden eski zemin rengini çıkarır (halo olmaz).
function render(im, w, h, mx, my) {
  const d = im.data, phi = new Float64Array(10), bl = new Float64Array(3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = mx(x), fy = my(y), a = alphaAt(fx, fy) / 255, i = (y * w + x) * 4;
    if (a <= 0.004) { d[i + 3] = 0; continue; }
    if (a < 0.996) {
      evalBg(coef, fx, fy, W, H, phi, bl);
      const B = lab2rgb(bl[0], bl[1], bl[2]);
      for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, Math.max(0, (d[i + c] - (1 - a) * B[c] * 255) / a));
    }
    d[i + 3] = a * 255;
  }
}

function drawPreview() {
  const k = Math.min(1, 1200 / Math.max(W, H)), pw = Math.round(W * k), ph = Math.round(H * k);
  for (const id of ['orig', 'res']) { $(id).width = pw; $(id).height = ph; }
  const og = $('orig').getContext('2d'); og.imageSmoothingQuality = 'high'; og.drawImage(src, 0, 0, pw, ph);
  const g = $('res').getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, pw, ph);
  const im = g.getImageData(0, 0, pw, ph);
  render(im, pw, ph, x => Math.min(W - 1, ((x + .5) / pw * W) | 0), y => Math.min(H - 1, ((y + .5) / ph * H) | 0));
  g.putImageData(im, 0, 0);
}

function setStageBg() {
  const v = $('bgsel').value;
  for (const s of document.querySelectorAll('.stage'))
    s.style.background = v === 'white' ? '#fff' : v === 'dark' ? '#15171b' : '';
}

// ---------- olaylar ----------
$('file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  name = f.name.replace(/\.[^.]+$/, '');
  for (const id of ctrl) $(id).disabled = true;
  try {
    status('Fotoğraf okunuyor: ' + f.name); progress(0);
    await analyze(f);
    refresh();
    for (const id of ctrl) $(id).disabled = false;
    progress(1); status(`Hazır: ${W}×${H} piksel. Sonucu beyaz ve koyu zeminde de kontrol et, sonra indir.`);
  } catch (err) {
    console.error(err);
    status('Hata: ' + (err?.message || err) + (W * H > 1e8 ? ' (Fotoğraf bu tarayıcı için çok büyük olabilir.)' : ''));
  }
});
for (const id of ['lo', 'soft', 'fill']) $(id).addEventListener('input', () => dq && refresh());
$('bgsel').addEventListener('change', setStageBg);

$('dl').addEventListener('click', async () => {
  $('dl').disabled = true; status('PNG hazırlanıyor (tam çözünürlük)…');
  try {
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const sg = src.getContext('2d', { willReadFrequently: true }), og = out.getContext('2d');
    for (let y0 = 0; y0 < H; y0 += TILE) for (let x0 = 0; x0 < W; x0 += TILE) {
      const w = Math.min(TILE, W - x0), h = Math.min(TILE, H - y0), im = sg.getImageData(x0, y0, w, h);
      render(im, w, h, x => x0 + x, y => y0 + y);
      og.putImageData(im, x0, y0);
      await tick();
    }
    const blob = await new Promise(res => out.toBlob(res, 'image/png'));
    if (!blob) throw new Error('Tarayıcı bu boyutta PNG üretemedi.');
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '_seffaf.png'; a.click();
    status('İndirildi.');
  } catch (err) { status('Hata: ' + (err?.message || err)); }
  $('dl').disabled = false;
});
