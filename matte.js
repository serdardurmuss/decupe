// Düz stüdyo zemininde fark tabanlı maske: zemini fotoğraftan öğrenir, üründen farkı alfa yapar.
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const fL = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;

export function rgb2lab(r, g, b, o, i) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const fx = fL((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const fy = fL(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const fz = fL((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  o[i] = 116 * fy - 16; o[i + 1] = 500 * (fx - fy); o[i + 2] = 200 * (fy - fz);
}
export function lab2rgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = t => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const g = c => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
  return [g(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z), g(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z), g(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z)];
}

const basis = (X, Y, o) => { o[0] = 1; o[1] = X; o[2] = Y; o[3] = X * X; o[4] = X * Y; o[5] = Y * Y; o[6] = X * X * X; o[7] = Y * Y * Y; o[8] = X * X * Y; o[9] = X * Y * Y; };
export function evalBg(coef, x, y, W, H, phi, out) {
  basis(((x + .5) / W - .5) * 2, ((y + .5) / H - .5) * 2, phi);
  for (let c = 0; c < 3; c++) { let s = 0; for (let k = 0; k < 10; k++) s += coef[c][k] * phi[k]; out[c] = s; }
}
export const dist = (dL, da, db) => { const w = dL > 0 ? 0.5 : 0.12; return Math.sqrt(w * w * dL * dL + da * da + db * db); };

function solve(A, b, n) {
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r * n + i]) > Math.abs(A[p * n + i])) p = r;
    if (p !== i) { for (let c = 0; c < n; c++) { const t = A[i * n + c]; A[i * n + c] = A[p * n + c]; A[p * n + c] = t; } const t = b[i]; b[i] = b[p]; b[p] = t; }
    const pv = A[i * n + i] || 1e-12;
    for (let r = i + 1; r < n; r++) { const f = A[r * n + i] / pv; if (!f) continue; for (let c = i; c < n; c++) A[r * n + c] -= f * A[i * n + c]; b[r] -= f * b[i]; }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i * n + c] * x[c]; x[i] = s / (A[i * n + i] || 1e-12); }
  return x;
}

// px: küçültülmüş RGBA (w x h). Dönüş: [L,a,b] için 10'ar katsayı.
export function fitBackground(px, w, h) {
  const n = w * h, lab = new Float32Array(n * 3), ch = new Float32Array(n);
  for (let i = 0; i < n; i++) { rgb2lab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], lab, i * 3); ch[i] = Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]); }
  const thr = Float32Array.from(ch).sort()[Math.floor(n * 0.7)];
  let bg = new Uint8Array(n); for (let i = 0; i < n; i++) bg[i] = ch[i] < thr ? 1 : 0;
  const phi = new Float64Array(10); let coef;
  for (let it = 0; it < 4; it++) {
    const AtA = new Float64Array(100), Atb = [new Float64Array(10), new Float64Array(10), new Float64Array(10)];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!bg[i]) continue;
      basis(((x + .5) / w - .5) * 2, ((y + .5) / h - .5) * 2, phi);
      for (let a = 0; a < 10; a++) { for (let c = 0; c < 10; c++) AtA[a * 10 + c] += phi[a] * phi[c]; for (let k = 0; k < 3; k++) Atb[k][a] += phi[a] * lab[i * 3 + k]; }
    }
    coef = Atb.map(v => solve(AtA.slice(), v.slice(), 10));
    const out = new Float64Array(3), hit = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; evalBg(coef, x, y, w, h, phi, out);
      if (dist(lab[i * 3] - out[0], lab[i * 3 + 1] - out[1], lab[i * 3 + 2] - out[2]) > 6) hit[i] = 1;
    }
    bg = new Uint8Array(n).fill(1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hit[y * w + x])
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w) bg[yy * w + xx] = 0; }
  }
  return coef;
}

// Parça için fark değeri (padded RGBA parça, çekirdek bölgesi [cx0,cy0,cw,ch]) -> Uint8 (d*4)
export function diffTile(px, w, h, ox, oy, W, H, coef, cx, cy, cw, chh, dq) {
  const d = new Float32Array(w * h), lab = new Float32Array(3), bgv = new Float64Array(3), phi = new Float64Array(10);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; rgb2lab(px[i], px[i + 1], px[i + 2], lab, 0);
    evalBg(coef, ox + x, oy + y, W, H, phi, bgv);
    d[y * w + x] = dist(lab[0] - bgv[0], lab[1] - bgv[1], lab[2] - bgv[2]);
  }
  for (let y = cy; y < cy + chh; y++) for (let x = cx; x < cx + cw; x++) {   // 3x3 binom. yumuşatma
    let s = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy)), xx = Math.min(w - 1, Math.max(0, x + dx)), wt = (2 - Math.abs(dx)) * (2 - Math.abs(dy));
      s += d[yy * w + xx] * wt; k += wt;
    }
    dq[(oy + y) * W + ox + x] = Math.min(255, Math.round(s / k * 4));
  }
}

export function makeLut(lo, hi) {
  const l = new Uint8ClampedArray(256);
  for (let q = 0; q < 256; q++) { const t = Math.min(1, Math.max(0, (q / 4 - lo) / (hi - lo))); l[q] = t * t * (3 - 2 * t) * 255; }
  return l;
}

// Ürünün içinde kalan (kenara bağlı olmayan) boşlukları bul; zeminden farklıysa ürün say.
export function holeMap(dq, W, H, lut, meanThr = 4.5) {
  const k = Math.max(1, Math.ceil(Math.max(W, H) / 1024)), lw = Math.ceil(W / k), lh = Math.ceil(H / k), n = lw * lh;
  const low = new Uint8Array(n);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) low[y * lw + x] = lut[dq[Math.min(H - 1, y * k) * W + Math.min(W - 1, x * k)]] < 128 ? 1 : 0;
  const lab = new Int32Array(n), fill = new Uint8Array(n), q = new Int32Array(n);
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (!low[s] || lab[s]) continue;
    id++; let head = 0, tail = 0, border = false, sum = 0; q[tail++] = s; lab[s] = id;
    const members = [];
    while (head < tail) {
      const p = q[head++], x = p % lw, y = (p / lw) | 0; members.push(p);
      sum += dq[Math.min(H - 1, y * k) * W + Math.min(W - 1, x * k)] / 4;
      if (x === 0 || y === 0 || x === lw - 1 || y === lh - 1) border = true;
      if (x > 0 && low[p - 1] && !lab[p - 1]) { lab[p - 1] = id; q[tail++] = p - 1; }
      if (x < lw - 1 && low[p + 1] && !lab[p + 1]) { lab[p + 1] = id; q[tail++] = p + 1; }
      if (y > 0 && low[p - lw] && !lab[p - lw]) { lab[p - lw] = id; q[tail++] = p - lw; }
      if (y < lh - 1 && low[p + lw] && !lab[p + lw]) { lab[p + lw] = id; q[tail++] = p + lw; }
    }
    if (!border && sum / members.length > meanThr) for (const p of members) fill[p] = 1;
  }
  return { fill, k, lw };
}
