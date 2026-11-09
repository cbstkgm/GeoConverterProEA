/**
 * DGN yazıcısı: GeoJSON FeatureCollection → MicroStation V7 (ISFF, "Intergraph Standard File Format")
 * ikili tasarım dosyası. Yapı GDAL'ın DGN sürücüsünün (frmts/dgn, dgnopen.c / dgnwrite.c) okuduğu
 * ve yazdığı düzene göre kurulmuştur.
 *
 * Dosya: [TCB (tip 9, 1536 bayt)] [grafik elemanlar …] [0xFFFF tasarım sonu] [512 bayta sıfır dolgu]
 *
 * Sayı düzeni (V7 / VAX kökenli):
 *  - 16 bit kelimeler little-endian.
 *  - 32 bit tamsayılar "orta-endian": önce yüksek kelime, sonra düşük kelime (her biri LE).
 *  - Eleman aralığı (range) 6 × int32, işaret biti çevrilmiş ("binary offset") olarak yazılır.
 *  - TCB'deki global köken VAX D-float (8 bayt) olarak yazılır.
 *
 * Eleman başlığı (18 kelime = 36 bayt): 0: level (bit 0–5) | complex (bit 7); 1: tip (bit 0–6);
 *   2–3: kelime sayısı − 2 (WTF); 4–27: aralık; 28: graphic group; 30: attindx (= toplam kelime − 16,
 *   öznitelik bağı yok); 32: properties (0x8000 = delik/hole); 34: stil | kalınlık<<3; 35: renk.
 *
 * Geometri eşlemesi:
 *  - Point → tip 3 (Line) sıfır uzunluklu: iki uç aynı. Gerekçe: V7'de ayrı nokta elemanı yoktur;
 *    MicroStation sıfır uzunluklu çizgiyi nokta olarak çizer ve GDAL/OGR'nin DGN yazıcısı da noktaları
 *    böyle yazar (tip 15 elips nokta değil, sembol olarak görünür ve yarıçap gerektirir).
 *  - LineString → tip 4 (Line String), en çok 101 köşe; uzun çizgiler 101 köşelik parçalara bölünür
 *    (parçalar uç noktaları paylaşır ve aynı graphic group'a konur) — uyarı verilir.
 *  - Polygon halkası → tip 6 (Shape, kapalı; ilk köşe sonda tekrarlanır), ≤ 101 köşe. Daha uzun halkalar
 *    tip 14 (Complex Shape) başlığı + 101 köşelik tip 4 alt elemanlar (complex bitli) olarak yazılır.
 *  - Delikler: ayrı shape/complex shape, properties'de HOLE (0x8000) bayrağı ve dış halkayla aynı
 *    graphic group numarası (MicroStation'da "grouped hole" hücresi yerine; uyarı verilir).
 *  - Level (1–63): katman özniteliğinden (tamsayı ise doğrudan, değilse sırayla eşlenir).
 *
 * Birim / UOR: ana birim metre (MU "m"), alt birim ve UOR/alt birim veri yayılımına göre seçilir:
 *   10 000 UOR/m (0,1 mm) tercih edilir; koordinatlar global köken etrafında INT32 sınırına
 *   (±2 147 483 647) sığmazsa 1000, 100, 10, 1 UOR/m'ye inilir (uyarıyla). Global köken verinin sınır
 *   kutusu merkezidir; böylece büyük TM koordinatları (ör. 4 500 000 m) taşmaz.
 *   GDAL formülü: dünya = int / UOR − köken_MU, köken_MU = TCB_köken / UOR ⇒ TCB_köken = −merkez × UOR.
 *
 * 2B/3B: veride herhangi bir Z varsa 3B dosya (TCB ilk baytı 0xC8, 1214. bayt 0x40), değilse 2B.
 *
 * Saf JS: DOM yok; worker ve Node'da çalışır.
 */
import {
  cbsParcalari,
  katmanNumaralari,
  eslemeUyarisi,
  objeKatmani,
  cografiMi,
  zVar,
  VARSAYILAN_KATMANLAR,
} from './step.js'

const TCB_BAYT = 1536
const AZAMI_KOSE = 101
const INT32_AZAMI = 2147483647
/** Yuvarlama ve kenar payı için INT32 sınırının biraz altı. */
const GUVENLI_SINIR = 2147000000
export const DGN_TIP = Object.freeze({ CIZGI: 3, CIZGI_DIZISI: 4, SEKIL: 6, TCB: 9, KARMASIK_SEKIL: 14 })
export const DGN_DELIK = 0x8000

/** (alt birim/ana birim, UOR/alt birim, alt birim adı) adayları — büyükten küçüğe çözünürlük. */
const UOR_ADAYLARI = [
  [1000, 10, 'mm'],
  [1000, 1, 'mm'],
  [100, 1, 'cm'],
  [10, 1, 'dm'],
  [1, 1, 'm '],
]

// ---------------------------------------------------------------- İkili yardımcılar
/** int32'yi DGN orta-endian düzeninde yazar. */
export function int32Yaz(dizi, ofset, deger) {
  const u = deger >>> 0
  dizi[ofset] = (u >>> 16) & 0xff
  dizi[ofset + 1] = (u >>> 24) & 0xff
  dizi[ofset + 2] = u & 0xff
  dizi[ofset + 3] = (u >>> 8) & 0xff
}

export function int32Oku(dizi, ofset) {
  return (dizi[ofset + 2] | (dizi[ofset + 3] << 8) | (dizi[ofset] << 16) | (dizi[ofset + 1] << 24)) | 0
}

const kelimeYaz = (dizi, ofset, deger) => {
  dizi[ofset] = deger & 0xff
  dizi[ofset + 1] = (deger >>> 8) & 0xff
}

/** IEEE 754 double → VAX D-float (DGN bayt düzeni). GDAL IEEE2DGNDouble ile aynı. */
export function vaxDYaz(dizi, ofset, deger) {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, deger, true)
  const lo = dv.getUint32(0, true)
  const hi = dv.getUint32(4, true)
  const isaret = hi & 0x80000000
  let us = (hi >>> 20) & 0x7ff
  let yHi = 0
  let yLo = 0
  if (us !== 0) {
    us = us - 1023 + 129
    if (us > 255) {
      yHi = (isaret | 0x7fffffff) >>> 0
      yLo = 0xffffffff
    } else if (us > 0) {
      const mantHi = (((hi & 0x000fffff) << 3) | (lo >>> 29)) & 0x007fffff
      yHi = (isaret | (us << 23) | mantHi) >>> 0
      yLo = (lo << 3) >>> 0
    }
  }
  dizi[ofset] = (yHi >>> 16) & 0xff
  dizi[ofset + 1] = (yHi >>> 24) & 0xff
  dizi[ofset + 2] = yHi & 0xff
  dizi[ofset + 3] = (yHi >>> 8) & 0xff
  dizi[ofset + 4] = (yLo >>> 16) & 0xff
  dizi[ofset + 5] = (yLo >>> 24) & 0xff
  dizi[ofset + 6] = yLo & 0xff
  dizi[ofset + 7] = (yLo >>> 8) & 0xff
}

/** VAX D-float (DGN bayt düzeni) → IEEE double. GDAL DGN2IEEEDouble ile aynı. */
export function vaxDOku(dizi, ofset) {
  const yHi = (dizi[ofset + 2] | (dizi[ofset + 3] << 8) | (dizi[ofset] << 16) | (dizi[ofset + 1] << 24)) >>> 0
  const yLo = (dizi[ofset + 6] | (dizi[ofset + 7] << 8) | (dizi[ofset + 4] << 16) | (dizi[ofset + 5] << 24)) >>> 0
  const isaret = yHi & 0x80000000
  let us = (yHi >>> 23) & 0xff
  if (us === 0) return 0
  us = us - 129 + 1023
  const hi = (isaret | (us << 20) | ((yHi & 0x7fffff) >>> 3)) >>> 0
  const lo = (((yHi & 0x7) << 29) | (yLo >>> 3)) >>> 0
  const dv = new DataView(new ArrayBuffer(8))
  dv.setUint32(0, lo, true)
  dv.setUint32(4, hi, true)
  return dv.getFloat64(0, true)
}

// ---------------------------------------------------------------- Eleman üretimi
/**
 * @param {number[][]} noktalar tamsayı UOR noktaları ([x,y] ya da [x,y,z])
 * @returns {Uint8Array}
 */
function grafikEleman({ tip, level, karmasik = false, grup = 0, ozellik = 0, boyut, noktalar, sayiKelimesi, govde }) {
  let govdeBayt
  if (govde) {
    govdeBayt = govde
  } else {
    const sayiBayt = sayiKelimesi ? 2 : 0
    govdeBayt = new Uint8Array(sayiBayt + noktalar.length * boyut * 4)
    if (sayiKelimesi) kelimeYaz(govdeBayt, 0, noktalar.length)
    noktalar.forEach((n, i) => {
      for (let e = 0; e < boyut; e++) int32Yaz(govdeBayt, sayiBayt + (i * boyut + e) * 4, n[e])
    })
  }
  const toplam = 36 + govdeBayt.length
  const e = new Uint8Array(toplam)
  e[0] = (level & 0x3f) | (karmasik ? 0x80 : 0)
  e[1] = tip & 0x7f
  kelimeYaz(e, 2, toplam / 2 - 2)
  // Aralık: alt köşe 4–15, üst köşe 16–27; işaret biti çevrilmiş (2B'de z = 0)
  const aralik = noktaAraligi(noktalar)
  for (let i = 0; i < 6; i++) int32Yaz(e, 4 + i * 4, (aralik[i] ^ 0x80000000) | 0)
  kelimeYaz(e, 28, grup)
  kelimeYaz(e, 30, toplam / 2 - 16)
  kelimeYaz(e, 32, ozellik)
  e[34] = 0
  e[35] = 0
  e.set(govdeBayt, 36)
  return e
}

function noktaAraligi(noktalar) {
  const a = [Infinity, Infinity, 0, -Infinity, -Infinity, 0]
  let zIlk = true
  for (const n of noktalar) {
    a[0] = Math.min(a[0], n[0]); a[1] = Math.min(a[1], n[1])
    a[3] = Math.max(a[3], n[0]); a[4] = Math.max(a[4], n[1])
    if (n.length > 2) {
      a[2] = zIlk ? n[2] : Math.min(a[2], n[2])
      a[5] = zIlk ? n[2] : Math.max(a[5], n[2])
      zIlk = false
    }
  }
  return a
}

/** Köşe dizisini, uç noktaları paylaşan en çok `azami` köşelik parçalara böler. */
function parcala(noktalar, azami = AZAMI_KOSE) {
  if (noktalar.length <= azami) return [noktalar]
  const sonuc = []
  for (let i = 0; i < noktalar.length - 1; i += azami - 1) sonuc.push(noktalar.slice(i, i + azami))
  return sonuc
}

/** Kapalı halka (kapanış köşesi dahil) → tip 6 shape ya da tip 14 complex shape + alt elemanlar. */
function sekilElemanlari(kapali, ortak) {
  if (kapali.length <= AZAMI_KOSE) {
    return { elemanlar: [grafikEleman({ ...ortak, tip: DGN_TIP.SEKIL, noktalar: kapali, sayiKelimesi: true })], karmasik: false }
  }
  const altlar = parcala(kapali).map((p) =>
    grafikEleman({ ...ortak, ozellik: 0, karmasik: true, tip: DGN_TIP.CIZGI_DIZISI, noktalar: p, sayiKelimesi: true }),
  )
  const altKelime = altlar.reduce((t, a) => t + a.length / 2, 0)
  // Başlık 20 kelime; totlength = başlığın ilk 19 kelimesi hariç tüm kelimeler (ISFF)
  const govde = new Uint8Array(4)
  kelimeYaz(govde, 0, 1 + altKelime)
  kelimeYaz(govde, 2, altlar.length)
  const baslik = grafikEleman({ ...ortak, tip: DGN_TIP.KARMASIK_SEKIL, noktalar: kapali, govde })
  return { elemanlar: [baslik, ...altlar], karmasik: true }
}

/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler]
 * @param {string} [secenekler.crs] hedef EPSG kodu
 * @returns {Promise<{veri: Uint8Array, onizleme: string, uyarilar: string[]}>}
 */
export async function dgnYaz(fc, secenekler = {}) {
  const ayarlar = secenekler || {}
  const { parcalar, uyarilar, zVarMi } = cbsParcalari(fc)
  const boyut = zVarMi ? 3 : 2
  if (cografiMi(ayarlar.crs)) {
    uyarilar.push('Koordinatlar coğrafi (derece) ancak DGN ana birimi metre olarak yazıldı; ölçüler anlamsız olur. Projeksiyonlu bir koordinat sistemi seçin.')
  }

  // Sınır kutusu → global köken (merkez) ve UOR seçimi
  const tumKonumlar = []
  for (const p of parcalar) {
    if (p.tip === 'nokta') tumKonumlar.push(p.konum)
    else if (p.tip === 'cizgi') for (const k of p.konumlar) tumKonumlar.push(k)
    else for (const h of p.halkalar) for (const k of h) tumKonumlar.push(k)
  }
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const k of tumKonumlar) {
    const z = zVar(k) ? k[2] : 0
    ;[k[0], k[1], z].forEach((d, e) => {
      if (d < min[e]) min[e] = d
      if (d > max[e]) max[e] = d
    })
  }
  const merkez = tumKonumlar.length ? min.map((m, e) => (m + max[e]) / 2) : [0, 0, 0]
  if (boyut === 2) merkez[2] = 0
  const yariAcilim = tumKonumlar.length ? Math.max(...min.map((m, e) => Math.max(merkez[e] - m, max[e] - merkez[e]))) : 0
  let [altBirim, uorAltBirim, altBirimAdi] = UOR_ADAYLARI[UOR_ADAYLARI.length - 1]
  for (const aday of UOR_ADAYLARI) {
    if (yariAcilim * aday[0] * aday[1] <= GUVENLI_SINIR) {
      ;[altBirim, uorAltBirim, altBirimAdi] = aday
      break
    }
  }
  const uor = altBirim * uorAltBirim
  if (uor < 1000) {
    uyarilar.push(`Veri çok geniş bir alana yayıldığı için DGN çözünürlüğü ${1 / uor} m'ye düşürüldü (INT32 koordinat sınırı).`)
  }
  if (yariAcilim * uor > INT32_AZAMI) {
    uyarilar.push('Veri DGN V7 koordinat aralığını aşıyor; sınır dışındaki koordinatlar kırpıldı.')
  }
  const tamsayi = (d, e) => Math.max(-INT32_AZAMI, Math.min(INT32_AZAMI, Math.round((d - merkez[e]) * uor)))
  const uorNokta = (k) => {
    const n = [tamsayi(k[0], 0), tamsayi(k[1], 1)]
    if (boyut === 3) n.push(tamsayi(zVar(k) ? k[2] : 0, 2))
    return n
  }

  // Katman → level (1–63)
  const katmanAdi = (p) => {
    const ham = objeKatmani(p.ozellikler)
    return ham === undefined ? VARSAYILAN_KATMANLAR[p.tip] : String(ham).trim()
  }
  const levelHaritasi = katmanNumaralari([...new Set(parcalar.map(katmanAdi))], { min: 1, maks: 63 })
  const eslemeMetni = eslemeUyarisi(levelHaritasi.eslemeler, 'DGN level')
  if (eslemeMetni) uyarilar.push(eslemeMetni)
  if (levelHaritasi.tasan) uyarilar.push(`${levelHaritasi.tasan} katman, DGN V7'nin 63 level sınırı aşıldığı için 63. level'a yazıldı.`)

  // Graphic group: birden çok eleman üreten objeler için ortak numara
  const objeParcaSayisi = new Map()
  for (const p of parcalar) {
    const ek = p.tip === 'poligon' ? p.halkalar.length : p.tip === 'cizgi' && p.konumlar.length > AZAMI_KOSE ? 2 : 1
    objeParcaSayisi.set(p.objeIndeks, (objeParcaSayisi.get(p.objeIndeks) ?? 0) + ek)
  }
  const gruplar = new Map()
  let sonGrup = 0
  let grupTasti = false
  const grupAl = (objeIndeks) => {
    if ((objeParcaSayisi.get(objeIndeks) ?? 0) < 2) return 0
    if (!gruplar.has(objeIndeks)) {
      if (sonGrup >= 65535) grupTasti = true
      gruplar.set(objeIndeks, sonGrup >= 65535 ? 0 : ++sonGrup)
    }
    return gruplar.get(objeIndeks)
  }

  const elemanlar = []
  const sayac = { nokta: 0, cizgiDizisi: 0, sekil: 0, karmasikSekil: 0, delik: 0, bolunenCizgi: 0 }
  for (const p of parcalar) {
    const ortak = { level: levelHaritasi.numara(katmanAdi(p)), grup: grupAl(p.objeIndeks), boyut }
    if (p.tip === 'nokta') {
      const n = uorNokta(p.konum)
      elemanlar.push(grafikEleman({ ...ortak, tip: DGN_TIP.CIZGI, noktalar: [n, n] }))
      sayac.nokta++
    } else if (p.tip === 'cizgi') {
      const parcalanmis = parcala(p.konumlar.map(uorNokta))
      if (parcalanmis.length > 1) sayac.bolunenCizgi++
      for (const pr of parcalanmis) {
        elemanlar.push(grafikEleman({ ...ortak, tip: DGN_TIP.CIZGI_DIZISI, noktalar: pr, sayiKelimesi: true }))
        sayac.cizgiDizisi++
      }
    } else {
      p.halkalar.forEach((h, i) => {
        const kapali = h.map(uorNokta)
        kapali.push(kapali[0])
        const sonuc = sekilElemanlari(kapali, { ...ortak, ozellik: i > 0 ? DGN_DELIK : 0 })
        elemanlar.push(...sonuc.elemanlar)
        if (sonuc.karmasik) sayac.karmasikSekil++
        else sayac.sekil++
        if (i > 0) sayac.delik++
      })
    }
  }

  if (sayac.bolunenCizgi) uyarilar.push(`${sayac.bolunenCizgi} çizgi DGN V7'nin 101 köşe sınırı nedeniyle parçalara bölündü (parçalar aynı graphic group'ta).`)
  if (sayac.delik) uyarilar.push(`${sayac.delik} poligon deliği ayrı "hole" bayraklı shape olarak yazıldı ve dış sınırla aynı graphic group'a bağlandı.`)
  if (grupTasti) uyarilar.push('65 535 graphic group sınırı aşıldı; sonraki objeler gruplanmadı.')

  // TCB
  const tcb = new Uint8Array(TCB_BAYT)
  tcb[0] = boyut === 3 ? 0xc8 : 0x08
  tcb[1] = DGN_TIP.TCB
  kelimeYaz(tcb, 2, TCB_BAYT / 2 - 2)
  int32Yaz(tcb, 1112, altBirim)
  int32Yaz(tcb, 1116, uorAltBirim)
  tcb[1120] = 0x6d // "m "
  tcb[1121] = 0x20
  tcb[1122] = altBirimAdi.charCodeAt(0)
  tcb[1123] = altBirimAdi.charCodeAt(1)
  if (boyut === 3) tcb[1214] |= 0x40
  vaxDYaz(tcb, 1240, -merkez[0] * uor)
  vaxDYaz(tcb, 1248, -merkez[1] * uor)
  vaxDYaz(tcb, 1256, -merkez[2] * uor)

  const icerik = TCB_BAYT + elemanlar.reduce((t, e) => t + e.length, 0) + 2
  const veri = new Uint8Array(Math.ceil(icerik / 512) * 512)
  veri.set(tcb, 0)
  let ofset = TCB_BAYT
  for (const e of elemanlar) {
    veri.set(e, ofset)
    ofset += e.length
  }
  veri[ofset] = 0xff
  veri[ofset + 1] = 0xff

  const onizleme = [
    `MicroStation V7 DGN (${boyut}B), ${veri.length} bayt`,
    `Ana birim: m, alt birim: ${altBirimAdi.trim()} (${altBirim}/m), UOR/alt birim: ${uorAltBirim} → ${uor} UOR/m`,
    `Global köken (merkez): ${merkez.map((d) => d.toFixed(3)).join(', ')}`,
    `Elemanlar: ${sayac.nokta} nokta (tip 3), ${sayac.cizgiDizisi} çizgi dizisi (tip 4), ${sayac.sekil} shape (tip 6), ${sayac.karmasikSekil} complex shape (tip 14)`,
    `Level eşlemesi: ${[...new Set(parcalar.map(katmanAdi))].map((a) => `${a}=${levelHaritasi.numara(a)}`).join(', ') || '-'}`,
  ].join('\n')
  return { veri, onizleme, uyarilar }
}
