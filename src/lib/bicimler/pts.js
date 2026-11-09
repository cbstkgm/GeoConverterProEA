/**
 * Leica PTS nokta bulutu yazıcısı + nokta bulutu yazıcılarının (LAS, PCD, PTX, E57) ortak
 * köşe toplayıcısı `noktaBulutuTopla`.
 *
 * PTS: ilk satır nokta sayısı, sonra her satırda "x y z yoğunluk [r g b]".
 * Yoğunluk Leica'da -2048…2047 aralığındadır; elimizde ölçülmüş yoğunluk olmadığı için 0 yazılır.
 * Renk yalnızca TÜM noktaların objelerinde sayısal 0–255 aralığında r, g, b öznitelikleri varsa
 * yazılır (PTS'te bir dosyadaki tüm satırlar aynı sütun sayısını taşımalıdır).
 *
 * Saf JS: DOM / window yok; Web Worker ve Node (Vitest) altında çalışır.
 */
import { sayiMetni } from './xyz.js'

export const ONIZLEME_SATIR = 200
const sayiMi = (v) => typeof v === 'number' && Number.isFinite(v)

export function fcDenetle(fc) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.')
  }
}

function parcalaraAc(g, cikti) {
  if (g == null || typeof g !== 'object') return
  const c = g.coordinates
  const dizi = (x) => (Array.isArray(x) ? x : [])
  switch (g.type) {
    case 'Point': cikti.push({ konumlar: [c], halka: false }); break
    case 'MultiPoint':
    case 'LineString': cikti.push({ konumlar: dizi(c), halka: false }); break
    case 'MultiLineString': for (const l of dizi(c)) cikti.push({ konumlar: dizi(l), halka: false }); break
    case 'Polygon': for (const h of dizi(c)) cikti.push({ konumlar: dizi(h), halka: true }); break
    case 'MultiPolygon': for (const p of dizi(c)) for (const h of dizi(p)) cikti.push({ konumlar: dizi(h), halka: true }); break
    case 'GeometryCollection': for (const alt of dizi(g.geometries)) parcalaraAc(alt, cikti); break
    default: throw new Error(`Desteklenmeyen geometri tipi: "${g.type}".`)
  }
}

/**
 * FC'deki tüm köşe noktalarını toplar (xyz.js mantığı): her köşe bir nokta; poligon
 * halkalarının kapanış tekrarı atılır. `obje` = noktanın ait olduğu objenin fc.features
 * içindeki sırası (0 tabanlı).
 * @returns {{ x: number[], y: number[], z: number[], obje: number[], adet: number, zVar: boolean,
 *   zEksik: number, gecersiz: number, geometrisiz: number,
 *   sinir: null | { xmin, ymin, zmin, xmax, ymax, zmax }, uyarilar: string[] }}
 */
export function noktaBulutuTopla(fc) {
  fcDenetle(fc)
  const x = [], y = [], z = [], obje = []
  let zEksik = 0, gecersiz = 0, geometrisiz = 0, zVar = false
  fc.features.forEach((f, sira) => {
    const g = f && typeof f === 'object' ? f.geometry : null
    if (g == null || typeof g !== 'object') { geometrisiz++; return }
    const parcalar = []
    parcalaraAc(g, parcalar)
    for (const { konumlar, halka } of parcalar) {
      let liste = konumlar
      if (halka && liste.length > 1) {
        const a = liste[0], b = liste[liste.length - 1]
        if (Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1] && (a[2] ?? 0) === (b[2] ?? 0)) {
          liste = liste.slice(0, -1)
        }
      }
      for (const k of liste) {
        if (!Array.isArray(k) || !sayiMi(k[0]) || !sayiMi(k[1])) { gecersiz++; continue }
        x.push(k[0]); y.push(k[1])
        if (sayiMi(k[2])) { z.push(k[2]); zVar = true } else { z.push(0); zEksik++ }
        obje.push(sira)
      }
    }
  })
  const uyarilar = []
  if (geometrisiz) uyarilar.push(`${geometrisiz} obje boş (null) geometrili; nokta bulutunda karşılığı olmadığından atlandı.`)
  if (gecersiz) uyarilar.push(`${gecersiz} köşe sayısal olmayan X/Y nedeniyle atlandı.`)
  if (zEksik && zVar) uyarilar.push(`${zEksik} noktada Z değeri yoktu; Z = 0 yazıldı.`)
  else if (zEksik) uyarilar.push('Veride Z (yükseklik) yok; tüm noktalara Z = 0 yazıldı.')
  let sinir = null
  if (x.length) {
    sinir = { xmin: Infinity, ymin: Infinity, zmin: Infinity, xmax: -Infinity, ymax: -Infinity, zmax: -Infinity }
    for (let i = 0; i < x.length; i++) {
      if (x[i] < sinir.xmin) sinir.xmin = x[i]
      if (x[i] > sinir.xmax) sinir.xmax = x[i]
      if (y[i] < sinir.ymin) sinir.ymin = y[i]
      if (y[i] > sinir.ymax) sinir.ymax = y[i]
      if (z[i] < sinir.zmin) sinir.zmin = z[i]
      if (z[i] > sinir.zmax) sinir.zmax = z[i]
    }
  }
  return { x, y, z, obje, adet: x.length, zVar, zEksik, gecersiz, geometrisiz, sinir, uyarilar }
}

/** 'EPSG:5255' / 'epsg:5255' / 5255 → 5255 (sayı); geçersizse null. */
export function epsgNumarasi(crs) {
  if (crs === undefined || crs === null || crs === '') return null
  const m = /^(?:EPSG:)?(\d+)$/i.exec(String(crs).trim())
  return m ? Number(m[1]) : null
}

/** Metin satırları için önizleme (ilk N satır). */
export function satirOnizleme(satirlar, baslik = []) {
  const ust = [...baslik, ...satirlar.slice(0, ONIZLEME_SATIR)]
  if (satirlar.length > ONIZLEME_SATIR) ust.push(`… ${satirlar.length - ONIZLEME_SATIR} satır daha`)
  return ust.join('\n')
}

const renkGecerli = (v) => sayiMi(v) && v >= 0 && v <= 255

/**
 * GeoJSON FeatureCollection → Leica PTS metni.
 * Boş FC/nokta yoksa "0" satırlı geçerli bir PTS üretilir ve uyarılır (0 noktalı bulut
 * biçimce geçerlidir; dönüştürme zincirini hata ile kesmek yerine durum bildirilir).
 */
export async function ptsYaz(fc, secenekler = {}) {
  const b = noktaBulutuTopla(fc)
  const uyarilar = [...b.uyarilar]
  if (secenekler.crs) uyarilar.push('PTS biçimi koordinat sistemi bilgisi taşımaz; CRS dosyaya yazılmadı.')
  const renkler = b.adet > 0 && b.obje.every((i) => {
    const p = fc.features[i].properties
    return p && renkGecerli(p.r) && renkGecerli(p.g) && renkGecerli(p.b)
  })
  const satirlar = new Array(b.adet)
  for (let i = 0; i < b.adet; i++) {
    let s = `${sayiMetni(b.x[i])} ${sayiMetni(b.y[i])} ${sayiMetni(b.z[i])} 0`
    if (renkler) {
      const p = fc.features[b.obje[i]].properties
      s += ` ${Math.round(p.r)} ${Math.round(p.g)} ${Math.round(p.b)}`
    }
    satirlar[i] = s
  }
  if (!b.adet) uyarilar.push('Yazılacak nokta bulunamadı; PTS dosyası 0 nokta içeriyor.')
  const veri = `${b.adet}\n${satirlar.length ? `${satirlar.join('\n')}\n` : ''}`
  return { veri, onizleme: satirOnizleme(satirlar, [String(b.adet)]), uyarilar }
}
