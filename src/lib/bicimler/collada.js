// COLLADA 1.4.1 (.dae) yazıcısı + 3B sahne yazıcılarının (x3d, vrml, usd, maya, rhino) ortak yardımcıları.
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
// Geometri ortak/ag.js → agOlustur ile hazırlanır (CCW üçgenler, Z-yukarı, `merkez` ötelemesi).
import { agOlustur } from './ortak/ag.js';
import { xmlKacis } from '../yazicilar.js';

// ===========================================================================
// Ortak yardımcılar (sahne yazıcıları)
// ===========================================================================

const TURKCE_ASCII = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' };

/**
 * Metni ASCII tanımlayıcıya çevirir: Türkçe harfler → ASCII, diğer aksanlar sökülür,
 * [A-Za-z0-9_] dışı karakterler '_' olur, rakamla başlayamaz, boşsa `yedek`.
 */
export function asciiAd(metin, yedek = 'Obje') {
  let s = String(metin ?? '')
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (h) => TURKCE_ASCII[h])
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!s) s = yedek;
  if (/^[0-9]/.test(s)) s = `_${s}`;
  return s;
}

/**
 * Benzersiz ad üretici. `ayrilmis`: kullanılamayacak adlar (format anahtar sözcükleri).
 * Karşılaştırma büyük/küçük harfe duyarsızdır (Windows/Maya/USD araçlarında güvenli taraf).
 */
export function adUretici(ayrilmis = []) {
  const kullanilan = new Set([...ayrilmis].map((a) => a.toLowerCase()));
  return (istenen, yedek = 'Obje') => {
    const temel = asciiAd(istenen, yedek);
    let ad = temel;
    for (let n = 2; kullanilan.has(ad.toLowerCase()); n++) ad = `${temel}_${n}`;
    kullanilan.add(ad.toLowerCase());
    return ad;
  };
}

/** Objenin görünen adı: name/ad/adi/Name/NAME özniteliği ya da "Obje N". */
export function objeAdi(ozellikler, objeIndeks) {
  const p = ozellikler || {};
  const ad = p.name ?? p.ad ?? p.adi ?? p.Name ?? p.NAME ?? p.AD;
  return ad !== undefined && ad !== null && String(ad).trim() !== '' ? String(ad) : `Obje ${objeIndeks + 1}`;
}

/** Öznitelik değerini metne çevirir (null → ''). */
export function degerMetni(deger) {
  if (deger === null || deger === undefined) return '';
  if (typeof deger === 'object') return JSON.stringify(deger);
  return String(deger);
}

/** Sayıyı dosyaya yazar (-0 → 0, tam hassasiyet). */
export const sayi = (v) => (Object.is(v, -0) ? '0' : String(v));

const FLOAT32_TAM_SINIR = 2 ** 24; // float32 bu değerin altındaki tüm tam sayıları tam temsil eder

/**
 * Merkezi float32 (SFVec3f vb.) alanlara kayıpsız yazmak için iki parçaya böler:
 * kaba = her bileşen tam sayı metre (|v| ≥ 2^24 ise float32'de tam temsil edilen 2'nin katına yuvarlanır),
 * ince = v − kaba (|ince| ≤ 0,5 m, ya da büyük değerlerde adımın yarısı). kaba + ince = v (double'da tam).
 * İki parça ayrı ayrı float32'ye indirildiğinde toplam gerçek merkezi mikrometre düzeyinde verir.
 */
export function merkeziBol(merkez) {
  const kaba = merkez.map((v) => {
    let adim = 1;
    while (Math.abs(v) / adim >= FLOAT32_TAM_SINIR) adim *= 2;
    const k = Math.round(v / adim) * adim;
    return Object.is(k, -0) ? 0 : k;
  });
  const ince = merkez.map((v, i) => {
    const d = v - kaba[i];
    return Object.is(d, -0) ? 0 : d;
  });
  return { kaba, ince };
}

/** Aileye (yüzey/çizgi/nokta) göre renk, 0–1 RGB. */
export const AILE_RENKLERI = Object.freeze({
  yuzey: Object.freeze([0.84, 0.2, 0.42]),
  cizgi: Object.freeze([0.1, 0.45, 0.85]),
  nokta: Object.freeze([0.95, 0.6, 0.1]),
});

/** Düz konum dizisinin [min, max] sınır kutusu. */
export function sinirKutusu(konumlar) {
  if (!konumlar.length) return [[0, 0, 0], [0, 0, 0]];
  const min = konumlar.slice(0, 3);
  const max = konumlar.slice(0, 3);
  for (let i = 3; i < konumlar.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      if (konumlar[i + e] < min[e]) min[e] = konumlar[i + e];
      if (konumlar[i + e] > max[e]) max[e] = konumlar[i + e];
    }
  }
  return [min, max];
}

/** Üçgenin birim normali (sağ el kuralı, CCW → +Z). Sıfır alanlıysa (0,0,1). */
export function ucgenNormali(k, a, b, c) {
  const ux = k[b * 3] - k[a * 3];
  const uy = k[b * 3 + 1] - k[a * 3 + 1];
  const uz = k[b * 3 + 2] - k[a * 3 + 2];
  const vx = k[c * 3] - k[a * 3];
  const vy = k[c * 3 + 1] - k[a * 3 + 1];
  const vz = k[c * 3 + 2] - k[a * 3 + 2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const u = Math.hypot(n[0], n[1], n[2]);
  return u > 0 ? n.map((v) => v / u) : [0, 0, 1];
}

/**
 * agOlustur sonucunu obje başına gruplar (obje sırası korunur):
 * { objeIndeks, ozellikler, ad, yuzey: { konumlar, indeksler } | null, cizgiler: number[][], noktalar: number[] }
 * Bir objenin tüm poligon parçaları tek ağda birleştirilir (indeksler ötelenir).
 */
export function objeleriGrupla(ag) {
  const harita = new Map();
  for (const p of ag.parcalar) {
    let g = harita.get(p.objeIndeks);
    if (!g) {
      g = { objeIndeks: p.objeIndeks, ozellikler: p.ozellikler, ad: objeAdi(p.ozellikler, p.objeIndeks), yuzey: null, cizgiler: [], noktalar: [] };
      harita.set(p.objeIndeks, g);
    }
    if (p.tip === 'yuzey') {
      if (!g.yuzey) g.yuzey = { konumlar: [], indeksler: [] };
      const oteleme = g.yuzey.konumlar.length / 3;
      g.yuzey.konumlar.push(...p.konumlar);
      for (const i of p.indeksler) g.yuzey.indeksler.push(i + oteleme);
    } else if (p.tip === 'cizgi') {
      g.cizgiler.push(p.konumlar);
    } else {
      g.noktalar.push(...p.konumlar);
    }
  }
  return [...harita.values()].sort((a, b) => a.objeIndeks - b.objeIndeks);
}

/** agOlustur + gruplama + boş veri uyarısı (tüm sahne yazıcıları için ortak giriş). */
export function sahneHazirla(fc) {
  const ag = agOlustur(fc);
  const objeler = objeleriGrupla(ag);
  const uyarilar = [...ag.uyarilar];
  if (!objeler.length) uyarilar.push('Yazılacak geometri bulunamadı; boş bir sahne üretildi.');
  return { ag, objeler, uyarilar, merkez: ag.merkez };
}

// ===========================================================================
// COLLADA 1.4.1
// ===========================================================================

const liste = (dizi) => dizi.map(sayi).join(' ');

function kaynakXml(id, konumlar) {
  const n = konumlar.length;
  return (
    `<source id="${id}-konum"><float_array id="${id}-konum-dizi" count="${n}">${liste(konumlar)}</float_array>` +
    `<technique_common><accessor source="#${id}-konum-dizi" count="${n / 3}" stride="3">` +
    '<param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>' +
    '</accessor></technique_common></source>' +
    `<vertices id="${id}-kose"><input semantic="POSITION" source="#${id}-konum"/></vertices>`
  );
}

function ozellikExtra(ozellikler) {
  const anahtarlar = Object.keys(ozellikler || {});
  if (!anahtarlar.length) return '';
  const satirlar = anahtarlar.map(
    (k) => `<ozellik ad="${xmlKacis(k)}">${xmlKacis(degerMetni(ozellikler[k]))}</ozellik>`,
  );
  return `<extra><technique profile="GeoConverterProEA">${satirlar.join('')}</technique></extra>`;
}

/**
 * GeoJSON FeatureCollection → COLLADA 1.4.1 (Z_UP, metre).
 * Her obje bir <node>; yüzeyler <triangles>, çizgiler <linestrips>, noktalar boş alt düğüm
 * (COLLADA'da nokta ilkeli yoktur). Kök düğümde <translate> = merkez.
 */
export async function colladaYaz(fc, secenekler = {}) {
  const { objeler, uyarilar, merkez } = sahneHazirla(fc);
  const ad = adUretici(['Sahne', 'Kok']);
  const tarih = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const geometriler = [];
  const dugumler = [];
  let noktaSayisi = 0;

  for (const o of objeler) {
    const id = ad(o.ad);
    const ic = [];
    const malzemeler = [];
    if (o.yuzey || o.cizgiler.length) {
      const parcalar = [];
      if (o.yuzey) {
        parcalar.push(kaynakXml(`${id}-yuzey`, o.yuzey.konumlar));
      }
      // Çizgilerin tümü tek kaynakta; her <p> bir çizgi.
      const cizgiKonum = [];
      const cizgiP = [];
      for (const c of o.cizgiler) {
        const bas = cizgiKonum.length / 3;
        cizgiKonum.push(...c);
        cizgiP.push(Array.from({ length: c.length / 3 }, (_, i) => bas + i).join(' '));
      }
      if (o.cizgiler.length) parcalar.push(kaynakXml(`${id}-cizgi`, cizgiKonum));
      if (o.yuzey) {
        parcalar.push(
          `<triangles material="yuzey" count="${o.yuzey.indeksler.length / 3}"><input semantic="VERTEX" source="#${id}-yuzey-kose" offset="0"/><p>${o.yuzey.indeksler.join(' ')}</p></triangles>`,
        );
        malzemeler.push('yuzey');
      }
      if (o.cizgiler.length) {
        parcalar.push(
          `<linestrips material="cizgi" count="${cizgiP.length}"><input semantic="VERTEX" source="#${id}-cizgi-kose" offset="0"/>${cizgiP.map((p) => `<p>${p}</p>`).join('')}</linestrips>`,
        );
        malzemeler.push('cizgi');
      }
      // COLLADA: <mesh> içinde önce tüm <source>/<vertices>, sonra ilkeller.
      const kaynaklar = parcalar.filter((p) => p.startsWith('<source'));
      const ilkeller = parcalar.filter((p) => !p.startsWith('<source'));
      geometriler.push(
        `<geometry id="${id}-geo" name="${xmlKacis(o.ad)}"><mesh>${kaynaklar.join('')}${ilkeller.join('')}</mesh></geometry>`,
      );
      ic.push(
        `<instance_geometry url="#${id}-geo"><bind_material><technique_common>${malzemeler
          .map((m) => `<instance_material symbol="${m}" target="#malzeme-${m}"/>`)
          .join('')}</technique_common></bind_material></instance_geometry>`,
      );
    }
    for (let i = 0; i < o.noktalar.length; i += 3) {
      noktaSayisi++;
      ic.push(`<node id="${id}-nokta${i / 3 + 1}" name="${xmlKacis(`${o.ad} nokta ${i / 3 + 1}`)}"><translate>${liste(o.noktalar.slice(i, i + 3))}</translate></node>`);
    }
    dugumler.push(`<node id="${id}" name="${xmlKacis(o.ad)}" type="NODE">${ic.join('')}${ozellikExtra(o.ozellikler)}</node>`);
  }
  if (noktaSayisi) uyarilar.push(`COLLADA'da nokta ilkeli olmadığı için ${noktaSayisi} nokta boş düğüm (konumlu) olarak yazıldı.`);

  const efektler = Object.entries(AILE_RENKLERI)
    .map(
      ([aile, [r, g, b]]) =>
        `<effect id="efekt-${aile}"><profile_COMMON><technique sid="common"><lambert><diffuse><color sid="diffuse">${r} ${g} ${b} 1</color></diffuse></lambert></technique></profile_COMMON></effect>`,
    )
    .join('\n');
  const malzemeler = Object.keys(AILE_RENKLERI)
    .map((aile) => `<material id="malzeme-${aile}" name="${aile}"><instance_effect url="#efekt-${aile}"/></material>`)
    .join('\n');

  const crs = secenekler.crs ? xmlKacis(String(secenekler.crs)) : '';
  const merkezParca = merkeziBol(merkez);
  const veri = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">',
    '<asset>',
    `<contributor><authoring_tool>GeoConverterProEA</authoring_tool>${crs ? `<comments>CRS: ${crs}; merkez: ${liste(merkez)}</comments>` : `<comments>merkez: ${liste(merkez)}</comments>`}</contributor>`,
    `<created>${tarih}</created><modified>${tarih}</modified>`,
    '<unit name="meter" meter="1"/>',
    '<up_axis>Z_UP</up_axis>',
    '</asset>',
    `<library_effects>\n${efektler}\n</library_effects>`,
    `<library_materials>\n${malzemeler}\n</library_materials>`,
    // Şema: library_geometries en az bir <geometry> ister; boşsa hiç yazılmaz.
    ...(geometriler.length ? [`<library_geometries>\n${geometriler.join('\n')}\n</library_geometries>`] : []),
    '<library_visual_scenes>',
    '<visual_scene id="Sahne" name="Sahne">',
    // Birçok içe aktarıcı <translate>'i float32 okur; merkez kaba (tam metre) + ince (kesir) olarak bölünür.
    `<node id="Kok" name="GeoConverterProEA" type="NODE"><translate sid="translate">${liste(merkezParca.kaba)}</translate><translate sid="translate_ince">${liste(merkezParca.ince)}</translate>`,
    ...dugumler,
    '</node>',
    '</visual_scene>',
    '</library_visual_scenes>',
    '<scene><instance_visual_scene url="#Sahne"/></scene>',
    '</COLLADA>',
    '',
  ].join('\n');
  return { veri, onizleme: veri, uyarilar };
}
