import { describe, it, expect } from 'vitest'
import { igesYaz, igesAscii, hollerith } from './iges.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
const kare = (x, y, b) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]]
const ZAMAN = '2026-01-02T03:04:05Z'

/** Hollerith farkında parametre ayrıştırıcı (ayraç ',' ve ';'). */
function parametreler(metin) {
  const sonuc = []
  let i = 0
  let alan = ''
  while (i < metin.length) {
    const m = /^(\d+)H/.exec(metin.slice(i))
    if (alan === '' && m) {
      const n = Number(m[1])
      const bas = i + m[0].length
      sonuc.push({ dize: metin.slice(bas, bas + n) })
      i = bas + n
      if (metin[i] === ',' || metin[i] === ';') i++
      continue
    }
    const c = metin[i++]
    if (c === ',' || c === ';') {
      sonuc.push(alan.trim())
      alan = ''
      if (c === ';') break
    } else alan += c
  }
  return sonuc
}

/** IGES ayrıştırıcı: sütun düzeni, sıra numaraları, D/P çapraz işaretçileri, T sayımları. */
function ayristir(metin, satirSonu = '\r\n') {
  expect(metin.endsWith(satirSonu)).toBe(true)
  const satirlar = metin.slice(0, -satirSonu.length).split(satirSonu)
  const bolumler = { S: [], G: [], D: [], P: [], T: [] }
  let onceki = 'S'
  for (const s of satirlar) {
    expect(s).toHaveLength(80)
    expect(s).toMatch(/^[\x20-\x7e]{80}$/)
    const b = s[72]
    expect('SGDPT'.indexOf(b)).toBeGreaterThanOrEqual('SGDPT'.indexOf(onceki))
    onceki = b
    bolumler[b].push(s)
    expect(Number(s.slice(73))).toBe(bolumler[b].length)
  }
  expect(bolumler.T).toHaveLength(1)
  const t = bolumler.T[0]
  expect(t.slice(0, 32)).toMatch(/^S[ \d]{7}G[ \d]{7}D[ \d]{7}P[ \d]{7}$/)
  const sayim = (h) => Number(t.slice(t.indexOf(h) + 1, t.indexOf(h) + 8))
  for (const h of 'SGDP') expect(sayim(h)).toBe(bolumler[h].length)
  expect(bolumler.D.length % 2).toBe(0)

  const global = parametreler(bolumler.G.map((s) => s.slice(0, 72)).join(''))
  const alanlar = (s) => Array.from({ length: 9 }, (_, i) => s.slice(i * 8, i * 8 + 8).trim())
  const varliklar = []
  for (let i = 0; i < bolumler.D.length; i += 2) {
    const [a, b] = [alanlar(bolumler.D[i]), alanlar(bolumler.D[i + 1])]
    expect(a[0]).toBe(b[0])
    const pBas = Number(a[1])
    const pSayi = Number(b[3])
    const pSatirlari = bolumler.P.slice(pBas - 1, pBas - 1 + pSayi)
    expect(pSatirlari).toHaveLength(pSayi)
    for (const p of pSatirlari) expect(Number(p.slice(65, 72))).toBe(i + 1) // P → D geri işaretçisi
    const parametre = parametreler(pSatirlari.map((p) => p.slice(0, 64)).join(''))
    expect(Number(parametre[0])).toBe(Number(a[0]))
    varliklar.push({ tip: Number(a[0]), level: Number(a[4]), durum: a[8], form: Number(b[4]), etiket: b[7], alt: Number(b[8]), parametre: parametre.map(Number) })
  }
  // Tüm P satırları bir varlığa ait olmalı
  expect(varliklar.reduce((t, v, i) => t + Number(alanlar(bolumler.D[i * 2 + 1])[3]), 0)).toBe(bolumler.P.length)
  return { bolumler, global, varliklar }
}

describe('IGES yardımcıları', () => {
  it('ASCII dönüşümü ve Hollerith', () => {
    expect(igesAscii('Çığ Şişli Ölçü é 日')).toBe('Cig Sisli Olcu e ?')
    expect(hollerith('Ağaç')).toBe('4HAgac')
  })
})

describe('igesYaz', () => {
  it('boş FC için geçerli S/G/T yapısı; global birim metre', async () => {
    const { veri, uyarilar } = await igesYaz(fc(), { zaman: ZAMAN, dosyaAdi: 'Ölçüm.igs' })
    const d = ayristir(veri)
    expect(d.varliklar).toEqual([])
    const g = d.global
    expect(g[0]).toEqual({ dize: ',' })
    expect(g[1]).toEqual({ dize: ';' })
    expect(g[3]).toEqual({ dize: 'Olcum.igs' })
    expect(g[13]).toBe('6')
    expect(g[14]).toEqual({ dize: 'M' })
    expect(g[17]).toEqual({ dize: '20260102.030405' })
    expect(g[22]).toBe('11')
    expect(uyarilar).toEqual([])
  })

  it('Point → 116, çizgi/halka → 106 form 12; koordinatlar ve işaretçiler doğru', async () => {
    const uzun = Array.from({ length: 40 }, (_, i) => [500000.123 + i, 4400000.456 + i * 2, i])
    const { veri, uyarilar } = await igesYaz(
      fc(
        obje({ type: 'Point', coordinates: [1.5, 2.5, 3.5] }, { ad: 'Röper Noktası' }),
        obje({ type: 'LineString', coordinates: uzun }, { name: 'Yol' }),
        obje({ type: 'Polygon', coordinates: [kare(0, 0, 10), kare(2, 2, 2)] }, { ad: 'Parsel' }),
        obje({ type: 'MultiPoint', coordinates: [[7, 8], [9, 10]] }),
        obje(null),
      ),
      { zaman: ZAMAN },
    )
    expect(uyarilar).toContain('1 obje geometrisiz olduğu için yazılmadı.')
    const d = ayristir(veri)
    expect(d.varliklar.map((v) => [v.tip, v.form])).toEqual([[116, 0], [106, 12], [106, 12], [106, 12], [116, 0], [116, 0]])
    const [nokta, cizgi, dis, delik, m1] = d.varliklar
    expect(nokta.parametre).toEqual([116, 1.5, 2.5, 3.5, 0])
    expect(nokta.etiket).toBe('Roper_No') // ASCII'ye çevrilmiş, 8 karakter
    expect(cizgi.parametre.slice(0, 3)).toEqual([106, 2, 40])
    const koseler = (v) => Array.from({ length: v.parametre[2] }, (_, i) => v.parametre.slice(3 + i * 3, 6 + i * 3))
    expect(koseler(cizgi)).toEqual(uzun)
    expect(d.bolumler.P.length).toBeGreaterThan(d.varliklar.length) // çok satırlı parametre verisi
    // Kapalı halka: 4 köşe + kapanış
    expect(koseler(dis)).toEqual([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0]])
    expect(koseler(delik)[0]).toEqual(koseler(delik).at(-1))
    expect([dis.etiket, dis.alt, delik.alt]).toEqual(['Parsel', 1, 2])
    expect(m1.parametre).toEqual([116, 7, 8, 0, 0])
    expect(d.varliklar.every((v) => v.durum === '00000000')).toBe(true)
    // Global 20: en büyük koordinat
    expect(Number(d.global[19])).toBe(4400000.456 + 39 * 2)
  })

  it('katmanı level alanına sayısal eşler ve uyarır', async () => {
    const { veri, uyarilar } = await igesYaz(
      fc(
        obje({ type: 'Point', coordinates: [0, 0] }, { layer: 'Bina' }),
        obje({ type: 'Point', coordinates: [0, 0] }, { katman: '1' }),
        obje({ type: 'Point', coordinates: [0, 0] }, { tabaka: 'Yol' }),
        obje({ type: 'Point', coordinates: [0, 0] }),
      ),
    )
    expect(ayristir(veri).varliklar.map((v) => v.level)).toEqual([2, 1, 3, 4])
    expect(uyarilar.find((u) => u.includes('IGES level'))).toBe('3 katman adı sayısal IGES level numarasına eşlendi: "Bina" → 2, "Yol" → 3, "NOKTA" → 4.')
  })

  it('LF satır sonu seçeneği ve coğrafi CRS uyarısı', async () => {
    const { veri, uyarilar } = await igesYaz(fc(obje({ type: 'Point', coordinates: [32, 39] })), { satirSonu: '\n', crs: 'EPSG:4326' })
    expect(veri.includes('\r')).toBe(false)
    expect(ayristir(veri, '\n').varliklar).toHaveLength(1)
    expect(uyarilar.some((u) => u.includes('coğrafi'))).toBe(true)
  })
})
