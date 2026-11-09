// ArcInfo Export (.e00) yazıcısı — sıkıştırılmamış ("EXP  0"), ÇİFT HASSASİYETLİ kapsam (coverage).
//
// Biçim kuralları GDAL'ın AVC kütüphanesindeki E00 üreticisinden alınmıştır
// (ogr/ogrsf_frmts/avc/avc_e00gen.cpp, avc_misc.cpp AVCPrintRealValue, avc_e00read.cpp bölüm sırası):
//  - Bölüm başlığı "XXX  3" (3 = çift hassasiyet). Bölüm sırası: ARC, LAB, PAL, TOL, SIN/EOX, PRJ,
//    IFO … EOI, EOS.
//  - Gerçel sayılar: işaret karakteri (' ' veya '-') + C "%17.14E" → 21 karakter (ARC/LAB/PAL/TOL);
//    öznitelik tablolarındaki 8 baytlık gerçeller "%20.17E" → 24 karakter. Üs her zaman en az 2 basamak.
//  - ARC: başlık "%10d"×7 (ArcId, UserId, FNode, TNode, LPoly, RPoly, köşe sayısı); çift hassasiyette
//    satır başına bir köşe (x y). Bitiş: "        -1         0         0         0         0         0         0".
//  - LAB: "%10d%10d" (ValueId, PolyId) + x y; ardından 2 satır (coord2, coord3). Bitiş "-1 0 0.0E+00 0.0E+00".
//  - PAL: "%10d" yay sayısı + minx miny; ikinci satır maxx maxy; ardından satır başına iki üçlü
//    "%10d%10d%10d" (yay no [ters yönde negatif], düğüm, komşu poligon). Yaysız poligon "0 0 0" satırı alır.
//    Bitiş 7'li -1 satırı + " 0.00000000000000E+00 0.00000000000000E+00".
//  - TOL: "%10d%10d" + gerçel. PRJ: her satırdan sonra "~" satırı, bitiş "EOP".
//  - IFO tabloları: başlık "%-32.32s%s%4d%4d%4d%10d" (ad, "XX", alan sayısı ×2, kayıt boyu, kayıt sayısı);
//    alan satırı "%-16.16s%3d%2d%4d%1d%2d%4d%2d%3d%2d%4d%4d%2d%-16.16s%4d-"; kayıtlar alanların E00
//    gösterimlerinin (C: boyut kadar karakter, B4: "%11d", F8: 24 karakter) art arda eklenip 80 karakterlik
//    satırlara bölünmesiyle yazılır (satır sonu boşlukları atılır).
//
// Topoloji (basitleştirilmiş): her poligon halkası kendi kapalı yayıdır (FNode = TNode); dış halkalar saat
// yönünde (poligon yayın SAĞINDA), delikler saat yönünün tersinde yazılır. Poligon 1 evren (universe)
// poligonudur. Komşu poligonlar arasında ortak yay paylaşımı (gerçek kapsam topolojisi) kurulmaz; deliklerin
// iç bölgesi ve yayların sol tarafı evren (1) olarak işaretlenir.
// Bir kapsam hem nokta hem poligon taşıyamaz (ikisi de PAT kullanır): poligon varsa noktalar yazılmaz.
// Karakter kodlaması: Windows-1254 (Türkçe); `veri` bir Uint8Array'dir.

import { poligonIcNoktasi } from './dxf.js'
import { parcalaraAc } from './geopackage.js'
import { onizlemeKisalt, sridCoz } from './wkb.js'

// ---------------------------------------------------------------- biçimlendirme

const d = (n, w) => String(n).padStart(w)

/** E00 gerçel sayı gösterimi: işaret karakteri + d.ddd…E±XX (basamak = ondalık hane sayısı). */
export function e00Gercel(v, basamak = 14) {
  const isaret = v < 0 ? '-' : ' '
  const [mantis, us] = Math.abs(v).toExponential(basamak).split('e')
  const usIsareti = us[0] === '-' ? '-' : '+'
  return `${isaret}${mantis}E${usIsareti}${us.replace(/^[+-]/, '').padStart(2, '0')}`
}
const g21 = (v) => e00Gercel(v, 14)
const g24 = (v) => e00Gercel(v, 17)
const YEDILI_SON = '        -1         0         0         0         0         0         0'

// ---------------------------------------------------------------- Windows-1254

const CP1254_OZEL = new Map([
  ['Ğ', 0xd0], ['İ', 0xdd], ['Ş', 0xde], ['ğ', 0xf0], ['ı', 0xfd], ['ş', 0xfe],
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88],
  ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c], ['‘', 0x91], ['’', 0x92], ['“', 0x93], ['”', 0x94],
  ['•', 0x95], ['–', 0x96], ['—', 0x97], ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c], ['Ÿ', 0x9f],
])
const CP1254_DISI_LATIN1 = new Set([0xd0, 0xdd, 0xde, 0xf0, 0xfd, 0xfe])
function cp1254Bayt(k) {
  const kod = k.codePointAt(0)
  if (kod < 0x80) return kod
  if (CP1254_OZEL.has(k)) return CP1254_OZEL.get(k)
  if (kod >= 0xa0 && kod <= 0xff && !CP1254_DISI_LATIN1.has(kod)) return kod
  return -1
}

// ---------------------------------------------------------------- yardımcılar

const TURKCE_ASCII = { Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U', ç: 'C', ğ: 'G', ı: 'I', ö: 'O', ş: 'S', ü: 'U' }
/** INFO adı: büyük harf ASCII, [A-Z0-9_#-], harfle başlar. */
function infoAdi(ad, uzunluk) {
  let s = String(ad)
    .replace(/[ÇĞİÖŞÜçğıöşü]/g, (h) => TURKCE_ASCII[h])
    .toUpperCase()
    .replace(/[^A-Z0-9_#-]/g, '_')
  if (!/^[A-Z]/.test(s)) s = `A${s}`
  return s.slice(0, uzunluk)
}

const halkaAlani = (h) => {
  let a = 0
  const [ox, oy] = h[0]
  for (let i = 0; i + 1 < h.length; i++) a += (h[i][0] - ox) * (h[i + 1][1] - oy) - (h[i + 1][0] - ox) * (h[i][1] - oy)
  return a / 2
}
const uzunluk = (c) => c.slice(1).reduce((t, k, i) => t + Math.hypot(k[0] - c[i][0], k[1] - c[i][1]), 0)
const kutu = (konumlar) => {
  const k = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity }
  for (const [x, y] of konumlar) {
    k.minx = Math.min(k.minx, x)
    k.miny = Math.min(k.miny, y)
    k.maxx = Math.max(k.maxx, x)
    k.maxy = Math.max(k.maxy, y)
  }
  return k
}

/** Öznitelik sütunları: B4 (32-bit tamsayı/mantıksal), F8 (gerçel) veya C (metin, en çok 320). */
function sutunlariCikar(kayitlar, ayrilmis, uyar, metinTemizle) {
  const tipler = new Map()
  for (const p of kayitlar) {
    for (const [k, v] of Object.entries(p || {})) {
      if (!tipler.has(k)) tipler.set(k, null)
      if (v == null) continue
      let t = 'C'
      if (typeof v === 'boolean') t = 'B4'
      else if (typeof v === 'number' && Number.isFinite(v)) t = Number.isInteger(v) && Math.abs(v) <= 2147483647 ? 'B4' : 'F8'
      const once = tipler.get(k)
      tipler.set(k, !once || once === t ? t : (once === 'B4' && t === 'F8') || (once === 'F8' && t === 'B4') ? 'F8' : 'C')
    }
  }
  const kullanilan = new Set(ayrilmis)
  const sutunlar = []
  for (const [anahtar, tip] of tipler) {
    const temel = infoAdi(anahtar, 16)
    let ad = temel
    let n = 1
    while (kullanilan.has(ad)) {
      const ek = `_${n++}`
      ad = `${temel.slice(0, 16 - ek.length)}${ek}`
    }
    kullanilan.add(ad)
    if (ad !== anahtar.toUpperCase()) uyar(`"${anahtar}" özniteliği INFO kuralları gereği "${ad}" adıyla yazıldı.`)
    const s = { anahtar, ad, tip: tip || 'C' }
    if (s.tip === 'C') {
      let boyut = 1
      for (const p of kayitlar) {
        const v = p?.[anahtar]
        if (v != null) boyut = Math.max(boyut, metinTemizle(v).length)
      }
      if (boyut > 320) {
        uyar(`"${anahtar}" özniteliğindeki 320 karakteri aşan değerler kesildi (INFO metin alanı sınırı).`)
        boyut = 320
      }
      s.boyut = boyut
    }
    sutunlar.push(s)
  }
  return sutunlar
}

const alanTanimi = (ad, tip, boyut, genislik, ondalik) => ({ ad, tip, boyut, genislik, ondalik })
const B4 = (ad, genislik = 5) => alanTanimi(ad, 'B4', 4, genislik, -1)
const F8 = (ad, ondalik = 5) => alanTanimi(ad, 'F8', 8, 18, ondalik)
const TIP_KODU = { B4: 50, F8: 60, C: 20 }

/** INFO tablosunu E00 satırlarına çevirir. */
function tabloSatirlari(tabloAdi, alanlar, kayitlar, metinTemizle) {
  const satirlar = []
  let ofset = 1
  const tanimlar = alanlar.map((a, i) => {
    const t = { ...a, ofset, indeks: i + 1 }
    ofset += a.boyut
    return t
  })
  const kayitBoyu = Math.ceil((ofset - 1) / 2) * 2
  satirlar.push(`${tabloAdi.padEnd(32).slice(0, 32)}XX${d(alanlar.length, 4)}${d(alanlar.length, 4)}${d(kayitBoyu, 4)}${d(kayitlar.length, 10)}`)
  for (const t of tanimlar) {
    satirlar.push(
      `${t.ad.padEnd(16).slice(0, 16)}${d(t.boyut, 3)}${d(-1, 2)}${d(t.ofset, 4)}${d(4, 1)}${d(-1, 2)}${d(t.genislik, 4)}${d(t.ondalik, 2)}` +
        `${d(TIP_KODU[t.tip], 3)}${d(-1, 2)}${d(-1, 4)}${d(-1, 4)}${d(-1, 2)}${''.padEnd(16)}${d(t.indeks, 4)}-`,
    )
  }
  for (const kayit of kayitlar) {
    let metin = ''
    tanimlar.forEach((t, i) => {
      const v = kayit[i]
      if (t.tip === 'B4') metin += d(v == null ? 0 : typeof v === 'boolean' ? Number(v) : Math.trunc(v), 11)
      else if (t.tip === 'F8') metin += g24(v == null || !Number.isFinite(Number(v)) ? 0 : Number(v))
      else metin += (v == null ? '' : metinTemizle(v)).padEnd(t.boyut).slice(0, t.boyut)
    })
    for (let i = 0; i < metin.length; i += 80) satirlar.push(metin.slice(i, i + 80).replace(/ +$/, ''))
  }
  return satirlar
}

// ---------------------------------------------------------------- PRJ

const dms = (derece) => `${d(Math.trunc(derece), 3)}${d(0, 3)}  0.00`
function prjSatirlari(srid, uyar) {
  const anahtar = (k, v) => `${k.padEnd(14)}${v}`
  if (srid === 4326) return [anahtar('Projection', 'GEOGRAPHIC'), anahtar('Datum', 'WGS84'), anahtar('Spheroid', 'WGS84'), anahtar('Units', 'DD'), anahtar('Zunits', 'NO'), 'Parameters']
  if (srid === 3857) {
    return [anahtar('Projection', 'MERCATOR_AUXILIARY_SPHERE'), anahtar('Datum', 'WGS84'), anahtar('Spheroid', 'WGS84'), anahtar('Units', 'METERS'), anahtar('Zunits', 'NO'), 'Parameters']
  }
  if (srid >= 5253 && srid <= 5259) {
    const dom = 27 + (srid - 5253) * 3
    return [
      anahtar('Projection', 'TRANSVERSE'),
      anahtar('Spheroid', 'GRS80'),
      anahtar('Units', 'METERS'),
      anahtar('Zunits', 'NO'),
      anahtar('Xshift', '0.0000000000'),
      anahtar('Yshift', '0.0000000000'),
      'Parameters',
      '  1.00000000 /* scale factor at central meridian',
      `${dms(dom)} /* longitude of central meridian`,
      `${dms(0)} /* latitude of origin`,
      '500000.00000 /* false easting (meters)',
      '0.00000 /* false northing (meters)',
    ]
  }
  if (srid >= 23035 && srid <= 23038) {
    return [
      anahtar('Projection', 'UTM'),
      anahtar('Zone', String(srid - 23000)),
      anahtar('Datum', 'EUR'),
      anahtar('Spheroid', 'INTERNATIONAL1909'),
      anahtar('Units', 'METERS'),
      anahtar('Zunits', 'NO'),
      anahtar('Xshift', '0.0000000000'),
      anahtar('Yshift', '0.0000000000'),
      'Parameters',
    ]
  }
  if (srid == null) uyar('Koordinat sistemi belirtilmedi; PRJ bölümü yazılmadı.')
  else uyar(`EPSG:${srid} için Arc/Info PRJ tanımı bilinmiyor; PRJ bölümü yazılmadı.`)
  return null
}

// ---------------------------------------------------------------- ana yazıcı

/**
 * GeoJSON FeatureCollection'ı ArcInfo Export (.e00) kapsamına yazar.
 * @param {object} fc FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler] crs ('EPSG:xxxx'), kapsamAdi (varsayılan 'OBJELER', en çok 13 karakter)
 * @returns {Promise<{ veri: Uint8Array, onizleme: string, uyarilar: string[] }>}
 */
export async function e00Yaz(fc, secenekler = {}) {
  const ayar = secenekler || {}
  const uyarilar = []
  const uyar = (m) => {
    if (!uyarilar.includes(m)) uyarilar.push(m)
  }
  let kodlanamayan = false
  const metinTemizle = (v) => {
    const s = (typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/[\r\n\t]+/g, ' ')
    let c = ''
    for (const k of s) {
      if (cp1254Bayt(k) >= 0) c += k
      else {
        c += '?'
        kodlanamayan = true
      }
    }
    return c
  }
  const kapsam = infoAdi(ayar.kapsamAdi || 'OBJELER', 13)
  if (ayar.kapsamAdi && kapsam !== ayar.kapsamAdi) uyar(`Kapsam adı "${ayar.kapsamAdi}" yerine "${kapsam}" kullanıldı (en çok 13 karakter, büyük harf ASCII).`)
  const srid = sridCoz(ayar.crs)
  const objeler = Array.isArray(fc?.features) ? fc.features : []

  // 1) Geometrileri ayır
  const cizgiler = [] // { p, c }
  const poligonlar = [] // { p, halkalar }
  const noktalar = [] // { p, k }
  let geometrisiz = 0
  let cokParcali = 0
  let zVar = false
  const temiz = (k) => {
    if (!Array.isArray(k) || !Number.isFinite(k[0]) || !Number.isFinite(k[1])) throw new Error('geçersiz koordinat')
    if (k.length > 2) zVar = true
    return [k[0], k[1]]
  }
  objeler.forEach((f, i) => {
    const p = f?.properties || {}
    const parcalar = f?.geometry ? parcalaraAc(f.geometry) : []
    if (!parcalar.length) {
      geometrisiz++
      return
    }
    try {
      const yeni = { cizgi: [], poligon: [], nokta: [] }
      for (const g of parcalar) {
        const c = g.coordinates
        if (g.type === 'Point') yeni.nokta.push(temiz(c))
        else if (g.type === 'MultiPoint') c.forEach((k) => yeni.nokta.push(temiz(k)))
        else if (g.type === 'LineString') yeni.cizgi.push(c.map(temiz))
        else if (g.type === 'MultiLineString') c.forEach((l) => yeni.cizgi.push(l.map(temiz)))
        else if (g.type === 'Polygon') yeni.poligon.push(c.map((h) => h.map(temiz)))
        else if (g.type === 'MultiPolygon') c.forEach((pl) => yeni.poligon.push(pl.map((h) => h.map(temiz))))
      }
      if (yeni.cizgi.length + yeni.poligon.length + yeni.nokta.length > 1) cokParcali++
      yeni.cizgi.filter((c) => c.length >= 2).forEach((c) => cizgiler.push({ p, c }))
      yeni.poligon
        .map((pl) => pl.filter((h) => h.length >= 4))
        .filter((pl) => pl.length)
        .forEach((halkalar) => poligonlar.push({ p, halkalar }))
      yeni.nokta.forEach((k) => noktalar.push({ p, k }))
    } catch (e) {
      uyar(`${i + 1}. obje yazılamadı (${e.message}).`)
    }
  })
  if (geometrisiz) uyar(`Geometrisi olmayan ${geometrisiz} obje E00'a yazılmadı (kapsam objeleri geometri gerektirir).`)
  if (cokParcali) uyar(`${cokParcali} çok parçalı obje parçalarına ayrıldı; her parça aynı öznitelikleri taşır.`)
  if (zVar) uyar('Z değerleri yazılmadı (E00 kapsamı 2 boyutludur).')
  if (poligonlar.length && noktalar.length) {
    uyar(`Bir E00 kapsamı hem nokta hem poligon taşıyamaz (ikisi de PAT tablosunu kullanır); ${noktalar.length} nokta yazılmadı.`)
    noktalar.length = 0
  }

  // 2) Yaylar (ARC) ve poligonlar (PAL)
  const yaylar = [] // { kullanici, fnode, tnode, sol, sag, c, p }
  let dugum = 0
  cizgiler.forEach(({ p, c }, i) => {
    yaylar.push({ kullanici: i + 1, fnode: ++dugum, tnode: ++dugum, sol: 0, sag: 0, c, p })
  })
  const palKayitlari = [] // poligon no 2.. (1 = evren)
  poligonlar.forEach(({ p, halkalar }, j) => {
    const no = j + 2
    const ylar = []
    let alan = 0
    let cevre = 0
    halkalar.forEach((h, hi) => {
      const a = halkaAlani(h)
      // dış halka saat yönünde (alan < 0), delik saat yönünün tersinde (alan > 0): poligon yayın sağında
      const c = (hi === 0 ? a > 0 : a < 0) ? [...h].reverse() : h
      alan += hi === 0 ? Math.abs(a) : -Math.abs(a)
      cevre += uzunluk(h)
      const node = ++dugum
      yaylar.push({ kullanici: 0, fnode: node, tnode: node, sol: 1, sag: no, c, p: null, dis: hi === 0 })
      ylar.push({ yay: yaylar.length, dugum: node, komsu: 1 })
    })
    const merkez = poligonIcNoktasi(halkalar[0], halkalar.slice(1)) ?? halkalar[0][0]
    palKayitlari.push({ no, p, ylar, kutu: kutu(halkalar[0]), alan, cevre, merkez: [merkez[0], merkez[1]] })
  })

  // 3) Satırlar
  const satirlar = [`EXP  0 /GEOCONVERTER/${kapsam}.E00`]
  const tumKonumlar = [...yaylar.flatMap((y) => y.c), ...noktalar.map((n) => n.k)]
  const genel = tumKonumlar.length ? kutu(tumKonumlar) : { minx: 0, miny: 0, maxx: 0, maxy: 0 }

  if (yaylar.length) {
    satirlar.push('ARC  3')
    yaylar.forEach((y, i) => {
      satirlar.push(`${d(i + 1, 10)}${d(y.kullanici, 10)}${d(y.fnode, 10)}${d(y.tnode, 10)}${d(y.sol, 10)}${d(y.sag, 10)}${d(y.c.length, 10)}`)
      for (const [x, yy] of y.c) satirlar.push(`${g21(x)}${g21(yy)}`)
    })
    satirlar.push(YEDILI_SON)
  }

  const etiketler = palKayitlari.length
    ? palKayitlari.map((r) => ({ deger: r.no - 1, poligon: r.no, k: r.merkez }))
    : noktalar.map((n, i) => ({ deger: i + 1, poligon: i + 1, k: n.k }))
  if (etiketler.length) {
    satirlar.push('LAB  3')
    for (const e of etiketler) {
      const xy = `${g21(e.k[0])}${g21(e.k[1])}`
      satirlar.push(`${d(e.deger, 10)}${d(e.poligon, 10)}${xy}`, xy, xy)
    }
    satirlar.push('        -1         0 0.00000000000000E+00 0.00000000000000E+00')
  }

  if (palKayitlari.length) {
    const pk = kutu(palKayitlari.flatMap((r) => [[r.kutu.minx, r.kutu.miny], [r.kutu.maxx, r.kutu.maxy]]))
    const evren = {
      ylar: palKayitlari.flatMap((r) => r.ylar.filter((y) => yaylar[y.yay - 1].dis).map((y) => ({ yay: -y.yay, dugum: y.dugum, komsu: r.no }))),
      kutu: pk,
    }
    satirlar.push('PAL  3')
    for (const r of [evren, ...palKayitlari]) {
      satirlar.push(`${d(r.ylar.length, 10)}${g21(r.kutu.minx)}${g21(r.kutu.miny)}`, `${g21(r.kutu.maxx)}${g21(r.kutu.maxy)}`)
      if (!r.ylar.length) satirlar.push(`${d(0, 10)}${d(0, 10)}${d(0, 10)}`)
      for (let i = 0; i < r.ylar.length; i += 2) {
        satirlar.push(r.ylar.slice(i, i + 2).map((y) => `${d(y.yay, 10)}${d(y.dugum, 10)}${d(y.komsu, 10)}`).join(''))
      }
    }
    satirlar.push(YEDILI_SON, ' 0.00000000000000E+00 0.00000000000000E+00')
  }

  satirlar.push('TOL  3')
  for (let i = 1; i <= 10; i++) satirlar.push(`${d(i, 10)}${d(1, 10)}${g21(0)}`)
  satirlar.push(YEDILI_SON)
  satirlar.push('SIN  3', 'EOX')

  const prj = prjSatirlari(srid, uyar)
  if (prj) {
    satirlar.push('PRJ  3')
    for (const s of prj) satirlar.push(s, '~')
    satirlar.push('EOP')
  }

  // 4) INFO tabloları
  satirlar.push('IFO  3')
  const kimlik = [B4(`${kapsam}#`), B4(`${kapsam}-ID`)]
  if (yaylar.length) {
    const ayrilmis = ['FNODE#', 'TNODE#', 'LPOLY#', 'RPOLY#', 'LENGTH', `${kapsam}#`, `${kapsam}-ID`]
    const sutunlar = sutunlariCikar(cizgiler.map((c) => c.p), ayrilmis, uyar, metinTemizle)
    const alanlar = [B4('FNODE#'), B4('TNODE#'), B4('LPOLY#'), B4('RPOLY#'), F8('LENGTH'), ...kimlik, ...sutunlar.map(kullaniciAlani)]
    const kayitlar = yaylar.map((y, i) => [y.fnode, y.tnode, y.sol, y.sag, uzunluk(y.c), i + 1, y.kullanici, ...sutunlar.map((s) => y.p?.[s.anahtar])])
    satirlar.push(...tabloSatirlari(`${kapsam}.AAT`, alanlar, kayitlar, metinTemizle))
  }
  satirlar.push(
    ...tabloSatirlari(`${kapsam}.BND`, [F8('XMIN'), F8('YMIN'), F8('XMAX'), F8('YMAX')], [[genel.minx, genel.miny, genel.maxx, genel.maxy]], metinTemizle),
  )
  if (etiketler.length) {
    const ayrilmis = ['AREA', 'PERIMETER', `${kapsam}#`, `${kapsam}-ID`]
    const kaynak = palKayitlari.length ? palKayitlari : noktalar
    const sutunlar = sutunlariCikar(kaynak.map((r) => r.p), ayrilmis, uyar, metinTemizle)
    const alanlar = [F8('AREA'), F8('PERIMETER'), ...kimlik, ...sutunlar.map(kullaniciAlani)]
    const kayitlar = palKayitlari.length
      ? [
          [-palKayitlari.reduce((t, r) => t + r.alan, 0), palKayitlari.reduce((t, r) => t + r.cevre, 0), 1, 0, ...sutunlar.map(() => null)],
          ...palKayitlari.map((r) => [r.alan, r.cevre, r.no, r.no - 1, ...sutunlar.map((s) => r.p?.[s.anahtar])]),
        ]
      : noktalar.map((n, i) => [0, 0, i + 1, i + 1, ...sutunlar.map((s) => n.p?.[s.anahtar])])
    satirlar.push(...tabloSatirlari(`${kapsam}.PAT`, alanlar, kayitlar, metinTemizle))
  }
  const tikler = [[genel.minx, genel.miny], [genel.minx, genel.maxy], [genel.maxx, genel.maxy], [genel.maxx, genel.miny]]
  satirlar.push(...tabloSatirlari(`${kapsam}.TIC`, [B4('IDTIC'), F8('XTIC'), F8('YTIC')], tikler.map((t, i) => [i + 1, ...t]), metinTemizle))
  satirlar.push('EOI', 'EOS')

  if (kodlanamayan) uyar('Windows-1254 (Türkçe) kod sayfasında karşılığı olmayan karakterler "?" olarak yazıldı.')

  const metin = `${satirlar.join('\n')}\n`
  const veri = new Uint8Array(metin.length)
  for (let i = 0; i < metin.length; i++) {
    const b = cp1254Bayt(metin[i])
    veri[i] = b >= 0 ? b : 0x3f
  }
  const ozet = [
    `ArcInfo Export (E00, sıkıştırılmamış, çift hassasiyet) – kapsam ${kapsam}, Windows-1254`,
    `Yay (ARC): ${yaylar.length}, poligon (PAL): ${palKayitlari.length}, etiket/nokta (LAB): ${etiketler.length}`,
    '',
  ]
  return { veri, onizleme: onizlemeKisalt([...ozet, ...satirlar]), uyarilar }
}

function kullaniciAlani(s) {
  if (s.tip === 'B4') return B4(s.ad, 11)
  if (s.tip === 'F8') return F8(s.ad, 8)
  return alanTanimi(s.ad, 'C', s.boyut, s.boyut, -1)
}
