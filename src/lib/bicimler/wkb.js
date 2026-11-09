/**
 * WKB (Well-Known Binary) kodlayıcısı ve `.wkb` yazıcısı.
 *
 * Saf JavaScript: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
 *
 * `geometriWkb` GeoJSON geometrisini bayt dizisine çevirir. İki çıktı kipi vardır:
 *
 *  1. ISO WKB (OGC SFA 1.2.1 / ISO 19125-1) — varsayılan.
 *       bayt sırası (1 bayt: 1 = little, 0 = big) | tip kodu (uint32) | gövde
 *       Tip kodları: Point 1, LineString 2, Polygon 3, MultiPoint 4, MultiLineString 5,
 *       MultiPolygon 6, GeometryCollection 7; Z boyutu için kod + 1000 (PointZ = 1001).
 *
 *  2. PostGIS EWKB — `ewkbSrid` verildiğinde.
 *       Tip kodunun üst bitleri bayrak: 0x80000000 = Z, 0x20000000 = SRID var.
 *       SRID (uint32) yalnızca en dıştaki geometride, tip kodundan hemen sonra yazılır;
 *       Multi* / GeometryCollection üyeleri SRID taşımaz ama Z bayrağını taşır (PostGIS ile aynı).
 *
 * Boyut kuralı: Bir geometride (üyeleri dahil) herhangi bir koordinat sonlu bir Z değeri taşıyorsa
 * geometrinin tamamı Z olarak yazılır ve Z'si eksik koordinatlara 0 konur — WKB, PostGIS ve GEOS
 * bir geometri içinde karışık boyuta izin vermez. `z: true/false` ile bu karar dışarıdan zorlanabilir
 * (ör. SQL yazıcısı tablo genelinde tek boyut ister). M boyutu GeoJSON'da olmadığından hiç yazılmaz.
 *
 * Boş geometriler: boş Point (coordinates: []) PostGIS/GEOS kuralına uygun olarak NaN koordinatlarla,
 * boş LineString/Polygon/Multi* sıfır öğe sayısıyla yazılır.
 */

const TIP_KODLARI = {
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
  GeometryCollection: 7,
};

const EWKB_Z = 0x80000000;
const EWKB_SRID = 0x20000000;

function hata(mesaj) {
  return new Error(mesaj);
}

/** Geometride sonlu Z değeri taşıyan en az bir koordinat var mı? (Üyeler dahil.) */
export function zVarMi(geometri) {
  if (!geometri || typeof geometri !== 'object') return false;
  if (geometri.type === 'GeometryCollection') return (geometri.geometries || []).some(zVarMi);
  const tara = (d) =>
    Array.isArray(d) && (typeof d[0] === 'number' ? d.length > 2 && Number.isFinite(d[2]) : d.some(tara));
  return tara(geometri.coordinates);
}

function konumDogrula(k) {
  if (!Array.isArray(k) || k.length < 2 || !Number.isFinite(k[0]) || !Number.isFinite(k[1])) {
    throw hata(`geçersiz koordinat: ${JSON.stringify(k)} (en az iki sonlu sayı bekleniyordu)`);
  }
}

function diziDogrula(d, aciklama) {
  if (!Array.isArray(d)) throw hata(`${aciklama} bir dizi olmalı`);
  return d;
}

/**
 * Bir geometrinin WKB bayt uzunluğunu hesaplar (yazmadan önce tek seferde tampon ayırmak için).
 * @param {object} g GeoJSON geometrisi
 * @param {number} kb koordinat başına bayt (16 veya 24)
 */
function uzunluk(g, kb) {
  const bas = 5; // bayt sırası + tip kodu
  const c = g.coordinates;
  switch (g.type) {
    case 'Point':
      return bas + kb;
    case 'LineString':
      return bas + 4 + diziDogrula(c, 'LineString koordinatları').length * kb;
    case 'Polygon':
      return bas + 4 + diziDogrula(c, 'Polygon koordinatları').reduce((t, h) => t + 4 + diziDogrula(h, 'halka').length * kb, 0);
    case 'MultiPoint':
      return bas + 4 + diziDogrula(c, 'MultiPoint koordinatları').length * (bas + kb);
    case 'MultiLineString':
      return bas + 4 + diziDogrula(c, 'MultiLineString koordinatları').reduce((t, p) => t + uzunluk({ type: 'LineString', coordinates: p }, kb), 0);
    case 'MultiPolygon':
      return bas + 4 + diziDogrula(c, 'MultiPolygon koordinatları').reduce((t, p) => t + uzunluk({ type: 'Polygon', coordinates: p }, kb), 0);
    case 'GeometryCollection':
      return bas + 4 + diziDogrula(g.geometries, 'GeometryCollection üyeleri').reduce((t, u) => t + uzunluk(u, kb), 0);
    default:
      throw hata(`WKB'ye çevrilemeyen geometri tipi: "${g?.type}"`);
  }
}

/**
 * GeoJSON geometrisini WKB baytlarına kodlar.
 *
 * @param {object} geometri GeoJSON geometrisi (Point … GeometryCollection)
 * @param {object} [secenekler]
 * @param {'little'|'big'} [secenekler.endian='little'] bayt sırası (NDR = little, XDR = big)
 * @param {number|null} [secenekler.ewkbSrid=null] verilirse PostGIS EWKB üretilir ve bu SRID gömülür
 * @param {boolean|null} [secenekler.z=null] null: otomatik (bkz. dosya başı); true/false: zorla
 * @returns {Uint8Array}
 * @throws {Error} desteklenmeyen tip veya geçersiz koordinatta, nedeni Türkçe mesajda
 *
 * @example
 *   geometriWkb({ type: 'Point', coordinates: [1, 2] })
 *   // → 01 01000000 000000000000F03F 0000000000000040
 */
export function geometriWkb(geometri, { endian = 'little', ewkbSrid = null, z = null } = {}) {
  if (!geometri || typeof geometri !== 'object' || typeof geometri.type !== 'string') {
    throw hata('WKB için geçerli bir GeoJSON geometrisi bekleniyordu');
  }
  if (endian !== 'little' && endian !== 'big') throw hata(`geçersiz bayt sırası: "${endian}" (little | big)`);
  const ewkb = ewkbSrid !== null && ewkbSrid !== undefined;
  if (ewkb && !(Number.isInteger(ewkbSrid) && ewkbSrid >= 0 && ewkbSrid <= 0xffffffff)) {
    throw hata(`geçersiz SRID: ${ewkbSrid}`);
  }

  const kz = z === null || z === undefined ? zVarMi(geometri) : Boolean(z);
  const kb = kz ? 24 : 16;
  const kucuk = endian === 'little';
  const toplam = uzunluk(geometri, kb) + (ewkb ? 4 : 0);
  const bayt = new Uint8Array(toplam);
  const dv = new DataView(bayt.buffer);
  let o = 0;

  const u32 = (n) => {
    dv.setUint32(o, n >>> 0, kucuk);
    o += 4;
  };
  const f64 = (n) => {
    dv.setFloat64(o, n, kucuk);
    o += 8;
  };
  const konum = (k) => {
    konumDogrula(k);
    f64(k[0]);
    f64(k[1]);
    if (kz) f64(k.length > 2 && Number.isFinite(k[2]) ? k[2] : 0);
  };
  const konumlar = (d) => {
    u32(d.length);
    d.forEach(konum);
  };
  const halkalar = (d) => {
    u32(d.length);
    d.forEach(konumlar);
  };

  function yaz(g, enDis) {
    const kod = TIP_KODLARI[g.type];
    bayt[o++] = kucuk ? 1 : 0;
    if (ewkb) {
      u32(kod | (kz ? EWKB_Z : 0) | (enDis ? EWKB_SRID : 0));
      if (enDis) u32(ewkbSrid);
    } else {
      u32(kod + (kz ? 1000 : 0));
    }
    const c = g.coordinates;
    switch (g.type) {
      case 'Point':
        if (Array.isArray(c) && c.length === 0) {
          // Boş nokta: tüm koordinatlar NaN (PostGIS / GEOS / OGR kuralı).
          f64(NaN);
          f64(NaN);
          if (kz) f64(NaN);
        } else konum(c);
        break;
      case 'LineString':
        konumlar(c);
        break;
      case 'Polygon':
        halkalar(c);
        break;
      case 'MultiPoint':
        u32(c.length);
        c.forEach((p) => yaz({ type: 'Point', coordinates: p }, false));
        break;
      case 'MultiLineString':
        u32(c.length);
        c.forEach((p) => yaz({ type: 'LineString', coordinates: p }, false));
        break;
      case 'MultiPolygon':
        u32(c.length);
        c.forEach((p) => yaz({ type: 'Polygon', coordinates: p }, false));
        break;
      case 'GeometryCollection':
        u32(g.geometries.length);
        g.geometries.forEach((u) => yaz(u, false));
        break;
    }
  }

  yaz(geometri, true);
  return bayt;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));

/** Baytları büyük harf onaltılık metne çevirir (PostGIS / OGR'nin hex WKB biçimi). */
export function hexe(bayt) {
  let s = '';
  for (let i = 0; i < bayt.length; i++) s += HEX[bayt[i]];
  return s;
}

/**
 * Hedef CRS'ten EPSG SRID'ini çıkarır: 'EPSG:5255', 'urn:ogc:def:crs:EPSG::5255' veya 5255 → 5255.
 * Çözülemezse null.
 */
export function sridCoz(crs) {
  if (crs === null || crs === undefined || crs === '') return null;
  if (Number.isInteger(crs) && crs > 0) return crs;
  const m = /EPSG:{1,2}(\d+)\s*$/i.exec(String(crs).trim());
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- Geometri tipi politikası
//
// Tek geometri sütunlu çıktılar (PostGIS typmod, GeoPackage gpkg_geometry_columns) için ortak kural:
//  - Tüm geometriler aynı tipteyse o tip.
//  - Aynı aileden tekil + çoklu karışıksa (ör. Polygon + MultiPolygon — kadastroda çok yaygın)
//    sütun çoklu tip olur; tekiller tek elemanlı Multi'ye yükseltilir.
//  - Yalnızca tek aileden parçalar içeren GeometryCollection o ailenin Multi'sine düzleştirilir.
//  - Gerçekten farklı aileler karışıksa 'Geometry' (hepsi karışık GeometryCollection ise
//    'GeometryCollection'); geometriler değiştirilmez.

const AILELER = {
  Point: ['Point', false],
  MultiPoint: ['Point', true],
  LineString: ['LineString', false],
  MultiLineString: ['LineString', true],
  Polygon: ['Polygon', false],
  MultiPolygon: ['Polygon', true],
};

/** GeometryCollection'ı (iç içe olanlar dahil) yaprak geometrilere açar. */
function yapraklar(g) {
  if (g?.type !== 'GeometryCollection') return [g];
  return (Array.isArray(g.geometries) ? g.geometries : []).filter(Boolean).flatMap(yapraklar);
}

/** { aile: 'Point'|'LineString'|'Polygon'|null, coklu, koleksiyon } */
function aileBilgisi(g) {
  if (g.type === 'GeometryCollection') {
    const aileler = new Set(yapraklar(g).map((y) => AILELER[y?.type]?.[0] ?? null));
    const tek = aileler.size === 1 && !aileler.has(null) ? [...aileler][0] : null;
    return { aile: tek, coklu: true, koleksiyon: true };
  }
  const [aile = null, coklu = false] = AILELER[g.type] || [];
  return { aile, coklu, koleksiyon: false };
}

/** Geometriyi verilen ailenin Multi tipine çevirir (tekil → tek elemanlı Multi, GC → düzleştirilmiş). */
export function cokluyaYukselt(g, aile) {
  const coklu = `Multi${aile}`;
  if (g.type === coklu) return g;
  if (g.type === aile) return { type: coklu, coordinates: [g.coordinates] };
  if (g.type === 'GeometryCollection') {
    const coordinates = [];
    for (const y of yapraklar(g)) {
      if (y.type === aile) coordinates.push(y.coordinates);
      else if (y.type === coklu) coordinates.push(...y.coordinates);
      else throw new Error(`"${y.type}" geometrisi ${coklu} içine alınamaz`);
    }
    return { type: coklu, coordinates };
  }
  throw new Error(`"${g.type}" geometrisi ${coklu} tipine çevrilemez`);
}

/**
 * Geometri listesi için tek sütun tipi ve gerekli dönüşümü belirler (bkz. yukarıdaki kural).
 * @param {object[]} geometriler null olmayan GeoJSON geometrileri
 * @returns {{ tip: string, z: boolean, karisikZ: boolean, donustur: (g: object) => object,
 *             yukseltilen: number, duzlestirilen: number }}
 */
export function geometriTipiPolitikasi(geometriler) {
  const zSayisi = geometriler.filter(zVarMi).length;
  const z = zSayisi > 0;
  const karisikZ = z && zSayisi < geometriler.length;
  const ayni = (g) => g;
  const sonuc = (tip, donustur = ayni, yukseltilen = 0, duzlestirilen = 0) =>
    ({ tip, z, karisikZ, donustur, yukseltilen, duzlestirilen });

  if (!geometriler.length) return sonuc('Geometry');
  const tipler = new Set(geometriler.map((g) => g.type));
  const bilgiler = geometriler.map(aileBilgisi);
  const aileler = new Set(bilgiler.map((b) => b.aile));
  if (aileler.size === 1 && !aileler.has(null)) {
    const aile = [...aileler][0];
    if (tipler.size === 1 && !bilgiler[0].koleksiyon) return sonuc([...tipler][0]);
    if (!bilgiler.some((b) => b.coklu)) return sonuc(aile);
    return sonuc(
      `Multi${aile}`,
      (g) => cokluyaYukselt(g, aile),
      bilgiler.filter((b) => !b.coklu).length,
      bilgiler.filter((b) => b.koleksiyon).length,
    );
  }
  if (tipler.size === 1) return sonuc([...tipler][0]); // ör. hepsi karışık GeometryCollection
  return sonuc('Geometry');
}

/** Uzun metinlerin önizlemesi: ilk `enFazla` satır + kalan satır sayısı özeti. */
export function onizlemeKisalt(satirlar, enFazla = 200) {
  if (satirlar.length <= enFazla) return satirlar.join('\n');
  return `${satirlar.slice(0, enFazla).join('\n')}\n… (${satirlar.length - enFazla} satır daha; toplam ${satirlar.length} satır)`;
}

/**
 * `.wkb` yazıcısı: her obje için bir satır büyük harf hex WKB (ISO, little-endian).
 *
 * Neden tek bir ikili dosya değil de hex satırlar?
 *  - WKB tek bir geometri için tanımlıdır; birden çok geometriyi tek ikili dosyada saklamanın standart
 *    bir kapsayıcısı yoktur (art arda yazılmış WKB'ler sınır bilgisi olmadan okunamaz ve hiçbir
 *    CBS yazılımı böyle bir `.wkb` dosyasını açmaz).
 *  - Hex WKB, PostGIS (`'…'::geometry`, `ST_GeomFromWKB(decode('…','hex'))`), QGIS, OGR, Shapely
 *    (`wkb.loads(hex=True)`) ve bu uygulamanın kendi okuyucusunun doğrudan kabul ettiği metin
 *    biçimidir; kopyala-yapıştır ve satır satır işleme mümkündür.
 *  - `.wkt` çıktısıyla simetriktir: satır N ↔ geometri N; arayüz önizlemesi de aynı metni gösterir.
 *
 * Seçenekler: `endian` ('little' | 'big', varsayılan little); `ewkb: true` ve çözülebilir `crs`
 * ('EPSG:xxxx') verilirse her satır SRID gömülü PostGIS EWKB olur (varsayılan: ISO WKB, SRID'siz).
 * Null geometrili objeler atlanır; kodlanamayan geometriler atlanır; her ikisi uyarılır.
 *
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler]
 * @returns {Promise<{veri: string, onizleme: string, uyarilar: string[]}>}
 */
export async function wkbYaz(fc, secenekler = {}) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw hata('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.');
  }
  const endian = secenekler?.endian === 'big' ? 'big' : 'little';
  const uyarilar = [];
  let ewkbSrid = null;
  if (secenekler?.ewkb === true) {
    ewkbSrid = sridCoz(secenekler.crs);
    if (ewkbSrid === null) {
      uyarilar.push(
        `EWKB istendi ama hedef koordinat sisteminden ${secenekler.crs ? `("${secenekler.crs}") ` : ''}SRID çıkarılamadı; SRID'siz ISO WKB yazıldı.`,
      );
    }
  }
  const satirlar = [];
  let bosSayisi = 0;
  fc.features.forEach((f, i) => {
    const g = f && typeof f === 'object' ? f.geometry : null;
    if (!g || typeof g !== 'object' || typeof g.type !== 'string') {
      bosSayisi++;
      return;
    }
    try {
      satirlar.push(hexe(geometriWkb(g, { endian, ewkbSrid })));
    } catch (e) {
      uyarilar.push(`${i + 1}. obje WKB'ye çevrilemedi, atlandı: ${e.message}`);
    }
  });
  if (bosSayisi) uyarilar.push(`${bosSayisi} obje geometrisiz (null) olduğu için WKB çıktısına yazılmadı.`);
  if (!satirlar.length) uyarilar.push('Yazılacak geometri yok; çıktı boş.');
  const veri = satirlar.join('\n');
  return { veri, onizleme: onizlemeKisalt(satirlar), uyarilar };
}
