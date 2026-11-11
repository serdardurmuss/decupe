// Tam otomatik ürün retouch: arka plan silme + toz/leke temizleme + renk ve ışıltı iyileştirme.
// Saf fonksiyonlar: tarayıcıda da Node'da da çalışır.
import { fitBackground, diffTile, makeLut, holeMap, evalBg, lab2rgb, rgb2lab } from './matte.js';
import { inpaint, addGrain } from './heal.js';

const TILE = 1024, PAD = 48;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const tick = () => new Promise(r => setTimeout(r));

export const PRESETS = { hafif: 0.6, orta: 1, guclu: 1.5 };

function box(a, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h), d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let s = 0;
    for (let x = -r; x <= r; x++) s += a[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) { t[row + x] = s / d; s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) { o[y * w + x] = s / d; s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; }
  }
  return o;
}
// Maskeli (sadece ürün pikselleriyle) yumuşatma: zemin rengi karışmaz.
function nblur(v, m, w, h, r) {
  const vm = new Float32Array(w * h); for (let i = 0; i < vm.length; i++) vm[i] = v[i] * m[i];
  const n = box(vm, w, h, r), d = box(m, w, h, r), o = new Float32Array(w * h);
  for (let i = 0; i < o.length; i++) o[i] = d[i] > 1e-3 ? n[i] / d[i] : v[i];
  return o;
}

// ---- tek parça işleme ----
function processTile(src, ox, oy, w, h, core, X) {
  const { W, H, coef, alphaAt, k, wb, lowAt } = X, n = w * h;
  const rgb = new Float32Array(n * 3), al = new Float32Array(n), phi = new Float64Array(10), bl = new Float64Array(3);
  const bgf = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; al[i] = alphaAt(ox + x, oy + y) / 255; bgf[i] = al[i] < 0.05 ? 1 : 0; }
  const near = box(bgf, w, h, 2);                                   // gerçek zemine 2px içinde mi?
  for (let i = 0; i < n; i++) if (al[i] >= 0.004 && al[i] < 0.996 && near[i] < 0.001) al[i] = 1;   // içteki yarı saydam pikseller ürünün parçası
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {      // eski zemin rengini sadece kenar piksellerinden çıkar
    const i = y * w + x, a = al[i];
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = src[i * 4 + c];
    if (a > 0.004 && a < 0.996) {
      evalBg(coef, ox + x, oy + y, W, H, phi, bl); const B = lab2rgb(bl[0], bl[1], bl[2]);
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = clamp((rgb[i * 3 + c] - (1 - a) * B[c] * 255) / a, 0, 255);
    }
  }
  const pm = new Float32Array(n), L = new Float32Array(n);
  for (let i = 0; i < n; i++) { pm[i] = al[i] > 0.95 ? 1 : 0; L[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]; }

  // 1) Toz / leke: sadece düzgün yüzeylerde, küçük, çevresinden belirgin farklı lekeler
  let specks = 0;
  if (k.speck > 0) {
    const Lb = nblur(L, pm, w, h, 5), g = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; g[i] = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + w] - L[i - w]); }
    const gs = nblur(g, pm, w, h, 10), inner = box(pm, w, h, 4), cand = new Uint8Array(n);
    for (let i = 0; i < n; i++) cand[i] = inner[i] > 0.999 && Math.abs(L[i] - Lb[i]) > k.T && gs[i] < k.GT ? 1 : 0;
    const maxDim = Math.max(10, Math.round(Math.max(W, H) * 0.02)), seen = new Uint8Array(n), q = new Int32Array(n), hole = new Uint8Array(n);
    const comps = [];
    for (let s0 = 0; s0 < n; s0++) {
      if (!cand[s0] || seen[s0]) continue;
      let head = 0, tail = 0, bx0 = w, by0 = h, bx1 = 0, by1 = 0; q[tail++] = s0; seen[s0] = 1;
      while (head < tail) {
        const p = q[head++], x = p % w, y = (p / w) | 0;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        for (const nb of [p - 1, p + 1, p - w, p + w]) if (nb >= 0 && nb < n && cand[nb] && !seen[nb] && Math.abs((nb % w) - x) <= 1) { seen[nb] = 1; q[tail++] = nb; }
      }
      const cx = (bx0 + bx1) >> 1, cy = (by0 + by1) >> 1;
      if (tail >= 3 && Math.max(bx1 - bx0, by1 - by0) <= maxDim && cx >= core.cx && cx < core.cx + core.cw && cy >= core.cy && cy < core.cy + core.ch) {
        comps.push([bx0, by0, bx1, by1]);
        for (let t = 0; t < tail; t++) { const p = q[t], x = p % w, y = (p / w) | 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w) hole[yy * w + xx] = 1; } }
      }
    }
    for (const [bx0, by0, bx1, by1] of comps) {
      const x0 = Math.max(0, bx0 - 20), y0 = Math.max(0, by0 - 20), x1 = Math.min(w, bx1 + 21), y1 = Math.min(h, by1 + 21), ww = x1 - x0, hh = y1 - y0;
      const sub = new Float32Array(ww * hh * 3), kn = new Float32Array(ww * hh); let any = false;
      for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) {
        const i = (y0 + y) * w + x0 + x, j = y * ww + x; for (let c = 0; c < 3; c++) sub[j * 3 + c] = rgb[i * 3 + c];
        if (hole[i]) any = true; else kn[j] = al[i];
      }
      if (!any) continue;
      const f = inpaint(sub, kn, ww, hh); if (!f) continue; addGrain(f, sub, kn, ww, hh, 0.4, (x0 * 31 + y0 + ox) | 1);
      for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) { const i = (y0 + y) * w + x0 + x; if (hole[i]) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = clamp(f[(y * ww + x) * 3 + c], 0, 255); }
      specks++;
    }
    for (let i = 0; i < n; i++) L[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  }

  // 2) Renk ve ışıltı
  const lab = new Float32Array(3), A = new Float32Array(n), B_ = new Float32Array(n), LL = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    rgb2lab(Math.round(clamp(rgb[i * 3], 0, 255)), Math.round(clamp(rgb[i * 3 + 1], 0, 255)), Math.round(clamp(rgb[i * 3 + 2], 0, 255)), lab, 0);
    LL[i] = lab[0]; A[i] = lab[1]; B_[i] = lab[2];
  }
  const Ad = nblur(A, pm, w, h, 2), Bd = nblur(B_, pm, w, h, 2);        // JPEG renk gürültüsünü azalt
  for (let i = 0; i < n; i++) { A[i] = A[i] * 0.4 + Ad[i] * 0.6; B_[i] = B_[i] * 0.4 + Bd[i] * 0.6; }
  const Lg = nblur(LL, pm, w, h, 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (al[i] <= 0.004) continue;
    let l = LL[i], a = A[i] - wb[0] * 0.8, b = B_[i] - wb[1] * 0.8;
    const [lo, wt] = lowAt(ox + x, oy + y);                              // yerel kontrast (netlik)
    l += k.clarity * (l - lo) * (wt / (wt + 0.08));
    let t = l / 100; t = 0.55 + (t - 0.55) * (1 + 0.10 * k.amt);          // kontrast
    if (t > 0.75) t += 0.04 * k.amt * (t - 0.75) / 0.25;                  // parlak noktaları ışıt
    l = clamp(t * 100, 0, 100);
    const d = LL[i] - Lg[i], dc = Math.sign(d) * Math.max(0, Math.abs(d) - 0.7);   // keskinlik (gürültüyü büyütmeden)
    l = clamp(l + k.sharp * dc * pm[i], 0, 100);
    const c = Math.hypot(a, b), sc = 1 + 0.07 * k.amt * (1 - Math.min(1, c / 60)); a *= sc; b *= sc;
    const o = lab2rgb(l, a, b); for (let q = 0; q < 3; q++) rgb[i * 3 + q] = o[q] * 255;
  }
  const out = new Uint8ClampedArray(core.cw * core.ch * 4);
  for (let y = 0; y < core.ch; y++) for (let x = 0; x < core.cw; x++) {
    const i = (core.cy + y) * w + core.cx + x, j = (y * core.cw + x) * 4;
    out[j] = rgb[i * 3]; out[j + 1] = rgb[i * 3 + 1]; out[j + 2] = rgb[i * 3 + 2]; out[j + 3] = al[i] * 255;
  }
  return { out, specks };
}

// ---- tüm görüntü ----
// getTile(x,y,w,h) -> RGBA; putTile(x,y,w,h,rgba); small: {px,w,h} küçültülmüş RGBA (en uzun kenar ~320)
export async function runPipeline({ W, H, getTile, putTile, small, strength = 'orta', lo = 8, soft = 14, fill = true, progress = () => {} }) {
  const amt = PRESETS[strength] ?? 1;
  const k = { amt, speck: 1, T: 7 - 2 * (amt - 1), GT: 5, clarity: 0.22 * amt, sharp: 0.55 * amt };
  const coef = fitBackground(small.px, small.w, small.h), dq = new Uint8Array(W * H);
  const nx = Math.ceil(W / TILE), ny = Math.ceil(H / TILE), tot = nx * ny;
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const x0 = tx * TILE, y0 = ty * TILE, x1 = Math.min(W, x0 + TILE), y1 = Math.min(H, y0 + TILE);
    const px0 = Math.max(0, x0 - 2), py0 = Math.max(0, y0 - 2), px1 = Math.min(W, x1 + 2), py1 = Math.min(H, y1 + 2);
    diffTile(getTile(px0, py0, px1 - px0, py1 - py0), px1 - px0, py1 - py0, px0, py0, W, H, coef, x0 - px0, y0 - py0, x1 - x0, y1 - y0, dq);
    progress('Ürün ayrılıyor', (ty * nx + tx + 1) / tot / 3); await tick();
  }
  const lut = makeLut(lo, lo + soft), holes = fill ? holeMap(dq, W, H, makeLut(lo + 4, lo + 4 + soft), 2.5, 0.0005 * W * H) : null;   // delik tespiti biraz daha sıkı eşikle
  const hk = holes ? holes.k : 1, hlw = holes ? holes.lw : 1, hlh = holes ? Math.ceil(H / hk) : 1;
  const alphaAt = (x, y) => {
    const a = lut[dq[y * W + x]];
    if (!holes || a >= 200) return a;
    const fx = clamp((x + .5) / hk - .5, 0, hlw - 1), fy = clamp((y + .5) / hk - .5, 0, hlh - 1), x0 = fx | 0, y0 = fy | 0, x1 = Math.min(hlw - 1, x0 + 1), y1 = Math.min(hlh - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    let v1 = 0, v2 = 0;
    for (const [xx, yy, wt] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]]) {
      const f = holes.fill[yy * hlw + xx]; if (f === 1) v1 += wt; else if (f === 2) v2 += wt;
    }
    const s1 = clamp((v1 - .35) / .3, 0, 1), s2 = clamp((v2 - .35) / .3, 0, 1);
    return Math.max(a * (1 - s2), 255 * s1);
  };
  const phi = new Float64Array(10), bl = new Float64Array(3); evalBg(coef, W / 2, H / 2, W, H, phi, bl);
  const wb = [clamp(bl[1], -8, 8), clamp(bl[2], -8, 8)];
  // düşük çözünürlüklü ürün parlaklığı (yerel kontrast için)
  const sw = small.w, sh = small.h, Ls = new Float32Array(sw * sh), Ws = new Float32Array(sw * sh), lab = new Float32Array(3);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = y * sw + x; rgb2lab(small.px[i * 4], small.px[i * 4 + 1], small.px[i * 4 + 2], lab, 0);
    Ls[i] = lab[0]; Ws[i] = alphaAt(Math.min(W - 1, ((x + .5) / sw * W) | 0), Math.min(H - 1, ((y + .5) / sh * H) | 0)) / 255;
  }
  const Ln = nblur(Ls, Ws, sw, sh, 4), Wn = box(Ws, sw, sh, 4);
  const lowAt = (fx, fy) => {
    const x = clamp((fx + .5) / W * sw - .5, 0, sw - 1), y = clamp((fy + .5) / H * sh - .5, 0, sh - 1), x0 = x | 0, y0 = y | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), tx = x - x0, ty = y - y0;
    const bi = (A) => (A[y0 * sw + x0] * (1 - tx) + A[y0 * sw + x1] * tx) * (1 - ty) + (A[y1 * sw + x0] * (1 - tx) + A[y1 * sw + x1] * tx) * ty;
    return [bi(Ln), bi(Wn)];
  };
  const X = { W, H, coef, alphaAt, k, wb, lowAt };
  let specks = 0;
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const x0 = tx * TILE, y0 = ty * TILE, x1 = Math.min(W, x0 + TILE), y1 = Math.min(H, y0 + TILE);
    const px0 = Math.max(0, x0 - PAD), py0 = Math.max(0, y0 - PAD), px1 = Math.min(W, x1 + PAD), py1 = Math.min(H, y1 + PAD);
    const r = processTile(getTile(px0, py0, px1 - px0, py1 - py0), px0, py0, px1 - px0, py1 - py0, { cx: x0 - px0, cy: y0 - py0, cw: x1 - x0, ch: y1 - y0 }, X);
    specks += r.specks; putTile(x0, y0, x1 - x0, y1 - y0, r.out);
    progress('Temizleniyor ve parlatılıyor', 1 / 3 + (ty * nx + tx + 1) / tot * 2 / 3); await tick();
  }
  return { specks };
}
