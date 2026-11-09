import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { dosyaOku, DESTEKLENEN_GIRDILER } from './okuyucular.js';

const fixture = (ad) => {
  const b = readFileSync(fileURLToPath(new URL(`./__fixtures__/${ad}`, import.meta.url)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const metinBuf = (metin) => new TextEncoder().encode(metin).buffer;
const oku = (ad, metin) => dosyaOku({ ad, veri: metinBuf(metin) });

// --- Test içinde minimal Shapefile (nokta) üretici --------------------------
function shpNokta(noktalar) {
  const uzunluk = 100 + noktalar.length * 28;
  const dv = new DataView(new ArrayBuffer(uzunluk));
  dv.setInt32(0, 9994, false);
  dv.setInt32(24, uzunluk / 2, false);
  dv.setInt32(28, 1000, true);
  dv.setInt32(32, 1, true);
  const xs = noktalar.map((p) => p[0]);
  const ys = noktalar.map((p) => p[1]);
  [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    .forEach((v, i) => dv.setFloat64(36 + i * 8, v, true));
  noktalar.forEach(([x, y], i) => {
    const o = 100 + i * 28;
    dv.setInt32(o, i + 1, false);
    dv.setInt32(o + 4, 10, false);
    dv.setInt32(o + 8, 1, true);
    dv.setFloat64(o + 12, x, true);
    dv.setFloat64(o + 20, y, true);
  });
  return new Uint8Array(dv.buffer);
}

function dbfTekAlan(alanAdi, degerler, genislik = 20) {
  const enc = new TextEncoder();
  const basUzunluk = 32 + 32 + 1;
  const kayitUzunluk = 1 + genislik;
  const out = new Uint8Array(basUzunluk + degerler.length * kayitUzunluk + 1);
  const dv = new DataView(out.buffer);
  out[0] = 0x03; out[1] = 124; out[2] = 1; out[3] = 1;
  dv.setUint32(4, degerler.length, true);
  dv.setUint16(8, basUzunluk, true);
  dv.setUint16(10, kayitUzunluk, true);
  out.set(enc.encode(alanAdi), 32);
  out[32 + 11] = 'C'.charCodeAt(0);
  out[32 + 16] = genislik;
  out[64] = 0x0d;
  degerler.forEach((d, i) => {
    const o = basUzunluk + i * kayitUzunluk;
    out.fill(0x20, o, o + kayitUzunluk);
    out.set(enc.encode(d).slice(0, genislik), o + 1);
  });
  out[out.length - 1] = 0x1a;
  return out;
}

const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]';

async function zipUret(dosyalar) {
  const zip = new JSZip();
  for (const [ad, icerik] of Object.entries(dosyalar)) zip.file(ad, icerik);
  return zip.generateAsync({ type: 'arraybuffer' });
}

// ---------------------------------------------------------------------------

describe('DESTEKLENEN_GIRDILER', () => {
  it('sözleşmedeki tüm uzantıları içerir', () => {
    const uzantilar = DESTEKLENEN_GIRDILER.map((g) => g.uzanti);
    for (const u of ['.geojson', '.json', '.kml', '.kmz', '.gpx', '.wkt', '.txt', '.csv', '.zip']) {
      expect(uzantilar).toContain(u);
    }
    for (const g of DESTEKLENEN_GIRDILER) expect(typeof g.aciklama).toBe('string');
  });
});

describe('GeoJSON', () => {
  it('FeatureCollection okur, Türkçe karakterleri korur', async () => {
    const fc = { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { ad: 'Iğdır Şehir Ğ' }, geometry: { type: 'Point', coordinates: [44, 39.9] } },
    ] };
    const { geojson, uyarilar } = await oku('a.geojson', JSON.stringify(fc));
    expect(geojson.type).toBe('FeatureCollection');
    expect(geojson.features[0].properties.ad).toBe('Iğdır Şehir Ğ');
    expect(uyarilar).toEqual([]);
  });

  it('tekil Feature sarmalanır', async () => {
    const { geojson } = await oku('a.json', JSON.stringify({
      type: 'Feature', properties: null, geometry: { type: 'Point', coordinates: [1, 2] },
    }));
    expect(geojson.features).toHaveLength(1);
    expect(geojson.features[0].properties).toEqual({});
  });

  it('çıplak geometri sarmalanır', async () => {
    const { geojson } = await oku('a.geojson', '{"type":"LineString","coordinates":[[0,0],[1,1]]}');
    expect(geojson.features[0].geometry.type).toBe('LineString');
  });

  it('BOM içeren dosyayı okur', async () => {
    const { geojson } = await oku('a.geojson', '﻿{"type":"Point","coordinates":[1,2]}');
    expect(geojson.features[0].geometry.coordinates).toEqual([1, 2]);
  });

  it('geçersiz JSON için Türkçe hata', async () => {
    await expect(oku('a.geojson', '{bozuk')).rejects.toThrow(/Geçersiz JSON/);
  });

  it('GeoJSON olmayan JSON için hata', async () => {
    await expect(oku('a.json', '{"foo":1}')).rejects.toThrow(/Geçersiz GeoJSON/);
    await expect(oku('a.json', '[1,2]')).rejects.toThrow(/Geçersiz GeoJSON/);
  });
});

describe('Genel hatalar', () => {
  it('boş dosya', async () => {
    await expect(dosyaOku({ ad: 'a.geojson', veri: new ArrayBuffer(0) })).rejects.toThrow(/boş/);
    await expect(oku('a.kml', '   \n ')).rejects.toThrow(/boş/);
  });

  it('desteklenmeyen uzantı (sahte veri üretmez)', async () => {
    await expect(oku('harita.dwg', 'x')).rejects.toThrow(/Desteklenmeyen dosya türü \(\.dwg\)/);
    await expect(oku('uzantisiz', 'x')).rejects.toThrow(/Desteklenmeyen/);
  });

  it('büyük harfli uzantıyı tanır', async () => {
    const { geojson } = await oku('A.GEOJSON', '{"type":"Point","coordinates":[1,2]}');
    expect(geojson.features).toHaveLength(1);
  });

  it('UTF-8 olmayan (Windows-1254) metni uyarıyla okur', async () => {
    // "Şişli" Windows-1254: Ş=0xDE ş=0xFE i=0x69 l=0x6C
    const baytlar = new Uint8Array([
      ...new TextEncoder().encode('ad,lat,lon\n'), 0xde, 0x69, 0xfe, 0x6c, 0x69,
      ...new TextEncoder().encode(',41,29\n'),
    ]);
    const { geojson, uyarilar } = await dosyaOku({ ad: 'a.csv', veri: baytlar.buffer });
    expect(geojson.features[0].properties.ad).toBe('Şişli');
    expect(uyarilar.join(' ')).toMatch(/Windows-1254/);
  });
});

describe('KML', () => {
  it('fixture KML okur (global DOMParser olmadan)', async () => {
    expect(globalThis.DOMParser).toBeUndefined();
    const { geojson } = await dosyaOku({ ad: 'ornek.kml', veri: fixture('ornek.kml') });
    expect(geojson.features).toHaveLength(2);
    expect(geojson.features[0].properties.name).toBe('Çankaya Köşkü');
    expect(geojson.features[0].geometry).toEqual({ type: 'Point', coordinates: [32.8597, 39.8885, 0] });
    expect(geojson.features[1].geometry.type).toBe('LineString');
  });

  it('MultiGeometry: aynı tip alt geometriler Multi* olur, karışık tipler GeometryCollection kalır', async () => {
    const pm = (ic) => `<Placemark><MultiGeometry>${ic}</MultiGeometry></Placemark>`;
    const nokta = (x) => `<Point><coordinates>${x},1</coordinates></Point>`;
    const hat = '<LineString><coordinates>0,0 1,1</coordinates></LineString>';
    const pol = (x) => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${x},0 ${x + 1},0 ${x + 1},1 ${x},0</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    const metin = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      ${pm(nokta(1) + nokta(2))}${pm(hat + hat)}${pm(pol(0) + pol(5))}${pm(nokta(1) + hat)}
    </Document></kml>`;
    const { geojson } = await oku('m.kml', metin);
    const g = geojson.features.map((f) => f.geometry);
    expect(g[0]).toEqual({ type: 'MultiPoint', coordinates: [[1, 1], [2, 1]] });
    expect(g[1]).toEqual({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[0, 0], [1, 1]]] });
    expect(g[2].type).toBe('MultiPolygon');
    expect(g[2].coordinates).toHaveLength(2);
    expect(g[2].coordinates[1][0][0]).toEqual([5, 0]);
    expect(g[3].type).toBe('GeometryCollection');
    expect(g[3].geometries.map((x) => x.type)).toEqual(['Point', 'LineString']);
  });

  it('KMZ içindeki MultiGeometry de sadeleştirilir', async () => {
    const veri = await zipUret({ 'doc.kml': '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><MultiGeometry><Point><coordinates>1,2</coordinates></Point><Point><coordinates>3,4</coordinates></Point></MultiGeometry></Placemark></kml>' });
    const { geojson } = await dosyaOku({ ad: 'a.kmz', veri });
    expect(geojson.features[0].geometry).toEqual({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });
  });

  it('bozuk XML için açık hata', async () => {
    await expect(oku('a.kml', '<kml><Placemark>')).rejects.toThrow(/KML/);
  });
});

describe('KMZ', () => {
  const kml = (ad) => `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>${ad}</name><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>`;

  it('doc.kml önceliklidir', async () => {
    const veri = await zipUret({ 'a.kml': kml('diğer'), 'doc.kml': kml('Ana Belge Ü'), 'files/x.png': 'png' });
    const { geojson, uyarilar } = await dosyaOku({ ad: 'a.kmz', veri });
    expect(geojson.features[0].properties.name).toBe('Ana Belge Ü');
    expect(uyarilar.join(' ')).toMatch(/2 KML/);
  });

  it('doc.kml yoksa kökteki ilk .kml', async () => {
    const veri = await zipUret({ 'alt/z.kml': kml('alt'), 'kok.kml': kml('kök') });
    const { geojson } = await dosyaOku({ ad: 'a.kmz', veri });
    expect(geojson.features[0].properties.name).toBe('kök');
  });

  it('KML yoksa açık hata', async () => {
    const veri = await zipUret({ 'resim.png': 'x' });
    await expect(dosyaOku({ ad: 'a.kmz', veri })).rejects.toThrow(/KMZ içinde KML dosyası bulunamadı/);
  });

  it('ZIP olmayan KMZ için hata', async () => {
    await expect(oku('a.kmz', 'zip değil')).rejects.toThrow(/KMZ dosyası açılamadı/);
  });
});

describe('GPX', () => {
  it('waypoint ve track okur', async () => {
    const { geojson } = await dosyaOku({ ad: 'ornek.gpx', veri: fixture('ornek.gpx') });
    const tipler = geojson.features.map((f) => f.geometry.type).sort();
    expect(tipler).toEqual(['LineString', 'Point']);
    const nokta = geojson.features.find((f) => f.geometry.type === 'Point');
    expect(nokta.properties.name).toBe('İstanbul Şişli');
    expect(nokta.geometry.coordinates).toEqual([28.9784, 41.0082]);
  });
});

describe('WKT / TXT', () => {
  it('satır başına bir WKT, bozuk satır uyarıyla atlanır', async () => {
    const { geojson, uyarilar } = await dosyaOku({ ad: 'ornek.wkt', veri: fixture('ornek.wkt') });
    expect(geojson.features.map((f) => f.geometry.type)).toEqual(['Point', 'LineString', 'Polygon']);
    expect(uyarilar).toEqual(['Satır 4: geçersiz WKT atlandı.']);
  });

  it('.txt de WKT olarak okunur (CRLF)', async () => {
    const { geojson } = await oku('a.txt', 'POINT (1 2)\r\nMULTIPOINT ((1 2), (3 4))\r\n');
    expect(geojson.features).toHaveLength(2);
  });

  it('hiç geçerli WKT yoksa hata', async () => {
    await expect(oku('a.wkt', 'merhaba\ndünya')).rejects.toThrow(/geçerli WKT/);
  });
});

describe('CSV', () => {
  it('; ayırıcı, BOM, tırnaklı alan, ondalık virgül, çok satırlı alan', async () => {
    const { geojson, uyarilar } = await dosyaOku({ ad: 'a.csv', veri: fixture('ornek_noktali_virgul.csv') });
    expect(geojson.features).toHaveLength(2);
    const [k, u] = geojson.features;
    expect(k.geometry).toEqual({ type: 'Point', coordinates: [32.8541, 39.9208] });
    expect(k.properties).toEqual({ ad: 'Kızılay; Meydan', açıklama: 'Ankara "merkez"' });
    expect(u.properties.açıklama).toBe('çok\nsatırlı');
    expect(uyarilar).toEqual(['Satır 5: geçersiz koordinat, satır atlandı.']);
  });

  it(', ayırıcı ve x/y sütunları', async () => {
    const { geojson } = await oku('a.csv', 'id,X,Y,not\n1,29.0,41.0,"a, b"\n');
    expect(geojson.features[0].geometry.coordinates).toEqual([29, 41]);
    expect(geojson.features[0].properties).toEqual({ id: '1', not: 'a, b' });
  });

  it('WKT sütunu öncelikli', async () => {
    const { geojson } = await oku('a.csv', 'ad,WKT,lat,lon\nhat,"LINESTRING (0 0, 1 1)",5,5\n');
    expect(geojson.features[0].geometry.type).toBe('LineString');
    expect(geojson.features[0].properties).toEqual({ ad: 'hat', lat: '5', lon: '5' });
  });

  it('geom / geometry sütun adları', async () => {
    const a = await oku('a.csv', 'geom;ad\nPOINT (1 2);x\n');
    const b = await oku('b.csv', 'Geometry,ad\nPOINT (3 4),y\n');
    expect(a.geojson.features[0].geometry.coordinates).toEqual([1, 2]);
    expect(b.geojson.features[0].geometry.coordinates).toEqual([3, 4]);
  });

  it('alt-dize eşleşmez (ör. "platform", "xyz")', async () => {
    await expect(oku('a.csv', 'platform,xyz,ylon\n1,2,3\n')).rejects.toThrow(/geometri sütunu bulunamadı/);
  });

  it('latitude/longitude ve enlem/boylam büyük harf', async () => {
    const a = await oku('a.csv', 'Latitude,Longitude\n10,20\n');
    const b = await oku('b.csv', 'ENLEM,BOYLAM\n10,20\n');
    expect(a.geojson.features[0].geometry.coordinates).toEqual([20, 10]);
    expect(b.geojson.features[0].geometry.coordinates).toEqual([20, 10]);
  });

  it('bozuk WKT satırı uyarıyla atlanır', async () => {
    const { geojson, uyarilar } = await oku('a.csv', 'wkt\nPOINT (1 2)\nbozuk\n');
    expect(geojson.features).toHaveLength(1);
    expect(uyarilar).toEqual(['Satır 3: geçersiz veya boş WKT, satır atlandı.']);
  });
});

describe('Zipli Shapefile', () => {
  it('tek katman, .prj ile, UTF-8 dbf', async () => {
    const veri = await zipUret({
      'iller.shp': shpNokta([[32.85, 39.92], [28.97, 41.01]]),
      'iller.dbf': dbfTekAlan('AD', ['Ankara', 'İstanbul']),
      'iller.cpg': 'UTF-8',
      'iller.prj': WGS84_PRJ,
    });
    const { geojson } = await dosyaOku({ ad: 'iller.zip', veri });
    expect(geojson.features).toHaveLength(2);
    expect(geojson.features[0].geometry.type).toBe('Point');
    expect(geojson.features[0].geometry.coordinates[0]).toBeCloseTo(32.85, 6);
    expect(geojson.features[0].geometry.coordinates[1]).toBeCloseTo(39.92, 6);
    expect(geojson.features[1].properties.AD).toBe('İstanbul');
  });

  it('.prj yoksa uyarır, koordinatlar aynen kalır', async () => {
    const veri = await zipUret({
      'k.shp': shpNokta([[500000, 4400000]]),
      'k.dbf': dbfTekAlan('AD', ['a']),
    });
    const { geojson, uyarilar } = await dosyaOku({ ad: 'k.zip', veri });
    expect(geojson.features[0].geometry.coordinates).toEqual([500000, 4400000]);
    expect(uyarilar.join(' ')).toMatch(/\.prj dosyası yok/);
  });

  it('birden fazla katman birleştirilir', async () => {
    const veri = await zipUret({
      'a.shp': shpNokta([[1, 1]]), 'a.dbf': dbfTekAlan('AD', ['x']), 'a.prj': WGS84_PRJ,
      'alt/b.shp': shpNokta([[2, 2], [3, 3]]), 'alt/b.prj': WGS84_PRJ,
    });
    const { geojson, uyarilar } = await dosyaOku({ ad: 'k.zip', veri });
    expect(geojson.features).toHaveLength(3);
    expect(geojson.features.map((f) => f.properties.katman).sort()).toEqual(['a', 'alt/b', 'alt/b']);
    expect(uyarilar.join(' ')).toMatch(/2 katman birleştirildi/);
  });

  it('shp içermeyen zip için hata', async () => {
    const veri = await zipUret({ 'oku.txt': 'x' });
    await expect(dosyaOku({ ad: 'k.zip', veri })).rejects.toThrow(/Shapefile \(\.shp\) bulunamadı/);
  });
});
