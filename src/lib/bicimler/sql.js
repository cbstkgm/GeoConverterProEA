/**
 * PostGIS SQL betiği yazıcısı (`.sql`).
 *
 * Saf JavaScript: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
 *
 * Üretilen betik (psql -f, pgAdmin, DBeaver ile tek seferde çalıştırılabilir):
 *
 *   -- açıklama satırları
 *   SET client_encoding = 'UTF8';
 *   SET standard_conforming_strings = on;
 *   BEGIN;
 *   CREATE TABLE "sema"."tablo" (id serial PRIMARY KEY, "öznitelik" tip, …, geom geometry(Tip[Z], SRID));
 *   INSERT INTO "sema"."tablo" ("öznitelik", …, geom) VALUES
 *     (…, ST_GeomFromEWKB('\x0101…'::bytea)),
 *     …;                          -- 500'erli bloklar (secenekler.topluBoyut)
 *   CREATE INDEX "tablo_geom_gist" ON "sema"."tablo" USING GIST (geom);
 *   COMMIT;
 *   ANALYZE "sema"."tablo";
 *
 * Geometri kodlaması — neden ST_GeomFromEWKB ve WKT değil?
 *  - Kayıpsız: koordinatlar IEEE-754 float64 olarak birebir aktarılır; WKT'deki ondalık metne
 *    çevirme/yuvarlama ve yeniden ayrıştırma yoktur (TM metre koordinatlarında mm altı fark bile oluşmaz).
 *  - SRID ve Z bayrağı geometrinin içinde taşınır; tablo typmod'uyla uyum PostGIS tarafından denetlenir.
 *  - Hex metin yalnızca [0-9A-F] içerir: kaçış gerektirmez, enjeksiyon yüzeyi yoktur.
 *  - PostGIS'te ikili girdiyi ayrıştırmak WKT ayrıştırmaktan hızlıdır (büyük yüklemelerde önemli).
 *  '\x…' bytea yazımı standard_conforming_strings = on gerektirir (PostgreSQL 9.1+ varsayılanı);
 *  betik bunu açıkça ayarlar, böylece eski/ayarı değiştirilmiş sunucularda da doğru çalışır.
 *
 * Kaçış kuralları (standard_conforming_strings = on varsayımıyla):
 *  - Metin değerleri: '…' içinde tek tırnak çiftlenir (O'Brien → 'O''Brien'); ters bölü olduğu gibi
 *    kalır (E'' kullanılmaz). PostgreSQL metinde NUL (U+0000) kabul etmediği için NUL ayıklanır.
 *  - Tanımlayıcılar (şema, tablo, sütun) her zaman çift tırnakla yazılır, içteki " çiftlenir,
 *    NUL ayıklanır, 63 bayta (NAMEDATALEN-1, UTF-8) kırpılır. Türkçe karakterler korunur.
 *  - 'id' ve 'geom' ile çakışan öznitelik adları (büyük/küçük harf duyarsız) yeniden adlandırılır.
 *
 * Tip çıkarımı (sütundaki null olmayan tüm değerlere bakılır):
 *  tamamı güvenli tamsayı → bigint; tamamı sayı → double precision; tamamı boolean → boolean;
 *  tamamı nesne/dizi → jsonb; tamamı YYYY-MM-DD → date; tamamı saat dilimli (Z/±hh:mm) ISO 8601
 *  tarih-saat → timestamptz; tamamı dilimsiz tarih-saat → timestamp (geçersiz takvim tarihi, ör.
 *  2024-02-30, metin sayılır); karışık veya metin → text (nesneler JSON metni olarak yazılır).
 *  ±2^53 dışındaki tamsayılar double precision'a düşer ve uyarılır.
 *
 * Geometri sütunu tipi: wkb.js `geometriTipiPolitikasi` (GeoPackage ile ortak kural) — aynı aileden
 * tekil + çoklu karışımı Multi* olur ve tekiller yükseltilir; yalnızca farklı aileler → Geometry.
 *
 * Seçenekler: `crs` ('EPSG:xxxx'), `tabloAdi` (varsayılan 'objeler'), `sema`, `topluBoyut` (500),
 * `tabloyuDegistir` (true ise BEGIN'den sonra DROP TABLE IF EXISTS; varsayılan kapalı).
 */
import { geometriTipiPolitikasi, geometriWkb, hexe, onizlemeKisalt, sridCoz } from './wkb.js';

const VARSAYILAN_TABLO = 'objeler';
const VARSAYILAN_SRID = 4326;
const VARSAYILAN_TOPLU = 500;
const AD_BAYT_SINIRI = 63;
const SAKLI_SUTUNLAR = new Set(['id', 'geom']);

const kodlayici = new TextEncoder();

// ---------------------------------------------------------------- Kaçış

/** NUL (U+0000) karakterlerini ayıklar; PostgreSQL text/identifier bunları kabul etmez. */
function nulAyikla(metin) {
  // eslint-disable-next-line no-control-regex
  return String(metin).replace(/\u0000/g, '');
}

/** Metni UTF-8 olarak en fazla `sinir` bayta, karakter bölmeden kırpar. */
function baytaKirp(metin, sinir = AD_BAYT_SINIRI) {
  if (kodlayici.encode(metin).length <= sinir) return metin;
  let sonuc = '';
  let bayt = 0;
  for (const harf of metin) {
    const n = kodlayici.encode(harf).length;
    if (bayt + n > sinir) break;
    sonuc += harf;
    bayt += n;
  }
  return sonuc;
}

/**
 * Ham adı temizler: NUL ayıklar, diğer kontrol karakterlerini (satır sonu, sekme…) boşluğa çevirir,
 * kenar boşluklarını atar, 63 bayta kırpar. Boşsa ''.
 */
export function adTemizle(ad) {
  // eslint-disable-next-line no-control-regex
  return baytaKirp(nulAyikla(ad ?? '').replace(/[\u0001-\u001F\u007F]/g, ' ').trim());
}

/** Tanımlayıcıyı çift tırnakla yazar: "ad""ı" (ad önceden temizlenmiş olmalı). */
export function tanimlayiciTirnakla(ad) {
  return `"${String(ad).replace(/"/g, '""')}"`;
}

/** Metin değerini SQL dizgesi olarak yazar: tek tırnak çiftleme + NUL ayıklama. */
export function metinTirnakla(deger) {
  return `'${nulAyikla(deger).replace(/'/g, "''")}'`;
}

/** Yorum satırına güvenle konabilecek tek satırlık metin. */
function yorumMetni(metin) {
  return nulAyikla(metin).replace(/[\r\n]+/g, ' ');
}

// ---------------------------------------------------------------- Tip çıkarımı

const INT64_EN_KUCUK = -(2n ** 63n);
const INT64_EN_BUYUK = 2n ** 63n - 1n;

const TARIH = /^(\d{4})-(\d{2})-(\d{2})$/;
// ISO 8601 tarih-saat: 2024-05-01T12:30[:45[.123]][Z|+03[:00]]; ayraç olarak boşluk da kabul edilir.
const TARIH_SAAT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Gerçek bir takvim tarihi mi? (2024-02-30, 2023-02-29, 0000-01-01 elenir.) */
function takvimGecerli(y, a, g) {
  const yil = Number(y);
  const ay = Number(a);
  const gun = Number(g);
  if (yil < 1 || ay < 1 || ay > 12 || gun < 1) return false;
  const artik = yil % 4 === 0 && (yil % 100 !== 0 || yil % 400 === 0);
  const ayGunleri = [31, artik ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return gun <= ayGunleri[ay - 1];
}

function metinTuru(d) {
  let m = TARIH.exec(d);
  if (m) return takvimGecerli(m[1], m[2], m[3]) ? 'tarih' : 'metin';
  m = TARIH_SAAT.exec(d);
  if (!m) return 'metin';
  const [, y, a, g, sa, dk, sn, dilim] = m;
  if (!takvimGecerli(y, a, g) || Number(sa) > 23 || Number(dk) > 59 || (sn !== undefined && Number(sn) > 59)) return 'metin';
  if (dilim && dilim.toUpperCase() !== 'Z' && Number(dilim.slice(1, 3)) > 15) return 'metin';
  return dilim ? 'zamanDilimli' : 'zaman';
}

function degerTuru(d) {
  if (typeof d === 'boolean') return 'boolean';
  if (typeof d === 'number') {
    if (Number.isSafeInteger(d)) return 'tamsayi';
    return Number.isInteger(d) ? 'guvensizTamsayi' : 'sayi';
  }
  if (typeof d === 'bigint') return d >= INT64_EN_KUCUK && d <= INT64_EN_BUYUK ? 'tamsayi' : 'guvensizTamsayi';
  if (typeof d === 'object') return 'json';
  if (typeof d === 'string') return metinTuru(d);
  return 'metin';
}

const SAYISAL = new Set(['tamsayi', 'sayi', 'guvensizTamsayi']);

/**
 * Sütun tipini çıkarır.
 * @returns {{ tip: string, guvensizTamsayi: boolean }} guvensizTamsayi: ±2^53 (veya int64) dışında
 *   tamsayı görüldü — JavaScript'te bu değerler zaten tam saklanamaz, hassasiyet kaybı olabilir.
 */
function sutunTipiCikar(degerler) {
  const turler = new Set();
  for (const d of degerler) if (d !== null && d !== undefined) turler.add(degerTuru(d));
  const guvensizTamsayi = turler.has('guvensizTamsayi');
  const tek = turler.size === 1 ? [...turler][0] : null;
  let tip = 'text';
  if (turler.size === 0) tip = 'text';
  else if (tek === 'tamsayi') tip = 'bigint';
  else if ([...turler].every((t) => SAYISAL.has(t))) tip = 'double precision';
  else if (tek === 'boolean') tip = 'boolean';
  else if (tek === 'json') tip = 'jsonb';
  else if (tek === 'tarih') tip = 'date';
  else if (tek === 'zamanDilimli') tip = 'timestamptz';
  else if (tek === 'zaman') tip = 'timestamp';
  return { tip, guvensizTamsayi };
}

function sayiYaz(n) {
  if (Number.isNaN(n)) return "'NaN'";
  if (n === Infinity) return "'Infinity'";
  if (n === -Infinity) return "'-Infinity'";
  return String(n);
}

function degerSql(d, tip) {
  if (d === null || d === undefined) return 'NULL';
  switch (tip) {
    case 'bigint':
      return String(d);
    case 'double precision':
      return sayiYaz(Number(d));
    case 'boolean':
      return d ? 'TRUE' : 'FALSE';
    case 'jsonb':
      // JSON.stringify NUL'u \u0000 olarak kaçırır; jsonb bunu reddettiği için o kaçışı da ayıkla.
      return `${metinTirnakla(JSON.stringify(d).replace(/\\u0000/g, ''))}::jsonb`;
    default:
      return metinTirnakla(typeof d === 'object' ? JSON.stringify(d) : String(d));
  }
}

// ---------------------------------------------------------------- Geometri sütunu

function geometriGecerli(g) {
  return g != null && typeof g === 'object' && typeof g.type === 'string';
}

/** 32 bit FNV-1a özeti, 8 hex karakter (indeks adı son eki için; kriptografik değil). */
function kisaOzet(metin) {
  let h = 0x811c9dc5;
  for (const b of kodlayici.encode(metin)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * GIST indeks adı: "<tablo>_geom_gist". 63 baytı aşarsa PostgreSQL adı sessizce kırpar ve aynı önekli
 * iki uzun tablo adı çakışabilir; bu yüzden tablo adı kısaltılır ve tam adın kısa özeti eklenir.
 */
function indeksAdiUret(semaAdi, tabloAdi) {
  const son = '_geom_gist';
  const tam = `${tabloAdi}${son}`;
  if (kodlayici.encode(tam).length <= AD_BAYT_SINIRI) return tam;
  const ozet = `_${kisaOzet(`${semaAdi}.${tabloAdi}`)}`;
  return `${baytaKirp(tabloAdi, AD_BAYT_SINIRI - son.length - ozet.length)}${ozet}${son}`;
}

// ---------------------------------------------------------------- Yazıcı

/**
 * GeoJSON FeatureCollection'ı PostGIS'e yüklenecek bir SQL betiğine çevirir.
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler] { crs, tabloAdi, sema, topluBoyut }
 * @returns {Promise<{veri: string, onizleme: string, uyarilar: string[]}>}
 */
export async function sqlYaz(fc, secenekler = {}) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.');
  }
  const s = secenekler || {};
  const uyarilar = [];
  const objeler = fc.features.filter((f) => f && typeof f === 'object');

  // SRID
  let srid = sridCoz(s.crs);
  if (srid === null) {
    srid = VARSAYILAN_SRID;
    uyarilar.push(
      s.crs
        ? `"${s.crs}" koordinat sisteminden SRID çıkarılamadı; SRID ${VARSAYILAN_SRID} (WGS84) varsayıldı.`
        : `Hedef koordinat sistemi belirtilmedi; SRID ${VARSAYILAN_SRID} (WGS84) varsayıldı.`,
    );
  }

  // Tablo / şema adları
  let tabloAdi = adTemizle(s.tabloAdi ?? VARSAYILAN_TABLO);
  if (!tabloAdi) {
    tabloAdi = VARSAYILAN_TABLO;
    uyarilar.push(`Tablo adı boş; "${VARSAYILAN_TABLO}" kullanıldı.`);
  }
  const semaAdi = s.sema ? adTemizle(s.sema) : '';
  const tablo = (semaAdi ? `${tanimlayiciTirnakla(semaAdi)}.` : '') + tanimlayiciTirnakla(tabloAdi);
  const indeksAdi = tanimlayiciTirnakla(indeksAdiUret(semaAdi, tabloAdi));
  const tabloyuDegistir = s.tabloyuDegistir === true;

  // Sütunlar: ilk görülme sırasıyla; çakışan/tekrarlanan adlar yeniden adlandırılır.
  const anahtarlar = [];
  const gorulenAnahtar = new Set();
  for (const f of objeler) {
    const p = f.properties && typeof f.properties === 'object' ? f.properties : {};
    for (const k of Object.keys(p)) {
      if (!gorulenAnahtar.has(k)) {
        gorulenAnahtar.add(k);
        anahtarlar.push(k);
      }
    }
  }
  const kullanilan = new Set([...SAKLI_SUTUNLAR]); // küçük harfle karşılaştırılır
  // Yeni ad üretirken sonradan gelecek özgün adlarla da çakışmamak için hepsini önceden ayır.
  const ozgunAdlar = new Set(anahtarlar.map((k) => adTemizle(k).toLowerCase()));
  const dolu = (ad) => kullanilan.has(ad.toLowerCase()) || ozgunAdlar.has(ad.toLowerCase());
  const sutunlar = anahtarlar.map((anahtar, i) => {
    let ad = adTemizle(anahtar) || `sutun_${i + 1}`;
    const ozgun = ad;
    if (kullanilan.has(ad.toLowerCase())) {
      let n = 1;
      const kok = baytaKirp(ad, AD_BAYT_SINIRI - 4);
      while (dolu(`${kok}_${n}`)) n++;
      ad = `${kok}_${n}`;
      uyarilar.push(
        SAKLI_SUTUNLAR.has(ozgun.toLowerCase())
          ? `"${anahtar}" özniteliği tablonun "${ozgun.toLowerCase()}" sütunuyla çakıştığı için "${ad}" olarak yazıldı.`
          : `"${anahtar}" özniteliğinin sütun adı başka bir sütunla çakıştığı (veya 63 bayta kırpıldığı) için "${ad}" olarak yazıldı.`,
      );
    } else if (ad !== anahtar) {
      uyarilar.push(`"${anahtar}" özniteliğinin sütun adı PostgreSQL için "${ad}" olarak düzeltildi.`);
    }
    kullanilan.add(ad.toLowerCase());
    const { tip, guvensizTamsayi } = sutunTipiCikar(objeler.map((f) => f.properties?.[anahtar]));
    if (guvensizTamsayi) {
      uyarilar.push(
        `"${anahtar}" sütununda güvenli tamsayı aralığını (±2^53) aşan değerler var; ${tip} olarak yazıldı, son basamaklarda hassasiyet kaybı olabilir (kaynakta metin olarak saklanması önerilir).`,
      );
    }
    return { anahtar, ad, tip };
  });

  // Geometri sütunu (tip politikası GeoPackage ile ortak: bkz. wkb.js geometriTipiPolitikasi)
  const geometriler = objeler.map((f) => f.geometry).filter(geometriGecerli);
  const gs = geometriTipiPolitikasi(geometriler);
  if (gs.yukseltilen) {
    uyarilar.push(`Sütun ${gs.tip} olarak tanımlandı; ${gs.yukseltilen} tekil geometri tek parçalı ${gs.tip}'e yükseltildi.`);
  }
  if (gs.duzlestirilen) {
    uyarilar.push(`${gs.duzlestirilen} GeometryCollection tek aileden parçalar içerdiği için ${gs.tip}'e düzleştirildi.`);
  }
  if (gs.karisikZ) {
    uyarilar.push('Bazı geometriler Z (yükseklik) içeriyor, bazıları içermiyor; PostGIS tek boyut istediği için Z\'siz koordinatlara Z = 0 yazıldı.');
  }
  const bosGeometri = objeler.length - geometriler.length;
  if (bosGeometri) uyarilar.push(`${bosGeometri} obje geometrisiz; geom sütununa NULL yazıldı.`);
  if (!objeler.length) uyarilar.push('Veri kümesi boş; betik yalnızca tabloyu oluşturur.');

  // Satırlar
  const satirDegerleri = [];
  objeler.forEach((f, i) => {
    const p = f.properties && typeof f.properties === 'object' ? f.properties : {};
    const degerler = sutunlar.map((c) => degerSql(p[c.anahtar], c.tip));
    let geomSql = 'NULL';
    if (geometriGecerli(f.geometry)) {
      try {
        geomSql = `ST_GeomFromEWKB('\\x${hexe(geometriWkb(gs.donustur(f.geometry), { ewkbSrid: srid, z: gs.z }))}'::bytea)`;
      } catch (e) {
        uyarilar.push(`${i + 1}. obje geometrisi kodlanamadı, NULL yazıldı: ${e.message}`);
      }
    }
    degerler.push(geomSql);
    satirDegerleri.push(`  (${degerler.join(', ')})`);
  });

  const topluBoyut = Number.isInteger(s.topluBoyut) && s.topluBoyut > 0 ? s.topluBoyut : VARSAYILAN_TOPLU;
  const sutunListesi = [...sutunlar.map((c) => tanimlayiciTirnakla(c.ad)), 'geom'].join(', ');
  const geomTipi = `geometry(${gs.tip}${gs.z ? 'Z' : ''}, ${srid})`;

  const satirlar = [
    '-- GeoConverterProEA tarafından üretilen PostGIS SQL betiği',
    `-- Tablo: ${yorumMetni(semaAdi ? `${semaAdi}.${tabloAdi}` : tabloAdi)} | SRID: ${srid} | Obje sayısı: ${objeler.length} | Geometri: ${gs.tip}${gs.z ? 'Z' : ''}`,
    '-- Gereksinim: PostGIS eklentisi (CREATE EXTENSION IF NOT EXISTS postgis;)' + (semaAdi ? ' ve mevcut şema' : ''),
    tabloyuDegistir
      ? '-- Çalıştırma: psql -d veritabani -f dosya.sql  (DİKKAT: tablo varsa silinip yeniden oluşturulur)'
      : '-- Çalıştırma: psql -d veritabani -f dosya.sql  (tablo zaten varsa CREATE TABLE hata verir ve hiçbir şey yazılmaz)',
    '',
    "SET client_encoding = 'UTF8';",
    'SET standard_conforming_strings = on;',
    '',
    'BEGIN;',
    '',
    ...(tabloyuDegistir ? [`DROP TABLE IF EXISTS ${tablo};`, ''] : []),
    `CREATE TABLE ${tablo} (`,
    ['  id serial PRIMARY KEY', ...sutunlar.map((c) => `  ${tanimlayiciTirnakla(c.ad)} ${c.tip}`), `  geom ${geomTipi}`].join(',\n'),
    ');',
    '',
  ];
  for (let i = 0; i < satirDegerleri.length; i += topluBoyut) {
    satirlar.push(`INSERT INTO ${tablo} (${sutunListesi}) VALUES`);
    satirlar.push(`${satirDegerleri.slice(i, i + topluBoyut).join(',\n')};`);
    satirlar.push('');
  }
  satirlar.push(`CREATE INDEX ${indeksAdi} ON ${tablo} USING GIST (geom);`, '', 'COMMIT;', '', `ANALYZE ${tablo};`, '');

  const veri = satirlar.join('\n');
  return { veri, onizleme: onizlemeKisalt(veri.split('\n')), uyarilar };
}
