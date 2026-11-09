/**
 * Geometri geçerlilik denetimi (OGC Simple Features kuralları).
 *
 * Saf JavaScript: harici kütüphane, React veya DOM kullanmaz; Worker ve Node'da çalışır.
 * Girdiyi değiştirmez. Denetim 2B'dir (x, y); Z değerleri dikkate alınmaz.
 *
 * Denetlenen kurallar:
 *  - Tüm koordinatlar sonlu sayı olmalı (NaN / Infinity / eksik değer geçersiz).
 *  - LineString en az 2 farklı noktadan oluşmalı.
 *  - Poligon halkası: en az 4 konum, kapalı (ilk = son), en az 3 farklı nokta, sıfırdan farklı alan.
 *  - Halka basit olmalı: kendisiyle kesişemez, kendine değemez, geri dönüş (diken) yapamaz.
 *  - Delikler: dış sınırın içinde olmalı, dış sınırı veya birbirini kesemez / örtüşemez,
 *    birbirinin içinde olamaz (tek noktada değmeleri serbesttir).
 *  - MultiPolygon parçaları birbiriyle kesişemez, örtüşemez, birbirinin içinde olamaz
 *    (tek noktada değmeleri serbesttir).
 *
 * Kesişim denetimi x eksenine göre sırala-ve-süpür (sort & sweep) ile yapılır; sınır verilerinde
 * neredeyse doğrusal çalışır.
 */

const AZAMI_SORUN = 50

const sonluMu = (k) => Array.isArray(k) && k.length >= 2 && Number.isFinite(k[0]) && Number.isFinite(k[1])
const ayniNokta = (a, b) => a[0] === b[0] && a[1] === b[1]
const farkliNoktaSayisi = (konumlar) => new Set(konumlar.map((k) => `${k[0]},${k[1]}`)).size

/** Ardışık tekrarlanan noktaları ayıklar (OGC'de geçerlidir ama kenar komşuluğunu bozar). */
function ardisikTekrarlariAyikla(halka) {
  const temiz = [halka[0]]
  for (let i = 1; i < halka.length; i++) if (!ayniNokta(halka[i], temiz[temiz.length - 1])) temiz.push(halka[i])
  return temiz
}

/** Halkanın işaretli alanı (shoelace). */
function halkaAlani(halka) {
  let toplam = 0
  for (let i = 0; i < halka.length - 1; i++) {
    toplam += halka[i][0] * halka[i + 1][1] - halka[i + 1][0] * halka[i][1]
  }
  return toplam / 2
}

/** (a, b, c) üçlüsünün yönelimi: >0 sola, <0 sağa, 0 doğrusal. */
const yonelim = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

/** c noktası, doğrusal olduğu bilinen [a, b] doğru parçasının kutusu içinde mi? */
const kutuIcinde = (a, b, c) =>
  Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1])

/**
 * İki doğru parçasının ilişkisini sınıflandırır.
 * @returns {{ tur: 'yok' | 'dokunma' | 'kesisme' | 'cakisma', nokta?: number[] }}
 *   dokunma: parçalardan birinin uç noktası diğerinin üzerinde (tek nokta),
 *   kesisme: iç noktalarda çaprazlama, cakisma: doğrusal ve pozitif uzunlukta örtüşme.
 */
function parcaIliskisi(p1, p2, q1, q2) {
  const d1 = yonelim(q1, q2, p1)
  const d2 = yonelim(q1, q2, p2)
  const d3 = yonelim(p1, p2, q1)
  const d4 = yonelim(p1, p2, q2)

  if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
    // Doğrusal: izdüşüm aralıklarının örtüşmesine bak.
    const eksen = Math.abs(p2[0] - p1[0]) >= Math.abs(p2[1] - p1[1]) ? 0 : 1
    const [pa, pb] = [Math.min(p1[eksen], p2[eksen]), Math.max(p1[eksen], p2[eksen])]
    const [qa, qb] = [Math.min(q1[eksen], q2[eksen]), Math.max(q1[eksen], q2[eksen])]
    const bas = Math.max(pa, qa)
    const son = Math.min(pb, qb)
    if (bas > son) return { tur: 'yok' }
    const ortakUc = [p1, p2].find((p) => p[eksen] === bas) || [q1, q2].find((q) => q[eksen] === bas)
    return bas === son ? { tur: 'dokunma', nokta: ortakUc } : { tur: 'cakisma', nokta: ortakUc }
  }

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    const t = d1 / (d1 - d2)
    return { tur: 'kesisme', nokta: [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] }
  }
  if (d1 === 0 && kutuIcinde(q1, q2, p1)) return { tur: 'dokunma', nokta: p1 }
  if (d2 === 0 && kutuIcinde(q1, q2, p2)) return { tur: 'dokunma', nokta: p2 }
  if (d3 === 0 && kutuIcinde(p1, p2, q1)) return { tur: 'dokunma', nokta: q1 }
  if (d4 === 0 && kutuIcinde(p1, p2, q2)) return { tur: 'dokunma', nokta: q2 }
  return { tur: 'yok' }
}

/** Nokta halkanın içinde mi (ışın atma; sınır üzerindeki noktalar belirsizdir)? */
function halkaIcindeMi(nokta, halka) {
  let icinde = false
  for (let i = 0, j = halka.length - 1; i < halka.length; j = i++) {
    const [xi, yi] = halka[i]
    const [xj, yj] = halka[j]
    if (yi > nokta[1] !== yj > nokta[1] && nokta[0] < ((xj - xi) * (nokta[1] - yi)) / (yj - yi) + xi) {
      icinde = !icinde
    }
  }
  return icinde
}

/** Halkanın, başka bir halkanın sınırı üzerinde olmayan bir noktasını bulur (içerme testi için). */
function sinirDisiNokta(halka, digerHalka) {
  const sinirUzerinde = (n) => {
    for (let i = 0; i < digerHalka.length - 1; i++) {
      const a = digerHalka[i]
      const b = digerHalka[i + 1]
      if (yonelim(a, b, n) === 0 && kutuIcinde(a, b, n)) return true
    }
    return false
  }
  for (let i = 0; i < halka.length - 1; i++) {
    if (!sinirUzerinde(halka[i])) return halka[i]
  }
  // Tüm köşeler sınırdaysa bir kenarın orta noktasını dene.
  for (let i = 0; i < halka.length - 1; i++) {
    const orta = [(halka[i][0] + halka[i + 1][0]) / 2, (halka[i][1] + halka[i + 1][1]) / 2]
    if (!sinirUzerinde(orta)) return orta
  }
  return null
}

function halkaKutusu(halka) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of halka) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

const kutularKesisir = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

/**
 * Halkanın yapısal denetimi (kesişim hariç). Sorun varsa ilkini döndürür.
 * @returns {{ neden: string, konum: number[] } | null}
 */
function halkaYapisiniDenetle(halka, ad) {
  if (!Array.isArray(halka) || halka.length === 0) return { neden: `${ad} boş`, konum: null }
  const bozuk = halka.find((k) => !sonluMu(k))
  if (bozuk) return { neden: `${ad} geçersiz (sayısal olmayan) koordinat içeriyor`, konum: null }
  if (!ayniNokta(halka[0], halka[halka.length - 1])) {
    return { neden: `${ad} kapalı değil (ilk ve son nokta farklı)`, konum: halka[0] }
  }
  if (halka.length < 4) return { neden: `${ad} 4'ten az noktadan oluşuyor`, konum: halka[0] }
  if (farkliNoktaSayisi(halka) < 3) return { neden: `${ad} 3'ten az farklı noktadan oluşuyor`, konum: halka[0] }
  // Geri dönüş (diken): b'ye gidip aynı doğru üzerinde geri dönen ardışık kenarlar.
  const temiz = ardisikTekrarlariAyikla(halka)
  const n = temiz.length - 1 // son nokta = ilk nokta
  // Önce: tüm noktalar tek doğru üzerindeyse (alan sıfır) bunu açıkça söyle.
  if (temiz.every((p) => yonelim(temiz[0], temiz[1], p) === 0)) {
    return { neden: `${ad} sıfır alanlı (tüm noktalar doğrusal)`, konum: halka[0] }
  }
  for (let i = 0; i < n; i++) {
    const a = temiz[(i - 1 + n) % n]
    const b = temiz[i]
    const c = temiz[(i + 1) % n]
    const geriDonus = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0
    if (yonelim(a, b, c) === 0 && geriDonus) {
      return { neden: `${ad} geri dönüş (diken) yapıyor: ardışık kenarlar üst üste biniyor`, konum: b }
    }
  }
  return null
}

/**
 * Poligon halkalarının (birden çok poligonun) kenar kesişimlerini süpürme ile denetler.
 * @param {number[][][][]} poligonlar her biri [dış, delik1, ...] halkaları
 * @returns {{ neden: string, konum: number[] } | null}
 */
function kesisimleriDenetle(poligonlar) {
  const parcalar = []
  poligonlar.forEach((halkalar, p) => {
    halkalar.forEach((hamHalka, h) => {
      const halka = ardisikTekrarlariAyikla(hamHalka)
      const n = halka.length - 1
      for (let i = 0; i < n; i++) {
        const a = halka[i]
        const b = halka[i + 1]
        parcalar.push({ a, b, p, h, i, n, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) })
      }
    })
  })
  parcalar.sort((s, t) => s.minX - t.minX)

  const komsuMu = (s, t) => {
    if (s.p !== t.p || s.h !== t.h) return false
    const fark = Math.abs(s.i - t.i)
    return fark === 1 || fark === s.n - 1
  }

  const aktif = []
  for (const s of parcalar) {
    // Süpürme çizgisinin gerisinde kalan parçaları çıkar.
    let yaz = 0
    for (let k = 0; k < aktif.length; k++) if (aktif[k].maxX >= s.minX) aktif[yaz++] = aktif[k]
    aktif.length = yaz

    for (const t of aktif) {
      if (t.maxY < s.minY || s.maxY < t.minY) continue
      const iliski = parcaIliskisi(s.a, s.b, t.a, t.b)
      if (iliski.tur === 'yok') continue
      const ayniHalka = s.p === t.p && s.h === t.h
      if (ayniHalka) {
        if (komsuMu(s, t)) {
          // Komşu kenarlar ortak köşede değer; yalnızca geri dönüş (örtüşme) geçersizdir.
          if (iliski.tur === 'cakisma') return { neden: 'Halka geri dönüş (diken) yapıyor: ardışık kenarlar örtüşüyor', konum: iliski.nokta }
          continue
        }
        return { neden: 'Halka kendisiyle kesişiyor veya kendine değiyor', konum: iliski.nokta }
      }
      if (iliski.tur === 'dokunma') continue // farklı halkalar tek noktada değebilir
      if (s.p === t.p) return { neden: 'Poligonun delik ve dış sınırı (veya iki deliği) birbirini kesiyor', konum: iliski.nokta }
      return { neden: 'MultiPolygon parçaları birbirini kesiyor veya örtüşüyor', konum: iliski.nokta }
    }
    aktif.push(s)
  }
  return null
}

/** Tek poligonun (halkalar dizisi) yapı ve içerme denetimi (kenar kesişimleri hariç). */
function poligonYapisiniDenetle(halkalar) {
  if (!Array.isArray(halkalar) || halkalar.length === 0) return { neden: 'Poligon boş', konum: null }
  for (let h = 0; h < halkalar.length; h++) {
    const sorun = halkaYapisiniDenetle(halkalar[h], h === 0 ? 'Dış sınır halkası' : `${h}. delik halkası`)
    if (sorun) return sorun
  }
  const dis = halkalar[0]
  for (let h = 1; h < halkalar.length; h++) {
    const nokta = sinirDisiNokta(halkalar[h], dis)
    if (nokta && !halkaIcindeMi(nokta, dis)) return { neden: `${h}. delik dış sınırın dışında`, konum: nokta }
    for (let d = 1; d < halkalar.length; d++) {
      if (d === h) continue
      const n2 = sinirDisiNokta(halkalar[h], halkalar[d])
      if (n2 && halkaIcindeMi(n2, halkalar[d])) return { neden: `${h}. delik başka bir deliğin içinde`, konum: n2 }
    }
  }
  return null
}

/** MultiPolygon parçalarının birbirinin içinde olup olmadığını denetler (kesişimler ayrıca denetlenir). */
function parcaIcermeleriniDenetle(poligonlar) {
  const kutular = poligonlar.map((p) => halkaKutusu(p[0]))
  for (let a = 0; a < poligonlar.length; a++) {
    for (let b = 0; b < poligonlar.length; b++) {
      if (a === b || !kutularKesisir(kutular[a], kutular[b])) continue
      const nokta = sinirDisiNokta(poligonlar[a][0], poligonlar[b][0])
      if (!nokta || !halkaIcindeMi(nokta, poligonlar[b][0])) continue
      // b'nin bir deliğinin içindeyse (ada) geçerlidir.
      const delikte = poligonlar[b].slice(1).some((delik) => halkaIcindeMi(nokta, delik))
      if (!delikte) return { neden: `MultiPolygon'un ${a + 1}. parçası ${b + 1}. parçanın içinde (örtüşüyor)`, konum: nokta }
    }
  }
  return null
}

/**
 * Tek bir geometriyi denetler.
 * @returns {{ neden: string, konum: number[] | null } | null} geçerliyse null
 */
export function geometriDenetle(g) {
  if (g == null) return null
  switch (g.type) {
    case 'Point':
      return sonluMu(g.coordinates) ? null : { neden: 'Nokta geçersiz (sayısal olmayan) koordinat içeriyor', konum: null }
    case 'MultiPoint': {
      if (!Array.isArray(g.coordinates)) return { neden: 'Koordinat dizisi yok', konum: null }
      return g.coordinates.every(sonluMu) ? null : { neden: 'Noktalardan biri geçersiz koordinat içeriyor', konum: null }
    }
    case 'LineString':
    case 'MultiLineString': {
      const cizgiler = g.type === 'LineString' ? [g.coordinates] : g.coordinates
      if (!Array.isArray(cizgiler)) return { neden: 'Koordinat dizisi yok', konum: null }
      for (const c of cizgiler) {
        if (!Array.isArray(c) || !c.every(sonluMu)) return { neden: 'Çizgi geçersiz (sayısal olmayan) koordinat içeriyor', konum: null }
        if (farkliNoktaSayisi(c) < 2) return { neden: "Çizgi 2'den az farklı noktadan oluşuyor", konum: c[0] || null }
      }
      return null
    }
    case 'Polygon':
    case 'MultiPolygon': {
      const poligonlar = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
      if (!Array.isArray(poligonlar) || poligonlar.length === 0) return { neden: 'Koordinat dizisi yok', konum: null }
      for (const p of poligonlar) {
        const sorun = poligonYapisiniDenetle(p)
        if (sorun) return sorun
      }
      const kesisim = kesisimleriDenetle(poligonlar)
      if (kesisim) return kesisim
      // Basit olduğu kesinleşen halkada sıfır alan = tüm noktalar doğrusal.
      for (const p of poligonlar) {
        for (let h = 0; h < p.length; h++) {
          if (halkaAlani(p[h]) === 0) {
            return { neden: `${h === 0 ? 'Dış sınır halkası' : `${h}. delik halkası`} sıfır alanlı (tüm noktalar doğrusal)`, konum: p[h][0] }
          }
        }
      }
      return poligonlar.length > 1 ? parcaIcermeleriniDenetle(poligonlar) : null
    }
    case 'GeometryCollection': {
      for (const alt of g.geometries || []) {
        const sorun = geometriDenetle(alt)
        if (sorun) return sorun
      }
      return null
    }
    default:
      return { neden: `Bilinmeyen geometri tipi: ${String(g.type)}`, konum: null }
  }
}

/**
 * FeatureCollection'daki tüm geometrileri denetler.
 * @returns {{
 *   denetlenen: number, gecerli: number, gecersiz: number, bos: number,
 *   sorunlar: { obje: number, tip: string, neden: string, konum: number[] | null }[],
 *   kesildi: boolean
 * }} obje: 1'den başlayan obje sırası; sorunlar en fazla 50 kayıt.
 */
export function gecerlilikDenetle(fc) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Geçersiz veri: GeoJSON FeatureCollection bekleniyordu.')
  }
  const sonuc = { denetlenen: 0, gecerli: 0, gecersiz: 0, bos: 0, sorunlar: [], kesildi: false }
  fc.features.forEach((f, i) => {
    const g = f && f.geometry
    if (!g) {
      sonuc.bos++
      return
    }
    sonuc.denetlenen++
    let sorun
    try {
      sorun = geometriDenetle(g)
    } catch {
      sorun = { neden: 'Geometri yapısı okunamadı (bozuk koordinat dizisi)', konum: null }
    }
    if (!sorun) {
      sonuc.gecerli++
      return
    }
    sonuc.gecersiz++
    if (sonuc.sorunlar.length < AZAMI_SORUN) {
      sonuc.sorunlar.push({ obje: i + 1, tip: g.type, neden: sorun.neden, konum: sorun.konum ? sorun.konum.slice(0, 2) : null })
    } else {
      sonuc.kesildi = true
    }
  })
  return sonuc
}
