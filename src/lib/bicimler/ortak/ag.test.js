import { describe, it, expect } from 'vitest'
import { agOlustur } from './ag.js'

const fc = (...geometriler) => ({
  type: 'FeatureCollection',
  features: geometriler.map((g, i) => ({ type: 'Feature', properties: { no: i }, geometry: g })),
})

const ucgenAlanlari = (p) => {
  const k = p.konumlar
  const alanlar = []
  for (let i = 0; i < p.indeksler.length; i += 3) {
    const [a, b, c] = p.indeksler.slice(i, i + 3).map((j) => [k[j * 3], k[j * 3 + 1]])
    alanlar.push(((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2)
  }
  return alanlar
}

describe('agOlustur', () => {
  it('delikli poligonu CCW üçgenlere böler; toplam alan delik hariç alandır', () => {
    const { parcalar } = agOlustur(
      fc({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]]] }),
      { merkezle: false },
    )
    const alanlar = ucgenAlanlari(parcalar[0])
    expect(alanlar.every((a) => a > 0)).toBe(true)
    expect(alanlar.reduce((s, a) => s + a, 0)).toBeCloseTo(96)
  })

  it('saat yönünde verilen halka da CCW üçgen üretir', () => {
    const { parcalar } = agOlustur(fc({ type: 'Polygon', coordinates: [[[0, 0], [0, 5], [5, 5], [5, 0], [0, 0]]] }))
    expect(ucgenAlanlari(parcalar[0]).every((a) => a > 0)).toBe(true)
  })

  it('projeksiyonlu koordinatları alt-orta noktaya göre öteler', () => {
    const r = agOlustur(fc({ type: 'LineString', coordinates: [[500000, 4400000, 100], [500010, 4400020, 110]] }))
    expect(r.merkez).toEqual([500005, 4400010, 100])
    expect(r.parcalar[0].konumlar).toEqual([-5, -10, 0, 5, 10, 10])
  })

  it('tüm tipleri parçalara açar, geometrisiz ve geçersizleri uyarır', () => {
    const r = agOlustur({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[1, 1], [2, 2]] } },
        { type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }, { type: 'LineString', coordinates: [[0, 0], [1, 1]] }] } },
        { type: 'Feature', properties: {}, geometry: null },
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] } },
      ],
    })
    expect(r.sayac).toMatchObject({ nokta: 3, cizgi: 1, yuzey: 0 })
    expect(r.uyarilar.join(' ')).toMatch(/1 obje geometrisiz/)
    expect(r.uyarilar.join(' ')).toMatch(/1 geometri parçası/)
  })

  it('boş FC: sinir null, merkez sıfır', () => {
    const r = agOlustur({ type: 'FeatureCollection', features: [] })
    expect(r.sinir).toBeNull()
    expect(r.merkez).toEqual([0, 0, 0])
  })
})
