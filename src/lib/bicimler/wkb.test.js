import { describe, it, expect } from 'vitest';
import { geometriWkb, geometriTipiPolitikasi, hexe, sridCoz, wkbYaz, zVarMi } from './wkb.js';
import { wktCoz } from '../wkt.js';

const hex = (g, s) => hexe(geometriWkb(g, s));

describe('geometriWkb — referans değerler', () => {
  it('POINT(1 2) little-endian', () => {
    expect(hex({ type: 'Point', coordinates: [1, 2] })).toBe('0101000000000000000000F03F0000000000000040');
  });

  it('POINT(1 2) big-endian', () => {
    expect(hex({ type: 'Point', coordinates: [1, 2] }, { endian: 'big' })).toBe('00000000013FF00000000000004000000000000000');
  });

  it('POINT Z (1 2 3) ISO: tip 1001', () => {
    expect(hex({ type: 'Point', coordinates: [1, 2, 3] })).toBe(
      '01E9030000000000000000F03F00000000000000400000000000000840',
    );
  });

  it('EWKB SRID=4326;POINT(1 2) — PostGIS çıktısıyla aynı', () => {
    expect(hex({ type: 'Point', coordinates: [1, 2] }, { ewkbSrid: 4326 })).toBe(
      '0101000020E6100000000000000000F03F0000000000000040',
    );
  });

  it('EWKB SRID=4326;POINT Z (1 2 3) — Z ve SRID bayrağı', () => {
    expect(hex({ type: 'Point', coordinates: [1, 2, 3] }, { ewkbSrid: 4326 })).toBe(
      '01010000A0E6100000000000000000F03F00000000000000400000000000000840',
    );
  });

  it('LINESTRING(0 0, 1 1)', () => {
    expect(hex({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toBe(
      '010200000002000000' + '0'.repeat(32) + '000000000000F03F000000000000F03F',
    );
  });

  it('boş nokta NaN koordinatlarla yazılır', () => {
    const h = hex({ type: 'Point', coordinates: [] });
    expect(h).toBe('0101000000000000000000F87F000000000000F87F');
    expect(wktCoz(h)).toBeNull();
  });

  it('EWKB çoklu geometride SRID yalnızca en dışta, Z bayrağı üyelerde de', () => {
    const b = geometriWkb({ type: 'MultiPoint', coordinates: [[1, 2, 3]] }, { ewkbSrid: 5255 });
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(1, true)).toBe(0xa0000004);
    expect(dv.getUint32(5, true)).toBe(5255);
    expect(dv.getUint32(9, true)).toBe(1); // üye sayısı
    expect(dv.getUint32(14, true)).toBe(0x80000001); // üye: Z, SRID yok
  });

  it('ISO Z çoklu geometride üyeler de +1000 kodu taşır', () => {
    const b = geometriWkb({ type: 'MultiLineString', coordinates: [[[0, 0, 1], [1, 1, 1]]] });
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(1, true)).toBe(1005);
    expect(dv.getUint32(10, true)).toBe(1002);
  });

  it('karışık boyutta Z eksik koordinata 0 yazılır; z:false Z\'yi atar', () => {
    const g = { type: 'LineString', coordinates: [[0, 0, 5], [1, 1]] };
    expect(wktCoz(hex(g))).toEqual({ type: 'LineString', coordinates: [[0, 0, 5], [1, 1, 0]] });
    expect(wktCoz(hex(g, { z: false }))).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1]] });
  });

  it.each([
    [{ type: 'Point', coordinates: ['a', 1] }, /geçersiz koordinat/],
    [{ type: 'Point', coordinates: [NaN, 1] }, /geçersiz koordinat/],
    [{ type: 'CircularString', coordinates: [] }, /çevrilemeyen geometri tipi/],
    [null, /geçerli bir GeoJSON geometrisi/],
  ])('hatalı girdi %#', (g, desen) => {
    expect(() => geometriWkb(g)).toThrow(desen);
  });

  it('geçersiz seçenekler', () => {
    const p = { type: 'Point', coordinates: [1, 2] };
    expect(() => geometriWkb(p, { endian: 'orta' })).toThrow(/bayt sırası/);
    expect(() => geometriWkb(p, { ewkbSrid: -1 })).toThrow(/SRID/);
  });

  it('zVarMi', () => {
    expect(zVarMi({ type: 'Point', coordinates: [1, 2] })).toBe(false);
    expect(zVarMi({ type: 'Polygon', coordinates: [[[0, 0], [1, 0, 2], [0, 0]]] })).toBe(true);
    expect(zVarMi({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 2, 3] }] })).toBe(true);
  });
});

describe('geometriWkb — wkt.js ile gidiş-dönüş', () => {
  const poligon = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [4, 2], [4, 4], [2, 2]]];
  const ornekler = [
    { type: 'Point', coordinates: [500123.456789, 4512345.987654] },
    { type: 'Point', coordinates: [29.1, 41.2, 120.5] },
    { type: 'LineString', coordinates: [[0, 0], [1.5, -2.25], [3, 4]] },
    { type: 'Polygon', coordinates: poligon },
    { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] },
    { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
    { type: 'MultiPolygon', coordinates: [poligon, [[[20, 20], [21, 20], [21, 21], [20, 20]]]] },
    { type: 'MultiPolygon', coordinates: [[[[0, 0, 1], [1, 0, 2], [1, 1, 3], [0, 0, 1]]]] },
    {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 2] },
        { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
        { type: 'Polygon', coordinates: poligon },
      ],
    },
  ];

  it.each(ornekler.map((g) => [g.type, g]))('%s (little, big, EWKB)', (_ad, g) => {
    expect(wktCoz(hex(g))).toEqual(g);
    expect(wktCoz(hex(g, { endian: 'big' }))).toEqual(g);
    expect(wktCoz(hex(g, { ewkbSrid: 5255 }))).toEqual(g);
    expect(wktCoz(hex(g, { ewkbSrid: 5255, endian: 'big' }))).toEqual(g);
  });
});

describe('wkbYaz', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', properties: {}, geometry: null },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
    ],
  };

  it('satır başına bir büyük harf hex geometri; null atlanır ve uyarılır', async () => {
    const { veri, onizleme, uyarilar } = await wkbYaz(fc);
    const satirlar = veri.split('\n');
    expect(satirlar).toHaveLength(2);
    expect(satirlar[0]).toBe('0101000000000000000000F03F0000000000000040');
    expect(satirlar.every((s) => /^[0-9A-F]+$/.test(s))).toBe(true);
    expect(wktCoz(satirlar[1])).toEqual(fc.features[2].geometry);
    expect(onizleme).toBe(veri);
    expect(uyarilar.join(' ')).toMatch(/1 obje geometrisiz/);
  });

  it('endian seçeneği', async () => {
    const { veri } = await wkbYaz(fc, { endian: 'big' });
    expect(veri.split('\n')[0]).toBe('00000000013FF00000000000004000000000000000');
  });

  it('kodlanamayan geometri atlanır ve uyarılır', async () => {
    const { veri, uyarilar } = await wkbYaz({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: ['x', 1] } }],
    });
    expect(veri).toBe('');
    expect(uyarilar.join(' ')).toMatch(/1\. obje WKB'ye çevrilemedi/);
  });

  it('uzun çıktıda önizleme kısaltılır', async () => {
    const features = Array.from({ length: 250 }, (_, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [i, i] },
    }));
    const { veri, onizleme } = await wkbYaz({ type: 'FeatureCollection', features });
    expect(veri.split('\n')).toHaveLength(250);
    expect(onizleme.split('\n')).toHaveLength(201);
    expect(onizleme).toMatch(/50 satır daha; toplam 250 satır/);
  });

  it('geçersiz FC hata verir', async () => {
    await expect(wkbYaz({ type: 'Feature' })).rejects.toThrow(/FeatureCollection/);
  });
});

describe('wkbYaz — EWKB seçeneği', () => {
  const fc1 = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } }],
  };

  it('ewkb + crs → SRID gömülü EWKB', async () => {
    const { veri, uyarilar } = await wkbYaz(fc1, { ewkb: true, crs: 'EPSG:4326' });
    expect(veri).toBe('0101000020E6100000000000000000F03F0000000000000040');
    expect(uyarilar).toEqual([]);
  });

  it('ewkb ama crs çözülemiyor → ISO + uyarı; varsayılan ISO', async () => {
    const r = await wkbYaz(fc1, { ewkb: true });
    expect(r.veri).toBe('0101000000000000000000F03F0000000000000040');
    expect(r.uyarilar.join(' ')).toMatch(/SRID çıkarılamadı/);
    expect((await wkbYaz(fc1, { crs: 'EPSG:4326' })).veri).toBe('0101000000000000000000F03F0000000000000040');
  });
});

describe('sridCoz', () => {
  it.each([
    ['EPSG:5255', 5255],
    ['epsg:4326', 4326],
    ['urn:ogc:def:crs:EPSG::23036', 23036],
    [3857, 3857],
    ['WGS84', null],
    [undefined, null],
  ])('%s → %s', (girdi, beklenen) => {
    expect(sridCoz(girdi)).toBe(beklenen);
  });
});

describe('geometriTipiPolitikasi', () => {
  const P = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const MP = { type: 'MultiPolygon', coordinates: [P.coordinates] };
  const L = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
  const N = { type: 'Point', coordinates: [1, 2] };

  it('aynı tip → o tip, dönüşüm yok', () => {
    const p = geometriTipiPolitikasi([P, P]);
    expect(p.tip).toBe('Polygon');
    expect(p.donustur(P)).toBe(P);
  });

  it('Polygon + MultiPolygon → MultiPolygon, tekil yükseltilir', () => {
    const p = geometriTipiPolitikasi([P, MP, P]);
    expect(p).toMatchObject({ tip: 'MultiPolygon', yukseltilen: 2, duzlestirilen: 0 });
    expect(p.donustur(P)).toEqual(MP);
    expect(p.donustur(MP)).toBe(MP);
  });

  it('Point + MultiPoint, LineString + MultiLineString', () => {
    expect(geometriTipiPolitikasi([N, { type: 'MultiPoint', coordinates: [[3, 4]] }]).tip).toBe('MultiPoint');
    expect(geometriTipiPolitikasi([L, { type: 'MultiLineString', coordinates: [L.coordinates] }]).tip).toBe('MultiLineString');
  });

  it('tek aileli GeometryCollection Multi tipine düzleştirilir (iç içe dahil)', () => {
    const gc = { type: 'GeometryCollection', geometries: [P, { type: 'GeometryCollection', geometries: [MP] }] };
    const p = geometriTipiPolitikasi([gc, P]);
    expect(p).toMatchObject({ tip: 'MultiPolygon', duzlestirilen: 1, yukseltilen: 1 });
    expect(p.donustur(gc)).toEqual({ type: 'MultiPolygon', coordinates: [P.coordinates, P.coordinates] });
    expect(geometriTipiPolitikasi([gc]).tip).toBe('MultiPolygon');
  });

  it('farklı aileler → Geometry; karışık GC listesi → GeometryCollection', () => {
    expect(geometriTipiPolitikasi([P, L]).tip).toBe('Geometry');
    expect(geometriTipiPolitikasi([MP, N]).tip).toBe('Geometry');
    const gc = { type: 'GeometryCollection', geometries: [P, L] };
    expect(geometriTipiPolitikasi([gc, gc]).tip).toBe('GeometryCollection');
    expect(geometriTipiPolitikasi([gc, P]).tip).toBe('Geometry');
    expect(geometriTipiPolitikasi([]).tip).toBe('Geometry');
  });

  it('Z bilgisi', () => {
    expect(geometriTipiPolitikasi([{ type: 'Point', coordinates: [1, 2, 3] }, N])).toMatchObject({ z: true, karisikZ: true });
  });
});
