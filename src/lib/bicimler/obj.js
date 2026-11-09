/**
 * Wavefront OBJ yazıcısı (`.obj`) ve 3B ağ yazıcılarının (obj, stl, ply, gltf, uc_ds) ortak küçük yardımcıları.
 *
 * Saf JavaScript: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
 * Geometri `ortak/ag.js` → `agOlustur(fc)` ile hazırlanır (üçgenleme, CCW, Z-yukarı, merkez ötelemesi).
 *
 * Çıktı yapısı:
 *   # başlık yorumları (eksen, merkez ötelemesi, sayaçlar)
 *   vn 0 0 1                      tek yukarı normal (tüm yüzeyler yataya yakın; üçgenler CCW → +Z)
 *   o <Obje_adi>                  her GeoJSON objesi için bir OBJ nesnesi (ad ASCII'ye temizlenir)
 *   g <katman>                    yalnızca katman/layer/tabaka özniteliği varsa
 *   # ozellik: anahtar = değer    öznitelikler yorum olarak (OBJ'de öznitelik kavramı yok)
 *   v x y z …                     köşeler (merkeze göre; `mutlak: true` ise mutlak koordinat)
 *   f a//1 b//1 c//1              üçgenler (1 tabanlı, dosya genelinde sürekli indeks)
 *   l a b c …                     çizgiler
 *   p a                           noktalar
 *
 * Sayılar `String(sayi)` ile yazılır: yerel ayardan bağımsız ('.' ondalık), float64'ü birebir geri
 * veren en kısa gösterim (tam hassasiyet).
 *
 * Merkez ötelemesi: projeksiyonlu koordinatlar (ör. 500000, 4400000) çoğu 3B yazılımda float32'ye
 * düşürülür ve santimetre hassasiyeti kaybolur. Varsayılan olarak köşeler merkeze göre yazılır ve
 * merkez başlıkta belgelenir (mutlak = yerel + merkez). `secenekler.mutlak === true` ise öteleme
 * yapılmaz, gerçek koordinatlar yazılır.
 */
import { agOlustur } from './ortak/ag.js';
import { onizlemeKisalt } from './wkb.js';

// ---------------------------------------------------------------- Ortak yardımcılar

const TURKCE_ASCII = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' };

/**
 * Adı yalnızca [A-Za-z0-9_.-] içeren ASCII'ye çevirir: Türkçe harfler ve diğer aksanlı harfler
 * karşılıklarına, boşluk ve özel karakterler '_' olur. `enFazla` verilirse o uzunluğa kırpılır.
 * Boş kalırsa ''.
 */
export function asciiAd(metin, enFazla = Infinity) {
  const s = String(metin ?? '')
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (h) => TURKCE_ASCII[h])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s.slice(0, enFazla);
}

/** Obje adı: name / ad / Name / NAME / isim özniteliği, yoksa "Obje N" (N = 1 tabanlı sıra). */
export function objeAdiHam(ozellikler, objeIndeks) {
  for (const k of ['name', 'ad', 'Name', 'NAME', 'isim', 'Ad']) {
    const v = ozellikler?.[k];
    if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return `Obje ${objeIndeks + 1}`;
}

/** agOlustur parçalarını obje sırasıyla gruplar: [{ objeIndeks, ozellikler, parcalar }]. */
export function objelereGrupla(parcalar) {
  const gruplar = new Map();
  for (const p of parcalar) {
    let g = gruplar.get(p.objeIndeks);
    if (!g) {
      g = { objeIndeks: p.objeIndeks, ozellikler: p.ozellikler, parcalar: [] };
      gruplar.set(p.objeIndeks, g);
    }
    g.parcalar.push(p);
  }
  return [...gruplar.values()];
}

/** Yerel ayarsız, tam hassasiyetli sayı metni (-0 → 0). */
export function sayiMetni(n) {
  return Object.is(n, -0) ? '0' : String(n);
}

/** Tek satırlık, kontrol karakteri içermeyen metin (yorum/başlık satırları için). */
export function tekSatir(metin) {
  // eslint-disable-next-line no-control-regex
  return String(metin ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
}

/** Öznitelik değerini metne çevirir (nesneler JSON, BigInt metin). */
export function degerMetni(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** Aynı adı ikinci kez görürse _2, _3 … son eki ekleyen üreteç (büyük/küçük harf duyarsız). */
export function benzersizAdUretici(enFazla = Infinity) {
  const kullanilan = new Set();
  return (ad) => {
    let aday = ad.slice(0, enFazla);
    for (let n = 2; kullanilan.has(aday.toLowerCase()); n++) {
      const ek = `_${n}`;
      aday = ad.slice(0, Math.max(0, enFazla - ek.length)) + ek;
    }
    kullanilan.add(aday.toLowerCase());
    return aday;
  };
}

export const merkezMetni = (m) => m.map(sayiMetni).join(' ');

// ---------------------------------------------------------------- OBJ

const KATMAN_ANAHTARLARI = ['katman', 'Katman', 'KATMAN', 'layer', 'Layer', 'LAYER', 'tabaka'];

/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {{ mutlak?: boolean, crs?: string }} [secenekler]
 * @returns {Promise<{veri: string, onizleme: string, uyarilar: string[]}>}
 */
export async function objYaz(fc, secenekler = {}) {
  const s = secenekler || {};
  const mutlak = s.mutlak === true;
  const ag = agOlustur(fc, { merkezle: !mutlak });
  const uyarilar = [...ag.uyarilar];
  const gruplar = objelereGrupla(ag.parcalar);
  const benzersiz = benzersizAdUretici();

  const satirlar = [
    '# GeoConverterProEA — Wavefront OBJ',
    '# Eksen: X = doğu, Y = kuzey, Z = yukarı (Z-up). İçe aktarırken "Z yukarı" seçin.',
  ];
  if (s.crs) satirlar.push(`# Koordinat sistemi: ${tekSatir(s.crs)}`);
  if (mutlak) {
    satirlar.push('# Koordinatlar mutlaktır (merkez ötelemesi uygulanmadı).');
  } else {
    satirlar.push(`# Merkez ötelemesi: ${merkezMetni(ag.merkez)}`);
    satirlar.push('# Mutlak koordinat = dosyadaki koordinat + merkez ötelemesi.');
  }
  satirlar.push(
    `# Obje: ${gruplar.length} | Üçgen: ${ag.sayac.ucgen} | Çizgi: ${ag.sayac.cizgi} | Nokta: ${ag.sayac.nokta} | Köşe: ${ag.sayac.kose}`,
  );
  if (ag.sayac.ucgen) satirlar.push('vn 0 0 1');

  let tabanIndeks = 1; // OBJ indeksleri 1 tabanlı ve dosya geneli
  let sonKatman = null;
  for (const g of gruplar) {
    const ad = benzersiz(asciiAd(objeAdiHam(g.ozellikler, g.objeIndeks)) || `Obje_${g.objeIndeks + 1}`);
    satirlar.push('', `o ${ad}`);
    const katmanAnahtari = KATMAN_ANAHTARLARI.find((k) => g.ozellikler[k] !== null && g.ozellikler[k] !== undefined && String(g.ozellikler[k]).trim() !== '');
    if (katmanAnahtari) {
      const katman = asciiAd(g.ozellikler[katmanAnahtari]) || 'katman';
      if (katman !== sonKatman) satirlar.push(`g ${katman}`);
      sonKatman = katman;
    }
    for (const [k, v] of Object.entries(g.ozellikler)) {
      satirlar.push(`# ozellik: ${tekSatir(k)} = ${tekSatir(degerMetni(v))}`);
    }
    for (const p of g.parcalar) {
      const k = p.konumlar;
      for (let i = 0; i < k.length; i += 3) {
        satirlar.push(`v ${sayiMetni(k[i])} ${sayiMetni(k[i + 1])} ${sayiMetni(k[i + 2])}`);
      }
      const adet = k.length / 3;
      if (p.tip === 'yuzey') {
        const ix = p.indeksler;
        for (let i = 0; i < ix.length; i += 3) {
          satirlar.push(`f ${ix[i] + tabanIndeks}//1 ${ix[i + 1] + tabanIndeks}//1 ${ix[i + 2] + tabanIndeks}//1`);
        }
      } else if (p.tip === 'cizgi') {
        satirlar.push(`l ${Array.from({ length: adet }, (_, i) => i + tabanIndeks).join(' ')}`);
      } else {
        satirlar.push(`p ${tabanIndeks}`);
      }
      tabanIndeks += adet;
    }
  }
  if (!gruplar.length) uyarilar.push('Yazılacak 3B geometri yok; OBJ dosyası yalnızca başlık içeriyor.');

  const veri = `${satirlar.join('\n')}\n`;
  return { veri, onizleme: onizlemeKisalt(satirlar), uyarilar };
}
