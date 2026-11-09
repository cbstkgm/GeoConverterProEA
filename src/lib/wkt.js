/**
 * WKT / EWKT / hex WKB-EWKB çözücü → GeoJSON geometrisi.
 *
 * Saf JavaScript (Worker ve Node'da çalışır). `wellknown` kütüphanesinin okuyamadığı ama gerçek
 * verilerde sık görülen biçimleri de destekler:
 *  - Z, M, ZM boyutları (ayrık "POINT Z (…)" veya bitişik "POINTZ(…)"); M değeri atılır, Z korunur.
 *  - SRID önekleri (EWKT "SRID=4326;…"), sondaki ";" ve boşluklar, büyük/küçük harf.
 *  - EMPTY geometriler (null döner), GEOMETRYCOLLECTION EMPTY dahil.
 *  - MULTIPOINT'in iki yazımı: (1 2, 3 4) ve ((1 2), (3 4)).
 *  - TRIANGLE → Polygon.
 *  - PostGIS dışa aktarımlarındaki hex WKB / EWKB (ör. "0101000020E6100000…"), ISO Z/M/ZM kodları dahil.
 * Okuyamadığında nedenini Türkçe söyleyen bir Error fırlatır.
 */

const BASIT_TIPLER = {
  POINT: 'Point',
  LINESTRING: 'LineString',
  POLYGON: 'Polygon',
  TRIANGLE: 'Polygon',
  MULTIPOINT: 'MultiPoint',
  MULTILINESTRING: 'MultiLineString',
  MULTIPOLYGON: 'MultiPolygon',
  GEOMETRYCOLLECTION: 'GeometryCollection',
}

const DESTEKLENMEYEN_TIPLER = new Set([
  'CIRCULARSTRING', 'COMPOUNDCURVE', 'CURVEPOLYGON', 'MULTICURVE', 'MULTISURFACE',
  'CURVE', 'SURFACE', 'POLYHEDRALSURFACE', 'TIN',
])

const TIP_DESENI = new RegExp(
  `^(${[...Object.keys(BASIT_TIPLER), ...DESTEKLENMEYEN_TIPLER].sort((a, b) => b.length - a.length).join('|')})(ZM|Z|M)?$`,
)

function hata(mesaj) {
  return new Error(mesaj)
}

// ---------------------------------------------------------------------------
// WKT
// ---------------------------------------------------------------------------

function sozcukle(metin) {
  const sozcukler = []
  const desen = /\s*(?:([A-Za-z]+)|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([(),])|(\S))/gy
  let m
  while (desen.lastIndex < metin.length && (m = desen.exec(metin))) {
    if (m[1]) sozcukler.push({ t: 'kelime', v: m[1].toUpperCase(), i: m.index })
    else if (m[2]) sozcukler.push({ t: 'sayi', v: Number(m[2]), i: m.index })
    else if (m[3]) sozcukler.push({ t: m[3], i: m.index })
    else if (m[4]) throw hata(`beklenmeyen karakter "${m[4]}" (konum ${m.index + 1})`)
    else break
  }
  return sozcukler
}

function wktAyristir(metin) {
  const s = sozcukle(metin)
  let k = 0
  const bak = () => s[k]
  const al = (tur, aciklama) => {
    const x = s[k]
    if (!x || x.t !== tur) {
      const nerede = x ? `konum ${x.i + 1}` : 'metin sonunda'
      throw hata(`${aciklama} bekleniyordu (${nerede})${x ? '' : '; parantez kapanmamış olabilir'}`)
    }
    k++
    return x
  }

  function konum(boyut) {
    const sayilar = []
    while (bak() && bak().t === 'sayi') sayilar.push(s[k++].v)
    if (sayilar.length < 2) throw hata(`koordinat için en az 2 sayı bekleniyordu (konum ${(bak()?.i ?? metin.length) + 1})`)
    if (sayilar.length > 4) throw hata(`bir koordinatta 4'ten fazla sayı var (konum ${(bak()?.i ?? metin.length) + 1})`)
    const [x, y, ucuncu, dorduncu] = sayilar
    if (boyut === 'M') return [x, y] // M (ölçü) değeri atılır
    if (boyut === 'ZM' || sayilar.length === 4) return [x, y, ucuncu] // Z korunur, M atılır
    void dorduncu
    return ucuncu === undefined ? [x, y] : [x, y, ucuncu]
  }

  function liste(ogeOku) {
    al('(', '"("')
    const ogeler = [ogeOku()]
    while (bak() && bak().t === ',') {
      k++
      ogeler.push(ogeOku())
    }
    al(')', '")" veya ","')
    return ogeler
  }

  const halka = (boyut) => () => liste(() => konum(boyut))

  function geometri() {
    const etiket = al('kelime', 'geometri tipi (POINT, POLYGON…)').v
    let tip = etiket
    let boyut = ''
    const eslesme = TIP_DESENI.exec(etiket)
    if (eslesme) {
      tip = eslesme[1]
      boyut = eslesme[2] || ''
    }
    if (DESTEKLENMEYEN_TIPLER.has(tip)) throw hata(`eğri/yüzey geometri tipi desteklenmiyor: ${tip}`)
    const geoTip = BASIT_TIPLER[tip]
    if (!geoTip) throw hata(`bilinmeyen geometri tipi: ${etiket}`)
    if (bak() && bak().t === 'kelime' && ['Z', 'M', 'ZM'].includes(bak().v)) boyut = s[k++].v
    if (bak() && bak().t === 'kelime' && bak().v === 'EMPTY') {
      k++
      return null
    }

    switch (geoTip) {
      case 'Point':
        al('(', '"("')
        {
          const p = konum(boyut)
          al(')', '")"')
          return { type: 'Point', coordinates: p }
        }
      case 'LineString':
        return { type: 'LineString', coordinates: liste(() => konum(boyut)) }
      case 'Polygon':
        return { type: 'Polygon', coordinates: liste(halka(boyut)) }
      case 'MultiPoint':
        return {
          type: 'MultiPoint',
          coordinates: liste(() => {
            if (bak() && bak().t === '(') {
              k++
              const p = konum(boyut)
              al(')', '")"')
              return p
            }
            return konum(boyut)
          }),
        }
      case 'MultiLineString':
        return { type: 'MultiLineString', coordinates: liste(halka(boyut)) }
      case 'MultiPolygon':
        return { type: 'MultiPolygon', coordinates: liste(() => liste(halka(boyut))) }
      case 'GeometryCollection':
        return { type: 'GeometryCollection', geometries: liste(geometri).filter(Boolean) }
      default:
        throw hata(`bilinmeyen geometri tipi: ${etiket}`)
    }
  }

  const g = geometri()
  if (k < s.length) throw hata(`geometriden sonra beklenmeyen içerik (konum ${s[k].i + 1})`)
  return g
}

// ---------------------------------------------------------------------------
// WKB / EWKB (hex)
// ---------------------------------------------------------------------------

const WKB_TIPLERI = { 1: 'Point', 2: 'LineString', 3: 'Polygon', 4: 'MultiPoint', 5: 'MultiLineString', 6: 'MultiPolygon', 7: 'GeometryCollection', 17: 'Polygon' }

function hexWkbAyristir(hex) {
  if (hex.length % 2 !== 0) throw hata('hex WKB uzunluğu tek sayı; veri kesilmiş olabilir')
  const bayt = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bayt.length; i++) bayt[i] = parseInt(hex.substr(i * 2, 2), 16)
  const dv = new DataView(bayt.buffer)
  let o = 0
  const kontrol = (n) => {
    if (o + n > bayt.length) throw hata('WKB verisi beklenenden kısa; veri kesilmiş olabilir')
  }

  function oku() {
    kontrol(5)
    const kucukSonlu = dv.getUint8(o) === 1
    o += 1
    let tipKodu = dv.getUint32(o, kucukSonlu)
    o += 4
    let z = false
    let m = false
    // EWKB bayrakları (PostGIS)
    if (tipKodu & 0x80000000) z = true
    if (tipKodu & 0x40000000) m = true
    if (tipKodu & 0x20000000) {
      kontrol(4)
      o += 4 // SRID
    }
    tipKodu &= 0x0fffffff
    // ISO kodları: 1000+ Z, 2000+ M, 3000+ ZM
    if (tipKodu >= 3000) { z = true; m = true; tipKodu -= 3000 }
    else if (tipKodu >= 2000) { m = true; tipKodu -= 2000 }
    else if (tipKodu >= 1000) { z = true; tipKodu -= 1000 }
    const tip = WKB_TIPLERI[tipKodu]
    if (!tip) throw hata(`desteklenmeyen WKB geometri tipi kodu: ${tipKodu}`)
    const boyut = 2 + (z ? 1 : 0) + (m ? 1 : 0)

    const konum = () => {
      kontrol(8 * boyut)
      const d = []
      for (let i = 0; i < boyut; i++) d.push(dv.getFloat64(o + i * 8, kucukSonlu))
      o += 8 * boyut
      return z ? [d[0], d[1], d[2]] : [d[0], d[1]]
    }
    const sayi = () => {
      kontrol(4)
      const n = dv.getUint32(o, kucukSonlu)
      o += 4
      return n
    }
    const konumlar = () => Array.from({ length: sayi() }, konum)
    const halkalar = () => Array.from({ length: sayi() }, konumlar)

    switch (tip) {
      case 'Point': {
        const p = konum()
        return Number.isNaN(p[0]) && Number.isNaN(p[1]) ? null : { type: 'Point', coordinates: p }
      }
      case 'LineString': {
        const c = konumlar()
        return c.length ? { type: 'LineString', coordinates: c } : null
      }
      case 'Polygon': {
        const c = halkalar()
        return c.length ? { type: 'Polygon', coordinates: c } : null
      }
      case 'MultiPoint':
      case 'MultiLineString':
      case 'MultiPolygon': {
        const parcalar = Array.from({ length: sayi() }, oku).filter(Boolean)
        return parcalar.length ? { type: tip, coordinates: parcalar.map((p) => p.coordinates) } : null
      }
      case 'GeometryCollection':
        return { type: 'GeometryCollection', geometries: Array.from({ length: sayi() }, oku).filter(Boolean) }
      default:
        throw hata(`desteklenmeyen WKB geometri tipi: ${tip}`)
    }
  }

  const g = oku()
  if (o !== bayt.length) throw hata('WKB verisinin sonunda fazladan bayt var')
  return g
}

// ---------------------------------------------------------------------------

/**
 * Metni GeoJSON geometrisine çevirir.
 * @param {string} girdi WKT, EWKT veya hex WKB/EWKB
 * @returns {object | null} geometri; EMPTY geometride null
 * @throws {Error} okunamazsa, nedeni Türkçe mesajda
 */
export function wktCoz(girdi) {
  let metin = String(girdi ?? '').trim()
  if (metin === '') throw hata('boş değer')
  metin = metin.replace(/;+\s*$/, '').trim()
  // Excel/CSV'den gelen "…" tırnaklarını temizle.
  if (/^"[\s\S]*"$/.test(metin)) metin = metin.slice(1, -1).replace(/""/g, '"').trim()
  if (/^(\\x|0x)?[0-9a-fA-F]+$/.test(metin) && metin.replace(/^(\\x|0x)/, '').length >= 10) {
    return hexWkbAyristir(metin.replace(/^(\\x|0x)/, ''))
  }
  metin = metin.replace(/^SRID\s*=\s*\d+\s*;\s*/i, '')
  return wktAyristir(metin)
}
