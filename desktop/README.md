# RoValra Desktop

> [!IMPORTANT]
> Bu proje **resmi değildir**. [RoValra](https://github.com/NotValra/RoValra) ekibi,
> [Sober/VinegarHQ](https://sober.vinegarhq.org) veya Roblox Corporation ile bir bağlantısı yoktur.
> RoValra eklentisi GPL-3.0 lisansıyla dağıtılır; bu çatallama da aynı lisansı kullanır.

Roblox web sitesini RoValra eklentisi yüklü olarak açan, Linux ve Windows için
masaüstü istemcisi (Electron).

## Geliştirme

```bash
cd desktop
npm install
npm run dev        # eklentiyi derler ve uygulamayı açar
```

## Paketleme

| Komut               | Çıktı (`desktop/release/`)                     |
| ------------------- | ---------------------------------------------- |
| `npm run dist:linux`| AppImage + tar.gz                               |
| `npm run dist:win`  | Kurulum (NSIS) + portable .exe (Windows'ta)    |
| `npm run dist`      | Linux + Windows portable (Linux'tan)           |

NSIS kurulum dosyası Linux'ta Wine gerektirir; `.github/workflows/desktop.yml`
her iki platformu da kendi işletim sisteminde derler.

## Oyun başlatma

- **Windows:** Resmi Roblox istemcisi `roblox-player:` bağlantılarını açar.
- **Linux:** Sırasıyla [Sober](https://sober.vinegarhq.org) (flatpak) ve diğer
  istemciler denenir; Studio için Vinegar. Kurulum:
  `flatpak install flathub org.vinegarhq.Sober`

## Electron sınırlamaları

Electron, Chrome eklenti API'lerinin bir alt kümesini destekler.
`prepare-extension.js`; `contextMenus`, `webNavigation`, `webRequest`,
`declarativeNetRequest` için zararsız taslaklar ekler. Bu API'lere bağlı birkaç
RoValra özelliği (sağ tık menüsü, özel/banlı oyun yönlendirme algılama,
durum kuralları) masaüstünde devre dışıdır; geri kalan her şey sayfa içinde çalışır.
