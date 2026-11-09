// XYZ nokta bulutu yazıcısı: tüm geometrilerin tüm köşe noktaları "X Y Z" satırları olarak.
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
import { geometriKonumlariniGez } from '../geometri.js';

export const XYZ_AYRACLARI = Object.freeze([' ', ',', '\t']);
const ONIZLEME_SATIR = 1000;

/**
 * Sayıyı tam hassasiyetle, nokta ondalıklı ve üstel gösterimsiz yazar
 * (ör. 1e-7 → "0.0000001", 1e21 → "1000000000000000000000"). -0 → "0".
 */
export function sayiMetni(sayi) {
  if (Object.is(sayi, -0)) return '0';
  const metin = String(sayi);
  const eslesme = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(metin);
  if (!eslesme) return metin;
  const [, isaret, tam, kesir = '', usMetni] = eslesme;
  const us = Number(usMetni);
  const rakamlar = tam + kesir;
  const noktaYeri = tam.length + us;
  let sonuc;
  if (noktaYeri <= 0) sonuc = `0.${'0'.repeat(-noktaYeri)}${rakamlar}`;
  else if (noktaYeri >= rakamlar.length) sonuc = rakamlar + '0'.repeat(noktaYeri - rakamlar.length);
  else sonuc = `${rakamlar.slice(0, noktaYeri)}.${rakamlar.slice(noktaYeri)}`;
  return isaret + sonuc;
}

const ayniNokta = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Geometriyi "parça" (halka/çizgi/nokta grubu) listesine ayırır; halka bilgisini korur. */
function parcalar(geometri, cikti) {
  if (geometri == null) return cikti;
  const k = geometri.coordinates;
  switch (geometri.type) {
    case 'Point':
      cikti.push({ konumlar: [k], halka: false });
      break;
    case 'MultiPoint':
    case 'LineString':
      cikti.push({ konumlar: k, halka: false });
      break;
    case 'MultiLineString':
      for (const c of k) cikti.push({ konumlar: c, halka: false });
      break;
    case 'Polygon':
      for (const c of k) cikti.push({ konumlar: c, halka: true });
      break;
    case 'MultiPolygon':
      for (const p of k) for (const c of p) cikti.push({ konumlar: c, halka: true });
      break;
    case 'GeometryCollection':
      for (const g of geometri.geometries || []) parcalar(g, cikti);
      break;
    default:
      throw new Error(`Desteklenmeyen geometri tipi: "${geometri.type}".`);
  }
  return cikti;
}

/**
 * GeoJSON FeatureCollection → XYZ metni.
 * secenekler.ayrac: ' ' (varsayılan), ',' veya '\t'.
 * secenekler.yinelenenleriAt: true (varsayılan) → poligon halkasının kapanış noktası ve
 *   ardışık aynı noktalar tekrar yazılmaz.
 */
export async function xyzYaz(fc, secenekler = {}) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.');
  }
  const ayrac = secenekler.ayrac ?? ' ';
  if (!XYZ_AYRACLARI.includes(ayrac)) {
    throw new Error('XYZ ayracı boşluk, virgül veya sekme (\\t) olmalıdır.');
  }
  const yinelenenleriAt = secenekler.yinelenenleriAt !== false;
  const uyarilar = [];
  let zEksik = 0;
  let gecersiz = 0;
  const satirlar = [];
  let onceki = null;

  const yaz = (konum) => {
    if (!Array.isArray(konum) || !Number.isFinite(konum[0]) || !Number.isFinite(konum[1])) {
      gecersiz++;
      return;
    }
    let z = konum[2];
    if (!Number.isFinite(z)) {
      zEksik++;
      z = 0;
    }
    const nokta = [konum[0], konum[1], z];
    if (yinelenenleriAt && ayniNokta(nokta, onceki)) return;
    onceki = nokta;
    satirlar.push(nokta.map(sayiMetni).join(ayrac));
  };

  for (const f of fc.features) {
    const g = f && typeof f === 'object' ? f.geometry : null;
    if (g == null || typeof g !== 'object') continue;
    // Tip ve yapı doğrulaması (geçersiz tipte Türkçe hata fırlatır).
    geometriKonumlariniGez(g, () => {});
    for (const { konumlar, halka } of parcalar(g, [])) {
      let liste = konumlar;
      if (yinelenenleriAt && halka && liste.length > 1) {
        const ilk = liste[0];
        const son = liste[liste.length - 1];
        if (Array.isArray(ilk) && Array.isArray(son) && ilk[0] === son[0] && ilk[1] === son[1] && (ilk[2] ?? 0) === (son[2] ?? 0)) {
          liste = liste.slice(0, -1);
        }
      }
      for (const konum of liste) yaz(konum);
    }
  }

  if (zEksik > 0) uyarilar.push(`${zEksik} noktada Z (yükseklik) değeri yoktu; Z = 0 yazıldı.`);
  if (gecersiz > 0) uyarilar.push(`${gecersiz} nokta sayısal olmayan X/Y değeri nedeniyle atlandı.`);
  if (satirlar.length === 0) uyarilar.push('Yazılacak nokta bulunamadı; XYZ dosyası boş.');

  const veri = satirlar.length ? `${satirlar.join('\n')}\n` : '';
  let onizleme = satirlar.slice(0, ONIZLEME_SATIR).join('\n');
  if (satirlar.length > ONIZLEME_SATIR) {
    onizleme += `\n… ${satirlar.length - ONIZLEME_SATIR} satır daha`;
  }
  return { veri, onizleme, uyarilar };
}
