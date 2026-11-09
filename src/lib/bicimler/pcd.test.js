import { describe, it, expect } from 'vitest'
import { pcdYaz } from './pcd.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })

/** Asgari PCD v0.7 okuyucu (ascii + binary). */
function pcdOku(veri) {
  const bayt = typeof veri === 'string' ? new TextEncoder().encode(veri) : veri
  const baslik = {}
  let o = 0
  for (;;) {
    const son = bayt.indexOf(0x0a, o)
    const satir = new TextDecoder().decode(bayt.subarray(o, son))
    o = son + 1
    if (satir.startsWith('#')) continue
    const [anahtar, ...degerler] = satir.split(' ')
    baslik[anahtar] = degerler
    if (anahtar === 'DATA') break
  }
  const n = Number(baslik.POINTS[0])
  const noktalar = []
  if (baslik.DATA[0] === 'ascii') {
    const satirlar = new TextDecoder().decode(bayt.subarray(o)).split('\n').filter(Boolean)
    for (const s of satirlar) noktalar.push(s.split(' ').map(Number))
  } else {
    const boylar = baslik.SIZE.map(Number)
    const kayit = boylar.reduce((a, b) => a + b, 0)
    expect(bayt.length - o).toBe(kayit * n)
    const dv = new DataView(bayt.buffer, bayt.byteOffset + o)
    for (let i = 0; i < n; i++) {
      let p = i * kayit
      const r = []
      baslik.TYPE.forEach((t, k) => {
        r.push(t === 'F' ? (boylar[k] === 8 ? dv.getFloat64(p, true) : dv.getFloat32(p, true)) : dv.getUint32(p, true))
        p += boylar[k]
      })
      noktalar.push(r)
    }
  }
  return { baslik, noktalar }
}

const girdi = () => fc(
  obje({ type: 'Point', coordinates: [500000.123, 4400000.456, 850.789] }, { ad: 'Ölçüm' }),
  obje(null),
  obje({ type: 'LineString', coordinates: [[512345.678, 4412345.987], [512345.679, 4412345.988]] }),
)

describe('pcdYaz', () => {
  it('ascii: v0.7 başlığı, double x y z + label (obje sırası), tam hassasiyet', async () => {
    const { veri, uyarilar } = await pcdYaz(girdi(), { crs: 'EPSG:5255' })
    expect(typeof veri).toBe('string')
    const { baslik, noktalar } = pcdOku(veri)
    expect(baslik.VERSION).toEqual(['0.7'])
    expect(baslik.FIELDS).toEqual(['x', 'y', 'z', 'label'])
    expect(baslik.SIZE).toEqual(['8', '8', '8', '4'])
    expect(baslik.TYPE).toEqual(['F', 'F', 'F', 'U'])
    expect(baslik.WIDTH).toEqual(['3'])
    expect(baslik.HEIGHT).toEqual(['1'])
    expect(baslik.POINTS).toEqual(['3'])
    expect(baslik.VIEWPOINT).toEqual(['0', '0', '0', '1', '0', '0', '0'])
    expect(noktalar).toEqual([
      [500000.123, 4400000.456, 850.789, 0],
      [512345.678, 4412345.987, 0, 2],
      [512345.679, 4412345.988, 0, 2],
    ])
    expect(uyarilar.join(' ')).toMatch(/1 obje boş \(null\)/)
    expect(uyarilar.join(' ')).toMatch(/2 noktada Z değeri yoktu/)
  })

  it('binary: aynı noktaları double olarak birebir taşır (float32 olsaydı mm kaybolurdu)', async () => {
    const { veri, onizleme } = await pcdYaz(girdi(), { ikili: true })
    expect(veri).toBeInstanceOf(Uint8Array)
    const { baslik, noktalar } = pcdOku(veri)
    expect(baslik.DATA).toEqual(['binary'])
    expect(noktalar[1]).toEqual([512345.678, 4412345.987, 0, 2])
    expect(noktalar[2][0] - noktalar[1][0]).toBeCloseTo(0.001, 9)
    expect(Math.fround(512345.678)).not.toBe(512345.678) // gerekçe: float32 yetersiz
    expect(onizleme).toContain('DATA binary')
  })

  it('boş FC: 0 noktalı geçerli PCD + uyarı', async () => {
    const { veri, uyarilar } = await pcdYaz(fc())
    const { baslik, noktalar } = pcdOku(veri)
    expect(baslik.POINTS).toEqual(['0'])
    expect(noktalar).toEqual([])
    expect(uyarilar.join(' ')).toMatch(/0 nokta/)
    const ikili = await pcdYaz(fc(), { ikili: true })
    expect(pcdOku(ikili.veri).noktalar).toEqual([])
  })
})
