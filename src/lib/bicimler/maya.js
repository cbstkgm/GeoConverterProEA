// Maya ASCII (.ma) yazıcısı.
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
//
// Eksen kararı: Maya'nın yukarı ekseni sahne dosyasında değil kullanıcı tercihinde tutulur ve varsayılanı Y'dir.
// Bu yüzden veri Z-yukarı olduğu gibi yazılır; kök "ZYukari" transform'u X etrafında -90° döndürülür
// ((x, y, z) → (x, z, -y)). Altındaki "Merkez" transform'u Z-yukarı çerçevede merkez ötelemesini taşır;
// böylece Maya Z-yukarı kullanılsa bile ZYukari'nin dönüşü sıfırlanarak özgün koordinatlara dönülür.
//
// Mesh: ".vt" köşeler, ".ed" kenarlar (v1 v2 yumuşaklık), ".fc" polyFaces "f 3 e0 e1 e2". Yüz kenarı,
// kenar listesindeki yönün tersine kullanılıyorsa -(e+1) yazılır (Maya kuralı).
import { adUretici, asciiAd, degerMetni, sahneHazirla, sayi } from './collada.js';

/** MEL dize sabiti: \ " ve satır sonları kaçışlı. */
export function melDize(metin) {
  return `"${String(metin)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')}"`;
}

/**
 * Üçgen listesinden Maya kenar listesi ve yüz kenar referansları üretir.
 * @returns {{ kenarlar: number[][], yuzler: number[][] }} kenarlar [v1, v2]; yuzler işaretli kenar indeksleri
 */
export function kenarlariKur(indeksler) {
  const kenarlar = [];
  const sozluk = new Map();
  const yuzler = [];
  for (let i = 0; i < indeksler.length; i += 3) {
    const u = [indeksler[i], indeksler[i + 1], indeksler[i + 2]];
    const yuz = [];
    for (let j = 0; j < 3; j++) {
      const a = u[j];
      const b = u[(j + 1) % 3];
      const ileri = `${a},${b}`;
      const geri = `${b},${a}`;
      if (sozluk.has(ileri)) yuz.push(sozluk.get(ileri));
      else if (sozluk.has(geri)) yuz.push(-sozluk.get(geri) - 1);
      else {
        sozluk.set(ileri, kenarlar.length);
        yuz.push(kenarlar.length);
        kenarlar.push([a, b]);
      }
    }
    yuzler.push(yuz);
  }
  return { kenarlar, yuzler };
}

const ucluSatirlari = (konumlar) => {
  const s = [];
  for (let i = 0; i < konumlar.length; i += 3) s.push(`${sayi(konumlar[i])} ${sayi(konumlar[i + 1])} ${sayi(konumlar[i + 2])}`);
  return s;
};

function ozellikKomutlari(ozellikler) {
  const komut = [];
  const kullanilan = new Set();
  for (const k of Object.keys(ozellikler || {})) {
    let uzun = `gc_${asciiAd(k, 'oznitelik')}`;
    for (let n = 2; kullanilan.has(uzun.toLowerCase()); n++) uzun = `gc_${asciiAd(k, 'oznitelik')}_${n}`;
    kullanilan.add(uzun.toLowerCase());
    komut.push(`\taddAttr -ci true -sn ${melDize(uzun)} -ln ${melDize(uzun)} -nn ${melDize(k)} -dt "string";`);
    komut.push(`\tsetAttr ".${uzun}" -type "string" ${melDize(degerMetni(ozellikler[k]))};`);
  }
  return komut;
}

/** GeoJSON FeatureCollection → Maya ASCII 2020. */
export async function mayaYaz(fc, secenekler = {}) {
  const { objeler, uyarilar, merkez } = sahneHazirla(fc);
  const ad = adUretici(['ZYukari', 'Merkez', 'persp', 'top', 'front', 'side', 'time1', 'defaultLayer']);
  const satirlar = [
    '//Maya ASCII 2020 scene',
    '//Name: geoconverter.ma',
    '//Codeset: UTF-8',
    'requires maya "2020";',
    'currentUnit -l meter -a degree -t film;',
    'fileInfo "application" "maya";',
    'fileInfo "product" "Maya 2020";',
    'fileInfo "version" "2020";',
    'fileInfo "GeoConverterProEA_yukariEkseni" "Z";',
    `fileInfo "GeoConverterProEA_merkez" ${melDize(merkez.map(sayi).join(' '))};`,
  ];
  if (secenekler.crs) satirlar.push(`fileInfo "GeoConverterProEA_crs" ${melDize(secenekler.crs)};`);
  satirlar.push(
    'createNode transform -n "ZYukari";',
    '\tsetAttr ".r" -type "double3" -90 0 0;',
    'createNode transform -n "Merkez" -p "ZYukari";',
    `\tsetAttr ".t" -type "double3" ${merkez.map(sayi).join(' ')};`,
  );

  for (const o of objeler) {
    const t = ad(o.ad);
    satirlar.push(`createNode transform -n ${melDize(t)} -p "Merkez";`, ...ozellikKomutlari(o.ozellikler));
    if (o.yuzey) {
      const { konumlar, indeksler } = o.yuzey;
      const { kenarlar, yuzler } = kenarlariKur(indeksler);
      const nv = konumlar.length / 3;
      satirlar.push(
        `createNode mesh -n ${melDize(ad(`${t}Shape`))} -p ${melDize(t)};`,
        '\tsetAttr -k off ".v";',
        `\tsetAttr -s ${nv} ".vt[0:${nv - 1}]" ${ucluSatirlari(konumlar).join('\n\t\t ')};`,
        `\tsetAttr -s ${kenarlar.length} ".ed[0:${kenarlar.length - 1}]" ${kenarlar.map(([a, b]) => `${a} ${b} 0`).join('\n\t\t ')};`,
        `\tsetAttr -s ${yuzler.length} ".fc[0:${yuzler.length - 1}]" -type "polyFaces" ${yuzler.map((y) => `\n\t\tf 3 ${y.join(' ')}`).join('')};`,
      );
    }
    o.cizgiler.forEach((c, ci) => {
      const n = c.length / 3;
      satirlar.push(
        `createNode nurbsCurve -n ${melDize(ad(`${t}_Cizgi${ci + 1}Shape`))} -p ${melDize(t)};`,
        '\tsetAttr -k off ".v";',
        `\tsetAttr ".cc" -type "nurbsCurve" \n\t\t1 ${n - 1} 0 no 3\n\t\t${n} ${Array.from({ length: n }, (_, i) => i).join(' ')}\n\t\t${n}\n\t\t${ucluSatirlari(c).join('\n\t\t')}\n\t\t;`,
      );
    });
    for (let i = 0; i < o.noktalar.length; i += 3) {
      const nt = ad(`${t}_Nokta${i / 3 + 1}`);
      satirlar.push(
        `createNode transform -n ${melDize(nt)} -p ${melDize(t)};`,
        `\tsetAttr ".t" -type "double3" ${o.noktalar.slice(i, i + 3).map(sayi).join(' ')};`,
        `createNode locator -n ${melDize(ad(`${nt}Shape`))} -p ${melDize(nt)};`,
        '\tsetAttr -k off ".v";',
      );
    }
  }
  satirlar.push('// End of geoconverter.ma', '');
  const veri = satirlar.join('\n');
  return { veri, onizleme: veri, uyarilar };
}
