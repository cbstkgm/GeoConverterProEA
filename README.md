# 🌍 GeoConverterProEA

GeoConverterProEA, tarayıcı üzerinde çalışan, yüksek performanslı ve modern (Fluent Design) arayüze sahip bir Harita & Geometri Dönüştürme asistanıdır. Özellikle büyük boyutlu CBS verilerini okuma, otomatik harita odaklama ve anında WKT/GeoJSON formatlarına dönüştürme yeteneklerine sahiptir.

## 🚀 Canlı Önizleme
Uygulamayı yüklemeye gerek kalmadan anında test etmek için aşağıdaki bağlantıya tıklayabilirsiniz:

👉 **[Uygulamayı Canlı Test Etmek İçin Tıklayın (GitHub Pages)](https://cbstkgm.github.io/GeoConverterProEA/)**

---

## 🌟 Temel Özellikler
- **Gerçek Zamanlı KMZ Oku/Çevir:** `JSZip` ve `toGeoJSON` kullanılarak KMZ dosyaları anında tarayıcı bellek sınırları içerisinde ayrıştırılır. Backend'e dosya göndermez, tamamen güvenlidir.
- **Yüksek Performanslı Harita Rendering:** Leaflet.js altyapısına eklenen **Canvas** optimizasyonu ile on binlerce koordinata sahip parseller tarayıcıyı dondurmadan haritada saniyeler içinde çizilir.
- **Akıllı Metin Kutusu Koruması:** Megabaytlarca boyuta ulaşan veri kodlarının (GeoJSON/WKT) arayüzü kilitlemesini önlemek için akıllı "Karakter Kırpma" modülü mevcuttur. Panoya kopyalama ve İndirme işlemlerinde veri orijinal boyutuyla kayıpsız korunur.
- **Tek Tıkla WKT Çevirisi:** Haritacılık ve veritabanı dünyasının standart metin formatı olan **Well-Known Text (WKT)** standartına dönüşüm işlemlerini gerçekleştirir.
- **Otomatik Zoom (Auto FitBounds):** Veriler yüklendiği anda manuel harita kaydırmaya gerek kalmadan, uygulama coğrafi konuma (Bounding Box) otomatik olarak hizalanır.

## 🛠 Kurulum ve Çalıştırma
Projeyi kendi yerel (local) ortamınızda geliştirmek için aşağıdaki komutları kullanabilirsiniz:

```bash
git clone https://github.com/cbstkgm/GeoConverterProEA.git
cd GeoConverterProEA
npm install
npm run dev
```

## 🏗 Kullanılan Teknolojiler (Tech Stack)
- **React & Vite** (Hızlı Kullanıcı Arayüzü)
- **Vanilla CSS** (Fluent Design & Glassmorphism Mimarisi)
- **React-Leaflet** (Harita ve Canvas Altlıkları)
- **JSZip & toGeoJSON** (Kapalı Formatlı CBS verilerini Açma)
- **Wellknown** (GeoJSON -> WKT Dönüşümleri)

---
*Geliştirme - Erdem Alpar*
