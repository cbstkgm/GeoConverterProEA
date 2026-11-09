/**
 * NetCDF klasik biçim yazıcısı (CDF-1; 2 GiB ofset sınırı aşılırsa CDF-2 / 64-bit ofset)
 * CF-1.8 "Geometries" (Discrete Geometries, bölüm 7.5) konvansiyonuyla.
 *
 * Kararlar
 *  - Her geometri ailesi (nokta / çizgi / poligon) AYRI bir geometry container ile yazılır;
 *    yalnız en kalabalık aileyi yazmak veri kaybı olurdu. Her ailenin kendi instance / node /
 *    part boyutları ve öznitelik değişkenleri vardır (tek aile varsa öznitelik değişkenleri
 *    önek almaz, çok aile varsa "<aile>_<ad>" adlanır). GeometryCollection parçaları ailelere
 *    dağıtılır, öznitelikler kopyalanır.
 *  - CF kuralları: poligon dış halkası saat yönünün TERSİ, delikler saat yönü (gerekirse
 *    çevrilir); halkalar kapalı yazılmaz (son düğüm ilk düğüme bağlı kabul edilir — CF 1.8
 *    örnekleri gibi); part_node_count yalnız çok parçalı/delikli veri varsa, interior_ring yalnız
 *    delik varsa yazılır. Nokta ailesinde node_count her zaman yazılır (çoklu nokta için gerekli).
 *  - Null geometrili objeler öznitelikleri kaybolmasın diye en kalabalık aileye 0 düğümlü örnek
 *    (node_count = 0) olarak eklenir ve uyarılır. Hiç geometri yoksa geometry_type
 *    belirlenemez ve klasik biçimde 0 uzunluklu sabit boyut tanımlanamaz (0 = UNLIMITED) → hata.
 *  - Öznitelikler instance boyutlu değişkenler: sayılar NC_DOUBLE (_FillValue = NC_FILL_DOUBLE),
 *    mantıksal değerler NC_BYTE (0/1, flag_values/flag_meanings), diğerleri NC_CHAR
 *    [instance, <ad>_strlen] sabit uzunluklu UTF-8 (klasik biçimde değişken uzunluklu string yok;
 *    _Encoding = "utf-8"). Değişken adları ASCII'ye indirgenir, özgün ad long_name'de kalır.
 *  - CRS: "crs" grid_mapping değişkeni; grid_mapping_name ve CF parametreleri katalog.js'teki
 *    proj4 tanımlarından türetilir, epsg_code ve crs_wkt (ESRI WKT, shapefile.js tablosu) eklenir.
 *
 * Tüm sayılar büyük endian (XDR). Saf JS: DOM / window yok.
 */
import { KOORDINAT_SISTEMI_TANIMLARI } from '../katalog.js'
import { prjMetni } from './shapefile.js'

export const NC = { BYTE: 1, CHAR: 2, SHORT: 3, INT: 4, FLOAT: 5, DOUBLE: 6 }
const TIP_BOYU = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 }
const NC_DIMENSION = 0x0a
const NC_VARIABLE = 0x0b
const NC_ATTRIBUTE = 0x0c
export const NC_FILL_DOUBLE = 9.969209968386869e36
const INT32_AZAMI = 2147483647

const kodla = (s) => new TextEncoder().encode(String(s).normalize('NFC'))
const hiza4 = (n) => (n + 3) & ~3
const sayiMi = (v) => typeof v === 'number' && Number.isFinite(v)

// ---------------------------------------------------------------- CRS
const ELIPSOIT = {
  GRS80: { a: 6378137, rf: 298.257222101 },
  intl: { a: 6378388, rf: 297 },
  WGS84: { a: 6378137, rf: 298.257223563 },
}

function proj4Ayristir(tanim) {
  const p = {}
  for (const m of tanim.matchAll(/\+(\w+)(?:=(\S+))?/g)) p[m[1]] = m[2] ?? true
  return p
}

/** EPSG kodu → crs değişkeninin CF öznitelikleri; bilinmiyorsa null. */
export function cfCrsOznitelikleri(crs) {
  const kod = String(crs).trim().toUpperCase()
  const tanim = KOORDINAT_SISTEMI_TANIMLARI.find((s) => s.kod === kod)
  if (!tanim) return null
  const p = proj4Ayristir(tanim.tanim)
  const e = ELIPSOIT[p.ellps] ?? ELIPSOIT.WGS84
  const a = []
  const ekle = (ad, tip, deger) => a.push({ ad, tip, deger })
  let cografi = false
  if (p.proj === 'longlat') {
    cografi = true
    ekle('grid_mapping_name', NC.CHAR, 'latitude_longitude')
  } else if (p.proj === 'merc') {
    ekle('grid_mapping_name', NC.CHAR, 'mercator')
    ekle('longitude_of_projection_origin', NC.DOUBLE, [Number(p.lon_0 ?? 0)])
    ekle('standard_parallel', NC.DOUBLE, [Number(p.lat_ts ?? 0)])
    ekle('false_easting', NC.DOUBLE, [Number(p.x_0 ?? 0)])
    ekle('false_northing', NC.DOUBLE, [Number(p.y_0 ?? 0)])
  } else {
    // tmerc / utm
    const lon0 = p.proj === 'utm' ? Number(p.zone) * 6 - 183 : Number(p.lon_0)
    ekle('grid_mapping_name', NC.CHAR, 'transverse_mercator')
    ekle('longitude_of_central_meridian', NC.DOUBLE, [lon0])
    ekle('latitude_of_projection_origin', NC.DOUBLE, [Number(p.lat_0 ?? 0)])
    ekle('scale_factor_at_central_meridian', NC.DOUBLE, [p.proj === 'utm' ? 0.9996 : Number(p.k ?? 1)])
    ekle('false_easting', NC.DOUBLE, [p.proj === 'utm' ? 500000 : Number(p.x_0 ?? 0)])
    ekle('false_northing', NC.DOUBLE, [Number(p.y_0 ?? 0)])
  }
  if (p.proj === 'merc' && p.a) {
    ekle('semi_major_axis', NC.DOUBLE, [Number(p.a)])
    ekle('semi_minor_axis', NC.DOUBLE, [Number(p.b)])
  } else {
    ekle('semi_major_axis', NC.DOUBLE, [e.a])
    ekle('inverse_flattening', NC.DOUBLE, [e.rf])
  }
  ekle('longitude_of_prime_meridian', NC.DOUBLE, [0])
  if (p.towgs84) ekle('towgs84', NC.DOUBLE, String(p.towgs84).split(',').map(Number))
  ekle('epsg_code', NC.CHAR, kod)
  const wkt = prjMetni(kod)
  if (wkt) ekle('crs_wkt', NC.CHAR, wkt)
  return { oznitelikler: a, cografi }
}

// ---------------------------------------------------------------- geometri
const AILELER = ['nokta', 'cizgi', 'poligon']
const CF_TIPI = { nokta: 'point', cizgi: 'line', poligon: 'polygon' }
const konumGecerli = (k) => Array.isArray(k) && sayiMi(k[0]) && sayiMi(k[1])

function isaretliAlan(h) {
  let t = 0
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length]
    t += a[0] * b[1] - b[0] * a[1]
  }
  return t / 2
}

/** Geometriyi aile → parça listesine ayırır. Parça: { konumlar, ic: boolean }. */
function ayristir(g, cikti, sayac) {
  if (g == null || typeof g !== 'object') return
  const c = g.coordinates
  const dizi = (x) => (Array.isArray(x) ? x : [])
  const temiz = (l) => {
    const t = dizi(l).filter(konumGecerli)
    sayac.gecersiz += dizi(l).length - t.length
    return t
  }
  switch (g.type) {
    case 'Point': if (konumGecerli(c)) cikti.nokta.push({ konumlar: [c], ic: false }); else sayac.gecersiz++; break
    case 'MultiPoint': { const t = temiz(c); if (t.length) cikti.nokta.push({ konumlar: t, ic: false }); break }
    case 'LineString':
    case 'MultiLineString':
      for (const l of g.type === 'LineString' ? [c] : dizi(c)) {
        const t = temiz(l)
        if (t.length >= 2) cikti.cizgi.push({ konumlar: t, ic: false })
        else if (t.length) sayac.parca++
      }
      break
    case 'Polygon':
    case 'MultiPolygon':
      for (const poligon of g.type === 'Polygon' ? [c] : dizi(c)) {
        let disVar = false
        dizi(poligon).forEach((h, i) => {
          let t = temiz(h)
          if (t.length > 1) {
            const a = t[0], b = t[t.length - 1]
            if (a[0] === b[0] && a[1] === b[1] && (a[2] ?? 0) === (b[2] ?? 0)) t = t.slice(0, -1)
          }
          if (t.length < 3) { if (t.length) sayac.parca++; return }
          if (i === 0) disVar = true
          else if (!disVar) { sayac.parca++; return } // dış halkası atılan poligonun delikleri
          const alan = isaretliAlan(t)
          // CF: dış halka saat yönünün tersi (alan > 0), iç halka saat yönü (alan < 0)
          if ((i === 0 && alan < 0) || (i > 0 && alan > 0)) { t = [...t].reverse(); sayac.cevrilen++ }
          cikti.poligon.push({ konumlar: t, ic: i > 0 })
        })
      }
      break
    case 'GeometryCollection': for (const alt of dizi(g.geometries)) ayristir(alt, cikti, sayac); break
    default: throw new Error(`Desteklenmeyen geometri tipi: "${g.type}".`)
  }
}

// ---------------------------------------------------------------- adlandırma
const TR_HARF = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' }

function degiskenAdi(ham, kullanilan) {
  let ad = String(ham)
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (h) => TR_HARF[h])
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_.@+-]/g, '_')
  if (!/^[A-Za-z]/.test(ad)) ad = `v_${ad}`
  let aday = ad
  for (let n = 1; kullanilan.has(aday); n++) aday = `${ad}_${n}`
  kullanilan.add(aday)
  return aday
}

// ---------------------------------------------------------------- ikili kodlama
class Yazici {
  constructor() { this.parcalar = []; this.boy = 0 }
  bayt(u8) { this.parcalar.push(u8); this.boy += u8.length }
  int(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, false); this.bayt(b) }
  uint(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, false); this.bayt(b) }
  int64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), false); this.bayt(b) }
  dolgu() { const d = hiza4(this.boy) - this.boy; if (d) this.bayt(new Uint8Array(d)) }
  ad(s) { const b = kodla(s); this.int(b.length); this.bayt(b); this.dolgu() }
  sonuc() {
    const u = new Uint8Array(this.boy)
    let o = 0
    for (const p of this.parcalar) { u.set(p, o); o += p.length }
    return u
  }
}

/** Değerleri büyük endian ham bayta çevirir (NC_CHAR: Uint8Array ya da metin). */
function degerBaytlari(tip, deger) {
  if (tip === NC.CHAR) return deger instanceof Uint8Array ? deger : kodla(deger)
  const n = deger.length
  const u = new Uint8Array(n * TIP_BOYU[tip])
  const dv = new DataView(u.buffer)
  for (let i = 0; i < n; i++) {
    if (tip === NC.DOUBLE) dv.setFloat64(i * 8, deger[i], false)
    else if (tip === NC.FLOAT) dv.setFloat32(i * 4, deger[i], false)
    else if (tip === NC.INT) dv.setInt32(i * 4, deger[i], false)
    else if (tip === NC.SHORT) dv.setInt16(i * 2, deger[i], false)
    else dv.setInt8(i, deger[i])
  }
  return u
}

function oznitelikListesi(y, liste) {
  if (!liste.length) { y.int(0); y.int(0); return }
  y.int(NC_ATTRIBUTE)
  y.int(liste.length)
  for (const { ad, tip, deger } of liste) {
    const b = degerBaytlari(tip, deger)
    y.ad(ad)
    y.int(tip)
    y.int(b.length / TIP_BOYU[tip])
    y.bayt(b)
    y.dolgu()
  }
}

/** Başlık + veri. surum 1 (CDF-1) ya da 2 (CDF-2, 64-bit begin). */
function dosyaKur(boyutlar, gattlar, degiskenler, surum) {
  const baslikKur = (beginler) => {
    const y = new Yazici()
    y.bayt(new Uint8Array([0x43, 0x44, 0x46, surum]))
    y.int(0) // numrecs (kayıt boyutu yok)
    y.int(NC_DIMENSION); y.int(boyutlar.length)
    for (const d of boyutlar) { y.ad(d.ad); y.int(d.uzunluk) }
    oznitelikListesi(y, gattlar)
    y.int(NC_VARIABLE); y.int(degiskenler.length)
    degiskenler.forEach((v, i) => {
      y.ad(v.ad)
      y.int(v.boyutlar.length)
      for (const d of v.boyutlar) y.int(d)
      oznitelikListesi(y, v.oznitelikler)
      y.int(v.tip)
      y.uint(v.vsize > 0xfffffffc ? 0xffffffff : v.vsize) // > 2^32-4 ise 2^32-1 (spesifikasyon)
      if (surum === 1) y.int(beginler[i]); else y.int64(beginler[i])
    })
    return y.sonuc()
  }
  for (const v of degiskenler) {
    v.ham = degerBaytlari(v.tip, v.veri)
    v.vsize = hiza4(v.ham.length)
  }
  const bosBaslik = baslikKur(degiskenler.map(() => 0))
  const beginler = []
  let o = bosBaslik.length
  for (const v of degiskenler) { beginler.push(o); o += v.vsize }
  const baslik = baslikKur(beginler)
  const veri = new Uint8Array(o)
  veri.set(baslik, 0)
  degiskenler.forEach((v, i) => veri.set(v.ham, beginler[i]))
  return { veri, toplam: o, sonBegin: beginler[beginler.length - 1] ?? 0 }
}

// ---------------------------------------------------------------- ana giriş
/**
 * GeoJSON FeatureCollection → NetCDF klasik (CF-1.8 geometri) Uint8Array.
 */
export async function netcdfYaz(fc, secenekler = {}) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.')
  }
  const uyarilar = []
  const sayac = { gecersiz: 0, parca: 0, cevrilen: 0 }
  const aileler = { nokta: [], cizgi: [], poligon: [] }
  const geometrisiz = []
  let dagitilan = 0
  fc.features.forEach((f) => {
    if (!f || typeof f !== 'object') return
    const cikti = { nokta: [], cizgi: [], poligon: [] }
    ayristir(f.geometry, cikti, sayac)
    const dolu = AILELER.filter((a) => cikti[a].length)
    if (!dolu.length) { geometrisiz.push(f); return }
    if (dolu.length > 1) dagitilan++
    for (const a of dolu) aileler[a].push({ f, parcalar: cikti[a] })
  })
  const yazilacak = AILELER.filter((a) => aileler[a].length)
  if (!yazilacak.length) {
    throw new Error(
      fc.features.length
        ? 'NetCDF yazılamadı: geometrisi olan obje yok; CF geometry_type belirlenemiyor (klasik biçimde 0 uzunluklu sabit boyut da tanımlanamaz).'
        : 'NetCDF yazılamadı: FeatureCollection hiç obje içermiyor (klasik biçimde 0 uzunluklu sabit boyut tanımlanamaz).',
    )
  }
  if (geometrisiz.length) {
    const hedef = [...yazilacak].sort((a, b) => aileler[b].length - aileler[a].length)[0]
    for (const f of geometrisiz) aileler[hedef].push({ f, parcalar: [] })
    uyarilar.push(`${geometrisiz.length} geometrisiz obje "${hedef}" ailesine 0 düğümlü örnek (node_count = 0) olarak eklendi; öznitelikleri korundu.`)
  }
  if (sayac.gecersiz) uyarilar.push(`${sayac.gecersiz} köşe sayısal olmayan X/Y nedeniyle atlandı.`)
  if (sayac.parca) uyarilar.push(`${sayac.parca} yetersiz düğümlü parça (çizgi < 2, halka < 3) atlandı.`)
  if (sayac.cevrilen) uyarilar.push(`${sayac.cevrilen} poligon halkasının yönü CF kuralına göre çevrildi (dış: saat yönünün tersi, delik: saat yönü).`)
  if (dagitilan) uyarilar.push(`${dagitilan} karışık tipli GeometryCollection parçaları ailelere dağıtıldı (öznitelikler kopyalandı).`)
  if (yazilacak.length > 1) uyarilar.push(`Veride ${yazilacak.length} geometri ailesi var; her biri ayrı CF geometry container ile yazıldı.`)

  // CRS
  let crs = null
  if (secenekler.crs == null || secenekler.crs === '') {
    uyarilar.push('Hedef koordinat sistemi belirtilmedi; grid_mapping (crs) değişkeni yazılmadı.')
  } else {
    crs = cfCrsOznitelikleri(secenekler.crs)
    if (!crs) uyarilar.push(`"${secenekler.crs}" için CF grid_mapping tanımı yok; crs değişkeni yazılmadı.`)
  }

  const boyutlar = []
  const degiskenler = []
  const kullanilan = new Set(['crs'])
  const boyutEkle = (ad, uzunluk) => { boyutlar.push({ ad, uzunluk }); return boyutlar.length - 1 }
  if (crs) degiskenler.push({ ad: 'crs', boyutlar: [], tip: NC.INT, veri: [0], oznitelikler: crs.oznitelikler })

  // Tüm aileler için ayrılmış adlar (öznitelik değişkenleriyle çakışmasın)
  for (const a of yazilacak) {
    for (const s of ['geometri', 'x', 'y', 'z', 'node_count', 'part_node_count', 'interior_ring']) kullanilan.add(`${a}_${s}`)
  }
  const ozet = []
  for (const a of yazilacak) {
    const uyeler = aileler[a]
    const konumlar = uyeler.flatMap((u) => u.parcalar.flatMap((p) => p.konumlar))
    const zVar = konumlar.some((k) => sayiMi(k[2]))
    const zEksik = zVar ? konumlar.filter((k) => !sayiMi(k[2])).length : 0
    if (zEksik) uyarilar.push(`"${a}" ailesinde ${zEksik} düğümün Z değeri yok; 0 yazıldı.`)
    const tumParcalar = uyeler.flatMap((u) => u.parcalar)
    const parcaGerekli = a !== 'nokta' && uyeler.some((u) => u.parcalar.length > 1)
    const icVar = a === 'poligon' && tumParcalar.some((p) => p.ic)

    const dInst = boyutEkle(`${a}_instance`, uyeler.length)
    const dNode = boyutEkle(`${a}_node`, konumlar.length)
    const dPart = parcaGerekli ? boyutEkle(`${a}_part`, tumParcalar.length) : null

    const kap = `${a}_geometri`
    const kapAtt = [
      { ad: 'geometry_type', tip: NC.CHAR, deger: CF_TIPI[a] },
      { ad: 'node_count', tip: NC.CHAR, deger: `${a}_node_count` },
      { ad: 'node_coordinates', tip: NC.CHAR, deger: zVar ? `${a}_x ${a}_y ${a}_z` : `${a}_x ${a}_y` },
    ]
    if (parcaGerekli) kapAtt.push({ ad: 'part_node_count', tip: NC.CHAR, deger: `${a}_part_node_count` })
    if (icVar) kapAtt.push({ ad: 'interior_ring', tip: NC.CHAR, deger: `${a}_interior_ring` })
    if (crs) kapAtt.push({ ad: 'grid_mapping', tip: NC.CHAR, deger: 'crs' })
    degiskenler.push({ ad: kap, boyutlar: [], tip: NC.INT, veri: [0], oznitelikler: kapAtt })

    const cografi = crs?.cografi
    const eksenAtt = (eksen) => (eksen === 'z'
      ? [{ ad: 'units', tip: NC.CHAR, deger: 'm' }, { ad: 'axis', tip: NC.CHAR, deger: 'Z' }, { ad: 'positive', tip: NC.CHAR, deger: 'up' }]
      : [
          { ad: 'units', tip: NC.CHAR, deger: cografi ? (eksen === 'x' ? 'degrees_east' : 'degrees_north') : 'm' },
          { ad: 'standard_name', tip: NC.CHAR, deger: cografi ? (eksen === 'x' ? 'longitude' : 'latitude') : `projection_${eksen}_coordinate` },
          { ad: 'axis', tip: NC.CHAR, deger: eksen.toUpperCase() },
        ])
    degiskenler.push({ ad: `${a}_x`, boyutlar: [dNode], tip: NC.DOUBLE, veri: konumlar.map((k) => k[0]), oznitelikler: eksenAtt('x') })
    degiskenler.push({ ad: `${a}_y`, boyutlar: [dNode], tip: NC.DOUBLE, veri: konumlar.map((k) => k[1]), oznitelikler: eksenAtt('y') })
    if (zVar) degiskenler.push({ ad: `${a}_z`, boyutlar: [dNode], tip: NC.DOUBLE, veri: konumlar.map((k) => (sayiMi(k[2]) ? k[2] : 0)), oznitelikler: eksenAtt('z') })
    degiskenler.push({
      ad: `${a}_node_count`, boyutlar: [dInst], tip: NC.INT,
      veri: uyeler.map((u) => u.parcalar.reduce((t, p) => t + p.konumlar.length, 0)),
      oznitelikler: [{ ad: 'long_name', tip: NC.CHAR, deger: 'count of coordinates in each instance geometry' }],
    })
    if (parcaGerekli) {
      degiskenler.push({
        ad: `${a}_part_node_count`, boyutlar: [dPart], tip: NC.INT, veri: tumParcalar.map((p) => p.konumlar.length),
        oznitelikler: [{ ad: 'long_name', tip: NC.CHAR, deger: 'count of coordinates in each geometry part' }],
      })
    }
    if (icVar) {
      degiskenler.push({
        ad: `${a}_interior_ring`, boyutlar: [dPart], tip: NC.INT, veri: tumParcalar.map((p) => (p.ic ? 1 : 0)),
        oznitelikler: [{ ad: 'long_name', tip: NC.CHAR, deger: 'type of each geometry part' }],
      })
    }

    // Öznitelik değişkenleri
    const anahtarlar = []
    const gorulen = new Set()
    for (const { f } of uyeler) {
      for (const k of Object.keys(f.properties && typeof f.properties === 'object' ? f.properties : {})) {
        if (!gorulen.has(k)) { gorulen.add(k); anahtarlar.push(k) }
      }
    }
    const alanlar = []
    for (const k of anahtarlar) {
      const ad = degiskenAdi(yazilacak.length > 1 ? `${a}_${k}` : k, kullanilan)
      const degerler = uyeler.map(({ f }) => f.properties?.[k])
      const dolu = degerler.filter((v) => v !== null && v !== undefined)
      const ortak = [
        { ad: 'long_name', tip: NC.CHAR, deger: k },
        { ad: 'geometry', tip: NC.CHAR, deger: kap },
      ]
      if (dolu.length && dolu.every((v) => typeof v === 'number')) {
        if (dolu.some((v) => !Number.isFinite(v))) uyarilar.push(`"${k}" alanındaki NaN/Infinity değerleri _FillValue olarak yazıldı.`)
        degiskenler.push({
          ad, boyutlar: [dInst], tip: NC.DOUBLE,
          veri: degerler.map((v) => (sayiMi(v) ? v : NC_FILL_DOUBLE)),
          oznitelikler: [{ ad: '_FillValue', tip: NC.DOUBLE, deger: [NC_FILL_DOUBLE] }, ...ortak],
        })
        alanlar.push(`${ad} double`)
      } else if (dolu.length && dolu.every((v) => typeof v === 'boolean')) {
        degiskenler.push({
          ad, boyutlar: [dInst], tip: NC.BYTE,
          veri: degerler.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : -127)),
          oznitelikler: [
            { ad: '_FillValue', tip: NC.BYTE, deger: [-127] },
            ...ortak,
            { ad: 'flag_values', tip: NC.BYTE, deger: [0, 1] },
            { ad: 'flag_meanings', tip: NC.CHAR, deger: 'false true' },
          ],
        })
        alanlar.push(`${ad} byte (mantıksal)`)
      } else {
        const metinler = degerler.map((v) => (v === null || v === undefined ? new Uint8Array(0)
          : kodla(typeof v === 'object' ? JSON.stringify(v) : String(v))))
        const uz = Math.max(1, ...metinler.map((m) => m.length))
        const dStr = boyutEkle(`${ad}_strlen`, uz)
        const ham = new Uint8Array(uz * uyeler.length)
        metinler.forEach((m, i) => ham.set(m, i * uz))
        degiskenler.push({
          ad, boyutlar: [dInst, dStr], tip: NC.CHAR, veri: ham,
          oznitelikler: [...ortak, { ad: '_Encoding', tip: NC.CHAR, deger: 'utf-8' }],
        })
        alanlar.push(`${ad} char[${uz}]`)
      }
    }
    ozet.push({ a, ornek: uyeler.length, dugum: konumlar.length, parca: parcaGerekli ? tumParcalar.length : null, zVar, alanlar })
  }

  const gattlar = [
    { ad: 'Conventions', tip: NC.CHAR, deger: 'CF-1.8' },
    { ad: 'featureType', tip: NC.CHAR, deger: yazilacak.length === 1 ? CF_TIPI[yazilacak[0]] : 'mixed' },
    { ad: 'source', tip: NC.CHAR, deger: 'GeoConverterProEA' },
    { ad: 'history', tip: NC.CHAR, deger: `${new Date().toISOString()} GeoConverterProEA ile oluşturuldu` },
  ]
  if (secenekler.baslik) gattlar.push({ ad: 'title', tip: NC.CHAR, deger: String(secenekler.baslik) })

  let surum = 1
  let sonuc = dosyaKur(boyutlar, gattlar, degiskenler, 1)
  if (sonuc.sonBegin > INT32_AZAMI) {
    surum = 2
    sonuc = dosyaKur(boyutlar, gattlar, degiskenler, 2)
    uyarilar.push('Veri 2 GiB ofset sınırını aştı; CDF-2 (64-bit ofset) biçimi kullanıldı.')
  }

  const satirlar = [`NetCDF klasik (CDF-${surum}), Conventions = CF-1.8`, `Dosya: ${sonuc.toplam} bayt`]
  satirlar.push(crs ? `CRS: ${String(secenekler.crs).toUpperCase()} (${crs.oznitelikler[0].deger})` : 'CRS: yazılmadı')
  satirlar.push('', 'Boyutlar:', ...boyutlar.map((d) => `  ${d.ad} = ${d.uzunluk}`))
  for (const o of ozet) {
    satirlar.push('', `Geometri: ${o.a}_geometri (geometry_type = ${CF_TIPI[o.a]}) — örnek ${o.ornek}, düğüm ${o.dugum}${o.parca ? `, parça ${o.parca}` : ''}${o.zVar ? ', Z var' : ''}`)
    satirlar.push(...(o.alanlar.length ? o.alanlar.map((x) => `  ${x}`) : ['  (öznitelik yok)']))
  }
  return { veri: sonuc.veri, onizleme: satirlar.join('\n'), uyarilar }
}
