/**
 * MapInfo TAB (yerel/NATIVE ikili biçim, MITAB) yazıcısı: GeoJSON FeatureCollection →
 * ZIP içinde <ad>.tab + <ad>.dat + <ad>.map + <ad>.id.
 *
 * Yapı GDAL'ın MITAB sürücüsünün (ogr/ogrsf_frmts/mitab, GDAL 3.12) yazdığı dosyalar bayt bayt
 * incelenerek izlenmiştir:
 *  .tab  Metin başlık: !table / !version 300 (MultiPoint varsa 450) / !charset WindowsTurkish,
 *        "Definition Table", Type NATIVE Charset, Fields.
 *  .dat  dBASE III tabanlı; MapInfo farkları (mitab_datfile.cpp): Integer/SmallInt/Float/Date
 *        alanları DBF başlığında 'C' tipli, değerleri İKİLİ (küçük endian int32/int16/double,
 *        tarih = int16 yıl + bayt ay + bayt gün); Char alanları NUL ile doldurulur; Logical 'L'
 *        tipli ama değeri ikili 1/0 bayt. Date alanı varsa GDAL gibi !version 450 yazılır.
 *        Metinler Windows-1254 (Türkçe) kodlanır.
 *  .map  1024 baytlık başlık bloğu + 512 baytlık bloklar:
 *        - başlık: nesne uzunluk tablosu (73 bayt), 0x100'de sihirli sayı 42424242, sürüm 500,
 *          blok boyu 512, tamsayı MBR, ilk indeks/araç bloğu, nesne sayıları, CoordSys
 *          (proj/datum/elipsoit/birim + 6 parametre + datum kaydırma/7 parametre),
 *          XScale/YScale/XDispl/YDispl.
 *        - nesne blokları (tip 2, 20 bayt başlık), koordinat blokları (tip 3, 8 bayt başlık,
 *          zincirli), R-tree indeks blokları (tip 1, giriş başına 20 bayt, en çok 25 giriş),
 *          araç bloğu (tip 5: kalem/fırça/sembol tanımları).
 *  .id   Her kayıt için .map içindeki nesne adresi (int32); geometrisiz kayıt 0.
 *
 * Kararlar
 *  - Koordinat ↔ tamsayı: GDAL SetCoordsysBounds formülü (ölçek = 2e9 / sınır genişliği,
 *    öteleme = −ölçek · sınır merkezi). GDAL varsayılanı projeksiyonun tüm geçerlilik alanını
 *    sınır alır (TM'de ~3 cm, coğrafide ~11 cm çözünürlük); bu yazıcı sınırı VERİ kapsamından
 *    (her eksende merkez ± 0.6 × genişlik, en az ±100 m / ±0.001°) seçer → milimetre altı
 *    çözünürlük (2000 km'lik veriye dek ≤ 1 mm). Bedeli: tablo sonradan MapInfo'da bu sınırın
 *    dışına genişletilemez.
 *  - Nesne tipleri GDAL gibi: nokta → SYMBOL (0x02), tek parça çizgi → PLINE, çok parça →
 *    MULTIPLINE, poligon/MultiPolygon → tek REGION (tüm halkalar; delikler dış halkanın
 *    numHoles sayısıyla), MultiPoint → MULTIPOINT (sürüm 450). Nesnenin tamsayı kapsamı
 *    65534'ten küçükse "compressed" (_C, int16 göreli koordinat) türü seçilir.
 *  - CRS: WGS84 (datum 104), Web Mercator (proj 10, datum 157), TUREF/ITRF96 TM (proj 8,
 *    özel datum 999 + GRS80 + sıfır kaydırma = katalog.js; MapInfo'da TUREF datumu yok, GDAL 999'u
 *    "GRS 80 + TOWGS84[0…]" olarak okur), ED50 UTM (proj 8, özel datum 9999 + Hayford/International
 *    1924 + katalog.js'teki 7 parametre; MapInfo dönüklükleri ters işaretle saklar).
 */
import JSZip from 'jszip'

// ---------------------------------------------------------------- Windows-1254
const CP1254_OZEL = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86], ['‡', 0x87],
  ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c], ['‘', 0x91], ['’', 0x92],
  ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97], ['˜', 0x98], ['™', 0x99],
  ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c], ['Ÿ', 0x9f],
  ['Ğ', 0xd0], ['İ', 0xdd], ['Ş', 0xde], ['ğ', 0xf0], ['ı', 0xfd], ['ş', 0xfe],
])
const CP1254_DISI_LATIN1 = new Set([0xd0, 0xdd, 0xde, 0xf0, 0xfd, 0xfe])

function cp1254Bayt(karakter) {
  const kod = karakter.codePointAt(0)
  if (kod < 0x80) return kod
  const ozel = CP1254_OZEL.get(karakter)
  if (ozel !== undefined) return ozel
  if (kod >= 0xa0 && kod <= 0xff && !CP1254_DISI_LATIN1.has(kod)) return kod
  return -1
}

/** Metni Windows-1254 baytlarına çevirir; karşılığı olmayan karakterler '?' olur. */
export function cp1254Kodla(metin) {
  const b = []
  let eksik = 0
  for (const k of String(metin).normalize('NFC')) {
    const v = cp1254Bayt(k)
    if (v < 0) { b.push(0x3f); eksik++ } else b.push(v)
  }
  return { baytlar: Uint8Array.from(b), eksik }
}

// ---------------------------------------------------------------- CoordSys tablosu
const TM = (dom, olcek) => [dom, 0, olcek, 500000, 0, 0]
const COORDSYS = {
  'EPSG:4326': { proj: 1, datum: 104, elipsoit: 28, birim: 13, param: [0, 0, 0, 0, 0, 0], cografi: true },
  'EPSG:3857': { proj: 10, datum: 157, elipsoit: 54, birim: 7, param: [0, 0, 1, 0, 0, 0] },
}
;[27, 30, 33, 36, 39, 42, 45].forEach((dom, i) => {
  COORDSYS[`EPSG:${5253 + i}`] = { proj: 8, datum: 999, elipsoit: 0, birim: 7, param: TM(dom, 1) }
})
;[35, 36, 37, 38].forEach((zon) => {
  COORDSYS[`EPSG:${23000 + zon}`] = {
    // Elipsoit 5 (Hayford = International 1924, 6378388 / 297). GDAL da 5 yazar; 4 ile okuma
    // tarafı 9999'u "Luxembourg 1930" kaydına eşleyip TOWGS84'ü düşürüyor (GDAL 3.12'de denendi).
    proj: 8, datum: 9999, elipsoit: 5, birim: 7, param: TM(zon * 6 - 183, 0.9996),
    // katalog.js: towgs84=-84.1,-101.8,-129.7,0,0,0.468,1.05 (Position Vector). MapInfo 9999
    // dönüklükleri ters işaretle saklar (GDAL de böyle yazar/okur); son değer başlangıç meridyeni.
    kaydirma: [-84.1, -101.8, -129.7], datumParam: [-0, -0, -0.468, 1.05, 0],
  }
})
export const MAPINFO_COORDSYS = Object.freeze(COORDSYS)

// ---------------------------------------------------------------- .map sabitleri
const BLOK = 512
const BASLIK_BLOK = 1024
const NESNE_BASLIK = 20
const KOORD_BASLIK = 8
const INDEKS_GIRIS = 20
const INDEKS_AZAMI = Math.floor((BLOK - 4) / INDEKS_GIRIS) // 25
const NESNE_UZUNLUK = [
  0x00, 0x0a, 0x0e, 0x15, 0x0e, 0x16, 0x1b, 0xa2, 0xa6, 0xab, 0x1a, 0x2a, 0x2f, 0xa5, 0xa9, 0xb5,
  0xa7, 0xb5, 0xd9, 0x0f, 0x17, 0x23, 0x13, 0x1f, 0x2b, 0x0f, 0x17, 0x23, 0x4f, 0x57, 0x63, 0x9c,
  0xa4, 0xa9, 0xa0, 0xa8, 0xad, 0xa4, 0xa8, 0xad, 0x16, 0x1a, 0x39, 0x0d, 0x11, 0x37, 0xa5, 0xa9,
  0xb5, 0xa4, 0xa8, 0xad, 0xb2, 0xb6, 0xdc, 0xbd, 0xbd, 0xf4, 0x2b, 0x2f, 0x55, 0xc8, 0xcc, 0xd8,
  0xc7, 0xcb, 0xd0, 0xd3, 0xd7, 0xfd, 0xc2, 0xc2, 0xf9,
]
export const GEOM = {
  SYMBOL: 0x02, PLINE_C: 0x07, PLINE: 0x08, REGION_C: 0x0d, REGION: 0x0e,
  MULTIPLINE_C: 0x25, MULTIPLINE: 0x26, MULTIPOINT_C: 0x34, MULTIPOINT: 0x35,
}
const nesneBoyu = (tip) => NESNE_UZUNLUK[tip] & 0x7f
const INT16_SINIR = 65534
const BOLUM_AZAMI = 32767
const roundInt = (v) => Math.trunc(v >= 0 ? v + 0.5 : v - 0.5)
const sayiMi = (v) => typeof v === 'number' && Number.isFinite(v)

// ---------------------------------------------------------------- geometri hazırlama
function konumlariAl(g, cikti, sayac) {
  if (g == null || typeof g !== 'object') return
  const c = g.coordinates
  const dizi = (x) => (Array.isArray(x) ? x : [])
  const k2 = (k) => {
    if (!Array.isArray(k) || !sayiMi(k[0]) || !sayiMi(k[1])) { sayac.gecersiz++; return null }
    if (k.length > 2 && sayiMi(k[2])) sayac.z++
    return [k[0], k[1]]
  }
  const liste = (l) => dizi(l).map(k2).filter(Boolean)
  const halka = (h) => {
    let t = liste(h)
    if (t.length >= 3) {
      const a = t[0], b = t[t.length - 1]
      if (a[0] !== b[0] || a[1] !== b[1]) { t = [...t, a]; sayac.kapatilan++ }
    }
    if (t.length < 4) { if (t.length) sayac.parca++; return null }
    return t
  }
  switch (g.type) {
    case 'Point': { const k = k2(c); if (k) cikti.nokta.push(k); break }
    case 'MultiPoint': cikti.nokta.push(...liste(c)); break
    case 'LineString':
    case 'MultiLineString':
      for (const l of g.type === 'LineString' ? [c] : dizi(c)) {
        const t = liste(l)
        if (t.length >= 2) cikti.cizgi.push(t)
        else if (t.length) sayac.parca++
      }
      break
    case 'Polygon':
    case 'MultiPolygon':
      for (const p of g.type === 'Polygon' ? [c] : dizi(c)) {
        const halkalar = dizi(p).map(halka)
        if (!halkalar[0]) { if (halkalar.length) sayac.parca++; continue }
        cikti.poligon.push(halkalar.filter(Boolean))
      }
      break
    case 'GeometryCollection': for (const alt of dizi(g.geometries)) konumlariAl(alt, cikti, sayac); break
    default: throw new Error(`Desteklenmeyen geometri tipi: "${g.type}".`)
  }
}

/** Objenin MapInfo nesne tanımı (koordinatlar henüz gerçek sayı). */
function nesneTanimi(f, sayac) {
  const c = { nokta: [], cizgi: [], poligon: [] }
  konumlariAl(f?.geometry, c, sayac)
  const aileler = ['poligon', 'cizgi', 'nokta'].filter((a) => c[a].length)
  if (!aileler.length) return null
  if (aileler.length > 1) sayac.karma++
  const a = aileler[0] // öncelik: bölge > çizgi > nokta
  if (a === 'poligon') {
    const bolumler = []
    for (const p of c.poligon) {
      p.forEach((h, i) => bolumler.push({ konumlar: h, delik: i === 0 ? p.length - 1 : 0 }))
    }
    return { tur: 'bolge', bolumler }
  }
  if (a === 'cizgi') return { tur: 'cizgi', bolumler: c.cizgi.map((k) => ({ konumlar: k, delik: 0 })) }
  return c.nokta.length === 1 ? { tur: 'nokta', konum: c.nokta[0] } : { tur: 'coklunokta', konumlar: c.nokta }
}

// ---------------------------------------------------------------- ikili yazıcı
class Tampon {
  constructor(boy) { this.u8 = new Uint8Array(boy); this.dv = new DataView(this.u8.buffer); this.o = 0 }
  i8(v) { this.dv.setUint8(this.o, v & 0xff); this.o += 1 }
  i16(v) { this.dv.setInt16(this.o, v, true); this.o += 2 }
  i32(v) { this.dv.setInt32(this.o, v, true); this.o += 4 }
  f64(v) { this.dv.setFloat64(this.o, v, true); this.o += 8 }
  sifir(n) { this.o += n }
}

/** Kapsam (int) */
function kapsam(noktalar) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of noktalar) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1 }
}

/** Çizgi etiket noktası (GDAL GetCenter benzeri): tek sayıda köşede orta köşe, aksi halde orta kenarın ortası. */
function cizgiEtiketi(k) {
  const n = k.length
  if (n % 2 === 1) return k[(n - 1) / 2]
  const a = k[n / 2 - 1], b = k[n / 2]
  return [Math.trunc((a[0] + b[0]) / 2), Math.trunc((a[1] + b[1]) / 2)]
}

/**
 * Nesneyi kodlar: { tip, nesne(Uint8Array, koord işaretçisi sonra yazılır), koord(Uint8Array|null),
 * kapsam }. Koordinatlar tamsayıdır.
 */
function nesneKodla(n, id) {
  if (n.tur === 'nokta') {
    const t = new Tampon(nesneBoyu(GEOM.SYMBOL))
    t.i8(GEOM.SYMBOL); t.i32(id); t.i32(n.konum[0]); t.i32(n.konum[1]); t.i8(1)
    const [x, y] = n.konum
    return { tip: GEOM.SYMBOL, nesne: t.u8, koord: null, kapsam: { x0: x, y0: y, x1: x, y1: y }, sinif: 'nokta' }
  }
  const tumKonumlar = n.tur === 'coklunokta' ? n.konumlar : n.bolumler.flatMap((b) => b.konumlar)
  const kp = kapsam(tumKonumlar)
  const sikistir = kp.x1 - kp.x0 <= INT16_SINIR && kp.y1 - kp.y0 <= INT16_SINIR
  const ox = Math.trunc((kp.x0 + kp.x1) / 2)
  const oy = Math.trunc((kp.y0 + kp.y1) / 2)
  const kxy = (t, x, y) => { if (sikistir) { t.i16(x - ox); t.i16(y - oy) } else { t.i32(x); t.i32(y) } }
  const etiketMbr = (t, etiket) => {
    kxy(t, etiket[0], etiket[1])
    if (sikistir) { t.i32(ox); t.i32(oy) }
    kxy(t, kp.x0, kp.y0)
    kxy(t, kp.x1, kp.y1)
  }
  const kb = sikistir ? 4 : 8

  if (n.tur === 'coklunokta') {
    const tip = sikistir ? GEOM.MULTIPOINT_C : GEOM.MULTIPOINT
    const koord = new Tampon(n.konumlar.length * kb)
    for (const [x, y] of n.konumlar) kxy(koord, x, y)
    const t = new Tampon(nesneBoyu(tip))
    t.i8(tip); t.i32(id); t.i32(0) /* koord işaretçisi */; t.i32(n.konumlar.length)
    t.sifir(15); t.i8(1) /* sembol */; t.i8(0)
    etiketMbr(t, n.konumlar[0])
    return { tip, nesne: t.u8, koord: koord.u8, kapsam: kp, sinif: 'nokta', isaretciOfset: 5 }
  }

  const bolge = n.tur === 'bolge'
  const tekParca = !bolge && n.bolumler.length === 1
  if (n.bolumler.length > BOLUM_AZAMI || n.bolumler.some((b) => b.konumlar.length > BOLUM_AZAMI)) {
    throw new Error(`MapInfo ${bolge ? 'bölge' : 'çizgi'} nesnesinde 32767'den fazla bölüm/köşe (sürüm 300 sınırı); obje ${id}.`)
  }
  const tip = bolge ? (sikistir ? GEOM.REGION_C : GEOM.REGION)
    : tekParca ? (sikistir ? GEOM.PLINE_C : GEOM.PLINE) : (sikistir ? GEOM.MULTIPLINE_C : GEOM.MULTIPLINE)
  const nb = n.bolumler.length
  const basBoyu = tekParca ? 0 : nb * (sikistir ? 16 : 24)
  const koord = new Tampon(basBoyu + tumKonumlar.length * kb)
  if (!tekParca) {
    // Bölüm başlıkları: köşe sayısı, delik sayısı, MBR, veri ofseti (sıkıştırılmamış boyutlarla)
    let onceki = 0
    for (const b of n.bolumler) {
      const bk = kapsam(b.konumlar)
      koord.i16(b.konumlar.length)
      koord.i16(b.delik)
      kxy(koord, bk.x0, bk.y0)
      kxy(koord, bk.x1, bk.y1)
      koord.i32(nb * 24 + onceki * 8)
      onceki += b.konumlar.length
    }
  }
  for (const [x, y] of tumKonumlar) kxy(koord, x, y)
  const t = new Tampon(nesneBoyu(tip))
  t.i8(tip); t.i32(id); t.i32(0) /* koord işaretçisi */; t.i32(koord.u8.length)
  if (!tekParca) t.i16(nb)
  const etiket = bolge ? [Math.trunc((kp.x0 + kp.x1) / 2), Math.trunc((kp.y0 + kp.y1) / 2)] : cizgiEtiketi(n.bolumler[0].konumlar)
  etiketMbr(t, etiket)
  t.i8(1) // kalem
  if (bolge) t.i8(1) // fırça
  return { tip, nesne: t.u8, koord: koord.u8, kapsam: kp, sinif: bolge ? 'bolge' : 'cizgi', isaretciOfset: 5 }
}

// ---------------------------------------------------------------- .dat ve .tab
const TR_HARF = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' }
const ISO_TARIH = /^(\d{4})-(\d{2})-(\d{2})$/

/** Alan adları: ≤ 31 karakter, harf/rakam/_, Türkçe → ASCII, harfle başlar, benzersiz (büyük/küçük duyarsız). */
export function mapinfoAlanAdlari(anahtarlar) {
  const esleme = new Map()
  const kullanilan = new Set()
  for (const k of anahtarlar) {
    let ad = String(k).replace(/[çÇğĞıİöÖşŞüÜ]/g, (h) => TR_HARF[h])
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_]/g, '_')
    if (!ad) ad = 'ALAN'
    if (!/^[A-Za-z]/.test(ad)) ad = `F_${ad}`
    ad = ad.slice(0, 31)
    if (kullanilan.has(ad.toUpperCase())) {
      for (let n = 1; ; n++) {
        const aday = ad.slice(0, 31 - String(n).length - 1) + `_${n}`
        if (!kullanilan.has(aday.toUpperCase())) { ad = aday; break }
      }
    }
    kullanilan.add(ad.toUpperCase())
    esleme.set(k, ad)
  }
  return esleme
}

function tarihParcala(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return [v.getFullYear(), v.getMonth() + 1, v.getDate()]
  if (typeof v === 'string') {
    const m = ISO_TARIH.exec(v)
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
      if (d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]) return [+m[1], +m[2], +m[3]]
    }
  }
  return null
}

const metneCevir = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))

function alanTipi(degerler) {
  const dolu = degerler.filter((v) => v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v)))
  if (dolu.length && dolu.every((v) => typeof v === 'boolean')) return { tip: 'Logical', dbf: 'L', uzunluk: 1 }
  if (dolu.length && dolu.every((v) => typeof v === 'number')) {
    if (dolu.every((v) => Number.isInteger(v) && v >= -2147483647 && v <= 2147483647)) return { tip: 'Integer', dbf: 'C', uzunluk: 4 }
    return { tip: 'Float', dbf: 'C', uzunluk: 8 }
  }
  if (dolu.length && dolu.every((v) => tarihParcala(v))) return { tip: 'Date', dbf: 'C', uzunluk: 4 }
  const uz = Math.min(254, Math.max(1, ...dolu.map((v) => cp1254Kodla(metneCevir(v)).baytlar.length)))
  return { tip: 'Char', dbf: 'C', uzunluk: uz }
}

function datUret(objeler, alanlar, uyar) {
  const kayitBoyu = 1 + alanlar.reduce((t, a) => t + a.uzunluk, 0)
  const baslikBoyu = 32 + 32 * alanlar.length + 1
  const u8 = new Uint8Array(baslikBoyu + kayitBoyu * objeler.length + 1)
  const dv = new DataView(u8.buffer)
  const bugun = new Date()
  u8[0] = 0x03
  u8[1] = bugun.getFullYear() % 100
  u8[2] = bugun.getMonth() + 1
  u8[3] = bugun.getDate()
  dv.setUint32(4, objeler.length, true)
  dv.setUint16(8, baslikBoyu, true)
  dv.setUint16(10, kayitBoyu, true)
  alanlar.forEach((a, i) => {
    const o = 32 + 32 * i
    for (let k = 0; k < Math.min(10, a.ad.length); k++) u8[o + k] = a.ad.charCodeAt(k)
    u8[o + 11] = a.dbf.charCodeAt(0)
    u8[o + 16] = a.uzunluk
    u8[o + 17] = 0
  })
  u8[baslikBoyu - 1] = 0x0d
  let bos = 0, kesilen = 0, eksik = 0
  let o = baslikBoyu
  for (const f of objeler) {
    u8[o++] = 0x20
    for (const a of alanlar) {
      const v = f?.properties?.[a.kaynak]
      const yok = v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))
      switch (a.tip) {
        case 'Integer': if (yok) bos++; else dv.setInt32(o, v, true); break
        case 'Float': if (yok) bos++; else dv.setFloat64(o, v, true); break
        case 'Logical': u8[o] = !yok && v ? 1 : 0; if (yok) bos++; break // GDAL: ikili 1/0
        case 'Date': {
          const t = yok ? null : tarihParcala(v)
          if (t) { dv.setInt16(o, t[0], true); u8[o + 2] = t[1]; u8[o + 3] = t[2] }
          break
        }
        default: if (!yok) {
          const { baytlar, eksik: e } = cp1254Kodla(metneCevir(v))
          eksik += e
          if (baytlar.length > a.uzunluk) kesilen++
          u8.set(baytlar.subarray(0, a.uzunluk), o)
        }
      }
      o += a.uzunluk
    }
  }
  u8[u8.length - 1] = 0x1a
  if (bos) uyar(`${bos} boş sayısal/mantıksal değer 0/yanlış yazıldı (MapInfo bu alan tiplerinde boş değer desteklemez).`)
  if (kesilen) uyar(`${kesilen} metin değeri Char(254) sınırı nedeniyle kesildi.`)
  if (eksik) uyar(`${eksik} karakter Windows-1254'te karşılığı olmadığı için "?" yazıldı.`)
  return u8
}

function tabMetni(alanlar, surum) {
  const s = [
    '!table',
    `!version ${surum}`,
    '!charset WindowsTurkish',
    '',
    'Definition Table',
    '  Type NATIVE Charset "WindowsTurkish"',
    `  Fields ${alanlar.length}`,
  ]
  for (const a of alanlar) s.push(`    ${a.ad} ${a.tip === 'Char' ? `Char (${a.uzunluk})` : a.tip} ;`)
  return `${s.join('\n')}\n`
}

// ---------------------------------------------------------------- .map
function mapUret(nesneler, cs, donusum, mbr) {
  // 1) Nesneleri nesne bloklarına yerleştir
  const nesneBloklari = []
  let blok = null
  for (const n of nesneler) {
    if (!n) continue
    if (!blok || blok.boy + n.nesne.length > BLOK) {
      blok = { nesneler: [], boy: NESNE_BASLIK, kapsam: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity } }
      nesneBloklari.push(blok)
    }
    n.blokIci = blok.boy
    n.blok = blok
    blok.nesneler.push(n)
    blok.boy += n.nesne.length
    const k = blok.kapsam
    k.x0 = Math.min(k.x0, n.kapsam.x0); k.y0 = Math.min(k.y0, n.kapsam.y0)
    k.x1 = Math.max(k.x1, n.kapsam.x1); k.y1 = Math.max(k.y1, n.kapsam.y1)
  }
  // 2) Koordinat akışını bloklara yerleştir (blok başına 504 bayt; sığmayan küçük veri yeni bloğa)
  const koordBloklari = []
  let kb = null
  for (const n of nesneler) {
    if (!n || !n.koord) continue
    const boy = n.koord.length
    if (!kb || (BLOK - kb.boy < boy && boy <= BLOK - KOORD_BASLIK) || kb.boy === BLOK) {
      kb = { parcalar: [], boy: KOORD_BASLIK }
      koordBloklari.push(kb)
    }
    n.koordBlok = koordBloklari.length - 1
    n.koordBlokIci = kb.boy
    let kalan = n.koord
    for (;;) {
      const sigan = Math.min(kalan.length, BLOK - kb.boy)
      kb.parcalar.push({ veri: kalan.subarray(0, sigan), ofset: kb.boy })
      kb.boy += sigan
      kalan = kalan.subarray(sigan)
      if (!kalan.length) break
      kb = { parcalar: [], boy: KOORD_BASLIK }
      koordBloklari.push(kb)
    }
    n.koordSonBlok = koordBloklari.length - 1
  }
  // 3) İndeks ağacı (yapraklar: nesne blokları)
  const seviyeler = []
  let girisler = nesneBloklari.map((b) => ({ kapsam: b.kapsam, hedef: b }))
  while (girisler.length) {
    const dugumler = []
    for (let i = 0; i < girisler.length; i += INDEKS_AZAMI) {
      const g = girisler.slice(i, i + INDEKS_AZAMI)
      const k = {
        x0: Math.min(...g.map((e) => e.kapsam.x0)), y0: Math.min(...g.map((e) => e.kapsam.y0)),
        x1: Math.max(...g.map((e) => e.kapsam.x1)), y1: Math.max(...g.map((e) => e.kapsam.y1)),
      }
      dugumler.push({ girisler: g, kapsam: k })
    }
    seviyeler.push(dugumler)
    if (dugumler.length === 1) break
    girisler = dugumler.map((d) => ({ kapsam: d.kapsam, hedef: d }))
  }
  const indeksBloklari = seviyeler.flat().reverse() // kök önce

  // 4) Araç tanımları
  const kalem = nesneler.filter((n) => n && n.sinif !== 'nokta').length
  const firca = nesneler.filter((n) => n && n.sinif === 'bolge').length
  const sembol = nesneler.filter((n) => n && n.sinif === 'nokta').length
  const araclar = []
  if (kalem) araclar.push([1, kalem, 1, 2, 0, 0, 0, 0]) // tip, ref, genişlik, desen, nokta genişliği, RGB
  if (firca) araclar.push([2, firca, 1, 0, 0, 0, 0, 0xff, 0xff, 0xff]) // desen 1 (boş), saydam, ön/arka renk
  if (sembol) araclar.push([4, sembol, 35, 12, 0, 0, 0, 0]) // sembol 35, boyut 12, özel stil, RGB
  const aracVar = araclar.length > 0

  // 5) Adresler
  let adres = BASLIK_BLOK
  for (const b of nesneBloklari) { b.adres = adres; adres += BLOK }
  for (const b of koordBloklari) { b.adres = adres; adres += BLOK }
  for (const b of indeksBloklari) { b.adres = adres; adres += BLOK }
  const aracAdres = aracVar ? adres : 0
  if (aracVar) adres += BLOK
  const u8 = new Uint8Array(adres)
  const dv = new DataView(u8.buffer)

  // Nesne blokları
  for (const b of nesneBloklari) {
    const ilkKoord = b.nesneler.filter((n) => n.koord)
    dv.setInt16(b.adres, 2, true)
    dv.setInt16(b.adres + 2, b.boy - NESNE_BASLIK, true)
    dv.setInt32(b.adres + 4, Math.trunc((b.kapsam.x0 + b.kapsam.x1) / 2), true)
    dv.setInt32(b.adres + 8, Math.trunc((b.kapsam.y0 + b.kapsam.y1) / 2), true)
    dv.setInt32(b.adres + 12, ilkKoord.length ? koordBloklari[ilkKoord[0].koordBlok].adres : 0, true)
    dv.setInt32(b.adres + 16, ilkKoord.length ? koordBloklari[ilkKoord[ilkKoord.length - 1].koordSonBlok].adres : 0, true)
    for (const n of b.nesneler) {
      n.adres = b.adres + n.blokIci
      u8.set(n.nesne, n.adres)
      if (n.koord) dv.setInt32(n.adres + n.isaretciOfset, koordBloklari[n.koordBlok].adres + n.koordBlokIci, true)
    }
  }
  // Koordinat blokları
  koordBloklari.forEach((b, i) => {
    dv.setInt16(b.adres, 3, true)
    dv.setInt16(b.adres + 2, b.boy - KOORD_BASLIK, true)
    dv.setInt32(b.adres + 4, i + 1 < koordBloklari.length ? koordBloklari[i + 1].adres : 0, true)
    for (const p of b.parcalar) u8.set(p.veri, b.adres + p.ofset)
  })
  // İndeks blokları
  for (const b of indeksBloklari) {
    dv.setInt16(b.adres, 1, true)
    dv.setInt16(b.adres + 2, b.girisler.length, true)
    b.girisler.forEach((e, i) => {
      const o = b.adres + 4 + i * INDEKS_GIRIS
      dv.setInt32(o, e.kapsam.x0, true); dv.setInt32(o + 4, e.kapsam.y0, true)
      dv.setInt32(o + 8, e.kapsam.x1, true); dv.setInt32(o + 12, e.kapsam.y1, true)
      dv.setInt32(o + 16, e.hedef.adres, true)
    })
  }
  // Araç bloğu
  if (aracVar) {
    const t = new Tampon(BLOK)
    t.i16(5); t.i16(0); t.i32(0)
    for (const [tip, ref, ...geri] of araclar) {
      t.i8(tip); t.i32(ref)
      if (tip === 4) { t.i16(geri[0]); t.i16(geri[1]); for (const b of geri.slice(2)) t.i8(b) } else for (const b of geri) t.i8(b)
    }
    new DataView(t.u8.buffer).setInt16(2, t.o - 8, true)
    u8.set(t.u8, aracAdres)
  }

  // Başlık bloğu
  const h = new Tampon(BASLIK_BLOK)
  u8.set(Uint8Array.from(NESNE_UZUNLUK), 0)
  h.o = 0x100
  h.i32(42424242); h.i16(500); h.i16(BLOK)
  h.f64(1.0)
  h.i32(mbr.x0); h.i32(mbr.y0); h.i32(mbr.x1); h.i32(mbr.y1)
  h.sifir(16)
  h.i32(indeksBloklari.length ? indeksBloklari[0].adres : 0)
  h.i32(0) // ilk çöp blok
  h.i32(aracAdres)
  const say = (s) => nesneler.filter((n) => n && n.sinif === s).length
  h.i32(say('nokta')); h.i32(say('cizgi')); h.i32(say('bolge')); h.i32(0)
  const enBuyukKoord = Math.max(0, ...nesneler.filter((n) => n && n.koord).map((n) => n.koord.length))
  h.i32(enBuyukKoord ? Math.ceil(enBuyukKoord / BLOK) * BLOK : 0)
  h.sifir(14)
  h.i8(7) // uzaklık birimi: metre
  h.i8(indeksBloklari.length ? seviyeler.length + 1 : 0) // en büyük indeks derinliği
  h.i8(3) // koordinat hassasiyeti (GDAL varsayılanı)
  h.i8(1) // köken çeyreği: KD
  h.i8(0) // X ekseni yansıtma yok
  h.i8(NESNE_UZUNLUK.length - 1)
  h.i8(kalem ? 1 : 0); h.i8(firca ? 1 : 0); h.i8(sembol ? 1 : 0); h.i8(0)
  h.i8(aracVar ? 1 : 0)
  h.sifir(1)
  h.i16(cs.datum)
  h.sifir(1)
  h.i8(cs.proj); h.i8(cs.elipsoit); h.i8(cs.birim)
  h.f64(donusum.xOlcek); h.f64(donusum.yOlcek); h.f64(donusum.xOtel); h.f64(donusum.yOtel)
  for (let i = 0; i < 6; i++) h.f64(cs.param[i] ?? 0)
  const kay = cs.kaydirma ?? [0, 0, 0]
  for (const v of kay) h.f64(v)
  for (let i = 0; i < 5; i++) h.f64(cs.datumParam?.[i] ?? 0)
  u8.set(h.u8.subarray(0x100), 0x100)

  return { u8, nesneBlokSayisi: nesneBloklari.length, koordBlokSayisi: koordBloklari.length, indeksBlokSayisi: indeksBloklari.length }
}

/** GDAL SetCoordsysBounds: ölçek = 2e9 / genişlik, öteleme = −ölçek · merkez. */
export function koordinatDonusumu(x0, y0, x1, y1) {
  if (x1 === x0) { x0 -= 1; x1 += 1 }
  if (y1 === y0) { y0 -= 1; y1 += 1 }
  const xOlcek = 2e9 / (x1 - x0)
  const yOlcek = 2e9 / (y1 - y0)
  return { xOlcek, yOlcek, xOtel: -xOlcek * (x1 + x0) / 2, yOtel: -yOlcek * (y1 + y0) / 2, sinir: [x0, y0, x1, y1] }
}

// ---------------------------------------------------------------- ana giriş
/**
 * GeoJSON FeatureCollection → MapInfo TAB zip'i.
 * Boş FC: 0 kayıtlı geçerli tablo üretilir ve uyarılır (MapInfo/GDAL boş tabloyu açar).
 */
export async function mapinfoYaz(fc, secenekler = {}) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.')
  }
  const uyarilar = []
  const uyar = (m) => { if (!uyarilar.includes(m)) uyarilar.push(m) }
  const ad = String(secenekler.ad ?? 'cikti').replace(/\.[^.]*$/, '').replace(/[çÇğĞıİöÖşŞüÜ]/g, (h) => TR_HARF[h])
    .replace(/[^A-Za-z0-9_-]/g, '_') || 'cikti'
  const objeler = fc.features.filter((f) => f && typeof f === 'object')

  // CRS
  let cs = null
  const kod = secenekler.crs == null || secenekler.crs === '' ? null : String(secenekler.crs).trim().toUpperCase()
  if (kod) cs = COORDSYS[/^\d+$/.test(kod) ? `EPSG:${kod}` : kod] ?? null
  if (!kod) uyar('Hedef koordinat sistemi belirtilmedi; tablo "NonEarth" (metre) olarak yazıldı.')
  else if (!cs) uyar(`"${secenekler.crs}" için MapInfo CoordSys tanımı yok; tablo "NonEarth" (metre) olarak yazıldı.`)
  cs ??= { proj: 0, datum: 0, elipsoit: 0, birim: 7, param: [0, 0, 0, 0, 0, 0] }

  // Geometriler
  const sayac = { gecersiz: 0, z: 0, parca: 0, kapatilan: 0, karma: 0 }
  const tanimlar = objeler.map((f) => nesneTanimi(f, sayac))
  const gercekKonumlar = tanimlar.flatMap((t) => (!t ? [] : t.tur === 'nokta' ? [t.konum] : t.tur === 'coklunokta' ? t.konumlar : t.bolumler.flatMap((b) => b.konumlar)))
  let donusum
  if (gercekKonumlar.length) {
    const k = kapsam(gercekKonumlar)
    const enAz = cs.cografi ? 0.001 : 100
    const yx = Math.max((k.x1 - k.x0) * 0.6, enAz)
    const yy = Math.max((k.y1 - k.y0) * 0.6, enAz)
    const cx = (k.x0 + k.x1) / 2, cy = (k.y0 + k.y1) / 2
    donusum = koordinatDonusumu(cx - yx, cy - yy, cx + yx, cy + yy)
  } else {
    donusum = koordinatDonusumu(-1000, -1000, 1000, 1000)
  }
  const tam = ([x, y]) => [roundInt(x * donusum.xOlcek + donusum.xOtel), roundInt(y * donusum.yOlcek + donusum.yOtel)]
  const tamTanim = (t) => {
    if (!t) return null
    if (t.tur === 'nokta') return { tur: 'nokta', konum: tam(t.konum) }
    if (t.tur === 'coklunokta') return { tur: 'coklunokta', konumlar: t.konumlar.map(tam) }
    return { tur: t.tur, bolumler: t.bolumler.map((b) => ({ konumlar: b.konumlar.map(tam), delik: b.delik })) }
  }
  const nesneler = tanimlar.map((t, i) => (t ? nesneKodla(tamTanim(t), i + 1) : null))
  const cokluNokta = nesneler.some((n) => n && (n.tip === GEOM.MULTIPOINT || n.tip === GEOM.MULTIPOINT_C))
  const mbr = gercekKonumlar.length ? kapsam(nesneler.filter(Boolean).flatMap((n) => [[n.kapsam.x0, n.kapsam.y0], [n.kapsam.x1, n.kapsam.y1]]))
    : { x0: 0, y0: 0, x1: 0, y1: 0 }

  const bos = tanimlar.filter((t) => !t).length
  if (bos) uyar(`${bos} obje geometrisiz; kayıtları korunarak "none" nesnesi (.id = 0) olarak yazıldı.`)
  if (sayac.z) uyar(`MapInfo TAB 2 boyutludur; ${sayac.z} konumun Z değeri atıldı.`)
  if (sayac.gecersiz) uyar(`${sayac.gecersiz} köşe sayısal olmayan X/Y nedeniyle atlandı.`)
  if (sayac.parca) uyar(`${sayac.parca} yetersiz köşeli parça (çizgi < 2, halka < 4) atlandı.`)
  if (sayac.kapatilan) uyar(`${sayac.kapatilan} kapalı olmayan halka kapatıldı.`)
  if (sayac.karma) uyar(`${sayac.karma} karışık tipli GeometryCollection tek nesneye indirildi (öncelik: bölge > çizgi > nokta); diğer parçalar atıldı.`)

  // Öznitelikler
  const anahtarlar = []
  const gorulen = new Set()
  for (const f of objeler) {
    for (const k of Object.keys(f.properties && typeof f.properties === 'object' ? f.properties : {})) {
      if (!gorulen.has(k)) { gorulen.add(k); anahtarlar.push(k) }
    }
  }
  const adlar = mapinfoAlanAdlari(anahtarlar)
  for (const [k, a] of adlar) if (k !== a) uyar(`Alan adı "${k}" → "${a}" (MapInfo: en çok 31 karakter, ASCII harf/rakam/_).`)
  let alanlar = anahtarlar.map((k) => ({ ad: adlar.get(k), kaynak: k, ...alanTipi(objeler.map((f) => f.properties?.[k])) }))
  let datObjeleri = objeler
  if (!alanlar.length) {
    // MapInfo tablosu en az bir alan ister; GDAL gibi sıra numaralı FID alanı eklenir.
    alanlar = [{ ad: 'FID', kaynak: '__fid', tip: 'Integer', dbf: 'C', uzunluk: 4 }]
    datObjeleri = objeler.map((f, i) => ({ properties: { __fid: i + 1 } }))
    uyar('Öznitelik yok; MapInfo en az bir alan gerektirdiği için "FID" (Integer) alanı eklendi.')
  }
  // GDAL: MultiPoint nesnesi ya da Date alanı sürüm 450 gerektirir
  const surum = cokluNokta || alanlar.some((a) => a.tip === 'Date') ? 450 : 300
  const dat = datUret(datObjeleri, alanlar, uyar)
  const tab = tabMetni(alanlar, surum)
  const harita = mapUret(nesneler, cs, donusum, mbr)
  const id = new Uint8Array(4 * objeler.length)
  const idDv = new DataView(id.buffer)
  nesneler.forEach((n, i) => idDv.setInt32(4 * i, n ? n.adres : 0, true))
  if (!objeler.length) uyar('FeatureCollection boş; 0 kayıtlı MapInfo tablosu üretildi.')

  const zip = new JSZip()
  zip.file(`${ad}.tab`, tab)
  zip.file(`${ad}.dat`, dat)
  zip.file(`${ad}.map`, harita.u8)
  zip.file(`${ad}.id`, id)
  const veri = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })

  const tipSay = {}
  for (const n of nesneler) {
    const k = n ? Object.keys(GEOM).find((g) => GEOM[g] === n.tip) : 'NONE'
    tipSay[k] = (tipSay[k] || 0) + 1
  }
  const onizleme = [
    `MapInfo TAB (NATIVE, sürüm ${surum}, WindowsTurkish) — ${ad}.tab/.dat/.map/.id`,
    `Kayıt: ${objeler.length}; nesneler: ${Object.entries(tipSay).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`,
    `CoordSys: proj ${cs.proj}, datum ${cs.datum}, elipsoit ${cs.elipsoit}, birim ${cs.birim}${kod ? ` (${kod})` : ''}`,
    `Ölçek: X ${donusum.xOlcek}, Y ${donusum.yOlcek} (çözünürlük ${(1 / donusum.xOlcek).toExponential(2)} birim)`,
    `.map: ${harita.u8.length} bayt — nesne bloğu ${harita.nesneBlokSayisi}, koordinat bloğu ${harita.koordBlokSayisi}, indeks bloğu ${harita.indeksBlokSayisi}`,
    '',
    tab,
  ].join('\n')
  return { veri, onizleme, uyarilar }
}
