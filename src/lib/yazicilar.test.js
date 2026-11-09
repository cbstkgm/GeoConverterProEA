import { describe, it, expect } from 'vitest';
import wellknown from 'wellknown';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { kml as kmlToGeojson } from '@tmcw/togeojson';
import { DESTEKLENEN_CIKTILAR, dosyaYaz, xmlKacis } from './yazicilar.js';
import { desteklenen_formatlar, tum_formatlari_duz_liste, formatDurumu } from '../data/formatlar.js';

const ozelMetin = `Ağaç & <Çınar> "İğne" 'şğü' Ö`;

const delikliPoligon = {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]],
  ],
};

const ornekFc = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Nokta', kod: 1 }, geometry: { type: 'Point', coordinates: [32.85, 39.93, 850] } },
    { type: 'Feature', properties: { name: 'Hat', aciklama: ozelMetin }, geometry: { type: 'LineString', coordinates: [[30, 40], [31, 41]] } },
    { type: 'Feature', properties: { name: 'Delikli' }, geometry: delikliPoligon },
    { type: 'Feature', properties: { name: 'Bos', not: 'geometri yok' }, geometry: null },
    {
      type: 'Feature',
      properties: { name: 'Çoklu' },
      geometry: { type: 'MultiPolygon', coordinates: [delikliPoligon.coordinates, [[[20, 20], [21, 20], [21, 21], [20, 20]]]] },
    },
  ],
});

const kmlOku = (metin) => kmlToGeojson(new DOMParser().parseFromString(metin, 'text/xml'));

// KML'de Multi* tipi yoktur; MultiGeometry togeojson tarafından GeometryCollection olarak okunur.
const multiyiAc = (g) => {
  const tekil = { MultiPoint: 'Point', MultiLineString: 'LineString', MultiPolygon: 'Polygon' }[g.type];
  return tekil ? { type: 'GeometryCollection', geometries: g.coordinates.map((coordinates) => ({ type: tekil, coordinates })) } : g;
};
describe('DESTEKLENEN_CIKTILAR', () => {
  it('sözleşmedeki asgari formatları içerir', () => {
    const u = DESTEKLENEN_CIKTILAR.map((c) => c.uzanti);
    for (const e of ['.geojson', '.wkt', '.kml', '.kmz', '.csv']) expect(u).toContain(e);
    for (const c of DESTEKLENEN_CIKTILAR) {
      expect(c.aciklama).toBeTruthy();
      expect(c.mime).toBeTruthy();
    }
  });
});

describe('dosyaYaz — genel', () => {
  it('desteklenmeyen uzantıda Türkçe hata fırlatır', async () => {
    await expect(dosyaYaz(ornekFc(), '.dwg')).rejects.toThrow(/desteklenmiyor/);
  });
  it('geçersiz girdide Türkçe hata fırlatır', async () => {
    await expect(dosyaYaz({ type: 'Feature' }, '.geojson')).rejects.toThrow(/FeatureCollection/);
  });
  it('uzantıyı noktasız ve büyük harfli kabul eder', async () => {
    const s = await dosyaYaz(ornekFc(), 'KML');
    expect(s.uzanti).toBe('.kml');
  });
  it('girdiyi değiştirmez', async () => {
    const fc = ornekFc();
    const kopya = JSON.parse(JSON.stringify(fc));
    for (const c of DESTEKLENEN_CIKTILAR) await dosyaYaz(fc, c.uzanti);
    expect(fc).toEqual(kopya);
  });
  it('boş FeatureCollection her formatta yazılır ya da anlaşılır bir hata verir', async () => {
    // Boş veriyi temsil edemeyen formatlar bilinçli olarak açıklayıcı hata verir.
    const bosuReddeden = {
      '.gml': /poligon bulunamadı/,
      '.zip': /hiç obje içermiyor/,
      '.ptx': /nokta yok/,
      '.nc': /./,
    };
    for (const c of DESTEKLENEN_CIKTILAR) {
      const bos = { type: 'FeatureCollection', features: [] };
      const sec = c.uzanti === '.mvt' || c.uzanti === '.pbf' ? { crs: 'EPSG:3857' } : { crs: 'EPSG:5255' };
      if (bosuReddeden[c.uzanti]) {
        await expect(dosyaYaz(bos, c.uzanti, sec), c.uzanti).rejects.toThrow(bosuReddeden[c.uzanti]);
        continue;
      }
      const s = await dosyaYaz(bos, c.uzanti, sec);
      expect(s.mime).toBe(c.mime);
    }
  });
});

describe('.geojson', () => {
  it('varsayılan 2 boşluk girintiyle geri-dönüş', async () => {
    const fc = ornekFc();
    const s = await dosyaYaz(fc, '.geojson');
    expect(s.mime).toBe('application/geo+json');
    expect(s.veri).toContain('\n  "type"');
    expect(JSON.parse(s.veri)).toEqual(fc);
    expect(s.onizleme).toBe(s.veri);
  });
  it('girinti seçeneği uygulanır', async () => {
    const s = await dosyaYaz(ornekFc(), '.geojson', { girinti: 0 });
    expect(s.veri).not.toContain('\n');
    const s4 = await dosyaYaz(ornekFc(), '.geojson', { girinti: 4 });
    expect(s4.veri).toContain('\n    "type"');
  });
});

describe('.wkt', () => {
  it('satır başına bir obje, null geometri atlanır, geri-dönüş', async () => {
    const fc = ornekFc();
    const s = await dosyaYaz(fc, '.wkt');
    const satirlar = s.veri.split('\n');
    expect(satirlar).toHaveLength(4);
    const beklenen = fc.features.filter((f) => f.geometry).map((f) => f.geometry);
    satirlar.forEach((satir, i) => expect(wellknown.parse(satir)).toEqual(beklenen[i]));
  });
  it('yalnızca null geometrili veri çökmez', async () => {
    const s = await dosyaYaz({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: null }] }, '.wkt');
    expect(s.veri).toBe('');
  });
  it('delikli poligon ve Z korunur', async () => {
    const s = await dosyaYaz(ornekFc(), '.wkt');
    expect(s.veri).toContain('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0), (2 2, 2 4, 4 4, 4 2, 2 2))');
    expect(s.veri).toContain('POINT (32.85 39.93 850)');
  });
});

describe('.kml', () => {
  it('togeojson ile geri-dönüş: geometri ve özellikler', async () => {
    const fc = ornekFc();
    const s = await dosyaYaz(fc, '.kml');
    expect(s.mime).toBe('application/vnd.google-earth.kml+xml');
    const geri = kmlOku(s.veri);
    expect(geri.features).toHaveLength(fc.features.length);
    expect(geri.features[0].geometry).toEqual(fc.features[0].geometry); // Z korunur
    expect(geri.features[1].geometry).toEqual(fc.features[1].geometry);
    expect(geri.features[2].geometry).toEqual(delikliPoligon);
    expect(geri.features[3].geometry).toBeNull();
    expect(geri.features[4].geometry).toEqual(multiyiAc(fc.features[4].geometry));
    expect(geri.features[1].properties.name).toBe('Hat');
    expect(String(geri.features[0].properties.kod)).toBe('1');
  });
  it('özel karakterleri doğru kaçırır', async () => {
    const fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: ozelMetin, [`a&b<"'>`]: ozelMetin }, geometry: { type: 'Point', coordinates: [1, 2] } }],
    };
    const s = await dosyaYaz(fc, '.kml');
    expect(s.veri).toContain('&amp;');
    expect(s.veri).toContain('&lt;Çınar&gt;');
    expect(s.veri).toContain('&quot;İğne&quot;');
    expect(s.veri).toContain('&apos;şğü&apos;');
    const geri = kmlOku(s.veri);
    expect(geri.features[0].properties.name).toBe(ozelMetin);
    expect(geri.features[0].properties[`a&b<"'>`]).toBe(ozelMetin);
  });
  it('xmlKacis beş karakteri kaçırır', () => {
    expect(xmlKacis(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
  it('MultiPoint, MultiLineString ve GeometryCollection → MultiGeometry', async () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] } },
        { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] } },
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 2] }, { type: 'LineString', coordinates: [[0, 0], [1, 1]] }] },
        },
      ],
    };
    const s = await dosyaYaz(fc, '.kml');
    expect(s.veri.match(/<MultiGeometry>/g)).toHaveLength(3);
    const geri = kmlOku(s.veri);
    expect(geri.features[0].geometry).toEqual(multiyiAc(fc.features[0].geometry));
    expect(geri.features[1].geometry).toEqual(multiyiAc(fc.features[1].geometry));
    expect(geri.features[2].geometry).toEqual(fc.features[2].geometry);
  });
  it('nesne değerli özellikleri JSON olarak yazar', async () => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { ek: { a: 1 } }, geometry: null }] };
    const geri = kmlOku((await dosyaYaz(fc, '.kml')).veri);
    expect(JSON.parse(geri.features[0].properties.ek)).toEqual({ a: 1 });
  });
});

describe('.kmz', () => {
  it('doc.kml içeren zip üretir, önizleme içteki KML', async () => {
    const fc = ornekFc();
    const s = await dosyaYaz(fc, '.kmz');
    expect(s.veri).toBeInstanceOf(Uint8Array);
    expect(s.mime).toBe('application/vnd.google-earth.kmz');
    expect(s.veri[0]).toBe(0x50); // 'P'
    expect(s.veri[1]).toBe(0x4b); // 'K'
    const zip = await JSZip.loadAsync(s.veri);
    const ic = await zip.file('doc.kml').async('string');
    expect(ic).toBe(s.onizleme);
    const geri = kmlOku(ic);
    expect(geri.features[2].geometry).toEqual(delikliPoligon);
    expect(geri.features[1].properties.aciklama).toBe(ozelMetin);
  });
});

// Basit RFC 4180 ayrıştırıcı (yalnızca test için)
function csvAyristir(metin) {
  const satirlar = [];
  let satir = [];
  let hucre = '';
  let tirnak = false;
  for (let i = 0; i < metin.length; i++) {
    const c = metin[i];
    if (tirnak) {
      if (c === '"' && metin[i + 1] === '"') { hucre += '"'; i++; }
      else if (c === '"') tirnak = false;
      else hucre += c;
    } else if (c === '"') tirnak = true;
    else if (c === ',') { satir.push(hucre); hucre = ''; }
    else if (c === '\r' && metin[i + 1] === '\n') { satir.push(hucre); satirlar.push(satir); satir = []; hucre = ''; i++; }
    else hucre += c;
  }
  satir.push(hucre);
  satirlar.push(satir);
  return satirlar;
}

describe('.csv', () => {
  it('UTF-8 BOM, WKT ilk sütun, özelliklerin birleşimi başlık', async () => {
    const fc = ornekFc();
    const s = await dosyaYaz(fc, '.csv');
    expect(s.mime).toBe('text/csv');
    expect(s.veri.charCodeAt(0)).toBe(0xfeff);
    expect(s.onizleme.charCodeAt(0)).not.toBe(0xfeff);
    const tablo = csvAyristir(s.veri.slice(1));
    expect(tablo[0]).toEqual(['WKT', 'name', 'kod', 'aciklama', 'not']);
    expect(tablo).toHaveLength(fc.features.length + 1);
    expect(wellknown.parse(tablo[3][0])).toEqual(delikliPoligon);
    expect(tablo[2][3]).toBe(ozelMetin);
    expect(tablo[4][0]).toBe(''); // null geometri → boş WKT
    expect(tablo[4][4]).toBe('geometri yok');
  });
  it('virgül, tırnak ve satır sonunu RFC 4180 ile tırnaklar', async () => {
    const fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { a: 'x, "y"\nz', b: null, c: 3.5 }, geometry: { type: 'Point', coordinates: [1, 2] } }],
    };
    const s = await dosyaYaz(fc, '.csv');
    expect(s.onizleme).toContain('"x, ""y""\nz"');
    const tablo = csvAyristir(s.onizleme);
    expect(tablo[1]).toEqual(['POINT (1 2)', 'x, "y"\nz', '', '3.5']);
  });
});

describe('formatlar.js kataloğu', () => {
  it('her formatın durumu tarayici veya planlanan', () => {
    for (const g of desteklenen_formatlar) {
      expect(g.kategori).toBeTruthy();
      for (const f of g.formatlar) expect(['tarayici', 'planlanan']).toContain(f.durum);
    }
  });
  it("'tarayici' olanlar DESTEKLENEN_CIKTILAR ile birebir aynı", () => {
    const tarayici = tum_formatlari_duz_liste().filter((f) => f.durum === 'tarayici').map((f) => f.uzanti).sort();
    expect(tarayici).toEqual(DESTEKLENEN_CIKTILAR.map((c) => c.uzanti).sort());
  });
  it('uzantı olmayan "postgis" planlanan olarak işaretlenir', () => {
    expect(formatDurumu('postgis')).toBe('planlanan');
    const pg = tum_formatlari_duz_liste().find((f) => f.uzanti === 'postgis');
    expect(pg.durum).toBe('planlanan');
  });
  it('düz liste kategori, uzanti, aciklama ve durum taşır', () => {
    const liste = tum_formatlari_duz_liste();
    expect(liste.length).toBeGreaterThan(50);
    for (const f of liste) expect(Object.keys(f).sort()).toEqual(['aciklama', 'durum', 'kategori', 'uzanti']);
  });
});
