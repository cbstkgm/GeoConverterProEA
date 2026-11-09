// M1 — Okuyucular: tarayıcıda (Worker dahil) ve Node'da çalışan CBS dosya okuyucuları.
// Sözleşme: docs/MIMARI.md → dosyaOku({ ad, veri: ArrayBuffer }) → { geojson, uyarilar }
import { DOMParser } from '@xmldom/xmldom';
import { kml as kmlToGeoJSON, gpx as gpxToGeoJSON } from '@tmcw/togeojson';
import JSZip from 'jszip';
import { wktCoz } from './wkt.js';
import proj4 from 'proj4';
import { parseShp, parseDbf } from 'shpjs';

import { DESTEKLENEN_GIRDILER } from './katalog.js';

export { DESTEKLENEN_GIRDILER };

const GEOMETRI_TIPLERI = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString',
  'Polygon', 'MultiPolygon', 'GeometryCollection',
]);

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function uzantiAl(ad) {
  const i = ad.lastIndexOf('.');
  return i === -1 ? '' : ad.slice(i).toLowerCase();
}

function baytlaraCevir(veri) {
  if (veri instanceof Uint8Array) return veri;
  if (veri instanceof ArrayBuffer || Object.prototype.toString.call(veri) === '[object ArrayBuffer]') {
    return new Uint8Array(veri);
  }
  if (ArrayBuffer.isView(veri)) return new Uint8Array(veri.buffer, veri.byteOffset, veri.byteLength);
  throw new Error('Dosya verisi okunamadı: ArrayBuffer bekleniyordu.');
}

/** UTF-8 çözer (BOM atılır). Geçersiz UTF-8 ise Windows-1254 (Türkçe) dener ve uyarır. */
function metneCevir(baytlar, uyarilar) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(baytlar);
  } catch {
    try {
      const metin = new TextDecoder('windows-1254').decode(baytlar);
      uyarilar.push('Dosya geçerli UTF-8 değil; Windows-1254 (Türkçe) kodlamasıyla okundu.');
      return metin;
    } catch {
      uyarilar.push('Dosya geçerli UTF-8 değil; bazı karakterler bozuk görünebilir.');
      return new TextDecoder('utf-8').decode(baytlar);
    }
  }
}

function bosMu(metin) {
  return metin.replace(/^﻿/, '').trim() === '';
}

function featureCollection(features) {
  return { type: 'FeatureCollection', features };
}

function xmlAyristir(metin, formatAdi) {
  let belge;
  try {
    const parser = new DOMParser({
      onError: (seviye, mesaj) => {
        if (seviye === 'fatalError') throw new Error(mesaj);
      },
    });
    belge = parser.parseFromString(metin, 'text/xml');
  } catch (e) {
    throw new Error(`${formatAdi} dosyası geçerli bir XML değil: ${e.message}`, { cause: e });
  }
  if (!belge || !belge.documentElement) {
    throw new Error(`${formatAdi} dosyası geçerli bir XML değil.`);
  }
  return belge;
}

/** Feature'ları normalize eder: properties her zaman nesne olur. */
function featureDuzelt(f) {
  return {
    ...f,
    type: 'Feature',
    geometry: f.geometry ?? null,
    properties: f.properties && typeof f.properties === 'object' ? f.properties : {},
  };
}

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

function geojsonOku(metin) {
  let veri;
  try {
    veri = JSON.parse(metin);
  } catch (e) {
    throw new Error(`Geçersiz JSON: ${e.message}`, { cause: e });
  }
  if (!veri || typeof veri !== 'object' || Array.isArray(veri)) {
    throw new Error('Geçersiz GeoJSON: kök öğe bir nesne olmalı.');
  }
  if (veri.type === 'FeatureCollection') {
    if (!Array.isArray(veri.features)) {
      throw new Error('Geçersiz GeoJSON: FeatureCollection içinde "features" dizisi yok.');
    }
    return { ...veri, features: veri.features.map(featureDuzelt) };
  }
  if (veri.type === 'Feature') {
    return featureCollection([featureDuzelt(veri)]);
  }
  if (GEOMETRI_TIPLERI.has(veri.type)) {
    return featureCollection([{ type: 'Feature', geometry: veri, properties: {} }]);
  }
  throw new Error(`Geçersiz GeoJSON: tanınmayan "type" değeri (${JSON.stringify(veri.type ?? null)}).`);
}

// ---------------------------------------------------------------------------
// KML / KMZ / GPX
// ---------------------------------------------------------------------------

const MULTI_KARSILIGI = { Point: 'MultiPoint', LineString: 'MultiLineString', Polygon: 'MultiPolygon' };

/** KML MultiGeometry → togeojson GeometryCollection; alt geometrilerin hepsi aynı basit tipteyse Multi*'a çevirir. */
function multiGeometriSadelestir(geometri) {
  if (!geometri || geometri.type !== 'GeometryCollection') return geometri;
  const altlar = geometri.geometries ?? [];
  if (!altlar.length) return geometri;
  const tip = altlar[0]?.type;
  const hedef = MULTI_KARSILIGI[tip];
  if (!hedef || !altlar.every((g) => g?.type === tip)) return geometri;
  return { type: hedef, coordinates: altlar.map((g) => g.coordinates) };
}

function kmlMetniOku(metin) {
  return featureCollection(
    kmlToGeoJSON(xmlAyristir(metin, 'KML')).features
      .map(featureDuzelt)
      .map((f) => ({ ...f, geometry: multiGeometriSadelestir(f.geometry) })),
  );
}

async function kmzOku(baytlar, uyarilar) {
  let zip;
  try {
    zip = await JSZip.loadAsync(baytlar);
  } catch (e) {
    throw new Error(`KMZ dosyası açılamadı (geçerli bir ZIP değil): ${e.message}`, { cause: e });
  }
  const kmller = Object.values(zip.files)
    .filter((g) => !g.dir && g.name.toLowerCase().endsWith('.kml') && !g.name.includes('__MACOSX'));
  const kokteki = kmller.filter((g) => !g.name.includes('/'));
  let secilen = kokteki.find((g) => g.name.toLowerCase() === 'doc.kml') ?? kokteki[0];
  if (!secilen && kmller.length) {
    secilen = kmller[0];
    uyarilar.push(`KMZ kök dizininde KML yok; alt klasördeki "${secilen.name}" kullanıldı.`);
  }
  if (!secilen) throw new Error('KMZ içinde KML dosyası bulunamadı.');
  if (kmller.length > 1) {
    uyarilar.push(`KMZ içinde ${kmller.length} KML dosyası var; yalnızca "${secilen.name}" okundu.`);
  }
  const kmlBaytlari = await secilen.async('uint8array');
  return kmlMetniOku(metneCevir(kmlBaytlari, uyarilar));
}

function gpxOku(metin) {
  return featureCollection(gpxToGeoJSON(xmlAyristir(metin, 'GPX')).features.map(featureDuzelt));
}

// ---------------------------------------------------------------------------
// WKT
// ---------------------------------------------------------------------------

/** Parantez dengesi (açılan − kapanan). */
const parantezFarki = (metin) => {
  let fark = 0;
  for (const c of metin) {
    if (c === '(') fark++;
    else if (c === ')') fark--;
  }
  return fark;
};

function wktOku(metin, uyarilar) {
  const features = [];
  const satirlar = metin.split(/\r\n|\n|\r/);
  // Bir geometri birden fazla satıra yayılabilir: parantezler kapanana kadar satırlar birleştirilir.
  let parca = '';
  let baslangic = 0;
  let derinlik = 0;
  const bitir = (sonSatir) => {
    const etiket = baslangic === sonSatir ? `Satır ${baslangic}` : `Satır ${baslangic}–${sonSatir}`;
    try {
      const geometri = wktCoz(parca);
      if (geometri) features.push({ type: 'Feature', geometry: geometri, properties: {} });
      else uyarilar.push(`${etiket}: boş geometri (EMPTY) atlandı.`);
    } catch (e) {
      uyarilar.push(`${etiket}: WKT okunamadı (${e.message}), atlandı.`);
    }
    parca = '';
    derinlik = 0;
  };
  satirlar.forEach((satir, i) => {
    const temiz = satir.replace(/^﻿/, '').trim();
    if (!temiz && !parca) return;
    if (!parca) baslangic = i + 1;
    parca += (parca ? ' ' : '') + temiz;
    derinlik += parantezFarki(temiz);
    if (derinlik <= 0) bitir(i + 1);
  });
  if (parca) bitir(satirlar.length);
  if (!features.length) throw new Error('Dosyada geçerli WKT geometrisi bulunamadı.');
  return featureCollection(features);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Tırnak dışındaki karakter sayısı (ayırıcı tespiti için). */
function tirnakDisiSay(satir, karakter) {
  let sayi = 0;
  let tirnakta = false;
  for (const c of satir) {
    if (c === '"') tirnakta = !tirnakta;
    else if (c === karakter && !tirnakta) sayi++;
  }
  return sayi;
}

/** RFC 4180 uyumlu CSV ayrıştırıcı: tırnaklı alanlar, "" kaçışı, alan içi satır sonu. */
function csvAyristir(metin, ayirici) {
  const satirlar = [];
  let satir = [];
  let alan = '';
  let tirnakta = false;
  let satirNo = 1;
  let satirBasNo = 1;
  for (let i = 0; i < metin.length; i++) {
    const c = metin[i];
    if (tirnakta) {
      if (c === '"') {
        if (metin[i + 1] === '"') { alan += '"'; i++; } else tirnakta = false;
      } else {
        if (c === '\n') satirNo++;
        alan += c;
      }
    } else if (c === '"') {
      tirnakta = true;
    } else if (c === ayirici) {
      satir.push(alan); alan = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && metin[i + 1] === '\n') i++;
      satir.push(alan); alan = '';
      satirlar.push({ alanlar: satir, no: satirBasNo });
      satir = [];
      satirNo++;
      satirBasNo = satirNo;
    } else {
      alan += c;
    }
  }
  if (alan !== '' || satir.length) {
    satir.push(alan);
    satirlar.push({ alanlar: satir, no: satirBasNo });
  }
  return satirlar.filter((s) => !(s.alanlar.length === 1 && s.alanlar[0].trim() === ''));
}

const WKT_SUTUNLARI = ['wkt', 'geom', 'geometry'];
const ENLEM_SUTUNLARI = ['lat', 'latitude', 'enlem', 'y'];
const BOYLAM_SUTUNLARI = ['lon', 'longitude', 'boylam', 'x'];

function sutunBul(basliklar, adaylar) {
  for (const aday of adaylar) {
    const i = basliklar.indexOf(aday);
    if (i !== -1) return i;
  }
  return -1;
}

function sayiyaCevir(deger) {
  const t = String(deger ?? '').trim().replace(',', '.');
  if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return NaN;
  return Number(t);
}

function csvOku(metin, uyarilar) {
  const ilkSatir = metin.split(/\r\n|\n|\r/, 1)[0];
  const ayirici = tirnakDisiSay(ilkSatir, ';') > tirnakDisiSay(ilkSatir, ',') ? ';' : ',';
  const satirlar = csvAyristir(metin, ayirici);
  if (!satirlar.length) throw new Error('CSV dosyası boş.');

  const ham = satirlar[0].alanlar.map((b) => b.trim());
  const basliklar = ham.map((b) => b.toLocaleLowerCase('tr-TR'));
  const basliklarEn = ham.map((b) => b.toLowerCase());
  const bul = (adaylar) => {
    const i = sutunBul(basliklarEn, adaylar);
    return i !== -1 ? i : sutunBul(basliklar, adaylar);
  };

  const wktSutun = bul(WKT_SUTUNLARI);
  const enlemSutun = bul(ENLEM_SUTUNLARI);
  const boylamSutun = bul(BOYLAM_SUTUNLARI);
  const kullanWkt = wktSutun !== -1;
  if (!kullanWkt && (enlemSutun === -1 || boylamSutun === -1)) {
    throw new Error(
      'CSV içinde geometri sütunu bulunamadı. "wkt", "geom" veya "geometry" sütunu ya da ' +
      'enlem/boylam sütunları (lat/lon, latitude/longitude, enlem/boylam, x/y) gereklidir.',
    );
  }
  const geometriSutunlari = kullanWkt ? new Set([wktSutun]) : new Set([enlemSutun, boylamSutun]);

  const features = [];
  for (const { alanlar, no } of satirlar.slice(1)) {
    let geometri = null;
    if (kullanWkt) {
      const wkt = (alanlar[wktSutun] ?? '').trim();
      if (!wkt) {
        uyarilar.push(`Satır ${no}: geometri hücresi boş, satır atlandı.`);
        continue;
      }
      try {
        geometri = wktCoz(wkt);
      } catch (e) {
        uyarilar.push(`Satır ${no}: geometri okunamadı (${e.message}), satır atlandı.`);
        continue;
      }
      if (!geometri) {
        uyarilar.push(`Satır ${no}: boş geometri (EMPTY), satır atlandı.`);
        continue;
      }
    } else {
      const enlem = sayiyaCevir(alanlar[enlemSutun]);
      const boylam = sayiyaCevir(alanlar[boylamSutun]);
      if (!Number.isFinite(enlem) || !Number.isFinite(boylam)) {
        uyarilar.push(`Satır ${no}: geçersiz koordinat, satır atlandı.`);
        continue;
      }
      geometri = { type: 'Point', coordinates: [boylam, enlem] };
    }
    const properties = {};
    ham.forEach((ad, i) => {
      if (!geometriSutunlari.has(i)) properties[ad || `alan_${i + 1}`] = alanlar[i] ?? '';
    });
    features.push({ type: 'Feature', geometry: geometri, properties });
  }
  if (!features.length) throw new Error('CSV dosyasında geçerli geometri içeren satır bulunamadı.');
  return featureCollection(features);
}

// ---------------------------------------------------------------------------
// Zipli Shapefile
// ---------------------------------------------------------------------------

async function shapefileZipOku(baytlar, uyarilar) {
  let zip;
  try {
    zip = await JSZip.loadAsync(baytlar);
  } catch (e) {
    throw new Error(`ZIP dosyası açılamadı: ${e.message}`, { cause: e });
  }
  const dosyalar = {};
  for (const g of Object.values(zip.files)) {
    if (g.dir || g.name.includes('__MACOSX')) continue;
    dosyalar[g.name.toLowerCase()] = g;
  }
  const katmanlar = Object.keys(dosyalar)
    .filter((ad) => ad.endsWith('.shp'))
    .map((ad) => ad.slice(0, -4));
  if (!katmanlar.length) throw new Error('ZIP içinde Shapefile (.shp) bulunamadı.');

  const features = [];
  for (const kok of katmanlar) {
    const katmanAdi = dosyalar[`${kok}.shp`].name.replace(/\.shp$/i, '');
    const oku = async (uzanti, tur) => (dosyalar[`${kok}.${uzanti}`]
      ? dosyalar[`${kok}.${uzanti}`].async(tur) : undefined);
    const [shp, dbf, cpg, prj] = await Promise.all([
      oku('shp', 'uint8array'), oku('dbf', 'uint8array'), oku('cpg', 'string'), oku('prj', 'string'),
    ]);

    let prjGecerli = false;
    if (prj === undefined) {
      uyarilar.push(`"${katmanAdi}": .prj dosyası yok; koordinat sistemi bilinmiyor, koordinatlar olduğu gibi okundu.`);
    } else {
      try {
        proj4(prj);
        prjGecerli = true;
      } catch {
        uyarilar.push(`"${katmanAdi}": .prj tanınamadı; koordinatlar dönüştürülmeden olduğu gibi okundu.`);
      }
    }
    if (prjGecerli) {
      uyarilar.push(`"${katmanAdi}": koordinatlar .prj'ye göre WGS84'e (EPSG:4326) dönüştürüldü.`);
    }

    let geometriler;
    try {
      geometriler = parseShp(shp, prjGecerli ? prj : undefined);
    } catch (e) {
      throw new Error(`"${katmanAdi}.shp" okunamadı: ${e.message}`, { cause: e });
    }
    let ozellikler = [];
    if (dbf) {
      try {
        ozellikler = parseDbf(dbf, cpg);
      } catch (e) {
        uyarilar.push(`"${katmanAdi}.dbf" okunamadı (${e.message}); öznitelikler boş bırakıldı.`);
      }
    } else {
      uyarilar.push(`"${katmanAdi}": .dbf dosyası yok; öznitelikler boş.`);
    }
    geometriler.forEach((geometri, i) => {
      const properties = { ...(ozellikler[i] || {}) };
      if (katmanlar.length > 1 && !('katman' in properties)) properties.katman = katmanAdi;
      features.push({ type: 'Feature', geometry: geometri ?? null, properties });
    });
  }
  if (katmanlar.length > 1) {
    uyarilar.push(`ZIP içinde ${katmanlar.length} katman birleştirildi; katman adı "katman" özniteliğine yazıldı.`);
  }
  return featureCollection(features);
}

// ---------------------------------------------------------------------------
// Ana giriş
// ---------------------------------------------------------------------------

/**
 * @param {{ ad: string, veri: ArrayBuffer }} girdi
 * @returns {Promise<{ geojson: {type:'FeatureCollection', features: any[]}, uyarilar: string[] }>}
 */
export async function dosyaOku(girdi) {
  const ad = girdi?.ad ?? '';
  const uzanti = uzantiAl(ad);
  if (!DESTEKLENEN_GIRDILER.some((g) => g.uzanti === uzanti)) {
    const liste = DESTEKLENEN_GIRDILER.map((g) => g.uzanti).join(', ');
    throw new Error(
      `Desteklenmeyen dosya türü${uzanti ? ` (${uzanti})` : ''}: "${ad}". Desteklenen uzantılar: ${liste}`,
    );
  }
  const baytlar = baytlaraCevir(girdi.veri);
  if (baytlar.byteLength === 0) throw new Error(`Dosya boş: "${ad}".`);

  const uyarilar = [];
  let geojson;
  if (uzanti === '.kmz') {
    geojson = await kmzOku(baytlar, uyarilar);
  } else if (uzanti === '.zip') {
    geojson = await shapefileZipOku(baytlar, uyarilar);
  } else {
    const metin = metneCevir(baytlar, uyarilar);
    if (bosMu(metin)) throw new Error(`Dosya boş: "${ad}".`);
    switch (uzanti) {
      case '.geojson':
      case '.json': geojson = geojsonOku(metin); break;
      case '.kml': geojson = kmlMetniOku(metin); break;
      case '.gpx': geojson = gpxOku(metin); break;
      case '.wkt':
      case '.txt': geojson = wktOku(metin, uyarilar); break;
      case '.csv': geojson = csvOku(metin, uyarilar); break;
      default: throw new Error(`Desteklenmeyen dosya türü: "${ad}".`);
    }
  }
  if (!geojson.features.length) uyarilar.push('Dosyada hiç obje bulunamadı.');
  return { geojson, uyarilar };
}
