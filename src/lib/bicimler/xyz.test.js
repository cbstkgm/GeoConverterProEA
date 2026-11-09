import { describe, it, expect } from 'vitest';
import { xyzYaz, sayiMetni } from './xyz.js';

const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });

describe('xyzYaz', () => {
  it('tüm geometri tiplerinin köşelerini yazar, halka kapanışını ve ardışık tekrarı atar', async () => {
    const { veri, uyarilar } = await xyzYaz(
      fc([
        obje({ type: 'Point', coordinates: [500000.123456789, 4400000.5, 850.25] }),
        obje({ type: 'MultiPoint', coordinates: [[1, 2, 3], [4, 5, 6]] }),
        obje({ type: 'LineString', coordinates: [[10, 10, 1], [10, 10, 1], [11, 11, 1]] }),
        obje({ type: 'MultiLineString', coordinates: [[[20, 20, 0], [21, 21, 0]]] }),
        obje({
          type: 'Polygon',
          coordinates: [
            [[0, 0, 5], [4, 0, 5], [4, 4, 5], [0, 0, 5]],
            [[1, 1, 5], [2, 1, 5], [2, 2, 5], [1, 1, 5]],
          ],
        }),
        obje({ type: 'MultiPolygon', coordinates: [[[[30, 30, 1], [31, 30, 1], [31, 31, 1], [30, 30, 1]]]] }),
        obje({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [7, 8, 9] }] }),
        obje(null, { ad: 'Boş' }),
      ]),
    );
    const satirlar = veri.trimEnd().split('\n');
    expect(satirlar[0]).toBe('500000.123456789 4400000.5 850.25');
    expect(satirlar).toEqual([
      '500000.123456789 4400000.5 850.25',
      '1 2 3',
      '4 5 6',
      '10 10 1',
      '11 11 1',
      '20 20 0',
      '21 21 0',
      '0 0 5',
      '4 0 5',
      '4 4 5',
      '1 1 5',
      '2 1 5',
      '2 2 5',
      '30 30 1',
      '31 30 1',
      '31 31 1',
      '7 8 9',
    ]);
    expect(veri.endsWith('\n')).toBe(true);
    expect(uyarilar).toEqual([]);
  });

  it('yinelenenleriAt: false iken kapanış ve tekrarlar korunur', async () => {
    const { veri } = await xyzYaz(
      fc([
        obje({ type: 'LineString', coordinates: [[1, 1], [1, 1]] }),
        obje({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }),
      ]),
      { yinelenenleriAt: false },
    );
    expect(veri.trimEnd().split('\n')).toHaveLength(6);
  });

  it('Z yoksa 0 yazar ve yalnızca bir kez uyarır', async () => {
    const { veri, uyarilar } = await xyzYaz(
      fc([obje({ type: 'LineString', coordinates: [[1, 2], [3, 4], [5, 6, 7]] })]),
    );
    expect(veri).toBe('1 2 0\n3 4 0\n5 6 7\n');
    expect(uyarilar).toHaveLength(1);
    expect(uyarilar[0]).toMatch(/2 noktada Z/);
  });

  it('virgül ve sekme ayracı; geçersiz ayraç hata verir', async () => {
    const g = fc([obje({ type: 'Point', coordinates: [1.5, -2.25, 3] })]);
    expect((await xyzYaz(g, { ayrac: ',' })).veri).toBe('1.5,-2.25,3\n');
    expect((await xyzYaz(g, { ayrac: '\t' })).veri).toBe('1.5\t-2.25\t3\n');
    await expect(xyzYaz(g, { ayrac: ';' })).rejects.toThrow(/ayracı/);
  });

  it('üstel gösterim kullanmaz, tam hassasiyeti korur', () => {
    expect(sayiMetni(1e-7)).toBe('0.0000001');
    expect(sayiMetni(-1.5e-10)).toBe('-0.00000000015');
    expect(sayiMetni(1e21)).toBe('1000000000000000000000');
    expect(sayiMetni(1.234e22)).toBe('12340000000000000000000');
    expect(sayiMetni(-0)).toBe('0');
    expect(sayiMetni(0.1 + 0.2)).toBe('0.30000000000000004');
  });

  it('öznitelikler (Türkçe, saldırı dizeleri) çıktıya sızmaz', async () => {
    const { veri } = await xyzYaz(
      fc([obje({ type: 'Point', coordinates: [1, 2, 3] }, { ad: 'Çığ</script><script>alert(1)</script>|\n' })]),
    );
    expect(veri).toBe('1 2 3\n');
  });

  it('boş FC ve yalnızca null geometri: boş çıktı + uyarı', async () => {
    for (const g of [fc([]), fc([obje(null)])]) {
      const { veri, onizleme, uyarilar } = await xyzYaz(g);
      expect(veri).toBe('');
      expect(onizleme).toBe('');
      expect(uyarilar[0]).toMatch(/nokta bulunamadı/);
    }
  });

  it('geçersiz girdi ve tip hata verir', async () => {
    await expect(xyzYaz(null)).rejects.toThrow(/FeatureCollection/);
    await expect(xyzYaz(fc([obje({ type: 'Daire', coordinates: [0, 0] })]))).rejects.toThrow(/Desteklenmeyen/);
  });

  it('büyük veride önizleme ilk 1000 satır + kalan sayısı', async () => {
    const koordinatlar = Array.from({ length: 2500 }, (_, i) => [i, i * 2, 1]);
    const { veri, onizleme } = await xyzYaz(fc([obje({ type: 'MultiPoint', coordinates: koordinatlar })]));
    expect(veri.trimEnd().split('\n')).toHaveLength(2500);
    const os = onizleme.split('\n');
    expect(os).toHaveLength(1001);
    expect(os[999]).toBe('999 1998 1');
    expect(os[1000]).toBe('… 1500 satır daha');
  });
});
