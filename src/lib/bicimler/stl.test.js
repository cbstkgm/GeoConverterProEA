import { describe, it, expect } from 'vitest';
import { stlYaz } from './stl.js';

const X0 = 500000;
const Y0 = 4400000;
const kare = (x, y, b, z = 100) => [[x, y, z], [x + b, y, z], [x + b, y + b, z], [x, y + b, z], [x, y, z]];
const DELIKLI = { type: 'Polygon', coordinates: [kare(X0, Y0, 10), kare(X0 + 2, Y0 + 2, 2).reverse()] };
const ornekFc = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { ad: 'Çağlayan' }, geometry: DELIKLI },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'MultiPolygon', coordinates: [[kare(X0 + 20, Y0, 1)], [kare(X0 + 30, Y0, 1)]] },
          { type: 'LineString', coordinates: [[X0, Y0 + 20, 100], [X0 + 5, Y0 + 20, 100]] },
          { type: 'Point', coordinates: [X0 + 1, Y0 + 30, 100] },
        ],
      },
    },
    { type: 'Feature', properties: {}, geometry: null },
  ],
});

/** Küçük ikili STL çözücü. */
function ikiliCoz(bayt) {
  const dv = new DataView(bayt.buffer, bayt.byteOffset, bayt.byteLength);
  const baslik = new TextDecoder().decode(bayt.subarray(0, 80)).replace(/\0+$/, '');
  const n = dv.getUint32(80, true);
  const ucgenler = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    const f = Array.from({ length: 12 }, (_, j) => dv.getFloat32(o + j * 4, true));
    ucgenler.push({ normal: f.slice(0, 3), koseler: [f.slice(3, 6), f.slice(6, 9), f.slice(9, 12)], oz: dv.getUint16(o + 48, true) });
  }
  return { baslik, n, ucgenler };
}

/** Küçük ASCII STL çözücü. */
function asciiCoz(metin) {
  const ucgenler = [];
  let u = null;
  for (const satir of metin.split('\n').map((s) => s.trim())) {
    if (satir.startsWith('facet normal')) u = { normal: satir.split(/\s+/).slice(2).map(Number), koseler: [] };
    else if (satir.startsWith('vertex')) u.koseler.push(satir.split(/\s+/).slice(1).map(Number));
    else if (satir === 'endfacet') ucgenler.push(u);
  }
  return { ilk: metin.split('\n')[0], son: metin.trim().split('\n').at(-1), ucgenler };
}

const alan = ({ koseler: [a, b, c] }) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

describe('stlYaz — ikili', () => {
  it('başlık, üçgen sayısı, dosya boyu, normaller, merkez', async () => {
    const { veri, uyarilar, onizleme } = await stlYaz(ornekFc());
    expect(veri).toBeInstanceOf(Uint8Array);
    const c = ikiliCoz(veri);
    expect(c.n).toBe(12); // 8 (delikli) + 2 + 2
    expect(veri.length).toBe(84 + 12 * 50);
    expect(c.baslik.startsWith('solid')).toBe(false);
    expect(c.baslik).toBe(`GeoConverterProEA merkez=${X0 + 15.5},${Y0 + 15},100`);
    expect(c.ucgenler.every((u) => u.normal[2] === 1 && u.oz === 0)).toBe(true);
    // Delikli poligon: toplam alan 96, köşeler merkeze göre (float32'de tam).
    const ilk8 = c.ucgenler.slice(0, 8);
    expect(ilk8.reduce((s, u) => s + alan(u), 0)).toBeCloseTo(96, 5);
    const koseler = ilk8.flatMap((u) => u.koseler).map((k) => [k[0] + X0 + 15.5, k[1] + Y0 + 15, k[2] + 100]);
    expect(koseler).toContainEqual([X0, Y0, 100]);
    expect(koseler).toContainEqual([X0 + 4, Y0 + 4, 100]);
    expect(uyarilar.join(' ')).toMatch(/1 çizgi ve 1 nokta parçası atlandı/);
    expect(uyarilar.join(' ')).toMatch(/1 obje geometrisiz/);
    expect(onizleme).toMatch(/Üçgen sayısı: 12/);
  });

  it('uzun merkez başlığa sığdırılır', async () => {
    const z = -1234.56789012345;
    const a = [-1234567.891234567, -4400000.987654321, z];
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[a, [-1234566.1, -4400000.987654321, z], [-1234566.1, -4399999.3333333, z], a]] } }] };
    const { veri, uyarilar } = await stlYaz(fc);
    expect(ikiliCoz(veri).baslik.length).toBeLessThanOrEqual(80);
    expect(uyarilar.join(' ')).toMatch(/milimetreye/);
  });

  it('boş FC: 0 üçgenli geçerli dosya + uyarı', async () => {
    const { veri, uyarilar } = await stlYaz({ type: 'FeatureCollection', features: [] });
    expect(veri.length).toBe(84);
    expect(ikiliCoz(veri).n).toBe(0);
    expect(uyarilar.join(' ')).toMatch(/0 üçgen/);
  });
});

describe('stlYaz — ASCII', () => {
  it('solid adı merkezi taşır; üçgenler ikiliyle aynı', async () => {
    const { veri } = await stlYaz(ornekFc(), { ascii: true });
    const a = asciiCoz(veri);
    expect(a.ilk).toBe(`solid GeoConverterProEA_merkez_${X0 + 15.5}_${Y0 + 15}_100`);
    expect(a.son).toBe(`endsolid GeoConverterProEA_merkez_${X0 + 15.5}_${Y0 + 15}_100`);
    const ikili = ikiliCoz((await stlYaz(ornekFc())).veri);
    expect(a.ucgenler).toHaveLength(12);
    expect(a.ucgenler.map((u) => u.koseler)).toEqual(ikili.ucgenler.map((u) => u.koseler));
    expect(a.ucgenler[0].normal).toEqual([0, 0, 1]);
  });

  it('null geometri tek başına: boş solid', async () => {
    const { veri, uyarilar } = await stlYaz({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null }] }, { ascii: true });
    expect(asciiCoz(veri).ucgenler).toHaveLength(0);
    expect(uyarilar.join(' ')).toMatch(/geometrisiz/);
  });
});
