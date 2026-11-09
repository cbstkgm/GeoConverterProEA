/**
 * Ortak 3B ağ (mesh) hazırlayıcı — 3B modelleme, CAD ve nokta bulutu yazıcılarının ortak girdisi.
 *
 * GeoJSON FeatureCollection'ı formattan bağımsız bir ara yapıya çevirir:
 *   - Poligonlar earcut ile (delikler dahil) üçgenlenir; tüm üçgenler yukarıdan bakınca saat yönünün
 *     tersinedir (normal +Z). Sıfır alanlı üçgenler atılır.
 *   - Çizgiler köşe dizisi, noktalar tek konum olarak kalır.
 *   - Koordinat ekseni: X = doğu, Y = kuzey, Z = yukarı (GeoJSON/CBS ile aynı). Y-yukarı kullanan formatlar
 *     (glTF, Collada varsayılanı, USD vb.) dönüşümü KENDİ yapar: (x, y, z) → (x, z, -y).
 *   - `merkezle` (varsayılan true): projeksiyonlu koordinatlar (ör. 500000, 4400000) float32'de santimetre
 *     hassasiyetini kaybeder; bu yüzden tüm konumlar sınır kutusunun alt-orta noktasına göre ötelenir ve öteleme
 *     `merkez` olarak döner. Yazıcı bunu dosyaya bir dönüşüm/köken olarak yazmalı ya da belgelendirmelidir.
 *
 * Saf JS: DOM yok; worker ve Node'da çalışır.
 */
import earcut from 'earcut'

/**
 * @typedef {{ objeIndeks: number, ozellikler: object, tip: 'yuzey', konumlar: number[], indeksler: number[] }} YuzeyParcasi
 *   konumlar düz [x,y,z, x,y,z, …] (merkeze göre), indeksler üçlüler (CCW, normal +Z)
 * @typedef {{ objeIndeks: number, ozellikler: object, tip: 'cizgi', konumlar: number[], kapali: boolean }} CizgiParcasi
 * @typedef {{ objeIndeks: number, ozellikler: object, tip: 'nokta', konumlar: number[] }} NoktaParcasi
 */

const sayiMi = (v) => typeof v === 'number' && Number.isFinite(v)

function konumAl(k) {
  if (!Array.isArray(k) || !sayiMi(k[0]) || !sayiMi(k[1])) return null
  return [k[0], k[1], sayiMi(k[2]) ? k[2] : 0]
}

/** Halkayı temizler: geçersiz köşeleri ve kapanış tekrarını atar. */
function halkaTemizle(halka) {
  const k = (Array.isArray(halka) ? halka : []).map(konumAl).filter(Boolean)
  if (k.length > 1) {
    const [a, b] = [k[0], k[k.length - 1]]
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) k.pop()
  }
  return k
}

/** Yassı geometrileri tek tip parçalara açar. */
function parcalaraAc(g, cikti) {
  if (!g || typeof g !== 'object') return
  const c = g.coordinates
  switch (g.type) {
    case 'Point': cikti.push({ tip: 'nokta', veri: c }); break
    case 'MultiPoint': (c || []).forEach((p) => cikti.push({ tip: 'nokta', veri: p })); break
    case 'LineString': cikti.push({ tip: 'cizgi', veri: c }); break
    case 'MultiLineString': (c || []).forEach((l) => cikti.push({ tip: 'cizgi', veri: l })); break
    case 'Polygon': cikti.push({ tip: 'yuzey', veri: c }); break
    case 'MultiPolygon': (c || []).forEach((p) => cikti.push({ tip: 'yuzey', veri: p })); break
    case 'GeometryCollection': (g.geometries || []).forEach((alt) => parcalaraAc(alt, cikti)); break
    default: throw new Error(`Desteklenmeyen geometri tipi: "${g.type}".`)
  }
}

/** Poligonu üçgenler. Dönüş: { konumlar (mutlak), indeksler } ya da null. */
function poligonUcgenle(halkalar) {
  const temiz = (Array.isArray(halkalar) ? halkalar : []).map(halkaTemizle)
  if (!temiz.length || temiz[0].length < 3) return null
  const halkaListesi = [temiz[0], ...temiz.slice(1).filter((h) => h.length >= 3)]
  const duz2 = []
  const konumlar = []
  const delikler = []
  for (let i = 0; i < halkaListesi.length; i++) {
    if (i > 0) delikler.push(duz2.length / 2)
    for (const k of halkaListesi[i]) {
      duz2.push(k[0], k[1])
      konumlar.push(k[0], k[1], k[2])
    }
  }
  const ham = earcut(duz2, delikler, 2)
  const indeksler = []
  for (let i = 0; i < ham.length; i += 3) {
    const [a, b, c] = [ham[i], ham[i + 1], ham[i + 2]]
    const alan2 =
      (duz2[b * 2] - duz2[a * 2]) * (duz2[c * 2 + 1] - duz2[a * 2 + 1]) -
      (duz2[c * 2] - duz2[a * 2]) * (duz2[b * 2 + 1] - duz2[a * 2 + 1])
    if (alan2 === 0) continue
    if (alan2 > 0) indeksler.push(a, b, c)
    else indeksler.push(a, c, b)
  }
  return indeksler.length ? { konumlar, indeksler } : null
}

/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {{ merkezle?: boolean }} [secenekler]
 * @returns {{ merkez: number[], sinir: { min: number[], max: number[] } | null,
 *   parcalar: Array<YuzeyParcasi | CizgiParcasi | NoktaParcasi>, uyarilar: string[],
 *   sayac: { yuzey: number, cizgi: number, nokta: number, ucgen: number, kose: number } }}
 */
export function agOlustur(fc, secenekler = {}) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.')
  }
  const merkezle = secenekler.merkezle !== false
  const uyarilar = []
  let geometrisiz = 0
  let atlanan = 0
  const mutlak = []

  fc.features.forEach((f, objeIndeks) => {
    if (!f || typeof f !== 'object') return
    if (!f.geometry) { geometrisiz++; return }
    const ozellikler = f.properties && typeof f.properties === 'object' ? f.properties : {}
    const ham = []
    parcalaraAc(f.geometry, ham)
    for (const p of ham) {
      if (p.tip === 'nokta') {
        const k = konumAl(p.veri)
        if (k) mutlak.push({ objeIndeks, ozellikler, tip: 'nokta', konumlar: k })
        else atlanan++
      } else if (p.tip === 'cizgi') {
        const k = (Array.isArray(p.veri) ? p.veri : []).map(konumAl).filter(Boolean)
        if (k.length >= 2) mutlak.push({ objeIndeks, ozellikler, tip: 'cizgi', konumlar: k.flat(), kapali: false })
        else atlanan++
      } else {
        const u = poligonUcgenle(p.veri)
        if (u) mutlak.push({ objeIndeks, ozellikler, tip: 'yuzey', konumlar: u.konumlar, indeksler: u.indeksler })
        else atlanan++
      }
    }
  })

  if (geometrisiz) uyarilar.push(`${geometrisiz} obje geometrisiz olduğu için 3B modele alınmadı.`)
  if (atlanan) uyarilar.push(`${atlanan} geometri parçası geçersiz veya alansız olduğu için atlandı.`)

  let sinir = null
  for (const p of mutlak) {
    for (let i = 0; i < p.konumlar.length; i += 3) {
      if (!sinir) sinir = { min: p.konumlar.slice(i, i + 3), max: p.konumlar.slice(i, i + 3) }
      for (let e = 0; e < 3; e++) {
        sinir.min[e] = Math.min(sinir.min[e], p.konumlar[i + e])
        sinir.max[e] = Math.max(sinir.max[e], p.konumlar[i + e])
      }
    }
  }

  const merkez = merkezle && sinir
    ? [(sinir.min[0] + sinir.max[0]) / 2, (sinir.min[1] + sinir.max[1]) / 2, sinir.min[2]]
    : [0, 0, 0]
  const sayac = { yuzey: 0, cizgi: 0, nokta: 0, ucgen: 0, kose: 0 }
  const parcalar = mutlak.map((p) => {
    const konumlar = p.konumlar.map((v, i) => v - merkez[i % 3])
    sayac[p.tip]++
    sayac.kose += konumlar.length / 3
    if (p.tip === 'yuzey') sayac.ucgen += p.indeksler.length / 3
    return { ...p, konumlar }
  })

  return { merkez, sinir, parcalar, uyarilar, sayac }
}
