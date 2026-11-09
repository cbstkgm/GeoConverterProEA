// LandXML 1.2 (.xml) yazıcısı.
//
// Eşleme:
//  - Point / MultiPoint          → CgPoints/CgPoint ("N E [Z]" — LandXML'de KUZEY ÖNCE gelir)
//  - Polygon / MultiPolygon      → Parcels/Parcel: Center (iç nokta) + CoordGeom/Line kenarları,
//                                  area (düzlem alanı, delikler düşülmüş), Feature/Property öznitelikleri.
//                                  Ad: TKGM ada/parsel özniteliklerinden "ada/parsel" (gml.js adaParselAdi),
//                                  yoksa name/ad/adi, yoksa "Parsel-N".
//  - LineString / MultiLineString → PlanFeatures/PlanFeature: CoordGeom/Line + Feature/Property.
//  - GeometryCollection          → parçalarına ayrılır, her parça kendi tipine göre yazılır.
// LandXML parsel modelinde delik kavramı yoktur: delikler ve çok parçalı poligonun ek parçaları aynı
// Parcel içinde ayrı CoordGeom öğeleri (name="parca-N" / "parca-N-delik-M") olarak yazılır ve uyarılır.
// Birimler Metric (metre, metrekare); LandXML projeksiyonlu koordinat bekler — coğrafi CRS'te uyarılır.
// Null geometrili objelerin LandXML'de karşılığı yoktur: yazılmaz ve uyarılır.

import { KOORDINAT_SISTEMLERI } from '../katalog.js'
import { adaParselAdi } from '../gml.js'
import { xmlKacis } from '../yazicilar.js'
import { poligonIcNoktasi } from './dxf.js'
import { parcalaraAc } from './geopackage.js'
import { onizlemeKisalt, sridCoz } from './wkb.js'

const LANDXML_NS = 'http://www.landxml.org/schema/LandXML-1.2'
const COGRAFI = new Set([4326])
const AD_ALANLARI = ['name', 'ad', 'adi', 'isim', 'NAME', 'Ad', 'AD']
const NOKTA_AD_ALANLARI = ['nokta_no', 'noktaNo', 'no', 'name', 'ad', 'adi', 'NAME', 'AD']
const KOD_ALANLARI = ['code', 'kod', 'KOD', 'CODE']
const ACIKLAMA_ALANLARI = ['desc', 'aciklama', 'açıklama', 'ACIKLAMA', 'DESC']

const ilkDeger = (p, alanlar) => {
  for (const a of alanlar) {
    const v = p?.[a]
    if (v != null && String(v).trim() !== '') return String(v)
  }
  return null
}

const degerMetni = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))

/** Düzlem alanı (işaretli, y-yukarı eksende saat yönünün tersi pozitif). */
function isaretliAlan(h) {
  let a = 0
  const [ox, oy] = h[0]
  for (let i = 0; i + 1 < h.length; i++) a += (h[i][0] - ox) * (h[i + 1][1] - oy) - (h[i + 1][0] - ox) * (h[i][1] - oy)
  return a / 2
}

/**
 * GeoJSON FeatureCollection'ı LandXML 1.2 belgesine yazar.
 * @param {object} fc FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler] crs ('EPSG:xxxx'), ondalik (varsayılan: projeksiyonlu 4, coğrafi 9)
 * @returns {Promise<{ veri: string, onizleme: string, uyarilar: string[] }>}
 */
export async function landxmlYaz(fc, secenekler = {}) {
  const ayar = secenekler || {}
  const uyarilar = []
  const uyar = (m) => {
    if (!uyarilar.includes(m)) uyarilar.push(m)
  }
  const objeler = Array.isArray(fc?.features) ? fc.features : []
  const srid = sridCoz(ayar.crs)
  const cografi = srid == null || COGRAFI.has(srid)
  if (srid == null) uyar('Koordinat sistemi belirtilmedi; CoordinateSystem öğesi yazılmadı.')
  else if (cografi) uyar(`EPSG:${srid} coğrafi bir koordinat sistemi; LandXML projeksiyonlu (metre) koordinat bekler — Parcel alanları derece² cinsinden anlamsızdır. Projeksiyonlu bir CRS (ör. ITRF96 / 3° TM) seçin.`)
  const ondalik = Number.isInteger(ayar.ondalik) ? ayar.ondalik : cografi ? 9 : 4
  const sayi = (v) => {
    const s = Number(v.toFixed(ondalik))
    return Object.is(s, -0) ? '0' : String(s)
  }
  const nokta = (k) => `${sayi(k[1])} ${sayi(k[0])}${k.length > 2 && Number.isFinite(k[2]) ? ` ${sayi(k[2])}` : ''}`

  const cgNoktalar = []
  const parseller = []
  const planObjeler = []
  const noktaAdlari = new Set()
  let geometrisiz = 0
  let delikli = 0
  let cokParcali = 0
  let kayipOznitelik = false

  const satirlar = (halka) => {
    const s = []
    for (let i = 0; i + 1 < halka.length; i++) s.push(`<Line><Start>${nokta(halka[i])}</Start><End>${nokta(halka[i + 1])}</End></Line>`)
    return s.join('')
  }
  const ozellikOgesi = (p) => {
    const girdiler = Object.entries(p || {}).filter(([, v]) => v != null)
    if (!girdiler.length) return ''
    return `<Feature name="oznitelikler">${girdiler.map(([k, v]) => `<Property label="${xmlKacis(k)}" value="${xmlKacis(degerMetni(v))}"/>`).join('')}</Feature>`
  }
  const benzersizNoktaAdi = (ad) => {
    let a = ad
    let n = 2
    while (noktaAdlari.has(a)) a = `${ad}_${n++}`
    noktaAdlari.add(a)
    return a
  }

  objeler.forEach((f, i) => {
    const p = f?.properties || {}
    const parcalar = f?.geometry ? parcalaraAc(f.geometry) : []
    if (!parcalar.length) {
      geometrisiz++
      return
    }
    const noktalar = []
    const cizgiler = []
    const poligonlar = []
    for (const g of parcalar) {
      if (g.type === 'Point') noktalar.push(g.coordinates)
      else if (g.type === 'MultiPoint') noktalar.push(...g.coordinates)
      else if (g.type === 'LineString') cizgiler.push(g.coordinates)
      else if (g.type === 'MultiLineString') cizgiler.push(...g.coordinates)
      else if (g.type === 'Polygon') poligonlar.push(g.coordinates)
      else if (g.type === 'MultiPolygon') poligonlar.push(...g.coordinates)
      else uyar(`${i + 1}. objede desteklenmeyen geometri tipi "${g.type}" atlandı.`)
    }

    // Noktalar
    if (noktalar.length) {
      const temel = ilkDeger(p, NOKTA_AD_ALANLARI) ?? `N${i + 1}`
      const kod = ilkDeger(p, KOD_ALANLARI)
      const aciklama = ilkDeger(p, ACIKLAMA_ALANLARI)
      const kullanilan = new Set([...NOKTA_AD_ALANLARI, ...KOD_ALANLARI, ...ACIKLAMA_ALANLARI])
      if (Object.keys(p).some((k) => !kullanilan.has(k) && p[k] != null)) kayipOznitelik = true
      noktalar.forEach((k, j) => {
        const ad = benzersizNoktaAdi(noktalar.length > 1 ? `${temel}-${j + 1}` : temel)
        const nitelikler = [`name="${xmlKacis(ad)}"`]
        if (kod) nitelikler.push(`code="${xmlKacis(kod)}"`)
        if (aciklama) nitelikler.push(`desc="${xmlKacis(aciklama)}"`)
        cgNoktalar.push(`    <CgPoint ${nitelikler.join(' ')}>${nokta(k)}</CgPoint>`)
      })
    }

    // Çizgiler
    if (cizgiler.length) {
      const ad = ilkDeger(p, AD_ALANLARI) ?? `Cizgi-${i + 1}`
      const geom = cizgiler
        .filter((c) => c.length >= 2)
        .map((c, j) => `<CoordGeom${cizgiler.length > 1 ? ` name="parca-${j + 1}"` : ''}>${satirlar(c)}</CoordGeom>`)
        .join('')
      planObjeler.push(`    <PlanFeature name="${xmlKacis(ad)}">${geom}${ozellikOgesi(p)}</PlanFeature>`)
    }

    // Poligonlar
    if (poligonlar.length) {
      const gecerli = poligonlar.filter((pl) => Array.isArray(pl[0]) && pl[0].length >= 4)
      if (!gecerli.length) return
      if (gecerli.length > 1) cokParcali++
      if (gecerli.some((pl) => pl.length > 1)) delikli++
      let alan = 0
      let enBuyuk = gecerli[0]
      let enBuyukAlan = -1
      const geomlar = []
      gecerli.forEach((pl, j) => {
        const dis = Math.abs(isaretliAlan(pl[0]))
        const delikAlani = pl.slice(1).reduce((t, h) => t + (h.length >= 4 ? Math.abs(isaretliAlan(h)) : 0), 0)
        alan += dis - delikAlani
        if (dis > enBuyukAlan) {
          enBuyukAlan = dis
          enBuyuk = pl
        }
        const parcaAdi = gecerli.length > 1 ? `parca-${j + 1}` : null
        geomlar.push(`<CoordGeom${parcaAdi ? ` name="${parcaAdi}"` : ''}>${satirlar(pl[0])}</CoordGeom>`)
        pl.slice(1).forEach((h, m) => {
          if (h.length < 4) return
          geomlar.push(`<CoordGeom name="${parcaAdi ? `${parcaAdi}-` : ''}delik-${m + 1}" desc="delik">${satirlar(h)}</CoordGeom>`)
        })
      })
      const ad = adaParselAdi(p) ?? ilkDeger(p, AD_ALANLARI) ?? `Parsel-${i + 1}`
      const merkez = poligonIcNoktasi(enBuyuk[0], enBuyuk.slice(1))
      const aciklama = ilkDeger(p, ACIKLAMA_ALANLARI)
      parseller.push(
        `    <Parcel name="${xmlKacis(ad)}" area="${sayi(alan)}"${aciklama ? ` desc="${xmlKacis(aciklama)}"` : ''}>` +
          `${merkez ? `<Center>${nokta(merkez)}</Center>` : ''}${geomlar.join('')}${ozellikOgesi(p)}</Parcel>`,
      )
    }
  })

  if (geometrisiz) uyar(`Geometrisi olmayan ${geometrisiz} obje LandXML'e yazılmadı (karşılığı yok).`)
  if (delikli) uyar(`${delikli} delikli poligon: LandXML Parcel modelinde delik yoktur; delikler aynı Parcel içinde ayrı CoordGeom (name="delik-N") olarak yazıldı.`)
  if (cokParcali) uyar(`${cokParcali} çok parçalı poligon: parçalar aynı Parcel içinde ayrı CoordGeom (name="parca-N") olarak yazıldı.`)
  if (kayipOznitelik) uyar('CgPoint yalnızca ad, kod ve açıklama taşıyabilir; noktaların diğer öznitelikleri LandXML\'e yazılmadı.')

  const simdi = new Date()
  const tarih = simdi.toISOString().slice(0, 10)
  const saat = simdi.toISOString().slice(11, 19)
  const crsAdi = srid != null ? (KOORDINAT_SISTEMLERI.find((s) => s.kod === `EPSG:${srid}`)?.ad ?? `EPSG:${srid}`) : null
  const govde = [
    "<?xml version='1.0' encoding='UTF-8'?>",
    `<LandXML xmlns="${LANDXML_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${LANDXML_NS} ${LANDXML_NS}/LandXML-1.2.xsd" version="1.2" date="${tarih}" time="${saat}" readOnly="false" language="Turkish">`,
    '  <Units>',
    '    <Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars" angularUnit="decimal degrees" directionUnit="decimal degrees"/>',
    '  </Units>',
  ]
  if (srid != null) govde.push(`  <CoordinateSystem name="${xmlKacis(crsAdi)}" epsgCode="${srid}"/>`)
  govde.push('  <Application name="GeoConverterProEA" manufacturer="GeoConverterProEA" version="1.0"/>')
  if (cgNoktalar.length) govde.push('  <CgPoints name="noktalar">', ...cgNoktalar, '  </CgPoints>')
  if (parseller.length) govde.push('  <Parcels name="parseller">', ...parseller, '  </Parcels>')
  if (planObjeler.length) govde.push('  <PlanFeatures name="cizgiler">', ...planObjeler, '  </PlanFeatures>')
  govde.push('</LandXML>')
  const veri = `${govde.join('\n')}\n`
  return { veri, onizleme: onizlemeKisalt(govde), uyarilar }
}
