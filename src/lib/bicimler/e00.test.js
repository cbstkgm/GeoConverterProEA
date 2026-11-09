import { describe, it, expect } from 'vitest'
import { e00Yaz, e00Gercel } from './e00.js'

const kare = (x, y, b) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]]
const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })

const coz = (veri) => new TextDecoder('windows-1254').decode(veri)
const int = (s, i, n = 10) => Number(s.slice(i, i + n))
const alan = (h) => h.slice(0, -1).reduce((t, [x0, y0], i) => t + x0 * h[i + 1][1] - h[i + 1][0] * y0, 0) / 2

/** Bölümleri ve tabloları GDAL AVC ayrıştırıcısının sütun konumlarıyla çözen küçük okuyucu. */
function e00Oku(metin) {
  const s = metin.split('\n')
  expect(s.at(-1)).toBe('')
  s.pop()
  expect(s[0].startsWith('EXP  0 ')).toBe(true)
  expect(s.at(-1)).toBe('EOS')
  const r = { sirala: [], arc: [], lab: [], pal: [], tol: [], prj: null, tablolar: {} }
  let i = 1
  const sayi21 = (l, k) => Number(l.slice(k * 21, k * 21 + 21))
  while (i < s.length) {
    const b = s[i++]
    r.sirala.push(b.slice(0, 3))
    if (b === 'ARC  3') {
      while (!s[i].startsWith('        -1')) {
        const h = s[i++]
        expect(h).toHaveLength(70)
        const n = int(h, 60)
        const c = []
        for (let k = 0; k < n; k++) {
          expect(s[i]).toHaveLength(42)
          c.push([sayi21(s[i], 0), sayi21(s[i], 1)])
          i++
        }
        r.arc.push({ id: int(h, 0), kullanici: int(h, 10), fnode: int(h, 20), tnode: int(h, 30), sol: int(h, 40), sag: int(h, 50), c })
      }
      expect(s[i++]).toBe('        -1         0         0         0         0         0         0')
    } else if (b === 'LAB  3') {
      while (!s[i].startsWith('        -1')) {
        const h = s[i]
        expect(h).toHaveLength(62)
        r.lab.push({ deger: int(h, 0), poligon: int(h, 10), k: [Number(h.slice(20, 41)), Number(h.slice(41, 62))] })
        expect(s[i + 1]).toHaveLength(42)
        i += 3
      }
      expect(s[i++]).toBe('        -1         0 0.00000000000000E+00 0.00000000000000E+00')
    } else if (b === 'PAL  3') {
      while (!s[i].startsWith('        -1')) {
        const h = s[i++]
        expect(h).toHaveLength(52)
        const n = int(h, 0)
        expect(s[i++]).toHaveLength(42)
        const ylar = []
        if (n === 0) i++
        for (let k = 0; k < n; k += 2) {
          const l = s[i++]
          for (let m = 0; m < l.length; m += 30) ylar.push([int(l, m), int(l, m + 10), int(l, m + 20)])
        }
        r.pal.push(ylar)
      }
      i += 2
    } else if (b === 'TOL  3') {
      while (!s[i].startsWith('        -1')) r.tol.push(s[i++])
      i++
    } else if (b === 'SIN  3') expect(s[i++]).toBe('EOX')
    else if (b === 'PRJ  3') {
      r.prj = []
      while (s[i] !== 'EOP') {
        r.prj.push(s[i])
        expect(s[i + 1]).toBe('~')
        i += 2
      }
      i++
    } else if (b === 'IFO  3') {
      while (s[i] !== 'EOI') {
        const h = s[i++]
        expect(h).toHaveLength(56)
        expect(h.slice(32, 34)).toBe('XX')
        const ad = h.slice(0, 32).trim()
        const nAlan = int(h, 34, 4)
        const nKayit = int(h, 46, 10)
        const alanlar = []
        for (let k = 0; k < nAlan; k++) {
          const l = s[i++]
          expect(l).toHaveLength(70)
          expect(l.at(-1)).toBe('-')
          alanlar.push({ ad: l.slice(0, 16).trim(), boyut: int(l, 16, 3), ofset: int(l, 21, 4), tip: int(l, 34, 3), indeks: int(l, 65, 4) })
        }
        const genislik = (a) => (a.tip === 50 ? 11 : a.tip === 60 ? 24 : a.boyut)
        const toplam = alanlar.reduce((t, a) => t + genislik(a), 0)
        const kayitlar = []
        for (let k = 0; k < nKayit; k++) {
          let metin = ''
          for (let okunan = 0; okunan < toplam; okunan += 80) {
            const l = s[i++]
            expect(l.length).toBeLessThanOrEqual(80)
            metin += l.padEnd(Math.min(80, toplam - okunan))
          }
          let o = 0
          const kayit = {}
          for (const a of alanlar) {
            const parca = metin.slice(o, o + genislik(a))
            o += genislik(a)
            kayit[a.ad] = a.tip === 20 ? parca.trimEnd() : Number(parca)
          }
          kayitlar.push(kayit)
        }
        r.tablolar[ad] = { alanlar, kayitlar, kayitBoyu: int(h, 42, 4) }
      }
      i++
    } else if (b === 'EOS') break
    else throw new Error(`beklenmeyen satır ${i}: "${b}"`)
  }
  return r
}

describe('e00Gercel', () => {
  it('C printf %17.14E / %20.17E ile birebir', () => {
    expect(e00Gercel(500123.456)).toBe(' 5.00123456000000E+05')
    expect(e00Gercel(-0.000123)).toBe('-1.23000000000000E-04')
    expect(e00Gercel(0)).toBe(' 0.00000000000000E+00')
    expect(e00Gercel(1.5, 7)).toBe(' 1.5000000E+00')
    expect(e00Gercel(4400987.654, 17)).toHaveLength(24)
    expect(e00Gercel(-4400987.654)).toHaveLength(21)
  })
})

describe('e00Yaz', () => {
  it('çizgi + poligon kapsamı: ARC, LAB, PAL, TOL, PRJ, IFO (AAT/BND/PAT/TIC) birebir sütunlarla', async () => {
    const delikli = [kare(500000, 4400000, 100), kare(500010, 4400010, 10)]
    const { veri, uyarilar, onizleme } = await e00Yaz(
      fc(
        obje({ type: 'LineString', coordinates: [[500000, 4400000], [500030, 4400040]] }, { ad: 'Yol Şişli', serit: 2 }),
        obje({ type: 'Polygon', coordinates: delikli }, { ada: 101, parsel: 7, malik: 'Çağrı Öğüt İı', oran: 0.25 }),
        obje(null, { ad: 'geometrisiz' }),
      ),
      { crs: 'EPSG:5255' },
    )
    expect(veri).toBeInstanceOf(Uint8Array)
    expect(onizleme).toContain('ARC  3')
    expect(uyarilar).toEqual(['Geometrisi olmayan 1 obje E00\'a yazılmadı (kapsam objeleri geometri gerektirir).'])
    const e = e00Oku(coz(veri))
    expect(e.sirala).toEqual(['ARC', 'LAB', 'PAL', 'TOL', 'SIN', 'PRJ', 'IFO', 'EOS'])

    // ARC: 1 çizgi + 2 halka yayı
    expect(e.arc).toHaveLength(3)
    expect(e.arc[0]).toMatchObject({ id: 1, kullanici: 1, fnode: 1, tnode: 2, sol: 0, sag: 0, c: [[500000, 4400000], [500030, 4400040]] })
    const [, dis, delik] = e.arc
    expect(dis).toMatchObject({ sol: 1, sag: 2 })
    expect(dis.fnode).toBe(dis.tnode)
    expect(alan(dis.c)).toBeLessThan(0) // saat yönü: poligon sağda
    expect(alan(delik.c)).toBeGreaterThan(0)
    expect(dis.c).toHaveLength(5)

    // LAB: poligon etiketi delikte değil
    expect(e.lab).toHaveLength(1)
    expect(e.lab[0]).toMatchObject({ deger: 1, poligon: 2 })
    const [lx, ly] = e.lab[0].k
    expect(lx > 500010 && lx < 500020 && ly > 4400010 && ly < 4400020).toBe(false)

    // PAL: evren (1) + poligon (2)
    expect(e.pal).toEqual([[[-2, dis.fnode, 2]], [[2, dis.fnode, 1], [3, delik.fnode, 1]]])

    expect(e.tol).toHaveLength(10)
    expect(e.prj).toEqual([
      'Projection    TRANSVERSE', 'Spheroid      GRS80', 'Units         METERS', 'Zunits        NO',
      'Xshift        0.0000000000', 'Yshift        0.0000000000', 'Parameters',
      '  1.00000000 /* scale factor at central meridian', ' 33  0  0.00 /* longitude of central meridian',
      '  0  0  0.00 /* latitude of origin', '500000.00000 /* false easting (meters)', '0.00000 /* false northing (meters)',
    ])

    const aat = e.tablolar['OBJELER.AAT']
    expect(aat.alanlar.map((a) => a.ad)).toEqual(['FNODE#', 'TNODE#', 'LPOLY#', 'RPOLY#', 'LENGTH', 'OBJELER#', 'OBJELER-ID', 'AD', 'SERIT'])
    expect(aat.alanlar.map((a) => a.ofset)).toEqual([1, 5, 9, 13, 17, 25, 29, 33, 42])
    expect(aat.kayitlar).toHaveLength(3)
    expect(aat.kayitlar[0]).toMatchObject({ 'FNODE#': 1, 'TNODE#': 2, LENGTH: 50, 'OBJELER#': 1, 'OBJELER-ID': 1, AD: 'Yol Şişli', SERIT: 2 })
    expect(aat.kayitlar[1]).toMatchObject({ 'LPOLY#': 1, 'RPOLY#': 2, AD: '', SERIT: 0 })

    const pat = e.tablolar['OBJELER.PAT']
    expect(pat.alanlar.map((a) => [a.ad, a.tip])).toEqual([['AREA', 60], ['PERIMETER', 60], ['OBJELER#', 50], ['OBJELER-ID', 50], ['ADA', 50], ['PARSEL', 50], ['MALIK', 20], ['ORAN', 60]])
    expect(pat.kayitlar).toHaveLength(2)
    expect(pat.kayitlar[0]).toMatchObject({ AREA: -9900, 'OBJELER#': 1, 'OBJELER-ID': 0 })
    expect(pat.kayitlar[1]).toMatchObject({ AREA: 9900, PERIMETER: 440, 'OBJELER#': 2, 'OBJELER-ID': 1, ADA: 101, PARSEL: 7, MALIK: 'Çağrı Öğüt İı', ORAN: 0.25 })

    expect(e.tablolar['OBJELER.BND'].kayitlar[0]).toEqual({ XMIN: 500000, YMIN: 4400000, XMAX: 500100, YMAX: 4400100 })
    expect(e.tablolar['OBJELER.TIC'].kayitlar).toHaveLength(4)
    for (const t of Object.values(e.tablolar)) expect(t.kayitBoyu % 2).toBe(0)
  })

  it('nokta kapsamı: LAB + PAT, ED50 UTM PRJ, Türkçe metin Windows-1254 baytlarıyla', async () => {
    const { veri } = await e00Yaz(
      fc(obje({ type: 'Point', coordinates: [450000.5, 4300000.25] }, { ad: 'ığüşöçİĞÜŞÖÇ' }), obje({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }, { ad: 'çok' })),
      { crs: 'EPSG:23036', kapsamAdi: 'noktalar' },
    )
    expect(Array.from(veri).some((b) => b === 0xfd)).toBe(true) // ı
    expect(Array.from(veri).some((b) => b > 0x7f && b < 0xa0)).toBe(false)
    const e = e00Oku(coz(veri))
    expect(e.sirala).toEqual(['LAB', 'TOL', 'SIN', 'PRJ', 'IFO', 'EOS'])
    expect(e.lab.map((l) => [l.deger, l.poligon, l.k])).toEqual([[1, 1, [450000.5, 4300000.25]], [2, 2, [1, 2]], [3, 3, [3, 4]]])
    expect(e.prj.slice(0, 4)).toEqual(['Projection    UTM', 'Zone          36', 'Datum         EUR', 'Spheroid      INTERNATIONAL1909'])
    const pat = e.tablolar['NOKTALAR.PAT']
    expect(pat.kayitlar.map((k) => k.AD)).toEqual(['ığüşöçİĞÜŞÖÇ', 'çok', 'çok'])
    expect(pat.kayitlar.map((k) => k['NOKTALAR-ID'])).toEqual([1, 2, 3])
  })

  it('80 karakteri aşan kayıtları satırlara böler; ad çakışmalarını ve INFO adlarını düzeltir', async () => {
    const uzun = 'Ş'.repeat(150)
    const { veri, uyarilar } = await e00Yaz(fc(obje({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { aciklama: uzun, length: 5, 'çok uzun bir öznitelik adı': 1 })), { crs: 'EPSG:4326' })
    const e = e00Oku(coz(veri))
    const aat = e.tablolar['OBJELER.AAT']
    expect(aat.alanlar.map((a) => a.ad).slice(7)).toEqual(['ACIKLAMA', 'LENGTH_1', 'COK_UZUN_BIR_OZN'])
    expect(aat.kayitlar[0].ACIKLAMA).toBe(uzun)
    expect(aat.kayitlar[0].LENGTH_1).toBe(5)
    expect(uyarilar.some((u) => u.includes('"length"'))).toBe(true)
    expect(e.prj[0]).toBe('Projection    GEOGRAPHIC')
  })

  it('boş FC, çok parçalı poligon, nokta+poligon çakışması ve bilinmeyen CRS', async () => {
    const bos = await e00Yaz(fc(), { crs: 'EPSG:5254' })
    const e = e00Oku(coz(bos.veri))
    expect(e.sirala).toEqual(['TOL', 'SIN', 'PRJ', 'IFO', 'EOS'])
    expect(Object.keys(e.tablolar)).toEqual(['OBJELER.BND', 'OBJELER.TIC'])
    expect(e.prj).toContain(' 30  0  0.00 /* longitude of central meridian')

    const r = await e00Yaz(fc(obje({ type: 'MultiPolygon', coordinates: [[kare(0, 0, 1)], [kare(5, 5, 2)]] }, { ad: 'iki' }), obje({ type: 'Point', coordinates: [9, 9] })), { crs: 'EPSG:2320' })
    const e2 = e00Oku(coz(r.veri))
    expect(e2.pal).toHaveLength(3)
    expect(e2.tablolar['OBJELER.PAT'].kayitlar.map((k) => k.AD)).toEqual(['', 'iki', 'iki'])
    expect(e2.prj).toBeNull()
    const metin = r.uyarilar.join('\n')
    expect(metin).toMatch(/1 nokta yazılmadı/)
    expect(metin).toMatch(/EPSG:2320/)
    expect(metin).toMatch(/çok parçalı/)
  })
})
