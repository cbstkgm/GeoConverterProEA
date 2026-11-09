/**
 * ESRI Shapefile yazıcısı (zipli): GeoJSON FeatureCollection → .zip (shp/shx/dbf/prj/cpg).
 *
 * Saf JavaScript: DOM / window kullanmaz; Web Worker ve Node (Vitest) altında çalışır.
 * Koordinatlar zaten hedef CRS'tedir; bu modül dönüşüm yapmaz, yalnızca .prj yazar.
 *
 * Kaynak: "ESRI Shapefile Technical Description" (Temmuz 1998) ve dBASE III dosya yapısı.
 *
 * Tasarım özeti
 *  - Bir shapefile tek geometri tipi taşır: objeler nokta / çizgi / poligon gruplarına
 *    ayrılır, her dolu grup ayrı katman olur (<ad>_nokta, <ad>_cizgi, <ad>_poligon).
 *  - Nokta grubu: tüm objeler tekil Point ise Point (1/11) yazılır — en yaygın ve en
 *    uyumlu tip, MultiPoint'e gereksiz sarmalama yapılmaz. Grupta en az bir çoklu nokta
 *    (MultiPoint ya da birden çok nokta içeren GeometryCollection) varsa, tek tip
 *    kuralı gereği tümü MultiPoint (8/18) yazılır; tekil noktalar 1 elemanlı olur.
 *  - Katmanda herhangi bir Z değeri varsa Z tipi (PointZ/PolyLineZ/PolygonZ/MultiPointZ)
 *    kullanılır; Z'si olmayan konumlara 0 yazılır (uyarı). M dizileri ESRI "veri yok"
 *    değeriyle (< -1e38) yazılır; ArcGIS/GDAL Z tiplerinde M bölümünü bekleyebilir.
 *  - Null / tamamen geçersiz geometrili objeler atlanmaz: Null Shape (tip 0) kaydı olarak
 *    yazılır, .dbf satırı korunur (ayrıntı: shapefileYaz içindeki açıklama).
 *  - Poligon: dış halka saat yönünde, delikler saat yönünün tersinde (gerekirse çevrilir).
 *  - .dbf: dBASE III, UTF-8; LDID = 0x00 (UTF-8 için tanımlı bir dBASE dil sürücüsü
 *    kodu yoktur; 0 "belirtilmemiş" demektir ve okuyucular kodlamayı .cpg'den alır —
 *    GDAL/ArcGIS de UTF-8 için böyle yazar). .cpg içeriği "UTF-8".
 */
import JSZip from 'jszip'

// ---------------------------------------------------------------------------
// .prj tablosu (ESRI WKT1). Parametreler katalog.js'teki proj4 tanımlarıyla tutarlıdır.
// ---------------------------------------------------------------------------

const DERECE = 'UNIT["Degree",0.0174532925199433]'
const GCS_WGS84 =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  `PRIMEM["Greenwich",0.0],${DERECE}]`
// TUREF (ITRF96 tabanlı Türkiye Ulusal Referans Çerçevesi), GRS80. ITRF96 ≈ WGS84 (<1 m):
// katalog.js'teki gibi datum kaydırması yok (towgs84 = 0).
const GCS_TUREF =
  'GEOGCS["GCS_TUREF",DATUM["D_Turkish_National_Reference_Frame",SPHEROID["GRS_1980",6378137.0,298.257222101],' +
  `TOWGS84[0,0,0,0,0,0,0]],PRIMEM["Greenwich",0.0],${DERECE}]`
// ED50, Uluslararası 1924 (Hayford). TOWGS84: EPSG:1784 "ED50 to WGS 84 (30)" Türkiye,
// Position Vector — katalog.js ED50_TURKIYE_TOWGS84 ile aynı değerler.
const GCS_ED50 =
  'GEOGCS["GCS_European_1950",DATUM["D_European_1950",SPHEROID["International_1924",6378388.0,297.0],' +
  `TOWGS84[-84.1,-101.8,-129.7,0,0,0.468,1.05]],PRIMEM["Greenwich",0.0],${DERECE}]`

function tmProjcs(ad, gcs, dom, olcek) {
  return (
    `PROJCS["${ad}",${gcs},PROJECTION["Transverse_Mercator"],` +
    'PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],' +
    `PARAMETER["Central_Meridian",${dom.toFixed(1)}],PARAMETER["Scale_Factor",${olcek}],` +
    'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'
  )
}

const prjTablosu = {
  'EPSG:4326': GCS_WGS84,
  'EPSG:3857':
    `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",${GCS_WGS84},PROJECTION["Mercator_Auxiliary_Sphere"],` +
    'PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],' +
    'PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]',
}
// EPSG:5253–5259: TUREF / TM27 … TM45 (ITRF96 3° TM), k = 1
;[27, 30, 33, 36, 39, 42, 45].forEach((dom, i) => {
  prjTablosu[`EPSG:${5253 + i}`] = tmProjcs(`TUREF_TM${dom}`, GCS_TUREF, dom, '1.0')
})
// EPSG:23035–23038: ED50 / UTM 35N–38N, k = 0.9996
;[35, 36, 37, 38].forEach((zon) => {
  prjTablosu[`EPSG:${23000 + zon}`] = tmProjcs(`ED_1950_UTM_Zone_${zon}N`, GCS_ED50, zon * 6 - 183, '0.9996')
})

/** Desteklenen EPSG kodu → ESRI WKT (.prj içeriği). */
export const PRJ_METINLERI = Object.freeze(prjTablosu)

/** 'EPSG:5255', 'epsg:5255' ya da 5255 → .prj metni; bilinmiyorsa undefined. */
export function prjMetni(crs) {
  if (crs === undefined || crs === null || crs === '') return undefined
  const s = String(crs).trim().toUpperCase()
  const kod = /^\d+$/.test(s) ? `EPSG:${s}` : s
  return PRJ_METINLERI[kod]
}

// ---------------------------------------------------------------------------
// Geometri gruplama
// ---------------------------------------------------------------------------

const SHP = { Null: 0, Point: 1, PolyLine: 3, Polygon: 5, MultiPoint: 8, PointZ: 11, PolyLineZ: 13, PolygonZ: 15, MultiPointZ: 18 }
const TIP_ADI = Object.fromEntries(Object.entries(SHP).map(([k, v]) => [v, k]))
const M_VERI_YOK = -1e39 // ESRI: -1e38'den küçük her değer "M yok" sayılır

const GRUPLAR = [
  { anahtar: 'nokta', ad: 'nokta' },
  { anahtar: 'cizgi', ad: 'cizgi' },
  { anahtar: 'poligon', ad: 'poligon' },
]

const konumGecerli = (k) => Array.isArray(k) && k.length >= 2 && Number.isFinite(k[0]) && Number.isFinite(k[1])
const zVar = (k) => k.length > 2 && Number.isFinite(k[2])

function halkaKapat(halka) {
  const ilk = halka[0]
  const son = halka[halka.length - 1]
  if (ilk[0] === son[0] && ilk[1] === son[1]) return { halka, kapatildi: false }
  return { halka: [...halka, ilk], kapatildi: true }
}

/** İşaretli alan (shoelace): > 0 saat yönünün tersi, < 0 saat yönü. */
export function isaretliAlan(halka) {
  let t = 0
  for (let i = 0; i < halka.length - 1; i++) {
    t += halka[i][0] * halka[i + 1][1] - halka[i + 1][0] * halka[i][1]
  }
  return t / 2
}

/**
 * Bir geometriyi (GeometryCollection dahil) gruplara ayırır.
 * Dönüş: { nokta: konum[], cizgi: parça[], poligon: halka[][] (poligon başına halkalar), sorunlar }
 */
function geometriParcala(g, cikti, sorun) {
  if (g == null) return
  const c = g.coordinates
  const dizi = (x) => Array.isArray(x)
  switch (g.type) {
    case 'Point':
      if (konumGecerli(c)) cikti.nokta.push(c)
      else sorun('geçersiz nokta')
      return
    case 'MultiPoint':
      if (!dizi(c)) return sorun('geçersiz MultiPoint')
      for (const k of c) {
        if (konumGecerli(k)) cikti.nokta.push(k)
        else sorun('geçersiz nokta')
      }
      return
    case 'LineString':
    case 'MultiLineString': {
      if (!dizi(c)) return sorun(`geçersiz ${g.type}`)
      for (const parca of g.type === 'LineString' ? [c] : c) {
        if (!dizi(parca) || !parca.every(konumGecerli)) { sorun('geçersiz koordinatlı çizgi parçası'); continue }
        if (parca.length < 2) { sorun('2 noktadan az çizgi parçası'); continue }
        cikti.cizgi.push(parca)
      }
      return
    }
    case 'Polygon':
    case 'MultiPolygon': {
      if (!dizi(c)) return sorun(`geçersiz ${g.type}`)
      for (const poligon of g.type === 'Polygon' ? [c] : c) {
        if (!dizi(poligon)) { sorun('geçersiz poligon'); continue }
        const halkalar = []
        poligon.forEach((h, i) => {
          if (!dizi(h) || !h.every(konumGecerli)) { sorun('geçersiz koordinatlı halka'); return }
          if (h.length === 0) return
          const { halka, kapatildi } = halkaKapat(h)
          if (kapatildi) sorun('kapalı olmayan halka kapatıldı', true)
          if (halka.length < 4) { sorun('4 noktadan az halka'); return }
          halkalar.push({ halka, dis: i === 0 })
        })
        if (!halkalar.length || !halkalar[0].dis) {
          if (halkalar.length) sorun('dış halkası geçersiz poligon')
          continue
        }
        cikti.poligon.push(halkalar.map((x) => x.halka))
      }
      return
    }
    case 'GeometryCollection':
      if (!dizi(g.geometries)) return sorun('geçersiz GeometryCollection')
      for (const alt of g.geometries) geometriParcala(alt, cikti, sorun)
      return
    default:
      sorun(`desteklenmeyen geometri tipi "${g.type}"`)
  }
}

// ---------------------------------------------------------------------------
// Kayıt içerikleri (.shp)
// ---------------------------------------------------------------------------

function kutuHesapla(konumlar) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity
  for (const k of konumlar) {
    if (k[0] < xmin) xmin = k[0]
    if (k[0] > xmax) xmax = k[0]
    if (k[1] < ymin) ymin = k[1]
    if (k[1] > ymax) ymax = k[1]
    const z = zVar(k) ? k[2] : 0
    if (z < zmin) zmin = z
    if (z > zmax) zmax = z
  }
  return { xmin, ymin, xmax, ymax, zmin, zmax }
}

/** Z ve M bölümlerini yazar (Z tipleri için). Dönüş: yeni ofset. */
function zmYaz(dv, o, konumlar, kutu) {
  dv.setFloat64(o, kutu.zmin, true); dv.setFloat64(o + 8, kutu.zmax, true); o += 16
  for (const k of konumlar) { dv.setFloat64(o, zVar(k) ? k[2] : 0, true); o += 8 }
  dv.setFloat64(o, M_VERI_YOK, true); dv.setFloat64(o + 8, M_VERI_YOK, true); o += 16
  for (let i = 0; i < konumlar.length; i++) { dv.setFloat64(o, M_VERI_YOK, true); o += 8 }
  return o
}

function kutuYaz(dv, o, kutu) {
  dv.setFloat64(o, kutu.xmin, true)
  dv.setFloat64(o + 8, kutu.ymin, true)
  dv.setFloat64(o + 16, kutu.xmax, true)
  dv.setFloat64(o + 24, kutu.ymax, true)
}

/** Shape kaydı içeriği (kayıt başlığı hariç), küçük endian. */
function kayitIcerigi(tip, parcalar) {
  if (parcalar === null) {
    // Null Shape: yalnızca 4 baytlık şekil tipi (0); her katmanda geçerlidir.
    const dv = new DataView(new ArrayBuffer(4))
    dv.setInt32(0, SHP.Null, true)
    return { dv, kutu: null }
  }
  const z = tip > 10
  if (tip === SHP.Point || tip === SHP.PointZ) {
    const k = parcalar[0][0]
    const dv = new DataView(new ArrayBuffer(z ? 36 : 20))
    dv.setInt32(0, tip, true)
    dv.setFloat64(4, k[0], true)
    dv.setFloat64(12, k[1], true)
    if (z) {
      dv.setFloat64(20, zVar(k) ? k[2] : 0, true)
      dv.setFloat64(28, M_VERI_YOK, true)
    }
    return { dv, kutu: kutuHesapla([k]) }
  }
  const konumlar = parcalar.flat()
  const n = konumlar.length
  const kutu = kutuHesapla(konumlar)
  const cokluNokta = tip === SHP.MultiPoint || tip === SHP.MultiPointZ
  const np = cokluNokta ? 0 : parcalar.length
  const temel = cokluNokta ? 40 + 16 * n : 44 + 4 * np + 16 * n
  const dv = new DataView(new ArrayBuffer(temel + (z ? 32 + 16 * n : 0)))
  dv.setInt32(0, tip, true)
  kutuYaz(dv, 4, kutu)
  let o
  if (cokluNokta) {
    dv.setInt32(36, n, true)
    o = 40
  } else {
    dv.setInt32(36, np, true)
    dv.setInt32(40, n, true)
    o = 44
    let bas = 0
    for (const p of parcalar) { dv.setInt32(o, bas, true); o += 4; bas += p.length }
  }
  for (const k of konumlar) { dv.setFloat64(o, k[0], true); dv.setFloat64(o + 8, k[1], true); o += 16 }
  if (z) o = zmYaz(dv, o, konumlar, kutu)
  return { dv, kutu }
}

function anaBaslikYaz(dv, tip, dosyaUzunluguBayt, kutu) {
  dv.setInt32(0, 9994, false) // dosya kodu: büyük endian
  dv.setInt32(24, dosyaUzunluguBayt / 2, false) // 16-bit kelime cinsinden, büyük endian
  dv.setInt32(28, 1000, true) // sürüm: küçük endian
  dv.setInt32(32, tip, true)
  kutuYaz(dv, 36, kutu)
  dv.setFloat64(68, tip > 10 ? kutu.zmin : 0, true)
  dv.setFloat64(76, tip > 10 ? kutu.zmax : 0, true)
  dv.setFloat64(84, 0, true) // M aralığı: ölçü yok
  dv.setFloat64(92, 0, true)
}

function shpShxUret(tip, kayitlar) {
  const icerikler = kayitlar.map((parcalar) => kayitIcerigi(tip, parcalar))
  const shpBoyu = 100 + icerikler.reduce((t, { dv }) => t + 8 + dv.byteLength, 0)
  const shxBoyu = 100 + 8 * icerikler.length
  if (shpBoyu > 0x7fffffff * 2) throw new Error('Shapefile 2 GB sınırını aşıyor; veriyi bölerek yazın.')
  const kutu = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity, zmin: Infinity, zmax: -Infinity }
  for (const { kutu: k } of icerikler) {
    if (!k) continue // Null Shape kayıtları bbox'a katılmaz
    kutu.xmin = Math.min(kutu.xmin, k.xmin); kutu.ymin = Math.min(kutu.ymin, k.ymin)
    kutu.xmax = Math.max(kutu.xmax, k.xmax); kutu.ymax = Math.max(kutu.ymax, k.ymax)
    kutu.zmin = Math.min(kutu.zmin, k.zmin); kutu.zmax = Math.max(kutu.zmax, k.zmax)
  }
  if (kutu.xmin === Infinity) Object.assign(kutu, { xmin: 0, ymin: 0, xmax: 0, ymax: 0, zmin: 0, zmax: 0 })
  const shp = new Uint8Array(shpBoyu)
  const shx = new Uint8Array(shxBoyu)
  const shpDv = new DataView(shp.buffer)
  const shxDv = new DataView(shx.buffer)
  anaBaslikYaz(shpDv, tip, shpBoyu, kutu)
  anaBaslikYaz(shxDv, tip, shxBoyu, kutu)
  let o = 100
  icerikler.forEach(({ dv }, i) => {
    const kelime = dv.byteLength / 2
    shxDv.setInt32(100 + 8 * i, o / 2, false) // ofset (kelime), büyük endian
    shxDv.setInt32(104 + 8 * i, kelime, false)
    shpDv.setInt32(o, i + 1, false) // kayıt numarası 1'den başlar, büyük endian
    shpDv.setInt32(o + 4, kelime, false)
    shp.set(new Uint8Array(dv.buffer), o + 8)
    o += 8 + dv.byteLength
  })
  return { shp, shx, kutu }
}

// ---------------------------------------------------------------------------
// .dbf (dBASE III, UTF-8)
// ---------------------------------------------------------------------------

const kodlayici = new TextEncoder()
const TR_HARF = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' }
const C_AZAMI = 254
const N_AZAMI_GENISLIK = 24 // GDAL'ın ondalık varsayılanı (24.15) ile uyumlu
const N_AZAMI_ONDALIK = 15
const ISO_TARIH = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Alan adı: Türkçe harfler ASCII'ye çevrilir, harf/rakam/_ dışı karakterler "_" olur,
 * harfle başlamıyorsa "F_" eklenir, 10 bayta kısaltılır. Benzersizlik büyük/küçük harf
 * duyarsız denetlenir (dBASE ve ArcGIS duyarsızdır); çakışmada "_1", "_2" … soneki.
 */
export function alanAdlariniEsle(anahtarlar) {
  const esleme = new Map()
  const kullanilan = new Set()
  for (const anahtar of anahtarlar) {
    let ad = String(anahtar)
      .replace(/[çÇğĞıİöÖşŞüÜ]/g, (h) => TR_HARF[h])
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_]/g, '_')
    if (!ad) ad = 'ALAN'
    if (!/^[A-Za-z]/.test(ad)) ad = `F_${ad}`
    ad = ad.slice(0, 10)
    if (kullanilan.has(ad.toUpperCase())) {
      for (let n = 1; ; n++) {
        const sonek = `_${n}`
        const aday = ad.slice(0, 10 - sonek.length) + sonek
        if (!kullanilan.has(aday.toUpperCase())) { ad = aday; break }
      }
    }
    kullanilan.add(ad.toUpperCase())
    esleme.set(anahtar, ad)
  }
  return esleme
}

function tarihGecerli(y, a, g) {
  const d = new Date(Date.UTC(y, a - 1, g))
  return d.getUTCFullYear() === y && d.getUTCMonth() === a - 1 && d.getUTCDate() === g
}

/** Değer → D alanı için "YYYYMMDD"; tarih değilse null. */
function tarihMetni(v) {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return `${String(v.getFullYear()).padStart(4, '0')}${String(v.getMonth() + 1).padStart(2, '0')}${String(v.getDate()).padStart(2, '0')}`
  }
  if (typeof v === 'string') {
    const m = ISO_TARIH.exec(v)
    if (m && tarihGecerli(+m[1], +m[2], +m[3])) return `${m[1]}${m[2]}${m[3]}`
  }
  return null
}

function ondalikBasamak(v) {
  const s = Math.abs(v).toString()
  const e = s.indexOf('e')
  if (e < 0) {
    const n = s.indexOf('.')
    return n < 0 ? 0 : s.length - n - 1
  }
  const us = Number(s.slice(e + 1))
  const mantis = s.slice(0, e)
  const n = mantis.indexOf('.')
  return Math.max(0, (n < 0 ? 0 : mantis.length - n - 1) - us)
}

function utf8Kes(metin, azami) {
  const b = kodlayici.encode(metin)
  if (b.length <= azami) return { baytlar: b, kesildi: false }
  let son = azami
  while (son > 0 && (b[son] & 0xc0) === 0x80) son-- // çok baytlı karakteri bölme
  return { baytlar: b.subarray(0, son), kesildi: true }
}

const metneCevir = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))

/** Bir alanın değerlerinden dBASE tipini çıkarır. */
function alanTanimi(ad, kaynak, degerler, uyar) {
  const dolu = degerler.filter((v) => v !== null && v !== undefined)
  const sayi = dolu.filter((v) => typeof v === 'number')
  if (sayi.length && sayi.some((v) => !Number.isFinite(v))) {
    uyar(`"${kaynak}" alanında sonlu olmayan sayı (NaN/Infinity) boş yazıldı.`)
  }
  const sonlu = dolu.filter((v) => !(typeof v === 'number' && !Number.isFinite(v)))

  if (sonlu.length && sonlu.every((v) => typeof v === 'boolean')) {
    return { ad, kaynak, tip: 'L', uzunluk: 1, ondalik: 0 }
  }
  if (sonlu.length && sonlu.every((v) => typeof v === 'number')) {
    let ondalik = Math.min(N_AZAMI_ONDALIK, Math.max(...sonlu.map(ondalikBasamak)))
    const genislik = (d) => Math.max(...sonlu.map((v) => v.toFixed(d).length))
    while (ondalik > 0 && genislik(ondalik) > N_AZAMI_GENISLIK) ondalik--
    const g = genislik(ondalik)
    if (g <= N_AZAMI_GENISLIK && !sonlu.some((v) => v.toFixed(ondalik).includes('e'))) {
      if (sonlu.some((v) => Number(v.toFixed(ondalik)) !== v)) {
        uyar(`"${kaynak}" alanındaki bazı sayılar ${ondalik} ondalık basamağa yuvarlandı.`)
      }
      return { ad, kaynak, tip: 'N', uzunluk: Math.max(1, g), ondalik }
    }
    uyar(`"${kaynak}" alanındaki sayılar dBASE N alanına (${N_AZAMI_GENISLIK} karakter) sığmadı; metin (C) olarak yazıldı.`)
  } else if (sonlu.length && sonlu.every((v) => tarihMetni(v) !== null)) {
    return { ad, kaynak, tip: 'D', uzunluk: 8, ondalik: 0 }
  } else if (sonlu.some((v) => typeof v === 'object' && !(v instanceof Date))) {
    uyar(`"${kaynak}" alanındaki nesne/dizi değerleri JSON metni olarak yazıldı.`)
  } else if (new Set(sonlu.map((v) => typeof v)).size > 1) {
    uyar(`"${kaynak}" alanında karışık değer tipleri var; metin (C) olarak yazıldı.`)
  }
  const uzunluk = Math.min(C_AZAMI, Math.max(1, ...sonlu.map((v) => kodlayici.encode(metneCevir(v)).length)))
  return { ad, kaynak, tip: 'C', uzunluk, ondalik: 0 }
}

function dbfUret(objeler, alanlar, uyar) {
  const kayitBoyu = 1 + alanlar.reduce((t, a) => t + a.uzunluk, 0)
  const baslikBoyu = 32 + 32 * alanlar.length + 1
  if (baslikBoyu > 0xffff || kayitBoyu > 0xffff) throw new Error('DBF alan sayısı/kayıt uzunluğu dBASE sınırını aşıyor.')
  if (alanlar.length > 255) uyar(`${alanlar.length} alan var; bazı yazılımlar 255'ten fazla alanı okuyamaz.`)
  const veri = new Uint8Array(baslikBoyu + kayitBoyu * objeler.length + 1)
  const dv = new DataView(veri.buffer)
  const bugun = new Date()
  veri[0] = 0x03 // dBASE III, memo yok
  veri[1] = bugun.getFullYear() - 1900
  veri[2] = bugun.getMonth() + 1
  veri[3] = bugun.getDate()
  dv.setUint32(4, objeler.length, true)
  dv.setUint16(8, baslikBoyu, true)
  dv.setUint16(10, kayitBoyu, true)
  veri[29] = 0x00 // LDID: UTF-8 için tanımlı kod yok → .cpg belirleyicidir
  alanlar.forEach((a, i) => {
    const o = 32 + 32 * i
    veri.set(kodlayici.encode(a.ad), o) // ASCII, ≤ 10 bayt; 11. bayt 0 (sonlandırıcı)
    veri[o + 11] = a.tip.charCodeAt(0)
    veri[o + 16] = a.uzunluk
    veri[o + 17] = a.ondalik
  })
  veri[baslikBoyu - 1] = 0x0d
  veri.fill(0x20, baslikBoyu, veri.length - 1)
  const kesilen = new Map()
  let o = baslikBoyu
  for (const f of objeler) {
    o += 1 // silinme bayrağı: boşluk
    for (const a of alanlar) {
      const v = f.properties?.[a.kaynak]
      let metin = null
      if (v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) {
        if (a.tip === 'N') metin = v.toFixed(a.ondalik).padStart(a.uzunluk, ' ')
        else if (a.tip === 'L') metin = v ? 'T' : 'F'
        else if (a.tip === 'D') metin = tarihMetni(v)
        else {
          const { baytlar, kesildi } = utf8Kes(metneCevir(v), a.uzunluk)
          if (kesildi) kesilen.set(a.kaynak, (kesilen.get(a.kaynak) || 0) + 1)
          veri.set(baytlar, o)
        }
      } else if (a.tip === 'L') metin = '?'
      if (metin !== null) veri.set(kodlayici.encode(metin), o)
      o += a.uzunluk
    }
  }
  veri[veri.length - 1] = 0x1a
  for (const [alan, sayi] of kesilen) {
    uyar(`"${alan}" alanında ${sayi} değer ${C_AZAMI} bayt sınırı nedeniyle kesildi.`)
  }
  return veri
}

// ---------------------------------------------------------------------------
// Ana giriş
// ---------------------------------------------------------------------------

function dosyaKoku(ad) {
  const s = String(ad ?? 'cikti').replace(/\.[^.]*$/, '').replace(/[çÇğĞıİöÖşŞüÜ]/g, (h) => TR_HARF[h])
    .replace(/[^A-Za-z0-9_-]/g, '_')
  return s || 'cikti'
}

/**
 * GeoJSON FeatureCollection → zipli ESRI Shapefile.
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {{ crs?: string, ad?: string }} [secenekler] crs: hedef EPSG kodu (.prj için);
 *   ad: katman dosya adı kökü (varsayılan "cikti" → cikti_nokta.shp …)
 * @returns {Promise<{ veri: Uint8Array, onizleme: string, uyarilar: string[] }>}
 */
export async function shapefileYaz(fc, secenekler = {}) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.')
  }
  const uyarilar = []
  const uyar = (m) => { if (!uyarilar.includes(m)) uyarilar.push(m) }
  const kok = dosyaKoku(secenekler.ad)

  // 1) Objeleri gruplara ayır
  const gruplar = { nokta: [], cizgi: [], poligon: [] }
  const geometrisizler = [] // null / tamamen geçersiz geometri: Null Shape kaydı olarak yazılır
  let bosGeometri = 0
  let gecersizGeometri = 0
  let gcDagitilan = 0
  let objeSayisi = 0
  const sorunSayaci = new Map()
  fc.features.forEach((f, sira) => {
    if (!f || typeof f !== 'object') return
    objeSayisi++
    const g = f.geometry
    if (g == null || typeof g !== 'object') { bosGeometri++; geometrisizler.push({ f, sira, parca: null }); return }
    const cikti = { nokta: [], cizgi: [], poligon: [] }
    let atlandi = false
    geometriParcala(g, cikti, (m, bilgi) => {
      sorunSayaci.set(m, (sorunSayaci.get(m) || 0) + 1)
      if (!bilgi) atlandi = true
    })
    const dolu = GRUPLAR.filter(({ anahtar }) => cikti[anahtar].length)
    if (!dolu.length) {
      if (atlandi) gecersizGeometri++
      else bosGeometri++
      geometrisizler.push({ f, sira, parca: null })
      return
    }
    if (dolu.length > 1) gcDagitilan++
    for (const { anahtar } of dolu) gruplar[anahtar].push({ f, sira, parca: cikti[anahtar] })
  })
  if (!objeSayisi) throw new Error('Shapefile yazılamadı: FeatureCollection hiç obje içermiyor.')
  for (const [m, n] of sorunSayaci) uyar(`Geometri sorunu: ${m} (${n} kez); ilgili parçalar atlandı.`)
  if (gcDagitilan) {
    uyar(`${gcDagitilan} karışık tipli GeometryCollection parçaları nokta/çizgi/poligon katmanlarına dağıtıldı (öznitelikler her katmana kopyalandı).`)
  }

  // Geometrisiz objeler öznitelikleri kaybolmasın diye Null Shape kaydı olarak yazılır:
  //  - tek geometri ailesi varsa o katmana, özgün sıralarında;
  //  - birden çok aile varsa ya da hiç geometri yoksa ayrı "<ad>_geometrisiz" katmanına.
  //    Bu katmanın başlık tipi Polygon (5) olur, tüm kayıtları Null Shape'tir. Başlık tipi
  //    Null (0) seçilmedi: shpjs (projenin kendi okuyucusu) tip 0'ı "I don't know shp type"
  //    hatasıyla reddeder ve ArcGIS Null tipli öğe sınıfı açmaz; yalnız Null kayıt içeren
  //    tipli bir dosya ise spesifikasyona uygundur ve GDAL/QGIS/ArcGIS/shpjs ile okunur.
  const katmanlar = GRUPLAR.filter(({ anahtar }) => gruplar[anahtar].length)
  if (geometrisizler.length) {
    const neden = [bosGeometri && `${bosGeometri} null`, gecersizGeometri && `${gecersizGeometri} tamamen geçersiz`]
      .filter(Boolean).join(', ')
    if (katmanlar.length === 1) {
      const { anahtar, ad } = katmanlar[0]
      gruplar[anahtar] = [...gruplar[anahtar], ...geometrisizler].sort((a, b) => a.sira - b.sira)
      uyar(`${geometrisizler.length} geometrisiz obje (${neden}) "${kok}_${ad}" katmanına Null Shape kaydı olarak yazıldı; öznitelikleri korundu.`)
    } else {
      gruplar.geometrisiz = geometrisizler
      katmanlar.push({ anahtar: 'geometrisiz', ad: 'geometrisiz' })
      uyar(`${geometrisizler.length} geometrisiz obje (${neden}) ayrı "${kok}_geometrisiz" katmanına Null Shape kaydı olarak yazıldı (başlık tipi Polygon); öznitelikleri korundu.`)
    }
  }

  // 2) Ortak alan adı eşlemesi (tüm katmanlarda aynı kısaltma)
  const anahtarlar = []
  const gorulen = new Set()
  for (const f of fc.features) {
    for (const k of Object.keys(f?.properties && typeof f.properties === 'object' ? f.properties : {})) {
      if (!gorulen.has(k)) { gorulen.add(k); anahtarlar.push(k) }
    }
  }
  const adlar = alanAdlariniEsle(anahtarlar)
  for (const [k, ad] of adlar) {
    if (k !== ad) uyar(`Alan adı "${k}" → "${ad}" (dBASE: en fazla 10 bayt, ASCII, benzersiz).`)
  }

  // 3) .prj
  const prj = prjMetni(secenekler.crs)
  if (secenekler.crs == null || secenekler.crs === '') {
    uyar('Hedef koordinat sistemi belirtilmedi; .prj dosyası yazılmadı.')
  } else if (!prj) {
    uyar(`"${secenekler.crs}" için .prj tanımı yok; .prj dosyası yazılmadı.`)
  }

  // 4) Katmanları üret
  const zip = new JSZip()
  const ozet = []
  const dosyaListesi = []
  for (const { anahtar, ad } of katmanlar) {
    const uyeler = gruplar[anahtar]
    let tip
    let kayitlar
    if (anahtar === 'nokta') {
      kayitlar = uyeler.map(({ parca }) => (parca ? [parca] : null))
    } else if (anahtar === 'cizgi' || anahtar === 'geometrisiz') {
      kayitlar = uyeler.map(({ parca }) => parca)
    } else {
      let cevrilen = 0
      kayitlar = uyeler.map(({ parca }) => parca && parca.flatMap((halkalar) => halkalar.map((h, i) => {
        const alan = isaretliAlan(h)
        // ESRI: dış halka saat yönü (alan < 0), delik saat yönünün tersi (alan > 0)
        if ((i === 0 && alan > 0) || (i > 0 && alan < 0)) { cevrilen++; return [...h].reverse() }
        return h
      })))
      if (cevrilen) uyar(`${cevrilen} poligon halkasının yönü ESRI kuralına göre çevrildi (dış: saat yönü, delik: tersi).`)
    }
    // kayıt → parçalar → konumlar
    const dolular = kayitlar.filter(Boolean)
    const z = dolular.some((kayit) => kayit.some((p) => p.some(zVar)))
    if (anahtar === 'nokta') {
      // Tüm objeler tekil nokta ise Point; tek bir çoklu nokta bile varsa hepsi MultiPoint.
      const tekil = uyeler.every(({ f, parca }) => !parca || (parca.length === 1 && f.geometry.type !== 'MultiPoint'))
      tip = tekil ? (z ? SHP.PointZ : SHP.Point) : (z ? SHP.MultiPointZ : SHP.MultiPoint)
    } else if (anahtar === 'cizgi') {
      tip = z ? SHP.PolyLineZ : SHP.PolyLine
    } else {
      tip = z ? SHP.PolygonZ : SHP.Polygon
    }
    if (z) {
      const eksik = dolular.flat(2).filter((k) => !zVar(k)).length
      if (eksik) uyar(`"${kok}_${ad}" katmanında ${eksik} konumun Z değeri yok; 0 yazıldı.`)
    }

    const { shp, shx } = shpShxUret(tip, kayitlar)
    const objeler = uyeler.map(({ f }) => f)
    const katmanAnahtarlari = anahtarlar.filter((k) => objeler.some((f) => f.properties && Object.hasOwn(f.properties, k)))
    const alanlar = katmanAnahtarlari.map((k) => alanTanimi(adlar.get(k), k, objeler.map((f) => f.properties?.[k]), uyar))
    const dbf = dbfUret(objeler, alanlar, uyar)

    const dosyaAdi = `${kok}_${ad}`
    zip.file(`${dosyaAdi}.shp`, shp)
    zip.file(`${dosyaAdi}.shx`, shx)
    zip.file(`${dosyaAdi}.dbf`, dbf)
    zip.file(`${dosyaAdi}.cpg`, 'UTF-8')
    const uzantilar = ['shp', 'shx', 'dbf', 'cpg']
    if (prj) { zip.file(`${dosyaAdi}.prj`, prj); uzantilar.push('prj') }
    dosyaListesi.push(...uzantilar.map((u) => `${dosyaAdi}.${u}`))
    ozet.push({ dosyaAdi, tip, sayi: objeler.length, nullSayisi: kayitlar.length - dolular.length, alanlar, boyut: { shp: shp.length, shx: shx.length, dbf: dbf.length } })
  }

  const veri = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })

  // 5) Önizleme
  const satirlar = ['ESRI Shapefile (zip)', `Dosyalar: ${dosyaListesi.join(', ')}`, '']
  for (const k of ozet) {
    satirlar.push(`Katman: ${k.dosyaAdi}  —  tip: ${TIP_ADI[k.tip]} (${k.tip}), obje: ${k.sayi}${k.nullSayisi ? ` (${k.nullSayisi} Null Shape)` : ''}`)
    satirlar.push(`  Boyut: .shp ${k.boyut.shp} B, .shx ${k.boyut.shx} B, .dbf ${k.boyut.dbf} B`)
    if (k.alanlar.length) {
      satirlar.push('  Alanlar:')
      for (const a of k.alanlar) {
        const tanim = a.tip === 'N' ? `N(${a.uzunluk},${a.ondalik})` : `${a.tip}(${a.uzunluk})`
        satirlar.push(`    ${a.ad.padEnd(10)} ${tanim}${a.ad !== a.kaynak ? `  ← "${a.kaynak}"` : ''}`)
      }
    } else {
      satirlar.push('  Alanlar: (yok)')
    }
    satirlar.push('')
  }
  satirlar.push('Kodlama: UTF-8 (.cpg)')
  satirlar.push(prj ? `.prj (${String(secenekler.crs).toUpperCase()}):\n${prj}` : '.prj: yazılmadı')
  if (uyarilar.length) satirlar.push('', 'Uyarılar:', ...uyarilar.map((u) => `  - ${u}`))

  return { veri, onizleme: satirlar.join('\n'), uyarilar }
}
