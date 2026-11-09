/**
 * Geometri yardımcıları (M3).
 *
 * Saf JavaScript: React/DOM kullanmaz; Web Worker ve Node (Vitest) içinde çalışır.
 * Tüm fonksiyonlar girdiyi değiştirmez, yeni FeatureCollection döndürür.
 *
 * Desteklenen geometri tipleri: Point, MultiPoint, LineString, MultiLineString,
 * Polygon, MultiPolygon, GeometryCollection ve null geometri.
 */

const KOORDINAT_DERINLIGI = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
}

/** Girdinin bir FeatureCollection olduğunu doğrular; değilse Türkçe hata fırlatır. */
export function fcDogrula(fc) {
  if (!fc || typeof fc !== 'object' || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Geçersiz veri: GeoJSON FeatureCollection bekleniyordu.')
  }
}

function konumDiziDonustur(koordinatlar, derinlik, fn) {
  if (!Array.isArray(koordinatlar)) {
    throw new Error('Geçersiz geometri: koordinat dizisi bekleniyordu.')
  }
  if (derinlik === 0) return fn(koordinatlar)
  return koordinatlar.map((alt) => konumDiziDonustur(alt, derinlik - 1, fn))
}

/**
 * Geometrideki her konuma (position: [x, y, z?, ...]) fn uygular; yeni geometri döndürür.
 * null geometri null olarak kalır. Geometrinin koordinat dışı alanları (ör. bbox hariç
 * yabancı üyeler) sığ kopyalanır.
 */
export function geometriKonumlariniEsle(geometri, fn) {
  if (geometri == null) return null
  if (geometri.type === 'GeometryCollection') {
    if (!Array.isArray(geometri.geometries)) {
      throw new Error('Geçersiz GeometryCollection: "geometries" dizisi bulunamadı.')
    }
    return { ...geometri, geometries: geometri.geometries.map((g) => geometriKonumlariniEsle(g, fn)) }
  }
  const derinlik = KOORDINAT_DERINLIGI[geometri.type]
  if (derinlik === undefined) {
    throw new Error(`Desteklenmeyen geometri tipi: "${geometri.type}".`)
  }
  return { ...geometri, coordinates: konumDiziDonustur(geometri.coordinates, derinlik, fn) }
}

/** Geometrideki her konumu ziyaret eder (değiştirmeden). */
export function geometriKonumlariniGez(geometri, fn) {
  if (geometri == null) return
  if (geometri.type === 'GeometryCollection') {
    for (const g of geometri.geometries || []) geometriKonumlariniGez(g, fn)
    return
  }
  const derinlik = KOORDINAT_DERINLIGI[geometri.type]
  if (derinlik === undefined) {
    throw new Error(`Desteklenmeyen geometri tipi: "${geometri.type}".`)
  }
  const gez = (k, d) => {
    if (!Array.isArray(k)) throw new Error('Geçersiz geometri: koordinat dizisi bekleniyordu.')
    if (d === 0) fn(k)
    else for (const alt of k) gez(alt, d - 1)
  }
  gez(geometri.coordinates, derinlik)
}

/**
 * Tüm FeatureCollection üzerinde konum eşlemesi yapar. Özellikler (properties)
 * ve diğer alanlar referans olarak korunur (değiştirilmez).
 * bboxEsle: (bbox) => yeniBbox | undefined  — undefined dönerse bbox alanı kaldırılır.
 */
export function fcKonumlariniEsle(fc, fn, bboxEsle = (b) => b) {
  fcDogrula(fc)
  const bboxAyarla = (nesne) => {
    if (!('bbox' in nesne)) return nesne
    const yeni = bboxEsle(nesne.bbox)
    if (yeni === undefined) {
      const { bbox: _bbox, ...kalan } = nesne
      return kalan
    }
    return { ...nesne, bbox: yeni }
  }
  const geometriAyarla = (g) => {
    if (g == null) return null
    const yeni = geometriKonumlariniEsle(g, fn)
    if (yeni.type === 'GeometryCollection') {
      return bboxAyarla({ ...yeni, geometries: yeni.geometries.map((alt) => (alt ? bboxAyarla(alt) : alt)) })
    }
    return bboxAyarla(yeni)
  }
  return bboxAyarla({
    ...fc,
    features: fc.features.map((f) => bboxAyarla({ ...f, geometry: geometriAyarla(f.geometry ?? null) })),
  })
}

/**
 * Z (yükseklik) değerlerini koordinat dizisi düzeyinde kaldırır.
 * - sadeceSifir: false (varsayılan) → tüm konumlardan Z (ve sonrası, ör. M) düşürülür.
 * - sadeceSifir: true → yalnızca z === 0 olan konumlardan Z düşürülür; diğerleri korunur.
 * X/Y değerlerine ve özelliklere (properties) asla dokunulmaz.
 */
export function zDegerleriniKaldir(fc, secenekler = {}) {
  const sadeceSifir = Boolean(secenekler && secenekler.sadeceSifir)
  const konum = (k) => {
    if (k.length < 3) return k.slice()
    if (sadeceSifir && k[2] !== 0) return k.slice()
    return [k[0], k[1]]
  }
  // 3B bbox ([minX,minY,minZ,maxX,maxY,maxZ]) Z tamamen kaldırıldığında 2B'ye indirilir.
  const bbox = (b) => {
    if (sadeceSifir || !Array.isArray(b) || b.length !== 6) return b
    return [b[0], b[1], b[3], b[4]]
  }
  return fcKonumlariniEsle(fc, konum, bbox)
}

function yuvarla(deger, basamak) {
  if (typeof deger !== 'number' || !Number.isFinite(deger)) return deger
  const isaret = deger < 0 ? -1 : 1
  const mutlak = Math.abs(deger)
  // Üstel gösterim hilesi: 1.005 → 1.01 gibi ikili kayan nokta sapmalarını önler.
  let sonuc = Number(`${Math.round(Number(`${mutlak}e${basamak}`))}e-${basamak}`)
  if (!Number.isFinite(sonuc)) {
    const carpan = 10 ** basamak
    sonuc = Math.round(mutlak * carpan) / carpan
  }
  sonuc *= isaret
  return Object.is(sonuc, -0) ? 0 : sonuc
}

/**
 * Tüm koordinat bileşenlerini (X, Y ve varsa Z) verilen ondalık basamağa yuvarlar.
 * basamak: 0–15 arası tam sayı.
 */
export function hassasiyetUygula(fc, basamak) {
  if (!Number.isInteger(basamak) || basamak < 0 || basamak > 15) {
    throw new Error('Hassasiyet 0 ile 15 arasında bir tam sayı olmalıdır.')
  }
  return fcKonumlariniEsle(
    fc,
    (k) => k.map((v) => yuvarla(v, basamak)),
    (b) => (Array.isArray(b) ? b.map((v) => yuvarla(v, basamak)) : b),
  )
}

function geometriBosMu(g) {
  if (g == null) return true
  if (g.type === 'GeometryCollection') {
    return !Array.isArray(g.geometries) || g.geometries.every(geometriBosMu)
  }
  let konumVar = false
  geometriKonumlariniGez(g, () => {
    konumVar = true
  })
  return !konumVar
}

/** FeatureCollection istatistikleri. */
export function istatistikHesapla(fc) {
  fcDogrula(fc)
  const geometriTipleri = {}
  let koordinatSayisi = 0
  let zIceriyor = false
  let bosGeometriSayisi = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const f of fc.features) {
    const g = f && f.geometry ? f.geometry : null
    if (g) geometriTipleri[g.type] = (geometriTipleri[g.type] || 0) + 1
    if (geometriBosMu(g)) {
      bosGeometriSayisi++
      continue
    }
    geometriKonumlariniGez(g, (k) => {
      koordinatSayisi++
      if (k.length >= 3 && typeof k[2] === 'number') zIceriyor = true
      const [x, y] = k
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    })
  }

  return {
    objeSayisi: fc.features.length,
    geometriTipleri,
    koordinatSayisi,
    bbox: minX === Infinity ? null : [minX, minY, maxX, maxY],
    zIceriyor,
    bosGeometriSayisi,
  }
}
