import { describe, it, expect } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { e57Yaz, crc32c, fizikselOfset, SAYFA, SAYFA_VERI } from './e57.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
const E57_NS = 'http://www.astm.org/COMMIT/E57/2010-e57-v1.0'

/**
 * Asgari bağımsız E57 okuyucu: her sayfanın CRC-32C'sini (büyük endian) doğrular, mantıksal
 * akışı kurar, başlığı + XML'i ayrıştırır, CompressedVector veri paketlerini çözer.
 */
function e57Oku(veri) {
  expect(veri.length % SAYFA).toBe(0)
  const sayfa = veri.length / SAYFA
  const fdv = new DataView(veri.buffer, veri.byteOffset, veri.byteLength)
  const mantiksal = new Uint8Array(sayfa * SAYFA_VERI)
  for (let s = 0; s < sayfa; s++) {
    const crc = fdv.getUint32(s * SAYFA + SAYFA_VERI, false)
    expect(crc, `sayfa ${s} CRC`).toBe(crc32c(veri.subarray(s * SAYFA, s * SAYFA + SAYFA_VERI)))
    mantiksal.set(veri.subarray(s * SAYFA, s * SAYFA + SAYFA_VERI), s * SAYFA_VERI)
  }
  const mantiksalOfset = (p) => Math.floor(p / SAYFA) * SAYFA_VERI + (p % SAYFA)
  const dv = new DataView(mantiksal.buffer)
  const u64 = (o) => Number(dv.getBigUint64(o, true))
  const baslik = {
    imza: new TextDecoder().decode(mantiksal.subarray(0, 8)),
    surum: [dv.getUint32(8, true), dv.getUint32(12, true)],
    fizikselUzunluk: u64(16),
    xmlFizikselOfset: u64(24),
    xmlMantiksalUzunluk: u64(32),
    sayfaBoyu: u64(40),
  }
  const xmlBas = mantiksalOfset(baslik.xmlFizikselOfset)
  const xmlMetni = new TextDecoder().decode(mantiksal.subarray(xmlBas, xmlBas + baslik.xmlMantiksalUzunluk))
  const hatalar = []
  const doc = new DOMParser({ onError: (_d, m) => hatalar.push(m) }).parseFromString(xmlMetni, 'text/xml')
  expect(hatalar).toEqual([])
  const kok = doc.documentElement

  const taramalar = []
  const data3D = kok.getElementsByTagNameNS(E57_NS, 'data3D')[0]
  for (const cocuk of Array.from(data3D.childNodes).filter((n) => n.nodeType === 1)) {
    const points = cocuk.getElementsByTagNameNS(E57_NS, 'points')[0]
    const kayit = Number(points.getAttribute('recordCount'))
    const bolum = mantiksalOfset(Number(points.getAttribute('fileOffset')))
    const alanlar = Array.from(points.getElementsByTagNameNS(E57_NS, 'prototype')[0].childNodes)
      .filter((n) => n.nodeType === 1).map((n) => [n.localName, n.getAttribute('type'), n.getAttribute('precision') || 'double'])
    expect(mantiksal[bolum]).toBe(1) // sectionId
    expect(Array.from(mantiksal.subarray(bolum + 1, bolum + 8))).toEqual([0, 0, 0, 0, 0, 0, 0])
    const bolumUzunlugu = u64(bolum + 8)
    expect(bolumUzunlugu % 4).toBe(0)
    let p = mantiksalOfset(u64(bolum + 16))
    expect(u64(bolum + 24)).toBe(0) // indeks paketi yok
    const akislar = alanlar.map(() => [])
    let paket = 0
    while (akislar[0].length < kayit) {
      expect(mantiksal[p]).toBe(1) // DATA_PACKET
      const uzunluk = dv.getUint16(p + 2, true) + 1
      expect(uzunluk % 4).toBe(0)
      const n = dv.getUint16(p + 4, true)
      expect(n).toBe(alanlar.length)
      const boylar = Array.from({ length: n }, (_, i) => dv.getUint16(p + 6 + 2 * i, true))
      let o = p + 6 + 2 * n
      boylar.forEach((b, i) => {
        for (let k = 0; k < b; k += 8) akislar[i].push(dv.getFloat64(o + k, true))
        o += b
      })
      expect(o).toBeLessThanOrEqual(p + uzunluk)
      p += uzunluk
      paket++
    }
    expect(p).toBe(bolum + bolumUzunlugu)
    const sinir = cocuk.getElementsByTagNameNS(E57_NS, 'cartesianBounds')[0]
    const deger = (ad) => Number(sinir.getElementsByTagNameNS(E57_NS, ad)[0].textContent)
    taramalar.push({
      kayit, alanlar, paket,
      ad: cocuk.getElementsByTagNameNS(E57_NS, 'name')[0].textContent,
      noktalar: akislar[0].map((_, i) => akislar.map((a) => a[i])),
      sinir: ['xMinimum', 'xMaximum', 'yMinimum', 'yMaximum', 'zMinimum', 'zMaximum'].map(deger),
    })
  }
  const metin = (ad) => kok.getElementsByTagNameNS(E57_NS, ad)[0]?.textContent
  return { baslik, kok, taramalar, metin, xmlMetni }
}

describe('E57 yardımcıları', () => {
  it('CRC-32C (Castagnoli) test vektörü; CRC-32 değil', () => {
    const b = new TextEncoder().encode('123456789')
    expect(crc32c(b)).toBe(0xe3069283)
    expect(crc32c(b)).not.toBe(0xcbf43926) // CRC-32/ISO-HDLC
  })
  it('mantıksal → fiziksel ofset sayfa sınırında 4 bayt CRC atlar', () => {
    expect(fizikselOfset(0)).toBe(0)
    expect(fizikselOfset(1019)).toBe(1019)
    expect(fizikselOfset(1020)).toBe(1024)
    expect(fizikselOfset(2041)).toBe(2049)
  })
})

describe('e57Yaz', () => {
  it('başlık, sayfa CRC\'leri, XML ve çok paketli/çok sayfalı noktalar gidiş-dönüş', async () => {
    const n = 5000
    const koordinatlar = Array.from({ length: n }, (_, i) => [500000 + i * 0.001, 4400000 - i * 0.01, 800 + (i % 7)])
    const girdi = fc(
      obje({ type: 'MultiPoint', coordinates: koordinatlar }, { ad: 'Tarama' }),
      obje(null),
      obje({ type: 'Polygon', coordinates: [[[1, 1, 1], [2, 1, 1], [2, 2, 1], [1, 1, 1]]] }),
    )
    const { veri, uyarilar, onizleme } = await e57Yaz(girdi, { crs: 'EPSG:5255', ad: 'Çankaya taraması' })
    const { baslik, taramalar, metin, kok } = e57Oku(veri)
    expect(baslik).toMatchObject({ imza: 'ASTM-E57', surum: [1, 0], fizikselUzunluk: veri.length, sayfaBoyu: 1024 })
    expect(kok.localName).toBe('e57Root')
    expect(kok.getAttribute('type')).toBe('Structure')
    expect(metin('formatName')).toBe('ASTM E57 3D Imaging Data File')
    expect(metin('versionMajor')).toBe('1')
    expect(metin('guid')).toMatch(/^\{[0-9A-F-]{36}\}$/)
    expect(metin('coordinateMetadata')).toContain('PROJCS["TUREF_TM33"')
    expect(taramalar).toHaveLength(1)
    const [t] = taramalar
    expect(t.ad).toBe('Çankaya taraması')
    expect(t.kayit).toBe(n + 3)
    expect(t.paket).toBe(3) // 2048 kayıt/paket
    expect(t.alanlar).toEqual([['cartesianX', 'Float', 'double'], ['cartesianY', 'Float', 'double'], ['cartesianZ', 'Float', 'double']])
    expect(t.noktalar.slice(0, n)).toEqual(koordinatlar)
    expect(t.noktalar.slice(n)).toEqual([[1, 1, 1], [2, 1, 1], [2, 2, 1]])
    expect(t.sinir).toEqual([1, 500000 + (n - 1) * 0.001, 1, 4400000, 1, 806])
    expect(veri.length / SAYFA).toBeGreaterThan(100)
    expect(uyarilar.join(' ')).toMatch(/1 obje boş \(null\)/)
    expect(onizleme).toContain('<e57Root')
  })

  it('bozulmuş bir bayt CRC denetimine takılır', async () => {
    const { veri } = await e57Yaz(fc(obje({ type: 'Point', coordinates: [1, 2, 3] })))
    const bozuk = veri.slice()
    bozuk[60] ^= 0xff
    expect(() => e57Oku(bozuk)).toThrow(/sayfa 0 CRC/)
  })

  it('Z yoksa 0; CRS yoksa coordinateMetadata yok; bilinmeyen kodda yalnız kod', async () => {
    const a = await e57Yaz(fc(obje({ type: 'LineString', coordinates: [[1, 2], [3, 4]] })))
    const ra = e57Oku(a.veri)
    expect(ra.taramalar[0].noktalar).toEqual([[1, 2, 0], [3, 4, 0]])
    expect(ra.metin('coordinateMetadata')).toBeUndefined()
    expect(a.uyarilar.join(' ')).toMatch(/Veride Z/)
    const b = await e57Yaz(fc(obje({ type: 'Point', coordinates: [1, 2, 3] })), { crs: 'EPSG:2320' })
    expect(e57Oku(b.veri).metin('coordinateMetadata')).toBe('EPSG:2320')
  })

  it('boş FC: data3D boş, geçerli tek sayfalık E57 + uyarı', async () => {
    const { veri, uyarilar } = await e57Yaz(fc(), { crs: 'EPSG:4326' })
    const { taramalar, baslik } = e57Oku(veri)
    expect(taramalar).toEqual([])
    expect(baslik.fizikselUzunluk).toBe(veri.length)
    expect(uyarilar.join(' ')).toMatch(/tarama \(data3D\) içermiyor/)
  })
})
