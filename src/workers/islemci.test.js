import { describe, it, expect } from 'vitest';
import { oku, donustur, wgs84e, istekIsle } from './islemci.js';

const kodla = (metin) => {
  const u8 = new TextEncoder().encode(metin);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
};

const ornekFc = () => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { ad: 'Nokta A' },
      geometry: { type: 'Point', coordinates: [30, 40, 0] },
    },
    {
      type: 'Feature',
      properties: { ad: 'Hat B' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [30, 40, 12.5],
          [30.5, 40.5, 0],
        ],
      },
    },
  ],
});

/** Tüm koordinatları düz bir diziye toplar. */
function koordinatlar(fc) {
  const sonuc = [];
  const gez = (c) => {
    if (typeof c[0] === 'number') sonuc.push(c);
    else c.forEach(gez);
  };
  for (const f of fc.features) if (f.geometry) gez(f.geometry.coordinates);
  return sonuc;
}

const metneCevir = (veri) => (typeof veri === 'string' ? veri : new TextDecoder().decode(veri));

describe('islemci — oku', () => {
  it('GeoJSON dosyasını okur, istatistik ve CRS tahmini üretir, ilerleme bildirir', async () => {
    const ilerlemeler = [];
    const sonuc = await oku(
      { ad: 'ornek.geojson', veri: kodla(JSON.stringify(ornekFc())) },
      (i) => ilerlemeler.push(i),
    );

    expect(sonuc.geojson.type).toBe('FeatureCollection');
    expect(sonuc.geojson.features).toHaveLength(2);
    expect(Array.isArray(sonuc.uyarilar)).toBe(true);
    expect(sonuc.istatistik.objeSayisi).toBe(2);
    expect(sonuc.istatistik.koordinatSayisi).toBe(3);
    expect(sonuc.istatistik.zIceriyor).toBe(true);
    expect(sonuc.tahminiCrs).toBe('EPSG:4326');

    expect(ilerlemeler[0].asama).toBe('Dosya okunuyor');
    expect(ilerlemeler.at(-1)).toEqual({ yuzde: 100, asama: 'Tamamlandı' });
    const yuzdeler = ilerlemeler.map((i) => i.yuzde);
    expect([...yuzdeler].sort((a, b) => a - b)).toEqual(yuzdeler);
  });

  it('projeksiyonlu koordinatlarda CRS tahmini null olur', async () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [500000, 4400000] } },
      ],
    };
    const sonuc = await oku({ ad: 'utm.geojson', veri: kodla(JSON.stringify(fc)) });
    expect(sonuc.tahminiCrs).toBeNull();
  });

  it('Uint8Array girdiyi de kabul eder', async () => {
    const sonuc = await oku({
      ad: 'ornek.geojson',
      veri: new TextEncoder().encode(JSON.stringify(ornekFc())),
    });
    expect(sonuc.geojson.features).toHaveLength(2);
  });

  it('boş dosyada ve desteklenmeyen uzantıda Türkçe hata fırlatır', async () => {
    await expect(oku({ ad: 'bos.geojson', veri: new ArrayBuffer(0) })).rejects.toThrow(/boş/);
    await expect(oku({ ad: 'dosya.xyz', veri: kodla('abc') })).rejects.toThrow();
  });
});

describe('islemci — donustur', () => {
  it('GeoJSON → WKT (aynı CRS) üretir, girdiyi değiştirmez', async () => {
    const girdi = ornekFc();
    const kopya = structuredClone(girdi);
    const ilerlemeler = [];
    const { sonuc, haritaGeojson, istatistik } = await donustur(
      girdi,
      '.wkt',
      { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:4326', zTemizle: false, hassasiyet: null },
      (i) => ilerlemeler.push(i),
    );

    const wkt = metneCevir(sonuc.veri);
    expect(wkt).toMatch(/POINT/i);
    expect(wkt).toMatch(/LINESTRING/i);
    expect(sonuc.uzanti).toBe('.wkt');
    expect(typeof sonuc.mime).toBe('string');
    expect(typeof sonuc.onizleme).toBe('string');
    expect(istatistik.objeSayisi).toBe(2);
    expect(haritaGeojson.features).toHaveLength(2);
    expect(girdi).toEqual(kopya);

    const asamalar = ilerlemeler.map((i) => i.asama);
    expect(asamalar).toContain('Koordinatlar dönüştürülüyor');
    expect(asamalar).toContain('Dosya yazılıyor');
    expect(asamalar).not.toContain('Z değerleri temizleniyor');
    expect(ilerlemeler.at(-1).yuzde).toBe(100);
  });

  it('GeoJSON → KML üretir', async () => {
    const { sonuc } = await donustur(ornekFc(), '.kml', {
      kaynakCrs: 'EPSG:4326',
      hedefCrs: 'EPSG:4326',
      zTemizle: false,
      hassasiyet: null,
    });
    const kml = metneCevir(sonuc.veri);
    expect(kml).toMatch(/<kml/);
    expect(kml).toMatch(/<Placemark/);
    expect(kml).toMatch(/30(\.0+)?,40(\.0+)?/);
  });

  it('geometriTipi: çizgi WKT çıktısında POLYGON olarak yazılır ve uyarı döner', async () => {
    const fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[30, 40], [31, 40], [31, 41]] } }],
    };
    const d = await donustur(fc, '.wkt', { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:4326', geometriTipi: 'Polygon' });
    expect(metneCevir(d.sonuc.veri).trim()).toBe('POLYGON ((30 40, 31 40, 31 41, 30 40))');
    expect(d.istatistik.geometriTipleri).toEqual({ Polygon: 1 });
    expect(d.uyarilar.join(' ')).toMatch(/kapatıldı/);
    const geri = await donustur(d.haritaGeojson, '.wkt', { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:4326', geometriTipi: 'LineString' });
    expect(metneCevir(geri.sonuc.veri).trim()).toBe('LINESTRING (30 40, 31 40, 31 41, 30 40)');
  });

  it('geçerlilik: yazılan geometri denetlenir; sorun konumu haritaya WGS84 olarak taşınır', async () => {
    // İnce bir poligon: hassasiyet 0 basamağa yuvarlanınca tüm noktaları doğrusal (sıfır alanlı) olur.
    const ince = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[33, 39.9], [33.0001, 39.9], [33.0001, 39.9001], [33, 39.9]]] } }],
    };
    const temiz = await donustur(ince, '.wkt', { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:4326' });
    expect(temiz.gecerlilik).toMatchObject({ denetlenen: 1, gecerli: 1, gecersiz: 0 });

    // 3 basamağa yuvarlanınca köşeler çakışır: hassasiyet de geçersiz geometri üretebilir.
    const bozuk = await donustur(ince, '.wkt', { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:4326', hassasiyet: 3 });
    expect(bozuk.gecerlilik.gecersiz).toBe(1);
    expect(bozuk.gecerlilik.sorunlar[0].neden).toMatch(/farklı noktadan/);

    // Projeksiyonlu hedefte sorun konumu metre cinsinden, harita konumu WGS84'te verilir.
    const papyon = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[33, 39.9], [33.01, 39.91], [33.01, 39.9], [33, 39.91], [33, 39.9]]] } }],
    };
    const tm = await donustur(papyon, '.wkt', { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:5255' });
    const [sorun] = tm.gecerlilik.sorunlar;
    expect(sorun.neden).toMatch(/kendisiyle kesişiyor/);
    expect(sorun.konum[0]).toBeGreaterThan(400000); // TM33 doğu (metre)
    expect(sorun.haritaKonum[0]).toBeCloseTo(33.005, 3); // WGS84 boylam
    expect(sorun.haritaKonum[1]).toBeCloseTo(39.905, 3);
  });

  it('oku geçerlilik özetini de döndürür', async () => {
    const papyon = { type: 'Polygon', coordinates: [[[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]] };
    const { gecerlilik } = await oku({ ad: 'p.geojson', veri: kodla(JSON.stringify(papyon)) });
    expect(gecerlilik).toMatchObject({ denetlenen: 1, gecersiz: 1 });
  });

  it('KML/KMZ çıktısında WGS84 dışı hedef koordinat sistemini reddeder', async () => {
    for (const uzanti of ['.kml', '.KMZ']) {
      await expect(
        donustur(ornekFc(), uzanti, { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:5254' }),
      ).rejects.toThrow(/yalnızca WGS84/);
    }
    // Projeksiyonlu kaynaktan WGS84 KML'e dönüşüm ise serbesttir.
    const { sonuc } = await donustur(ornekFc(), '.kml', { kaynakCrs: 'EPSG:4326', hedefCrs: 'epsg:4326' });
    expect(metneCevir(sonuc.veri)).toMatch(/<kml/);
  });

  it('EPSG:4326 → EPSG:3857 dönüştürür; haritaGeojson WGS84 kalır', async () => {
    const { sonuc, haritaGeojson, istatistik } = await donustur(ornekFc(), '.geojson', {
      kaynakCrs: 'EPSG:4326',
      hedefCrs: 'EPSG:3857',
      zTemizle: false,
      hassasiyet: null,
    });
    const cikti = JSON.parse(metneCevir(sonuc.veri));
    const [x, y] = cikti.features[0].geometry.coordinates;
    expect(x).toBeCloseTo(3339584.72, 0);
    expect(y).toBeCloseTo(4865942.28, 0);
    expect(istatistik.bbox[0]).toBeGreaterThan(1e6);

    const [lon, lat] = haritaGeojson.features[0].geometry.coordinates;
    expect(lon).toBeCloseTo(30, 6);
    expect(lat).toBeCloseTo(40, 6);
  });

  it('ITRF96 TM30 (EPSG:5254) dönüşümü merkez meridyende doğu=500000 verir', async () => {
    const { sonuc } = await donustur(ornekFc(), '.geojson', {
      kaynakCrs: 'EPSG:4326',
      hedefCrs: 'EPSG:5254',
      zTemizle: true,
      hassasiyet: 3,
    });
    const cikti = JSON.parse(metneCevir(sonuc.veri));
    const [x, y] = cikti.features[0].geometry.coordinates;
    expect(x).toBeCloseTo(500000, 0);
    expect(y).toBeGreaterThan(4_400_000);
    expect(y).toBeLessThan(4_500_000);
  });

  it('zTemizle ile Z değerleri kaldırılır ve aşama bildirilir', async () => {
    const ilerlemeler = [];
    const { sonuc, haritaGeojson, istatistik } = await donustur(
      ornekFc(),
      '.geojson',
      { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:4326', zTemizle: true, hassasiyet: null },
      (i) => ilerlemeler.push(i),
    );
    const cikti = JSON.parse(metneCevir(sonuc.veri));
    for (const k of koordinatlar(cikti)) expect(k).toHaveLength(2);
    for (const k of koordinatlar(haritaGeojson)) expect(k).toHaveLength(2);
    expect(istatistik.zIceriyor).toBe(false);
    expect(ilerlemeler.map((i) => i.asama)).toContain('Z değerleri temizleniyor');
  });

  it('zTemizle ve WKT birlikte: çıktıda Z boyutu kalmaz', async () => {
    const { sonuc } = await donustur(ornekFc(), '.wkt', {
      kaynakCrs: 'EPSG:4326',
      hedefCrs: 'EPSG:4326',
      zTemizle: true,
      hassasiyet: null,
    });
    const wkt = metneCevir(sonuc.veri);
    expect(wkt).not.toMatch(/\bZ\b/);
    expect(wkt).not.toMatch(/12\.5/);
  });

  it('hassasiyet uygulanır', async () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [30.123456789, 40.987654321] },
        },
      ],
    };
    const { sonuc } = await donustur(fc, '.geojson', {
      kaynakCrs: 'EPSG:4326',
      hedefCrs: 'EPSG:4326',
      zTemizle: false,
      hassasiyet: 2,
    });
    const cikti = JSON.parse(metneCevir(sonuc.veri));
    expect(cikti.features[0].geometry.coordinates).toEqual([30.12, 40.99]);
  });

  it('geçersiz girdilerde Türkçe hata fırlatır', async () => {
    const sec = { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:4326', zTemizle: false, hassasiyet: null };
    await expect(donustur(null, '.wkt', sec)).rejects.toThrow(/FeatureCollection/);
    await expect(donustur(ornekFc(), '', sec)).rejects.toThrow(/format/);
    await expect(donustur(ornekFc(), '.wkt', { ...sec, kaynakCrs: '' })).rejects.toThrow(/Koordinat/);
    await expect(donustur(ornekFc(), '.wkt', { ...sec, hassasiyet: -1 })).rejects.toThrow(/Hassasiyet/);
  });
});

describe('islemci — uçtan uca', () => {
  it('oku → donustur → wgs84e zinciri tutarlıdır', async () => {
    const okunan = await oku({ ad: 'a.geojson', veri: kodla(JSON.stringify(ornekFc())) });
    const { sonuc } = await donustur(okunan.geojson, '.geojson', {
      kaynakCrs: okunan.tahminiCrs,
      hedefCrs: 'EPSG:3857',
      zTemizle: true,
      hassasiyet: null,
    });
    const merkator = JSON.parse(metneCevir(sonuc.veri));
    const geri = await wgs84e(merkator, 'EPSG:3857');
    const [lon, lat] = geri.features[0].geometry.coordinates;
    expect(lon).toBeCloseTo(30, 6);
    expect(lat).toBeCloseTo(40, 6);
  });

  it('wgs84e EPSG:4326 girdisini aynen döndürür', async () => {
    const fc = ornekFc();
    expect(await wgs84e(fc, 'EPSG:4326')).toBe(fc);
  });

  it('istekIsle protokol tiplerini yönlendirir, bilinmeyeni reddeder', async () => {
    const okunan = await istekIsle('oku', { ad: 'a.geojson', veri: kodla(JSON.stringify(ornekFc())) });
    expect(okunan.geojson.features).toHaveLength(2);
    const d = await istekIsle('donustur', {
      geojson: okunan.geojson,
      hedefUzanti: '.wkt',
      secenekler: { kaynakCrs: 'EPSG:4326', hedefCrs: 'EPSG:4326', zTemizle: false, hassasiyet: null },
    });
    expect(metneCevir(d.sonuc.veri)).toMatch(/POINT/i);
    await expect(istekIsle('yok', {})).rejects.toThrow(/Bilinmeyen/);
  });
});
