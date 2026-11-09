import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import proj4 from 'proj4'
import shp, { parseShp, parseDbf } from 'shpjs'
import { shapefileYaz, prjMetni, PRJ_METINLERI, alanAdlariniEsle, isaretliAlan } from './shapefile.js'
import { KOORDINAT_SISTEMI_TANIMLARI } from '../katalog.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
// GeoJSON (RFC 7946) yönü: dış halka saat yönünün tersi, delik saat yönü
const kareCCW = (x, y, b, z) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]].map((k) => (z === undefined ? k : [...k, z]))
const kareCW = (x, y, b, z) => kareCCW(x, y, b, z).reverse()

async function zipAc(veri) {
  const zip = await JSZip.loadAsync(veri)
  const dosyalar = {}
  for (const g of Object.values(zip.files)) dosyalar[g.name] = await g.async('uint8array')
  return dosyalar
}
const metin = (b) => new TextDecoder().decode(b)

/** .prj olmadan (yeniden projeksiyon yapmadan) bir katmanı shpjs ile okur. */
function katmanOku(dosyalar, kok) {
  const geo = parseShp(dosyalar[`${kok}.shp`])
  const oz = parseDbf(dosyalar[`${kok}.dbf`], metin(dosyalar[`${kok}.cpg`]))
  return geo.map((g, i) => ({ geometry: g, properties: oz[i] }))
}
const sadeGeo = ({ type, coordinates }) => ({ type, coordinates })

describe('shapefileYaz — gidiş-dönüş (shpjs)', () => {
  it('karışık tipli FC katmanlara ayrılır; geometri ve Türkçe öznitelikler korunur', async () => {
    const delikli = { type: 'Polygon', coordinates: [kareCCW(0, 0, 10), kareCW(2, 2, 3)] }
    const coklu = { type: 'MultiPolygon', coordinates: [[kareCCW(20, 0, 5)], [kareCCW(40, 0, 5), kareCW(41, 1, 2)]] }
    const girdi = fc(
      obje({ type: 'Point', coordinates: [30.5, 39.25] }, { ad: 'Şişli Çarşı', no: 1, oran: 0.125, aktif: true, tarih: '2024-02-29' }),
      obje({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] }, { ad: 'Ğüzergâh İğdır', no: 2 }),
      obje(null, { ad: 'boş' }),
      obje(delikli, { ad: 'Ölçü Ünitesi', no: 3, oran: -12.5, aktif: false }),
      obje({ type: 'Point', coordinates: [31, 40] }, { ad: 'ıİöÖüÜ', no: 4, oran: null, aktif: null }),
      obje(coklu, { ad: 'çoklu', no: 5 }),
      obje({ type: 'MultiLineString', coordinates: [[[0, 0], [5, 5]], [[6, 6], [7, 8]]] }, { ad: 'iki parça', no: 6 }),
    )
    const { veri, uyarilar, onizleme } = await shapefileYaz(girdi, { crs: 'EPSG:5255' })
    const dosyalar = await zipAc(veri)
    expect(Object.keys(dosyalar).sort()).toEqual(
      ['nokta', 'cizgi', 'poligon', 'geometrisiz'].flatMap((t) => ['shp', 'shx', 'dbf', 'cpg', 'prj'].map((u) => `cikti_${t}.${u}`)).sort(),
    )
    expect(uyarilar.some((u) => u.includes('1 geometrisiz obje (1 null) ayrı "cikti_geometrisiz"'))).toBe(true)
    const geometrisiz = katmanOku(dosyalar, 'cikti_geometrisiz')
    expect(geometrisiz).toEqual([{ geometry: null, properties: { ad: 'boş' } }])

    const nokta = katmanOku(dosyalar, 'cikti_nokta')
    expect(nokta.map((o) => o.geometry)).toEqual([
      { type: 'Point', coordinates: [30.5, 39.25] },
      { type: 'Point', coordinates: [31, 40] },
    ])
    expect(nokta[0].properties).toMatchObject({ ad: 'Şişli Çarşı', no: 1, oran: 0.125, aktif: true })
    expect(nokta[0].properties.tarih).toEqual(new Date(2024, 1, 29))
    expect(nokta[1].properties.ad).toBe('ıİöÖüÜ')
    expect(nokta[1].properties.oran).toBeNaN() // boş N alanı
    expect(nokta[1].properties.aktif).toBe(false) // '?' → shpjs false okur

    const cizgi = katmanOku(dosyalar, 'cikti_cizgi')
    expect(cizgi.map((o) => sadeGeo(o.geometry))).toEqual([girdi.features[1].geometry, girdi.features[6].geometry])
    expect(cizgi.map((o) => o.properties.ad)).toEqual(['Ğüzergâh İğdır', 'iki parça'])
    expect(Object.keys(cizgi[0].properties)).toEqual(['ad', 'no']) // katmanda olmayan alan yazılmaz

    const poligon = katmanOku(dosyalar, 'cikti_poligon')
    // shpjs dış halkayı saat yönünde verir (ESRI yönü); karşılaştırma için çevrilmiş beklenti
    expect(sadeGeo(poligon[0].geometry)).toEqual({ type: 'Polygon', coordinates: [kareCW(0, 0, 10), kareCCW(2, 2, 3)] })
    expect(sadeGeo(poligon[1].geometry)).toEqual({
      type: 'MultiPolygon',
      coordinates: [[kareCW(20, 0, 5)], [kareCW(40, 0, 5), kareCCW(41, 1, 2)]],
    })
    expect(poligon.map((o) => o.properties.ad)).toEqual(['Ölçü Ünitesi', 'çoklu'])

    expect(onizleme).toContain('cikti_poligon')
    expect(onizleme).toContain('TUREF_TM33')
    expect(onizleme).toMatch(/ad\s+C\(/)
  })

  it('.prj ile shpjs.parseZip WGS84 boylam/enleme geri dönüştürür (EPSG:5255)', async () => {
    const tm33 = KOORDINAT_SISTEMI_TANIMLARI.find((s) => s.kod === 'EPSG:5255').tanim
    const [x, y] = proj4('EPSG:4326', tm33, [32.85, 39.92])
    const { veri } = await shapefileYaz(fc(obje({ type: 'Point', coordinates: [x, y] }, { ad: 'Ankara' })), { crs: 'EPSG:5255' })
    const geri = await shp(veri)
    expect(geri.features[0].properties.ad).toBe('Ankara')
    expect(geri.features[0].geometry.coordinates[0]).toBeCloseTo(32.85, 7)
    expect(geri.features[0].geometry.coordinates[1]).toBeCloseTo(39.92, 7)
  })

  it('Z değerleri PointZ / PolyLineZ / PolygonZ / MultiPointZ ile korunur', async () => {
    const girdi = fc(
      obje({ type: 'MultiPoint', coordinates: [[1, 2, 10], [3, 4, 20]] }),
      obje({ type: 'Point', coordinates: [5, 6, 30] }),
      obje({ type: 'LineString', coordinates: [[0, 0, 1], [1, 1, 2]] }),
      obje({ type: 'MultiLineString', coordinates: [[[0, 0, 1], [1, 1, 2]], [[2, 2, 3], [3, 3, 4], [4, 4, 5]]] }),
      obje({ type: 'Polygon', coordinates: [kareCW(0, 0, 10, 7), kareCCW(2, 2, 2, 8)] }),
    )
    const { veri, uyarilar } = await shapefileYaz(girdi)
    expect(uyarilar).toContain('Hedef koordinat sistemi belirtilmedi; .prj dosyası yazılmadı.')
    const d = await zipAc(veri)
    expect(d['cikti_nokta.prj']).toBeUndefined()
    const tip = (k) => new DataView(d[`${k}.shp`].buffer).getInt32(32, true)
    expect([tip('cikti_nokta'), tip('cikti_cizgi'), tip('cikti_poligon')]).toEqual([18, 13, 15])

    const n = katmanOku(d, 'cikti_nokta').map((o) => sadeGeo(o.geometry))
    expect(n[0]).toEqual({ type: 'MultiPoint', coordinates: [[1, 2, 10], [3, 4, 20]] })
    const c = katmanOku(d, 'cikti_cizgi').map((o) => sadeGeo(o.geometry))
    expect(c).toEqual([girdi.features[2].geometry, girdi.features[3].geometry])
    const p = katmanOku(d, 'cikti_poligon').map((o) => sadeGeo(o.geometry))
    expect(p[0]).toEqual(girdi.features[4].geometry)
    // Başlıkta Z aralığı
    const dv = new DataView(d['cikti_poligon.shp'].buffer)
    expect([dv.getFloat64(68, true), dv.getFloat64(76, true)]).toEqual([7, 8])
  })

  it('Z eksik konumlar Z katmanında 0 yazılır ve uyarılır', async () => {
    const { veri, uyarilar } = await shapefileYaz(fc(
      obje({ type: 'Point', coordinates: [1, 1, 5] }),
      obje({ type: 'Point', coordinates: [2, 2] }),
    ))
    const d = await zipAc(veri)
    expect(katmanOku(d, 'cikti_nokta').map((o) => o.geometry.coordinates)).toEqual([[1, 1, 5], [2, 2, 0]])
    expect(uyarilar.some((u) => u.includes('1 konumun Z değeri yok'))).toBe(true)
  })
})

describe('shapefileYaz — geometri kuralları', () => {
  it('nokta katmanı: yalnız Point → Point (1); MultiPoint varsa tümü MultiPoint (8)', async () => {
    const tip = async (girdi) => new DataView((await zipAc((await shapefileYaz(girdi)).veri))['cikti_nokta.shp'].buffer).getInt32(32, true)
    expect(await tip(fc(obje({ type: 'Point', coordinates: [1, 2] }), obje({ type: 'Point', coordinates: [3, 4] })))).toBe(1)
    expect(await tip(fc(obje({ type: 'Point', coordinates: [1, 2] }), obje({ type: 'MultiPoint', coordinates: [[3, 4], [5, 6]] })))).toBe(8)
  })

  it('poligon halkaları ESRI yönüne çevrilir (dış saat yönü, delik tersi)', async () => {
    const { veri, uyarilar } = await shapefileYaz(fc(obje({ type: 'Polygon', coordinates: [kareCCW(0, 0, 10), kareCW(2, 2, 3)] })))
    expect(uyarilar.some((u) => u.includes('2 poligon halkasının yönü'))).toBe(true)
    const b = (await zipAc(veri))['cikti_poligon.shp']
    const dv = new DataView(b.buffer)
    // kayıt içeriği 108'de başlar: tip(4) bbox(32) numParts numPoints parts[2] → noktalar 108+52
    const np = dv.getInt32(108 + 36, true)
    const parts = [dv.getInt32(108 + 44, true), dv.getInt32(108 + 48, true)]
    expect(np).toBe(2)
    expect(parts).toEqual([0, 5])
    const halka = (bas, adet) => Array.from({ length: adet }, (_, i) => [
      dv.getFloat64(108 + 52 + 16 * (bas + i), true), dv.getFloat64(108 + 60 + 16 * (bas + i), true),
    ])
    expect(isaretliAlan(halka(0, 5))).toBeLessThan(0) // saat yönü
    expect(isaretliAlan(halka(5, 5))).toBeGreaterThan(0) // saat yönünün tersi
  })

  it('GeometryCollection parçaları uygun katmanlara dağıtılır, öznitelik kopyalanır', async () => {
    const gc = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 1] },
        { type: 'Point', coordinates: [2, 2] },
        { type: 'Polygon', coordinates: [kareCW(0, 0, 4)] },
      ],
    }
    const { veri, uyarilar } = await shapefileYaz(fc(obje(gc, { ad: 'karma' })))
    const d = await zipAc(veri)
    expect(Object.keys(d).some((k) => k.startsWith('cikti_cizgi'))).toBe(false)
    expect(katmanOku(d, 'cikti_nokta')[0]).toMatchObject({
      geometry: { type: 'MultiPoint', coordinates: [[1, 1], [2, 2]] }, properties: { ad: 'karma' },
    })
    expect(katmanOku(d, 'cikti_poligon')[0].properties.ad).toBe('karma')
    expect(uyarilar.some((u) => u.includes('GeometryCollection'))).toBe(true)
  })
})

describe('shapefileYaz — ikili yapı (.shp/.shx)', () => {
  it('ana başlık ve .shx ofsetleri spesifikasyona uyar', async () => {
    const girdi = fc(
      obje({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }),
      obje({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1], [2, 2]], [[5, 5], [6, 7]]] }),
      obje({ type: 'LineString', coordinates: [[-3, 4], [8, -9], [1, 1]] }),
    )
    const d = await zipAc((await shapefileYaz(girdi)).veri)
    const shpB = d['cikti_cizgi.shp']
    const shxB = d['cikti_cizgi.shx']
    const s = new DataView(shpB.buffer)
    const x = new DataView(shxB.buffer)
    for (const [dv, boy] of [[s, shpB.length], [x, shxB.length]]) {
      expect(dv.getInt32(0, false)).toBe(9994)
      expect(dv.getInt32(24, false) * 2).toBe(boy)
      expect(dv.getInt32(28, true)).toBe(1000)
      expect(dv.getInt32(32, true)).toBe(3)
      expect([0, 1, 2, 3].map((i) => dv.getFloat64(36 + 8 * i, true))).toEqual([-3, -9, 8, 7])
    }
    expect(shxB.length).toBe(100 + 8 * 3)
    let o = 100
    for (let i = 0; i < 3; i++) {
      const ofset = x.getInt32(100 + 8 * i, false)
      const uzunluk = x.getInt32(104 + 8 * i, false)
      expect(ofset * 2).toBe(o)
      expect(s.getInt32(o, false)).toBe(i + 1) // kayıt no
      expect(s.getInt32(o + 4, false)).toBe(uzunluk)
      expect(s.getInt32(o + 8, true)).toBe(3) // kayıt şekil tipi
      const np = s.getInt32(o + 8 + 36, true)
      const n = s.getInt32(o + 8 + 40, true)
      expect(uzunluk * 2).toBe(44 + 4 * np + 16 * n)
      o += 8 + uzunluk * 2
    }
    expect(o).toBe(shpB.length)
  })
})

describe('shapefileYaz — .dbf / .cpg', () => {
  it('başlık, LDID, alan tipleri ve .cpg', async () => {
    const girdi = fc(
      obje({ type: 'Point', coordinates: [0, 0] }, { metin: 'abc', tam: 12, ondalik: 1.5, mantik: true, gun: '2023-10-29', karma: 1 }),
      obje({ type: 'Point', coordinates: [1, 1] }, { metin: 'ğ', tam: -345, ondalik: 22.125, mantik: false, gun: '2024-01-01', karma: 'x' }),
    )
    const d = await zipAc((await shapefileYaz(girdi)).veri)
    expect(metin(d['cikti_nokta.cpg'])).toBe('UTF-8')
    const b = d['cikti_nokta.dbf']
    const dv = new DataView(b.buffer)
    expect(b[0]).toBe(0x03)
    expect(dv.getUint32(4, true)).toBe(2)
    expect(dv.getUint16(8, true)).toBe(32 + 32 * 6 + 1)
    expect(b[29]).toBe(0x00) // LDID
    expect(b[32 + 32 * 6]).toBe(0x0d)
    expect(b[b.length - 1]).toBe(0x1a)
    const alanlar = Array.from({ length: 6 }, (_, i) => {
      const o = 32 + 32 * i
      return [metin(b.subarray(o, o + 11)).replace(/\0+$/, ''), String.fromCharCode(b[o + 11]), b[o + 16], b[o + 17]]
    })
    expect(alanlar).toEqual([
      ['metin', 'C', 3, 0],
      ['tam', 'N', 4, 0],
      ['ondalik', 'N', 6, 3],
      ['mantik', 'L', 1, 0],
      ['gun', 'D', 8, 0],
      ['karma', 'C', 1, 0],
    ])
    expect(dv.getUint16(10, true)).toBe(1 + 3 + 4 + 6 + 1 + 8 + 1)
    const oz = parseDbf(b, 'UTF-8')
    expect(oz[1]).toMatchObject({ metin: 'ğ', tam: -345, ondalik: 22.125, mantik: false, karma: 'x' })
    // Ham kayıt: N sağa, C sola yaslı; D YYYYMMDD
    expect(metin(b.subarray(dv.getUint16(8, true), dv.getUint16(8, true) + dv.getUint16(10, true))))
      .toBe(' abc  12 1.500T20231029' + '1')
  })

  it('alan adları 10 bayta kısaltılır, Türkçe harfler ASCII olur, çakışmada sonek eklenir', async () => {
    const esleme = alanAdlariniEsle(['uzun_alan_adi_1', 'uzun_alan_adi_2', 'UZUN_ALAN_', 'şehir_ilçe_adı', 'kısa', '2023', 'ad soyad', ''])
    expect([...esleme.values()]).toEqual(['uzun_alan_', 'uzun_ala_1', 'UZUN_ALA_2', 'sehir_ilce', 'kisa', 'F_2023', 'ad_soyad', 'ALAN'])
    const { veri, uyarilar } = await shapefileYaz(fc(obje({ type: 'Point', coordinates: [0, 0] }, { uzun_alan_adi_1: 'a', uzun_alan_adi_2: 'b', şehir_ilçe_adı: 'İstanbul' })))
    expect(uyarilar).toContain('Alan adı "uzun_alan_adi_2" → "uzun_ala_1" (dBASE: en fazla 10 bayt, ASCII, benzersiz).')
    const [kayit] = katmanOku(await zipAc(veri), 'cikti_nokta')
    expect(kayit.properties).toEqual({ uzun_alan_: 'a', uzun_ala_1: 'b', sehir_ilce: 'İstanbul' })
  })

  it('254 bayttan uzun C değeri karakter sınırında kesilir ve uyarılır', async () => {
    const uzun = 'ş'.repeat(200) // 400 bayt
    const { veri, uyarilar } = await shapefileYaz(fc(obje({ type: 'Point', coordinates: [0, 0] }, { not: uzun })))
    const [kayit] = katmanOku(await zipAc(veri), 'cikti_nokta')
    expect(kayit.properties.not).toBe('ş'.repeat(127))
    expect(uyarilar.some((u) => u.includes('"not" alanında 1 değer 254 bayt'))).toBe(true)
  })

  it('obje sırası .shp ile .dbf arasında birebir aynıdır', async () => {
    const girdi = fc(...Array.from({ length: 25 }, (_, i) => obje({ type: 'Point', coordinates: [i, -i] }, { sira: i })))
    const k = katmanOku(await zipAc((await shapefileYaz(girdi)).veri), 'cikti_nokta')
    k.forEach((o, i) => {
      expect(o.properties.sira).toBe(i)
      expect(o.geometry.coordinates).toEqual([i, -i])
    })
  })
})

describe('shapefileYaz — .prj', () => {
  it('katalogdaki her CRS için ESRI WKT var ve proj4 ile aynı dönüşümü verir', () => {
    for (const { kod, tanim } of KOORDINAT_SISTEMI_TANIMLARI) {
      const prj = prjMetni(kod)
      expect(prj, kod).toBeTruthy()
      expect(prj).toMatch(kod === 'EPSG:4326' ? /^GEOGCS\[/ : /^PROJCS\[/)
      const dom = kod.startsWith('EPSG:525') ? 27 + 3 * (Number(kod.slice(5)) - 5253)
        : kod.startsWith('EPSG:230') ? (Number(kod.slice(8)) * 6 - 183) : 30
      const lonlat = [dom + 0.7, 39.5]
      const beklenen = proj4('EPSG:4326', tanim, lonlat)
      const gercek = proj4('EPSG:4326', prj, lonlat)
      const tol = kod === 'EPSG:4326' ? 1e-9 : 1e-3
      expect(Math.abs(gercek[0] - beklenen[0]), kod).toBeLessThan(tol)
      expect(Math.abs(gercek[1] - beklenen[1]), kod).toBeLessThan(tol)
    }
    expect(Object.keys(PRJ_METINLERI)).toHaveLength(KOORDINAT_SISTEMI_TANIMLARI.length)
    expect(prjMetni(5255)).toBe(prjMetni('epsg:5255'))
    expect(PRJ_METINLERI['EPSG:23036']).toContain('TOWGS84[-84.1,-101.8,-129.7,0,0,0.468,1.05]')
    expect(PRJ_METINLERI['EPSG:23036']).toContain('SPHEROID["International_1924",6378388.0,297.0]')
    expect(PRJ_METINLERI['EPSG:5257']).toContain('SPHEROID["GRS_1980",6378137.0,298.257222101]')
  })

  it('tanımsız CRS: .prj yazılmaz, uyarı verilir', async () => {
    const { veri, uyarilar } = await shapefileYaz(fc(obje({ type: 'Point', coordinates: [0, 0] })), { crs: 'EPSG:2320' })
    expect(Object.keys(await zipAc(veri)).some((k) => k.endsWith('.prj'))).toBe(false)
    expect(uyarilar).toContain('"EPSG:2320" için .prj tanımı yok; .prj dosyası yazılmadı.')
  })
})

/** .shx kayıtlarını .shp kayıt başlıklarıyla karşılaştırır; [şekil tipi] listesi döndürür. */
function shxDogrula(shpB, shxB) {
  const s = new DataView(shpB.buffer)
  const x = new DataView(shxB.buffer)
  expect(s.getInt32(24, false) * 2).toBe(shpB.length)
  expect(x.getInt32(24, false) * 2).toBe(shxB.length)
  const adet = (shxB.length - 100) / 8
  const tipler = []
  let o = 100
  for (let i = 0; i < adet; i++) {
    expect(x.getInt32(100 + 8 * i, false) * 2).toBe(o)
    const uzunluk = x.getInt32(104 + 8 * i, false)
    expect(s.getInt32(o, false)).toBe(i + 1)
    expect(s.getInt32(o + 4, false)).toBe(uzunluk)
    const tip = s.getInt32(o + 8, true)
    if (tip === 0) expect(uzunluk).toBe(2) // Null Shape: 4 bayt = 2 kelime
    tipler.push(tip)
    o += 8 + uzunluk * 2
  }
  expect(o).toBe(shpB.length)
  return tipler
}

describe('shapefileYaz — null geometri (Null Shape)', () => {
  it('tek aile + null: null kayıtlar aynı katmana özgün sırada yazılır; bbox null kayıtları saymaz', async () => {
    const girdi = fc(
      obje(null, { parsel: 1, ad: 'çizilmemiş' }),
      obje({ type: 'Polygon', coordinates: [kareCW(10, 20, 5), kareCCW(11, 21, 1)] }, { parsel: 2, ad: 'Çiğdem' }),
      obje(null, { parsel: 3, ad: 'ğ' }),
      obje({ type: 'MultiPolygon', coordinates: [[kareCW(30, 20, 2)]] }, { parsel: 4, ad: 'son' }),
    )
    const { veri, uyarilar, onizleme } = await shapefileYaz(girdi, { crs: 'EPSG:5255' })
    const d = await zipAc(veri)
    expect(Object.keys(d).filter((k) => k.endsWith('.shp'))).toEqual(['cikti_poligon.shp'])
    expect(shxDogrula(d['cikti_poligon.shp'], d['cikti_poligon.shx'])).toEqual([0, 5, 0, 5])
    const k = katmanOku(d, 'cikti_poligon')
    expect(k.map((o) => o.properties)).toEqual(girdi.features.map((f) => f.properties))
    expect(k[0].geometry).toBeNull()
    expect(k[2].geometry).toBeNull()
    expect(sadeGeo(k[1].geometry)).toEqual(girdi.features[1].geometry)
    expect(sadeGeo(k[3].geometry)).toEqual({ type: 'Polygon', coordinates: [kareCW(30, 20, 2)] })
    const dv = new DataView(d['cikti_poligon.shp'].buffer)
    expect([0, 1, 2, 3].map((i) => dv.getFloat64(36 + 8 * i, true))).toEqual([10, 20, 32, 25])
    expect(dv.getInt32(32, true)).toBe(5)
    expect(uyarilar.some((u) => u.includes('2 geometrisiz obje (2 null) "cikti_poligon" katmanına'))).toBe(true)
    expect(onizleme).toContain('obje: 4 (2 Null Shape)')
  })

  it('tamamen null FC: hata yerine yalnız Null Shape içeren tek katman + .dbf üretilir', async () => {
    const girdi = fc(obje(null, { ada: 101, parsel: 7, malik: 'Ayşe Öztürk' }), obje(null, { ada: 101, parsel: 8, malik: 'İsmail Şahin' }))
    const { veri, uyarilar } = await shapefileYaz(girdi)
    const d = await zipAc(veri)
    expect(Object.keys(d).sort()).toEqual(['cpg', 'dbf', 'shp', 'shx'].map((u) => `cikti_geometrisiz.${u}`))
    expect(shxDogrula(d['cikti_geometrisiz.shp'], d['cikti_geometrisiz.shx'])).toEqual([0, 0])
    const dv = new DataView(d['cikti_geometrisiz.shp'].buffer)
    expect(dv.getInt32(32, true)).toBe(5) // başlık tipi Polygon (shpjs tip 0'ı okuyamaz)
    expect([0, 1, 2, 3].map((i) => dv.getFloat64(36 + 8 * i, true))).toEqual([0, 0, 0, 0])
    expect(katmanOku(d, 'cikti_geometrisiz')).toEqual(girdi.features.map((f) => ({ geometry: null, properties: f.properties })))
    // shpjs'in zip okuyucusuyla da gidiş-dönüş
    const geri = await shp(veri)
    expect(geri.features.map((f) => [f.geometry, f.properties.malik])).toEqual([[null, 'Ayşe Öztürk'], [null, 'İsmail Şahin']])
    expect(uyarilar.some((u) => u.includes('"cikti_geometrisiz"'))).toBe(true)
  })

  it('tamamen geçersiz geometri de Null Shape olur; karışık ailede ayrı katmana gider', async () => {
    const girdi = fc(
      obje({ type: 'Point', coordinates: [1, 1] }, { n: 1 }),
      obje({ type: 'LineString', coordinates: [[0, 0]] }, { n: 2 }),
      obje({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { n: 3 }),
    )
    const { veri, uyarilar } = await shapefileYaz(girdi)
    const d = await zipAc(veri)
    expect(katmanOku(d, 'cikti_geometrisiz')).toEqual([{ geometry: null, properties: { n: 2 } }])
    expect(shxDogrula(d['cikti_cizgi.shp'], d['cikti_cizgi.shx'])).toEqual([3])
    expect(uyarilar.some((u) => u.includes('1 tamamen geçersiz'))).toBe(true)
  })
})

describe('shapefileYaz — boş girdi', () => {
  it('hiç obje yoksa anlaşılır hata verir', async () => {
    await expect(shapefileYaz(fc())).rejects.toThrow(/hiç obje içermiyor/)
    await expect(shapefileYaz({ type: 'Feature' })).rejects.toThrow(/FeatureCollection/)
  })
})
