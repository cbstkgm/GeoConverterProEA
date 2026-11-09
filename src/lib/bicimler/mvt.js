// Mapbox Vector Tile 2.1 (.mvt / .pbf) yazıcısı — bağımlılıksız protobuf kodlayıcıyla.
//
// Tüm veri TEK döşemeye (tile) ve tek katmana yazılır:
//  - secenekler.z/x/y verilirse o döşeme kullanılır; dışarıda kalan geometriler döşeme + tampon
//    (secenekler.tampon, varsayılan 64 birim) sınırında kırpılır.
//  - Verilmezse verinin tamamını kapsayan EN BÜYÜK zoom'daki döşeme seçilir (en çok
//    secenekler.enBuyukZoom, varsayılan 22); bu durumda kırpma gerekmez.
// Döşemeleme Web Mercator'a (EPSG:3857, XYZ/Google döşeme şeması, y yukarıdan aşağı) göredir.
// Girdi EPSG:3857 ise doğrudan, EPSG:4326 ise (küresel Mercator formülüyle) 3857'ye çevrilerek
// kullanılır; başka CRS'te hata verilir. CRS verilmezse 4326 varsayılır ve uyarılır.
//
// Kodlama (MVT 2.1): Tile.layers(3) → Layer { name(1), features(2), keys(3), values(4), extent(5),
// version(15)=2 }; Feature { id(1), tags(2, packed), type(3), geometry(4, packed) };
// Value { string(1), double(3), sint(6), bool(7) }. Geometri komutları MoveTo(1)/LineTo(2)/ClosePath(7),
// parametreler zigzag kodlu göreli farklar. Poligon dış halkası y-aşağı döşeme ekseninde saat yönünde
// (alan > 0), delikler saat yönünün tersinde (alan < 0) yazılır.
// Koordinatlar tamsayı ızgaraya yuvarlanır; ardışık yinelenen köşeler atılır, çökmüş (2'den az köşeli
// çizgi, 3'ten az köşeli / sıfır alanlı halka) parçalar atılır ve "basitleştirilen" olarak sayılır.
// Z değerleri yazılmaz (MVT 2B'dir). Çıktı sıkıştırılmamış protobuf'tur (gzip yok).

import { BaytYazici, parcalaraAc } from './geopackage.js'
import { sridCoz } from './wkb.js'

const E = 20037508.342789244 // Web Mercator dünya yarı genişliği (m)
const R = 6378137
const ENLEM_SINIRI = 85.0511287798066
const MVT_TIPLERI = { nokta: 1, cizgi: 2, poligon: 3 }
const AILE = { Point: 'nokta', MultiPoint: 'nokta', LineString: 'cizgi', MultiLineString: 'cizgi', Polygon: 'poligon', MultiPolygon: 'poligon' }

// ---------------------------------------------------------------- protobuf yazıcı

class PbfYazici extends BaytYazici {
  varint(n) {
    let v = n
    while (v >= 0x80) {
      this.u8((v % 0x80) | 0x80)
      v = Math.floor(v / 0x80)
    }
    this.u8(v)
  }
  etiket(alan, tel) {
    this.varint(alan * 8 + tel)
  }
  baytlar(b) {
    this.yer(b.length)
    this.tampon.set(b, this.o)
    this.o += b.length
  }
  /** length-delimited (tel tipi 2) alan */
  uzunluklu(alan, b) {
    this.etiket(alan, 2)
    this.varint(b.length)
    this.baytlar(b)
  }
  metin(alan, s) {
    this.uzunluklu(alan, new TextEncoder().encode(s))
  }
  varintAlan(alan, n) {
    this.etiket(alan, 0)
    this.varint(n)
  }
  /** packed repeated uint32 */
  paketli(alan, dizi) {
    const ic = new PbfYazici(dizi.length * 2 + 8)
    for (const n of dizi) ic.varint(n)
    this.uzunluklu(alan, ic.sonuc())
  }
  double(alan, v) {
    this.etiket(alan, 1)
    this.f64(v)
  }
}

export const zigzag = (n) => (n >= 0 ? n * 2 : -n * 2 - 1)
const komut = (id, sayi) => (id & 0x7) | (sayi << 3)

// ---------------------------------------------------------------- koordinat ve döşeme

/** EPSG:4326 boylam/enlem → EPSG:3857 (küresel Mercator). */
export function wgs84tenMercatora([lon, lat]) {
  const e = Math.max(-ENLEM_SINIRI, Math.min(ENLEM_SINIRI, lat))
  return [(lon * E) / 180, Math.log(Math.tan(((90 + e) * Math.PI) / 360)) * R]
}

const doseBoyu = (z) => (2 * E) / 2 ** z

/** Döşemenin 3857 sınırları. */
export function doseSinirlari(z, x, y) {
  const b = doseBoyu(z)
  return { minx: -E + x * b, maxx: -E + (x + 1) * b, miny: E - (y + 1) * b, maxy: E - y * b }
}

/** Kapsamı bütünüyle içeren en büyük zoom'daki döşeme. */
export function kapsayanDoseme(k, enBuyukZoom = 22) {
  for (let z = enBuyukZoom; z >= 0; z--) {
    const b = doseBoyu(z)
    const n = 2 ** z
    const sinirla = (v) => Math.max(0, Math.min(n - 1, v))
    const x0 = sinirla(Math.floor((k.minx + E) / b))
    const x1 = sinirla(Math.max(x0, Math.ceil((k.maxx + E) / b) - 1))
    const y0 = sinirla(Math.floor((E - k.maxy) / b))
    const y1 = sinirla(Math.max(y0, Math.ceil((E - k.miny) / b) - 1))
    if (x0 === x1 && y0 === y1) return { z, x: x0, y: y0 }
  }
  return { z: 0, x: 0, y: 0 }
}

// ---------------------------------------------------------------- kırpma (döşeme ekseninde)

/** Liang–Barsky ile çizgiyi kutuya kırpar; içeride kalan parçaları döndürür. */
function cizgiKirp(nk, kutu) {
  const parcalar = []
  let mevcut = []
  for (let i = 0; i + 1 < nk.length; i++) {
    const [x0, y0] = nk[i]
    const [x1, y1] = nk[i + 1]
    const dx = x1 - x0
    const dy = y1 - y0
    let t0 = 0
    let t1 = 1
    let ic = true
    for (const [p, q] of [[-dx, x0 - kutu.min], [dx, kutu.max - x0], [-dy, y0 - kutu.min], [dy, kutu.max - y0]]) {
      if (p === 0) {
        if (q < 0) ic = false
      } else {
        const r = q / p
        if (p < 0) t0 = Math.max(t0, r)
        else t1 = Math.min(t1, r)
      }
    }
    if (!ic || t0 > t1) {
      if (mevcut.length) parcalar.push(mevcut)
      mevcut = []
      continue
    }
    const a = [x0 + t0 * dx, y0 + t0 * dy]
    const b = [x0 + t1 * dx, y0 + t1 * dy]
    if (!mevcut.length) mevcut.push(a)
    mevcut.push(b)
    if (t1 < 1) {
      parcalar.push(mevcut)
      mevcut = []
    }
  }
  if (mevcut.length) parcalar.push(mevcut)
  return parcalar
}

/** Sutherland–Hodgman ile halkayı kutuya kırpar (kapanış köşesi olmadan döner). */
function halkaKirp(halka, kutu) {
  let liste = halka.slice(0, -1)
  const kenarlar = [
    [(p) => p[0] >= kutu.min, (a, b) => kes(a, b, 0, kutu.min)],
    [(p) => p[0] <= kutu.max, (a, b) => kes(a, b, 0, kutu.max)],
    [(p) => p[1] >= kutu.min, (a, b) => kes(a, b, 1, kutu.min)],
    [(p) => p[1] <= kutu.max, (a, b) => kes(a, b, 1, kutu.max)],
  ]
  for (const [icinde, kesisim] of kenarlar) {
    const girdi = liste
    liste = []
    for (let i = 0; i < girdi.length; i++) {
      const a = girdi[(i + girdi.length - 1) % girdi.length]
      const b = girdi[i]
      if (icinde(b)) {
        if (!icinde(a)) liste.push(kesisim(a, b))
        liste.push(b)
      } else if (icinde(a)) liste.push(kesisim(a, b))
    }
    if (!liste.length) break
  }
  return liste
}

function kes(a, b, eksen, deger) {
  const t = (deger - a[eksen]) / (b[eksen] - a[eksen])
  return eksen === 0 ? [deger, a[1] + t * (b[1] - a[1])] : [a[0] + t * (b[0] - a[0]), deger]
}

const halkaAlani = (h) => {
  let a = 0
  for (let i = 0; i < h.length; i++) {
    const [x0, y0] = h[i]
    const [x1, y1] = h[(i + 1) % h.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

/** Yuvarla + ardışık yinelenenleri at. */
function tamsayiya(nk) {
  const c = []
  for (const k of nk) {
    const p = [Math.round(k[0]), Math.round(k[1])]
    const s = c[c.length - 1]
    if (!s || s[0] !== p[0] || s[1] !== p[1]) c.push(p)
  }
  return c
}

// ---------------------------------------------------------------- ana yazıcı

function degerAnahtari(v) {
  if (typeof v === 'boolean') return ['bool', v]
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v) && Math.abs(v) <= 2 ** 52) return ['sint', v]
    if (Number.isFinite(v)) return ['double', v]
    return ['string', String(v)]
  }
  if (typeof v === 'bigint') return Math.abs(Number(v)) <= 2 ** 52 ? ['sint', Number(v)] : ['string', v.toString()]
  if (typeof v === 'object') return ['string', JSON.stringify(v)]
  return ['string', String(v)]
}

/**
 * GeoJSON FeatureCollection'ı tek bir Mapbox Vector Tile 2.1 döşemesine yazar.
 * @param {object} fc FeatureCollection (koordinatlar EPSG:3857 veya EPSG:4326)
 * @param {object} [secenekler] crs, z/x/y, katman (varsayılan 'objeler'), extent (4096), tampon (64), enBuyukZoom (22)
 * @returns {Promise<{ veri: Uint8Array, onizleme: string, uyarilar: string[] }>}
 */
export async function mvtYaz(fc, secenekler = {}) {
  const ayar = secenekler || {}
  const uyarilar = []
  const uyar = (m) => {
    if (!uyarilar.includes(m)) uyarilar.push(m)
  }
  let srid = sridCoz(ayar.crs)
  if (srid == null) {
    uyar('Koordinat sistemi belirtilmedi; koordinatlar EPSG:4326 (boylam/enlem) kabul edilip Web Mercator\'a çevrildi.')
    srid = 4326
  }
  if (srid !== 4326 && srid !== 3857) {
    throw new Error(
      `MVT döşemeleri Web Mercator'a (EPSG:3857) göre üretilir; koordinatların EPSG:3857 veya EPSG:4326 olması gerekir (gelen: EPSG:${srid}). Hedef koordinat sistemi olarak EPSG:3857 seçin.`,
    )
  }
  const extent = Number.isInteger(ayar.extent) && ayar.extent > 0 ? ayar.extent : 4096
  const katmanAdi = ayar.katman ? String(ayar.katman) : 'objeler'
  const donustur = srid === 4326 ? wgs84tenMercatora : (k) => [k[0], k[1]]
  const objeler = Array.isArray(fc?.features) ? fc.features : []

  // 1) Geometrileri aileye göre basit parçalara ayır ve 3857'ye çevir.
  let zVar = false
  let geometrisiz = 0
  let gcBolunen = 0
  const kayitlar = [] // { f, i, aile, parcalar: [[nk]] | [[halka...]] | [[nk]] }
  const kapsam = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity }
  const kapsamaEkle = (p) => {
    kapsam.minx = Math.min(kapsam.minx, p[0])
    kapsam.maxx = Math.max(kapsam.maxx, p[0])
    kapsam.miny = Math.min(kapsam.miny, p[1])
    kapsam.maxy = Math.max(kapsam.maxy, p[1])
  }
  const cevir = (k) => {
    if (!Array.isArray(k) || !Number.isFinite(k[0]) || !Number.isFinite(k[1])) throw new Error('geçersiz koordinat')
    if (k.length > 2) zVar = true
    const p = donustur(k)
    kapsamaEkle(p)
    return p
  }
  objeler.forEach((f, i) => {
    const g = f?.geometry
    if (!g) {
      geometrisiz++
      return
    }
    try {
      const gruplar = new Map()
      for (const p of parcalaraAc(g)) {
        const aile = AILE[p.type]
        if (!aile) throw new Error(`desteklenmeyen geometri tipi: ${p.type}`)
        if (!gruplar.has(aile)) gruplar.set(aile, [])
        const liste = gruplar.get(aile)
        const c = p.coordinates
        if (p.type === 'Point') liste.push(cevir(c))
        else if (p.type === 'MultiPoint') c.forEach((k) => liste.push(cevir(k)))
        else if (p.type === 'LineString') liste.push(c.map(cevir))
        else if (p.type === 'MultiLineString') c.forEach((l) => liste.push(l.map(cevir)))
        else if (p.type === 'Polygon') liste.push(c.map((h) => h.map(cevir)))
        else c.forEach((pl) => liste.push(pl.map((h) => h.map(cevir))))
      }
      if (gruplar.size > 1) gcBolunen++
      if (!gruplar.size) geometrisiz++
      for (const [aile, parcalar] of gruplar) kayitlar.push({ f, i, aile, parcalar })
    } catch (e) {
      uyar(`${i + 1}. obje yazılamadı (${e.message}).`)
    }
  })
  if (geometrisiz) uyar(`Geometrisi olmayan (veya boş) ${geometrisiz} obje MVT'ye yazılmadı (MVT objeleri geometri gerektirir).`)
  if (gcBolunen) uyar(`Farklı geometri tipleri içeren ${gcBolunen} GeometryCollection, aynı id ve özniteliklerle tip başına ayrı objelere bölündü.`)
  if (zVar) uyar('Z değerleri MVT\'ye yazılmadı (MVT iki boyutludur).')

  // 2) Döşeme seçimi
  const zxyVerildi = [ayar.z, ayar.x, ayar.y].every((v) => Number.isInteger(v) && v >= 0)
  let dose
  if (zxyVerildi) {
    if (ayar.x >= 2 ** ayar.z || ayar.y >= 2 ** ayar.z) throw new Error(`Geçersiz döşeme: ${ayar.z}/${ayar.x}/${ayar.y}.`)
    dose = { z: ayar.z, x: ayar.x, y: ayar.y }
  } else if (Number.isFinite(kapsam.minx)) {
    dose = kapsayanDoseme(kapsam, Number.isInteger(ayar.enBuyukZoom) ? ayar.enBuyukZoom : 22)
  } else dose = { z: 0, x: 0, y: 0 }
  const s = doseSinirlari(dose.z, dose.x, dose.y)
  const olcek = extent / (s.maxx - s.minx)
  const doseye = (p) => [(p[0] - s.minx) * olcek, (s.maxy - p[1]) * olcek]
  const tampon = Number.isFinite(ayar.tampon) ? ayar.tampon : 64
  const kutu = { min: -tampon, max: extent + tampon }
  const icinde = (p) => p[0] >= kutu.min && p[0] <= kutu.max && p[1] >= kutu.min && p[1] <= kutu.max

  // 3) Öznitelik tabloları
  const anahtarlar = []
  const anahtarIndeks = new Map()
  const degerler = []
  const degerIndeks = new Map()
  const etiketler = (p) => {
    const t = []
    if (!p || typeof p !== 'object') return t
    for (const [k, v] of Object.entries(p)) {
      if (v == null) continue
      if (!anahtarIndeks.has(k)) {
        anahtarIndeks.set(k, anahtarlar.length)
        anahtarlar.push(k)
      }
      const [tip, deger] = degerAnahtari(v)
      const dk = `${tip}:${deger}`
      if (!degerIndeks.has(dk)) {
        degerIndeks.set(dk, degerler.length)
        degerler.push([tip, deger])
      }
      t.push(anahtarIndeks.get(k), degerIndeks.get(dk))
    }
    return t
  }

  // id: tüm objelerde benzersiz, negatif olmayan tamsayı id varsa o; yoksa sıra numarası (1'den).
  const idler = objeler.map((f) => f?.id)
  const idKullan = idler.length > 0 && idler.every((v) => Number.isSafeInteger(v) && v >= 0) && new Set(idler).size === idler.length
  if (objeler.length && !idKullan) uyar('Objelerin tamamında benzersiz, negatif olmayan tamsayı id olmadığından MVT id alanına sıra numarası (1, 2, …) yazıldı.')

  // 4) Objeleri kodla
  let kirpilan = 0
  let disarida = 0
  let basitlestirilen = 0
  const objeBaytlari = []
  for (const k of kayitlar) {
    const geo = []
    let x = 0
    let y = 0
    const git = (p) => {
      geo.push(zigzag(p[0] - x), zigzag(p[1] - y))
      x = p[0]
      y = p[1]
    }
    let kirpildi = false
    if (k.aile === 'nokta') {
      const noktalar = []
      for (const p of k.parcalar) {
        const d = doseye(p)
        if (!icinde(d)) {
          kirpildi = true
          continue
        }
        noktalar.push([Math.round(d[0]), Math.round(d[1])])
      }
      if (noktalar.length) {
        geo.push(komut(1, noktalar.length))
        noktalar.forEach(git)
      }
    } else if (k.aile === 'cizgi') {
      for (const cizgi of k.parcalar) {
        let parcalar = [cizgi.map(doseye)]
        if (!parcalar[0].every(icinde)) {
          kirpildi = true
          parcalar = cizgiKirp(parcalar[0], kutu)
        }
        for (const ham of parcalar) {
          const c = tamsayiya(ham)
          if (c.length < 2) {
            basitlestirilen++
            continue
          }
          geo.push(komut(1, 1))
          git(c[0])
          geo.push(komut(2, c.length - 1))
          c.slice(1).forEach(git)
        }
      }
    } else {
      for (const poligon of k.parcalar) {
        const halkalar = []
        poligon.forEach((halka, hi) => {
          let h = halka.map(doseye)
          if (!h.every(icinde)) {
            kirpildi = true
            h = halkaKirp(h, kutu)
          } else h = h.slice(0, -1)
          let c = tamsayiya(h)
          if (c.length > 1 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]) c.pop()
          const alan = c.length >= 3 ? halkaAlani(c) : 0
          if (alan === 0) {
            if (h.length) basitlestirilen++
            if (hi === 0) halkalar.length = 0
            halkalar.push(null)
            return
          }
          // dış halka alan > 0 (y-aşağı eksende saat yönü), delik alan < 0
          if ((hi === 0) !== alan > 0) c = c.reverse()
          halkalar.push(c)
        })
        if (!halkalar[0]) continue // dış halka çöktü/dışarıda: poligon atılır
        for (const c of halkalar) {
          if (!c) continue
          geo.push(komut(1, 1))
          git(c[0])
          geo.push(komut(2, c.length - 1))
          c.slice(1).forEach(git)
          geo.push(komut(7, 1))
        }
      }
    }
    if (kirpildi) kirpilan++
    if (!geo.length) {
      disarida++
      continue
    }
    const w = new PbfYazici(geo.length * 2 + 32)
    w.varintAlan(1, idKullan ? k.f.id : k.i + 1)
    const t = etiketler(k.f?.properties)
    if (t.length) w.paketli(2, t)
    w.varintAlan(3, MVT_TIPLERI[k.aile])
    w.paketli(4, geo)
    objeBaytlari.push(w.sonuc())
  }
  if (kirpilan) uyar(`${kirpilan} obje ${dose.z}/${dose.x}/${dose.y} döşemesinin sınırında (tampon ${tampon}) kırpıldı.`)
  if (disarida) uyar(`${disarida} obje döşeme dışında kaldığı veya tamsayı ızgarada çöktüğü için yazılmadı.`)
  if (basitlestirilen) uyar(`${basitlestirilen} çizgi/halka ${extent} birimlik ızgaraya yuvarlanınca çöktüğü için atıldı.`)

  // 5) Katman ve döşeme
  const katman = new PbfYazici(1024)
  katman.metin(1, katmanAdi)
  for (const b of objeBaytlari) katman.uzunluklu(2, b)
  for (const a of anahtarlar) katman.metin(3, a)
  for (const [tip, deger] of degerler) {
    const d = new PbfYazici(16)
    if (tip === 'string') d.metin(1, deger)
    else if (tip === 'double') d.double(3, deger)
    else if (tip === 'sint') d.varintAlan(6, zigzag(deger))
    else d.varintAlan(7, deger ? 1 : 0)
    katman.uzunluklu(4, d.sonuc())
  }
  katman.varintAlan(5, extent)
  katman.varintAlan(15, 2)
  const dosya = new PbfYazici(1024)
  dosya.uzunluklu(3, katman.sonuc())
  const veri = dosya.sonuc()

  const onizleme = [
    'Mapbox Vector Tile 2.1 (protobuf, sıkıştırılmamış)',
    `Döşeme (z/x/y): ${dose.z}/${dose.x}/${dose.y}${zxyVerildi ? '' : ' (veriyi kapsayan en büyük zoom)'}`,
    `Döşeme sınırları (EPSG:3857): ${s.minx}, ${s.miny} – ${s.maxx}, ${s.maxy}`,
    `Katman: ${katmanAdi}, extent ${extent}`,
    `Obje: ${objeler.length} girdi, ${objeBaytlari.length} MVT objesi yazıldı`,
    `Kırpılan obje: ${kirpilan}, yazılmayan: ${disarida + geometrisiz}, ızgarada çöken parça: ${basitlestirilen}`,
    `Anahtar: ${anahtarlar.length}, değer: ${degerler.length}`,
    `Dosya boyutu: ${veri.length} bayt`,
  ].join('\n')
  return { veri, onizleme, uyarilar }
}
