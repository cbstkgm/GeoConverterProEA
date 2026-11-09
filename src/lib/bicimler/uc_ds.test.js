import { describe, it, expect } from 'vitest';
import { ucDsYaz, agiBol } from './uc_ds.js';

const X0 = 500000;
const Y0 = 4400000;
const kare = (x, y, b, z = 100) => [[x, y, z], [x + b, y, z], [x + b, y + b, z], [x, y + b, z], [x, y, z]];
const DELIKLI = { type: 'Polygon', coordinates: [kare(X0, Y0, 10), kare(X0 + 2, Y0 + 2, 2).reverse()] };
const ornekFc = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { ad: 'Çağlayan Şişli Parsel' }, geometry: DELIKLI },
    {
      type: 'Feature',
      properties: { ad: 'Çağlayan Şişli Yol' },
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
const MERKEZ = [X0 + 15.5, Y0 + 15, 100];

/** Küçük 3DS chunk çözücü: tüm uzunlukları doğrular, nesneleri döndürür. */
function ucDsCoz(bayt) {
  const dv = new DataView(bayt.buffer, bayt.byteOffset, bayt.byteLength);
  const nesneler = [];
  const surumler = {};
  function gez(bas, son, ebeveyn) {
    let o = bas;
    while (o < son) {
      const kimlik = dv.getUint16(o, true);
      const uz = dv.getUint32(o + 2, true);
      expect(uz).toBeGreaterThanOrEqual(6);
      expect(o + uz).toBeLessThanOrEqual(son);
      const g = o + 6;
      if (kimlik === 0x4d4d || kimlik === 0x3d3d || kimlik === 0x4100) gez(g, o + uz, ebeveyn);
      else if (kimlik === 0x0002 || kimlik === 0x3d3e) surumler[kimlik] = dv.getUint32(g, true);
      else if (kimlik === 0x4000) {
        let s = g;
        let ad = '';
        while (bayt[s] !== 0) ad += String.fromCharCode(bayt[s++]);
        const n = { ad, koseler: [], yuzler: [], bayraklar: new Set() };
        nesneler.push(n);
        gez(s + 1, o + uz, n);
      } else if (kimlik === 0x4110) {
        const n = dv.getUint16(g, true);
        expect(uz).toBe(6 + 2 + n * 12);
        for (let i = 0; i < n; i++) ebeveyn.koseler.push([0, 1, 2].map((e) => dv.getFloat32(g + 2 + i * 12 + e * 4, true)));
      } else if (kimlik === 0x4120) {
        const n = dv.getUint16(g, true);
        expect(uz).toBe(6 + 2 + n * 8);
        for (let i = 0; i < n; i++) {
          ebeveyn.yuzler.push([0, 1, 2].map((e) => dv.getUint16(g + 2 + i * 8 + e * 2, true)));
          ebeveyn.bayraklar.add(dv.getUint16(g + 2 + i * 8 + 6, true));
        }
      }
      o += uz;
    }
    expect(o).toBe(son);
  }
  expect(dv.getUint16(0, true)).toBe(0x4d4d);
  expect(dv.getUint32(2, true)).toBe(bayt.length);
  gez(0, bayt.length, null);
  return { nesneler, surumler };
}

const alan = ([a, b, c]) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

describe('ucDsYaz', () => {
  it('chunk yapısı, benzersiz 10 karakterlik ASCII adlar, gidiş-dönüş', async () => {
    const { veri, uyarilar } = await ucDsYaz(ornekFc());
    expect(veri).toBeInstanceOf(Uint8Array);
    const { nesneler, surumler } = ucDsCoz(veri);
    expect(surumler).toEqual({ 2: 3, 0x3d3e: 3 });
    expect(nesneler.map((n) => n.ad)).toEqual(['Caglayan_S', 'Caglayan_2']);
    const [parsel, yol] = nesneler;
    expect(parsel.yuzler).toHaveLength(8);
    expect(parsel.koseler).toHaveLength(8);
    expect(parsel.bayraklar).toEqual(new Set([7]));
    const ucgenler = parsel.yuzler.map((y) => y.map((i) => parsel.koseler[i]));
    expect(ucgenler.every((u) => alan(u) > 0)).toBe(true);
    expect(ucgenler.reduce((s, u) => s + alan(u), 0)).toBeCloseTo(96, 5);
    const mutlak = parsel.koseler.map((k) => k.map((v, i) => v + MERKEZ[i]));
    expect(mutlak).toContainEqual([X0, Y0, 100]);
    expect(yol.yuzler).toHaveLength(4);
    const metin = uyarilar.join(' ');
    expect(metin).toMatch(/1 çizgi ve 1 nokta parçası atlandı/);
    expect(metin).toMatch(new RegExp(`merkez ötelemesi uygulandı: mutlak = dosyadaki \\+ \\(${MERKEZ.join(' ')}\\)`));
    expect(metin).toMatch(/1 obje geometrisiz/);
  });

  it('65535 köşe sınırını aşan obje bölünür ve uyarılır', async () => {
    const parcalar = Array.from({ length: 16500 }, (_, i) => [kare((i % 200) * 2, Math.floor(i / 200) * 2, 1, 0)]); // 66000 köşe, 33000 yüz
    const { veri, uyarilar } = await ucDsYaz({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { ad: 'Büyük' }, geometry: { type: 'MultiPolygon', coordinates: parcalar } }] });
    const { nesneler } = ucDsCoz(veri);
    expect(nesneler.map((n) => n.ad)).toEqual(['Buyuk', 'Buyuk_2']);
    expect(nesneler.every((n) => n.koseler.length <= 65535 && n.yuzler.length <= 65535)).toBe(true);
    expect(nesneler.reduce((s, n) => s + n.yuzler.length, 0)).toBe(33000);
    // Bölme bir karenin iki üçgeni arasına düşer: ortak kenarın 2 köşesi ikinci nesnede yinelenir.
    expect(nesneler[0].koseler).toHaveLength(65535);
    expect(nesneler.reduce((s, n) => s + n.koseler.length, 0)).toBe(66002);
    expect(nesneler.every((n) => n.yuzler.flat().every((i) => i < n.koseler.length))).toBe(true);
    expect(uyarilar.join(' ')).toMatch(/"Büyük" 3DS'in 65535 köşe\/yüz sınırını aştığı için 2 nesneye bölündü/);
  });

  it('agiBol: köşe ve yüz sınırı, paylaşılan köşeler korunur', () => {
    // 4 köşe, 2 yüz (ortak kenar) — sınır 3: her yüz ayrı alt ağa, köşeler kopyalanır
    const p = { konumlar: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], indeksler: [0, 1, 2, 0, 2, 3] };
    const altlar = agiBol([p], 3);
    expect(altlar).toHaveLength(2);
    expect(altlar.map((a) => a.yuzler)).toEqual([[0, 1, 2], [0, 1, 2]]);
    expect(altlar[1].konumlar).toEqual([0, 0, 0, 1, 1, 0, 0, 1, 0]);
    // Sınır yeterliyse tek alt ağ, köşeler paylaşılır
    expect(agiBol([p], 10)).toEqual([{ konumlar: p.konumlar, yuzler: p.indeksler }]);
    // Yüz sınırı: 4 köşe sınırında 1 yüz/alt ağ olacak şekilde yüz sınırı da işler
    expect(agiBol([p], 4).length).toBe(1);
  });

  it('boş FC ve yalnızca çizgi: boş sahne + uyarı', async () => {
    for (const fc of [
      { type: 'FeatureCollection', features: [] },
      { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }] },
    ]) {
      const { veri, uyarilar } = await ucDsYaz(fc);
      expect(ucDsCoz(veri).nesneler).toEqual([]);
      expect(uyarilar.join(' ')).toMatch(/boş sahne/);
    }
  });
});
