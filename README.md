# GeoConverterProEA

GeoConverterProEA, CBS (Coğrafi Bilgi Sistemi) verilerini **tamamen tarayıcıda** okuyan, koordinat sistemleri arasında dönüştüren, haritada gösteren ve farklı formatlarda dışa aktaran bir web uygulamasıdır. Dosyalarınız hiçbir sunucuya gönderilmez.

**Canlı sürüm:** https://cbstkgm.github.io/GeoConverterProEA/

---

## Özellikler

- **Çoklu format okuma ve yazma** (ayrıntılar aşağıdaki tablolarda).
- **Koordinat dönüşümü:** WGS84, Web Mercator, ITRF96 3° TM ve ED50 UTM sistemleri arasında `proj4` ile dönüşüm. Girdinin WGS84 olup olmadığı koordinat aralığından tahmin edilir.
- **Geometri araçları:** Z (yükseklik) değerlerini kaldırma, koordinat hassasiyetini (ondalık basamak) sınırlama, istatistik (obje sayısı, geometri tipleri, koordinat sayısı, sınır kutusu).
- **Web Worker:** Okuma ve dönüştürme işlemleri ayrı bir iş parçacığında yürür; büyük dosyalarda arayüz donmaz. Worker kullanılamayan ortamlarda aynı işlemler ana iş parçacığında yapılır.
- **Harita önizleme:** Leaflet / React-Leaflet ile sonuç haritada gösterilir ve otomatik olarak veriye yakınlaşılır.
- **Metin önizleme, panoya kopyalama ve indirme.**

### Desteklenen girdi formatları

| Uzantı | Açıklama |
|---|---|
| `.geojson`, `.json` | GeoJSON (`FeatureCollection`, tekil `Feature` veya çıplak geometri) |
| `.kml` | Keyhole Markup Language |
| `.kmz` | Sıkıştırılmış KML |
| `.gpx` | GPS Exchange Format |
| `.wkt`, `.txt` | Well-Known Text (satır başına bir geometri) |
| `.csv` | WKT sütunu veya enlem/boylam sütunları |
| `.zip` | Zipli ESRI Shapefile (`.shp` + `.dbf` + `.prj` …) |

### Desteklenen çıktı formatları

| Uzantı | Açıklama |
|---|---|
| `.geojson` | GeoJSON |
| `.wkt` | Well-Known Text (satır başına bir obje) |
| `.kml` | KML 2.2 |
| `.kmz` | Sıkıştırılmış KML |
| `.csv` | WKT sütunlu CSV (UTF-8 BOM, Excel uyumlu) |
| `.gml` | Netcad / TKGM uyumlu GML (yalnızca poligon; Python aracıyla birebir aynı çıktı) |
| `.dxf` | DXF (AutoCAD R12, Netcad uyumlu; katmanlar, etiketler, öznitelikler XDATA olarak, Windows-1254) |
| `.zip` | Zipli ESRI Shapefile (geometri ailesi başına katman; `.shp/.shx/.dbf/.prj/.cpg`, UTF-8) |
| `.gpkg` | OGC GeoPackage 1.3 (SQLite; tekil/çoklu karışımı Multi* olarak, aile başına tablo) |
| `.wkb` | Well-Known Binary (satır başına bir hex WKB) |
| `.sql` | PostGIS SQL betiği (`CREATE TABLE` + toplu `INSERT` + GIST indeks, EWKB geometri) |
| `.xyz` | XYZ nokta bulutu (tüm köşe noktaları) |
| `.html` | Tek dosyalık Leaflet harita sayfası (CARTO / Esri uydu / OSM altlıkları) |
| `.md` | Markdown öznitelik tablosu (GFM) |

Format kataloğunda "planlanan" olarak işaretli diğer formatlar (ör. DWG, NCZ, IFC) henüz tarayıcıda desteklenmez.

### Koordinat sistemleri

| Kod | Sistem |
|---|---|
| EPSG:4326 | WGS84 coğrafi (enlem/boylam) |
| EPSG:3857 | WGS84 / Web Mercator |
| EPSG:5253 – 5259 | ITRF96 / 3° TM 27, 30, 33, 36, 39, 42, 45 |
| EPSG:23035 – 23038 | ED50 / UTM 35N – 38N (Türkiye için 7 parametreli datum dönüşümü) |

Hedef format **GML (Netcad / TKGM uyumlu)** seçildiğinde hedef koordinat sistemi otomatik olarak ITRF96 / 3° TM olur; dilim, verinin sınır kutusu ortasındaki boylama göre seçilir (ör. Ankara → TM 33, Trabzon → TM 39). Elle seçim yapılırsa o korunur; "Konuma göre seç" ile otomatiğe dönülür.

---

## Kurulum ve çalıştırma

Node.js 22 veya üstü gerekir.

```bash
git clone https://github.com/cbstkgm/GeoConverterProEA.git
cd GeoConverterProEA
npm ci
npm start          # geliştirme sunucusu (npm run dev ile aynı)
```

> **Windows / PowerShell notu:** PowerShell'in betik çalıştırma ilkesi (execution policy) nedeniyle `npm` ve `npx` komutları
> "running scripts is disabled on this system" hatası verebilir. Bu durumda `npm.cmd` ve `npx.cmd` kullanın:
>
> ```powershell
> npm.cmd ci
> npm.cmd start
> npx.cmd vitest run
> ```

### Komutlar

| Komut | Açıklama |
|---|---|
| `npm start` / `npm run dev` | Vite geliştirme sunucusu |
| `npm run build` | Üretim derlemesi (`dist/`) |
| `npm run preview` | Derlenmiş sürümü yerelde sunar |
| `npm test` | Vitest birim testleri (tek sefer) |
| `npm run test:watch` | Vitest izleme modu |
| `npm run lint` | oxlint ile statik analiz |

Testler, test edilen dosyanın yanında `src/**/*.test.js` olarak bulunur ve Node ortamında çalışır.

## Proje yapısı

```
src/
  lib/          Saf JS çekirdek: okuyucular, yazıcılar, geometri, projeksiyon (Worker + Node uyumlu)
  workers/      Dönüştürme Web Worker'ı
  hooks/        useDonusturucu (Worker ile iletişim)
  components/   React arayüz bileşenleri
  data/         Format kataloğu
docs/MIMARI.md  Modül sözleşmeleri
```

## CI / CD

- **`.github/workflows/ci.yml`** — Pull request'ler ve `main` dışındaki dallar: lint + test + build (Node 22) ve Python testleri (`pytest tests_py`, Python 3.12). Deploy yapılmaz.
- **`.github/workflows/deploy.yml`** — `main`'e push: `npm ci` → lint → test → build → GitHub Pages'e yayın.
- **Dependabot** — npm ve GitHub Actions bağımlılıkları için haftalık güncelleme PR'ları.

## Python arka uç (isteğe bağlı)

`cografi_donusturucu.py`, aynı dönüşümlerin masaüstü/sunucu tarafında GeoPandas ile yapılabilmesi için ayrı bir komut satırı aracıdır; web uygulaması bu betiğe ihtiyaç duymaz.

```bash
pip install -r requirements.txt
pytest tests_py
```

Komut satırı kullanımı:

```bash
python cografi_donusturucu.py girdi.csv cikti.gpkg --kaynak-crs EPSG:4326 --hedef-crs EPSG:5254 --kolonlar ada,parsel --geometri-kolonu wkt
```

- **Girdi:** `.csv`, `.shp`, `.zip` (Shapefile), `.gml`, `.geojson`, `.json`, `.kml`, `.kmz`, `.gpkg`, `.gpx`, `.wkt`
- **Çıktı:** `.csv`, `.shp`, `.geojson`, `.gpkg`, `.kml`, `.kmz`, `.wkt`, `.gml` / `.ncz` (Netcad/TKGM uyumlu GML)
- KML/KMZ çıktısı otomatik olarak WGS84'e (EPSG:4326) dönüştürülür. `-v` ayrıntılı log verir.
- GML/NCZ çıktısı TKGM adlandırmasına uyar (KDB GML Converter 7.2): parsel adı `ada/parsel` (ör. `5494/14`), tabaka `TK_PARSEL_abc` (nokta konum doğruluğu 0,21 → `TK_PARSEL_021`). Doğruluk verideki `nkd` sütunundan alınır; yoksa `--nkd 0,21` ile varsayılan verilir. Web uygulamasıyla aynı girdiden bayt bayt aynı GML üretilir.

```bash
python cografi_donusturucu.py parseller.geojson parseller.gml --nkd 0,21
```

## Kullanılan teknolojiler

React 19, Vite 8, Leaflet / React-Leaflet, proj4, shpjs, JSZip, @tmcw/togeojson, @xmldom/xmldom, Vitest, oxlint.

---

*Geliştirme: Erdem Alpar*
