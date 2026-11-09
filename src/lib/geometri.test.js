import { describe, it, expect } from 'vitest'
import { zDegerleriniKaldir, hassasiyetUygula, istatistikHesapla, geometriTipiDonustur } from './geometri.js'

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

describe('geometriTipiDonustur', () => {
  it('açık LineString kapatılarak Polygon olur, özellikler ve Z korunur', () => {
    const fc = fcOlustur({ type: 'LineString', coordinates: [[0, 0, 5], [10, 0, 5], [10, 10, 5]] })
    const { geojson, uyarilar, donusenSayisi } = geometriTipiDonustur(fc, 'Polygon')
    expect(donusenSayisi).toBe(1)
    expect(geojson.features[0].geometry).toEqual({
      type: 'Polygon',
      coordinates: [[[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 0, 5]]],
    })
    expect(geojson.features[0].properties).toEqual({ sira: 0 })
    expect(uyarilar.join(' ')).toMatch(/1 açık çizgi/)
  })

  it('zaten kapalı LineString ikinci kez kapatılmaz', () => {
    const halka = [[0, 0], [1, 0], [1, 1], [0, 0]]
    const { geojson, uyarilar } = geometriTipiDonustur(fcOlustur({ type: 'LineString', coordinates: halka }), 'Polygon')
    expect(geojson.features[0].geometry.coordinates).toEqual([halka])
    expect(uyarilar).toEqual([])
  })

  it("3'ten az farklı noktalı çizgi değişmeden kalır ve uyarılır", () => {
    const cizgi = { type: 'LineString', coordinates: [[0, 0], [1, 1], [0, 0]] }
    const { geojson, uyarilar } = geometriTipiDonustur(fcOlustur(cizgi), 'Polygon')
    expect(geojson.features[0].geometry).toEqual(cizgi)
    expect(uyarilar.join(' ')).toMatch(/1 çizgi 3'ten az/)
  })

  it('MultiLineString → MultiPolygon; geçersiz parça atlanır', () => {
    const fc = fcOlustur({
      type: 'MultiLineString',
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]], [[5, 5], [6, 6]]],
    })
    const { geojson, uyarilar } = geometriTipiDonustur(fc, 'Polygon')
    expect(geojson.features[0].geometry).toEqual({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] })
    expect(uyarilar.join(' ')).toMatch(/1 parça 3'ten az/)
  })

  it('Polygon → LineString; delikli poligon tüm halkalarıyla MultiLineString olur', () => {
    const dis = [[0, 0], [10, 0], [10, 10], [0, 0]]
    const ic = [[2, 2], [3, 2], [3, 3], [2, 2]]
    const { geojson } = geometriTipiDonustur(
      fcOlustur({ type: 'Polygon', coordinates: [dis] }, { type: 'Polygon', coordinates: [dis, ic] }),
      'LineString',
    )
    expect(geojson.features[0].geometry).toEqual({ type: 'LineString', coordinates: dis })
    expect(geojson.features[1].geometry).toEqual({ type: 'MultiLineString', coordinates: [dis, ic] })
  })

  it('MultiPolygon → MultiLineString; nokta, null ve GeometryCollection içi doğru işlenir', () => {
    const a = [[0, 0], [1, 0], [1, 1], [0, 0]]
    const b = [[5, 5], [6, 5], [6, 6], [5, 5]]
    const fc = fcOlustur(
      { type: 'MultiPolygon', coordinates: [[a], [b]] },
      { type: 'Point', coordinates: [1, 2] },
      null,
      { type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [a] }, { type: 'Point', coordinates: [0, 0] }] },
    )
    const { geojson } = geometriTipiDonustur(fc, 'LineString')
    expect(geojson.features[0].geometry).toEqual({ type: 'MultiLineString', coordinates: [a, b] })
    expect(geojson.features[1].geometry).toEqual({ type: 'Point', coordinates: [1, 2] })
    expect(geojson.features[2].geometry).toBeNull()
    expect(geojson.features[3].geometry.geometries[0]).toEqual({ type: 'LineString', coordinates: a })
  })

  it('gidiş-dönüş: Polygon → LineString → Polygon aynı geometriyi verir', () => {
    const poligon = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] }
    const cizgi = geometriTipiDonustur(fcOlustur(poligon), 'LineString').geojson
    const geri = geometriTipiDonustur(cizgi, 'Polygon').geojson
    expect(geri.features[0].geometry).toEqual(poligon)
  })

  it('girdiyi değiştirmez; çevrilecek geometri yoksa uyarır; geçersiz hedefte hata verir', () => {
    const fc = fcOlustur({ type: 'LineString', coordinates: [[0, 0], [1, 0], [1, 1]] })
    const kopya = JSON.parse(JSON.stringify(fc))
    geometriTipiDonustur(fc, 'Polygon')
    expect(fc).toEqual(kopya)
    expect(geometriTipiDonustur(fc, 'LineString').uyarilar.join(' ')).toMatch(/bulunamadı/)
    expect(() => geometriTipiDonustur(fc, 'Point')).toThrow(/Desteklenmeyen hedef geometri tipi/)
  })

  it('2 noktalı segmentlere bölünmüş sınır (ayrı LineString objeleri) birleşip tek Polygon olur', () => {
    // Kare sınır 4 ayrı segment; ikisi ters yönde ve sıra karışık. Ayrıca alakasız bir nokta.
    const fc = fcOlustur(
      { type: 'LineString', coordinates: [[0, 0], [10, 0]] },
      { type: 'LineString', coordinates: [[10, 10], [0, 10]] },
      { type: 'Point', coordinates: [5, 5] },
      { type: 'LineString', coordinates: [[10, 10], [10, 0]] }, // ters yönde
      { type: 'LineString', coordinates: [[0, 0], [0, 10]] }, // ters yönde
    )
    const { geojson, uyarilar } = geometriTipiDonustur(fc, 'Polygon')
    const poligonlar = geojson.features.filter((f) => f.geometry.type === 'Polygon')
    expect(poligonlar).toHaveLength(1)
    const halka = poligonlar[0].geometry.coordinates[0]
    expect(halka).toHaveLength(5)
    expect(halka[0]).toEqual(halka[4])
    expect(new Set(halka.map(String))).toEqual(new Set(['0,0', '10,0', '10,10', '0,10']))
    expect(poligonlar[0].properties).toEqual({ sira: 0 })
    expect(geojson.features.filter((f) => f.geometry.type === 'Point')).toHaveLength(1)
    expect(geojson.features).toHaveLength(2)
    expect(uyarilar.join(' ')).toMatch(/4 çizgi parçası birleştirilerek 1 poligon/)
  })

  it('segmentli MultiLineString aynı objede MultiPolygon olur (iki ayrı halka)', () => {
    const fc = fcOlustur({
      type: 'MultiLineString',
      coordinates: [
        [[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 0]], // 1. halka (3 segment)
        [[5, 5], [6, 5]], [[6, 6], [6, 5]], [[6, 6], [5, 5]], // 2. halka (biri ters)
      ],
    })
    const { geojson } = geometriTipiDonustur(fc, 'Polygon')
    expect(geojson.features).toHaveLength(1)
    const g = geojson.features[0].geometry
    expect(g.type).toBe('MultiPolygon')
    expect(g.coordinates).toHaveLength(2)
    for (const [halka] of g.coordinates) {
      expect(halka).toHaveLength(4)
      expect(halka[0]).toEqual(halka[3])
    }
  })

  it('birbirine bağlanmayan iki açık çizgi ayrı poligonlar olarak kapatılır', () => {
    const fc = fcOlustur(
      { type: 'LineString', coordinates: [[0, 0], [1, 0], [1, 1]] },
      { type: 'LineString', coordinates: [[5, 5], [6, 5], [6, 6]] },
    )
    const { geojson, uyarilar } = geometriTipiDonustur(fc, 'Polygon')
    expect(geojson.features.map((f) => f.geometry.type)).toEqual(['Polygon', 'Polygon'])
    expect(uyarilar.join(' ')).toMatch(/2 açık çizgi/)
  })

  it('binlerce segmentli halka doğrusal sürede birleşir', () => {
    const n = 20000
    const nokta = (i) => [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)]
    const segmentler = Array.from({ length: n }, (_, i) => ({ type: 'LineString', coordinates: [nokta(i), nokta((i + 1) % n)] }))
    segmentler.reverse()
    const t0 = Date.now()
    const { geojson } = geometriTipiDonustur(fcOlustur(...segmentler), 'Polygon')
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(geojson.features).toHaveLength(1)
    expect(geojson.features[0].geometry.coordinates[0]).toHaveLength(n + 1)
  })
})
