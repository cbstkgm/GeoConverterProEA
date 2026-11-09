// USD yazıcıları: usdYaz → USDA 1.0 metin (.usd uzantısı ASCII içerik kabul eder), usdzYaz → USDZ paketi.
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
// upAxis = "Z" sahne meta verisiyle bildirilir (USD Z-yukarıyı doğrudan destekler; koordinat dönüşümü yok).
// Kök Xform'un xformOp:translate değeri = merkez (double3, tam hassasiyet).
import { AILE_RENKLERI, adUretici, degerMetni, sahneHazirla, sayi, sinirKutusu, ucgenNormali } from './collada.js';

/** USDA dize sabiti: \ " ve satır sonları kaçışlı. */
export function usdDize(metin) {
  return `"${String(metin)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')}"`;
}

const ucluler = (konumlar) => {
  const parca = [];
  for (let i = 0; i < konumlar.length; i += 3) parca.push(`(${sayi(konumlar[i])}, ${sayi(konumlar[i + 1])}, ${sayi(konumlar[i + 2])})`);
  return `[${parca.join(', ')}]`;
};

const renk = (r) => `[(${r.join(', ')})]`;

function extent(konumlar, pay = 0) {
  const [min, max] = sinirKutusu(konumlar);
  return ucluler([...min.map((v) => v - pay), ...max.map((v) => v + pay)]);
}

function customData(ozellikler, girinti) {
  const anahtarlar = Object.keys(ozellikler || {});
  if (!anahtarlar.length) return '';
  const satirlar = anahtarlar.map((k) => {
    const v = ozellikler[k];
    if (typeof v === 'number' && Number.isFinite(v)) return `${girinti}        double ${usdDize(k)} = ${sayi(v)}`;
    if (typeof v === 'boolean') return `${girinti}        bool ${usdDize(k)} = ${v ? 1 : 0}`;
    return `${girinti}        string ${usdDize(k)} = ${usdDize(degerMetni(v))}`;
  });
  return ` (\n${girinti}    customData = {\n${satirlar.join('\n')}\n${girinti}    }\n${girinti})`;
}

const CIZGI_GENISLIGI = 0.1;
const NOKTA_GENISLIGI = 0.5;

/** USDA metnini üretir (usdYaz ve usdzYaz ortak). */
function usdaMetni(fc, secenekler) {
  const { objeler, uyarilar, merkez } = sahneHazirla(fc);
  const ad = adUretici(['Kok']);
  const g = '    ';
  const primler = objeler.map((o) => {
    const ic = [];
    if (o.yuzey) {
      const { konumlar, indeksler } = o.yuzey;
      const normaller = [];
      for (let i = 0; i < indeksler.length; i += 3) normaller.push(...ucgenNormali(konumlar, indeksler[i], indeksler[i + 1], indeksler[i + 2]));
      ic.push(
        [
          `${g}${g}def Mesh "yuzey"`,
          `${g}${g}{`,
          `${g}${g}${g}uniform bool doubleSided = 1`,
          `${g}${g}${g}float3[] extent = ${extent(konumlar)}`,
          `${g}${g}${g}int[] faceVertexCounts = [${new Array(indeksler.length / 3).fill(3).join(', ')}]`,
          `${g}${g}${g}int[] faceVertexIndices = [${indeksler.join(', ')}]`,
          `${g}${g}${g}normal3f[] normals = ${ucluler(normaller)} (`,
          `${g}${g}${g}${g}interpolation = "uniform"`,
          `${g}${g}${g})`,
          `${g}${g}${g}uniform token orientation = "rightHanded"`,
          `${g}${g}${g}point3f[] points = ${ucluler(konumlar)}`,
          `${g}${g}${g}color3f[] primvars:displayColor = ${renk(AILE_RENKLERI.yuzey)} (`,
          `${g}${g}${g}${g}interpolation = "constant"`,
          `${g}${g}${g})`,
          `${g}${g}${g}uniform token subdivisionScheme = "none"`,
          `${g}${g}}`,
        ].join('\n'),
      );
    }
    if (o.cizgiler.length) {
      const konumlar = o.cizgiler.flat();
      ic.push(
        [
          `${g}${g}def BasisCurves "cizgi"`,
          `${g}${g}{`,
          `${g}${g}${g}uniform token type = "linear"`,
          `${g}${g}${g}int[] curveVertexCounts = [${o.cizgiler.map((c) => c.length / 3).join(', ')}]`,
          `${g}${g}${g}float3[] extent = ${extent(konumlar, CIZGI_GENISLIGI / 2)}`,
          `${g}${g}${g}point3f[] points = ${ucluler(konumlar)}`,
          `${g}${g}${g}float[] widths = [${CIZGI_GENISLIGI}] (`,
          `${g}${g}${g}${g}interpolation = "constant"`,
          `${g}${g}${g})`,
          `${g}${g}${g}color3f[] primvars:displayColor = ${renk(AILE_RENKLERI.cizgi)} (`,
          `${g}${g}${g}${g}interpolation = "constant"`,
          `${g}${g}${g})`,
          `${g}${g}}`,
        ].join('\n'),
      );
    }
    if (o.noktalar.length) {
      ic.push(
        [
          `${g}${g}def Points "nokta"`,
          `${g}${g}{`,
          `${g}${g}${g}float3[] extent = ${extent(o.noktalar, NOKTA_GENISLIGI / 2)}`,
          `${g}${g}${g}point3f[] points = ${ucluler(o.noktalar)}`,
          `${g}${g}${g}float[] widths = [${NOKTA_GENISLIGI}] (`,
          `${g}${g}${g}${g}interpolation = "constant"`,
          `${g}${g}${g})`,
          `${g}${g}${g}color3f[] primvars:displayColor = ${renk(AILE_RENKLERI.nokta)} (`,
          `${g}${g}${g}${g}interpolation = "constant"`,
          `${g}${g}${g})`,
          `${g}${g}}`,
        ].join('\n'),
      );
    }
    return `${g}def Xform ${usdDize(ad(o.ad))}${customData(o.ozellikler, g)}\n${g}{\n${ic.join('\n\n')}\n${g}}`;
  });

  const katmanVerisi = [`${g}${g}double3 merkez = (${merkez.map(sayi).join(', ')})`];
  if (secenekler.crs) katmanVerisi.push(`${g}${g}string crs = ${usdDize(secenekler.crs)}`);
  const metin = [
    '#usda 1.0',
    '(',
    `${g}customLayerData = {`,
    ...katmanVerisi,
    `${g}}`,
    `${g}defaultPrim = "Kok"`,
    `${g}doc = "GeoConverterProEA"`,
    `${g}metersPerUnit = 1`,
    `${g}upAxis = "Z"`,
    ')',
    '',
    'def Xform "Kok" (',
    `${g}kind = "component"`,
    ')',
    '{',
    `${g}double3 xformOp:translate = (${merkez.map(sayi).join(', ')})`,
    `${g}uniform token[] xformOpOrder = ["xformOp:translate"]`,
    '',
    primler.join('\n\n'),
    '}',
    '',
  ].join('\n');
  return { metin, uyarilar };
}

/** GeoJSON FeatureCollection → USDA 1.0 metni. */
export async function usdYaz(fc, secenekler = {}) {
  const { metin, uyarilar } = usdaMetni(fc, secenekler);
  return { veri: metin, onizleme: metin, uyarilar };
}

// ---------------------------------------------------------------------------
// USDZ: sıkıştırılmamış (STORED) zip; her dosyanın verisi 64 bayt hizalı.
// JSZip veri hizalamasını desteklemediği için zip burada elle yazılır.
// ---------------------------------------------------------------------------

let crcTablosu = null;
/** CRC-32 (IEEE 802.3, zip). */
export function crc32(bayt) {
  if (!crcTablosu) {
    crcTablosu = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTablosu[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bayt.length; i++) crc = crcTablosu[(crc ^ bayt[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const USDZ_HIZALAMA = 64;
const DOLGU_KIMLIGI = 0x1986; // Pixar usdzip'in hizalama dolgusu için kullandığı extra alan kimliği.
const DOS_TARIH = (0 << 9) | (1 << 5) | 1; // 1980-01-01 (belirlenimci çıktı)
const DOS_SAAT = 0;

/**
 * Dosyaları USDZ kurallarına uygun zip'e yazar: sıkıştırma yok, veri başlangıcı 64'ün katı.
 * @param {{ ad: string, veri: Uint8Array }[]} dosyalar ilk dosya .usda/.usdc olmalı
 */
export function usdzPaketle(dosyalar) {
  const kodlayici = new TextEncoder();
  const parcalar = [];
  const merkezi = [];
  let ofset = 0;
  for (const d of dosyalar) {
    const ad = kodlayici.encode(d.ad);
    const crc = crc32(d.veri);
    let dolgu = (USDZ_HIZALAMA - ((ofset + 30 + ad.length) % USDZ_HIZALAMA)) % USDZ_HIZALAMA;
    if (dolgu > 0 && dolgu < 4) dolgu += USDZ_HIZALAMA; // extra alanı en az 4 baytlık başlık ister
    const yerel = new Uint8Array(30 + ad.length + dolgu);
    const v = new DataView(yerel.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true); // UTF-8 ad
    v.setUint16(8, 0, true); // STORED
    v.setUint16(10, DOS_SAAT, true);
    v.setUint16(12, DOS_TARIH, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, d.veri.length, true);
    v.setUint32(22, d.veri.length, true);
    v.setUint16(26, ad.length, true);
    v.setUint16(28, dolgu, true);
    yerel.set(ad, 30);
    if (dolgu) {
      v.setUint16(30 + ad.length, DOLGU_KIMLIGI, true);
      v.setUint16(32 + ad.length, dolgu - 4, true);
    }
    const yerelOfset = ofset;
    parcalar.push(yerel, d.veri);
    ofset += yerel.length + d.veri.length;

    const m = new Uint8Array(46 + ad.length);
    const mv = new DataView(m.buffer);
    mv.setUint32(0, 0x02014b50, true);
    mv.setUint16(4, 20, true);
    mv.setUint16(6, 20, true);
    mv.setUint16(8, 0x0800, true);
    mv.setUint16(10, 0, true);
    mv.setUint16(12, DOS_SAAT, true);
    mv.setUint16(14, DOS_TARIH, true);
    mv.setUint32(16, crc, true);
    mv.setUint32(20, d.veri.length, true);
    mv.setUint32(24, d.veri.length, true);
    mv.setUint16(28, ad.length, true);
    mv.setUint32(42, yerelOfset, true);
    m.set(ad, 46);
    merkezi.push(m);
  }
  const merkeziOfset = ofset;
  const merkeziBoyut = merkezi.reduce((t, m) => t + m.length, 0);
  const son = new Uint8Array(22);
  const sv = new DataView(son.buffer);
  sv.setUint32(0, 0x06054b50, true);
  sv.setUint16(8, dosyalar.length, true);
  sv.setUint16(10, dosyalar.length, true);
  sv.setUint32(12, merkeziBoyut, true);
  sv.setUint32(16, merkeziOfset, true);

  const tum = [...parcalar, ...merkezi, son];
  const cikti = new Uint8Array(tum.reduce((t, p) => t + p.length, 0));
  let i = 0;
  for (const p of tum) {
    cikti.set(p, i);
    i += p.length;
  }
  return cikti;
}

/** GeoJSON FeatureCollection → USDZ (içinde tek model.usda). */
export async function usdzYaz(fc, secenekler = {}) {
  const { metin, uyarilar } = usdaMetni(fc, secenekler);
  const veri = usdzPaketle([{ ad: 'model.usda', veri: new TextEncoder().encode(metin) }]);
  return { veri, onizleme: metin, uyarilar };
}
