/**
 * IFC yazıcısı: GeoJSON FeatureCollection → IFC4 (ISO 16739-1:2018) STEP Part 21 metni.
 *
 * Hiyerarşi:
 *   IfcProject ─(IfcRelAggregates)→ IfcSite ─(IfcRelContainedInSpatialStructure)→ IfcGeographicElement×N
 *   Her obje bir IfcGeographicElement'tir (CBS objesi; PredefinedType USERDEFINED, ObjectType = katman).
 *   Öznitelikler: IfcPropertySet "CBS_Oznitelikler" + IfcPropertySingleValue; değer tipi korunur
 *   (metin IfcLabel, tamsayı IfcInteger, ondalık IfcReal, mantıksal IfcBoolean; nesne JSON IfcLabel).
 *   Katmanlar: IfcPresentationLayerAssignment.
 *
 * Geometri (ortak/ag.js ile): poligonlar IfcTriangulatedFaceSet (delikler dahil, CCW üçgenler; objenin
 *   tüm poligonları tek yüz kümesinde), çizgiler IfcPolyline, noktalar IfcCartesianPoint; çizgi ve
 *   noktalar IfcGeometricCurveSet içinde ayrı bir 'GeometricCurveSet' temsili olarak yazılır.
 *
 * Georeferans: secenekler.crs projeksiyonlu bir CRS ise koordinatlar ağ modülünün merkezine göre
 *   ötelenir (büyük TM değerlerinde görüntüleyicilerin float hassasiyeti için) ve öteleme
 *   IfcMapConversion.Eastings/Northings/OrthogonalHeight'e yazılır; hedef IfcProjectedCRS'in adı EPSG
 *   kodudur (ör. "EPSG:5255"). CRS yoksa ya da coğrafiyse georeferans yazılmaz, koordinatlar mutlak
 *   kalır ve uyarı verilir.
 *
 * GlobalId: 22 karakterlik IFC base64 sıkıştırılmış GUID. Deterministiktir: içerik özetinden (ya da
 *   secenekler.guidTohumu'ndan) ve öğe sırasından 128 bitlik özet üretilir; aynı girdi aynı GUID'leri
 *   verir (sürüm karşılaştırması ve kararlı testler için), farklı veriler farklı GUID'ler alır.
 *
 * Saf JS: DOM yok; worker ve Node'da çalışır.
 */
import { agOlustur } from './ortak/ag.js'
import { KOORDINAT_SISTEMI_TANIMLARI } from '../katalog.js'
import {
  cbsParcalari,
  objeAdi,
  objeKatmani,
  cografiMi,
  zamanAl,
  p21Dize,
  p21Sayi,
  p21Liste,
  p21Dosya,
  P21Veri,
  VARSAYILAN_KATMANLAR,
} from './step.js'

// ---------------------------------------------------------------- GUID
const IFC_GUID_KARAKTERLERI = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'

/** cyrb128: metinden 4×32 bit özet (kriptografik değil; GUID dağılımı için yeterli). */
function ozet128(metin) {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < metin.length; i++) {
    const k = metin.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/** 128 bitlik değeri (UUID v4 bitleri ayarlanmış) IFC'nin 22 karakterlik base64 biçimine sıkıştırır. */
export function ifcGuid(tohum) {
  const [a, b, c, d] = ozet128(String(tohum))
  // UUID sürüm 4 / RFC 4122 varyant bitleri: GUID gerçek bir UUID gibi görünür
  const b2 = ((b & 0xffff0fff) | 0x00004000) >>> 0
  const c2 = ((c & 0x3fffffff) | 0x80000000) >>> 0
  let sayi = (BigInt(a) << 96n) | (BigInt(b2) << 64n) | (BigInt(c2) << 32n) | BigInt(d)
  const karakterler = []
  for (let i = 0; i < 21; i++) {
    karakterler.push(IFC_GUID_KARAKTERLERI[Number(sayi & 63n)])
    sayi >>= 6n
  }
  karakterler.push(IFC_GUID_KARAKTERLERI[Number(sayi & 3n)])
  return karakterler.reverse().join('')
}

// ---------------------------------------------------------------- CRS
function projeksiyonBilgisi(kod) {
  const tanim = KOORDINAT_SISTEMI_TANIMLARI.find((s) => s.kod === kod)
  if (!tanim) return { aciklama: null, datum: null, projeksiyon: null, dilim: null }
  const t = tanim.tanim
  const lon0 = /\+lon_0=(-?[\d.]+)/.exec(t)?.[1]
  const zon = /\+zone=(\d+)/.exec(t)?.[1]
  const datum = /^EPSG:52(5[3-9])$/.test(kod) ? 'ITRF96' : /^EPSG:230\d\d$/.test(kod) ? 'ED50' : /datum=WGS84|a=6378137/.test(t) ? 'WGS84' : null
  let projeksiyon = null
  let dilim = null
  if (/\+proj=utm\b/.test(t)) {
    projeksiyon = 'Universal Transverse Mercator'
    dilim = zon ? `${zon}N` : null
  } else if (/\+proj=tmerc\b/.test(t)) {
    projeksiyon = 'Transverse Mercator'
    dilim = lon0 ? `3 derece TM ${lon0}` : null
  } else if (/\+proj=merc\b/.test(t)) {
    projeksiyon = 'Mercator (Web)'
  }
  return { aciklama: tanim.ad, datum, projeksiyon, dilim }
}

// ---------------------------------------------------------------- Değerler
const opsiyonelDize = (m) => (m === null || m === undefined ? '$' : p21Dize(m))

function ozellikDegeri(deger) {
  if (typeof deger === 'boolean') return `IFCBOOLEAN(${deger ? '.T.' : '.F.'})`
  if (typeof deger === 'number' && Number.isFinite(deger)) {
    return Number.isSafeInteger(deger) ? `IFCINTEGER(${deger})` : `IFCREAL(${p21Sayi(deger)})`
  }
  if (typeof deger === 'object') return `IFCLABEL(${p21Dize(JSON.stringify(deger))})`
  return `IFCLABEL(${p21Dize(String(deger))})`
}

/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler]
 * @param {string} [secenekler.crs] hedef EPSG kodu (IfcProjectedCRS.Name)
 * @param {string} [secenekler.projeAdi] IfcProject adı (varsayılan "GeoConverter")
 * @param {string} [secenekler.guidTohumu] GUID üretim tohumu (varsayılan: içerik özeti)
 * @param {string} [secenekler.dosyaAdi] FILE_NAME (varsayılan "cikti.ifc")
 * @param {Date|string} [secenekler.zaman] FILE_NAME zaman damgası
 * @returns {Promise<{veri: string, onizleme: string, uyarilar: string[]}>}
 */
export async function ifcYaz(fc, secenekler = {}) {
  const ayarlar = secenekler || {}
  const { parcalar, uyarilar } = cbsParcalari(fc)
  const crs = typeof ayarlar.crs === 'string' ? ayarlar.crs.trim().toUpperCase() : null
  const georeferans = Boolean(crs) && !cografiMi(crs)
  if (!crs) {
    uyarilar.push('Koordinat sistemi belirtilmediği için IFC georeferansı (IfcMapConversion) yazılmadı; koordinatlar mutlak değerleriyle yazıldı.')
  } else if (!georeferans) {
    uyarilar.push('Koordinatlar coğrafi (derece); IFC metre tabanlı yerel koordinat bekler. Georeferans yazılmadı, ölçüler anlamsız olur. Projeksiyonlu bir koordinat sistemi seçin.')
  }

  // Doğrulanmış parçalardan temiz FC → ortak ağ (üçgenleme + merkez ötelemesi)
  const objeParcalari = new Map()
  for (const p of parcalar) {
    if (!objeParcalari.has(p.objeIndeks)) objeParcalari.set(p.objeIndeks, [])
    objeParcalari.get(p.objeIndeks).push(p)
  }
  const temizFc = {
    type: 'FeatureCollection',
    features: fc.features.map((_, i) => {
      const liste = objeParcalari.get(i)
      if (!liste) return { type: 'Feature', properties: {}, geometry: null }
      const geometriler = liste.map((p) =>
        p.tip === 'nokta' ? { type: 'Point', coordinates: p.konum }
          : p.tip === 'cizgi' ? { type: 'LineString', coordinates: p.konumlar }
            : { type: 'Polygon', coordinates: p.halkalar })
      return { type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: geometriler } }
    }),
  }
  const ag = agOlustur(temizFc, { merkezle: georeferans })
  uyarilar.push(...ag.uyarilar.filter((u) => u.includes('alansız')))
  const agParcalari = new Map()
  for (const p of ag.parcalar) {
    if (!agParcalari.has(p.objeIndeks)) agParcalari.set(p.objeIndeks, [])
    agParcalari.get(p.objeIndeks).push(p)
  }

  // GUID üretici
  const tohum = ayarlar.guidTohumu ?? ozet128(JSON.stringify(fc)).map((h) => h.toString(16)).join('')
  const kullanilanGuidler = new Set()
  let guidSayaci = 0
  const guid = () => {
    let g
    do g = ifcGuid(`${tohum}|${guidSayaci++}`)
    while (kullanilanGuidler.has(g))
    kullanilanGuidler.add(g)
    return p21Dize(g)
  }

  const v = new P21Veri()
  const metre = v.ekle('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')
  const alan = v.ekle('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)')
  const hacim = v.ekle('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)')
  const aci = v.ekle('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)')
  const birimler = v.ekle(`IFCUNITASSIGNMENT((${metre},${alan},${hacim},${aci}))`)
  const koken = v.ekle('IFCCARTESIANPOINT((0.0,0.0,0.0))')
  const zEkseni = v.ekle('IFCDIRECTION((0.0,0.0,1.0))')
  const xEkseni = v.ekle('IFCDIRECTION((1.0,0.0,0.0))')
  const yerlesim = v.ekle(`IFCAXIS2PLACEMENT3D(${koken},${zEkseni},${xEkseni})`)
  const kuzey = v.ekle('IFCDIRECTION((0.0,1.0))')
  const baglam = v.ekle(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${yerlesim},${kuzey})`)
  const govdeBaglami = v.ekle(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${baglam},$,.MODEL_VIEW.,$)`)
  const proje = v.ekle(`IFCPROJECT(${guid()},$,${p21Dize(ayarlar.projeAdi || 'GeoConverter')},$,$,$,$,(${baglam}),${birimler})`)

  if (georeferans) {
    const b = projeksiyonBilgisi(crs)
    const hedef = v.ekle(
      `IFCPROJECTEDCRS(${p21Dize(crs)},${opsiyonelDize(b.aciklama)},${opsiyonelDize(b.datum)},$,${opsiyonelDize(b.projeksiyon)},${opsiyonelDize(b.dilim)},${metre})`,
    )
    const [e, n, h] = ag.merkez
    v.ekle(`IFCMAPCONVERSION(${baglam},${hedef},${p21Sayi(e)},${p21Sayi(n)},${p21Sayi(h)},1.0,0.0,1.0)`)
  }

  const sahaYeri = v.ekle(`IFCLOCALPLACEMENT($,${yerlesim})`)
  const saha = v.ekle(`IFCSITE(${guid()},$,'Site',$,$,${sahaYeri},$,$,.ELEMENT.,$,$,$,$,$)`)
  v.ekle(`IFCRELAGGREGATES(${guid()},$,$,$,${proje},(${saha}))`)

  const elemanlar = []
  const katmanTemsilleri = new Map()
  for (const [objeIndeks, liste] of agParcalari) {
    // Ağ parçaları temiz FC'den gelir (özniteliksiz); öznitelikler doğrulanmış özgün parçalardan alınır
    const ozellikler = objeParcalari.get(objeIndeks)[0].ozellikler
    const ad = objeAdi(ozellikler, objeIndeks)
    const hamKatman = objeKatmani(ozellikler)
    const ilkTip = liste[0].tip === 'yuzey' ? 'poligon' : liste[0].tip
    const katman = hamKatman === undefined ? VARSAYILAN_KATMANLAR[ilkTip] : String(hamKatman).trim()

    const temsiller = []
    // Yüzeyler → tek IfcTriangulatedFaceSet
    const yuzeyler = liste.filter((p) => p.tip === 'yuzey')
    if (yuzeyler.length) {
      const koordinatlar = []
      const ucgenler = []
      for (const p of yuzeyler) {
        const taban = koordinatlar.length
        for (let i = 0; i < p.konumlar.length; i += 3) {
          koordinatlar.push(p21Liste([p.konumlar[i], p.konumlar[i + 1], p.konumlar[i + 2]].map(p21Sayi)))
        }
        for (let i = 0; i < p.indeksler.length; i += 3) {
          ucgenler.push(`(${taban + p.indeksler[i] + 1},${taban + p.indeksler[i + 1] + 1},${taban + p.indeksler[i + 2] + 1})`)
        }
      }
      const liste3B = v.ekle(`IFCCARTESIANPOINTLIST3D(${p21Liste(koordinatlar)})`)
      const yuzKumesi = v.ekle(`IFCTRIANGULATEDFACESET(${liste3B},$,.F.,${p21Liste(ucgenler)},$)`)
      temsiller.push(v.ekle(`IFCSHAPEREPRESENTATION(${govdeBaglami},'Body','Tessellation',(${yuzKumesi}))`))
    }
    // Çizgi ve noktalar → IfcGeometricCurveSet
    const egriOgeleri = []
    for (const p of liste) {
      if (p.tip === 'nokta') {
        egriOgeleri.push(v.ekle(`IFCCARTESIANPOINT(${p21Liste(p.konumlar.map(p21Sayi))})`))
      } else if (p.tip === 'cizgi') {
        const noktalar = []
        for (let i = 0; i < p.konumlar.length; i += 3) {
          noktalar.push(v.ekle(`IFCCARTESIANPOINT(${p21Liste([p.konumlar[i], p.konumlar[i + 1], p.konumlar[i + 2]].map(p21Sayi))})`))
        }
        egriOgeleri.push(v.ekle(`IFCPOLYLINE(${p21Liste(noktalar)})`))
      }
    }
    if (egriOgeleri.length) {
      const kume = v.ekle(`IFCGEOMETRICCURVESET(${p21Liste(egriOgeleri)})`)
      temsiller.push(v.ekle(`IFCSHAPEREPRESENTATION(${govdeBaglami},'Body','GeometricCurveSet',(${kume}))`))
    }
    if (!katmanTemsilleri.has(katman)) katmanTemsilleri.set(katman, [])
    katmanTemsilleri.get(katman).push(...temsiller)

    const sekil = v.ekle(`IFCPRODUCTDEFINITIONSHAPE($,$,${p21Liste(temsiller)})`)
    const yer = v.ekle(`IFCLOCALPLACEMENT(${sahaYeri},${yerlesim})`)
    const eleman = v.ekle(
      `IFCGEOGRAPHICELEMENT(${guid()},$,${p21Dize(ad)},$,${p21Dize(katman)},${yer},${sekil},${p21Dize(String(objeIndeks + 1))},.USERDEFINED.)`,
    )
    elemanlar.push(eleman)

    const ozellikListesi = Object.entries(ozellikler)
      .filter(([, d]) => d !== null && d !== undefined && !(typeof d === 'number' && !Number.isFinite(d)))
      .map(([k, d]) => v.ekle(`IFCPROPERTYSINGLEVALUE(${p21Dize(k)},$,${ozellikDegeri(d)},$)`))
    if (ozellikListesi.length) {
      const kume = v.ekle(`IFCPROPERTYSET(${guid()},$,'CBS_Oznitelikler',$,${p21Liste(ozellikListesi)})`)
      v.ekle(`IFCRELDEFINESBYPROPERTIES(${guid()},$,$,$,(${eleman}),${kume})`)
    }
  }

  if (elemanlar.length) {
    v.ekle(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid()},$,'Site icerigi',$,${p21Liste(elemanlar)},${saha})`)
  }
  for (const [katman, temsiller] of katmanTemsilleri) {
    v.ekle(`IFCPRESENTATIONLAYERASSIGNMENT(${p21Dize(katman)},$,${p21Liste(temsiller)},$)`)
  }

  const metin = p21Dosya({
    aciklama: ['ViewDefinition [ReferenceView_V1.2]'],
    dosyaAdi: ayarlar.dosyaAdi || 'cikti.ifc',
    zaman: zamanAl(ayarlar.zaman),
    sema: 'IFC4',
    veri: v,
  })
  return { veri: metin, onizleme: metin, uyarilar }
}
