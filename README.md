# Roblox-style 3D Web Oyunu

Bu proje saf HTML/JS + [three.js](https://threejs.org/) ile yazılmış tarayıcı tabanlı bir 3D oyundur. Herhangi bir build adımına (npm install, webpack, vite vb.) ihtiyaç duymaz; tüm kütüphaneler `index.html` içindeki `importmap` üzerinden CDN'den (esm.sh) yüklenir.

## GitHub Pages ile yayınlama

1. Bu klasördeki tüm dosyaları bir GitHub reposuna yükleyin (repo kökü = bu klasörün içeriği; yani `index.html` reponun ana dizininde olmalı).
2. Repo ayarlarından **Settings → Pages** kısmına gidin.
3. **Source** olarak `Deploy from a branch` seçin, branch olarak `main` (veya kullandığınız branch) ve klasör olarak `/ (root)` seçin.
4. Kaydedin. Birkaç dakika içinde `https://<kullanici-adi>.github.io/<repo-adi>/` adresinde oyun yayında olacak.

Alternatif olarak bu repoda `.github/workflows/deploy.yml` dosyası ile otomatik GitHub Pages deploy'u da ayarlanmıştır; `main` branch'e her push'ta otomatik olarak Pages'e deploy eder (Settings → Pages → Source: **GitHub Actions** olarak seçmeniz yeterli).

## Neden orijinal sürüm siyah ekran veriyordu?

Bu proje aslında [Websim](https://websim.ai) platformunda geliştirilmişti ve kodun içinde (`src/main.js`) Websim'in sağladığı gerçek zamanlı `WebsimSocket` sınıfına bağımlıydı. Bu sınıf sadece Websim ortamında otomatik olarak tanımlı geliyordu. Proje Websim dışına (örn. GitHub Pages'e) taşındığında:

1. `WebsimSocket` tanımsız kalıyor, script en baştan hata veriyordu → sahne hiç kurulmuyordu.
2. Bazı görsel/ses dosyaları `/dosya.png` gibi **kök dizine göre mutlak** yollarla çağrılıyordu. GitHub Pages projeleri genelde `kullanici.github.io/repo-adi/` gibi bir **alt klasörde** yayınlandığı için `/dosya.png` yanlış adrese (`kullanici.github.io/dosya.png`) gidiyor ve 404 dönüyordu.

Bu depoda ikisi de düzeltildi:

- `index.html` içine, gerçek `WebsimSocket` yoksa devreye giren basit bir **yerel yedek (polyfill)** eklendi. Böylece oyun çökmeden çalışır; sadece gerçek çoklu oyuncu (multiplayer) senkronizasyonu ve sunucu üzerinden sohbet devre dışı kalır (yerelde tek oyunculu mod).
- Tüm `/dosya.uzanti` şeklindeki mutlak asset yolları `./dosya.uzanti` şeklinde **göreli** yollara çevrildi, böylece proje hangi alt klasörde yayınlanırsa yayınlansın dosyalar doğru bulunur.

## Gerçek çoklu oyunculuyu geri getirmek

Eğer gerçek çoklu oyuncu (başka oyuncuları görme, gerçek zamanlı sohbet vb.) istiyorsanız, `index.html` içindeki polyfill'in yerine kendi WebSocket sunucunuza bağlanan gerçek bir istemci kodu yazmanız gerekir (ör. Node.js + `ws` kütüphanesi ile basit bir oda/sunucu kurup, `subscribePresence`, `send`, `updatePresence` gibi metodları o sunucuya bağlayarak). Bu, statik GitHub Pages barındırmasının dışında ayrı bir sunucu (ör. Render, Railway, Fly.io) gerektirir çünkü GitHub Pages sadece statik dosya sunar, WebSocket sunucusu çalıştıramaz.
