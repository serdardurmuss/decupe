// Leke silme çekirdeği: "push-pull" doldurma (çevre renklerinden yumuşak geçişli doldurur) + gren ekleme.
// rgb: Float32Array(w*h*3, 0..255), known: Float32Array(w*h, 0..1; 0 = silinecek/bilinmeyen).
export function inpaint(rgb, known, w, h) {
  const P = [], WT = [], D = [];
  let cw = w, ch = h, p = new Float32Array(w * h * 3), wt = Float32Array.from(known);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) p[i * 3 + c] = rgb[i * 3 + c] * known[i];
  P.push(p); WT.push(wt); D.push([cw, ch]);
  while (cw > 1 || ch > 1) {                                   // push: küçült
    const nw = Math.max(1, (cw + 1) >> 1), nh = Math.max(1, (ch + 1) >> 1);
    const np = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = y * cw + x, j = (y >> 1) * nw + (x >> 1);
      nwt[j] += wt[i] / 4; for (let c = 0; c < 3; c++) np[j * 3 + c] += p[i * 3 + c] / 4;
    }
    p = np; wt = nwt; cw = nw; ch = nh; P.push(p); WT.push(wt); D.push([cw, ch]);
  }
  const L = P.length - 1;
  if (!(WT[L][0] > 0)) return null;                            // hiç bilinen piksel yok
  let filled = new Float32Array(3);
  for (let c = 0; c < 3; c++) filled[c] = P[L][c] / WT[L][0];
  for (let l = L - 1; l >= 0; l--) {                           // pull: büyüt ve doldur
    const [lw, lh] = D[l], [sw, sh] = D[l + 1], out = new Float32Array(lw * lh * 3), pl = P[l], wl = WT[l];
    for (let y = 0; y < lh; y++) {
      const fy = Math.min(sh - 1, Math.max(0, (y + .5) / 2 - .5)), y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < lw; x++) {
        const fx = Math.min(sw - 1, Math.max(0, (x + .5) / 2 - .5)), x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        const i = y * lw + x, k = 1 - Math.min(1, wl[i]);
        for (let c = 0; c < 3; c++) {
          const up = (filled[(y0 * sw + x0) * 3 + c] * (1 - tx) + filled[(y0 * sw + x1) * 3 + c] * tx) * (1 - ty) +
                     (filled[(y1 * sw + x0) * 3 + c] * (1 - tx) + filled[(y1 * sw + x1) * 3 + c] * tx) * ty;
          out[i * 3 + c] = pl[i * 3 + c] + k * up;
        }
      }
    }
    filled = out;
  }
  return filled;
}

// Doldurulan yerde plastik görünmesin diye çevredeki gren (ince doku) kadar gürültü ekler.
export function addGrain(filled, rgb, known, w, h, amount, seed = 1) {
  let s = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (known[i] < 1) continue;
    const g = c => rgb[i * 3 + c] - (rgb[(i - 1) * 3 + c] + rgb[(i + 1) * 3 + c] + rgb[(i - w) * 3 + c] + rgb[(i + w) * 3 + c]) / 4;
    s += g(1) * g(1); n++;
  }
  const sd = n ? Math.sqrt(s / n) * 0.9 : 0;
  let r = seed >>> 0; const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < w * h; i++) {
    const m = 1 - Math.min(1, known[i]); if (m <= 0) continue;
    const u = Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(6.2831853 * rnd()) * sd * amount * m;
    for (let c = 0; c < 3; c++) filled[i * 3 + c] += u;
  }
}

// Dokulu yüzey (mat, kazıma, fırçalı): çevresiyle en iyi uyuşan komşu parçayı bulup deliğe kopyalar,
// sonra çevreyle renk/parlaklık farkını düzeltir. Dönüş: {filled, score, texture} veya null.
export function patchFill(rgb, known, w, h, step = 2) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1; const hole = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (known[y * w + x] < 0.5) { hole.push(y * w + x); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (!hole.length) return null;
  const m = 6, ring = [];
  for (let y = Math.max(0, y0 - m); y <= Math.min(h - 1, y1 + m); y++) for (let x = Math.max(0, x0 - m); x <= Math.min(w - 1, x1 + m); x++) {
    const i = y * w + x; if (known[i] >= 1 && ((x + y) & 1) === 0) ring.push(i);
  }
  if (ring.length < 20) return null;
  const lum = i => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  let best = Infinity, bdx = 0, bdy = 0;
  for (let dy = -h + 1; dy < h; dy += step) for (let dx = -w + 1; dx < w; dx += step) {
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) continue;
    let ok = true;
    for (let k = 0; k < hole.length && ok; k += 3) {
      const x = (hole[k] % w) + dx, y = ((hole[k] / w) | 0) + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || known[y * w + x] < 1) ok = false;
    }
    if (!ok) continue;
    let s = 0, n = 0;
    for (let k = 0; k < ring.length; k++) {
      const x = (ring[k] % w) + dx, y = ((ring[k] / w) | 0) + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || known[y * w + x] < 1) continue;
      const a = rgb[ring[k] * 3] - rgb[(y * w + x) * 3], b = rgb[ring[k] * 3 + 1] - rgb[(y * w + x) * 3 + 1], c = rgb[ring[k] * 3 + 2] - rgb[(y * w + x) * 3 + 2];
      s += a * a + b * b + c * c; n++;
      if (s > best * Math.max(n, 1) && n > 20) { n = 0; break; }
    }
    if (n < ring.length * 0.7) continue;
    if (s / n < best) { best = s / n; bdx = dx; bdy = dy; }
  }
  if (!isFinite(best)) return null;
  const out = Float32Array.from(rgb), dm = [0, 0, 0]; let cnt = 0;
  for (const i of ring) {
    const x = (i % w) + bdx, y = ((i / w) | 0) + bdy;
    if (x < 0 || y < 0 || x >= w || y >= h || known[y * w + x] < 1) continue;
    for (let c = 0; c < 3; c++) dm[c] += rgb[i * 3 + c] - rgb[(y * w + x) * 3 + c]; cnt++;
  }
  for (let c = 0; c < 3; c++) dm[c] /= Math.max(1, cnt);
  for (const i of hole) {
    const s = ((((i / w) | 0) + bdy) * w + (i % w) + bdx) * 3;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(255, Math.max(0, rgb[s + c] + dm[c]));
  }
  let ls = 0, ln = 0;                                           // çevrenin doku şiddeti
  for (const i of ring) if (i % w > 0 && i % w < w - 1) { const g = lum(i) - (lum(i - 1) + lum(i + 1)) / 2; ls += g * g; ln++; }
  return { filled: out, score: Math.sqrt(best), texture: Math.sqrt(ls / Math.max(1, ln)), offset: [bdx, bdy] };
}
