import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { usdYaz, usdzYaz, usdDize, crc32, usdzPaketle, USDZ_HIZALAMA } from './usd.js';
import { agOlustur } from './ortak/ag.js';

const SALDIRI = '</script><script>alert(1)</script> & "x" \\ ( ) { }\nyeni';
const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (properties, geometry) => ({ type: 'Feature', properties, geometry });
const kare = (x, y, s, z = 0) => [[x, y, z], [x + s, y, z], [x + s, y + s, z], [x, y + s, z], [x, y, z]];
const ornekFc = () =>
  fc([
    obje({ ad: 'Çığır Şöför', not: SALDIRI, alan: 96.5, aktif: true }, { type: 'Polygon', coordinates: [kare(500000, 4400000, 10, 5), kare(500003, 4400003, 2, 5).reverse()] }),
    obje({ ad: 'Çığır Şöför' }, { type: 'MultiPolygon', coordinates: [[kare(500020, 4400000, 5)], [kare(500030, 4400000, 5)]] }),
    obje({ ad: 'Yol' }, { type: 'MultiLineString', coordinates: [[[500000, 4400020], [500010, 4400020], [500010, 4400030]], [[500000, 4400040], [500005, 4400045]]] }),
    obje({ ad: 'Nirengi', kod: 7 }, { type: 'MultiPoint', coordinates: [[500001, 4400001, 12.5], [500002, 4400002]] }),
    obje({}, { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [500040, 4400040] }, { type: 'LineString', coordinates: [[500040, 4400040], [500041, 4400041]] }] }),
    obje({ ad: 'Boş' }, null),
  ]);

/** Dizeler dışında ( ) { } [ ] dengesini denetler; dizeleri çözüp döndürür. */
function denetle(metin) {
  const yigin = [];
  const dizeler = [];
  const eslesme = { ')': '(', '}': '{', ']': '[' };
  for (let i = 0; i < metin.length; i++) {
    const c = metin[i];
    if (c === '"') {
      let s = '';
      for (i++; metin[i] !== '"'; i++) {
        if (metin[i] === '\\') {
          i++;
          s += { n: '\n', r: '\r', t: '\t' }[metin[i]] ?? metin[i];
        } else s += metin[i];
      }
      dizeler.push(s);
    } else if ('({['.includes(c)) yigin.push(c);
    else if (')}]'.includes(c)) expect(yigin.pop()).toBe(eslesme[c]);
  }
  expect(yigin).toEqual([]);
  return dizeler;
}

/** `def <Tip> "<ad>"` bloğunu (dengeli { }) döndürür. */
function blok(metin, tip, ad) {
  const bas = metin.indexOf(`def ${tip} "${ad}"`);
  expect(bas).toBeGreaterThanOrEqual(0);
  // Prim meta verisi ( … ) varsa atlanır; gövde ondan sonraki ilk { … } bloğudur.
  let parantez = 0;
  let govde = false;
  let derinlik = 0;
  for (let j = bas + `def ${tip} "${ad}"`.length; j < metin.length; j++) {
    const c = metin[j];
    if (c === '"') {
      for (j++; metin[j] !== '"'; j++) if (metin[j] === '\\') j++;
    } else if (c === '(') parantez++;
    else if (c === ')') parantez--;
    else if (parantez === 0 && c === '{') {
      govde = true;
      derinlik++;
    } else if (parantez === 0 && govde && c === '}' && --derinlik === 0) return metin.slice(bas, j + 1);
  }
  throw new Error('blok bulunamadı');
}

const ozellik = (b, ad) => {
  const m = new RegExp(`${ad} = (\\[[^\\]]*\\]|\\([^)]*\\)|"[^"]*"|\\S+)`).exec(b);
  return m && m[1];
};
const sayilar = (s) => s.replace(/[[\]()]/g, ' ').split(/[\s,]+/).filter(Boolean).map(Number);

describe('usdYaz (USDA)', () => {
  it('katman meta verisi, kök Xform translate = merkez, prim adları', async () => {
    const girdi = ornekFc();
    const { veri, onizleme, uyarilar } = await usdYaz(girdi, { crs: 'EPSG:5255' });
    expect(onizleme).toBe(veri);
    expect(veri.startsWith('#usda 1.0\n(')).toBe(true);
    expect(veri).toContain('upAxis = "Z"');
    expect(veri).toContain('metersPerUnit = 1');
    expect(veri).toContain('defaultPrim = "Kok"');
    expect(veri).toContain('def Xform "Kok"');
    const { merkez } = agOlustur(girdi);
    expect(veri).toContain(`double3 xformOp:translate = (${merkez.join(', ')})`);
    expect(veri).toContain(`double3 merkez = (${merkez.join(', ')})`);
    expect(veri).toContain('uniform token[] xformOpOrder = ["xformOp:translate"]');
    expect(veri).toContain('string crs = "EPSG:5255"');
    const dizeler = denetle(veri);
    expect(dizeler).toContain(SALDIRI);
    const adlar = [...veri.matchAll(/^ {4}def Xform "([^"]+)"/gm)].map((m) => m[1]);
    expect(adlar).toEqual(['Cigir_Sofor', 'Cigir_Sofor_2', 'Yol', 'Nirengi', 'Obje_5']);
    expect(uyarilar.some((u) => /geometrisiz/.test(u))).toBe(true);
  });

  it('Mesh: points/faceVertexCounts/faceVertexIndices/normals/extent tutarlı (delikli poligon)', async () => {
    const { veri } = await usdYaz(ornekFc());
    const m = blok(blok(veri, 'Xform', 'Cigir_Sofor'), 'Mesh', 'yuzey');
    const p = sayilar(ozellik(m, 'point3f\\[\\] points'));
    const sayim = sayilar(ozellik(m, 'int\\[\\] faceVertexCounts'));
    const ind = sayilar(ozellik(m, 'int\\[\\] faceVertexIndices'));
    const n = sayilar(ozellik(m, 'normal3f\\[\\] normals'));
    const ext = sayilar(ozellik(m, 'float3\\[\\] extent'));
    expect(p).toHaveLength(24);
    expect(sayim).toEqual(new Array(8).fill(3));
    expect(ind).toHaveLength(24);
    expect(Math.max(...ind)).toBe(7);
    expect(n).toHaveLength(8 * 3); // uniform: yüz başına bir normal
    expect(m).toContain('interpolation = "uniform"');
    for (let i = 0; i < n.length; i += 3) expect([n[i], n[i + 1], n[i + 2]]).toEqual([0, 0, 1]);
    for (let i = 0; i < p.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        expect(p[i + e]).toBeGreaterThanOrEqual(ext[e]);
        expect(p[i + e]).toBeLessThanOrEqual(ext[3 + e]);
      }
    }
    expect(ext[2]).toBe(5);
    // MultiPolygon tek Mesh.
    const m2 = blok(blok(veri, 'Xform', 'Cigir_Sofor_2'), 'Mesh', 'yuzey');
    expect(sayilar(ozellik(m2, 'int\\[\\] faceVertexCounts'))).toHaveLength(4);
  });

  it('BasisCurves linear ve Points; extent ve sayımlar', async () => {
    const { veri } = await usdYaz(ornekFc());
    const c = blok(blok(veri, 'Xform', 'Yol'), 'BasisCurves', 'cizgi');
    expect(c).toContain('uniform token type = "linear"');
    expect(sayilar(ozellik(c, 'int\\[\\] curveVertexCounts'))).toEqual([3, 2]);
    expect(sayilar(ozellik(c, 'point3f\\[\\] points'))).toHaveLength(15);
    expect(ozellik(c, 'float3\\[\\] extent')).toBeTruthy();
    const p = blok(blok(veri, 'Xform', 'Nirengi'), 'Points', 'nokta');
    expect(sayilar(ozellik(p, 'point3f\\[\\] points'))).toHaveLength(6);
    expect(ozellik(p, 'float3\\[\\] extent')).toBeTruthy();
    const gc = blok(veri, 'Xform', 'Obje_5');
    expect(gc).toContain('def Points "nokta"');
    expect(gc).toContain('def BasisCurves "cizgi"');
  });

  it('customData: tür eşlemesi ve kaçış', async () => {
    const { veri } = await usdYaz(ornekFc());
    const x = blok(veri, 'Xform', 'Cigir_Sofor');
    expect(x).toContain('string "ad" = "Çığır Şöför"');
    expect(x).toContain('double "alan" = 96.5');
    expect(x).toContain('bool "aktif" = 1');
    expect(x).toContain(`string "not" = ${usdDize(SALDIRI)}`);
    expect(usdDize('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it('boş FC: geçerli katman, boş kök', async () => {
    const { veri, uyarilar } = await usdYaz(fc([]));
    denetle(veri);
    expect(veri).toContain('def Xform "Kok"');
    expect(veri).not.toContain('def Mesh');
    expect(uyarilar).toEqual(['Yazılacak geometri bulunamadı; boş bir sahne üretildi.']);
  });
});

/** Yerel dosya başlıklarını gezer. */
function yerelBasliklar(bayt) {
  const v = new DataView(bayt.buffer, bayt.byteOffset, bayt.byteLength);
  const sonuc = [];
  let o = 0;
  while (v.getUint32(o, true) === 0x04034b50) {
    const yontem = v.getUint16(o + 8, true);
    const crc = v.getUint32(o + 14, true);
    const boyut = v.getUint32(o + 18, true);
    const adUz = v.getUint16(o + 26, true);
    const extraUz = v.getUint16(o + 28, true);
    const ad = new TextDecoder().decode(bayt.subarray(o + 30, o + 30 + adUz));
    const veriOfset = o + 30 + adUz + extraUz;
    sonuc.push({ ad, yontem, crc, boyut, veriOfset, extraUz, veri: bayt.subarray(veriOfset, veriOfset + boyut) });
    o = veriOfset + boyut;
  }
  return sonuc;
}

describe('usdzYaz', () => {
  it('STORED zip, ilk dosya model.usda, veri 64 bayt hizalı, CRC doğru, JSZip okur', async () => {
    const girdi = ornekFc();
    const { veri, onizleme } = await usdzYaz(girdi, { crs: 'EPSG:5255' });
    expect(veri).toBeInstanceOf(Uint8Array);
    const basliklar = yerelBasliklar(veri);
    expect(basliklar).toHaveLength(1);
    const [b] = basliklar;
    expect(b.ad).toBe('model.usda');
    expect(b.yontem).toBe(0);
    expect(b.veriOfset % USDZ_HIZALAMA).toBe(0);
    expect(b.crc).toBe(crc32(b.veri));
    const usda = (await usdYaz(girdi, { crs: 'EPSG:5255' })).veri;
    expect(new TextDecoder().decode(b.veri)).toBe(usda);
    expect(onizleme).toBe(usda);
    const zip = await JSZip.loadAsync(veri, { checkCRC32: true });
    expect(Object.keys(zip.files)).toEqual(['model.usda']);
    expect(await zip.file('model.usda').async('string')).toBe(usda);
  });

  it('çok dosyada ve her ad uzunluğunda hizalama korunur (extra dolgusu ≥ 4 bayt)', async () => {
    const dosyalar = Array.from({ length: 70 }, (_, i) => ({
      ad: `${'d'.repeat(i + 1)}.usda`,
      veri: new TextEncoder().encode('#usda 1.0\n'.repeat(i % 7)),
    }));
    const zipBayt = usdzPaketle(dosyalar);
    const basliklar = yerelBasliklar(zipBayt);
    expect(basliklar).toHaveLength(70);
    for (const b of basliklar) {
      expect(b.veriOfset % 64).toBe(0);
      expect(b.extraUz === 0 || b.extraUz >= 4).toBe(true);
    }
    const zip = await JSZip.loadAsync(zipBayt, { checkCRC32: true });
    expect(Object.keys(zip.files)).toHaveLength(70);
  });

  it('crc32 bilinen değer', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('boş FC de geçerli USDZ üretir', async () => {
    const { veri } = await usdzYaz(fc([]));
    const zip = await JSZip.loadAsync(veri, { checkCRC32: true });
    expect(await zip.file('model.usda').async('string')).toContain('#usda 1.0');
  });
});
