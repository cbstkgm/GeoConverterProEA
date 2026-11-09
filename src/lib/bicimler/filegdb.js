// Esri File Geodatabase (.gdb, OpenFileGDB / "FGDB 10", tablo sürümü 3) yazıcısı → <ad>.gdb/ klasörünü içeren ZIP.
//
// GDAL'ın OpenFileGDB sürücüsünün yeni bir veritabanı oluştururken yazdığı yapı birebir izlenir
// (ogropenfilegdbdatasource_write.cpp Create/CreateGDB*, ogropenfilegdblayer_write.cpp Create/RefreshXMLDefinition):
//   gdb (sürüm dosyası), timestamps,
//   a00000001 GDB_SystemCatalog, a00000002 GDB_DBTune, a00000003 GDB_SpatialRefs, a00000004 GDB_Items,
//   a00000005 GDB_ItemTypes, a00000006 GDB_ItemRelationships, a00000007 GDB_ItemRelationshipTypes
//   (a00000008 GDB_ReplicaLog yalnızca katalogda kayıtlıdır, dosyası yazılmaz — GDAL ile aynı),
//   a00000009… her katman için .gdbtable + .gdbtablx + .gdbindexes (FDO_OBJECTID).
// Uzamsal indeks (.spx) yazılmaz; katman XML'inde HasSpatialIndex=false (GDAL da false yazar).
//
// Katman/tip politikası GeoPackage ile ortaktır (geopackage.js tablolaraDagit → wkb.js geometriTipiPolitikasi):
// aynı ailede tekil+çoklu karışımı Multi'ye yükseltilir, farklı aileler aile başına ayrı katmana yazılır.
// FileGDB GeometryCollection saklayamadığından farklı aileden parçalar içeren koleksiyonlar aile başına
// ayrı objelere bölünür. Poligon ve çizgi katmanlarına Shape_Area / Shape_Length alanları eklenir.

import JSZip from 'jszip'
import { prjMetni } from './shapefile.js'
import { sridCoz, zVarMi } from './wkb.js'
import { AILELER, degerTipi, guvensizTamSayi, parcalaraAc, tablolaraDagit, tipBirlestir } from './geopackage.js'
import { ALAN, FgdbTablo, FgdbYazici, TABLO_GEOMETRISI, yeniGuid } from './filegdb/tablo.js'
import { fgdbGeometrisi } from './filegdb/geometri.js'
import { CALISMA_ALANI_TIPI, DBTUNE, ILISKI_TIPLERI, KLASOR_TIPI, KLASORDE_VERI_KUMESI, OBJE_SINIFI_TIPI, OGE_TIPLERI } from './filegdb/sistem.js'

const BILINMEYEN_SRS = '{B286C06B-0879-11D2-AACA-00C04FA33C20}'
const WGS84_ESRI =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
const AYRILMIS_SOZCUKLER = new Set(
  'ADD ALTER AND BETWEEN BY COLUMN CREATE DELETE DROP EXISTS FOR FROM GROUP IN INSERT INTO IS LIKE NOT NULL OR ORDER SELECT SET TABLE UPDATE VALUES WHERE'.split(' '),
)
const AYRILMIS_ALANLAR = ['OBJECTID', 'SHAPE', 'SHAPE_LENGTH', 'SHAPE_AREA']
const TURKCE_ASCII = { Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U', ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' }
const INT32 = 2147483647

// ---------------------------------------------------------------- adlar

/** ArcGIS ad kuralları: ASCII harf/rakam/_; harfle başlar; ayrılmış SQL sözcüklerine '_' eklenir. */
function fgdbAdi(ad, enCok) {
  let s = String(ad)
    .replace(/[ÇĞİÖŞÜçğıöşü]/g, (h) => TURKCE_ASCII[h])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]/g, '_')
  if (!/^[A-Za-z]/.test(s)) s = `F${s}`
  if (AYRILMIS_SOZCUKLER.has(s.toUpperCase())) s += '_'
  return s.slice(0, enCok)
}

// ---------------------------------------------------------------- değerler

const ISO_TARIH = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d)(\.\d+)?Z?)?$/
/** ISO 8601 → FileGDB tarih (1899-12-30'dan beri gün, double). */
function fgdbTarihi(s) {
  const m = ISO_TARIH.exec(s)
  if (!m) return null
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7] ? Math.round(Number(m[7]) * 1000) : 0)
  return ms / 86400000 + 25569
}

/** Öznitelik sütunlarını çıkarır (tip çıkarımı geopackage.js ile ortak). */
function sutunlar(objeler, uyar) {
  const tipler = new Map()
  const guvensiz = new Set()
  const int32Disi = new Set()
  const uzunluk = new Map()
  for (const f of objeler) {
    for (const [k, v] of Object.entries(f?.properties || {})) {
      if (!tipler.has(k)) tipler.set(k, null)
      if (v == null) continue
      if (guvensizTamSayi(v)) guvensiz.add(k)
      if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) > INT32) int32Disi.add(k)
      tipler.set(k, tipBirlestir(tipler.get(k), degerTipi(v)))
      const metin = typeof v === 'object' ? JSON.stringify(v) : String(v)
      uzunluk.set(k, Math.max(uzunluk.get(k) ?? 0, metin.length))
    }
  }
  const kullanilan = new Set(AYRILMIS_ALANLAR)
  const sonuc = []
  for (const [anahtar, tip] of tipler) {
    const temel = fgdbAdi(anahtar, 64)
    let ad = temel
    let n = 1
    while (kullanilan.has(ad.toUpperCase())) {
      const ek = `_${n++}`
      ad = `${temel.slice(0, 64 - ek.length)}${ek}`
    }
    kullanilan.add(ad.toUpperCase())
    if (ad !== anahtar) {
      const neden = AYRILMIS_ALANLAR.includes(temel.toUpperCase()) ? 'ayrılmış alan adı' : 'ArcGIS ad kuralları (ASCII harf/rakam/_, harfle başlar, en çok 64 karakter)'
      uyar(`"${anahtar}" özniteliği "${ad}" alanına yazıldı (${neden}).`)
    }
    let fgdbTip
    if (tip === 'INTEGER' && int32Disi.has(anahtar)) {
      fgdbTip = ALAN.FLOAT64
      uyar(`"${anahtar}" özniteliğinde 32 bit aralığını aşan tamsayılar var; Double alan olarak yazıldı.`)
    } else fgdbTip = { INTEGER: ALAN.INT32, REAL: ALAN.FLOAT64, BOOLEAN: ALAN.INT16, DATE: ALAN.DATETIME, DATETIME: ALAN.DATETIME }[tip] ?? ALAN.STRING
    if (guvensiz.has(anahtar)) uyar(`"${anahtar}" özniteliğinde ±2^53'ü aşan tamsayılar var; son basamaklarda hassasiyet kaybı olabilir.`)
    const genislik = fgdbTip === ALAN.STRING ? Math.max(255, uzunluk.get(anahtar) ?? 0) : undefined
    sonuc.push({ anahtar, ad, tip: fgdbTip, genislik, nullable: true, editable: true })
  }
  return sonuc
}

function degerCevir(v, s) {
  if (v == null) return null
  switch (s.tip) {
    case ALAN.INT16:
      return v ? 1 : 0
    case ALAN.INT32:
      return Number(v)
    case ALAN.FLOAT64:
      return Number.isFinite(Number(v)) ? Number(v) : null
    case ALAN.DATETIME:
      return fgdbTarihi(String(v))
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
}

// ---------------------------------------------------------------- XML

const xmlKacis = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const g17 = (v) => String(Number(v.toPrecision(17)))
const NS = 'http://www.esri.com/schemas/ArcGIS/10.3'
const ESRI_ALAN_TIPI = {
  [ALAN.INT16]: ['esriFieldTypeSmallInteger', 2],
  [ALAN.INT32]: ['esriFieldTypeInteger', 4],
  [ALAN.FLOAT64]: ['esriFieldTypeDouble', 8],
  [ALAN.DATETIME]: ['esriFieldTypeDate', 8],
}
const SEKIL_TIPI = {
  [TABLO_GEOMETRISI.NOKTA]: 'esriGeometryPoint',
  [TABLO_GEOMETRISI.COKLU_NOKTA]: 'esriGeometryMultipoint',
  [TABLO_GEOMETRISI.CIZGI]: 'esriGeometryPolyline',
  [TABLO_GEOMETRISI.POLIGON]: 'esriGeometryPolygon',
}

function alanXml(a) {
  const s = ['    <GPFieldInfoEx xsi:type="typens:GPFieldInfoEx">', `      <Name>${xmlKacis(a.ad)}</Name>`]
  if (a.tip === ALAN.OBJECTID) {
    s.push('      <FieldType>esriFieldTypeOID</FieldType>', '      <IsNullable>false</IsNullable>', '      <Length>4</Length>', '      <Precision>0</Precision>', '      <Scale>0</Scale>', '      <Required>true</Required>')
  } else if (a.tip === ALAN.GEOMETRY) {
    s.push('      <FieldType>esriFieldTypeGeometry</FieldType>', `      <IsNullable>${a.nullable}</IsNullable>`, '      <Length>0</Length>', '      <Precision>0</Precision>', '      <Scale>0</Scale>', '      <Required>true</Required>')
  } else {
    const [tipAdi, uzunluk] = a.tip === ALAN.STRING ? ['esriFieldTypeString', a.genislik] : ESRI_ALAN_TIPI[a.tip]
    s.push(`      <FieldType xmlns:typens="${NS}">${tipAdi}</FieldType>`)
    if (a.nullable) s.push('      <IsNullable>true</IsNullable>')
    if (a.required) s.push('      <Required>true</Required>')
    if (!a.editable) s.push('      <Editable>false</Editable>')
    s.push(`      <Length>${uzunluk}</Length>`, '      <Precision>0</Precision>', '      <Scale>0</Scale>')
  }
  s.push('    </GPFieldInfoEx>')
  return s
}

function katmanXml({ ad, dsid, alanlar, geometriTipi, z, geom, srid, cografi, alanAdi, uzunlukAdi }) {
  const srsTipi = geom.wkt === BILINMEYEN_SRS ? 'typens:UnknownCoordinateSystem' : cografi ? 'typens:GeographicCoordinateSystem' : 'typens:ProjectedCoordinateSystem'
  const s = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<typens:DEFeatureClassInfo xmlns:typens="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" xsi:type="typens:DEFeatureClassInfo">`,
    `  <CatalogPath>\\${xmlKacis(ad)}</CatalogPath>`,
    `  <Name>${xmlKacis(ad)}</Name>`,
    '  <ChildrenExpanded>false</ChildrenExpanded>',
    '  <DatasetType>esriDTFeatureClass</DatasetType>',
    `  <DSID>${dsid}</DSID>`,
    '  <Versioned>false</Versioned>',
    '  <CanVersion>false</CanVersion>',
    '  <HasOID>true</HasOID>',
    '  <OIDFieldName>OBJECTID</OIDFieldName>',
    '  <GPFieldInfoExs xsi:type="typens:ArrayOfGPFieldInfoEx">',
    ...alanlar.flatMap(alanXml),
    '  </GPFieldInfoExs>',
    '  <CLSID>{52353152-891A-11D0-BEC6-00805F7C4268}</CLSID>',
    '  <EXTCLSID></EXTCLSID>',
    '  <IsTimeInUTC>true</IsTimeInUTC>',
    '  <FeatureType>esriFTSimple</FeatureType>',
    `  <ShapeType>${SEKIL_TIPI[geometriTipi]}</ShapeType>`,
    '  <ShapeFieldName>SHAPE</ShapeFieldName>',
    '  <HasM>false</HasM>',
    `  <HasZ>${z}</HasZ>`,
    '  <HasSpatialIndex>false</HasSpatialIndex>',
    `  <AreaFieldName>${alanAdi}</AreaFieldName>`,
    `  <LengthFieldName>${uzunlukAdi}</LengthFieldName>`,
    '  <Extent xsi:nil="true"></Extent>',
    `  <SpatialReference xsi:type="${srsTipi}">`,
  ]
  if (geom.wkt !== BILINMEYEN_SRS) s.push(`    <WKT>${xmlKacis(geom.wkt)}</WKT>`)
  for (const [etiket, v] of [
    ['XOrigin', geom.xOrigin], ['YOrigin', geom.yOrigin], ['XYScale', geom.xyScale], ['ZOrigin', geom.zOrigin], ['ZScale', geom.zScale],
    ['MOrigin', geom.mOrigin], ['MScale', geom.mScale], ['XYTolerance', geom.xyTolerance], ['ZTolerance', geom.zTolerance], ['MTolerance', geom.mTolerance],
  ]) s.push(`    <${etiket}>${g17(v)}</${etiket}>`)
  s.push('    <HighPrecision>true</HighPrecision>')
  if (srid != null && geom.wkt !== BILINMEYEN_SRS) s.push(`    <WKID>${srid}</WKID>`, `    <LatestWKID>${srid}</LatestWKID>`)
  s.push('  </SpatialReference>', '</typens:DEFeatureClassInfo>')
  return s.join('\n')
}

const CALISMA_ALANI_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<DEWorkspace xmlns:typens="http://www.esri.com/schemas/ArcGIS/10.3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" xsi:type="typens:DEWorkspace">\n' +
  '  <CatalogPath>\\</CatalogPath>\n' +
  '  <Name/>\n' +
  '  <ChildrenExpanded>false</ChildrenExpanded>\n' +
  '  <WorkspaceType>esriLocalDatabaseWorkspace</WorkspaceType>\n' +
  '  <WorkspaceFactoryProgID/>\n' +
  '  <ConnectionString/>\n' +
  '  <ConnectionInfo xsi:nil="true"/>\n' +
  '  <Domains xsi:type="typens:ArrayOfDomain"/>\n' +
  '  <MajorVersion>3</MajorVersion>\n' +
  '  <MinorVersion>0</MinorVersion>\n' +
  '  <BugfixVersion>0</BugfixVersion>\n' +
  '</DEWorkspace>'

// ---------------------------------------------------------------- yardımcılar

const oid = (ad) => ({ ad, tip: ALAN.OBJECTID, required: true })
const metin = (ad, genislik, nullable) => ({ ad, tip: ALAN.STRING, genislik, nullable, editable: true })
const tam = (ad, nullable = true) => ({ ad, tip: ALAN.INT32, nullable, editable: true })
const gercel = (ad) => ({ ad, tip: ALAN.FLOAT64, nullable: true, editable: true })
const guid = (ad) => ({ ad, tip: ALAN.GUID, editable: true })
const globalId = (ad) => ({ ad, tip: ALAN.GLOBALID, required: true })
const xml = (ad) => ({ ad, tip: ALAN.XML, nullable: true, editable: true })

/** GDAL GDBGridSettingsFromOGR varsayılanları. */
function izgaraAyarlari(cografi, wkt) {
  const ortak = { wkt, zOrigin: -100000, zScale: 10000, zTolerance: 0.001, mOrigin: -100000, mScale: 10000, mTolerance: 0.001 }
  return cografi
    ? { ...ortak, xOrigin: -400, yOrigin: -400, xyScale: 1e9, xyTolerance: 8.983153e-9 }
    : { ...ortak, xOrigin: -2147483647, yOrigin: -2147483647, xyScale: 10000, xyTolerance: 0.001 }
}

/** GDAL ComputeOptimalSpatialIndexGridResolution ile aynı. */
function izgaraBoyu(tablo, noktaSayisi, enBuyukKapsam) {
  const k = tablo.kapsam
  if (Number.isNaN(k.minx)) return 0
  if (tablo.geometriTipi === TABLO_GEOMETRISI.NOKTA || tablo.geometriTipi === TABLO_GEOMETRISI.COKLU_NOKTA) {
    if (!noktaSayisi) return 0
    const alan = (k.maxx - k.minx) * (k.maxy - k.miny)
    if (alan !== 0) return Math.sqrt(alan / noktaSayisi)
    if (k.maxx > k.minx) return (k.maxx - k.minx) / noktaSayisi
    if (k.maxy > k.miny) return (k.maxy - k.miny) / noktaSayisi
    return 0
  }
  return enBuyukKapsam
}

/** Farklı aileden parçalar içeren GeometryCollection'ları aile başına objelere böler. */
function koleksiyonlariBol(objeler, uyar) {
  let bolunen = 0
  const sonuc = []
  for (const f of objeler) {
    const g = f?.geometry
    if (g?.type !== 'GeometryCollection') {
      sonuc.push(f)
      continue
    }
    const gruplar = new Map()
    for (const p of parcalaraAc(g)) {
      const aile = AILELER[p.type]
      if (!gruplar.has(aile)) gruplar.set(aile, [])
      gruplar.get(aile).push(p)
    }
    if (gruplar.size <= 1) {
      sonuc.push(f)
      continue
    }
    bolunen++
    for (const parcalar of gruplar.values()) sonuc.push({ ...f, geometry: { type: 'GeometryCollection', geometries: parcalar } })
  }
  if (bolunen) uyar(`FileGDB GeometryCollection saklayamaz: farklı geometri tipleri içeren ${bolunen} obje, aynı özniteliklerle tip başına ayrı objelere bölündü.`)
  return sonuc
}

const TIP_ESLEME = {
  POINT: TABLO_GEOMETRISI.NOKTA,
  MULTIPOINT: TABLO_GEOMETRISI.COKLU_NOKTA,
  LINESTRING: TABLO_GEOMETRISI.CIZGI,
  MULTILINESTRING: TABLO_GEOMETRISI.CIZGI,
  POLYGON: TABLO_GEOMETRISI.POLIGON,
  MULTIPOLYGON: TABLO_GEOMETRISI.POLIGON,
}
const dosyaAdi = (n) => `a${n.toString(16).padStart(8, '0')}`

function gdbIndeksleri() {
  const w = new FgdbYazici(64)
  const utf16 = (s) => {
    w.u32(s.length)
    for (let i = 0; i < s.length; i++) w.u16(s.charCodeAt(i))
  }
  w.u32(1)
  utf16('FDO_OBJECTID')
  w.u16(0)
  w.u32(16)
  w.u16(0xffff)
  w.u32(1)
  utf16('OBJECTID')
  w.u16(0)
  return w.sonuc()
}

// ---------------------------------------------------------------- ana yazıcı

/**
 * GeoJSON FeatureCollection'ı Esri File Geodatabase'e yazar; <ad>.gdb/ klasörünü içeren ZIP döndürür.
 * @param {object} fc FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler] crs ('EPSG:xxxx'), ad (varsayılan 'cikti'), katman (katman taban adı, varsayılan 'objeler')
 * @returns {Promise<{ veri: Uint8Array, onizleme: string, uyarilar: string[] }>}
 */
export async function filegdbYaz(fc, secenekler = {}) {
  const ayar = secenekler || {}
  const uyarilar = []
  const uyar = (m) => {
    if (!uyarilar.includes(m)) uyarilar.push(m)
  }
  let srid = sridCoz(ayar.crs)
  if (srid == null) {
    uyar('Koordinat sistemi belirtilmedi; File Geodatabase EPSG:4326 (WGS84) olarak yazıldı.')
    srid = 4326
  }
  let wkt = prjMetni(`EPSG:${srid}`)
  // ESRI WKT'sinde TOWGS84 bulunmaz (ArcGIS/GDAL FileGDB'ye yazarken eklemez).
  if (wkt) wkt = wkt.replace(/,TOWGS84\[[^\]]*\]/g, '')
  else uyar(`EPSG:${srid} için ESRI WKT tanımı bilinmiyor; katman "Unknown Coordinate System" olarak yazıldı.`)
  const cografi = wkt ? wkt.startsWith('GEOGCS') : false
  const geomAyar = izgaraAyarlari(cografi, wkt ?? BILINMEYEN_SRS)

  const gdbAdi = String(ayar.ad || 'cikti').replace(/\.gdb$/i, '').replace(/[\\/:*?"<>|]/g, '_') || 'cikti'
  const tabanAd = fgdbAdi(ayar.katman || 'objeler', 160)
  if (ayar.katman && tabanAd !== ayar.katman) uyar(`Katman adı "${ayar.katman}" yerine "${tabanAd}" kullanıldı (ArcGIS ad kuralları).`)
  const objeler = koleksiyonlariBol(Array.isArray(fc?.features) ? fc.features : [], uyar)
  const tablolar = tablolaraDagit(objeler, tabanAd, uyar)

  // ---- katman tabloları
  const katmanlar = []
  let bosGeometri = 0
  for (const t of tablolar) {
    let geometriTipi = TIP_ESLEME[t.tip]
    if (geometriTipi == null) {
      geometriTipi = TABLO_GEOMETRISI.NOKTA
      if (t.kayitlar.length) uyar(`"${t.ad}" katmanında geometrili obje yok; nokta katmanı olarak (boş geometrilerle) yazıldı.`)
    }
    const z = t.kayitlar.some((k) => k.g && zVarMi(k.g))
    const alanVar = geometriTipi === TABLO_GEOMETRISI.POLIGON
    const uzunlukVar = alanVar || geometriTipi === TABLO_GEOMETRISI.CIZGI
    const kullanici = sutunlar(t.kayitlar.map((k) => k.f), uyar)
    const alanlar = [
      { ad: 'SHAPE', tip: ALAN.GEOMETRY, nullable: true, required: true, editable: true, geom: geomAyar },
      oid('OBJECTID'),
      ...(alanVar ? [{ ad: 'Shape_Area', tip: ALAN.FLOAT64, nullable: true, required: true }] : []),
      ...(uzunlukVar ? [{ ad: 'Shape_Length', tip: ALAN.FLOAT64, nullable: true, required: true }] : []),
      ...kullanici,
    ]
    const tablo = new FgdbTablo({ geometriTipi, z, ofsetBoyu: 5, alanlar })
    let noktaSayisi = 0
    let enBuyukKapsam = 0
    for (const k of t.kayitlar) {
      let geo = null
      if (k.g) {
        // tekil aileli GeometryCollection tablolaraDagit'te Multi'ye çevrildi; burada yalnız basit tipler kalır
        geo = fgdbGeometrisi(k.g, geomAyar, z)
        if (!geo) bosGeometri++
      }
      if (geo) {
        tablo.kapsamaEkle(geo.kapsam)
        noktaSayisi += geo.noktaSayisi
        enBuyukKapsam = Math.max(enBuyukKapsam, geo.kapsam.maxx - geo.kapsam.minx, geo.kapsam.maxy - geo.kapsam.miny)
      }
      const p = k.f?.properties || {}
      tablo.satirEkle([
        geo ? geo.blob : null,
        null,
        ...(alanVar ? [geo ? geo.alan : null] : []),
        ...(uzunlukVar ? [geo ? geo.uzunluk : null] : []),
        ...kullanici.map((s) => degerCevir(p[s.anahtar], s)),
      ])
    }
    tablo.izgara = [izgaraBoyu(tablo, geometriTipi === TABLO_GEOMETRISI.NOKTA ? t.kayitlar.filter((k) => k.g).length : noktaSayisi, enBuyukKapsam)]
    katmanlar.push({ ad: t.ad, tablo, alanlar, geometriTipi, z, alanVar, uzunlukVar, kullanici, sayi: t.kayitlar.length })
  }
  if (bosGeometri) uyar(`${bosGeometri} boş geometri NULL olarak yazıldı.`)

  // ---- sistem tabloları
  const dosyalar = {}
  const ekle = (n, tablo) => {
    const { gdbtable, gdbtablx } = tablo.dosyalar()
    dosyalar[`${dosyaAdi(n)}.gdbtable`] = gdbtable
    dosyalar[`${dosyaAdi(n)}.gdbtablx`] = gdbtablx
  }

  const katalog = new FgdbTablo({ alanlar: [oid('ID'), metin('Name', 160, false), { ...tam('FileFormat', false) }] })
  for (const [ad, bicim] of [
    ['GDB_SystemCatalog', 0], ['GDB_DBTune', 0], ['GDB_SpatialRefs', 0], ['GDB_Items', 0], ['GDB_ItemTypes', 0],
    ['GDB_ItemRelationships', 0], ['GDB_ItemRelationshipTypes', 0], ['GDB_ReplicaLog', 2],
  ]) katalog.satirEkle([null, ad, bicim])
  for (const k of katmanlar) katalog.satirEkle([null, k.ad, 0])
  ekle(1, katalog)

  const dbtune = new FgdbTablo({ alanlar: [metin('Keyword', 32, false), metin('ParameterName', 32, false), metin('ConfigString', 2048, true)] })
  for (const r of DBTUNE) dbtune.satirEkle(r)
  ekle(2, dbtune)

  const srsAlanlari = ['FalseX', 'FalseY', 'XYUnits', 'FalseZ', 'ZUnits', 'FalseM', 'MUnits', 'XYTolerance', 'ZTolerance', 'MTolerance']
  const srs = new FgdbTablo({ alanlar: [oid('ID'), metin('SRTEXT', 2048, false), ...srsAlanlari.map(gercel)] })
  const srsSatiri = (g) => [null, g.wkt, g.xOrigin, g.yOrigin, g.xyScale, g.zOrigin, g.zScale, g.mOrigin, g.mScale, g.xyTolerance, g.zTolerance, g.mTolerance]
  const ogeGeom = { ...izgaraAyarlari(true, WGS84_ESRI), xOrigin: -180, yOrigin: -90, xyScale: 1000000, xyTolerance: 0.000002 }
  srs.satirEkle(srsSatiri(ogeGeom))
  if (katmanlar.length) srs.satirEkle(srsSatiri(geomAyar))
  ekle(3, srs)

  const ogeler = new FgdbTablo({
    geometriTipi: TABLO_GEOMETRISI.POLIGON,
    alanlar: [
      oid('ObjectID'), globalId('UUID'), guid('Type'), metin('Name', 160, true), metin('PhysicalName', 160, true), metin('Path', 260, true),
      tam('DatasetSubtype1'), tam('DatasetSubtype2'), metin('DatasetInfo1', 255, true), metin('DatasetInfo2', 255, true), metin('URL', 255, true),
      xml('Definition'), xml('Documentation'), xml('ItemInfo'), tam('Properties'), { ad: 'Defaults', tip: ALAN.BINARY, nullable: true, editable: true },
      { ad: 'Shape', tip: ALAN.GEOMETRY, nullable: true, required: true, editable: true, geom: ogeGeom },
    ],
  })
  ogeler.izgara = [0.012, 0.4, 12.0]
  const kokGuid = yeniGuid()
  ogeler.satirEkle([null, kokGuid, KLASOR_TIPI, '', '', '\\', null, null, null, null, '', null, null, null, 1, null, null])
  ogeler.satirEkle([null, yeniGuid(), CALISMA_ALANI_TIPI, 'Workspace', 'WORKSPACE', '', null, null, null, null, '', CALISMA_ALANI_XML, null, null, 0, null, null])

  const iliskiler = new FgdbTablo({
    alanlar: [oid('ObjectID'), globalId('UUID'), guid('OriginID'), guid('DestID'), guid('Type'), xml('Attributes'), tam('Properties')],
  })

  katmanlar.forEach((k, i) => {
    const katmanGuid = yeniGuid()
    const tanim = katmanXml({
      ad: k.ad,
      dsid: 3 + i,
      alanlar: k.alanlar,
      geometriTipi: k.geometriTipi,
      z: k.z,
      geom: geomAyar,
      srid: wkt ? srid : null,
      cografi,
      alanAdi: k.alanVar ? 'Shape_Area' : '',
      uzunlukAdi: k.uzunlukVar ? 'Shape_Length' : '',
    })
    iliskiler.satirEkle([null, yeniGuid(), kokGuid, katmanGuid, KLASORDE_VERI_KUMESI, null, 1])
    ogeler.satirEkle([null, katmanGuid, OBJE_SINIFI_TIPI, k.ad, k.ad.toUpperCase(), `\\${k.ad}`, 1, k.geometriTipi, 'SHAPE', null, '', tanim, null, null, 1, null, null])
    const n = 9 + i
    ekle(n, k.tablo)
    dosyalar[`${dosyaAdi(n)}.gdbindexes`] = gdbIndeksleri()
  })
  ekle(4, ogeler)

  const tipler = new FgdbTablo({ alanlar: [oid('ObjectID'), guid('UUID'), guid('ParentTypeID'), metin('Name', 160, false)] })
  for (const r of OGE_TIPLERI) tipler.satirEkle([null, ...r])
  ekle(5, tipler)
  ekle(6, iliskiler)

  const iliskiTipleri = new FgdbTablo({
    alanlar: [
      oid('ObjectID'), guid('UUID'), guid('OrigItemTypeID'), guid('DestItemTypeID'), metin('Name', 160, true), metin('ForwardLabel', 255, true),
      metin('BackwardLabel', 255, true), { ad: 'IsContainment', tip: ALAN.INT16, nullable: true, editable: true },
    ],
  })
  for (const r of ILISKI_TIPLERI) iliskiTipleri.satirEkle([null, ...r])
  ekle(7, iliskiTipleri)

  dosyalar.gdb = Uint8Array.of(0x05, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef)
  dosyalar.timestamps = new Uint8Array(400).fill(0xff)

  // ---- ZIP
  const zip = new JSZip()
  const klasor = zip.folder(`${gdbAdi}.gdb`)
  for (const ad of Object.keys(dosyalar).sort()) klasor.file(ad, dosyalar[ad])
  const veri = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })

  const satirlar = [
    `Esri File Geodatabase (OpenFileGDB, ArcGIS 10.x biçimi) – ${gdbAdi}.gdb (ZIP)`,
    `Koordinat sistemi: EPSG:${srid}${wkt ? '' : ' (bilinmiyor)'}`,
    `Katman sayısı: ${katmanlar.length}, ZIP boyutu: ${veri.length} bayt`,
  ]
  for (const k of katmanlar) {
    satirlar.push(
      '',
      `Katman: ${k.ad} (${dosyaAdi(katmanlar.indexOf(k) + 9)}.gdbtable)`,
      `  Geometri: ${SEKIL_TIPI[k.geometriTipi]}${k.z ? ' (Z)' : ''}, obje: ${k.sayi}`,
      `  Alanlar: ${k.alanlar.map((a) => a.ad).join(', ')}`,
    )
  }
  return { veri, onizleme: satirlar.join('\n'), uyarilar }
}
