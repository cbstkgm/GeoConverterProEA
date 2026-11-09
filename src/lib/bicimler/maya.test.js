import { describe, it, expect } from 'vitest';
import { mayaYaz, melDize, kenarlariKur } from './maya.js';
import { agOlustur } from './ortak/ag.js';

const SALDIRI = '</script><script>alert(1)</script> & "x" \\ ; { }\nyeni';
const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (properties, geometry) => ({ type: 'Feature', properties, geometry });
const kare = (x, y, s, z = 0) => [[x, y, z], [x + s, y, z], [x + s, y + s, z], [x, y + s, z], [x, y, z]];
const ornekFc = () =>
  fc([
    obje({ ad: 'Çığır Şöför', not: SALDIRI, 'şehir adı': 'İğdır', 'Şehir-adı': 'x' }, { type: 'Polygon', coordinates: [kare(500000, 4400000, 10, 5), kare(500003, 4400003, 2, 5).reverse()] }),
    obje({ ad: 'Çığır Şöför' }, { type: 'MultiPolygon', coordinates: [[kare(500020, 4400000, 5)], [kare(500030, 4400000, 5)]] }),
    obje({ ad: 'Yol' }, { type: 'MultiLineString', coordinates: [[[500000, 4400020], [500010, 4400020], [500010, 4400030]], [[500000, 4400040], [500005, 4400045]]] }),
    obje({ ad: 'Nirengi', kod: 7 }, { type: 'MultiPoint', coordinates: [[500001, 4400001, 12.5], [500002, 4400002]] }),
    obje({}, { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [500040, 4400040] }, { type: 'LineString', coordinates: [[500040, 4400040], [500041, 4400041]] }] }),
    obje({ ad: 'Boş' }, null),
  ]);

/** .ma dosyasını komutlara ayırır: her komut belirteç dizisi (dizeler çözülmüş, { dize } olarak). */
function komutlar(metin) {
  const sonuc = [];
  let gecerli = [];
  let i = 0;
  while (i < metin.length) {
    const c = metin[i];
    if (c === '/' && metin[i + 1] === '/') {
      while (i < metin.length && metin[i] !== '\n') i++;
    } else if (c === '"') {
      let s = '';
      for (i++; metin[i] !== '"'; i++) {
        if (i >= metin.length) throw new Error('kapanmamış dize');
        if (metin[i] === '\\') {
          i++;
          s += { n: '\n', r: '\r', t: '\t' }[metin[i]] ?? metin[i];
        } else s += metin[i];
      }
      i++;
      gecerli.push({ dize: s });
    } else if (c === ';') {
      sonuc.push(gecerli);
      gecerli = [];
      i++;
    } else if (/\s/.test(c)) i++;
    else {
      let s = '';
      while (i < metin.length && !/[\s;"]/.test(metin[i])) s += metin[i++];
      gecerli.push(s);
    }
  }
  expect(gecerli).toEqual([]);
  return sonuc;
}

const deger = (b) => (typeof b === 'object' ? b.dize : b);

/** createNode'lara göre düğüm ağacı ve her düğümün setAttr/addAttr komutları. */
function sahne(metin) {
  const dugumler = [];
  let son = null;
  for (const k of komutlar(metin)) {
    if (k[0] === 'createNode') {
      const ad = deger(k[k.indexOf('-n') + 1]);
      const p = k.indexOf('-p');
      son = { tip: k[1], ad, ebeveyn: p >= 0 ? deger(k[p + 1]) : null, setAttr: [], addAttr: [] };
      dugumler.push(son);
    } else if (k[0] === 'setAttr' || k[0] === 'addAttr') {
      son[k[0]].push(k);
    }
  }
  return dugumler;
}

const attr = (dugum, ad) => dugum.setAttr.find((k) => k.some((b) => typeof b === 'object' && b.dize.startsWith(ad)));
const sayilarSonra = (k, ad) => {
  const i = k.findIndex((b) => typeof b === 'object' && b.dize.startsWith(ad));
  return k.slice(i + 1);
};

/** Mesh tutarlılığı: kenarlar ve yüz kenar referansları üçgenleri birebir kurar. */
function meshDenetle(mesh) {
  const vt = attr(mesh, '.vt[');
  const nv = Number(vt[vt.indexOf('-s') + 1]);
  const konum = sayilarSonra(vt, '.vt[').map(Number);
  expect(konum).toHaveLength(nv * 3);
  const ed = attr(mesh, '.ed[');
  const ne = Number(ed[ed.indexOf('-s') + 1]);
  const kenarHam = sayilarSonra(ed, '.ed[').map(Number);
  expect(kenarHam).toHaveLength(ne * 3);
  const kenarlar = [];
  for (let i = 0; i < kenarHam.length; i += 3) {
    const [a, b] = [kenarHam[i], kenarHam[i + 1]];
    expect(a).not.toBe(b);
    expect(a < nv && b < nv && a >= 0 && b >= 0).toBe(true);
    kenarlar.push([a, b]);
  }
  const anahtarlar = kenarlar.map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join(','));
  expect(new Set(anahtarlar).size).toBe(ne); // yinelenen kenar yok
  const fcK = attr(mesh, '.fc[');
  const nf = Number(fcK[fcK.indexOf('-s') + 1]);
  expect(fcK).toContainEqual({ dize: 'polyFaces' });
  const yuzBelirtec = fcK.slice(fcK.findIndex((b) => b === 'f'));
  const kullanim = new Array(ne).fill(0);
  const ucgenler = [];
  for (let i = 0; i < yuzBelirtec.length; ) {
    expect(yuzBelirtec[i]).toBe('f');
    const n = Number(yuzBelirtec[i + 1]);
    expect(n).toBe(3);
    const e = yuzBelirtec.slice(i + 2, i + 2 + n).map(Number);
    const yonlu = e.map((x) => (x >= 0 ? kenarlar[x] : [...kenarlar[-x - 1]].reverse()));
    e.forEach((x) => kullanim[x >= 0 ? x : -x - 1]++);
    for (let j = 0; j < n; j++) expect(yonlu[j][1]).toBe(yonlu[(j + 1) % n][0]); // kapalı zincir
    ucgenler.push(yonlu.map((y) => y[0]));
    i += 2 + n;
  }
  expect(ucgenler).toHaveLength(nf);
  expect(Math.max(...kullanim)).toBeLessThanOrEqual(2); // manifold
  expect(Math.min(...kullanim)).toBeGreaterThanOrEqual(1); // kullanılmayan kenar yok
  // CCW (normal +Z)
  for (const [a, b, c] of ucgenler) {
    const p = (j) => konum.slice(j * 3, j * 3 + 2);
    const [A, B, C] = [p(a), p(b), p(c)];
    expect((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])).toBeGreaterThan(0);
  }
  return { nv, ne, nf, konum };
}

describe('Maya merkez hassasiyeti', () => {
  it('.t double3 (double): kesirli büyük merkez metinden birebir geri okunur, bölmeye gerek yok', async () => {
    const girdi = fc([
      obje({ ad: 'K' }, { type: 'Polygon', coordinates: [[[512345.678, 4412345.987, 1012.345], [512355.123, 4412345.987, 1012.345], [512355.123, 4412356.456, 1012.345], [512345.678, 4412345.987, 1012.345]]] }),
    ]);
    const { merkez } = agOlustur(girdi);
    const { veri } = await mayaYaz(girdi);
    expect(veri).toContain('setAttr ".t" -type "double3" ');
    const d = sahne(veri);
    const t = sayilarSonra(attr(d.find((n) => n.ad === 'Merkez'), '.t'), 'double3').map(Number);
    expect(t).toEqual(merkez);
    expect(merkez[0] % 1).not.toBe(0);
  });
});

describe('kenarlariKur', () => {
  it('ortak kenar bir kez, ters yönlü kullanım -(e+1)', () => {
    const { kenarlar, yuzler } = kenarlariKur([0, 1, 2, 0, 2, 3]);
    expect(kenarlar).toEqual([[0, 1], [1, 2], [2, 0], [2, 3], [3, 0]]);
    expect(yuzler).toEqual([[0, 1, 2], [-3, 3, 4]]);
  });
});

describe('mayaYaz', () => {
  it('başlık, birim, Z-yukarı kök dönüşü, merkez, düğüm ağacı', async () => {
    const girdi = ornekFc();
    const { veri, onizleme, uyarilar } = await mayaYaz(girdi, { crs: 'EPSG:5255' });
    expect(onizleme).toBe(veri);
    const satirlar = veri.split('\n');
    expect(satirlar[0]).toBe('//Maya ASCII 2020 scene');
    expect(veri).toContain('requires maya "2020";');
    expect(veri.indexOf('currentUnit -l meter')).toBeGreaterThan(veri.indexOf('requires maya'));
    expect(veri).toContain('fileInfo "GeoConverterProEA_crs" "EPSG:5255";');
    const { merkez } = agOlustur(girdi);
    const d = sahne(veri);
    const zy = d.find((n) => n.ad === 'ZYukari');
    expect(sayilarSonra(attr(zy, '.r'), 'double3').map(Number)).toEqual([-90, 0, 0]);
    const mz = d.find((n) => n.ad === 'Merkez');
    expect(mz.ebeveyn).toBe('ZYukari');
    expect(sayilarSonra(attr(mz, '.t'), 'double3').map(Number)).toEqual(merkez);
    // Adlar geçerli ve benzersiz; ebeveynler önceden tanımlı.
    const adlar = d.map((n) => n.ad);
    expect(new Set(adlar).size).toBe(adlar.length);
    const tanimli = new Set();
    for (const n of d) {
      expect(n.ad).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      if (n.ebeveyn) expect(tanimli.has(n.ebeveyn)).toBe(true);
      tanimli.add(n.ad);
    }
    const objeler = d.filter((n) => n.ebeveyn === 'Merkez').map((n) => n.ad);
    expect(objeler).toEqual(['Cigir_Sofor', 'Cigir_Sofor_2', 'Yol', 'Nirengi', 'Obje_5']);
    expect(uyarilar.some((u) => /geometrisiz/.test(u))).toBe(true);
  });

  it('delikli ve çok parçalı poligon mesh: kenar/yüz tutarlılığı', async () => {
    const d = sahne((await mayaYaz(ornekFc())).veri);
    const m1 = meshDenetle(d.find((n) => n.tip === 'mesh' && n.ebeveyn === 'Cigir_Sofor'));
    expect([m1.nv, m1.nf]).toEqual([8, 8]);
    expect(m1.ne).toBe(16); // Euler: V - E + F = 0 (tek delikli yüzey) → E = 16
    expect(m1.konum[2]).toBe(5);
    const m2 = meshDenetle(d.find((n) => n.tip === 'mesh' && n.ebeveyn === 'Cigir_Sofor_2'));
    expect([m2.nv, m2.nf, m2.ne]).toEqual([8, 4, 10]);
  });

  it('çizgiler degree-1 nurbsCurve; noktalar locator', async () => {
    const d = sahne((await mayaYaz(ornekFc())).veri);
    const egriler = d.filter((n) => n.tip === 'nurbsCurve' && n.ebeveyn === 'Yol');
    expect(egriler).toHaveLength(2);
    const cc = attr(egriler[0], '.cc');
    const s = sayilarSonra(cc, 'nurbsCurve');
    // derece span biçim rasyonel boyut | düğüm sayısı düğümler | cv sayısı cv'ler
    expect(s.slice(0, 5)).toEqual(['1', '2', '0', 'no', '3']);
    expect(s.slice(5, 9).map(Number)).toEqual([3, 0, 1, 2]);
    expect(Number(s[9])).toBe(3);
    expect(s.slice(10)).toHaveLength(9);
    const locator = d.filter((n) => n.tip === 'locator');
    expect(locator).toHaveLength(3);
    const nokta = d.find((n) => n.ad === 'Nirengi_Nokta1');
    expect(sayilarSonra(attr(nokta, '.t'), 'double3').map(Number)[2]).toBe(12.5);
    expect(d.filter((n) => n.ebeveyn === 'Obje_5').map((n) => n.tip).sort()).toEqual(['nurbsCurve', 'transform']);
  });

  it('öznitelikler string addAttr/setAttr; ad temizliği ve kaçış', async () => {
    const { veri } = await mayaYaz(ornekFc());
    const d = sahne(veri);
    const t = d.find((n) => n.ad === 'Cigir_Sofor');
    const uzunAdlar = t.addAttr.map((k) => deger(k[k.indexOf('-ln') + 1]));
    expect(uzunAdlar).toEqual(['gc_ad', 'gc_not', 'gc_sehir_adi', 'gc_Sehir_adi_2']);
    const guzelAdlar = t.addAttr.map((k) => deger(k[k.indexOf('-nn') + 1]));
    expect(guzelAdlar).toEqual(['ad', 'not', 'şehir adı', 'Şehir-adı']);
    const notK = t.setAttr.find((k) => deger(k[1]) === '.gc_not');
    expect(deger(notK[notK.length - 1])).toBe(SALDIRI);
    expect(melDize('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it('boş FC', async () => {
    const { veri, uyarilar } = await mayaYaz(fc([]));
    const d = sahne(veri);
    expect(d.map((n) => n.ad)).toEqual(['ZYukari', 'Merkez']);
    expect(uyarilar).toEqual(['Yazılacak geometri bulunamadı; boş bir sahne üretildi.']);
  });
});
