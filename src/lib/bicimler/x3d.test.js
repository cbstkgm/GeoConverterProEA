import { describe, it, expect } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { x3dYaz, mfString } from './x3d.js';
import { agOlustur } from './ortak/ag.js';

const SALDIRI = '</script><script>alert(1)</script> & "x" \\ <y>';
const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (properties, geometry) => ({ type: 'Feature', properties, geometry });
const kare = (x, y, s, z = 0) => [[x, y, z], [x + s, y, z], [x + s, y + s, z], [x, y + s, z], [x, y, z]];
const ornekFc = () =>
  fc([
    obje({ ad: 'Çığır Şöför', not: SALDIRI }, { type: 'Polygon', coordinates: [kare(500000, 4400000, 10, 5), kare(500003, 4400003, 2, 5).reverse()] }),
    obje({ ad: 'Çığır Şöför' }, { type: 'MultiPolygon', coordinates: [[kare(500020, 4400000, 5)], [kare(500030, 4400000, 5)]] }),
    obje({ ad: 'Yol' }, { type: 'MultiLineString', coordinates: [[[500000, 4400020], [500010, 4400020], [500010, 4400030]], [[500000, 4400040], [500005, 4400045]]] }),
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
  const doc = new DOMParser({ onError: (d, m) => hatalar.push(`${d}: ${m}`) }).parseFromString(xml, 'text/xml');
  expect(hatalar).toEqual([]);
  return doc;
}
const el = (kok, ad) => Array.from(kok.getElementsByTagName(ad));
const sayilar = (m) => m.trim().split(/\s+/).filter(Boolean).map(Number);
/** MFString çözücü ("a" "b\"c"). */
const mfCoz = (m) => [...m.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\(.)/g, '$1'));
const def = (doc, ad) => el(doc, 'Transform').find((t) => t.getAttribute('DEF') === ad);

describe('x3dYaz', () => {
  it('X3D 4.0 Interchange; Z-yukarı dönüşü ve merkez ötelemesi; başlık meta verisi', async () => {
    const girdi = ornekFc();
    const { veri, onizleme, uyarilar } = await x3dYaz(girdi, { crs: 'EPSG:5255' });
    expect(onizleme).toBe(veri);
    expect(veri).toContain('<!DOCTYPE X3D PUBLIC "ISO//Web3D//DTD X3D 4.0//EN"');
    const doc = ayristir(veri);
    const x3d = doc.documentElement;
    expect([x3d.tagName, x3d.getAttribute('profile'), x3d.getAttribute('version')]).toEqual(['X3D', 'Interchange', '4.0']);
    const { merkez } = agOlustur(girdi);
    expect(def(doc, 'ZYukari').getAttribute('rotation')).toBe('1 0 0 -1.5707963267948966');
    const kaba = sayilar(def(doc, 'Merkez').getAttribute('translation'));
    const ince = sayilar(def(doc, 'MerkezInce').getAttribute('translation'));
    expect(kaba.map((v, i) => v + ince[i])).toEqual(merkez);
    expect(def(doc, 'MerkezInce').parentNode).toBe(def(doc, 'Merkez'));
    const meta = Object.fromEntries(el(doc, 'meta').map((m) => [m.getAttribute('name'), m.getAttribute('content')]));
    expect(meta.crs).toBe('EPSG:5255');
    expect(sayilar(meta.merkez)).toEqual(merkez);
    const sahneMeta = el(doc, 'MetadataDouble').find((m) => m.getAttribute('name') === 'merkez');
    expect(sayilar(sahneMeta.getAttribute('value'))).toEqual(merkez);
    expect(uyarilar.some((u) => /geometrisiz/.test(u))).toBe(true);

    const objeler = el(def(doc, 'MerkezInce'), 'Transform').map((t) => t.getAttribute('DEF'));
    expect(objeler).toEqual(['Cigir_Sofor', 'Cigir_Sofor_2', 'Yol', 'Nirengi', 'Obje_5']);
    const tumDef = el(doc, '*').map((e) => e.getAttribute('DEF')).filter(Boolean);
    expect(new Set(tumDef).size).toBe(tumDef.length);
    for (const d of tumDef) expect(d).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('kesirli büyük merkez: Merkez (tam metre) + MerkezInce; float32 toplamı 1 mm içinde; meta veride tam değer', async () => {
    const girdi = kesirliFc();
    const { merkez } = agOlustur(girdi);
    const doc = ayristir((await x3dYaz(girdi)).veri);
    const kaba = sayilar(def(doc, 'Merkez').getAttribute('translation'));
    const ince = sayilar(def(doc, 'MerkezInce').getAttribute('translation'));
    for (const k of kaba) expect(Number.isInteger(k)).toBe(true);
    for (const v of ince) expect(Math.abs(v)).toBeLessThanOrEqual(0.5);
    float32Toplam(kaba, ince).forEach((v, i) => expect(Math.abs(v - merkez[i])).toBeLessThan(1e-3));
    expect(Math.abs(Math.fround(merkez[1]) - merkez[1])).toBeGreaterThan(1e-3); // tek değer yetmezdi
    const md = el(doc, 'MetadataDouble').find((m) => m.getAttribute('name') === 'merkez');
    expect(sayilar(md.getAttribute('value'))).toEqual(merkez);
    expect(def(doc, 'ZYukari').getAttribute('rotation')).toBe('1 0 0 -1.5707963267948966');
  });

  it('dönme matrisi (x, y, z) → (x, z, -y) eşdeğeridir', () => {
    const t = -Math.PI / 2;
    const [x, y, z] = [1, 2, 3];
    expect([x, y * Math.cos(t) - z * Math.sin(t), y * Math.sin(t) + z * Math.cos(t)].map((v) => Math.round(v * 1e12) / 1e12)).toEqual([1, 3, -2]);
  });

  it('delikli poligon IndexedTriangleSet; çizgiler IndexedLineSet (-1 ayraçlı); noktalar PointSet', async () => {
    const doc = ayristir((await x3dYaz(ornekFc())).veri);
    const its = el(def(doc, 'Cigir_Sofor'), 'IndexedTriangleSet')[0];
    const indeks = sayilar(its.getAttribute('index'));
    const nokta = sayilar(el(its, 'Coordinate')[0].getAttribute('point'));
    expect(indeks).toHaveLength(8 * 3);
    expect(nokta).toHaveLength(8 * 3);
    expect(Math.max(...indeks)).toBe(7);
    expect(its.getAttribute('solid')).toBe('false');
    expect(sayilar(el(def(doc, 'Cigir_Sofor_2'), 'IndexedTriangleSet')[0].getAttribute('index'))).toHaveLength(12);

    const ils = el(def(doc, 'Yol'), 'IndexedLineSet')[0];
    expect(ils.getAttribute('coordIndex')).toBe('0 1 2 -1 3 4 -1');
    expect(sayilar(el(ils, 'Coordinate')[0].getAttribute('point'))).toHaveLength(15);

    const ps = el(def(doc, 'Nirengi'), 'PointSet')[0];
    const pn = sayilar(el(ps, 'Coordinate')[0].getAttribute('point'));
    expect(pn).toHaveLength(6);
    expect(pn[2]).toBe(12.5);
    const gc = def(doc, 'Obje_5');
    expect(el(gc, 'Shape')).toHaveLength(2);
  });

  it('öznitelikler MetadataSet/MetadataString; saldırı dizeleri kaçışlı ve geri okunur', async () => {
    const { veri } = await x3dYaz(ornekFc());
    expect(veri).not.toContain('<script>');
    const doc = ayristir(veri);
    const ms = el(def(doc, 'Cigir_Sofor'), 'MetadataString');
    const oz = Object.fromEntries(ms.map((m) => [m.getAttribute('name'), mfCoz(m.getAttribute('value'))[0]]));
    expect(oz).toEqual({ ad: 'Çığır Şöför', not: SALDIRI });
    expect(mfString(['a"b\\c'])).toBe('&quot;a\\&quot;b\\\\c&quot;');
  });

  it('boş FC: geçerli belge, obje yok, uyarı', async () => {
    const { veri, uyarilar } = await x3dYaz(fc([]));
    const doc = ayristir(veri);
    expect(el(doc, 'Shape')).toHaveLength(0);
    expect(def(doc, 'Merkez').getAttribute('translation')).toBe('0 0 0');
    expect(uyarilar).toEqual(['Yazılacak geometri bulunamadı; boş bir sahne üretildi.']);
  });
});
