// Bağımlılıksız katalog: arayüzün ihtiyaç duyduğu sabitler.
// Bu dosya kasıtlı olarak hiçbir kütüphane import etmez; böylece arayüz bu listeleri
// kullanırken okuyucu/yazıcı/projeksiyon kütüphaneleri (shpjs, proj4, jszip…) ana pakete
// girmez — onlar yalnızca Web Worker paketinde yer alır.
// okuyucular.js, yazicilar.js ve projeksiyon.js bu sabitleri yeniden dışa aktarır (sözleşme korunur).

export const WGS84 = 'EPSG:4326';

export const DESTEKLENEN_GIRDILER = [
  { uzanti: '.geojson', aciklama: 'GeoJSON' },
  { uzanti: '.json', aciklama: 'GeoJSON (JSON)' },
  { uzanti: '.kml', aciklama: 'Keyhole Markup Language' },
  { uzanti: '.kmz', aciklama: 'Sıkıştırılmış KML' },
  { uzanti: '.gpx', aciklama: 'GPS Exchange Format' },
  { uzanti: '.wkt', aciklama: 'Well-Known Text (satır başına bir geometri)' },
  { uzanti: '.txt', aciklama: 'Metin – satır başına bir WKT' },
  { uzanti: '.csv', aciklama: 'CSV (WKT sütunu veya enlem/boylam)' },
  { uzanti: '.zip', aciklama: 'Zipli ESRI Shapefile' },
];

export const DESTEKLENEN_CIKTILAR = [
  { uzanti: '.geojson', aciklama: 'GeoJSON', mime: 'application/geo+json' },
  { uzanti: '.wkt', aciklama: 'Well-Known Text (satır başına bir obje)', mime: 'text/plain' },
  { uzanti: '.kml', aciklama: 'KML 2.2 (Google Earth)', mime: 'application/vnd.google-earth.kml+xml' },
  { uzanti: '.kmz', aciklama: 'KMZ (sıkıştırılmış KML)', mime: 'application/vnd.google-earth.kmz' },
  { uzanti: '.csv', aciklama: 'CSV (WKT sütunlu, UTF-8 BOM)', mime: 'text/csv' },
  { uzanti: '.gml', aciklama: 'GML (Netcad / TKGM uyumlu)', mime: 'application/gml+xml' },
  { uzanti: '.dxf', aciklama: 'DXF (AutoCAD R12, Netcad uyumlu)', mime: 'image/vnd.dxf' },
  { uzanti: '.zip', aciklama: 'ESRI Shapefile (zipli; shp/shx/dbf/prj/cpg)', mime: 'application/zip' },
  { uzanti: '.gpkg', aciklama: 'OGC GeoPackage 1.3 (SQLite)', mime: 'application/geopackage+sqlite3' },
  { uzanti: '.wkb', aciklama: 'Well-Known Binary (satır başına bir hex WKB)', mime: 'text/plain' },
  { uzanti: '.sql', aciklama: 'PostGIS SQL betiği (CREATE TABLE + INSERT)', mime: 'application/sql' },
  { uzanti: '.xyz', aciklama: 'XYZ nokta bulutu (köşe noktaları)', mime: 'text/plain' },
  { uzanti: '.html', aciklama: 'HTML harita (Leaflet, tek dosya)', mime: 'text/html' },
  { uzanti: '.md', aciklama: 'Markdown öznitelik tablosu', mime: 'text/markdown' },
];

/** KML 2.2 standardı koordinatları yalnızca WGS84 boylam/enlem olarak tanımlar. */
export const WGS84_ZORUNLU_CIKTILAR = new Set(['.kml', '.kmz']);

export const wgs84ZorunluMu = (uzanti) =>
  typeof uzanti === 'string' && WGS84_ZORUNLU_CIKTILAR.has(uzanti.trim().toLowerCase());

/**
 * ED50 → WGS84 Türkiye parametreleri.
 * Kaynak: EPSG:1784 "ED50 to WGS 84 (30)", kullanım alanı Türkiye (karada ve denizde),
 * yöntem Position Vector (EPSG:9606) — proj4 +towgs84 ile aynı işaret kuralı.
 * tx=-84.1 m, ty=-101.8 m, tz=-129.7 m, rx=0", ry=0", rz=0.468", ds=1.05 ppm. Doğruluk ≈ 2 m.
 */
const ED50_TURKIYE_TOWGS84 = '-84.1,-101.8,-129.7,0,0,0.468,1.05';

const sistemler = [
  {
    kod: 'EPSG:4326',
    ad: 'WGS84 Coğrafi (Enlem/Boylam) (EPSG:4326)',
    tanim: '+proj=longlat +datum=WGS84 +no_defs',
  },
  {
    kod: 'EPSG:3857',
    ad: 'WGS84 / Web Mercator (EPSG:3857)',
    tanim:
      '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  },
];

// ITRF96 / 3° TM: EPSG:5253 (TM27) … EPSG:5259 (TM45). GRS80, k=1, x_0=500000.
// ITRF96 ile WGS84 arasındaki fark (<1 m, epokla değişen) ihmal edilir: towgs84 = 0.
[27, 30, 33, 36, 39, 42, 45].forEach((dom, i) => {
  sistemler.push({
    kod: `EPSG:${5253 + i}`,
    ad: `ITRF96 / 3° TM ${dom} (EPSG:${5253 + i})`,
    tanim: `+proj=tmerc +lat_0=0 +lon_0=${dom} +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`,
  });
});

// ED50 / UTM 35N–38N: EPSG:23035–23038. Uluslararası (Hayford 1924) elipsoidi.
[35, 36, 37, 38].forEach((zon) => {
  const dom = zon * 6 - 183;
  sistemler.push({
    kod: `EPSG:${23000 + zon}`,
    ad: `ED50 / UTM ${zon}N (6° DOM ${dom}) (EPSG:${23000 + zon})`,
    tanim: `+proj=utm +zone=${zon} +ellps=intl +towgs84=${ED50_TURKIYE_TOWGS84} +units=m +no_defs`,
  });
});

/** proj4 tanımlarıyla birlikte tam liste (projeksiyon.js kullanır). */
export const KOORDINAT_SISTEMI_TANIMLARI = Object.freeze(sistemler.map((s) => Object.freeze({ ...s })));

/** Arayüzde gösterilecek koordinat sistemleri listesi. */
export const KOORDINAT_SISTEMLERI = Object.freeze(
  sistemler.map(({ kod, ad }) => Object.freeze({ kod, ad })),
);

/** Dönüşüm panelindeki geometri tipi seçenekleri (değer null: değiştirme). */
export const GEOMETRI_TIPI_SECENEKLERI = Object.freeze([
  Object.freeze({ deger: null, ad: 'Değiştirme' }),
  Object.freeze({ deger: 'Polygon', ad: 'Çizgi → Poligon (LineString → Polygon)' }),
  Object.freeze({ deger: 'LineString', ad: 'Poligon → Çizgi (Polygon → LineString)' }),
]);
