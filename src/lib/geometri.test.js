import { describe, it, expect } from 'vitest'
import { zDegerleriniKaldir, hassasiyetUygula, istatistikHesapla } from './geometri.js'

const fcOlustur = (...geometriler) => ({
  type: 'FeatureCollection',
  features: geometriler.map((geometry, i) => ({ type: 'Feature', id: i, properties: { sira: i }, geometry })),
})

const tumTipler = () =>
  fcOlustur(
    { type: 'Point', coordinates: [30, 0, 0] },
    { type: 'MultiPoint', coordinates: [[1, 2, 3], [4, 0, 0]] },
    { type: 'LineString', coordinates: [[0, 0, 0], [1, 1, 5]] },
    { type: 'MultiLineString', coordinates: [[[0, 0, 0], [1, 0, 0]], [[2, 2, 2], [3, 3, 0]]] },
    { type: 'Polygon', coordinates: [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 0]]] },
    { type: 'MultiPolygon', coordinates: [[[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 1]]]] },
    {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [5, 0, 0] },
        { type: 'LineString', coordinates: [[5, 0, 7], [6, 0, 0]] },
      ],
    },
    null,
  )

describe('zDegerleriniKaldir', () => {
  it('Y=0 olan 2B koordinatı korur (eski regex hatası: POINT (5 0) -> POINT (5))', () => {
    const fc = fcOlustur({ type: 'Point', coordinates: [5, 0] }, { type: 'Point', coordinates: [30, 0] })
    for (const sadeceSifir of [true, false]) {
      const s = zDegerleriniKaldir(fc, { sadeceSifir })
      expect(s.features[0].geometry.coordinates).toEqual([5, 0])
      expect(s.features[1].geometry.coordinates).toEqual([30, 0])
    }
  })

  it('özellik dizilerine ve değerlerine dokunmaz', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { dizi: [30, 0], ic: { k: [1, 2, 0] }, metin: 'POINT (5 0 0)' },
          geometry: { type: 'Point', coordinates: [30, 40, 0] },
        },
      ],
    }
    for (const sadeceSifir of [true, false]) {
      const s = zDegerleriniKaldir(fc, { sadeceSifir })
      expect(s.features[0].properties).toEqual({ dizi: [30, 0], ic: { k: [1, 2, 0] }, metin: 'POINT (5 0 0)' })
      expect(s.features[0].geometry.coordinates).toEqual([30, 40])
    }
  })

  it('sadeceSifir=false tüm Z değerlerini düşürür (tüm geometri tipleri)', () => {
    const s = zDegerleriniKaldir(tumTipler(), { sadeceSifir: false })
    expect(istatistikHesapla(s).zIceriyor).toBe(false)
    expect(s.features[1].geometry.coordinates).toEqual([[1, 2], [4, 0]])
    expect(s.features[3].geometry.coordinates).toEqual([[[0, 0], [1, 0]], [[2, 2], [3, 3]]])
    expect(s.features[5].geometry.coordinates[0][0][0]).toEqual([0, 0])
    expect(s.features[6].geometry.geometries[1].coordinates).toEqual([[5, 0], [6, 0]])
    expect(s.features[7].geometry).toBeNull()
  })

  it('varsayılan davranış tüm Z değerlerini düşürmektir', () => {
    expect(zDegerleriniKaldir(tumTipler())).toEqual(zDegerleriniKaldir(tumTipler(), { sadeceSifir: false }))
  })

  it('sadeceSifir=true yalnızca z===0 olan konumlardan Z düşürür', () => {
    const s = zDegerleriniKaldir(tumTipler(), { sadeceSifir: true })
    expect(s.features[0].geometry.coordinates).toEqual([30, 0])
    expect(s.features[1].geometry.coordinates).toEqual([[1, 2, 3], [4, 0]])
    expect(s.features[2].geometry.coordinates).toEqual([[0, 0], [1, 1, 5]])
    expect(s.features[4].geometry.coordinates).toEqual([[[0, 0], [1, 0], [1, 1], [0, 0]]])
    expect(s.features[5].geometry.coordinates[0][0][0]).toEqual([0, 0, 1])
    expect(s.features[6].geometry.geometries[0].coordinates).toEqual([5, 0])
    expect(s.features[6].geometry.geometries[1].coordinates).toEqual([[5, 0, 7], [6, 0]])
  })

  it('girdiyi değiştirmez', () => {
    const fc = tumTipler()
    const kopya = structuredClone(fc)
    zDegerleriniKaldir(fc)
    zDegerleriniKaldir(fc, { sadeceSifir: true })
    expect(fc).toEqual(kopya)
  })

  it('3B bbox Z kaldırılınca 2B olur', () => {
    const fc = { ...fcOlustur({ type: 'Point', coordinates: [1, 2, 3] }), bbox: [1, 2, 3, 1, 2, 3] }
    expect(zDegerleriniKaldir(fc).bbox).toEqual([1, 2, 1, 2])
  })

  it('geçersiz girdide Türkçe hata', () => {
    expect(() => zDegerleriniKaldir({ type: 'Feature' })).toThrow(/FeatureCollection/)
    expect(() => zDegerleriniKaldir(fcOlustur({ type: 'Curve', coordinates: [] }))).toThrow(
      /Desteklenmeyen geometri tipi/,
    )
  })
})

describe('hassasiyetUygula', () => {
  it('tüm bileşenleri yuvarlar, özelliklere dokunmaz', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { deger: 1.23456789 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [32.123456789, 39.987654321, 850.4567],
              [1.005, -1.005],
            ],
          },
        },
      ],
    }
    const s = hassasiyetUygula(fc, 2)
    expect(s.features[0].geometry.coordinates).toEqual([
      [32.12, 39.99, 850.46],
      [1.01, -1.01],
    ])
    expect(s.features[0].properties.deger).toBe(1.23456789)
    expect(fc.features[0].geometry.coordinates[0][0]).toBe(32.123456789)
  })

  it('0 basamak ve -0 temizliği', () => {
    const s = hassasiyetUygula(fcOlustur({ type: 'Point', coordinates: [-0.4, 2.5] }), 0)
    expect(Object.is(s.features[0].geometry.coordinates[0], 0)).toBe(true)
    expect(s.features[0].geometry.coordinates[1]).toBe(3)
  })

  it('çok küçük (üstel gösterimli) değerler', () => {
    const s = hassasiyetUygula(fcOlustur({ type: 'Point', coordinates: [1e-9, 4420742.006686] }), 3)
    expect(s.features[0].geometry.coordinates).toEqual([0, 4420742.007])
  })

  it('tüm geometri tiplerinde çalışır', () => {
    const s = hassasiyetUygula(tumTipler(), 3)
    expect(s).toEqual(tumTipler())
  })

  it('geçersiz basamakta Türkçe hata', () => {
    expect(() => hassasiyetUygula(tumTipler(), -1)).toThrow(/Hassasiyet/)
    expect(() => hassasiyetUygula(tumTipler(), 2.5)).toThrow(/Hassasiyet/)
    expect(() => hassasiyetUygula(tumTipler(), 16)).toThrow(/Hassasiyet/)
  })
})

describe('istatistikHesapla', () => {
  it('tüm geometri tipleri için doğru sayımlar', () => {
    const i = istatistikHesapla(tumTipler())
    expect(i.objeSayisi).toBe(8)
    expect(i.geometriTipleri).toEqual({
      Point: 1,
      MultiPoint: 1,
      LineString: 1,
      MultiLineString: 1,
      Polygon: 1,
      MultiPolygon: 1,
      GeometryCollection: 1,
    })
    // 1 + 2 + 2 + 4 + 4 + 4 + (1 + 2)
    expect(i.koordinatSayisi).toBe(20)
    expect(i.bbox).toEqual([0, 0, 30, 3])
    expect(i.zIceriyor).toBe(true)
    expect(i.bosGeometriSayisi).toBe(1)
  })

  it('boş koleksiyon ve boş geometriler', () => {
    expect(istatistikHesapla({ type: 'FeatureCollection', features: [] })).toEqual({
      objeSayisi: 0,
      geometriTipleri: {},
      koordinatSayisi: 0,
      bbox: null,
      zIceriyor: false,
      bosGeometriSayisi: 0,
    })
    const i = istatistikHesapla(
      fcOlustur({ type: 'LineString', coordinates: [] }, { type: 'GeometryCollection', geometries: [] }, null),
    )
    expect(i.bosGeometriSayisi).toBe(3)
    expect(i.bbox).toBeNull()
    expect(i.geometriTipleri).toEqual({ LineString: 1, GeometryCollection: 1 })
  })

  it('negatif koordinatlarla bbox', () => {
    const i = istatistikHesapla(fcOlustur({ type: 'MultiPoint', coordinates: [[-10, -5], [20, 15]] }))
    expect(i.bbox).toEqual([-10, -5, 20, 15])
    expect(i.zIceriyor).toBe(false)
  })
})
