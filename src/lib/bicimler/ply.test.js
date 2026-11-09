import { describe, it, expect } from 'vitest';
import { plyYaz } from './ply.js';

const X0 = 500000;
const Y0 = 4400000;
const kare = (x, y, b, z = 100) => [[x, y, z], [x + b, y, z], [x + b, y + b, z], [x, y + b, z], [x, y, z]];
const DELIKLI = { type: 'Polygon', coordinates: [kare(X0, Y0, 10), kare(X0 + 2, Y0 + 2, 2).reverse()] };
const ornekFc = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { ad: 'Çağlayan Şişli' }, geometry: DELIKLI },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'MultiPolygon', coordinates: [[kare(X0 + 20, Y0, 1)], [kare(X0 + 30, Y0, 1)]] },
          { type: 'LineString', coordinates: [[X0, Y0 + 20, 100], [X0 + 5, Y0 + 20, 100], [X0 + 5, Y0 + 25, 100]] },
          { type: 'Point', coordinates: [X0 + 1, Y0 + 30, 105] },
        ],
      },
    },
    { type: 'Feature', properties: {}, geometry: null },
  ],
});

/** Küçük PLY çözücü (ascii ve binary_little_endian; bu yazıcının ürettiği özellik türleri). */
function plyCoz(veri) {
  const bayt = typeof veri === 'string' ? new TextEncoder().encode(veri) : veri;
  const metin = new TextDecoder('latin1').decode(bayt);
  const son = metin.indexOf('end_header\n') + 'end_header\n'.length;
  const baslik = metin.slice(0, son).split('\n');
  const format = baslik[1].split(' ')[1];
  const elemanlar = [];
  const yorumlar = [];
  for (const s of baslik) {
    const p = s.split(' ');
    if (p[0] === 'element') elemanlar.push({ ad: p[1], n: Number(p[2]), ozellikler: [] });
    else if (p[0] === 'property') elemanlar.at(-1).ozellikler.push(p[1] === 'list' ? { ad: p[4], liste: [p[2], p[3]] } : { ad: p[2], tur: p[1] });
    else if (p[0] === 'comment') yorumlar.push(p.slice(1).join(' '));
  }
  const sonuc = { format, yorumlar, baslik };
  if (format === 'ascii') {
    const satirlar = metin.slice(son).trim().split('\n').filter(Boolean).map((s) => s.split(' ').map(Number));
    let i = 0;
    for (const e of elemanlar) {
      sonuc[e.ad] = satirlar.slice(i, i + e.n).map((s) => (e.ozellikler[0].liste ? [s.slice(1, 1 + s[0]), ...s.slice(1 + s[0])] : s));
      i += e.n;
    }
    return sonuc;
  }
  const dv = new DataView(bayt.buffer, bayt.byteOffset + son);
  let o = 0;
  const oku = (tur) => {
    const v = { double: () => dv.getFloat64(o, true), float: () => dv.getFloat32(o, true), int: () => dv.getInt32(o, true), uchar: () => dv.getUint8(o) }[tur]();
    o += { double: 8, float: 4, int: 4, uchar: 1 }[tur];
    return v;
  };
  for (const e of elemanlar) {
    sonuc[e.ad] = Array.from({ length: e.n }, () => {
      const kayit = [];
      for (const p of e.ozellikler) {
        if (p.liste) {
          const n = oku(p.liste[0]);
          kayit.push(Array.from({ length: n }, () => oku(p.liste[1])));
        } else kayit.push(oku(p.tur));
      }
      return kayit;
    });
  }
  expect(son + o).toBe(bayt.length); // fazla/eksik bayt yok
  return sonuc;
}

const alan = (v, [a, b, c]) => ((v[b][0] - v[a][0]) * (v[c][1] - v[a][1]) - (v[c][0] - v[a][0]) * (v[b][1] - v[a][1])) / 2;

describe('plyYaz', () => {
  it.each([['ikili', {}], ['ascii', { ascii: true }]])('%s: gidiş-dönüş', async (_ad, secenek) => {
    const { veri, uyarilar } = await plyYaz(ornekFc(), secenek);
    const c = plyCoz(veri);
    expect(c.format).toBe(secenek.ascii ? 'ascii' : 'binary_little_endian');
    expect(c.baslik).toContain('property double x');
    expect(c.baslik).toContain('property list uchar int vertex_indices');
    expect(c.baslik).toContain('property int obje');
    expect(c.yorumlar).toContain(`merkez ${X0 + 15.5} ${Y0 + 15} 100`);
    expect(c.yorumlar).toContain('obje 0 Caglayan_Sisli');
    expect(c.yorumlar).toContain('obje 1 Obje_2');
    expect(c.vertex).toHaveLength(8 + 4 + 4 + 3 + 1);
    expect(c.face).toHaveLength(12);
    expect(c.face.map((f) => f[1])).toEqual([...Array(8).fill(0), 1, 1, 1, 1]);
    expect(c.face.slice(0, 8).reduce((s, f) => s + alan(c.vertex, f[0]), 0)).toBeCloseTo(96, 9);
    expect(c.edge).toEqual([[16, 17, 1], [17, 18, 1]]);
    const mutlak = c.vertex.map((v) => [v[0] + X0 + 15.5, v[1] + Y0 + 15, v[2] + 100]);
    expect(mutlak[0]).toEqual([X0, Y0, 100]);
    expect(mutlak[19]).toEqual([X0 + 1, Y0 + 30, 105]);
    expect(uyarilar.join(' ')).toMatch(/1 obje geometrisiz/);
  });

  it('çizgi yoksa edge elemanı yazılmaz', async () => {
    const { veri } = await plyYaz({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: DELIKLI }] });
    const c = plyCoz(veri);
    expect(c.edge).toBeUndefined();
    expect(c.face).toHaveLength(8);
  });

  it('boş FC: 0 köşe, uyarı', async () => {
    const { veri, uyarilar } = await plyYaz({ type: 'FeatureCollection', features: [] });
    const c = plyCoz(veri);
    expect(c.vertex).toEqual([]);
    expect(c.face).toEqual([]);
    expect(uyarilar.join(' ')).toMatch(/boş/);
  });
});
