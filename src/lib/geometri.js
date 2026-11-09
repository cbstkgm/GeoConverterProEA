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

// ---------------------------------------------------------------------------
// Geometri tipi dönüşümü: çizgi ↔ poligon
// ---------------------------------------------------------------------------

/** Desteklenen hedef tipler. */
export const GEOMETRI_TIPI_HEDEFLERI = Object.freeze(['Polygon', 'LineString'])

const konumKopyala = (k) => k.slice()
const ayniXY = (a, b) => a[0] === b[0] && a[1] === b[1]

/**
 * Bir konum dizisinden kapalı halka üretir. 3'ten az farklı (x, y) konumu varsa null döner.
 * @returns {{ halka: number[][], kapatildi: boolean } | null}
 */
function halkaOlustur(konumlar) {
  if (!Array.isArray(konumlar) || konumlar.length === 0) return null
  const farkli = new Set(konumlar.map((k) => `${k[0]},${k[1]}`))
  if (farkli.size < 3) return null
  const halka = konumlar.map(konumKopyala)
  const kapatildi = !ayniXY(halka[0], halka[halka.length - 1])
  if (kapatildi) halka.push(konumKopyala(halka[0]))
  return { halka, kapatildi }
}

function cizgiyiPoligonaCevir(g, sayac) {
  switch (g.type) {
    case 'LineString': {
      const h = halkaOlustur(g.coordinates)
      if (!h) {
        sayac.donusmeyen++
        return g
      }
      if (h.kapatildi) sayac.kapatilan++
      sayac.donusen++
      return { type: 'Polygon', coordinates: [h.halka] }
    }
    case 'MultiLineString':
      return multiCizgiyiPoligonaCevir(g, sayac)
    case 'GeometryCollection':
      return { ...g, geometries: (g.geometries || []).map((alt) => (alt ? cizgiyiPoligonaCevir(alt, sayac) : alt)) }
    default:
      return g
  }
}

function poligonuCizgiyeCevir(g, sayac) {
  const halkalar = (poligon) => (poligon || []).map((halka) => halka.map(konumKopyala))
  switch (g.type) {
    case 'Polygon': {
      const h = halkalar(g.coordinates)
      if (h.length === 0) return g
      sayac.donusen++
      // Deliksiz poligon tek çizgi olur; iç halkalar (delikler) kaybolmasın diye MultiLineString.
      return h.length === 1 ? { type: 'LineString', coordinates: h[0] } : { type: 'MultiLineString', coordinates: h }
    }
    case 'MultiPolygon': {
      const h = (g.coordinates || []).flatMap(halkalar)
      if (h.length === 0) return g
      sayac.donusen++
      return { type: 'MultiLineString', coordinates: h }
    }
    case 'GeometryCollection':
      return { ...g, geometries: (g.geometries || []).map((alt) => (alt ? poligonuCizgiyeCevir(alt, sayac) : alt)) }
    default:
      return g
  }
}

// Uç noktaları eşleştirmek için anahtar: ~1e-9 birimlik yuvarlama (derecede < 1 mm, metrede 1 nm).
const ucAnahtari = (k) => `${Math.round(k[0] * 1e9)},${Math.round(k[1] * 1e9)}`

const kapaliHalkaMi = (konumlar) =>
  Array.isArray(konumlar) &&
  konumlar.length >= 4 &&
  ayniXY(konumlar[0], konumlar[konumlar.length - 1]) &&
  new Set(konumlar.map((k) => `${k[0]},${k[1]}`)).size >= 3

/**
 * Uç uca bağlanan çizgi parçalarını zincirler (ör. sınırı 2 noktalı yüzlerce segment olarak
 * kaydedilmiş KML'ler). Parçalar gerekirse ters çevrilir. Zincir kendi başlangıcına dönünce durur;
 * ikiden fazla parçanın buluştuğu düğümlerde ilk uygun parça seçilir.
 * Doğrusal karmaşıklık: her uç bir kez indekslenir, her parça bir kez kullanılır.
 * @param {{ konumlar: number[][] }[]} parcalar
 * @returns {{ konumlar: number[][], ilk: number, parcaSayisi: number }[]}
 */
function parcalariZincirle(parcalar) {
  const uclar = new Map()
  const ucEkle = (anahtar, i) => {
    const liste = uclar.get(anahtar)
    if (liste) liste.push(i)
    else uclar.set(anahtar, [i])
  }
  parcalar.forEach((p, i) => {
    ucEkle(ucAnahtari(p.konumlar[0]), i)
    ucEkle(ucAnahtari(p.konumlar[p.konumlar.length - 1]), i)
  })
  const kullanildi = new Array(parcalar.length).fill(false)
  const komsuBul = (anahtar) => {
    const liste = uclar.get(anahtar)
    if (!liste) return -1
    for (const j of liste) if (!kullanildi[j]) return j
    return -1
  }

  const zincirler = []
  for (let i = 0; i < parcalar.length; i++) {
    if (kullanildi[i]) continue
    kullanildi[i] = true
    const ileri = parcalar[i].konumlar.map(konumKopyala)
    const geriParcalar = [] // başa eklenecek parçalar (en yakını önce)
    let parcaSayisi = 1
    let basAnahtar = ucAnahtari(ileri[0])

    // İleri yönde uzat: zincirin sonuna bağlanan parçaları ekle.
    for (;;) {
      const sonAnahtar = ucAnahtari(ileri[ileri.length - 1])
      if (sonAnahtar === basAnahtar && ileri.length > 2) break // halka kapandı
      const j = komsuBul(sonAnahtar)
      if (j < 0) break
      kullanildi[j] = true
      parcaSayisi++
      const p = parcalar[j].konumlar.map(konumKopyala)
      if (ucAnahtari(p[0]) !== sonAnahtar) p.reverse()
      for (let k = 1; k < p.length; k++) ileri.push(p[k])
    }

    // Kapanmadıysa geri yönde uzat: zincirin başına bağlanan parçaları ekle.
    const kapandi = () => ucAnahtari(ileri[ileri.length - 1]) === basAnahtar
    if (!(kapandi() && ileri.length > 2)) {
      for (;;) {
        const j = komsuBul(basAnahtar)
        if (j < 0) break
        kullanildi[j] = true
        parcaSayisi++
        const p = parcalar[j].konumlar.map(konumKopyala)
        if (ucAnahtari(p[p.length - 1]) !== basAnahtar) p.reverse()
        geriParcalar.push(p.slice(0, -1))
        basAnahtar = ucAnahtari(p[0])
        if (kapandi()) break
      }
    }

    const konumlar = []
    for (let g = geriParcalar.length - 1; g >= 0; g--) konumlar.push(...geriParcalar[g])
    for (const k of ileri) konumlar.push(k)
    zincirler.push({ konumlar, ilk: i, parcaSayisi })
  }
  return zincirler
}

/**
 * MultiLineString → MultiPolygon: parçalar kendi içinde uç uca birleştirilir, oluşan her
 * halka MultiPolygon'un bir üyesi olur. Poligon olamayan zincirler atlanır (sayılır).
 * Hiç halka çıkmazsa geometri olduğu gibi döner.
 */
function multiCizgiyiPoligonaCevir(g, sayac) {
  const parcalar = (g.coordinates || []).filter((p) => Array.isArray(p) && p.length > 0)
  const poligonlar = []
  let atlanan = 0
  for (const z of parcalariZincirle(parcalar.map((konumlar) => ({ konumlar })))) {
    const h = halkaOlustur(z.konumlar)
    if (!h) {
      atlanan += z.parcaSayisi
      continue
    }
    if (h.kapatildi) sayac.kapatilan++
    if (z.parcaSayisi > 1) {
      sayac.birlesenParca += z.parcaSayisi
      sayac.birlesenPoligon++
    }
    poligonlar.push([h.halka])
  }
  if (poligonlar.length === 0) {
    sayac.donusmeyen += atlanan
    return g
  }
  sayac.atlanan += atlanan
  sayac.donusen++
  return { type: 'MultiPolygon', coordinates: poligonlar }
}

/**
 * Çizgi → poligon (FeatureCollection düzeyinde).
 * - MultiLineString objesi kendi parçalarıyla MultiPolygon olur (obje korunur).
 * - LineString objeleri: kapalı olan kendi objesinde Polygon olur. Açık olanlar obje obje
 *   dağılmış olsa da uç uca birleştirilir (ör. sınırı 2 noktalı segmentlerle kaydedilmiş KML);
 *   oluşan her zincir bir Polygon objesi olur ve zincirin ilk parçasının özelliklerini taşır.
 */
function cizgileriPoligonlastir(fc, sayac) {
  const havuz = [] // { konumlar, sira } — objeler arası birleştirilecek açık LineString'ler
  const cikti = fc.features.map(() => [])

  fc.features.forEach((f, sira) => {
    const g = f && f.geometry
    if (g && g.type === 'LineString') {
      if (kapaliHalkaMi(g.coordinates)) {
        sayac.donusen++
        cikti[sira].push({ ...f, geometry: { type: 'Polygon', coordinates: [g.coordinates.map(konumKopyala)] } })
      } else if (Array.isArray(g.coordinates) && g.coordinates.length > 0) {
        havuz.push({ konumlar: g.coordinates, sira })
      } else {
        cikti[sira].push(f)
      }
      return
    }
    if (g && (g.type === 'MultiLineString' || g.type === 'GeometryCollection')) {
      const yeni = g.type === 'MultiLineString' ? multiCizgiyiPoligonaCevir(g, sayac) : cizgiyiPoligonaCevir(g, sayac)
      cikti[sira].push(yeni === g ? f : { ...f, geometry: yeni })
      return
    }
    cikti[sira].push(f)
  })

  for (const z of parcalariZincirle(havuz)) {
    const sira = havuz[z.ilk].sira
    const kaynak = fc.features[sira]
    const h = halkaOlustur(z.konumlar)
    if (!h) {
      sayac.donusmeyen += z.parcaSayisi
      cikti[sira].push({ ...kaynak, geometry: { type: 'LineString', coordinates: z.konumlar } })
      continue
    }
    if (h.kapatildi) sayac.kapatilan++
    if (z.parcaSayisi > 1) {
      sayac.birlesenParca += z.parcaSayisi
      sayac.birlesenPoligon++
    }
    sayac.donusen++
    cikti[sira].push({ ...kaynak, geometry: { type: 'Polygon', coordinates: [h.halka] } })
  }

  return cikti.flat()
}

/**
 * Çizgileri poligona (hedef 'Polygon') veya poligonları çizgiye (hedef 'LineString') çevirir.
 * - LineString → Polygon, MultiLineString → MultiPolygon. Uç uca bağlanan parçalar (aynı ya da
 *   farklı objelerde) önce birleştirilir; açık kalan zincir ilk noktayla kapatılır.
 *   3'ten az farklı noktası olan çizgi poligon olamaz; olduğu gibi bırakılır ve uyarılır.
 * - Polygon → LineString (delikliyse tüm halkalarıyla MultiLineString), MultiPolygon → MultiLineString.
 * - Nokta geometrileri ve hedefle ilgisi olmayan tipler değişmez. Özelliklere dokunulmaz.
 * @returns {{ geojson: object, uyarilar: string[], donusenSayisi: number }}
 */
export function geometriTipiDonustur(fc, hedef) {
  fcDogrula(fc)
  if (!GEOMETRI_TIPI_HEDEFLERI.includes(hedef)) {
    throw new Error(`Desteklenmeyen hedef geometri tipi: "${hedef}". 'Polygon' veya 'LineString' olmalıdır.`)
  }
  const sayac = { donusen: 0, donusmeyen: 0, atlanan: 0, kapatilan: 0, birlesenParca: 0, birlesenPoligon: 0 }
  const features =
    hedef === 'Polygon'
      ? cizgileriPoligonlastir(fc, sayac)
      : fc.features.map((f) => {
          if (!f || !f.geometry) return f
          const yeni = poligonuCizgiyeCevir(f.geometry, sayac)
          if (yeni === f.geometry) return f
          const { bbox: _bbox, ...geometri } = yeni
          return { ...f, geometry: geometri }
        })

  const uyarilar = []
  const hedefAd = hedef === 'Polygon' ? 'poligona' : 'çizgiye'
  if (sayac.donusen === 0) {
    uyarilar.push(`Veride ${hedefAd} çevrilebilecek geometri bulunamadı; geometriler değiştirilmedi.`)
  }
  if (sayac.birlesenParca > 0) {
    uyarilar.push(
      `Uç uca bağlanan ${sayac.birlesenParca} çizgi parçası birleştirilerek ${sayac.birlesenPoligon} poligon oluşturuldu (özellikler her zincirin ilk parçasından alındı).`,
    )
  }
  if (sayac.kapatilan > 0) {
    uyarilar.push(`${sayac.kapatilan} açık çizgi, ilk noktasına bağlanarak kapatıldı ve poligona çevrildi.`)
  }
  if (sayac.atlanan > 0) {
    uyarilar.push(`MultiLineString objelerindeki ${sayac.atlanan} parça 3'ten az farklı noktaya sahip olduğu için MultiPolygon'a alınmadı.`)
  }
  if (sayac.donusmeyen > 0) {
    uyarilar.push(`${sayac.donusmeyen} çizgi 3'ten az farklı noktaya sahip olduğu için poligona çevrilemedi ve olduğu gibi bırakıldı.`)
  }

  const { bbox: _fcBbox, ...ust } = fc
  return { geojson: { ...ust, features }, uyarilar, donusenSayisi: sayac.donusen }
}
