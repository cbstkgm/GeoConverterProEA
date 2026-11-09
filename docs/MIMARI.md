# GeoConverterProEA — Mimari ve Modül Sözleşmeleri

Bu belge, modüller arasındaki **bağlayıcı arayüzleri** tanımlar. Her modülün sahibi yalnızca kendi dosyalarını değiştirir; diğer modülleri yalnızca burada tanımlanan imzalar üzerinden kullanır. İmza değişikliği gerekiyorsa baş mühendise bildirilir — kendi başına değiştirilmez.

## Genel İlkeler

- Tüm işleme **tarayıcıda** yapılır; veri hiçbir sunucuya gönderilmez.
- Modüller arası veri modeli her zaman **GeoJSON `FeatureCollection`**'dır (`{ type: 'FeatureCollection', features: [...] }`).
- `src/lib/**` saf JavaScript'tir: React, `window`, `document`, global `DOMParser` **kullanmaz**. Bu modüller hem Web Worker'da hem Node'da (Vitest) çalışmalıdır. XML ayrıştırma için `@xmldom/xmldom` kullanılır.
- Fonksiyonlar girdiyi **değiştirmez** (immutable); yeni nesne döndürür.
- Hatalar Türkçe, kullanıcıya gösterilebilir mesajlı `Error` olarak fırlatılır.
- Testler Vitest ile, test edilen dosyanın yanında `*.test.js` olarak yazılır. Çalıştırma: `npx.cmd vitest run`.

## Dosya Sahipliği

| Mühendis | Alan | Sahip olunan dosyalar |
|---|---|---|
| M1 | Okuyucular | `src/lib/okuyucular.js`, `src/lib/okuyucular.test.js`, `src/lib/__fixtures__/**` |
| M2 | Yazıcılar & Format Kataloğu | `src/lib/yazicilar.js`, `src/lib/yazicilar.test.js`, `src/data/formatlar.js` |
| M3 | Geometri & Projeksiyon | `src/lib/geometri.js`, `src/lib/projeksiyon.js` ve testleri |
| M4 | Arayüz | `src/App.jsx`, `src/main.jsx`, `src/components/**`, `src/App.css`, `src/index.css` |
| M5 | Performans (Worker) | `src/workers/**`, `src/hooks/**` |
| M6 | Platform & DevOps | `package.json` (yalnız `scripts`), `vite.config.js`, `.github/**`, `index.html`, `README.md`, `.oxlintrc.json`, `public/**`, `src/assets/**` |
| M7 | Python Arka Uç | `cografi_donusturucu.py`, `requirements.txt`, `tests_py/**` |

`src/lib/katalog.js` (baş mühendis): **bağımlılıksız** sabitler — `DESTEKLENEN_GIRDILER`, `DESTEKLENEN_CIKTILAR`, `KOORDINAT_SISTEMLERI`, `WGS84`, `wgs84ZorunluMu`. Arayüz bu sabitleri yalnızca buradan import eder; böylece okuyucu/yazıcı/projeksiyon kütüphaneleri ana pakete girmez, yalnızca Worker paketinde kalır. `okuyucular.js`, `yazicilar.js` ve `projeksiyon.js` aynı sabitleri yeniden dışa aktarır.

**Geçerlilik denetimi:** `src/lib/gecerlilik.js` → `gecerlilikDenetle(fc)` OGC Simple Features kurallarını (kapalı halka, kendini kesme/değme, diken, delik konumu, MultiPolygon örtüşmesi, sonlu koordinat) harici kütüphane olmadan denetler. `oku` ve `donustur` sonucuna `gecerlilik: { denetlenen, gecerli, gecersiz, bos, sorunlar[], kesildi }` eklenir. `donustur`'da denetim **yazılan** geometri üzerinde yapılır (hassasiyet yuvarlaması da geçersizlik üretebilir); sorunlara haritada gösterim için WGS84 `haritaKonum` eklenir.

**KML/KMZ kuralı:** KML 2.2 yalnızca WGS84 taşır. Arayüz bu formatlarda hedef CRS'yi EPSG:4326'ya kilitler; `islemci.donustur` başka bir hedef CRS'yi hata ile reddeder.

Bağımlılıklar baş mühendis tarafından kurulmuştur: `proj4`, `shpjs`, `@xmldom/xmldom`, `vitest`. **Kimse `npm install` çalıştırmaz.**

---

## M1 — `src/lib/okuyucular.js`

```js
export const DESTEKLENEN_GIRDILER: Array<{ uzanti: string, aciklama: string }>
// En az: .geojson, .json, .kml, .kmz, .gpx, .wkt, .txt (satır başına bir WKT), .csv, .zip (zipli Shapefile)

export async function dosyaOku(girdi: { ad: string, veri: ArrayBuffer }):
  Promise<{ geojson: FeatureCollection, uyarilar: string[] }>
```

- Çıktı daima `FeatureCollection`'dır (tekil `Feature` veya çıplak geometri sarmalanır).
- Desteklenmeyen uzantıda açık bir hata fırlatır (asla sahte/örnek veri üretmez).

## M2 — `src/lib/yazicilar.js`

```js
export const DESTEKLENEN_CIKTILAR: Array<{ uzanti: string, aciklama: string, mime: string }>
// En az: .geojson, .wkt, .kml, .kmz, .csv

export async function dosyaYaz(fc: FeatureCollection, uzanti: string, secenekler?: { girinti?: number }):
  Promise<{ veri: string | Uint8Array, mime: string, uzanti: string, onizleme: string }>
```

- `onizleme`: metin kutusunda gösterilecek metin (KMZ için içteki KML).

`src/data/formatlar.js` — mevcut `desteklenen_formatlar` dışa aktarımı korunur; her formata `durum: 'tarayici' | 'planlanan'` alanı eklenir. `'tarayici'` olanlar `DESTEKLENEN_CIKTILAR` ile birebir eşleşir.

## M3 — `src/lib/geometri.js`

```js
export function zDegerleriniKaldir(fc, secenekler?: { sadeceSifir?: boolean }): FeatureCollection
export function hassasiyetUygula(fc, basamak: number): FeatureCollection
export function istatistikHesapla(fc): {
  objeSayisi: number, geometriTipleri: Record<string, number>, koordinatSayisi: number,
  bbox: [minX, minY, maxX, maxY] | null, zIceriyor: boolean, bosGeometriSayisi: number
}
```

## M3 — `src/lib/projeksiyon.js`

```js
export const KOORDINAT_SISTEMLERI: Array<{ kod: string, ad: string }>
// En az: EPSG:4326, EPSG:3857, ITRF96 TM27–TM45 (EPSG:5253–5259), ED50 UTM 35N–38N (EPSG:23035–23038)

export function koordinatDonustur(fc, kaynakKod: string, hedefKod: string): FeatureCollection
export function wgs84OlabilirMi(fc): boolean   // tüm koordinatlar -180..180 / -90..90 içinde mi
```

## M5 — `src/hooks/useDonusturucu.js` (+ `src/workers/donusturucu.worker.js`)

```js
export function useDonusturucu(): {
  oku(file: File): Promise<{ geojson, uyarilar: string[], istatistik, tahminiCrs: string | null }>,
  donustur(geojson, hedefUzanti: string, secenekler: {
    kaynakCrs: string, hedefCrs: string, zTemizle: boolean, hassasiyet: number | null
  }): Promise<{ sonuc: { veri, mime, uzanti, onizleme }, haritaGeojson, istatistik }>,
  wgs84e(geojson, kaynakCrs: string): Promise<FeatureCollection>,
  mesgul: boolean,
  ilerleme: { yuzde: number, asama: string } | null,
}
```

- `donustur` boru hattı: `koordinatDonustur(kaynak→hedef)` → (`zTemizle` ise) `zDegerleriniKaldir` → (`hassasiyet` ise) `hassasiyetUygula` → `dosyaYaz`.
- `haritaGeojson`: çıktının haritada gösterilmek üzere EPSG:4326'ya çevrilmiş hâli.
- İşler Web Worker'da yürür; Worker kullanılamazsa ana iş parçacığında aynı API ile çalışır.
- Hook unmount olduğunda Worker sonlandırılır.

## M4 — Arayüz

`App.jsx` yalnızca `useDonusturucu`, `DESTEKLENEN_GIRDILER`, `desteklenen_formatlar` ve `KOORDINAT_SISTEMLERI` kullanır; dönüşüm mantığı içermez.
