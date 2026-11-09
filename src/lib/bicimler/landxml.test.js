import { describe, it, expect } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { landxmlYaz } from './landxml.js'

const NS = 'http://www.landxml.org/schema/LandXML-1.2'
const kare = (x, y, b) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]]
const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })

function ayristir(metin) {
  const hatalar = []
  const doc = new DOMParser({ onError: (_d, m) => hatalar.push(m) }).parseFromString(metin, 'text/xml')
  expect(hatalar).toEqual([])
  return doc
}
const ogeler = (el, ad) => Array.from(el.getElementsByTagNameNS(NS, ad))
const nokta = (metin) => metin.trim().split(/\s+/).map(Number)
const cocuklar = (el, ad) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.localName === ad)

describe('landxmlYaz', () => {
  it('LandXML 1.2 yapısı: Units, CoordinateSystem, CgPoints (N E Z), Parcels, PlanFeatures', async () => {
    const { veri, uyarilar, onizleme } = await landxmlYaz(
      fc(
        obje({ type: 'Point', coordinates: [500123.456, 4400987.654, 812.5] }, { ad: 'P1', kod: 'PK', aciklama: 'Poligon noktası' }),
        obje({ type: 'Polygon', coordinates: [kare(500000, 4400000, 100)] }, { ada: 101, parsel: 7, malik: 'Şükrü Çağlar' }),
        obje({ type: 'LineString', coordinates: [[500000, 4400000], [500050, 4400020], [500100, 4400000]] }, { ad: 'Yol ğüşiöç' }),
      ),
      { crs: 'EPSG:5255' },
    )
    expect(uyarilar).toEqual([])
    expect(onizleme).toContain('<LandXML')
    const doc = ayristir(veri)
    const kok = doc.documentElement
    expect(kok.localName).toBe('LandXML')
    expect(kok.namespaceURI).toBe(NS)
    expect(kok.getAttribute('version')).toBe('1.2')
    expect(kok.getAttribute('date')).toMatch(/^\d{4}-\d\d-\d\d$/)
    const metric = ogeler(kok, 'Metric')[0]
    expect(metric.getAttribute('linearUnit')).toBe('meter')
    expect(metric.getAttribute('areaUnit')).toBe('squareMeter')
    const cs = ogeler(kok, 'CoordinateSystem')[0]
    expect(cs.getAttribute('epsgCode')).toBe('5255')
    expect(cs.getAttribute('name')).toContain('TM 33')

    const [p] = ogeler(kok, 'CgPoint')
    expect(p.getAttribute('name')).toBe('P1')
    expect(p.getAttribute('code')).toBe('PK')
    expect(p.getAttribute('desc')).toBe('Poligon noktası')
    expect(nokta(p.textContent)).toEqual([4400987.654, 500123.456, 812.5]) // kuzey önce

    const [parsel] = ogeler(kok, 'Parcel')
    expect(parsel.getAttribute('name')).toBe('101/7')
    expect(Number(parsel.getAttribute('area'))).toBe(10000)
    expect(nokta(cocuklar(parsel, 'Center')[0].textContent)).toEqual([4400050, 500050])
    const cizgiler = ogeler(parsel, 'Line')
    expect(cizgiler).toHaveLength(4)
    expect(nokta(ogeler(cizgiler[0], 'Start')[0].textContent)).toEqual([4400000, 500000])
    expect(nokta(ogeler(cizgiler[0], 'End')[0].textContent)).toEqual([4400000, 500100])
    expect(nokta(ogeler(cizgiler[3], 'End')[0].textContent)).toEqual([4400000, 500000])
    const ozellikler = Object.fromEntries(ogeler(parsel, 'Property').map((e) => [e.getAttribute('label'), e.getAttribute('value')]))
    expect(ozellikler).toEqual({ ada: '101', parsel: '7', malik: 'Şükrü Çağlar' })

    const [pf] = ogeler(kok, 'PlanFeature')
    expect(pf.getAttribute('name')).toBe('Yol ğüşiöç')
    expect(ogeler(pf, 'Line')).toHaveLength(2)
  })

  it('delikli ve çok parçalı poligonları ayrı CoordGeom parçaları olarak yazar ve uyarır', async () => {
    const { veri, uyarilar } = await landxmlYaz(
      fc(
        obje({ type: 'Polygon', coordinates: [kare(0, 0, 10), kare(2, 2, 2)] }, { ad: 'Delikli' }),
        obje({ type: 'MultiPolygon', coordinates: [[kare(100, 100, 10)], [kare(200, 200, 5)]] }, { ad: 'Çok' }),
      ),
      { crs: 'EPSG:23036' },
    )
    expect(uyarilar.some((u) => u.includes('delikli poligon'))).toBe(true)
    expect(uyarilar.some((u) => u.includes('çok parçalı'))).toBe(true)
    const [a, b] = ogeler(ayristir(veri).documentElement, 'Parcel')
    expect(Number(a.getAttribute('area'))).toBe(96)
    expect(cocuklar(a, 'CoordGeom').map((c) => c.getAttribute('name'))).toEqual([null, 'delik-1'])
    // iç nokta deliğe düşmemeli
    const [n, e] = nokta(cocuklar(a, 'Center')[0].textContent)
    expect(e >= 2 && e <= 4 && n >= 2 && n <= 4).toBe(false)
    expect(Number(b.getAttribute('area'))).toBe(125)
    expect(cocuklar(b, 'CoordGeom').map((c) => c.getAttribute('name'))).toEqual(['parca-1', 'parca-2'])
  })

  it('null geometri, boş FC, coğrafi CRS uyarısı, benzersiz nokta adları', async () => {
    const bos = await landxmlYaz(fc(), { crs: 'EPSG:5254' })
    const doc = ayristir(bos.veri)
    expect(ogeler(doc.documentElement, 'CgPoints')).toHaveLength(0)
    expect(ogeler(doc.documentElement, 'CoordinateSystem')[0].getAttribute('epsgCode')).toBe('5254')

    const r = await landxmlYaz(
      fc(obje(null, { ad: 'x' }), obje({ type: 'MultiPoint', coordinates: [[30.5, 39.25], [30.6, 39.3]] }, { ad: 'A', ek: 1 }), obje({ type: 'Point', coordinates: [30.7, 39.1] }, { ad: 'A-1' })),
      { crs: 'EPSG:4326' },
    )
    const metin = r.uyarilar.join('\n')
    expect(metin).toMatch(/coğrafi/)
    expect(metin).toMatch(/Geometrisi olmayan 1 obje/)
    expect(metin).toMatch(/diğer öznitelikleri/)
    const noktalar = ogeler(ayristir(r.veri).documentElement, 'CgPoint')
    expect(noktalar.map((p) => p.getAttribute('name'))).toEqual(['A-1', 'A-2', 'A-1_2'])
    expect(nokta(noktalar[0].textContent)).toEqual([39.25, 30.5])

    const crssiz = await landxmlYaz(fc(obje({ type: 'Point', coordinates: [1, 2] })))
    expect(crssiz.uyarilar.join(' ')).toMatch(/CoordinateSystem/)
  })

  it('XML özel karakterlerini kaçışlar', async () => {
    const { veri } = await landxmlYaz(fc(obje({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { ad: 'A & B <"x">' })), { crs: 'EPSG:5255' })
    expect(ogeler(ayristir(veri).documentElement, 'PlanFeature')[0].getAttribute('name')).toBe('A & B <"x">')
  })
})
