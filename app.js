// Faz 2: leke silme (inpaint/doku kopyalama) ve kopyalama aracı. Tam çözünürlükte, alfa korunarak.
import { inpaint, addGrain, patchFill } from './heal.js?v=1';

const $ = id => document.getElementById(id);
const status = t => ($('status').textContent = t);
const view = $('view'), cv = $('cv'), ov = $('ov'), cur = $('cursor'), og = ov.getContext('2d');
let ctx, W = 0, H = 0, s = 1, tx = 0, ty = 0, name = 'urun';
let tool = 'heal', cloneSrc = null, cloneOff = null, drawing = false, pts = [], panning = false, space = false, last = null;
let tiles = null; const undo = [], TS = 256;
const R = () => +$('size').value;

// ---------- görünüm ----------
function applyView() {
  cv.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
  cv.style.imageRendering = s >= 3 ? 'pixelated' : 'auto';
  ov.width = view.clientWidth; ov.height = view.clientHeight; drawOverlay();
}
function fit() {
  const r = view.getBoundingClientRect();
  s = Math.min(1, (r.width - 8) / W, (r.height - 8) / H);
  tx = (r.width - W * s) / 2; ty = (r.height - H * s) / 2; applyView();
}
const toImg = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left - tx) / s, (e.clientY - r.top - ty) / s]; };
const toScr = p => [p[0] * s + tx, p[1] * s + ty];

function drawOverlay() {
  og.clearRect(0, 0, ov.width, ov.height);
  if (drawing && tool === 'heal' && pts.length) {
    og.strokeStyle = 'rgba(255,50,50,.55)'; og.fillStyle = 'rgba(255,50,50,.55)';
    og.lineWidth = R() * s; og.lineCap = og.lineJoin = 'round'; og.beginPath();
    pts.forEach((p, i) => { const q = toScr(p); i ? og.lineTo(q[0], q[1]) : og.moveTo(q[0], q[1]); });
    og.stroke();
    if (pts.length === 1) { const q = toScr(pts[0]); og.beginPath(); og.arc(q[0], q[1], R() * s / 2, 0, 7); og.fill(); }
  }
  if (tool === 'clone' && cloneSrc) {
    const p = drawing && cloneOff ? [pts[pts.length - 1][0] + cloneOff[0], pts[pts.length - 1][1] + cloneOff[1]] : cloneSrc, q = toScr(p);
    og.strokeStyle = '#3df'; og.lineWidth = 2; og.beginPath();
    og.moveTo(q[0] - 10, q[1]); og.lineTo(q[0] + 10, q[1]); og.moveTo(q[0], q[1] - 10); og.lineTo(q[0], q[1] + 10); og.stroke();
  }
}

// ---------- geri alma (değişen 256px parçalar saklanır) ----------
function saveRegion(x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  for (let ty_ = Math.floor(y0 / TS); ty_ <= Math.floor((y1 - 1) / TS); ty_++) for (let tx_ = Math.floor(x0 / TS); tx_ <= Math.floor((x1 - 1) / TS); tx_++) {
    const k = tx_ + ',' + ty_; if (tiles.has(k)) continue;
    const x = tx_ * TS, y = ty_ * TS; tiles.set(k, { x, y, d: ctx.getImageData(x, y, Math.min(TS, W - x), Math.min(TS, H - y)) });
  }
}
function commit() { if (tiles && tiles.size) { undo.push(tiles); if (undo.length > 25) undo.shift(); } tiles = null; $('undo').disabled = !undo.length; }
function doUndo() { const t = undo.pop(); if (!t) return; for (const v of t.values()) ctx.putImageData(v.d, v.x, v.y); $('undo').disabled = !undo.length; }

// ---------- kopyalama ----------
function dab(p) {
  const r = R() / 2, cx = Math.round(p[0]), cy = Math.round(p[1]);
  const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r)), x1 = Math.min(W, Math.ceil(cx + r) + 1), y1 = Math.min(H, Math.ceil(cy + r) + 1);
  const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) return;
  saveRegion(x0, y0, x1, y1);
  const dst = ctx.getImageData(x0, y0, w, h), sr = ctx.getImageData(x0 + Math.round(cloneOff[0]), y0 + Math.round(cloneOff[1]), w, h), D = dst.data, S = sr.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x0 + x - cx, y0 + y - cy); if (d > r) continue;
    let k = d < r * .5 ? 1 : 1 - (d - r * .5) / (r * .5); k = k * k * (3 - 2 * k) * .95;
    const i = (y * w + x) * 4; if (D[i + 3] === 0 || S[i + 3] < 200) continue;
    for (let c = 0; c < 3; c++) D[i + c] = D[i + c] * (1 - k) + S[i + c] * k;
  }
  ctx.putImageData(dst, x0, y0);
}
function dabLine(a, b) {
  const step = Math.max(1, R() / 6), n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  for (let i = 1; i <= n; i++) dab([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
}

// ---------- leke silme ----------
function applyHeal(path) {
  const rad = R() / 2 + 1; let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
  for (const [x, y] of path) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
  const x0 = Math.floor(bx0 - rad), y0 = Math.floor(by0 - rad), x1 = Math.ceil(bx1 + rad), y1 = Math.ceil(by1 + rad);
  const P = Math.max(40, Math.round(Math.max(x1 - x0, y1 - y0) * .8) + 24);
  const wx0 = Math.max(0, x0 - P), wy0 = Math.max(0, y0 - P), wx1 = Math.min(W, x1 + P), wy1 = Math.min(H, y1 + P), w = wx1 - wx0, h = wy1 - wy0;
  if (w < 8 || h < 8) return;
  const mc = new OffscreenCanvas(w, h), mg = mc.getContext('2d');
  mg.strokeStyle = mg.fillStyle = '#fff'; mg.lineWidth = R() + 2; mg.lineCap = mg.lineJoin = 'round'; mg.beginPath();
  path.forEach(([x, y], i) => i ? mg.lineTo(x - wx0, y - wy0) : mg.moveTo(x - wx0, y - wy0)); mg.stroke();
  mg.beginPath(); mg.arc(path[0][0] - wx0, path[0][1] - wy0, rad, 0, 7); mg.fill();
  const m = mg.getImageData(0, 0, w, h).data, im = ctx.getImageData(wx0, wy0, w, h), d = im.data, n = w * h;
  const rgb = new Float32Array(n * 3), known = new Float32Array(n), hole = new Float32Array(n); let holes = 0;
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
    if (m[i * 4 + 3] > 127 && d[i * 4 + 3] > 0) { hole[i] = 1; holes++; } else known[i] = d[i * 4 + 3] / 255;
  }
  if (!holes) return;
  const mode = $('mode').value; let filled = null, used = '';
  if (mode !== 'smooth' && n <= 160000) {
    const p = patchFill(rgb, known, w, h, n > 60000 ? 3 : 2);
    if (p && (mode === 'texture' || p.texture > 8)) { filled = p.filled; used = 'doku kopyalama'; }
  }
  if (!filled) {
    filled = inpaint(rgb, known, w, h);
    if (!filled) { status('Çevrede kullanılabilir ürün yüzeyi bulunamadı, fırçayı küçült veya yerini değiştir.'); return; }
    addGrain(filled, rgb, known, w, h, +$('grain').value / 100, (wx0 * 7919 + wy0) | 1); used = 'yumuşak doldurma';
  }
  let soft = hole;                                             // kenarı 2px yumuşat
  for (let it = 0; it < 2; it++) {
    const t = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w) { a += soft[yy * w + xx]; c++; } }
      t[y * w + x] = a / c;
    }
    soft = t;
  }
  saveRegion(wx0, wy0, wx1, wy1);
  for (let i = 0; i < n; i++) {
    const k = hole[i] ? 1 : Math.min(1, soft[i] * 1.6); if (k <= 0 || d[i * 4 + 3] === 0) continue;
    for (let c = 0; c < 3; c++) d[i * 4 + c] = Math.min(255, Math.max(0, rgb[i * 3 + c] * (1 - k) + filled[i * 3 + c] * k));
  }
  ctx.putImageData(im, wx0, wy0); status('Leke silindi (' + used + ').');
}

// ---------- fare / dokunma ----------
view.addEventListener('contextmenu', e => e.preventDefault());
view.addEventListener('pointerdown', e => {
  if (!W) return; view.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || space) { panning = true; last = [e.clientX, e.clientY]; return; }
  if (e.button !== 0) return;
  const p = toImg(e);
  if (tool === 'clone' && e.altKey) { cloneSrc = p; cloneOff = null; drawOverlay(); status('Kaynak seçildi. Şimdi kopyalamak istediğin yeri boya.'); return; }
  if (tool === 'clone' && !cloneSrc) { status('Önce Option (Alt) tuşuna basılı tutarak kopyalanacak yeri tıkla.'); return; }
  drawing = true; pts = [p]; tiles = new Map();
  if (tool === 'clone') { if (!cloneOff) cloneOff = [cloneSrc[0] - p[0], cloneSrc[1] - p[1]]; dab(p); }
  drawOverlay();
});
view.addEventListener('pointermove', e => {
  const r = view.getBoundingClientRect(); cur.style.display = 'block';
  cur.style.left = e.clientX - r.left + 'px'; cur.style.top = e.clientY - r.top + 'px'; cur.style.width = cur.style.height = Math.max(4, R() * s) + 'px';
  if (panning) { tx += e.clientX - last[0]; ty += e.clientY - last[1]; last = [e.clientX, e.clientY]; applyView(); return; }
  if (!drawing) return;
  const p = toImg(e), a = pts[pts.length - 1];
  if (tool === 'clone') dabLine(a, p);
  pts.push(p); drawOverlay();
});
const up = () => {
  if (panning) { panning = false; return; }
  if (!drawing) return; drawing = false;
  if (tool === 'heal') applyHeal(pts);
  commit(); pts = []; drawOverlay();
};
view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
view.addEventListener('pointerleave', () => (cur.style.display = 'none'));
view.addEventListener('wheel', e => {
  if (!W) return; e.preventDefault();
  const r = view.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, ns = Math.min(24, Math.max(.05, s * Math.exp(-e.deltaY * .0015)));
  tx = mx - (mx - tx) * ns / s; ty = my - (my - ty) * ns / s; s = ns; applyView();
}, { passive: false });
addEventListener('keydown', e => {
  if (e.code === 'Space' && !/INPUT|SELECT/.test(document.activeElement.tagName)) { space = true; e.preventDefault(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
});
addEventListener('keyup', e => { if (e.code === 'Space') space = false; });
addEventListener('resize', () => W && applyView());

// ---------- kontroller ----------
for (const r of document.querySelectorAll('input[name=tool]')) r.addEventListener('change', () => {
  tool = r.value; $('healOpts').style.display = tool === 'heal' ? '' : 'none'; drawOverlay();
});
$('size').addEventListener('input', () => ($('sizeV').textContent = R()));
$('bgsel').addEventListener('change', () => { const v = $('bgsel').value; view.style.background = v === 'white' ? '#fff' : v === 'dark' ? '#15171b' : ''; });
$('undo').addEventListener('click', doUndo);
$('fit').addEventListener('click', fit);
$('file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    name = f.name.replace(/\.[^.]+$/, ''); status('Fotoğraf okunuyor…');
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    W = bmp.width; H = bmp.height; cv.width = W; cv.height = H;
    ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0);
    undo.length = 0; cloneSrc = cloneOff = null; fit();
    for (const id of ['undo', 'fit', 'dl']) $(id).disabled = id === 'undo';
    status(`${W}×${H} piksel yüklendi. Lekenin üzerini boya.`);
  } catch (err) { status('Hata: ' + (err?.message || err)); }
});
$('dl').addEventListener('click', () => cv.toBlob(b => {
  if (!b) return status('Tarayıcı bu boyutta PNG üretemedi.');
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name + '_temiz.png'; a.click(); status('İndirildi.');
}, 'image/png'));
