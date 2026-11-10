# Ürün Retouch – Faz 1

Arka plan silme + tam çözünürlükte kenar rafine etme + şeffaf PNG çıktısı. Sunucu yok, ücret yok.

## Ücretsiz yayınlama (GitHub Pages)
1. github.com'da ücretsiz hesap aç, yeni bir repo oluştur (ör. `retouch`).
2. `index.html`, `app.js` ve bu `README.md` dosyalarını repoya yükle.
3. Settings → Pages → Branch: `main`, klasör: `/ (root)` → Save.
4. Birkaç dakika sonra `https://KULLANICI.github.io/retouch/` adresi açılır.

Cloudflare Pages veya Netlify'a klasörü sürükle-bırak ile de yüklenebilir.
Not: `index.html` çift tıklayıp açılmaz; HTTPS adres gerekir.

## Dosyalar (hepsi aynı klasörde, ana dizinde olmalı)
`index.html`, `app.js`, `matte.js`, `README.md`

## Notlar
- Yöntem: fotoğraftaki düz stüdyo zeminin rengini öğrenir, üründen farkı tam çözünürlükte alfa yapar. Model indirmez.
- Düz/yumuşak degrade zemin için tasarlandı. Desenli veya karmaşık zeminde çalışmaz.
- Çok büyük fotoğraflarda tarayıcının canvas limiti sınır olur; hata mesajı gösterilir.
