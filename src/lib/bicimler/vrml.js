// VRML97 (.wrl) yazıcısı — "#VRML V2.0 utf8".
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
// Eksen: VRML Y-yukarıdır; x3d.js ile aynı karar — veri Z-yukarı yazılır, dış Transform
// rotation 1 0 0 -π/2 ile çevrilir; iç Transform translation = merkez. Öznitelikler ve merkez WorldInfo'da.
import { AILE_RENKLERI, adUretici, degerMetni, merkeziBol, sahneHazirla, sayi } from './collada.js';
import { X3D_DONDURME } from './x3d.js';

/** VRML97 anahtar sözcükleri (DEF adı olamaz). */
const AYRILMIS = ['DEF', 'EXTERNPROTO', 'FALSE', 'IS', 'NULL', 'PROTO', 'ROUTE', 'TO', 'TRUE', 'USE', 'eventIn', 'eventOut', 'exposedField', 'field'];

/** SFString: \ ve " kaçışlı, kontrol karakterleri (satır sonu dahil) boşluk. */
export function vrmlDize(metin) {
  return `"${String(metin)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')}"`;
}

const liste = (dizi) => dizi.map(sayi).join(' ');

function noktaListesi(konumlar) {
  const satirlar = [];
  for (let i = 0; i < konumlar.length; i += 3) satirlar.push(liste(konumlar.slice(i, i + 3)));
  return satirlar.join(', ');
}

/** GeoJSON FeatureCollection → VRML97. */
export async function vrmlYaz(fc, secenekler = {}) {
  const { objeler, uyarilar, merkez } = sahneHazirla(fc);
  // SFVec3f float32'dir: merkez tam metre (Merkez) + kesir (MerkezInce) olarak iki Transform'a bölünür.
  const merkezParca = merkeziBol(merkez);
  const ad = adUretici([...AYRILMIS, 'ZYukari', 'Merkez', 'MerkezInce']);
  const [ry, rc, rn] = [AILE_RENKLERI.yuzey, AILE_RENKLERI.cizgi, AILE_RENKLERI.nokta].map((r) => r.join(' '));

  const dugumler = objeler.map((o) => {
    const cocuklar = [];
    const bilgi = Object.keys(o.ozellikler || {}).map((k) => vrmlDize(`${k}=${degerMetni(o.ozellikler[k])}`));
    cocuklar.push(`WorldInfo { title ${vrmlDize(o.ad)} info [ ${bilgi.join(', ')} ] }`);
    if (o.yuzey) {
      const ucgenler = [];
      for (let i = 0; i < o.yuzey.indeksler.length; i += 3) ucgenler.push(`${o.yuzey.indeksler.slice(i, i + 3).join(' ')} -1`);
      cocuklar.push(
        `Shape {\n  appearance Appearance { material Material { diffuseColor ${ry} } }\n` +
          `  geometry IndexedFaceSet {\n    solid FALSE\n    ccw TRUE\n    coord Coordinate { point [ ${noktaListesi(o.yuzey.konumlar)} ] }\n    coordIndex [ ${ucgenler.join(', ')} ]\n  }\n}`,
      );
    }
    if (o.cizgiler.length) {
      const konum = [];
      const indeks = [];
      for (const c of o.cizgiler) {
        const bas = konum.length / 3;
        konum.push(...c);
        indeks.push(`${Array.from({ length: c.length / 3 }, (_, i) => bas + i).join(' ')} -1`);
      }
      cocuklar.push(
        `Shape {\n  appearance Appearance { material Material { diffuseColor 0 0 0 emissiveColor ${rc} } }\n` +
          `  geometry IndexedLineSet {\n    coord Coordinate { point [ ${noktaListesi(konum)} ] }\n    coordIndex [ ${indeks.join(', ')} ]\n  }\n}`,
      );
    }
    if (o.noktalar.length) {
      cocuklar.push(
        `Shape {\n  appearance Appearance { material Material { diffuseColor 0 0 0 emissiveColor ${rn} } }\n` +
          `  geometry PointSet { coord Coordinate { point [ ${noktaListesi(o.noktalar)} ] } }\n}`,
      );
    }
    return `DEF ${ad(o.ad)} Transform {\n children [\n${cocuklar.join('\n')}\n ]\n}`;
  });

  const sahneBilgi = [vrmlDize(`merkez=${liste(merkez)}`), vrmlDize('yukariEkseni=Z'), vrmlDize('birim=metre')];
  if (secenekler.crs) sahneBilgi.push(vrmlDize(`crs=${secenekler.crs}`));

  const veri = [
    '#VRML V2.0 utf8',
    '# GeoConverterProEA — Z-yukarı veri, dış Transform ile Y-yukarıya çevrilir.',
    `WorldInfo { title "GeoConverterProEA" info [ ${sahneBilgi.join(', ')} ] }`,
    `DEF ZYukari Transform {\n rotation ${X3D_DONDURME}\n children [`,
    `DEF Merkez Transform {\n translation ${liste(merkezParca.kaba)}\n children [`,
    `DEF MerkezInce Transform {\n translation ${liste(merkezParca.ince)}\n children [`,
    ...dugumler,
    ' ]\n}\n ]\n}\n ]\n}',
    '',
  ].join('\n');
  return { veri, onizleme: veri, uyarilar };
}
