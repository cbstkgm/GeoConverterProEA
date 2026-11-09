import { describe, it, expect } from 'vitest'
import { KOORDINAT_SISTEMLERI, koordinatDonustur, wgs84OlabilirMi } from './projeksiyon.js'

const nokta = (x, y, z) => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { ad: 'kontrol' },
      geometry: { type: 'Point', coordinates: z === undefined ? [x, y] : [x, y, z] },
    },
  ],
})
const koord = (fc) => fc.features[0].geometry.coordinates

/*
 * Beklenen değerler bu kütüphaneden (proj4) BAĞIMSIZ olarak hesaplanmıştır:
 * Krüger serisi (n^6 terime kadar, mm-altı doğruluk) ile Transverse Mercator ve
 * EPSG:1784 parametreleriyle (Position Vector) kesin ters Helmert + ECEF dönüşümü,
 * yalnızca Python standart kütüphanesi kullanılarak. Tolerans: 1 cm.
 */
const KONTROL = [
  { ad: 'Ankara', wgs: [32.85411, 39.92077], kod: 'EPSG:5255', beklenen: [487527.5012, 4420742.0067] },
  { ad: 'Ankara', wgs: [32.85411, 39.92077], kod: 'EPSG:23036', beklenen: [487560.8717, 4419157.867] },
  { ad: 'İstanbul', wgs: [28.97836, 41.00824], kod: 'EPSG:5254', beklenen: [414054.1929, 4541991.1924] },
  { ad: 'İstanbul', wgs: [28.97836, 41.00824], kod: 'EPSG:23035', beklenen: [666409.5258, 4541744.5739] },
  { ad: 'Erzurum', wgs: [41.27694, 39.90861], kod: 'EPSG:5258', beklenen: [438172.5883, 4419631.9526] },
  { ad: 'Erzurum', wgs: [41.27694, 39.90861], kod: 'EPSG:23037', beklenen: [694642.9438, 4420277.4085] },
  { ad: 'Erzurum', wgs: [41.27694, 39.90861], kod: 'EPSG:23038', beklenen: [181737.3968, 4424434.2428] },
]

describe('KOORDINAT_SISTEMLERI', () => {
  it('sözleşmedeki tüm kodları Türkçe adlarla içerir', () => {
    const kodlar = KOORDINAT_SISTEMLERI.map((s) => s.kod)
    for (const k of ['EPSG:4326', 'EPSG:3857', 'EPSG:23035', 'EPSG:23036', 'EPSG:23037', 'EPSG:23038']) {
      expect(kodlar).toContain(k)
    }
    for (let k = 5253; k <= 5259; k++) expect(kodlar).toContain(`EPSG:${k}`)
    expect(KOORDINAT_SISTEMLERI.find((s) => s.kod === 'EPSG:5254').ad).toBe('ITRF96 / 3° TM 30 (EPSG:5254)')
    for (const s of KOORDINAT_SISTEMLERI) expect(s.ad).toContain(s.kod)
  })
})

describe('koordinatDonustur — kontrol noktaları', () => {
  for (const { ad, wgs, kod, beklenen } of KONTROL) {
    it(`${ad}: WGS84 -> ${kod} ve geri`, () => {
      const ileri = koord(koordinatDonustur(nokta(...wgs), 'EPSG:4326', kod))
      expect(Math.abs(ileri[0] - beklenen[0])).toBeLessThan(0.01)
      expect(Math.abs(ileri[1] - beklenen[1])).toBeLessThan(0.01)
      const geri = koord(koordinatDonustur(nokta(...beklenen), kod, 'EPSG:4326'))
      // 1e-7 derece ≈ 1 cm
      expect(Math.abs(geri[0] - wgs[0])).toBeLessThan(1e-7)
      expect(Math.abs(geri[1] - wgs[1])).toBeLessThan(1e-7)
    })
  }

  it('Web Mercator (EPSG:3857) kapalı formülüyle uyumlu', () => {
    const [lon, lat] = [32.85411, 39.92077]
    const R = 6378137
    const x = (R * lon * Math.PI) / 180
    const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
    const s = koord(koordinatDonustur(nokta(lon, lat), 'EPSG:4326', 'EPSG:3857'))
    expect(s[0]).toBeCloseTo(x, 3)
    expect(s[1]).toBeCloseTo(y, 3)
  })

  it('ED50 UTM 36 -> ITRF96 TM33 doğrudan dönüşüm (datum kaydırması dahil)', () => {
    const s = koord(koordinatDonustur(nokta(487560.8717, 4419157.867), 'EPSG:23036', 'EPSG:5255'))
    expect(Math.abs(s[0] - 487527.5012)).toBeLessThan(0.01)
    expect(Math.abs(s[1] - 4420742.0067)).toBeLessThan(0.01)
  })
})

describe('koordinatDonustur — genel davranış', () => {
  const karma = () => ({
    type: 'FeatureCollection',
    bbox: [27, 37, 33, 41],
    features: [
      { type: 'Feature', properties: { dizi: [30, 0] }, geometry: { type: 'Point', coordinates: [30, 39, 850] } },
      { type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[30, 39], [31, 40]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[30, 39], [30.5, 39.5]] } },
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiLineString', coordinates: [[[30, 39], [30.1, 39.1]], [[31, 40], [31.1, 40.1]]] },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[[30, 39], [30.1, 39], [30.1, 39.1], [30, 39]]] },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiPolygon', coordinates: [[[[30, 39], [30.1, 39], [30.1, 39.1], [30, 39]]]] },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [29, 38] },
            { type: 'LineString', coordinates: [[29, 38], [29.5, 38.5]] },
          ],
        },
      },
      { type: 'Feature', properties: { bos: true }, geometry: null },
    ],
  })

  const duzlestir = (g) => (g.type === 'GeometryCollection' ? g.geometries.flatMap(duzlestir) : [g.coordinates].flat(4))

  it('tüm geometri tiplerinde gidiş-dönüş (4326 -> TM30 -> ED50 UTM35 -> 4326)', () => {
    const fc = karma()
    const kopya = structuredClone(fc)
    const a = koordinatDonustur(fc, 'EPSG:4326', 'EPSG:5254')
    const b = koordinatDonustur(a, 'EPSG:5254', 'EPSG:23035')
    const c = koordinatDonustur(b, 'EPSG:23035', 'EPSG:4326')
    expect(fc).toEqual(kopya) // girdi değişmedi
    expect(a.bbox).toBeUndefined() // eski bbox geçersiz -> kaldırıldı
    expect(c.features[7].geometry).toBeNull()
    expect(c.features[0].properties).toEqual({ dizi: [30, 0] })
    for (let i = 0; i < 7; i++) {
      const once = duzlestir(fc.features[i].geometry)
      const sonra = duzlestir(c.features[i].geometry)
      expect(sonra.length).toBe(once.length)
      sonra.forEach((v, j) => expect(Math.abs(v - once[j])).toBeLessThan(1e-8))
    }
  })

  it('Z değeri dönüşümde korunur', () => {
    const s = koord(koordinatDonustur(nokta(32.85411, 39.92077, 938.5), 'EPSG:4326', 'EPSG:23036'))
    expect(s).toHaveLength(3)
    expect(s[2]).toBe(938.5)
  })

  it('aynı kod verilirse bağımsız kopya döndürür', () => {
    const fc = karma()
    const s = koordinatDonustur(fc, 'EPSG:5255', 'epsg:5255')
    expect(s).toEqual(fc)
    expect(s).not.toBe(fc)
    expect(s.features[0].geometry.coordinates).not.toBe(fc.features[0].geometry.coordinates)
  })

  it('bilinmeyen kodda Türkçe hata', () => {
    expect(() => koordinatDonustur(karma(), 'EPSG:9999', 'EPSG:4326')).toThrow(/Bilinmeyen kaynak koordinat sistemi/)
    expect(() => koordinatDonustur(karma(), 'EPSG:4326', 'ABC')).toThrow(/Bilinmeyen hedef koordinat sistemi/)
  })

  it('sayısal olmayan koordinatta Türkçe hata', () => {
    expect(() => koordinatDonustur(nokta('a', 1), 'EPSG:4326', 'EPSG:3857')).toThrow(/Geçersiz koordinat/)
  })
})

describe('wgs84OlabilirMi', () => {
  it('coğrafi koordinatlar için true', () => {
    expect(wgs84OlabilirMi(nokta(32.85, 39.92))).toBe(true)
    expect(wgs84OlabilirMi(nokta(-180, -90))).toBe(true)
  })
  it('projeksiyonlu koordinatlar için false', () => {
    expect(wgs84OlabilirMi(nokta(487527.5, 4420742.0))).toBe(false)
    expect(wgs84OlabilirMi(nokta(100, 95))).toBe(false)
  })
  it('koordinatsız veya geçersiz veri için false', () => {
    expect(wgs84OlabilirMi({ type: 'FeatureCollection', features: [] })).toBe(false)
    expect(wgs84OlabilirMi({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null }] })).toBe(false)
    expect(wgs84OlabilirMi(null)).toBe(false)
  })
})
