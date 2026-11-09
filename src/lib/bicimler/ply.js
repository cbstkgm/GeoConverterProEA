/**
 * PLY (Stanford Polygon File Format) yazıcısı (`.ply`).
 *
 * Saf JavaScript: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
 * Geometri `ortak/ag.js` → `agOlustur(fc)` ile hazırlanır (CCW üçgenler, Z-yukarı, merkez ötelemesi).
 *
 * Başlık (ASCII):
 *   ply
 *   format binary_little_endian 1.0      (secenekler.ascii === true → format ascii 1.0)
 *   comment …                            (üretici, eksen, merkez ötelemesi, obje adları)
 *   element vertex N
 *   property double x / y / z
 *   element face M
 *   property list uchar int vertex_indices
 *   property int obje                    (0 tabanlı GeoJSON obje sırası; obje adları comment'te)
 *   element edge K                       (yalnızca çizgi varsa)
 *   property int vertex1 / vertex2 / obje
 *   end_header
 *
 * Neden double? PLY'nin float (32 bit) türü ~7 anlamlı basamak taşır; merkez ötelemesi sonrası bile
 * büyük (kilometrelerce) veri kümelerinde milimetre altı hassasiyet için yetersiz kalabilir. double,
 * kaynak koordinatları kayıpsız taşır ve CloudCompare, MeshLab, Open3D, PDAL, Blender (4.x) okur.
 * Merkez ötelemesi yine uygulanır ve `comment merkez x y z` olarak yazılır, böylece float'a çeviren
 * okuyucularda da hassasiyet korunur.
 *
 * Noktalar yalnızca köşe olarak bulunur (hiçbir yüze/kenara bağlı değildir) — PLY nokta bulutunun doğal hâli.
 * Başlık ASCII olmalıdır; obje adları bu yüzden ASCII'ye çevrilir.
 */
import { agOlustur } from './ortak/ag.js';
import { asciiAd, merkezMetni, objeAdiHam, objelereGrupla, sayiMetni } from './obj.js';
import { onizlemeKisalt } from './wkb.js';

/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {{ ascii?: boolean, crs?: string }} [secenekler]
 * @returns {Promise<{veri: string | Uint8Array, onizleme: string, uyarilar: string[]}>}
 */
export async function plyYaz(fc, secenekler = {}) {
  const s = secenekler || {};
  const asciiMi = s.ascii === true;
  const ag = agOlustur(fc, { merkezle: true });
  const uyarilar = [...ag.uyarilar];

  const koseler = []; // düz [x,y,z,…]
  const yuzler = []; // [a, b, c, obje]
  const kenarlar = []; // [v1, v2, obje]
  for (const p of ag.parcalar) {
    const taban = koseler.length / 3;
    for (const v of p.konumlar) koseler.push(v); // spread büyük dizilerde yığın taşırır
    if (p.tip === 'yuzey') {
      for (let i = 0; i < p.indeksler.length; i += 3) {
        yuzler.push([p.indeksler[i] + taban, p.indeksler[i + 1] + taban, p.indeksler[i + 2] + taban, p.objeIndeks]);
      }
    } else if (p.tip === 'cizgi') {
      const adet = p.konumlar.length / 3;
      for (let i = 0; i + 1 < adet; i++) kenarlar.push([taban + i, taban + i + 1, p.objeIndeks]);
    }
  }
  const nKose = koseler.length / 3;
  if (!nKose) uyarilar.push('Yazılacak 3B geometri yok; PLY dosyası boş.');

  const baslik = [
    'ply',
    `format ${asciiMi ? 'ascii' : 'binary_little_endian'} 1.0`,
    'comment GeoConverterProEA',
    'comment eksen X=dogu Y=kuzey Z=yukari',
    `comment merkez ${merkezMetni(ag.merkez)}`,
    'comment mutlak koordinat = dosyadaki koordinat + merkez',
  ];
  if (s.crs) baslik.push(`comment crs ${asciiAd(s.crs)}`);
  for (const g of objelereGrupla(ag.parcalar)) {
    baslik.push(`comment obje ${g.objeIndeks} ${asciiAd(objeAdiHam(g.ozellikler, g.objeIndeks)) || '-'}`);
  }
  baslik.push(
    `element vertex ${nKose}`,
    'property double x',
    'property double y',
    'property double z',
    `element face ${yuzler.length}`,
    'property list uchar int vertex_indices',
    'property int obje',
  );
  if (kenarlar.length) {
    baslik.push(`element edge ${kenarlar.length}`, 'property int vertex1', 'property int vertex2', 'property int obje');
  }
  baslik.push('end_header');

  const ozet = `${nKose} köşe, ${yuzler.length} yüz, ${kenarlar.length} kenar`;

  if (asciiMi) {
    const govde = [];
    for (let i = 0; i < koseler.length; i += 3) govde.push(`${sayiMetni(koseler[i])} ${sayiMetni(koseler[i + 1])} ${sayiMetni(koseler[i + 2])}`);
    for (const [a, b, c, o] of yuzler) govde.push(`3 ${a} ${b} ${c} ${o}`);
    for (const [a, b, o] of kenarlar) govde.push(`${a} ${b} ${o}`);
    const satirlar = [...baslik, ...govde];
    return { veri: `${satirlar.join('\n')}\n`, onizleme: onizlemeKisalt(satirlar), uyarilar };
  }

  const basMetin = `${baslik.join('\n')}\n`;
  const basBayt = new TextEncoder().encode(basMetin);
  const bayt = new Uint8Array(basBayt.length + nKose * 24 + yuzler.length * 17 + kenarlar.length * 12);
  bayt.set(basBayt, 0);
  const dv = new DataView(bayt.buffer);
  let o = basBayt.length;
  for (const v of koseler) {
    dv.setFloat64(o, v, true);
    o += 8;
  }
  for (const [a, b, c, obje] of yuzler) {
    dv.setUint8(o++, 3);
    for (const x of [a, b, c, obje]) {
      dv.setInt32(o, x, true);
      o += 4;
    }
  }
  for (const k of kenarlar) {
    for (const x of k) {
      dv.setInt32(o, x, true);
      o += 4;
    }
  }
  return { veri: bayt, onizleme: `${basMetin}(ikili gövde: ${ozet}; ${bayt.length} bayt)`, uyarilar };
}
