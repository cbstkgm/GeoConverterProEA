import { describe, it, expect } from 'vitest';
import { vrmlYaz, vrmlDize } from './vrml.js';
import { agOlustur } from './ortak/ag.js';

const SALDIRI = '</script><script>alert(1)</script> & "x" \\ # { } [ ]\nyeni satır';
const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (properties, geometry) => ({ type: 'Feature', properties, geometry });
const kare = (x, y, s, z = 0) => [[x, y, z], [x + s, y, z], [x + s, y + s, z], [x, y + s, z], [x, y, z]];
const ornekFc = () =>
  fc([
    obje({ ad: 'Çığır Şöför', not: SALDIRI }, { type: 'Polygon', coordinates: [kare(500000, 4400000, 10, 5), kare(500003, 4400003, 2, 5).reverse()] }),
    obje({ ad: 'Çığır Şöför' }, { type: 'MultiPolygon', coordinates: [[kare(500020, 4400000, 5)], [kare(500030, 4400000, 5)]] }),
    obje({ ad: 'TRUE' }, { type: 'MultiLineString', coordinates: [[[500000, 4400020], [500010, 4400020], [500010, 4400030]], [[500000, 4400040], [500005, 4400045]]] }),
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

/**
 * Basit VRML sözcük çözümleyici: dizeleri çözer, yorumları atar, { } [ ] dengesini denetler.
 * Dönüş: { belirtecler, dizeler }.
 */
function cozumle(metin) {
  const belirtecler = [];
  const dizeler = [];
  const yigin = [];
  let i = 0;
  while (i < metin.length) {
    const c = metin[i];
    if (c === '#') {
      while (i < metin.length && metin[i] !== '\n') i++;
    } else if (c === '"') {
      let s = '';
      i++;
      while (metin[i] !== '"') {
        if (i >= metin.length) throw new Error('Kapanmamış dize');
        if (metin[i] === '\\') i++;
        s += metin[i++];
      }
      i++;
      dizeler.push(s);
      belirtecler.push({ dize: s });
    } else if ('{['.includes(c)) {
      yigin.push(c);
      belirtecler.push(c);
      i++;
    } else if ('}]'.includes(c)) {
      const ac = yigin.pop();
      if ((c === '}' && ac !== '{') || (c === ']' && ac !== '[')) throw new Error(`Dengesiz ${c}`);
      belirtecler.push(c);
      i++;
    } else if (/[\s,]/.test(c)) {
      i++;
    } else {
      let s = '';
      while (i < metin.length && !/[\s,{}[\]"#]/.test(metin[i])) s += metin[i++];
      belirtecler.push(s);
    }
  }
  if (yigin.length) throw new Error('Kapanmamış blok');
  return { belirtecler, dizeler };
}

/** "anahtar [ ... ]" dizisini sayılar olarak toplar (n. eşleşme). */
function dizi(metin, anahtar, n = 0) {
  const eslesmeler = [...metin.matchAll(new RegExp(`${anahtar} \\[([^\\]]*)\\]`, 'g'))];
  return eslesmeler[n][1].split(/[\s,]+/).filter(Boolean).map(Number);
}

describe('vrmlYaz', () => {
  it('başlık, dengeli yapı, Z-yukarı dönüşü, merkez ve WorldInfo', async () => {
    const girdi = ornekFc();
    const { veri, onizleme, uyarilar } = await vrmlYaz(girdi, { crs: 'EPSG:5255' });
    expect(onizleme).toBe(veri);
    expect(veri.split('\n')[0]).toBe('#VRML V2.0 utf8');
    const { belirtecler, dizeler } = cozumle(veri);
    const { merkez } = agOlustur(girdi);
    expect(veri).toContain('rotation 1 0 0 -1.5707963267948966');
    const tr = [...veri.matchAll(/DEF (Merkez|MerkezInce) Transform \{\n translation ([^\n]+)/g)].map((m) => [m[1], m[2].split(' ').map(Number)]);
    expect(tr.map((t) => t[0])).toEqual(['Merkez', 'MerkezInce']);
    expect(tr[0][1].map((v, i) => v + tr[1][1][i])).toEqual(merkez);
    expect(dizeler).toContain(`merkez=${merkez.join(' ')}`);
    expect(dizeler).toContain('crs=EPSG:5255');
    expect(uyarilar.some((u) => /geometrisiz/.test(u))).toBe(true);

    const defler = belirtecler.flatMap((b, i) => (b === 'DEF' ? [belirtecler[i + 1]] : []));
    expect(defler).toEqual(['ZYukari', 'Merkez', 'MerkezInce', 'Cigir_Sofor', 'Cigir_Sofor_2', 'TRUE_2', 'Nirengi', 'Obje_5']);
    for (const d of defler) expect(d).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('kesirli büyük merkez: iki Transform, float32 toplamı 1 mm içinde; WorldInfo tam değer', async () => {
    const girdi = kesirliFc();
    const { merkez } = agOlustur(girdi);
    const { veri } = await vrmlYaz(girdi);
    const { dizeler } = cozumle(veri);
    const [kaba, ince] = [...veri.matchAll(/DEF (?:Merkez|MerkezInce) Transform \{\n translation ([^\n]+)/g)].map((m) => m[1].split(' ').map(Number));
    for (const k of kaba) expect(Number.isInteger(k)).toBe(true);
    float32Toplam(kaba, ince).forEach((v, i) => expect(Math.abs(v - merkez[i])).toBeLessThan(1e-3));
    expect(dizeler).toContain(`merkez=${merkez.join(' ')}`);
  });

  it('IndexedFaceSet (delikli, -1 ayraçlı), IndexedLineSet, PointSet', async () => {
    const { veri } = await vrmlYaz(ornekFc());
    const yuz = dizi(veri, 'coordIndex', 0);
    expect(yuz).toHaveLength(8 * 4);
    for (let i = 3; i < yuz.length; i += 4) expect(yuz[i]).toBe(-1);
    const nokta = dizi(veri, 'point', 0);
    expect(nokta).toHaveLength(8 * 3);
    expect(Math.max(...yuz)).toBe(7);
    expect(dizi(veri, 'coordIndex', 1)).toHaveLength(4 * 4); // MultiPolygon: 2 kare × 2 üçgen
    expect(dizi(veri, 'coordIndex', 2)).toEqual([0, 1, 2, -1, 3, 4, -1]);
    expect(veri).toContain('PointSet');
    expect(veri.match(/IndexedFaceSet/g)).toHaveLength(2);
    expect(veri.match(/IndexedLineSet/g)).toHaveLength(2);
    expect(veri.match(/PointSet/g)).toHaveLength(2);
  });

  it('öznitelik dizeleri kaçışlı ve geri okunur (satır sonu boşluk olur)', async () => {
    const { veri } = await vrmlYaz(ornekFc());
    const { dizeler } = cozumle(veri);
    expect(dizeler).toContain('ad=Çığır Şöför');
    expect(dizeler).toContain(`not=${SALDIRI.replace('\n', ' ')}`);
    expect(dizeler).toContain('Çığır Şöför');
    expect(vrmlDize('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('boş FC', async () => {
    const { veri, uyarilar } = await vrmlYaz(fc([]));
    cozumle(veri);
    expect(veri).not.toContain('Shape');
    expect(uyarilar).toEqual(['Yazılacak geometri bulunamadı; boş bir sahne üretildi.']);
  });
});
