import { describe, it, expect } from 'vitest';
import { objYaz, asciiAd, benzersizAdUretici, objeAdiHam } from './obj.js';

const X0 = 500000;
const Y0 = 4400000;
const kare = (x, y, b, z = 100) => [[x, y, z], [x + b, y, z], [x + b, y + b, z], [x, y + b, z], [x, y, z]];
const DELIKLI = { type: 'Polygon', coordinates: [kare(X0, Y0, 10), kare(X0 + 2, Y0 + 2, 2).reverse()] };
const ornekFc = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { ad: 'Çağlayan Şişli Parsel #1', katman: 'Yapı Adası', alan: 96 }, geometry: DELIKLI },
    {
      type: 'Feature',
      properties: { no: 2 },
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'MultiPolygon', coordinates: [[kare(X0 + 20, Y0, 1)], [kare(X0 + 30, Y0, 1)]] },
          { type: 'LineString', coordinates: [[X0, Y0 + 20, 100], [X0 + 5, Y0 + 20, 100], [X0 + 5, Y0 + 25, 100]] },
          { type: 'Point', coordinates: [X0 + 1, Y0 + 30, 105] },
        ],
      },
    },
    { type: 'Feature', properties: { ad: 'boş' }, geometry: null },
  ],
});

/** Küçük OBJ çözücü. */
function objCoz(metin) {
  const sonuc = { v: [], f: [], l: [], p: [], o: [], g: [], merkez: null };
  for (const satir of metin.split('\n')) {
    const [k, ...a] = satir.trim().split(/\s+/);
    if (k === 'v') sonuc.v.push(a.map(Number));
    else if (k === 'f') sonuc.f.push(a.map((x) => Number(x.split('/')[0]) - 1));
    else if (k === 'l') sonuc.l.push(a.map((x) => Number(x) - 1));
    else if (k === 'p') sonuc.p.push(Number(a[0]) - 1);
    else if (k === 'o') sonuc.o.push(a.join(' '));
    else if (k === 'g') sonuc.g.push(a.join(' '));
    const m = /^# Merkez ötelemesi: (\S+) (\S+) (\S+)$/.exec(satir);
    if (m) sonuc.merkez = m.slice(1).map(Number);
  }
  return sonuc;
}

const alan2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);

describe('objYaz', () => {
  it('gidiş-dönüş: delikli poligon, çok parçalı obje, çizgi, nokta, merkez', async () => {
    const { veri, uyarilar } = await objYaz(ornekFc());
    const c = objCoz(veri);
    expect(c.merkez).toEqual([X0 + 15.5, Y0 + 15, 100]);
    expect(c.o).toEqual(['Caglayan_Sisli_Parsel_1', 'Obje_2']);
    expect(c.g).toEqual(['Yapi_Adasi']);
    expect(c.f).toHaveLength(8 + 2 + 2);
    // Delikli poligonun üçgenleri (ilk 8): hepsi CCW, toplam alan 96.
    const ilk8 = c.f.slice(0, 8).map((u) => alan2(...u.map((i) => c.v[i])) / 2);
    expect(ilk8.every((a) => a > 0)).toBe(true);
    expect(ilk8.reduce((s, a) => s + a, 0)).toBeCloseTo(96, 9);
    // Mutlak = yerel + merkez
    const mutlak = c.v.map((v) => v.map((x, i) => x + c.merkez[i]));
    expect(mutlak[0]).toEqual([X0, Y0, 100]);
    expect(c.l).toHaveLength(1);
    expect(c.l[0].map((i) => mutlak[i])).toEqual([[X0, Y0 + 20, 100], [X0 + 5, Y0 + 20, 100], [X0 + 5, Y0 + 25, 100]]);
    expect(mutlak[c.p[0]]).toEqual([X0 + 1, Y0 + 30, 105]);
    // Tüm indeksler geçerli (1 tabanlı → 0 tabanlı aralıkta)
    expect([...c.f.flat(), ...c.l.flat(), ...c.p].every((i) => i >= 0 && i < c.v.length)).toBe(true);
    expect(veri).toContain('vn 0 0 1');
    expect(veri).toContain('# ozellik: ad = Çağlayan Şişli Parsel #1');
    expect(uyarilar.join(' ')).toMatch(/1 obje geometrisiz/);
  });

  it('mutlak: true → öteleme yok, gerçek koordinatlar', async () => {
    const { veri } = await objYaz(ornekFc(), { mutlak: true });
    const c = objCoz(veri);
    expect(c.merkez).toBeNull();
    expect(veri).toContain('Koordinatlar mutlaktır');
    expect(c.v[0]).toEqual([X0, Y0, 100]);
  });

  it('sayılar yerel ayarsız ve tam hassasiyetli', async () => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [500000.123456789, 4400000.987654321] } }] };
    const { veri } = await objYaz(fc, { mutlak: true });
    expect(veri).toContain('v 500000.123456789 4400000.987654321 0');
  });

  it('boş FC ve yalnızca null geometri', async () => {
    for (const fc of [{ type: 'FeatureCollection', features: [] }, { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null }] }]) {
      const { veri, uyarilar } = await objYaz(fc);
      expect(objCoz(veri).v).toHaveLength(0);
      expect(uyarilar.join(' ')).toMatch(/Yazılacak 3B geometri yok/);
    }
  });

  it('geçersiz FC hata verir', async () => {
    await expect(objYaz({ type: 'Feature' })).rejects.toThrow(/FeatureCollection/);
  });
});

describe('ortak ad yardımcıları', () => {
  it.each([
    ['Çağlayan Şişli Parsel #1', 'Caglayan_Sisli_Parsel_1'],
    ['İĞNEADA ÖZÜ', 'IGNEADA_OZU'],
    ['  café / déjà-vu  ', 'cafe_deja-vu'],
    ['a\nb\tc', 'a_b_c'],
    ['☃☃', ''],
  ])('asciiAd(%j) → %j', (girdi, beklenen) => {
    expect(asciiAd(girdi)).toBe(beklenen);
  });

  it('asciiAd kırpma, benzersiz ad, obje adı', () => {
    expect(asciiAd('Kadıköy Merkez', 10)).toBe('Kadikoy_Me');
    const b = benzersizAdUretici(10);
    expect([b('Kadikoy_Me'), b('kadikoy_me'), b('Kadikoy_Me')]).toEqual(['Kadikoy_Me', 'kadikoy__2', 'Kadikoy__3']);
    expect(objeAdiHam({ name: ' A ' }, 0)).toBe('A');
    expect(objeAdiHam({ ad: '' }, 4)).toBe('Obje 5');
  });
});
