<p align="center">
  <img src="./public/Assets/logo.svg" alt="RoValra Desktop" width="480">
</p>

<p align="center">
  <strong>Roblox web sitesini <a href="https://github.com/NotValra/RoValra">RoValra</a> eklentisi yüklü olarak açan,<br>
  Linux ve Windows için masaüstü istemcisi.</strong>
</p>

<p align="center">
  <a href="#kurulum">Kurulum</a> •
  <a href="#özellikler">Özellikler</a> •
  <a href="#nasıl-çalışır">Nasıl çalışır</a> •
  <a href="#geliştirme">Geliştirme</a> •
  <a href="#english">English</a>
</p>

> [!IMPORTANT]
> Bu proje **resmi değildir**. RoValra ekibi, [Sober / VinegarHQ](https://sober.vinegarhq.org)
> veya Roblox Corporation ile bir bağlantısı yoktur ve onlar tarafından desteklenmez.
> RoValra'nın resmi sürümü için: [rovalra.com](https://www.rovalra.com).

---

## Özellikler

### RoValra, tarayıcısız

- RoValra eklentisi uygulamanın içinde, **eksiksiz** çalışır. Electron'un desteklemediği Chrome API'leri
  (`declarativeNetRequest`, `webRequest`, `webNavigation`, `contextMenus`, `permissions`,
  `runtime.onInstalled`) uygulama tarafından yeniden yazılmıştır. Sunucu bilgisi ("What Am I Joining"),
  çevrimiçi durumu gizleme, sağ tık menüleri ve diğer özellikler Chrome'daki gibi çalışır.
- Ayrı oturum: Roblox girişiniz uygulamaya özeldir; tarayıcınızı etkilemez.
- Sağ tık menüsü, ileri/geri, yakınlaştırma, tam ekran (F11), geliştirici araçları.

### Oyun başlatma

| Platform | Nasıl |
|---|---|
| **Windows** | Resmi Roblox istemcisi. Oyna'ya basınca doğrudan açılır. |
| **Linux** | [Sober](https://sober.vinegarhq.org) (Roblox'un Android sürümünü Linux'ta çalıştırır). **Otomatik kurulur ve yapılandırılır**; Sober'ın kendi kurulum ekranları hiç açılmaz. Roblox Studio bağlantıları kuruluysa Vinegar'a gider. |

Linux'ta oyun açıkken uygulama küçülür ve Roblox sayfasını bellekten boşaltır (~700 MB); oyun kapanınca
kaldığınız sayfaya geri döner.

### Oyun menüsü (Linux)

- **Performans profilleri:** Performans / Dengeli / Kalite. Roblox'un grafik seviyesini ve izin verilen
  FastFlag'leri birlikte ayarlar.
- **FPS sınırı:** 60 / 144 / 240 / Sınırsız.
- **Düşük gecikme:** Mesa'nın `mailbox` sunum modu (kuyrukta bekleyen kare yok, yırtılma yok).
- **FPS sayacı:** [MangoHud](https://github.com/flightlessmango/MangoHud) ile, otomatik kurulur.
  Ayar penceresinde sürükleyip bırakarak konumlandırılır; oyun açıkken bile anında yer değiştirir,
  gizlenir/gösterilir (`Ctrl+Shift+F`).
- **GameMode:** Kurulu değilse bir kez kurmayı önerir. Şifreyi sistemin kendi polkit penceresi sorar;
  uygulama şifreyi görmez.

### Arka plan teması

**RoValra → Arka plan** menüsünden:

- **Hazır temalar:** Gece mavisi, Mor bulutsu, Gün batımı, Orman, Okyanus, Koyu grafit.
- **Bilgisayardan resim seç:** PNG, JPG, WebP, GIF, AVIF.
- **Görünümü ayarla:** RoValra'nın kendi editörü (opaklık, bulanıklık, renk katmanı, konum).

> Koyu arka planlarda yazıların okunması için Roblox'ta **Settings → Account Info → Theme: Dark** önerilir.

---

## Kurulum

### Hazır sürüm

Henüz yayınlanmış bir sürüm yok. Kendiniz derlemek için **Actions → Build Desktop App → Run workflow**
çalıştırın; Linux (AppImage, tar.gz) ve Windows (kurulum, portable) dosyaları iş bitince indirilebilir.
Ya da aşağıdaki gibi kaynaktan çalıştırın.

### Linux gereksinimleri

- **Flatpak** (oyunlar için). Çoğu dağıtımda kuruludur; değilse: `sudo pacman -S flatpak` /
  `sudo apt install flatpak`.
- Gerisini (Sober, MangoHud) uygulama ilk "Oyna"da kendisi kurar. İnternet bağlantısına ve ~1,5 GB
  boş alana ihtiyaç vardır.

### Kaynaktan çalıştırma

[Node.js](https://nodejs.org) 20 veya üstü gerekir.

```bash
git clone https://github.com/il4pt/rovalra-desktop.git
cd rovalra-desktop
npm install
cd desktop && npm install && cd ..
npm run build        # RoValra eklentisini derler
npm start            # uygulamayı açar
```

> Uygulama açılmıyor ve `Electron failed to install correctly` hatası alıyorsanız, npm kurulum
> betiklerini engelliyordur. Electron'u elle indirin:
> `node desktop/node_modules/electron/install.js`

---

## Nasıl çalışır

```
roblox.com (Electron penceresi)
 ├─ RoValra içerik betikleri ─────────────── sayfada çalışır, değiştirilmemiştir
 └─ RoValra arka plan service worker'ı
     └─ sw-shim.js  ── eksik chrome.* API'leri
         └─ sw-preload.js ── IPC köprüsü
             └─ bridge.js (ana süreç)
                 ├─ declarativeNetRequest kural motoru → session.webRequest
                 ├─ webNavigation / webRequest olayları
                 └─ sağ tık menüsü (contextMenus)

"Oyna" → roblox-player:// yakalanır
 ├─ Windows: resmi Roblox istemcisi
 └─ Linux:   sober.js → (gerekirse ekransız kurulum) → flatpak run org.vinegarhq.Sober
```

| Dosya | Görevi |
|---|---|
| `desktop/main.js` | Pencere, menüler, oyun başlatma akışı, arka plan teması |
| `desktop/bridge.js` | Electron'da olmayan Chrome eklenti API'lerinin ana süreç tarafı |
| `desktop/sw-shim.js` | Eklentinin arka plan betiğinin başına eklenen API katmanı |
| `desktop/sober.js` | Sober kurulumu, ayarları, performans profilleri, MangoHud |
| `desktop/gamemode.js` | GameMode kurulumu (pkexec) |
| `desktop/prepare-extension.js` | Derlenmiş eklentiyi Electron'a uyarlar |

RoValra'nın kaynak koduna yapılan değişiklikler iki hata düzeltmesiyle sınırlıdır
(`settingsCompat.ts` ve `serverlist.js`); geri kalanı olduğu gibi kullanılır.

### Sınırlar

- Roblox'un Windows istemcisi Linux'ta çalıştırılamaz; Hyperion hile koruması Wine/Proton'u
  [2023'ten beri engelliyor](https://vinegarhq.org/Home/rol_faq.html). Linux'ta oyunlar bu yüzden
  Sober (Android sürümü) ile açılır.
- Oyun penceresi Sober'ın kendi penceresidir; Wayland başka bir programın penceresini gömmeye izin vermez.
- FastFlag'ler Roblox'un [izin listesiyle](https://devforum.roblox.com/) sınırlıdır; ağ gecikmesini
  değiştiren flag'ler engellidir.

---

## Geliştirme

```bash
npm run build                 # eklentiyi derle (dist/)
cd desktop
npm run dev                   # eklentiyi derle + uygulamayı aç
npm run dist:linux            # AppImage + tar.gz
npm run dist:win              # Windows kurulum + portable (Windows'ta)
npm run dist                  # Linux + Windows portable (Linux'tan)
```

Hata ayıklama için:

```bash
ELECTRON_ENABLE_LOGGING=1 ./node_modules/electron/dist/electron . --remote-debugging-port=9333
```

Ardından `chrome://inspect` ile `localhost:9333`'e bağlanarak sayfayı ve eklentinin service worker'ını
inceleyebilirsiniz. Her iki platform için derleme `.github/workflows/desktop.yml` ile GitHub Actions'ta da
yapılabilir.

---

## Lisans ve emeği geçenler

- **[RoValra](https://github.com/NotValra/RoValra)** — Valra ve katkıda bulunanlar. Eklentinin tüm
  özellikleri onların eseridir. Kod GPL-3.0 ile lisanslıdır. Orijinal README: [docs/RoValra-README.md](docs/RoValra-README.md).
- **[Sober](https://sober.vinegarhq.org)** — VinegarHQ. Kapalı kaynaktır; bu depoda yer almaz,
  kullanıcının makinesine Flathub'dan kurulur.
- **[MangoHud](https://github.com/flightlessmango/MangoHud)**, **[GameMode](https://github.com/FeralInteractive/gamemode)**.

Bu depo [GPL-3.0](LICENSE) ile lisanslıdır. RoValra'nın `LICENSE` dosyasında belirtilen logo ve ikon
görselleri telif altında olduğundan bu çatallamaya dahil **edilmemiştir**; aynı dosya adlarındaki görseller
bu proje için yeniden çizilmiştir.

Roblox, Roblox Corporation'ın ticari markasıdır.

---

## English

**RoValra Desktop** is an unofficial Linux/Windows desktop client that opens the Roblox website with the
[RoValra](https://github.com/NotValra/RoValra) extension built in.

- RoValra runs fully: the Chrome extension APIs Electron lacks are reimplemented in the main process.
- **Windows** launches games with the official Roblox client. **Linux** uses [Sober](https://sober.vinegarhq.org),
  installed and configured automatically with no Sober setup screens.
- Linux extras: performance profiles, FPS cap, low-latency presentation, a draggable MangoHud FPS counter,
  GameMode setup.
- Background themes: built-in gradients or any local image.

Run from source with `npm install && (cd desktop && npm install) && npm run build && npm start`.
Not affiliated with RoValra, VinegarHQ or Roblox Corporation. Licensed under GPL-3.0.
