// OGC GeoPackage 1.3 (.gpkg) yazıcısı.
// SQLite veritabanı sql.js (WASM) ile bellekte kurulur; DOM/window kullanılmaz,
// Web Worker ve Node (Vitest) altında çalışır.
//
// Yapı: zorunlu gpkg_spatial_ref_sys / gpkg_contents / gpkg_geometry_columns tabloları
// + tek obje tablosu (fid, geom, öznitelikler). Geometriler GeoPackageBinary başlığı + ISO WKB.
// Not: sql.js derlemesinde SQLite rtree modülü bulunmadığından R-tree uzamsal indeks yazılmaz
// (indeks isteğe bağlıdır; QGIS/GDAL dosyayı indekssiz açar, gerekirse kendisi oluşturur).

const GPKG_APPLICATION_ID = 0x47504b47 // 'GPKG'
const GPKG_USER_VERSION = 10300 // 1.3.0
const VARSAYILAN_TABLO = 'objeler'
const GEOMETRI_SUTUNU = 'geom'
const KIMLIK_SUTUNU = 'fid'

// ---------------------------------------------------------------------------
// sql.js başlatma (modül düzeyinde önbellek)
// ---------------------------------------------------------------------------

let sqlSozu = null

/**
 * sql.js'i bir kez yükler. Tarayıcı/worker'da `sqlWasmUrl` verilmelidir (Vite: `?url` import);
 * verilmezse paket kendi konumundan yükler (Node).
 */
function sqlJsYukle(sqlWasmUrl) {
  if (!sqlSozu) {
    sqlSozu = (async () => {
      const modul = await import('sql.js')
      const initSqlJs = modul.default ?? modul
      const ayar = sqlWasmUrl ? { locateFile: () => sqlWasmUrl } : {}
      return initSqlJs(ayar)
    })()
    // Başarısız yükleme önbellekte kalmasın; sonraki çağrı yeniden denesin.
    sqlSozu.catch(() => {
      sqlSozu = null
    })
  }
  return sqlSozu
}

// ---------------------------------------------------------------------------
// Koordinat sistemleri (OGC WKT 1)
// ---------------------------------------------------------------------------

const yetki = (kod) => `AUTHORITY["EPSG","${kod}"]`
const DERECE = `UNIT["degree",0.0174532925199433,${yetki(9122)}]`
const METRE = `UNIT["metre",1,${yetki(9001)}]`
const GREENWICH = `PRIMEM["Greenwich",0,${yetki(8901)}]`
const EN_BOY = 'AXIS["Easting",EAST],AXIS["Northing",NORTH]'

const WGS84_GEOGCS =
  `GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,${yetki(7030)}],${yetki(6326)}],` +
  `${GREENWICH},${DERECE},AXIS["Latitude",NORTH],AXIS["Longitude",EAST],${yetki(4326)}]`

// TUREF (ITRF96 tabanlı), katalog.js ile aynı: towgs84 = 0.
const TUREF_GEOGCS =
  `GEOGCS["TUREF",DATUM["Turkish_National_Reference_Frame",SPHEROID["GRS 1980",6378137,298.257222101,${yetki(7019)}],` +
  `TOWGS84[0,0,0,0,0,0,0],${yetki(1057)}],${GREENWICH},${DERECE},${yetki(5252)}]`

// ED50, katalog.js'teki Türkiye parametreleri (EPSG:1784) ile.
const ED50_GEOGCS =
  `GEOGCS["ED50",DATUM["European_Datum_1950",SPHEROID["International 1924",6378388,297,${yetki(7022)}],` +
  `TOWGS84[-84.1,-101.8,-129.7,0,0,0.468,1.05],${yetki(6230)}],${GREENWICH},${DERECE},${yetki(4230)}]`

const tmerc = (ad, geogcs, dom, olcek, kod) =>
  `PROJCS["${ad}",${geogcs},PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],` +
  `PARAMETER["central_meridian",${dom}],PARAMETER["scale_factor",${olcek}],PARAMETER["false_easting",500000],` +
  `PARAMETER["false_northing",0],${METRE},${EN_BOY},${yetki(kod)}]`

/** srs_id → { ad, tanim, aciklama } */
const SRS_TANIMLARI = new Map([
  [4326, { ad: 'WGS 84 geodetic', tanim: WGS84_GEOGCS, aciklama: 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid' }],
  [
    3857,
    {
      ad: 'WGS 84 / Pseudo-Mercator',
      tanim:
        `PROJCS["WGS 84 / Pseudo-Mercator",${WGS84_GEOGCS},PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],` +
        `PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],${METRE},${EN_BOY},` +
        `EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"],${yetki(3857)}]`,
      aciklama: 'WGS 84 / Web Mercator',
    },
  ],
])
;[27, 30, 33, 36, 39, 42, 45].forEach((dom, i) => {
  const kod = 5253 + i
  SRS_TANIMLARI.set(kod, { ad: `TUREF / TM${dom}`, tanim: tmerc(`TUREF / TM${dom}`, TUREF_GEOGCS, dom, 1, kod), aciklama: `ITRF96 / 3° TM ${dom}` })
})
;[35, 36, 37, 38].forEach((zon) => {
  const kod = 23000 + zon
  const ad = `ED50 / UTM zone ${zon}N`
  SRS_TANIMLARI.set(kod, { ad, tanim: tmerc(ad, ED50_GEOGCS, zon * 6 - 183, 0.9996, kod), aciklama: ad })
})

function srsCoz(crs, uyarilar) {
  if (crs == null || crs === '') {
    uyarilar.push('Hedef koordinat sistemi belirtilmedi; GeoPackage EPSG:4326 (WGS84) olarak yazıldı.')
    return 4326
  }
  const m = /^\s*(?:EPSG\s*:\s*)?(\d+)\s*$/i.exec(String(crs))
  if (!m) {
    uyarilar.push(`Koordinat sistemi "${crs}" tanınmadı; GeoPackage EPSG:4326 (WGS84) olarak yazıldı.`)
    return 4326
  }
  return Number(m[1])
}

// ---------------------------------------------------------------------------
// Geometri: ISO WKB + GeoPackageBinary
// ---------------------------------------------------------------------------

const WKB_KODLARI = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 }

/** Basit büyüyen little-endian bayt yazıcı. */
class BaytYazici {
  constructor(boyut = 256) {
    this.tampon = new Uint8Array(boyut)
    this.dv = new DataView(this.tampon.buffer)
    this.o = 0
  }
  yer(n) {
    if (this.o + n <= this.tampon.length) return
    let yeni = this.tampon.length * 2
    while (yeni < this.o + n) yeni *= 2
    const t = new Uint8Array(yeni)
    t.set(this.tampon.subarray(0, this.o))
    this.tampon = t
    this.dv = new DataView(t.buffer)
  }
  u8(v) {
    this.yer(1)
    this.dv.setUint8(this.o, v)
    this.o += 1
  }
  u32(v) {
    this.yer(4)
    this.dv.setUint32(this.o, v, true)
    this.o += 4
  }
  i32(v) {
    this.yer(4)
    this.dv.setInt32(this.o, v, true)
    this.o += 4
  }
  f64(v) {
    this.yer(8)
    this.dv.setFloat64(this.o, v, true)
    this.o += 8
  }
  sonuc() {
    return this.tampon.slice(0, this.o)
  }
}

/** Geometrideki tüm konumları gezer. */
function konumlariGez(g, fn) {
  if (!g) return
  if (g.type === 'GeometryCollection') {
    for (const alt of g.geometries || []) konumlariGez(alt, fn)
    return
  }
  const gez = (c, derinlik) => {
    if (!Array.isArray(c)) return
    if (derinlik === 0) fn(c)
    else for (const k of c) gez(k, derinlik - 1)
  }
  const derinlik = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 }[g.type]
  if (derinlik === undefined) throw new Error(`desteklenmeyen geometri tipi: ${g.type}`)
  if (g.type === 'Point') {
    if (Array.isArray(g.coordinates) && g.coordinates.length) fn(g.coordinates)
  } else gez(g.coordinates, derinlik)
}

/** Geometriyi inceler: Z var mı, M (4. boyut) var mı, zarf, boş mu, sayılar geçerli mi. */
function geometriIncele(g) {
  let z = false
  let m = false
  let sayi = 0
  const zarf = { minx: Infinity, maxx: -Infinity, miny: Infinity, maxy: -Infinity, minz: Infinity, maxz: -Infinity }
  konumlariGez(g, (k) => {
    if (k.length < 2 || !Number.isFinite(k[0]) || !Number.isFinite(k[1])) throw new Error('geçersiz koordinat (sayı olmayan veya eksik değer)')
    if (k.length >= 3) {
      if (!Number.isFinite(k[2])) throw new Error('geçersiz Z değeri')
      z = true
      if (k[2] < zarf.minz) zarf.minz = k[2]
      if (k[2] > zarf.maxz) zarf.maxz = k[2]
    }
    if (k.length >= 4) m = true
    sayi++
    if (k[0] < zarf.minx) zarf.minx = k[0]
    if (k[0] > zarf.maxx) zarf.maxx = k[0]
    if (k[1] < zarf.miny) zarf.miny = k[1]
    if (k[1] > zarf.maxy) zarf.maxy = k[1]
  })
  return { z, m, bos: sayi === 0, zarf }
}

/** ISO WKB (little-endian) yazar; z true ise tüm alt geometriler Z'li (+1000) yazılır. */
function wkbYaz(w, g, z) {
  const kod = WKB_KODLARI[g.type]
  if (!kod) throw new Error(`desteklenmeyen geometri tipi: ${g.type}`)
  w.u8(1)
  w.u32(kod + (z ? 1000 : 0))
  const konum = (k) => {
    w.f64(k[0])
    w.f64(k[1])
    if (z) w.f64(k.length >= 3 ? k[2] : 0)
  }
  const konumlar = (c) => {
    const d = Array.isArray(c) ? c : []
    w.u32(d.length)
    d.forEach(konum)
  }
  const halkalar = (c) => {
    const d = Array.isArray(c) ? c : []
    w.u32(d.length)
    d.forEach(konumlar)
  }
  const c = g.coordinates
  switch (g.type) {
    case 'Point':
      // Boş nokta: ISO/GeoPackage kuralı NaN koordinat.
      if (Array.isArray(c) && c.length >= 2) konum(c)
      else konum(z ? [NaN, NaN, NaN] : [NaN, NaN])
      break
    case 'LineString':
      konumlar(c)
      break
    case 'Polygon':
      halkalar(c)
      break
    case 'MultiPoint': {
      const d = (Array.isArray(c) ? c : []).filter((k) => Array.isArray(k) && k.length >= 2)
      w.u32(d.length)
      d.forEach((k) => wkbYaz(w, { type: 'Point', coordinates: k }, z))
      break
    }
    case 'MultiLineString': {
      const d = Array.isArray(c) ? c : []
      w.u32(d.length)
      d.forEach((k) => wkbYaz(w, { type: 'LineString', coordinates: k }, z))
      break
    }
    case 'MultiPolygon': {
      const d = Array.isArray(c) ? c : []
      w.u32(d.length)
      d.forEach((k) => wkbYaz(w, { type: 'Polygon', coordinates: k }, z))
      break
    }
    case 'GeometryCollection': {
      const d = (g.geometries || []).filter(Boolean)
      w.u32(d.length)
      d.forEach((alt) => wkbYaz(w, alt, z))
      break
    }
  }
}

/**
 * GeoJSON geometrisini GeoPackageBinary BLOB'una çevirir.
 * @returns {{ blob: Uint8Array, bilgi: ReturnType<typeof geometriIncele> }}
 */
export function geopackageGeometrisi(g, srsId) {
  const bilgi = geometriIncele(g)
  const zarfTipi = bilgi.bos ? 0 : bilgi.z ? 2 : 1
  const w = new BaytYazici(64)
  w.u8(0x47) // 'G'
  w.u8(0x50) // 'P'
  w.u8(0) // sürüm 0 (1.x)
  // bayraklar: bit0 = little-endian, bit1-3 = zarf tipi, bit4 = boş geometri, bit5 = standart (0)
  w.u8(1 | (zarfTipi << 1) | ((bilgi.bos ? 1 : 0) << 4))
  w.i32(srsId)
  if (zarfTipi) {
    const e = bilgi.zarf
    w.f64(e.minx)
    w.f64(e.maxx)
    w.f64(e.miny)
    w.f64(e.maxy)
    if (zarfTipi === 2) {
      w.f64(e.minz)
      w.f64(e.maxz)
    }
  }
  wkbYaz(w, g, bilgi.z)
  return { blob: w.sonuc(), bilgi }
}

// ---------------------------------------------------------------------------
// Geometri aileleri, Multi'ye yükseltme ve tablo bölme
// ---------------------------------------------------------------------------

const AILE_SIRASI = ['nokta', 'cizgi', 'poligon', 'karisik']
const AILELER = {
  Point: 'nokta',
  MultiPoint: 'nokta',
  LineString: 'cizgi',
  MultiLineString: 'cizgi',
  Polygon: 'poligon',
  MultiPolygon: 'poligon',
}
const TEKIL_COKLU = { Point: 'MultiPoint', LineString: 'MultiLineString', Polygon: 'MultiPolygon' }
const AILE_COKLU = { nokta: 'MultiPoint', cizgi: 'MultiLineString', poligon: 'MultiPolygon' }

const dolu = (c) => Array.isArray(c) && c.length > 0

/** GeometryCollection'ı (iç içe olanlar dahil) boş olmayan basit parçalarına açar. */
function parcalaraAc(g, cikti = []) {
  if (!g) return cikti
  if (g.type === 'GeometryCollection') for (const alt of g.geometries || []) parcalaraAc(alt, cikti)
  else if (dolu(g.coordinates)) cikti.push(g)
  return cikti
}

/** Basit parçaları tek ailenin Multi geometrisinde birleştirir. */
function multiyeBirlestir(aile, parcalar) {
  const coordinates = []
  for (const p of parcalar) {
    if (TEKIL_COKLU[p.type]) coordinates.push(p.coordinates)
    else coordinates.push(...p.coordinates)
  }
  return { type: AILE_COKLU[aile], coordinates }
}

/** Tekil geometriyi aynı ailenin çoklusuna yükseltir (ogr2ogr -nlt PROMOTE_TO_MULTI). */
function multiyeYukselt(g) {
  const coklu = TEKIL_COKLU[g.type]
  if (!coklu) return g
  return { type: coklu, coordinates: dolu(g.coordinates) ? [g.coordinates] : [] }
}

// ---------------------------------------------------------------------------
// Öznitelik sütunları
// ---------------------------------------------------------------------------

const tirnakla = (ad) => `"${String(ad).replace(/"/g, '""')}"`
const TARIH = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const TARIH_ZAMAN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?Z?$/

function degerTipi(v) {
  if (typeof v === 'boolean') return 'BOOLEAN'
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v)) return 'INTEGER'
    return Number.isFinite(v) ? 'REAL' : 'TEXT'
  }
  if (typeof v === 'bigint') return guvensizTamSayi(v) ? 'REAL' : 'INTEGER'
  if (typeof v === 'string') {
    if (TARIH.test(v)) return 'DATE'
    if (TARIH_ZAMAN.test(v)) return 'DATETIME'
  }
  return 'TEXT'
}

/** Değer tam sayı ama 2^53'ü aşıyor mu (double'da birebir saklanamaz)? */
const guvensizTamSayi = (v) =>
  (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) ||
  (typeof v === 'bigint' && (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)))

function tipBirlestir(a, b) {
  if (!a) return b
  if (a === b) return a
  if ((a === 'INTEGER' && b === 'REAL') || (a === 'REAL' && b === 'INTEGER')) return 'REAL'
  return 'TEXT'
}

/**
 * Öznitelik anahtarlarından SQLite sütunlarını çıkarır. SQLite sütun adları büyük/küçük harf
 * duyarsızdır; rezerve adlar (fid, geom) ve çakışmalar `_1`, `_2`… ekiyle çözülür.
 */
function sutunlariCikar(objeler, uyar) {
  const tipler = new Map() // anahtar → tip
  const guvensiz = new Set()
  for (const f of objeler) {
    const p = f && f.properties
    if (!p || typeof p !== 'object') continue
    for (const [k, v] of Object.entries(p)) {
      if (!tipler.has(k)) tipler.set(k, null)
      if (v == null) continue
      if (guvensizTamSayi(v)) guvensiz.add(k)
      tipler.set(k, tipBirlestir(tipler.get(k), degerTipi(v)))
    }
  }
  const kullanilan = new Set([KIMLIK_SUTUNU, GEOMETRI_SUTUNU])
  const sutunlar = []
  for (const [anahtar, tip] of tipler) {
    const temel = anahtar.trim() === '' ? 'alan' : anahtar
    let ad = temel
    let n = 1
    while (kullanilan.has(ad.toLowerCase())) ad = `${temel}_${n++}`
    if (ad !== anahtar) {
      const neden = [KIMLIK_SUTUNU, GEOMETRI_SUTUNU].includes(anahtar.toLowerCase())
        ? 'GeoPackage için rezerve sütun adı'
        : anahtar.trim() === ''
          ? 'boş sütun adı'
          : 'başka bir sütunla çakışıyor (SQLite sütun adları büyük/küçük harf duyarsız)'
      uyar(`"${anahtar}" özniteliği "${ad}" sütununa yazıldı (${neden}).`)
    }
    if (guvensiz.has(anahtar)) {
      uyar(`"${anahtar}" özniteliğinde ±2^53'ü aşan tam sayılar var; ${tip === 'TEXT' ? 'metin' : 'REAL (64-bit double)'} olarak yazıldı, son basamaklarda hassasiyet kaybı olabilir.`)
    }
    kullanilan.add(ad.toLowerCase())
    sutunlar.push({ anahtar, ad, tip: tip || 'TEXT' })
  }
  return sutunlar
}

function degerDonustur(v, tip) {
  if (v == null) return null
  if (typeof v === 'object') return JSON.stringify(v)
  switch (tip) {
    case 'BOOLEAN':
      return v ? 1 : 0
    case 'INTEGER':
    case 'REAL':
      return typeof v === 'bigint' ? Number(v) : v
    default:
      return typeof v === 'number' && !Number.isFinite(v) ? null : String(v)
  }
}

function tabloAdiBelirle(istenen, uyar) {
  if (istenen == null || istenen === '') return VARSAYILAN_TABLO
  let ad = String(istenen).trim().replace(/[^\p{L}\p{N}_]/gu, '_')
  if (!/^\p{L}/u.test(ad)) ad = `t_${ad}`
  if (/^(gpkg_|rtree_|sqlite_)/i.test(ad)) ad = `t_${ad}`
  if (ad !== istenen) uyar(`Tablo adı "${istenen}" yerine "${ad}" kullanıldı.`)
  return ad
}

/**
 * Objeleri geometri ailesine göre tablolara dağıtır.
 * - Tek aile (veya hiç geometri yok): tek tablo, ad = taban ad.
 * - Birden çok aile: `<taban>_nokta|_cizgi|_poligon|_karisik`, yalnızca dolu olanlar.
 * - GeometryCollection: parçaları tek aileden ise o ailenin Multi'sine çevrilir, değilse `_karisik`.
 * - null/boş/yazılamayan geometriler: ilk tabloya NULL geom ile (öznitelikleri kaybolmasın;
 *   yalnızca bunlar için GEOMETRY tipli ek tablo açmak ArcGIS uyumunu bozardı).
 */
function tablolaraDagit(objeler, tabanAd, uyar) {
  const kayitlar = [] // { f, g, aile }
  let gecersiz = 0
  let gcCevrildi = 0
  let gcKarisik = 0
  let gcBos = 0
  objeler.forEach((f, i) => {
    let g = f?.geometry || null
    let aile = null
    if (g) {
      try {
        geometriIncele(g) // tip ve koordinat denetimi
        if (g.type === 'GeometryCollection') {
          const parcalar = parcalaraAc(g)
          const aileler = new Set(parcalar.map((p) => AILELER[p.type]))
          if (aileler.size === 0) {
            g = null
            gcBos++
          } else if (aileler.size === 1) {
            aile = [...aileler][0]
            g = multiyeBirlestir(aile, parcalar)
            gcCevrildi++
          } else {
            aile = 'karisik'
            gcKarisik++
          }
        } else aile = AILELER[g.type]
      } catch (e) {
        gecersiz++
        if (gecersiz <= 5) uyar(`${i + 1}. objenin geometrisi yazılamadı (${e.message}); geometrisi boş (NULL) bırakıldı.`)
        g = null
      }
    }
    kayitlar.push({ f, g, aile })
  })
  if (gecersiz > 5) uyar(`Toplam ${gecersiz} objenin geometrisi yazılamadı.`)
  if (gcCevrildi) uyar(`${gcCevrildi} GeometryCollection tek aileden parçalar içerdiği için Multi geometriye çevrildi.`)
  if (gcBos) uyar(`${gcBos} boş GeometryCollection NULL geometri olarak yazıldı.`)

  const aileler = AILE_SIRASI.filter((a) => kayitlar.some((k) => k.aile === a))
  const cokTablo = aileler.length > 1
  const tablolar = (aileler.length ? aileler : [null]).map((aile) => ({
    aile,
    ad: cokTablo ? `${tabanAd}_${aile}` : tabanAd,
    kayitlar: [],
  }))
  const tabloBul = new Map(tablolar.map((t) => [t.aile, t]))
  let geometrisiz = 0
  for (const k of kayitlar) {
    if (k.aile) tabloBul.get(k.aile).kayitlar.push(k)
    else {
      tablolar[0].kayitlar.push(k)
      geometrisiz++
    }
  }
  if (cokTablo) {
    uyar(`Farklı geometri aileleri bulundu; objeler ${tablolar.length} tabloya bölündü: ${tablolar.map((t) => `${t.ad} (${t.kayitlar.length})`).join(', ')}.`)
    if (geometrisiz) uyar(`Geometrisi olmayan ${geometrisiz} obje "${tablolar[0].ad}" tablosuna NULL geometriyle yazıldı.`)
  }
  if (gcKarisik) uyar(`${gcKarisik} GeometryCollection farklı aileden parçalar içerdiği için "${tabloBul.get('karisik').ad}" (GEOMETRY tipli) tablosuna yazıldı.`)

  // Tablo tipi: aynı ailede tekil+çoklu karışıksa Multi'ye yükselt.
  for (const t of tablolar) {
    const tipler = new Set(t.kayitlar.filter((k) => k.g).map((k) => k.g.type))
    if (!t.aile || t.aile === 'karisik' || tipler.size === 0) {
      t.tip = t.aile && t.aile !== 'karisik' && tipler.size === 1 ? [...tipler][0].toUpperCase() : 'GEOMETRY'
      continue
    }
    if (tipler.size > 1) {
      let yukseltilen = 0
      for (const k of t.kayitlar) {
        if (k.g && TEKIL_COKLU[k.g.type]) {
          k.g = multiyeYukselt(k.g)
          yukseltilen++
        }
      }
      t.tip = AILE_COKLU[t.aile].toUpperCase()
      uyar(`"${t.ad}" tablosunda tekil ve çoklu geometriler karışık; ${yukseltilen} tekil geometri ${AILE_COKLU[t.aile]} tipine yükseltildi.`)
    } else t.tip = [...tipler][0].toUpperCase()
  }
  return tablolar
}

// ---------------------------------------------------------------------------
// Ana yazıcı
// ---------------------------------------------------------------------------

const SRS_EKLE = 'INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)'

function sistemTablolariniKur(db) {
  db.run(`CREATE TABLE gpkg_spatial_ref_sys (
    srs_name TEXT NOT NULL,
    srs_id INTEGER PRIMARY KEY,
    organization TEXT NOT NULL,
    organization_coordsys_id INTEGER NOT NULL,
    definition TEXT NOT NULL,
    description TEXT)`)
  db.run(`CREATE TABLE gpkg_contents (
    table_name TEXT NOT NULL PRIMARY KEY,
    data_type TEXT NOT NULL,
    identifier TEXT UNIQUE,
    description TEXT DEFAULT '',
    last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
    srs_id INTEGER,
    CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))`)
  db.run(`CREATE TABLE gpkg_geometry_columns (
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    geometry_type_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL,
    z TINYINT NOT NULL,
    m TINYINT NOT NULL,
    CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
    CONSTRAINT uk_gc_table_name UNIQUE (table_name),
    CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
    CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id))`)
  db.run(SRS_EKLE, ['Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system'])
  db.run(SRS_EKLE, ['Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system'])
  const w = SRS_TANIMLARI.get(4326)
  db.run(SRS_EKLE, [w.ad, 4326, 'EPSG', 4326, w.tanim, w.aciklama])
}

/** Bir obje tablosunu geometrileri kodlayarak yazar; özet bilgiyi döndürür. */
function objeTablosuYaz(db, tablo, srsId, uyar) {
  const kz = { zVar: false, zYok: false, mAtildi: false }
  const toplam = { minx: Infinity, maxx: -Infinity, miny: Infinity, maxy: -Infinity }
  const bloblar = tablo.kayitlar.map((k) => {
    if (!k.g) return null
    const { blob, bilgi } = geopackageGeometrisi(k.g, srsId)
    if (bilgi.z) kz.zVar = true
    else kz.zYok = true
    if (bilgi.m) kz.mAtildi = true
    if (!bilgi.bos) {
      toplam.minx = Math.min(toplam.minx, bilgi.zarf.minx)
      toplam.maxx = Math.max(toplam.maxx, bilgi.zarf.maxx)
      toplam.miny = Math.min(toplam.miny, bilgi.zarf.miny)
      toplam.maxy = Math.max(toplam.maxy, bilgi.zarf.maxy)
    }
    return blob
  })
  if (kz.mAtildi) uyar('M (ölçü) değerleri GeoPackage çıktısına yazılmadı; yalnızca X, Y ve Z korundu.')
  if (kz.zVar && kz.zYok) uyar(`"${tablo.ad}" tablosunda bazı geometriler Z'li, bazıları Z'siz; Z sütunu 'isteğe bağlı' (z=2) olarak işaretlendi.`)
  const zBayragi = kz.zVar ? (kz.zYok ? 2 : 1) : 0
  const bboxVar = Number.isFinite(toplam.minx)
  const sutunlar = sutunlariCikar(tablo.kayitlar.map((k) => k.f), uyar)

  db.run(
    `INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
     VALUES (?, 'features', ?, '', ?, ?, ?, ?, ?)`,
    [tablo.ad, tablo.ad, ...(bboxVar ? [toplam.minx, toplam.miny, toplam.maxx, toplam.maxy] : [null, null, null, null]), srsId],
  )
  db.run('INSERT INTO gpkg_geometry_columns VALUES (?, ?, ?, ?, ?, 0)', [tablo.ad, GEOMETRI_SUTUNU, tablo.tip, srsId, zBayragi])
  const sutunTanimlari = [
    `${tirnakla(KIMLIK_SUTUNU)} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL`,
    `${tirnakla(GEOMETRI_SUTUNU)} ${tablo.tip}`,
    ...sutunlar.map((s) => `${tirnakla(s.ad)} ${s.tip}`),
  ]
  db.run(`CREATE TABLE ${tirnakla(tablo.ad)} (${sutunTanimlari.join(', ')})`)
  const ekle = db.prepare(
    `INSERT INTO ${tirnakla(tablo.ad)} (${[GEOMETRI_SUTUNU, ...sutunlar.map((s) => s.ad)].map(tirnakla).join(', ')}) ` +
      `VALUES (${Array(sutunlar.length + 1).fill('?').join(', ')})`,
  )
  try {
    tablo.kayitlar.forEach((k, i) => {
      const p = (k.f && k.f.properties) || {}
      ekle.run([bloblar[i], ...sutunlar.map((s) => degerDonustur(p[s.anahtar], s.tip))])
    })
  } finally {
    ekle.free()
  }
  return { ad: tablo.ad, tip: tablo.tip, z: zBayragi, sayi: tablo.kayitlar.length, kapsam: bboxVar ? toplam : null, sutunlar }
}

/**
 * GeoJSON FeatureCollection'ı OGC GeoPackage 1.3 dosyasına yazar.
 * Tek geometri ailesinde tek tablo (`tabloAdi`); farklı ailelerde aile başına bir tablo.
 * @param {object} fc FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler]
 * @param {string} [secenekler.crs] hedef EPSG kodu, ör. 'EPSG:5255' (yoksa 4326)
 * @param {string} [secenekler.sqlWasmUrl] sql.js WASM dosyasının adresi (tarayıcı/worker)
 * @param {string} [secenekler.tabloAdi] obje tablosu (taban) adı, varsayılan 'objeler'
 * @returns {Promise<{ veri: Uint8Array, onizleme: string, uyarilar: string[] }>}
 */
export async function geopackageYaz(fc, secenekler = {}) {
  const ayar = secenekler || {}
  const uyarilar = []
  const uyar = (m) => {
    if (!uyarilar.includes(m)) uyarilar.push(m)
  }
  const objeler = Array.isArray(fc?.features) ? fc.features : []
  const srsId = srsCoz(ayar.crs, uyarilar)
  const tabanAd = tabloAdiBelirle(ayar.tabloAdi, uyar)
  const tablolar = tablolaraDagit(objeler, tabanAd, uyar)

  let srs = SRS_TANIMLARI.get(srsId)
  if (!srs) {
    uyar(`EPSG:${srsId} için OGC WKT tanımı bilinmiyor; gpkg_spatial_ref_sys tanımı 'undefined' yazıldı (yazılım EPSG kodundan çözebilir).`)
    srs = { ad: `EPSG:${srsId}`, tanim: 'undefined', aciklama: null }
  }

  const SQL = await sqlJsYukle(ayar.sqlWasmUrl)
  const db = new SQL.Database()
  try {
    db.run(`PRAGMA application_id = ${GPKG_APPLICATION_ID}`)
    db.run(`PRAGMA user_version = ${GPKG_USER_VERSION}`)
    db.run('BEGIN')
    sistemTablolariniKur(db)
    if (srsId !== 4326 && srsId !== 0 && srsId !== -1) db.run(SRS_EKLE, [srs.ad, srsId, 'EPSG', srsId, srs.tanim, srs.aciklama])
    const ozetler = tablolar.map((t) => objeTablosuYaz(db, t, srsId, uyar))
    db.run('COMMIT')

    const veri = db.export()
    const satirlar = [
      'OGC GeoPackage 1.3 (SQLite)',
      `Koordinat sistemi: EPSG:${srsId} – ${srs.ad}`,
      `Toplam obje: ${objeler.length}, tablo sayısı: ${ozetler.length}`,
      `Dosya boyutu: ${veri.length} bayt`,
    ]
    for (const o of ozetler) {
      const k = o.kapsam
      satirlar.push(
        '',
        `Tablo: ${o.ad}`,
        `  Obje sayısı: ${o.sayi}`,
        `  Geometri tipi: ${o.tip}${o.z ? ' (Z)' : ''}`,
        `  Kapsam: ${k ? `${k.minx}, ${k.miny} – ${k.maxx}, ${k.maxy}` : 'yok'}`,
        `  Sütunlar: ${[`${KIMLIK_SUTUNU} INTEGER`, `${GEOMETRI_SUTUNU} ${o.tip}`, ...o.sutunlar.map((s) => `${s.ad} ${s.tip}`)].join(', ')}`,
      )
    }
    return { veri, onizleme: satirlar.join('\n'), uyarilar }
  } finally {
    db.close()
  }
}
