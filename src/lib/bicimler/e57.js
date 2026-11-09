/**
 * ASTM E2807 (E57) yazıcısı — tek tarama (data3D), cartesianX/Y/Z double, sıkıştırılmamış.
 *
 * Fiziksel yapı: dosya 1024 baytlık sayfalardan oluşur; her sayfanın ilk 1020 baytı "mantıksal"
 * veri, son 4 baytı bu 1020 baytın CRC-32C'sidir (Castagnoli, yansıtılmış polinom 0x82F63B78;
 * CRC-32/ISO-HDLC DEĞİL). libE57 sağlama toplamını büyük endian yazar; biz de öyle yazarız.
 * Mantıksal ofset L → fiziksel P = floor(L / 1020) * 1024 + L % 1020.
 *
 * Mantıksal düzen:
 *   0     Dosya başlığı (48 bayt): "ASTM-E57", sürüm 1.0, dosya fiziksel uzunluğu,
 *         XML fiziksel ofseti, XML mantıksal uzunluğu, sayfa boyutu (tümü küçük endian).
 *   48    CompressedVector ikili bölümü: bölüm başlığı (32 bayt: sectionId=1, 7 ayrılmış,
 *         sectionLogicalLength, dataPhysicalOffset, indexPhysicalOffset=0) + veri paketleri.
 *         Veri paketi: tip=1, bayrak=0, (mantıksal uzunluk − 1) u16, bytestream sayısı u16,
 *         her bytestream için tampon uzunluğu u16, tamponlar (X, Y, Z ham double), 4'e dolgu.
 *         İndeks paketi isteğe bağlıdır; yazılmaz.
 *   …     XML bölümü (UTF-8): e57Root → data3D[0] → points (CompressedVector, fileOffset =
 *         bölüm başlığının FİZİKSEL ofseti, recordCount).
 *
 * Koordinatlar mutlak (hedef CRS) yazılır; pose yazılmaz (birim kabul edilir). CRS, kök
 * düğümdeki coordinateMetadata metnine (bilinen kodlar için WKT, aksi halde "EPSG:xxxx") yazılır.
 */
import { noktaBulutuTopla } from './pts.js'
import { prjMetni } from './shapefile.js'

export const SAYFA = 1024
export const SAYFA_VERI = 1020
const BASLIK_BOYU = 48
const BOLUM_BASLIK_BOYU = 32
const PAKET_KAYIT = 2048 // paket başına kayıt: 12 + 3·8·2048 = 49164 bayt (< 64 KiB, 4'ün katı)
const E57_NS = 'http://www.astm.org/COMMIT/E57/2010-e57-v1.0'

// ---------------------------------------------------------------- CRC-32C
const CRC_TABLO = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** CRC-32C (Castagnoli). crc32c("123456789") = 0xE3069283. */
export function crc32c(baytlar, bas = 0, son = baytlar.length) {
  let c = 0xffffffff
  for (let i = bas; i < son; i++) c = CRC_TABLO[(c ^ baytlar[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export const fizikselOfset = (mantiksal) => Math.floor(mantiksal / SAYFA_VERI) * SAYFA + (mantiksal % SAYFA_VERI)

/** Mantıksal akışı CRC'li fiziksel sayfalara böler. */
export function sayfala(mantiksal) {
  const sayfaSayisi = Math.max(1, Math.ceil(mantiksal.length / SAYFA_VERI))
  const fiziksel = new Uint8Array(sayfaSayisi * SAYFA)
  const dv = new DataView(fiziksel.buffer)
  for (let s = 0; s < sayfaSayisi; s++) {
    fiziksel.set(mantiksal.subarray(s * SAYFA_VERI, Math.min(mantiksal.length, (s + 1) * SAYFA_VERI)), s * SAYFA)
    dv.setUint32(s * SAYFA + SAYFA_VERI, crc32c(fiziksel, s * SAYFA, s * SAYFA + SAYFA_VERI), false)
  }
  return fiziksel
}

// ---------------------------------------------------------------- yardımcılar
const hiza = (n, k) => Math.ceil(n / k) * k

function guidUret() {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return `{${c.randomUUID().toUpperCase()}}`
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0').toUpperCase()
  return `{${h()}${h()}-${h()}-${h()}-${h()}-${h()}${h()}${h()}}`
}

const cdata = (s) => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
const xmlSayi = (v) => (Number.isFinite(v) ? String(v) : '0')

/** GPS zamanı (1980-01-06'dan beri saniye; 18 artık saniye). */
const gpsZamani = (t) => (t.getTime() / 1000) - 315964800 + 18

function xmlUret({ adet, sinir, bolumFizikselOfset, crsMetni, ad, tarih }) {
  const satir = []
  satir.push('<?xml version="1.0" encoding="UTF-8"?>')
  satir.push(`<e57Root type="Structure" xmlns="${E57_NS}">`)
  satir.push(`<formatName type="String">${cdata('ASTM E57 3D Imaging Data File')}</formatName>`)
  satir.push(`<guid type="String">${cdata(guidUret())}</guid>`)
  satir.push('<versionMajor type="Integer">1</versionMajor>')
  satir.push('<versionMinor type="Integer">0</versionMinor>')
  satir.push(`<e57LibraryVersion type="String">${cdata('GeoConverterProEA E57 yazıcısı')}</e57LibraryVersion>`)
  if (crsMetni) satir.push(`<coordinateMetadata type="String">${cdata(crsMetni)}</coordinateMetadata>`)
  satir.push('<creationDateTime type="Structure">')
  satir.push(`<dateTimeValue type="Float">${xmlSayi(gpsZamani(tarih))}</dateTimeValue>`)
  satir.push('<isAtomicClockReferenced type="Integer">0</isAtomicClockReferenced>')
  satir.push('</creationDateTime>')
  satir.push('<data3D type="Vector" allowHeterogeneousChildren="1">')
  if (adet > 0) {
    satir.push('<vectorChild type="Structure">')
    satir.push(`<guid type="String">${cdata(guidUret())}</guid>`)
    satir.push(`<name type="String">${cdata(ad)}</name>`)
    satir.push('<cartesianBounds type="Structure">')
    for (const [e, k] of [['x', 'x'], ['y', 'y'], ['z', 'z']]) {
      satir.push(`<${e}Minimum type="Float">${xmlSayi(sinir[`${k}min`])}</${e}Minimum>`)
      satir.push(`<${e}Maximum type="Float">${xmlSayi(sinir[`${k}max`])}</${e}Maximum>`)
    }
    satir.push('</cartesianBounds>')
    satir.push(`<points type="CompressedVector" fileOffset="${bolumFizikselOfset}" recordCount="${adet}">`)
    satir.push('<prototype type="Structure">')
    satir.push('<cartesianX type="Float"/>')
    satir.push('<cartesianY type="Float"/>')
    satir.push('<cartesianZ type="Float"/>')
    satir.push('</prototype>')
    satir.push('<codecs type="Vector" allowHeterogeneousChildren="1">')
    satir.push('</codecs>')
    satir.push('</points>')
    satir.push('</vectorChild>')
  }
  satir.push('</data3D>')
  satir.push('<images2D type="Vector" allowHeterogeneousChildren="1">')
  satir.push('</images2D>')
  satir.push('</e57Root>')
  return `${satir.join('\n')}\n`
}

/**
 * Sıkıştırılmamış veri paketleri. Her paket: 6 bayt başlık + 3 × u16 tampon uzunluğu +
 * X/Y/Z ham double tamponları + 4 bayta dolgu.
 */
function paketleriUret(b) {
  const paketler = []
  for (let bas = 0; bas < b.adet; bas += PAKET_KAYIT) {
    const n = Math.min(PAKET_KAYIT, b.adet - bas)
    const tampon = n * 8
    const uzunluk = hiza(6 + 2 * 3 + 3 * tampon, 4)
    const p = new Uint8Array(uzunluk)
    const dv = new DataView(p.buffer)
    p[0] = 1 // DATA_PACKET
    p[1] = 0 // bayraklar
    dv.setUint16(2, uzunluk - 1, true)
    dv.setUint16(4, 3, true) // bytestream sayısı
    for (let s = 0; s < 3; s++) dv.setUint16(6 + 2 * s, tampon, true)
    let o = 12
    for (const dizi of [b.x, b.y, b.z]) {
      for (let i = 0; i < n; i++) { dv.setFloat64(o, dizi[bas + i], true); o += 8 }
    }
    paketler.push(p)
  }
  return paketler
}

/**
 * GeoJSON FeatureCollection → E57 (Uint8Array).
 * Boş FC/nokta yoksa data3D boş olan geçerli bir E57 üretilir ve uyarılır (standart, taramasız
 * dosyaya izin verir; 0 kayıtlı CompressedVector yazmak yerine tarama hiç eklenmez).
 */
export async function e57Yaz(fc, secenekler = {}) {
  const b = noktaBulutuTopla(fc)
  const uyarilar = [...b.uyarilar]
  const tarih = secenekler.tarih instanceof Date ? secenekler.tarih : new Date()

  let crsMetni = null
  if (secenekler.crs == null || secenekler.crs === '') {
    uyarilar.push('Hedef koordinat sistemi belirtilmedi; E57 coordinateMetadata yazılmadı.')
  } else {
    const kod = String(secenekler.crs).trim().toUpperCase()
    crsMetni = prjMetni(kod) ?? kod
    if (!prjMetni(kod)) uyarilar.push(`"${secenekler.crs}" için WKT tanımı yok; coordinateMetadata'ya yalnızca kod yazıldı.`)
  }

  // Mantıksal yerleşim
  const bolumBas = BASLIK_BOYU // 48: 4'ün (ve 8'in) katı
  const paketler = paketleriUret(b)
  const paketToplam = paketler.reduce((t, p) => t + p.length, 0)
  const bolumUzunlugu = b.adet ? BOLUM_BASLIK_BOYU + paketToplam : 0
  const xmlBas = hiza(bolumBas + bolumUzunlugu, 4)
  const xml = new TextEncoder().encode(xmlUret({
    adet: b.adet, sinir: b.sinir, bolumFizikselOfset: fizikselOfset(bolumBas), crsMetni,
    ad: secenekler.ad ?? 'GeoConverterProEA', tarih,
  }))
  const mantiksal = new Uint8Array(xmlBas + xml.length)
  const dv = new DataView(mantiksal.buffer)

  if (b.adet) {
    mantiksal[bolumBas] = 1 // COMPRESSED_VECTOR_SECTION
    dv.setBigUint64(bolumBas + 8, BigInt(bolumUzunlugu), true)
    dv.setBigUint64(bolumBas + 16, BigInt(fizikselOfset(bolumBas + BOLUM_BASLIK_BOYU)), true)
    dv.setBigUint64(bolumBas + 24, 0n, true) // indeks paketi yok
    let o = bolumBas + BOLUM_BASLIK_BOYU
    for (const p of paketler) { mantiksal.set(p, o); o += p.length }
  }
  mantiksal.set(xml, xmlBas)

  const fizikselUzunluk = Math.max(1, Math.ceil(mantiksal.length / SAYFA_VERI)) * SAYFA
  mantiksal.set(new TextEncoder().encode('ASTM-E57'), 0)
  dv.setUint32(8, 1, true) // majorVersion
  dv.setUint32(12, 0, true) // minorVersion
  dv.setBigUint64(16, BigInt(fizikselUzunluk), true)
  dv.setBigUint64(24, BigInt(fizikselOfset(xmlBas)), true)
  dv.setBigUint64(32, BigInt(xml.length), true)
  dv.setBigUint64(40, BigInt(SAYFA), true)

  const veri = sayfala(mantiksal)
  if (!b.adet) uyarilar.push('Yazılacak nokta bulunamadı; E57 dosyası tarama (data3D) içermiyor.')
  const xmlMetni = new TextDecoder().decode(xml)
  const onizleme = [
    'ASTM E2807 (E57) 1.0 — tek tarama, cartesianX/Y/Z double, sıkıştırılmamış',
    `Nokta sayısı: ${b.adet}, veri paketi: ${paketler.length}`,
    `Dosya: ${veri.length} bayt (${veri.length / SAYFA} sayfa × 1024, CRC-32C)`,
    `XML: fiziksel ofset ${fizikselOfset(xmlBas)}, ${xml.length} bayt`,
    '',
    xmlMetni.length > 4000 ? `${xmlMetni.slice(0, 4000)}…` : xmlMetni,
  ].join('\n')
  return { veri, onizleme, uyarilar }
}
