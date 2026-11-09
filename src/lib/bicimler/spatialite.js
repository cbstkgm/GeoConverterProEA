// SpatiaLite 4.x (.sqlite) yazıcısı — SpatiaLite eklentisi OLMADAN, yalnızca sql.js ile.
//
// Meta veri "current" (4.x) düzenindedir: spatial_ref_sys (srid, auth_name, auth_srid, ref_sys_name,
// proj4text, srtext), geometry_columns (f_table_name, f_geometry_column, geometry_type tamsayı kodu,
// coord_dimension, srid, spatial_index_enabled), spatialite_history. SpatiaLite / GDAL bu iki tablonun
// sütun düzeninden veritabanını 4.x olarak tanır.
//
// Geometri BLOB'u SpatiaLite iç biçimidir (https://www.gaia-gis.it/gaia-sins/BLOB-Geometry.html):
//   0x00 START | 0x01 (little-endian) | SRID int32 | MBR minX minY maxX maxY (4 double) | 0x7C MBR_END
//   | sınıf tipi int32 | gövde | 0xFE END
// Gövde WKB'ye benzer, ancak bayt sırası/tip yalnızca en dışta bir kez yazılır; Multi* ve
// GeometryCollection öğeleri 0x69 ENTITY işaretçisi + sınıf tipi int32 + gövde olarak yazılır.
// Sınıf tipleri: 1..7 (XY), 1001..1007 (XYZ). Sıkıştırılmış tipler (1000000+) kullanılmaz.
//
// Tip politikası GeoPackage yazıcısıyla aynıdır (geopackage.js → tablolaraDagit; wkb.js
// geometriTipiPolitikasi): aynı ailede tekil+çoklu karışımı Multi'ye yükseltilir, farklı aileler aile
// başına ayrı tabloya (<tablo>_nokta/_cizgi/_poligon/_karisik) yazılır.
// SpatiaLite boş geometriyi temsil edemez (MBR tanımsız): boş geometriler NULL yazılır ve uyarılır.
// R-tree uzamsal indeks yazılmaz (sql.js'te rtree modülü yok): spatial_index_enabled = 0.

import { KOORDINAT_SISTEMI_TANIMLARI } from '../katalog.js'
import {
  BaytYazici,
  GEOMETRI_SUTUNU,
  KIMLIK_SUTUNU,
  SRS_TANIMLARI,
  degerDonustur,
  geometriIncele,
  sqlJsYukle,
  srsCoz,
  sutunlariCikar,
  tabloAdiBelirle,
  tablolaraDagit,
  tirnakla,
} from './geopackage.js'

const SINIF_KODLARI = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 }
const TABLO_TIP_KODLARI = {
  GEOMETRY: 0,
  POINT: 1,
  LINESTRING: 2,
  POLYGON: 3,
  MULTIPOINT: 4,
  MULTILINESTRING: 5,
  MULTIPOLYGON: 6,
  GEOMETRYCOLLECTION: 7,
}
const SISTEM_TABLOLARI = /^(spatial_ref_sys|geometry_columns|spatialite_history|views_geometry_columns|virts_geometry_columns|sqlite_.*)$/i

function govdeYaz(w, g, z) {
  const konum = (k) => {
    w.f64(k[0])
    w.f64(k[1])
    if (z) w.f64(k.length >= 3 && Number.isFinite(k[2]) ? k[2] : 0)
  }
  const konumlar = (c) => {
    const d = Array.isArray(c) ? c : []
    w.u32(d.length)
    d.forEach(konum)
  }
  const varlik = (alt) => {
    w.u8(0x69) // ENTITY
    w.u32(SINIF_KODLARI[alt.type] + (z ? 1000 : 0))
    govdeYaz(w, alt, z)
  }
  const c = g.coordinates
  switch (g.type) {
    case 'Point':
      konum(c)
      break
    case 'LineString':
      konumlar(c)
      break
    case 'Polygon':
      w.u32(c.length)
      c.forEach(konumlar)
      break
    case 'MultiPoint':
      w.u32(c.length)
      c.forEach((k) => varlik({ type: 'Point', coordinates: k }))
      break
    case 'MultiLineString':
      w.u32(c.length)
      c.forEach((k) => varlik({ type: 'LineString', coordinates: k }))
      break
    case 'MultiPolygon':
      w.u32(c.length)
      c.forEach((k) => varlik({ type: 'Polygon', coordinates: k }))
      break
    case 'GeometryCollection': {
      const d = (g.geometries || []).filter(Boolean)
      w.u32(d.length)
      d.forEach(varlik)
      break
    }
    default:
      throw new Error(`desteklenmeyen geometri tipi: ${g.type}`)
  }
}

/**
 * GeoJSON geometrisini SpatiaLite BLOB'una çevirir. Boş geometride null döner.
 * @param {object} g GeoJSON geometrisi
 * @param {number} srid
 * @param {boolean} [z] XYZ yaz (verilmezse geometride Z varsa)
 */
export function spatialiteGeometrisi(g, srid, z) {
  const bilgi = geometriIncele(g)
  if (bilgi.bos) return null
  const xyz = z ?? bilgi.z
  const w = new BaytYazici(64)
  w.u8(0x00) // START
  w.u8(0x01) // little-endian
  w.i32(srid)
  w.f64(bilgi.zarf.minx)
  w.f64(bilgi.zarf.miny)
  w.f64(bilgi.zarf.maxx)
  w.f64(bilgi.zarf.maxy)
  w.u8(0x7c) // MBR_END
  w.u32(SINIF_KODLARI[g.type] + (xyz ? 1000 : 0))
  govdeYaz(w, g, xyz)
  w.u8(0xfe) // END
  return w.sonuc()
}

function metaTablolariniKur(db) {
  db.run(`CREATE TABLE spatial_ref_sys (
    srid INTEGER NOT NULL PRIMARY KEY,
    auth_name TEXT NOT NULL,
    auth_srid INTEGER NOT NULL,
    ref_sys_name TEXT NOT NULL DEFAULT 'Unknown',
    proj4text TEXT NOT NULL,
    srtext TEXT NOT NULL DEFAULT 'Undefined')`)
  db.run('CREATE UNIQUE INDEX idx_spatial_ref_sys ON spatial_ref_sys (auth_srid, auth_name)')
  db.run(`CREATE TABLE geometry_columns (
    f_table_name TEXT NOT NULL,
    f_geometry_column TEXT NOT NULL,
    geometry_type INTEGER NOT NULL,
    coord_dimension INTEGER NOT NULL,
    srid INTEGER NOT NULL,
    spatial_index_enabled INTEGER NOT NULL,
    CONSTRAINT pk_geom_cols PRIMARY KEY (f_table_name, f_geometry_column),
    CONSTRAINT fk_gc_srs FOREIGN KEY (srid) REFERENCES spatial_ref_sys (srid),
    CONSTRAINT ck_gc_rtree CHECK (spatial_index_enabled IN (0,1,2)))`)
  db.run('CREATE INDEX idx_srid_geocols ON geometry_columns (srid)')
  db.run(`CREATE TABLE spatialite_history (
    event_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    geometry_column TEXT,
    event TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    ver_sqlite TEXT NOT NULL,
    ver_splite TEXT NOT NULL)`)
}

const tarihce = (db, tablo, sutun, olay) =>
  db.run(
    `INSERT INTO spatialite_history (table_name, geometry_column, event, timestamp, ver_sqlite, ver_splite)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), sqlite_version(), 'GeoConverterProEA (sql.js)')`,
    [tablo, sutun, olay],
  )

/**
 * GeoJSON FeatureCollection'ı SpatiaLite 4.x veritabanına yazar.
 * @param {object} fc FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler] crs ('EPSG:xxxx'), sqlWasmUrl, tabloAdi (varsayılan 'objeler')
 * @returns {Promise<{ veri: Uint8Array, onizleme: string, uyarilar: string[] }>}
 */
export async function spatialiteYaz(fc, secenekler = {}) {
  const ayar = secenekler || {}
  const uyarilar = []
  const uyar = (m) => {
    if (!uyarilar.includes(m)) uyarilar.push(m)
  }
  const objeler = Array.isArray(fc?.features) ? fc.features : []
  const srid = srsCoz(ayar.crs, uyarilar)
  // SpatiaLite tablo adlarını küçük harfle karşılaştırır (geometry_columns'ta küçük harf zorunlu).
  let tabanAd = tabloAdiBelirle(ayar.tabloAdi, uyar).toLowerCase()
  if (SISTEM_TABLOLARI.test(tabanAd)) tabanAd = `t_${tabanAd}`
  const tablolar = tablolaraDagit(objeler, tabanAd, uyar)

  const tanim = KOORDINAT_SISTEMI_TANIMLARI.find((s) => s.kod === `EPSG:${srid}`)
  const wkt = SRS_TANIMLARI.get(srid)
  if (!tanim || !wkt) uyar(`EPSG:${srid} katalogda yok; spatial_ref_sys kaydı proj4/WKT tanımı olmadan ('Undefined') yazıldı.`)

  const SQL = await sqlJsYukle(ayar.sqlWasmUrl)
  const db = new SQL.Database()
  try {
    db.run('BEGIN')
    metaTablolariniKur(db)
    const srsEkle = 'INSERT INTO spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)'
    db.run(srsEkle, [-1, 'NONE', -1, 'Undefined - Cartesian', '', 'Undefined'])
    db.run(srsEkle, [0, 'NONE', 0, 'Undefined - Geographic Long/Lat', '', 'Undefined'])
    const wgs = KOORDINAT_SISTEMI_TANIMLARI.find((s) => s.kod === 'EPSG:4326')
    db.run(srsEkle, [4326, 'epsg', 4326, 'WGS 84', wgs.tanim, SRS_TANIMLARI.get(4326).tanim])
    if (srid > 0 && srid !== 4326) {
      db.run(srsEkle, [srid, 'epsg', srid, wkt?.ad ?? tanim?.ad ?? `EPSG:${srid}`, tanim?.tanim ?? '', wkt?.tanim ?? 'Undefined'])
    }
    tarihce(db, 'spatial_ref_sys', null, 'table successfully created')
    tarihce(db, 'geometry_columns', null, 'table successfully created')

    let bosSayisi = 0
    const ozetler = []
    for (const t of tablolar) {
      const geometrili = t.kayitlar.filter((k) => k.g)
      const z = geometrili.some((k) => geometriIncele(k.g).z)
      const tipKodu = TABLO_TIP_KODLARI[t.tip] + (z ? 1000 : 0)
      const sutunlar = sutunlariCikar(t.kayitlar.map((k) => k.f), uyar)
      const tanimlar = [
        `${tirnakla(KIMLIK_SUTUNU)} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL`,
        `${tirnakla(GEOMETRI_SUTUNU)} ${t.tip}`,
        ...sutunlar.map((s) => `${tirnakla(s.ad)} ${s.tip}`),
      ]
      db.run(`CREATE TABLE ${tirnakla(t.ad)} (${tanimlar.join(', ')})`)
      db.run('INSERT INTO geometry_columns VALUES (?, ?, ?, ?, ?, 0)', [t.ad, GEOMETRI_SUTUNU, tipKodu, z ? 3 : 2, srid])
      tarihce(db, t.ad, GEOMETRI_SUTUNU, `Geometry [${t.tip},${z ? 'XYZ' : 'XY'},SRID=${srid}] successfully created`)

      const ekle = db.prepare(
        `INSERT INTO ${tirnakla(t.ad)} (${[GEOMETRI_SUTUNU, ...sutunlar.map((s) => s.ad)].map(tirnakla).join(', ')}) ` +
          `VALUES (${Array(sutunlar.length + 1).fill('?').join(', ')})`,
      )
      try {
        for (const k of t.kayitlar) {
          let blob = null
          if (k.g) {
            blob = spatialiteGeometrisi(k.g, srid, z)
            if (!blob) bosSayisi++
          }
          const p = (k.f && k.f.properties) || {}
          ekle.run([blob, ...sutunlar.map((s) => degerDonustur(p[s.anahtar], s.tip))])
        }
      } finally {
        ekle.free()
      }
      ozetler.push({ ad: t.ad, tip: t.tip, z, sayi: t.kayitlar.length, sutunlar })
    }
    if (bosSayisi) uyar(`${bosSayisi} boş geometri SpatiaLite'ta temsil edilemediği için NULL yazıldı.`)
    db.run('COMMIT')

    const veri = db.export()
    const satirlar = [
      'SpatiaLite 4.x (SQLite)',
      `Koordinat sistemi: EPSG:${srid}${tanim ? ` – ${tanim.ad}` : ''}`,
      `Toplam obje: ${objeler.length}, tablo sayısı: ${ozetler.length}`,
      'Uzamsal indeks: yok (spatial_index_enabled = 0; gerekirse SpatiaLite/QGIS ile CreateSpatialIndex)',
      `Dosya boyutu: ${veri.length} bayt`,
    ]
    for (const o of ozetler) {
      satirlar.push(
        '',
        `Tablo: ${o.ad}`,
        `  Obje sayısı: ${o.sayi}`,
        `  Geometri tipi: ${o.tip}${o.z ? ' (XYZ)' : ''}`,
        `  Sütunlar: ${[`${KIMLIK_SUTUNU} INTEGER`, `${GEOMETRI_SUTUNU} ${o.tip}`, ...o.sutunlar.map((s) => `${s.ad} ${s.tip}`)].join(', ')}`,
      )
    }
    return { veri, onizleme: satirlar.join('\n'), uyarilar }
  } finally {
    db.close()
  }
}
