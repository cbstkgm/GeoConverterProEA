import { describe, it, expect } from 'vitest'
import wellknown from 'wellknown'
import { wktCoz } from './wkt.js'

describe('wktCoz — WKT', () => {
  it.each([
    ['POINT (30 40)', { type: 'Point', coordinates: [30, 40] }],
    ['point(30 40)', { type: 'Point', coordinates: [30, 40] }],
    ['POINT Z (30 40 5)', { type: 'Point', coordinates: [30, 40, 5] }],
    ['POINTZ(30 40 5)', { type: 'Point', coordinates: [30, 40, 5] }],
    ['POINT M (30 40 9)', { type: 'Point', coordinates: [30, 40] }],
    ['POINT ZM (30 40 5 9)', { type: 'Point', coordinates: [30, 40, 5] }],
    ['POINT (30 40 5 9)', { type: 'Point', coordinates: [30, 40, 5] }],
    ['POINT (3.1e1 -4.0E+1)', { type: 'Point', coordinates: [31, -40] }],
    ['SRID=4326;POINT (1 2)', { type: 'Point', coordinates: [1, 2] }],
    ['POINT (1 2);', { type: 'Point', coordinates: [1, 2] }],
    ['"POINT (1 2)"', { type: 'Point', coordinates: [1, 2] }],
    ['LINESTRING (0 0, 1 1)', { type: 'LineString', coordinates: [[0, 0], [1, 1]] }],
    ['POLYGON ((0 0, 1 0, 1 1, 0 0), (0.2 0.2, 0.4 0.2, 0.4 0.4, 0.2 0.2))', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]]] }],
    ['TRIANGLE ((0 0, 1 0, 1 1, 0 0))', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }],
    ['MULTIPOINT (1 2, 3 4)', { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }],
    ['MULTIPOINT ((1 2), (3 4))', { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }],
    ['MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))', { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }],
    ['MULTIPOLYGON Z (((0 0 1, 1 0 1, 1 1 1, 0 0 1)))', { type: 'MultiPolygon', coordinates: [[[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 1]]]] }],
    ['GEOMETRYCOLLECTION (POINT (1 2), POINT EMPTY, LINESTRING (0 0, 1 1))', { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 2] }, { type: 'LineString', coordinates: [[0, 0], [1, 1]] }] }],
    ['POLYGON ((0 0,\n 1 0,\n 1 1, 0 0))', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }],
  ])('%s', (wkt, beklenen) => {
    expect(wktCoz(wkt)).toEqual(beklenen)
  })

  it.each(['POLYGON EMPTY', 'GEOMETRYCOLLECTION EMPTY', 'point empty', 'MULTIPOLYGON Z EMPTY'])('%s → null', (wkt) => {
    expect(wktCoz(wkt)).toBeNull()
  })

  it.each([
    ['', /boş değer/],
    ['   ', /boş değer/],
    ['CURVEPOLYGON ((0 0, 1 0, 1 1, 0 0))', /eğri\/yüzey geometri tipi desteklenmiyor: CURVEPOLYGON/],
    ['MULTISURFACE (((0 0, 1 0, 1 1, 0 0)))', /desteklenmiyor: MULTISURFACE/],
    ['CIRCULARSTRING (0 0, 1 1, 2 0)', /desteklenmiyor: CIRCULARSTRING/],
    ['POLYGOM ((0 0, 1 0, 1 1, 0 0))', /bilinmeyen geometri tipi: POLYGOM/],
    ['POLYGON ((0 0, 1 0, 1 1, 0 0)', /parantez kapanmamış/],
    ['POINT (30,5 40,5)', /en az 2 sayı/],
    ['POINT (1 2) EXTRA', /beklenmeyen içerik/],
    ['POINT (1 2 3 4 5)', /4'ten fazla/],
    ['POINT (1 # 2)', /beklenmeyen karakter "#"/],
  ])('hata: %s', (wkt, desen) => {
    expect(() => wktCoz(wkt)).toThrow(desen)
  })

  it('wellknown ile aynı sonucu verir (yazıcıdan gelen WKT ile gidiş-dönüş)', () => {
    const g = { type: 'MultiPolygon', coordinates: [[[[30, 20], [45, 40], [10, 40], [30, 20]]], [[[15, 5], [40, 10], [10, 20], [5, 10], [15, 5]]]] }
    expect(wktCoz(wellknown.stringify(g))).toEqual(g)
  })
})

describe('wktCoz — hex WKB / EWKB', () => {
  it('PostGIS EWKB nokta (SRID 4326, little-endian)', () => {
    expect(wktCoz('0101000020E61000000000000000003E400000000000004440')).toEqual({ type: 'Point', coordinates: [30, 40] })
  })

  it('\\x öneki ve büyük-endian WKB', () => {
    // 00 = big-endian, tip 1 (Point), x=1, y=2
    expect(wktCoz('\\x00000000013FF00000000000004000000000000000')).toEqual({ type: 'Point', coordinates: [1, 2] })
  })

  it('ISO Z poligon (1003) ve EWKB Z bayrağı', () => {
    const iso = '01EB0300000100000004000000000000000000000000000000000000000000000000000000000000000000F03F00000000000000000000000000000000000000000000F03F000000000000F03F0000000000000000000000000000000000000000000000000000000000000000'
    // 0x03EB = 1003: Polygon Z, 1 halka, 4 nokta
    const g = wktCoz(iso)
    expect(g.type).toBe('Polygon')
    expect(g.coordinates[0]).toHaveLength(4)
    expect(g.coordinates[0][1]).toEqual([1, 0, 0])

    const ewkbZ = '0101000080000000000000F03F00000000000000400000000000000840' // Point Z (1 2 3)
    expect(wktCoz(ewkbZ)).toEqual({ type: 'Point', coordinates: [1, 2, 3] })
  })

  it('kesilmiş WKB için açık hata verir', () => {
    expect(() => wktCoz('0101000020E61000000000000000003E40')).toThrow(/kısa/)
  })
})
