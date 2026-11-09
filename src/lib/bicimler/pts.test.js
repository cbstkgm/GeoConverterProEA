import { describe, it, expect } from 'vitest'
import { ptsYaz, noktaBulutuTopla, epsgNumarasi } from './pts.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })

describe('noktaBulutuTopla', () => {
  it('köşeleri toplar, halka kapanışını atar, obje sırasını taşır, null geometriyi sayar', () => {
    const b = noktaBulutuTopla(fc(
      obje({ type: 'Point', coordinates: [1, 2, 3] }),
      obje(null),
      obje({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }),
      obje({ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[5, 5, 1], [6, 6, 2]] }] }),
    ))
    expect(b.adet).toBe(6)
    expect(b.x).toEqual([1, 0, 1, 1, 5, 6])
    expect(b.obje).toEqual([0, 2, 2, 2, 3, 3])
    expect(b.geometrisiz).toBe(1)
    expect(b.sinir).toEqual({ xmin: 0, ymin: 0, zmin: 0, xmax: 6, ymax: 6, zmax: 3 })
    expect(b.uyarilar.join(' ')).toMatch(/1 obje boş \(null\)/)
    expect(b.uyarilar.join(' ')).toMatch(/3 noktada Z değeri yoktu/)
  })

  it('epsgNumarasi', () => {
    expect(epsgNumarasi('EPSG:5255')).toBe(5255)
    expect(epsgNumarasi('epsg:4326')).toBe(4326)
    expect(epsgNumarasi(23036)).toBe(23036)
    expect(epsgNumarasi('ESRI:102100x')).toBeNull()
    expect(epsgNumarasi(undefined)).toBeNull()
  })
})

describe('ptsYaz', () => {
  it('ilk satır nokta sayısı, sonra "x y z i"; tam hassasiyet ve gidiş-dönüş', async () => {
    const girdi = fc(
      obje({ type: 'Point', coordinates: [500000.123456789, 4400000.5, 850.25] }, { ad: 'Şişli' }),
      obje({ type: 'LineString', coordinates: [[1e-7, 2], [3, 4]] }),
    )
    const { veri, uyarilar, onizleme } = await ptsYaz(girdi, { crs: 'EPSG:5255' })
    const satirlar = veri.trimEnd().split('\n')
    expect(satirlar).toEqual(['3', '500000.123456789 4400000.5 850.25 0', '0.0000001 2 0 0', '3 4 0 0'])
    const geri = satirlar.slice(1).map((s) => s.split(' ').map(Number))
    expect(geri.map((s) => s.slice(0, 2))).toEqual([[500000.123456789, 4400000.5], [1e-7, 2], [3, 4]])
    expect(uyarilar.join(' ')).toMatch(/CRS dosyaya yazılmadı/)
    expect(onizleme.split('\n')[0]).toBe('3')
  })

  it('tüm objelerde r g b varsa renk sütunları yazılır; Z yoksa uyarılır', async () => {
    const { veri, uyarilar } = await ptsYaz(fc(
      obje({ type: 'Point', coordinates: [1, 2] }, { r: 255, g: 10.4, b: 0 }),
      obje({ type: 'MultiPoint', coordinates: [[3, 4], [5, 6]] }, { r: 1, g: 2, b: 3 }),
    ))
    expect(veri).toBe('3\n1 2 0 0 255 10 0\n3 4 0 0 1 2 3\n5 6 0 0 1 2 3\n')
    expect(uyarilar.join(' ')).toMatch(/Veride Z \(yükseklik\) yok/)
  })

  it('boş FC ve yalnız null geometri: "0" satırlı geçerli PTS + uyarı', async () => {
    for (const girdi of [fc(), fc(obje(null, { ad: 'boş' }))]) {
      const { veri, uyarilar } = await ptsYaz(girdi)
      expect(veri).toBe('0\n')
      expect(uyarilar.join(' ')).toMatch(/0 nokta/)
    }
    await expect(ptsYaz({ type: 'Feature' })).rejects.toThrow(/FeatureCollection/)
  })
})
