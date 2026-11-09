import { describe, it, expect } from 'vitest'
import { lasYaz, geoAnahtarDizini } from './las.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
const ascii = (u8, o, n) => new TextDecoder().decode(u8.subarray(o, o + n)).replace(/\0+$/, '')

/** Asgari LAS 1.2 okuyucu. */
function lasOku(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const f64 = (o) => dv.getFloat64(o, true)
  const h = {
    imza: ascii(u8, 0, 4),
    surum: [u8[24], u8[25]],
    yazilim: ascii(u8, 58, 32),
    baslikBoyu: dv.getUint16(94, true),
    noktaOfseti: dv.getUint32(96, true),
    vlrSayisi: dv.getUint32(100, true),
    format: u8[104],
    kayitBoyu: dv.getUint16(105, true),
    adet: dv.getUint32(107, true),
    donusler: [0, 1, 2, 3, 4].map((i) => dv.getUint32(111 + 4 * i, true)),
    olcek: [f64(131), f64(139), f64(147)],
    oteleme: [f64(155), f64(163), f64(171)],
    max: [f64(179), f64(195), f64(211)],
    min: [f64(187), f64(203), f64(219)],
  }
  const vlrler = []
  let o = h.baslikBoyu
  for (let i = 0; i < h.vlrSayisi; i++) {
    const uzunluk = dv.getUint16(o + 20, true)
    const v = { kullanici: ascii(u8, o + 2, 16), kayit: dv.getUint16(o + 18, true), veri: [] }
    for (let k = 0; k < uzunluk / 2; k++) v.veri.push(dv.getUint16(o + 54 + 2 * k, true))
    vlrler.push(v)
    o += 54 + uzunluk
  }
  const noktalar = []
  for (let i = 0; i < h.adet; i++) {
    const p = h.noktaOfseti + i * h.kayitBoyu
    noktalar.push({
      x: dv.getInt32(p, true) * h.olcek[0] + h.oteleme[0],
      y: dv.getInt32(p + 4, true) * h.olcek[1] + h.oteleme[1],
      z: dv.getInt32(p + 8, true) * h.olcek[2] + h.oteleme[2],
      ham: [dv.getInt32(p, true), dv.getInt32(p + 4, true), dv.getInt32(p + 8, true)],
      donusBayti: u8[p + 14],
      sinif: u8[p + 15],
      kaynak: dv.getUint16(p + 18, true),
    })
  }
  return { h, vlrler, noktalar, boy: u8.length }
}

describe('lasYaz', () => {
  it('LAS 1.2 başlığı (227 bayt), format 0, ölçek/öteleme, dönüş dizisi, min/max ve gidiş-dönüş', async () => {
    const girdi = fc(
      obje({ type: 'Point', coordinates: [500000.1234, 4400000.5678, 850.25] }, { ad: 'Ağrı Dağı' }),
      obje(null),
      obje({ type: 'Polygon', coordinates: [[[500100, 4400100, 900], [500200, 4400100, 901], [500200, 4400200, 902.5], [500100, 4400100, 900]]] }),
    )
    const { veri, uyarilar, onizleme } = await lasYaz(girdi, { crs: 'EPSG:5255', tarih: new Date(Date.UTC(2026, 1, 1)) })
    const { h, vlrler, noktalar, boy } = lasOku(veri)
    expect(h.imza).toBe('LASF')
    expect(h.surum).toEqual([1, 2])
    expect(h.yazilim).toBe('GeoConverterProEA')
    expect(h.baslikBoyu).toBe(227)
    expect(h.format).toBe(0)
    expect(h.kayitBoyu).toBe(20)
    expect(h.adet).toBe(4)
    expect(h.donusler).toEqual([4, 0, 0, 0, 0])
    expect(h.olcek).toEqual([0.001, 0.001, 0.001])
    expect(h.oteleme).toEqual([500000, 4400000, 850])
    expect(h.noktaOfseti).toBe(227 + 54 + 2 * 20)
    expect(boy).toBe(h.noktaOfseti + 4 * 20)
    expect(new DataView(veri.buffer).getUint16(90, true)).toBe(32) // 1 Şubat = yılın 32. günü
    expect(new DataView(veri.buffer).getUint16(92, true)).toBe(2026)

    const bek = [[500000.1234, 4400000.5678, 850.25, 0], [500100, 4400100, 900, 2], [500200, 4400100, 901, 2], [500200, 4400200, 902.5, 2]]
    noktalar.forEach((p, i) => {
      expect(Math.abs(p.x - bek[i][0])).toBeLessThanOrEqual(0.0005 + 1e-9)
      expect(Math.abs(p.y - bek[i][1])).toBeLessThanOrEqual(0.0005 + 1e-9)
      expect(Math.abs(p.z - bek[i][2])).toBeLessThanOrEqual(0.0005 + 1e-9)
      expect(p.kaynak).toBe(bek[i][3])
      expect(p.sinif).toBe(1)
      expect(p.donusBayti & 7).toBe(1)
      expect((p.donusBayti >> 3) & 7).toBe(1)
      expect(p.ham.every((v) => v >= 0)).toBe(true)
    })
    expect(h.min[0]).toBeCloseTo(500000.123, 6)
    expect(h.max).toEqual([500200, 4400200, 902.5])

    expect(vlrler).toHaveLength(1)
    expect(vlrler[0].kullanici).toBe('LASF_Projection')
    expect(vlrler[0].kayit).toBe(34735)
    // [sürüm 1, revizyon 1, alt 0, anahtar sayısı 4] + anahtarlar (ID, konum, sayı, değer)
    expect(vlrler[0].veri).toEqual([1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 5255, 3076, 0, 1, 9001])
    expect(uyarilar.join(' ')).toMatch(/1 obje boş \(null\)/)
    expect(onizleme).toContain('EPSG:5255 (ProjectedCSTypeGeoKey 3072)')
  })

  it('coğrafi CRS: 1e-7 ölçek, GeographicTypeGeoKey 2048; INT32 taşması ölçek büyütülerek önlenir', async () => {
    const { veri } = await lasYaz(fc(obje({ type: 'Point', coordinates: [32.8543211, 39.9208765, 938] })), { crs: 'EPSG:4326' })
    const { h, vlrler, noktalar } = lasOku(veri)
    expect(h.olcek).toEqual([1e-7, 1e-7, 0.001])
    expect(h.oteleme).toEqual([32, 39, 938])
    expect(noktalar[0].x).toBeCloseTo(32.8543211, 7)
    expect(noktalar[0].y).toBeCloseTo(39.9208765, 7)
    expect(vlrler[0].veri).toEqual(geoAnahtarDizini(4326))
    expect(vlrler[0].veri.slice(4)).toEqual([1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326])

    const genis = await lasYaz(fc(obje({ type: 'MultiPoint', coordinates: [[-179.5, 0], [179.5, 1]] })), { crs: 'EPSG:4326' })
    const g = lasOku(genis.veri)
    expect(g.h.olcek[0]).toBeCloseTo(1e-6, 15)
    expect(genis.uyarilar.join(' ')).toMatch(/X aralığı .* INT32'ye sığmadı/)
    expect(g.noktalar[1].x).toBeCloseTo(179.5, 5)
  })

  it('Point Source ID 65535 üstünde sarılır ve uyarılır', async () => {
    const objeler = Array.from({ length: 65538 }, (_, i) => obje(i < 65535 ? null : { type: 'Point', coordinates: [i, 0, 0] }))
    const { veri, uyarilar } = await lasYaz(fc(...objeler))
    const { noktalar } = lasOku(veri)
    expect(noktalar.map((p) => p.kaynak)).toEqual([65535, 0, 1])
    expect(uyarilar.join(' ')).toMatch(/2 noktanın obje sırası 65535'i aşıyor/)
  })

  it('CRS yoksa ya da 16 bite sığmıyorsa VLR yazılmaz; Z yoksa 0 + uyarı', async () => {
    const a = await lasYaz(fc(obje({ type: 'Point', coordinates: [500000, 4400000] })))
    expect(lasOku(a.veri).h.vlrSayisi).toBe(0)
    expect(lasOku(a.veri).noktalar[0].z).toBe(0)
    expect(a.uyarilar.join(' ')).toMatch(/GeoKey \(CRS\) VLR yazılmadı/)
    expect(a.uyarilar.join(' ')).toMatch(/Veride Z/)
    const b = await lasYaz(fc(obje({ type: 'Point', coordinates: [1, 2, 3] })), { crs: 'EPSG:102100x' })
    expect(lasOku(b.veri).h.vlrSayisi).toBe(0)
  })

  it('boş FC: 0 noktalı geçerli LAS + uyarı', async () => {
    const { veri, uyarilar } = await lasYaz(fc(), { crs: 'EPSG:5255' })
    const { h, boy } = lasOku(veri)
    expect(h.adet).toBe(0)
    expect(h.donusler).toEqual([0, 0, 0, 0, 0])
    expect(boy).toBe(h.noktaOfseti)
    expect(uyarilar.join(' ')).toMatch(/0 nokta/)
  })
})
