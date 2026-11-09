import { describe, it, expect, beforeAll } from 'vitest';
import rhino3dm from 'rhino3dm/rhino3dm.module.js';
import { rhinoYaz } from './rhino.js';
import { agOlustur } from './ortak/ag.js';

const SALDIRI = '</script><script>alert(1)</script> & "x" \\ ; { }\nyeni';
const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (properties, geometry) => ({ type: 'Feature', properties, geometry });
const kare = (x, y, s, z = 0) => [[x, y, z], [x + s, y, z], [x + s, y + s, z], [x, y + s, z], [x, y, z]];
const ornekFc = () =>
  fc([
    obje({ ad: 'Çığır Şöför', not: SALDIRI, katman: 'Binalar' }, { type: 'Polygon', coordinates: [kare(500000, 4400000, 10, 5), kare(500003, 4400003, 2, 5).reverse()] }),
    obje({ ad: 'Çığır Şöför', layer: 'Binalar' }, { type: 'MultiPolygon', coordinates: [[kare(500020, 4400000, 5)], [kare(500030, 4400000, 5)]] }),
    obje({ ad: 'Yol', katman: 'Ulaşım::Ana' }, { type: 'MultiLineString', coordinates: [[[500000, 4400020], [500010, 4400020], [500010, 4400030]], [[500000, 4400040], [500005, 4400045]]] }),
    obje({ ad: 'Nirengi', kod: 7 }, { type: 'MultiPoint', coordinates: [[500001, 4400001, 12.5], [500002, 4400002]] }),
    obje({}, { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [500040, 4400040] }, { type: 'LineString', coordinates: [[500040, 4400040], [500041, 4400041]] }] }),
    obje({ ad: 'Boş' }, null),
  ]);

let rh;
beforeAll(async () => {
  rh = await rhino3dm();
}, 60000);

function oku(bayt) {
  const d = rh.File3dm.fromByteArray(bayt);
  expect(d).toBeTruthy();
  const objeler = [];
  for (let i = 0; i < d.objects().count; i++) {
    const o = d.objects().get(i);
    const a = o.attributes();
    const g = o.geometry();
    objeler.push({ tip: g.constructor.name, ad: a.name, katman: d.layers().get(a.layerIndex).name, kullanici: a.getUserStrings(), g });
  }
  const katmanlar = [];
  for (let i = 0; i < d.layers().count; i++) katmanlar.push(d.layers().get(i).name);
  return { d, objeler, katmanlar };
}

describe('rhinoYaz', () => {
  it('gidiş-dönüş: birim metre, merkez, katmanlar, nesne tipleri ve adları', async () => {
    const girdi = ornekFc();
    const { veri, onizleme, uyarilar } = await rhinoYaz(girdi, { crs: 'EPSG:5255' });
    expect(veri).toBeInstanceOf(Uint8Array);
    expect(onizleme).toContain('Mesh: 2 · Polyline eğri: 3 · Nokta: 3');
    expect(uyarilar.some((u) => /geometrisiz/.test(u))).toBe(true);
    const { d, objeler, katmanlar } = oku(veri);
    expect(d.settings().modelUnitSystem.value).toBe(rh.UnitSystem.Meters.value);
    const { merkez } = agOlustur(girdi);
    expect(d.settings().modelBasePoint).toEqual(merkez);
    const dizeler = {};
    for (let i = 0; i < d.strings().count; i++) {
      const [k, v] = d.strings().get(i);
      dizeler[k] = v;
    }
    expect(dizeler['GeoConverterProEA/merkez']).toBe(merkez.join(' '));
    expect(dizeler['GeoConverterProEA/crs']).toBe('EPSG:5255');

    expect(katmanlar).toEqual(['GeoConverterProEA', 'Binalar', 'Ulaşım:Ana']);
    expect(objeler.map((o) => [o.tip, o.ad, o.katman])).toEqual([
      ['Mesh', 'Çığır Şöför', 'Binalar'],
      ['Mesh', 'Çığır Şöför', 'Binalar'],
      ['PolylineCurve', 'Yol', 'Ulaşım:Ana'],
      ['PolylineCurve', 'Yol', 'Ulaşım:Ana'],
      ['Point', 'Nirengi', 'GeoConverterProEA'],
      ['Point', 'Nirengi', 'GeoConverterProEA'],
      ['PolylineCurve', 'Obje 5', 'GeoConverterProEA'],
      ['Point', 'Obje 5', 'GeoConverterProEA'],
    ]);
  });

  it('delikli poligon mesh, polyline ve nokta koordinatları (merkeze göre)', async () => {
    const girdi = ornekFc();
    const { merkez } = agOlustur(girdi);
    const { objeler } = oku((await rhinoYaz(girdi)).veri);
    const mesh = objeler[0].g;
    expect(mesh.vertices().count).toBe(8);
    expect(mesh.faces().count).toBe(8);
    const kose = mesh.vertices().get(0);
    expect(kose[0] + merkez[0]).toBeCloseTo(500000, 6);
    expect(kose[2]).toBeCloseTo(5, 6);
    expect(objeler[1].g.faces().count).toBe(4);
    const egri = objeler[2].g;
    expect(egri.pointCount).toBe(3);
    expect(egri.point(2)).toEqual([500010 - merkez[0], 4400030 - merkez[1], 0 - merkez[2]]);
    const nokta = objeler[4].g;
    expect(nokta.location).toEqual([500001 - merkez[0], 4400001 - merkez[1], 12.5 - merkez[2]]);
  });

  it('merkezle: false → mutlak koordinat (double)', async () => {
    const { veri } = await rhinoYaz(ornekFc(), { merkezle: false });
    const { d, objeler } = oku(veri);
    expect(d.settings().modelBasePoint).toEqual([0, 0, 0]);
    expect(objeler[4].g.location).toEqual([500001, 4400001, 12.5]);
  });

  it('öznitelikler UserString olarak; Türkçe ve saldırı dizeleri aynen', async () => {
    const { objeler } = oku((await rhinoYaz(ornekFc())).veri);
    const us = Object.fromEntries(objeler[0].kullanici);
    expect(us).toEqual({ ad: 'Çığır Şöför', not: SALDIRI, katman: 'Binalar' });
    expect(Object.fromEntries(objeler[4].kullanici).kod).toBe('7');
  });

  it('boş FC ve null geometri: geçerli boş 3DM', async () => {
    for (const g of [fc([]), fc([obje({ ad: 'x' }, null)])]) {
      const { veri, uyarilar } = await rhinoYaz(g);
      const { objeler, katmanlar } = oku(veri);
      expect(objeler).toHaveLength(0);
      expect(katmanlar).toEqual(['GeoConverterProEA']);
      expect(uyarilar.some((u) => /geometri bulunamadı/.test(u))).toBe(true);
    }
    await expect(rhinoYaz(null)).rejects.toThrow(/FeatureCollection/);
  });
});
