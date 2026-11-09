import { describe, it, expect } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { colladaYaz, asciiAd, adUretici, objeAdi, merkeziBol } from './collada.js';
import { agOlustur } from './ortak/ag.js';

const SALDIRI = '</script><script>alert(1)</script> & "x" <y>';
const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (properties, geometry) => ({ type: 'Feature', properties, geometry });
const kare = (x, y, s, z = 0) => [[x, y, z], [x + s, y, z], [x + s, y + s, z], [x, y + s, z], [x, y, z]];
const ornekFc = () =>
  fc([
    obje({ ad: 'Çığır Şöför', not: SALDIRI }, { type: 'Polygon', coordinates: [kare(500000, 4400000, 10, 5), kare(500003, 4400003, 2, 5).reverse()] }),
    obje({ ad: 'Çığır Şöför' }, { type: 'MultiPolygon', coordinates: [[kare(500020, 4400000, 5)], [kare(500030, 4400000, 5)]] }),
    obje({ ad: 'Yol', katman: 'Ulaşım' }, { type: 'MultiLineString', coordinates: [[[500000, 4400020], [500010, 4400020], [500010, 4400030]], [[500000, 4400040], [500005, 4400045]]] }),
    obje({ ad: 'Nirengi', kod: 7 }, { type: 'MultiPoint', coordinates: [[500001, 4400001, 12.5], [500002, 4400002]] }),
    obje({}, { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [500040, 4400040] }, { type: 'LineString', coordinates: [[500040, 4400040], [500041, 4400041]] }] }),
    obje({ ad: 'Boş' }, null),
  ]);

/** Kesirli, büyük projeksiyonlu koordinatlar: merkez float32'de kayıplı olurdu. */
const kesirliFc = () =>
  fc([
    obje({ ad: 'K' }, { type: 'Polygon', coordinates: [[[512345.678, 4412345.987, 1012.345], [512355.123, 4412345.987, 1012.345], [512355.123, 4412356.456, 1012.345], [512345.678, 4412345.987, 1012.345]]] }),
  ]);
/** Kaba + ince parçaları ayrı ayrı float32'ye indirip toplar; gerçek merkeze 1 mm içinde olmalı. */
const float32Toplam = (kaba, ince) => kaba.map((k, i) => Math.fround(k) + Math.fround(ince[i]));

function ayristir(xml) {
  const hatalar = [];
  const doc = new DOMParser({ onError: (duzey, mesaj) => hatalar.push(`${duzey}: ${mesaj}`) }).parseFromString(xml, 'text/xml');
  expect(hatalar).toEqual([]);
  return doc;
}
const elemanlar = (kok, ad) => Array.from(kok.getElementsByTagName(ad));
const sayilar = (metin) => metin.trim().split(/\s+/).filter(Boolean).map(Number);

describe('ortak yardımcılar', () => {
  it('asciiAd: Türkçe → ASCII, geçersiz karakter temizliği, rakamla başlamaz', () => {
    expect(asciiAd('Çığır Şöför Ünlü İğne')).toBe('Cigir_Sofor_Unlu_Igne');
    expect(asciiAd('Ağaç/ç-2 (eski)')).toBe('Agac_c_2_eski');
    expect(asciiAd('123 ada')).toBe('_123_ada');
    expect(asciiAd('  ###  ')).toBe('Obje');
    expect(asciiAd('Crème brûlée')).toBe('Creme_brulee');
  });
  it('adUretici: benzersiz ve ayrılmış adlardan kaçınır', () => {
    const ad = adUretici(['Kok']);
    expect([ad('kok'), ad('Ağaç'), ad('Agac'), ad('agac')]).toEqual(['kok_2', 'Agac', 'Agac_2', 'agac_3']);
  });
  it('objeAdi', () => {
    expect(objeAdi({ name: 'A' }, 0)).toBe('A');
    expect(objeAdi({}, 4)).toBe('Obje 5');
  });
  it('merkeziBol: kaba float32de tam, kaba + ince = merkez, float32 toplamı 1 mm içinde', () => {
    const ornekler = [
      [500020.5, 4400022.5, 0],
      [512350.4005, 4412351.2215, 1012.345],
      [-123456.789, -9876543.21, -0.001],
      [16777215.7, 16777216.3, 33554433.9],
      [123456789.123, -98765432.1, 0.5],
    ];
    for (const m of ornekler) {
      const { kaba, ince } = merkeziBol(m);
      expect(kaba.map((v, i) => v + ince[i])).toEqual(m);
      for (const k of kaba) expect(Math.fround(k)).toBe(k);
      float32Toplam(kaba, ince).forEach((v, i) => expect(Math.abs(v - m[i])).toBeLessThan(1e-3));
    }
    // Karşılaştırma: tek float32 değer kadastro için yetersiz (4,4 milyon m'de adım 0,5 m).
    expect(Math.abs(Math.fround(4412351.2215) - 4412351.2215)).toBeGreaterThan(0.2);
    expect(merkeziBol([0.4, -0.6, 0])).toEqual({ kaba: [0, -1, 0], ince: [0.4, 0.4, 0] });
  });
});

describe('colladaYaz', () => {
  it('kesirli büyük merkez: kök iki translate, float32 toplamı 1 mm içinde', async () => {
    const girdi = kesirliFc();
    const { merkez } = agOlustur(girdi);
    expect(merkez[0] % 1).not.toBe(0);
    const doc = ayristir((await colladaYaz(girdi)).veri);
    const kok = elemanlar(doc, 'node').find((n) => n.getAttribute('id') === 'Kok');
    const tr = elemanlar(kok, 'translate').filter((t) => t.parentNode === kok);
    expect(tr.map((t) => t.getAttribute('sid'))).toEqual(['translate', 'translate_ince']);
    const [kaba, ince] = tr.map((t) => sayilar(t.textContent));
    for (const k of kaba) expect(Number.isInteger(k)).toBe(true);
    float32Toplam(kaba, ince).forEach((v, i) => expect(Math.abs(v - merkez[i])).toBeLessThan(1e-3));
  });

  it('COLLADA 1.4.1 yapısı: asset Z_UP/metre, kökte merkez, obje başına node', async () => {
    const girdi = ornekFc();
    const { veri, onizleme, uyarilar } = await colladaYaz(girdi, { crs: 'EPSG:5255' });
    expect(onizleme).toBe(veri);
    const doc = ayristir(veri);
    const kok = doc.documentElement;
    expect(kok.tagName).toBe('COLLADA');
    expect(kok.getAttribute('version')).toBe('1.4.1');
    expect(kok.getAttribute('xmlns')).toBe('http://www.collada.org/2005/11/COLLADASchema');
    expect(elemanlar(doc, 'up_axis')[0].textContent).toBe('Z_UP');
    expect(elemanlar(doc, 'unit')[0].getAttribute('meter')).toBe('1');
    expect(elemanlar(doc, 'comments')[0].textContent).toContain('EPSG:5255');

    const { merkez } = agOlustur(girdi);
    const kokDugum = elemanlar(doc, 'node').find((n) => n.getAttribute('id') === 'Kok');
    const [kaba, ince] = elemanlar(kokDugum, 'translate').filter((t) => t.parentNode === kokDugum).map((t) => sayilar(t.textContent));
    expect(kaba.map((v, i) => v + ince[i])).toEqual(merkez);
    expect(merkez[0]).toBeGreaterThan(400000);

    const objeDugumleri = elemanlar(kokDugum, 'node').filter((n) => n.parentNode === kokDugum);
    expect(objeDugumleri.map((n) => n.getAttribute('id'))).toEqual(['Cigir_Sofor', 'Cigir_Sofor_2', 'Yol', 'Nirengi', 'Obje_5']);
    expect(objeDugumleri[0].getAttribute('name')).toBe('Çığır Şöför');
    expect(uyarilar.some((u) => /1 obje geometrisiz/.test(u))).toBe(true);
    expect(uyarilar.some((u) => /3 nokta boş düğüm/.test(u))).toBe(true);

    // Tüm id'ler benzersiz, tüm #referanslar çözülüyor.
    const idler = elemanlar(doc, '*').map((e) => e.getAttribute('id')).filter(Boolean);
    expect(new Set(idler).size).toBe(idler.length);
    const referanslar = [...veri.matchAll(/(?:url|source|target)="#([^"]+)"/g)].map((m) => m[1]);
    for (const r of referanslar) expect(idler).toContain(r);
  });

  it('delikli poligon: üçgenler, float_array sayıları ve indeks aralığı tutarlı; alan delik hariç', async () => {
    const { veri } = await colladaYaz(ornekFc());
    const doc = ayristir(veri);
    const geo = elemanlar(doc, 'geometry').find((g) => g.getAttribute('id') === 'Cigir_Sofor-geo');
    const dizi = elemanlar(geo, 'float_array')[0];
    const konum = sayilar(dizi.textContent);
    expect(Number(dizi.getAttribute('count'))).toBe(konum.length);
    expect(konum.length).toBe(8 * 3);
    const ucgen = elemanlar(geo, 'triangles')[0];
    const p = sayilar(elemanlar(ucgen, 'p')[0].textContent);
    expect(Number(ucgen.getAttribute('count'))).toBe(p.length / 3);
    expect(Math.max(...p)).toBeLessThan(8);
    let alan = 0;
    for (let i = 0; i < p.length; i += 3) {
      const [a, b, c] = [p[i], p[i + 1], p[i + 2]].map((j) => konum.slice(j * 3, j * 3 + 3));
      const iki = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      expect(iki).toBeGreaterThan(0); // CCW, normal +Z
      alan += iki / 2;
    }
    expect(alan).toBeCloseTo(96, 9);
    // Z korunur (merkez z = en düşük Z = 0 → 5).
    expect(konum[2]).toBe(5);
  });

  it('çok parçalı objeler: MultiPolygon tek ağ, MultiLineString linestrips, GeometryCollection karışık', async () => {
    const { veri } = await colladaYaz(ornekFc());
    const doc = ayristir(veri);
    const geo = (id) => elemanlar(doc, 'geometry').find((g) => g.getAttribute('id') === `${id}-geo`);
    expect(Number(elemanlar(geo('Cigir_Sofor_2'), 'triangles')[0].getAttribute('count'))).toBe(4);
    const ls = elemanlar(geo('Yol'), 'linestrips')[0];
    expect(ls.getAttribute('count')).toBe('2');
    expect(elemanlar(ls, 'p').map((p) => p.textContent)).toEqual(['0 1 2', '3 4']);
    const gc = elemanlar(doc, 'node').find((n) => n.getAttribute('id') === 'Obje_5');
    expect(elemanlar(gc, 'instance_geometry')).toHaveLength(1);
    expect(elemanlar(gc, 'node')).toHaveLength(1); // nokta
    const nirengi = elemanlar(doc, 'node').find((n) => n.getAttribute('id') === 'Nirengi');
    expect(elemanlar(nirengi, 'node')).toHaveLength(2);
    expect(elemanlar(nirengi, 'instance_geometry')).toHaveLength(0);
    // Malzemeler aileye göre bağlanır.
    expect(elemanlar(geo('Yol'), 'linestrips')[0].getAttribute('material')).toBe('cizgi');
    expect(elemanlar(doc, 'effect')).toHaveLength(3);
  });

  it('öznitelikler <extra> içinde; saldırı dizeleri kaçışlı ve aynen geri okunur', async () => {
    const { veri } = await colladaYaz(ornekFc());
    expect(veri).not.toContain('<script>');
    const doc = ayristir(veri);
    const dugum = elemanlar(doc, 'node').find((n) => n.getAttribute('id') === 'Cigir_Sofor');
    const ozellikler = Object.fromEntries(elemanlar(dugum, 'ozellik').map((e) => [e.getAttribute('ad'), e.textContent]));
    expect(ozellikler).toEqual({ ad: 'Çığır Şöför', not: SALDIRI });
    const nirengi = elemanlar(doc, 'node').find((n) => n.getAttribute('id') === 'Nirengi');
    expect(elemanlar(nirengi, 'ozellik').find((e) => e.getAttribute('ad') === 'kod').textContent).toBe('7');
  });

  it('boş FC ve yalnızca null geometri: geçerli belge + uyarı', async () => {
    for (const g of [fc([]), fc([obje({ ad: 'x' }, null)])]) {
      const { veri, uyarilar } = await colladaYaz(g);
      const doc = ayristir(veri);
      expect(elemanlar(doc, 'library_geometries')).toHaveLength(0);
      expect(elemanlar(doc, 'visual_scene')).toHaveLength(1);
      expect(uyarilar.some((u) => /geometri bulunamadı/.test(u))).toBe(true);
    }
    await expect(colladaYaz(null)).rejects.toThrow(/FeatureCollection/);
  });
});
