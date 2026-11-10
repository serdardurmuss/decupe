# Ürün Retouch – Faz 1

Arka plan silme + tam çözünürlükte kenar rafine etme + şeffaf PNG çıktısı. Sunucu yok, ücret yok.

## Ücretsiz yayınlama (GitHub Pages)
1. github.com'da ücretsiz hesap aç, yeni bir repo oluştur (ör. `retouch`).
2. `index.html`, `app.js` ve bu `README.md` dosyalarını repoya yükle.
3. Settings → Pages → Branch: `main`, klasör: `/ (root)` → Save.
4. Birkaç dakika sonra `https://KULLANICI.github.io/retouch/` adresi açılır.

Cloudflare Pages veya Netlify'a klasörü sürükle-bırak ile de yüklenebilir.
Not: `index.html` çift tıklayıp açılmaz; HTTPS adres gerekir.

## Notlar
- İlk açılışta model (BiRefNet_lite, yüzlerce MB) indirilir, sonra tarayıcı önbelleğinden gelir.
- WebGPU destekleyen masaüstü Chrome/Edge hızlıdır; olmayan cihazlarda yavaş (WASM) çalışır.
- Model adresi `app.js` başındaki `MODEL_URL`. Ticari kullanım öncesi modelin lisansını Hugging Face sayfasından doğrula.
- Çok büyük fotoğraflarda tarayıcının canvas limiti sınır olur; hata mesajı gösterilir.
