/**
 * STEP yazıcısı: GeoJSON FeatureCollection → ISO 10303-21 (STEP Part 21) metin, AP214
 * (AUTOMOTIVE_DESIGN) şeması. Katı modelleme değil; CBS geometrisinin tel kafes (ve isteğe bağlı
 * üçgen yüzey) aktarımı. FreeCAD/OCCT, CATIA, SolidWorks, Rhino vb. açabilir.
 *
 * Yapı:
 *  - Kök ürün (PRODUCT "GeoConverter") boş bir SHAPE_REPRESENTATION taşır; her geometrili obje kendi
 *    PRODUCT'ı olur (adı `name`/`ad` özniteliği, yoksa "Obje N") ve kök ürüne
 *    NEXT_ASSEMBLY_USAGE_OCCURRENCE + CONTEXT_DEPENDENT_SHAPE_REPRESENTATION (birim dönüşüm) ile
 *    bağlanır. Böylece CAD ağacında obje adları görünür.
 *  - Her obje: SHAPE_REPRESENTATION ── SHAPE_REPRESENTATION_RELATIONSHIP ──▶
 *      GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION (GEOMETRIC_CURVE_SET: CARTESIAN_POINT +
 *      POLYLINE; poligon halkaları kapalı POLYLINE — ilk nokta sonda tekrarlanır, delikler ayrı)
 *    ve secenekler.yuzeyler === true ise ayrıca ──▶ MANIFOLD_SURFACE_SHAPE_REPRESENTATION
 *      (SHELL_BASED_SURFACE_MODEL / OPEN_SHELL / FACE_SURFACE + PLANE + POLY_LOOP üçgenleri;
 *      üçgenler ortak ağ modülünden: ortak/ag.js, CCW, normal +Z).
 *  - Birimler: SI metre / radyan / steradyan; belirsizlik 1E-7 m. Coğrafi CRS'te uyarı verilir
 *    (koordinatlar derece olduğu hâlde metre diye yorumlanır).
 *  - Koordinatlar mutlak (hedef CRS) yazılır: STEP'te georeferans yoktur; öteleme yapılırsa konum
 *    bilgisi kaybolurdu. Çift hassasiyetli REAL'ler büyük TM koordinatlarında sorun çıkarmaz.
 *  - Dize kaçışı (ISO 10303-21 §6.4.3): ' → '', \ → \\, ASCII dışı ve kontrol karakterleri
 *    \X2\hhhh…\X0\ (UTF-16), BMP dışı \X4\hhhhhhhh…\X0\.
 *
 * Bu dosya ayrıca IGES/IFC/DGN yazıcılarının ortak kullandığı yardımcıları dışa aktarır
 * (cbsParcalari, katmanNumaralari, p21Dize, p21Sayi …).
 *
 * Saf JS: DOM yok; worker ve Node'da çalışır.
 */
import { dxfSayi } from './dxf.js'
import { agOlustur } from './ortak/ag.js'
import { KOORDINAT_SISTEMI_TANIMLARI } from '../katalog.js'

// =============================================================== Ortak yardımcılar (CAD yazıcıları)

export const VARSAYILAN_KATMANLAR = Object.freeze({ nokta: 'NOKTA', cizgi: 'CIZGI', poligon: 'POLIGON' })
const KATMAN_ANAHTARLARI = ['layer', 'katman', 'tabaka']
const AD_ANAHTARLARI = ['name', 'ad']

/** Özniteliklerden (büyük/küçük harf duyarsız) aday adlardan ilk dolu ilkel değeri döndürür. */
export function oznitelikDegeri(ozellikler, adaylar) {
  if (!ozellikler || typeof ozellikler !== 'object') return undefined
  const harita = new Map()
  for (const k of Object.keys(ozellikler)) {
    const a = String(k).toLocaleLowerCase('tr')
    if (!harita.has(a)) harita.set(a, k)
  }
  for (const aday of adaylar) {
    const gercek = harita.get(aday)
    if (gercek === undefined) continue
    const deger = ozellikler[gercek]
    if (deger === null || deger === undefined || typeof deger === 'object') continue
    if (String(deger).trim() === '') continue
    return deger
  }
  return undefined
}

export const objeAdi = (ozellikler, sira) => {
  const ad = oznitelikDegeri(ozellikler, AD_ANAHTARLARI)
  return ad === undefined ? `Obje ${sira + 1}` : String(ad)
}

export const objeKatmani = (ozellikler) => oznitelikDegeri(ozellikler, KATMAN_ANAHTARLARI)

/** CRS koordinatları derece mi? (katalogda +proj=longlat; bilinmeyende yalnızca EPSG:4326) */
export function cografiMi(crs) {
  if (typeof crs !== 'string') return false
  const kod = crs.trim().toUpperCase()
  const tanim = KOORDINAT_SISTEMI_TANIMLARI.find((s) => s.kod === kod)
  return tanim ? /\+proj=longlat\b/.test(tanim.tanim) : kod === 'EPSG:4326'
}

const gecerliKonum = (k) => Array.isArray(k) && k.length >= 2 && Number.isFinite(k[0]) && Number.isFinite(k[1])
export const zVar = (k) => k.length > 2 && Number.isFinite(k[2])

/**
 * FeatureCollection'ı CAD yazıcıları için düz parçalara açar ve doğrular. İstisna atmaz.
 * @returns {{ parcalar: Array<{ objeIndeks: number, ozellikler: object,
 *   tip: 'nokta'|'cizgi'|'poligon', konum?: number[], konumlar?: number[][], halkalar?: number[][][] }>,
 *   uyarilar: string[], zVarMi: boolean }}
 *   Poligon halkalarında kapanış tekrarı YOKTUR (her halka ≥ 3 farklı köşe); halkalar[0] dış halka.
 */
export function cbsParcalari(fc, { sorunSiniri = 10 } = {}) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.')
  }
  const parcalar = []
  const sorunlar = []
  let geometrisiz = 0
  let zVarMi = false

  const konumlar = (dizi, tanim) => {
    if (!Array.isArray(dizi)) return []
    const gecerli = dizi.filter(gecerliKonum)
    if (gecerli.length !== dizi.length) sorunlar.push(`${tanim}: ${dizi.length - gecerli.length} geçersiz koordinat atlandı.`)
    return gecerli
  }
  const halka = (dizi, tanim) => {
    let k = konumlar(dizi, tanim)
    if (k.length >= 2) {
      const [a, b] = [k[0], k[k.length - 1]]
      if (a[0] === b[0] && a[1] === b[1] && (a[2] ?? 0) === (b[2] ?? 0)) k = k.slice(0, -1)
    }
    if (k.length < 3) {
      sorunlar.push(`${tanim}: halka en az 3 farklı nokta içermiyor, atlandı.`)
      return null
    }
    return k
  }

  fc.features.forEach((f, objeIndeks) => {
    if (!f || typeof f !== 'object') return
    if (f.geometry === null || f.geometry === undefined) {
      geometrisiz++
      return
    }
    const ozellikler = f.properties && typeof f.properties === 'object' ? f.properties : {}
    const ekle = (p) => {
      parcalar.push({ objeIndeks, ozellikler, ...p })
      const tum = p.konum ? [p.konum] : p.konumlar ?? p.halkalar.flat()
      if (!zVarMi && tum.some(zVar)) zVarMi = true
    }
    const nokta = (k, tanim) => {
      if (gecerliKonum(k)) ekle({ tip: 'nokta', konum: k })
      else sorunlar.push(`${tanim}: nokta koordinatı geçersiz veya boş, atlandı.`)
    }
    const cizgi = (dizi, tanim) => {
      const k = konumlar(dizi, tanim)
      if (k.length >= 2) ekle({ tip: 'cizgi', konumlar: k })
      else sorunlar.push(`${tanim}: çizgi en az 2 geçerli nokta içermiyor, atlandı.`)
    }
    const poligon = (dizi, tanim) => {
      if (!Array.isArray(dizi) || dizi.length === 0) {
        sorunlar.push(`${tanim}: boş poligon, atlandı.`)
        return
      }
      const dis = halka(dizi[0], `${tanim} dış halka`)
      if (!dis) return
      const delikler = dizi.slice(1).map((h, i) => halka(h, `${tanim} ${i + 1}. delik`)).filter(Boolean)
      ekle({ tip: 'poligon', halkalar: [dis, ...delikler] })
    }
    const coklu = (dizi, tanim, fn) => {
      if (!Array.isArray(dizi) || dizi.length === 0) {
        sorunlar.push(`${tanim}: boş çoklu geometri, atlandı.`)
        return
      }
      dizi.forEach((p, i) => fn(p, `${tanim} ${i + 1}. parça`))
    }
    const yaz = (g, tanim, derinlik) => {
      if (!g || typeof g !== 'object' || typeof g.type !== 'string') {
        sorunlar.push(`${tanim}: geometri tanımsız, atlandı.`)
        return
      }
      switch (g.type) {
        case 'Point': return nokta(g.coordinates, tanim)
        case 'LineString': return cizgi(g.coordinates, tanim)
        case 'Polygon': return poligon(g.coordinates, tanim)
        case 'MultiPoint': return coklu(g.coordinates, tanim, nokta)
        case 'MultiLineString': return coklu(g.coordinates, tanim, cizgi)
        case 'MultiPolygon': return coklu(g.coordinates, tanim, poligon)
        case 'GeometryCollection':
          if (derinlik > 32) {
            sorunlar.push(`${tanim}: iç içe geometri koleksiyonu çok derin, atlandı.`)
            return
          }
          return coklu(g.geometries, tanim, (alt, t) => yaz(alt, t, derinlik + 1))
        default:
          sorunlar.push(`${tanim}: "${g.type}" geometri tipi desteklenmiyor, atlandı.`)
      }
    }
    yaz(f.geometry, `Obje ${objeIndeks + 1}`, 0)
  })

  const uyarilar = []
  if (geometrisiz) uyarilar.push(`${geometrisiz} obje geometrisiz olduğu için yazılmadı.`)
  uyarilar.push(...sorunlar.slice(0, sorunSiniri))
  if (sorunlar.length > sorunSiniri) uyarilar.push(`… ve ${sorunlar.length - sorunSiniri} benzer uyarı daha.`)
  return { parcalar, uyarilar, zVarMi }
}

/**
 * Katman değerlerini tamsayı seviye/level numaralarına eşler.
 * - Değer [min, maks] aralığında bir tamsayıysa (ör. "5", 5) olduğu gibi kullanılır.
 * - Diğer adlar ilk görülme sırasıyla, sayısal olarak kullanılmayan en küçük numaralara atanır.
 * - Numara biterse ad `maks`'a düşer (uyarı verilir).
 * @returns {{ numara: (ad: string) => number, eslemeler: Array<[string, number]>, tasan: number }}
 */
export function katmanNumaralari(adlar, { min = 1, maks = 63 } = {}) {
  const sonuc = new Map()
  const kullanilan = new Set()
  const tamsayi = (ad) => {
    const m = /^\s*(\d+)\s*$/.exec(String(ad))
    const n = m ? Number(m[1]) : NaN
    return Number.isInteger(n) && n >= min && n <= maks ? n : null
  }
  for (const ad of adlar) {
    const n = tamsayi(ad)
    if (n !== null) {
      sonuc.set(String(ad), n)
      kullanilan.add(n)
    }
  }
  let siradaki = min
  let tasan = 0
  const eslemeler = []
  for (const ad of adlar) {
    const anahtar = String(ad)
    if (sonuc.has(anahtar)) continue
    while (siradaki <= maks && kullanilan.has(siradaki)) siradaki++
    let n
    if (siradaki <= maks) {
      n = siradaki
      kullanilan.add(n)
    } else {
      n = maks
      tasan++
    }
    sonuc.set(anahtar, n)
    eslemeler.push([anahtar, n])
  }
  return { numara: (ad) => sonuc.get(String(ad)) ?? min, eslemeler, tasan }
}

/** Eşleme uyarı metni (ilk 8 örnek). */
export function eslemeUyarisi(eslemeler, birim) {
  if (!eslemeler.length) return null
  const ornek = eslemeler.slice(0, 8).map(([a, n]) => `"${a}" → ${n}`).join(', ')
  return `${eslemeler.length} katman adı sayısal ${birim} numarasına eşlendi: ${ornek}${eslemeler.length > 8 ? ', …' : ''}.`
}

/** Tarih/zaman: secenekler.zaman (Date | ISO metni) ya da şimdi; testlerde kararlılık için verilebilir. */
export function zamanAl(zaman) {
  const t = zaman instanceof Date ? zaman : zaman ? new Date(zaman) : new Date()
  return Number.isNaN(t.getTime()) ? new Date(0) : t
}

// ---------------------------------------------------------------- ISO 10303-21 biçimleme

/** STEP/IFC REAL: nokta ondalıklı, tam hassasiyet; çok uzun gösterimlerde üstel (E) biçim. */
export function p21Sayi(sayi) {
  const duz = dxfSayi(sayi)
  if (duz.length <= 28) return duz
  const [m, e] = sayi.toExponential().split('e')
  return `${m.includes('.') ? m : `${m}.`}E${e.replace('+', '')}`
}

/** ISO 10303-21 dize kaçışı; tırnaklar dahil döner. */
export function p21Dize(metin) {
  let sonuc = ''
  let blok = '' // \X2\ içinde biriken UTF-16 onaltılıkları
  let blok4 = ''
  const kapat = () => {
    if (blok) sonuc += `\\X2\\${blok}\\X0\\`
    if (blok4) sonuc += `\\X4\\${blok4}\\X0\\`
    blok = ''
    blok4 = ''
  }
  for (const karakter of String(metin)) {
    const kod = karakter.codePointAt(0)
    if (kod >= 0x20 && kod <= 0x7e) {
      kapat()
      sonuc += karakter === "'" ? "''" : karakter === '\\' ? '\\\\' : karakter
    } else if (kod <= 0xffff) {
      if (blok4) kapat()
      blok += kod.toString(16).toUpperCase().padStart(4, '0')
    } else {
      if (blok) kapat()
      blok4 += kod.toString(16).toUpperCase().padStart(8, '0')
    }
  }
  kapat()
  return `'${sonuc}'`
}

/** Part 21 varlık listesi oluşturucu: `ekle('CARTESIAN_POINT', "'',(…)")` → '#n'. */
export class P21Veri {
  constructor() {
    this.satirlar = []
  }

  ekle(govde) {
    const no = this.satirlar.length + 1
    this.satirlar.push(`#${no}=${govde};`)
    return `#${no}`
  }
}

export const p21Liste = (ogeler) => `(${ogeler.join(',')})`
export const p21Nokta = (k) => p21Liste([p21Sayi(k[0]), p21Sayi(k[1]), p21Sayi(zVar(k) ? k[2] : 0)])

/** Part 21 dosyası: başlık + DATA. */
export function p21Dosya({ aciklama, dosyaAdi, zaman, sema, veri, satirSonu = '\n' }) {
  const zamanMetni = zaman.toISOString().slice(0, 19)
  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${aciklama.map(p21Dize).join(',')}),'2;1');`,
    `FILE_NAME(${p21Dize(dosyaAdi)},${p21Dize(zamanMetni)},(''),(''),'GeoConverterProEA','GeoConverterProEA','');`,
    `FILE_SCHEMA((${p21Dize(sema)}));`,
    'ENDSEC;',
    'DATA;',
    ...veri.satirlar,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join(satirSonu)
}

// =============================================================== STEP AP214

function birimBaglami(v) {
  const uzunluk = v.ekle('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.))')
  const aci = v.ekle('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))')
  const kati = v.ekle('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())')
  const belirsizlik = v.ekle(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${uzunluk},'distance_accuracy_value','confusion accuracy')`,
  )
  return v.ekle(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${belirsizlik}))` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((${uzunluk},${aci},${kati}))` +
      `REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`,
  )
}

/** Ürün zinciri: PRODUCT → FORMATION → DEFINITION → SHAPE → SHAPE_DEFINITION_REPRESENTATION. */
function urunZinciri(v, baglamlar, id, ad, temsil) {
  const urun = v.ekle(`PRODUCT(${p21Dize(id)},${p21Dize(ad)},'',(${baglamlar.urun}))`)
  v.ekle(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${urun}))`)
  const formasyon = v.ekle(`PRODUCT_DEFINITION_FORMATION('','',${urun})`)
  const tanim = v.ekle(`PRODUCT_DEFINITION('design','',${formasyon},${baglamlar.tanim})`)
  const sekil = v.ekle(`PRODUCT_DEFINITION_SHAPE('','',${tanim})`)
  v.ekle(`SHAPE_DEFINITION_REPRESENTATION(${sekil},${temsil})`)
  return tanim
}

function eksenYerlesimi(v) {
  const o = v.ekle("CARTESIAN_POINT('',(0.0,0.0,0.0))")
  const z = v.ekle("DIRECTION('',(0.0,0.0,1.0))")
  const x = v.ekle("DIRECTION('',(1.0,0.0,0.0))")
  return v.ekle(`AXIS2_PLACEMENT_3D('',${o},${z},${x})`)
}

/** Bir objenin tel kafes öğeleri (noktalar + polyline'lar). */
function telKafesOgeleri(v, parcalar) {
  const ogeler = []
  const polyline = (konumlar, kapali) => {
    const noktalar = konumlar.map((k) => v.ekle(`CARTESIAN_POINT('',${p21Nokta(k)})`))
    if (kapali) noktalar.push(noktalar[0])
    return v.ekle(`POLYLINE('',${p21Liste(noktalar)})`)
  }
  for (const p of parcalar) {
    if (p.tip === 'nokta') ogeler.push(v.ekle(`CARTESIAN_POINT('',${p21Nokta(p.konum)})`))
    else if (p.tip === 'cizgi') ogeler.push(polyline(p.konumlar, false))
    else for (const h of p.halkalar) ogeler.push(polyline(h, true))
  }
  return ogeler
}

const fark = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const capraz = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const birim = (a) => {
  const u = Math.hypot(a[0], a[1], a[2])
  return u === 0 ? null : [a[0] / u, a[1] / u, a[2] / u]
}

/** Ağ parçalarından üçgen yüzleri (FACE_SURFACE + PLANE + POLY_LOOP). */
function yuzeyOgeleri(v, yuzeyParcalari) {
  const yuzler = []
  for (const p of yuzeyParcalari) {
    const k = (i) => [p.konumlar[i * 3], p.konumlar[i * 3 + 1], p.konumlar[i * 3 + 2]]
    const noktaNo = new Map()
    const nokta = (i) => {
      if (!noktaNo.has(i)) noktaNo.set(i, v.ekle(`CARTESIAN_POINT('',${p21Nokta(k(i))})`))
      return noktaNo.get(i)
    }
    for (let t = 0; t < p.indeksler.length; t += 3) {
      const [a, b, c] = [p.indeksler[t], p.indeksler[t + 1], p.indeksler[t + 2]]
      const kenar = fark(k(b), k(a))
      const normal = birim(capraz(kenar, fark(k(c), k(a))))
      const xYonu = birim(kenar)
      if (!normal || !xYonu) continue
      const yz = v.ekle(`DIRECTION('',${p21Liste(normal.map(p21Sayi))})`)
      const yx = v.ekle(`DIRECTION('',${p21Liste(xYonu.map(p21Sayi))})`)
      const yer = v.ekle(`AXIS2_PLACEMENT_3D('',${nokta(a)},${yz},${yx})`)
      const duzlem = v.ekle(`PLANE('',${yer})`)
      const dongu = v.ekle(`POLY_LOOP('',(${nokta(a)},${nokta(b)},${nokta(c)}))`)
      const sinir = v.ekle(`FACE_OUTER_BOUND('',${dongu},.T.)`)
      yuzler.push(v.ekle(`FACE_SURFACE('',(${sinir}),${duzlem},.T.)`))
    }
  }
  return yuzler
}

/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler]
 * @param {string} [secenekler.crs] hedef EPSG kodu
 * @param {boolean} [secenekler.yuzeyler] true ise poligonlar ayrıca üçgen yüzey olarak yazılır
 * @param {string} [secenekler.dosyaAdi] FILE_NAME içindeki ad (varsayılan "cikti.stp")
 * @param {Date|string} [secenekler.zaman] FILE_NAME zaman damgası (varsayılan: şimdi)
 * @returns {Promise<{veri: string, onizleme: string, uyarilar: string[]}>}
 */
export async function stepYaz(fc, secenekler = {}) {
  const ayarlar = secenekler || {}
  const { parcalar, uyarilar } = cbsParcalari(fc)
  if (cografiMi(ayarlar.crs)) {
    uyarilar.push('Koordinatlar coğrafi (derece) ancak STEP uzunluk birimi metredir; CAD yazılımında ölçüler anlamsız olur. Projeksiyonlu bir koordinat sistemi (ör. ITRF96 / 3° TM) seçin.')
  }

  // Obje bazında grupla (sıra korunur)
  const objeler = new Map()
  for (const p of parcalar) {
    if (!objeler.has(p.objeIndeks)) objeler.set(p.objeIndeks, [])
    objeler.get(p.objeIndeks).push(p)
  }

  // İsteğe bağlı yüzeyler: aynı objenin poligonlarını ortak ağ modülüyle üçgenle (mutlak koordinat)
  const yuzeyler = new Map()
  if (ayarlar.yuzeyler === true) {
    const poligonFc = {
      type: 'FeatureCollection',
      features: fc.features.map((f, i) => {
        const pol = (objeler.get(i) || []).filter((p) => p.tip === 'poligon').map((p) => p.halkalar)
        return { type: 'Feature', properties: {}, geometry: pol.length ? { type: 'MultiPolygon', coordinates: pol } : null }
      }),
    }
    const ag = agOlustur(poligonFc, { merkezle: false })
    for (const p of ag.parcalar) {
      if (p.tip !== 'yuzey') continue
      if (!yuzeyler.has(p.objeIndeks)) yuzeyler.set(p.objeIndeks, [])
      yuzeyler.get(p.objeIndeks).push(p)
    }
  }

  const v = new P21Veri()
  const uygulama = v.ekle("APPLICATION_CONTEXT('core data for automotive mechanical design processes')")
  v.ekle(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${uygulama})`)
  const baglamlar = {
    urun: v.ekle(`PRODUCT_CONTEXT('',${uygulama},'mechanical')`),
    tanim: v.ekle(`PRODUCT_DEFINITION_CONTEXT('part definition',${uygulama},'design')`),
  }
  const temsilBaglami = birimBaglami(v)

  const kokEksen = eksenYerlesimi(v)
  const kokTemsil = v.ekle(`SHAPE_REPRESENTATION('GeoConverter',(${kokEksen}),${temsilBaglami})`)
  const kokTanim = urunZinciri(v, baglamlar, 'GeoConverter', 'GeoConverter', kokTemsil)

  let yuzeySayisi = 0
  for (const [objeIndeks, objeParcalari] of objeler) {
    const ozellikler = objeParcalari[0].ozellikler
    const ad = objeAdi(ozellikler, objeIndeks)
    const eksen = eksenYerlesimi(v)
    const temsil = v.ekle(`SHAPE_REPRESENTATION(${p21Dize(ad)},(${eksen}),${temsilBaglami})`)

    const telKafes = telKafesOgeleri(v, objeParcalari)
    const kume = v.ekle(`GEOMETRIC_CURVE_SET('',${p21Liste(telKafes)})`)
    const gbwsr = v.ekle(`GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION(${p21Dize(ad)},(${kume},${eksen}),${temsilBaglami})`)
    v.ekle(`SHAPE_REPRESENTATION_RELATIONSHIP('','',${temsil},${gbwsr})`)

    const yuzler = yuzeyOgeleri(v, yuzeyler.get(objeIndeks) || [])
    if (yuzler.length) {
      const kabuk = v.ekle(`OPEN_SHELL('',${p21Liste(yuzler)})`)
      const model = v.ekle(`SHELL_BASED_SURFACE_MODEL('',(${kabuk}))`)
      const mssr = v.ekle(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION(${p21Dize(ad)},(${model},${eksen}),${temsilBaglami})`)
      v.ekle(`SHAPE_REPRESENTATION_RELATIONSHIP('','',${temsil},${mssr})`)
      yuzeySayisi += yuzler.length
    }

    const tanim = urunZinciri(v, baglamlar, `OBJE-${objeIndeks + 1}`, ad, temsil)
    // Montaj bağı: kök ürün ⟵ obje (birim dönüşüm)
    const kullanim = v.ekle(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${p21Dize(`NAUO${objeIndeks + 1}`)},${p21Dize(ad)},'',${kokTanim},${tanim},$)`)
    const kullanimSekli = v.ekle(`PRODUCT_DEFINITION_SHAPE('','',${kullanim})`)
    const donusum = v.ekle(`ITEM_DEFINED_TRANSFORMATION('','',${kokEksen},${eksen})`)
    const iliski = v.ekle(
      `(REPRESENTATION_RELATIONSHIP('','',${temsil},${kokTemsil})` +
        `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(${donusum})SHAPE_REPRESENTATION_RELATIONSHIP())`,
    )
    v.ekle(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(${iliski},${kullanimSekli})`)
  }

  if (ayarlar.yuzeyler === true && yuzeySayisi === 0 && objeler.size) {
    uyarilar.push('Yüzey istendi ancak üçgenlenecek geçerli poligon bulunamadı.')
  }

  const metin = p21Dosya({
    aciklama: ['GeoConverterProEA CBS tel kafes aktarimi'],
    dosyaAdi: ayarlar.dosyaAdi || 'cikti.stp',
    zaman: zamanAl(ayarlar.zaman),
    sema: 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }',
    veri: v,
  })
  return { veri: metin, onizleme: metin, uyarilar }
}
