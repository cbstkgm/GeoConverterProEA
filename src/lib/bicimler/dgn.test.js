import { describe, it, expect } from 'vitest'
import { dgnYaz, vaxDYaz, vaxDOku, int32Yaz, int32Oku, DGN_TIP, DGN_DELIK } from './dgn.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
const kare = (x, y, b) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]]
const halka = (n, r = 50, cx = 0, cy = 0) => {
  const h = Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)])
  return [...h, h[0]]
}

const kelime = (b, o) => b[o] | (b[o + 1] << 8)

/**
 * Bağımsız DGN V7 okuyucu (GDAL dgnopen.c / dgnread.c formülleriyle):
 * TCB alanları, eleman başlıkları, kelime sayıları, aralıklar ve köşeler.
 */
function oku(veri) {
  expect(veri).toBeInstanceOf(Uint8Array)
  expect(veri.length % 512).toBe(0)
  // GDAL DGNTestOpen
  expect([0x08, 0xc8]).toContain(veri[0])
  expect([veri[1], veri[2], veri[3]]).toEqual([0x09, 0xfe, 0x02])
  const boyut = veri[1214] & 0x40 ? 3 : 2
  expect(boyut === 3).toBe(veri[0] === 0xc8)
  const altBirim = int32Oku(veri, 1112)
  const uorAltBirim = int32Oku(veri, 1116)
  const uor = altBirim * uorAltBirim
  const koken = [1240, 1248, 1256].map((o) => vaxDOku(veri, o) / uor)
  const birimler = String.fromCharCode(veri[1120], veri[1121], veri[1122], veri[1123])
  const donustur = (n) => n.map((d, e) => d / uor - koken[e]) // GDAL DGNTransformPoint

  const elemanlar = []
  let o = 1536
  for (;;) {
    if (veri[o] === 0xff && veri[o + 1] === 0xff) break
    const wtf = kelime(veri, o + 2)
    const bayt = (wtf + 2) * 2
    const b = veri.subarray(o, o + bayt)
    expect(b.length).toBe(bayt)
    const kelimeler = bayt / 2
    expect(kelime(b, 30)).toBe(kelimeler - 16) // attindx: öznitelik bağı yok
    const tip = b[1] & 0x7f
    const aralik = Array.from({ length: 6 }, (_, i) => (int32Oku(b, 4 + i * 4) ^ 0x80000000) | 0)
    const el = { tip, level: b[0] & 0x3f, karmasik: Boolean(b[0] & 0x80), grup: kelime(b, 28), ozellik: kelime(b, 32), kelimeler, aralik, noktalar: [] }
    const noktaOku = (bas, sayi) => {
      for (let i = 0; i < sayi; i++) {
        el.noktalar.push(Array.from({ length: boyut }, (_, e) => int32Oku(b, bas + (i * boyut + e) * 4)))
      }
    }
    if (tip === DGN_TIP.CIZGI) {
      expect(bayt).toBe(36 + 2 * boyut * 4)
      noktaOku(36, 2)
    } else if (tip === DGN_TIP.CIZGI_DIZISI || tip === DGN_TIP.SEKIL) {
      const n = kelime(b, 36)
      expect(n).toBeGreaterThanOrEqual(2)
      expect(n).toBeLessThanOrEqual(101)
      expect(bayt).toBe(38 + n * boyut * 4) // kelime sayısı ↔ köşe sayısı
      noktaOku(38, n)
    } else if (tip === DGN_TIP.KARMASIK_SEKIL) {
      expect(bayt).toBe(40)
      el.toplamUzunluk = kelime(b, 36)
      el.altSayisi = kelime(b, 38)
    } else {
      throw new Error(`Beklenmeyen eleman tipi ${tip}`)
    }
    for (const n of el.noktalar) {
      expect(n[0]).toBeGreaterThanOrEqual(aralik[0]); expect(n[0]).toBeLessThanOrEqual(aralik[3])
      expect(n[1]).toBeGreaterThanOrEqual(aralik[1]); expect(n[1]).toBeLessThanOrEqual(aralik[4])
      if (boyut === 3) { expect(n[2]).toBeGreaterThanOrEqual(aralik[2]); expect(n[2]).toBeLessThanOrEqual(aralik[5]) }
    }
    el.dunya = el.noktalar.map(donustur)
    elemanlar.push(el)
    o += bayt
  }
  expect(veri.subarray(o + 2).every((x) => x === 0)).toBe(true)
  return { boyut, uor, altBirim, uorAltBirim, birimler, koken, elemanlar }
}

const yakin = (a, b, tolerans) => a.every((d, i) => Math.abs(d - b[i]) <= tolerans)

describe('DGN ikili yardımcıları', () => {
  it('VAX D-float gidiş-dönüş (GDAL IEEE2DGNDouble/DGN2IEEEDouble)', () => {
    const b = new Uint8Array(8)
    for (const x of [0, 1, -1, 0.5, 4400000 * 10000, -5000000000.25, 1e-30, 123456.789012345]) {
      vaxDYaz(b, 0, x)
      expect(vaxDOku(b, 0)).toBe(x)
    }
    // 1.0 → VAX: üs 129, mantis 0 → hi kelime 0x4080
    vaxDYaz(b, 0, 1)
    expect(Array.from(b)).toEqual([0x80, 0x40, 0, 0, 0, 0, 0, 0])
  })

  it('int32 orta-endian düzeni', () => {
    const b = new Uint8Array(4)
    int32Yaz(b, 0, 0x12345678)
    expect(Array.from(b)).toEqual([0x34, 0x12, 0x78, 0x56])
    for (const n of [0, -1, 2147483647, -2147483647, 123456789]) {
      int32Yaz(b, 0, n)
      expect(int32Oku(b, 0)).toBe(n)
    }
  })
})

describe('dgnYaz', () => {
  it('boş FC: yalnızca TCB + tasarım sonu', async () => {
    const { veri, uyarilar } = await dgnYaz(fc())
    const d = oku(veri)
    expect(d.boyut).toBe(2)
    expect(d.elemanlar).toEqual([])
    expect(veri.length).toBe(2048)
    expect([veri[1536], veri[1537]]).toEqual([0xff, 0xff])
    expect(uyarilar).toEqual([])
  })

  it('2B: büyük TM koordinatları global kökenle taşmadan, 0,1 mm hassasiyetle geri okunur', async () => {
    const { veri, uyarilar, onizleme } = await dgnYaz(
      fc(
        obje({ type: 'Point', coordinates: [500123.4567, 4400321.1234] }, { layer: 'Röper' }),
        obje({ type: 'LineString', coordinates: [[499000, 4399000], [501000, 4401000.5]] }, { katman: '7' }),
        obje({ type: 'Polygon', coordinates: [kare(500000, 4400000, 10)] }),
        obje(null),
      ),
    )
    expect(uyarilar[0]).toBe('1 obje geometrisiz olduğu için yazılmadı.')
    const d = oku(veri)
    expect(d.boyut).toBe(2)
    expect([d.uor, d.birimler]).toEqual([10000, 'm mm'])
    expect(d.koken).toEqual([-500000, -4400000.25, 0])
    const [nokta, cizgi, sekil] = d.elemanlar
    expect(nokta.tip).toBe(DGN_TIP.CIZGI)
    expect(nokta.noktalar[0]).toEqual(nokta.noktalar[1]) // sıfır uzunluklu çizgi
    expect(yakin(nokta.dunya[0], [500123.4567, 4400321.1234], 0.5 / d.uor)).toBe(true)
    expect(cizgi.tip).toBe(DGN_TIP.CIZGI_DIZISI)
    expect(cizgi.dunya).toEqual([[499000, 4399000], [501000, 4401000.5]])
    expect(sekil.tip).toBe(DGN_TIP.SEKIL)
    expect(sekil.dunya).toEqual([...kare(500000, 4400000, 10)])
    // Level: '7' doğrudan; diğer adlar boş numaralara
    expect([nokta.level, cizgi.level, sekil.level]).toEqual([1, 7, 2])
    expect(uyarilar.some((u) => u.includes('"Röper" → 1'))).toBe(true)
    expect(onizleme).toContain('10000 UOR/m')
  })

  it('3B: Z korunur, TCB 3B bayrakları ayarlanır', async () => {
    const { veri } = await dgnYaz(fc(obje({ type: 'LineString', coordinates: [[0, 0, 100.25], [10, 10, 200]] }), obje({ type: 'Point', coordinates: [5, 5] })))
    const d = oku(veri)
    expect(d.boyut).toBe(3)
    expect(veri[0]).toBe(0xc8)
    expect(d.elemanlar[0].dunya).toEqual([[0, 0, 100.25], [10, 10, 200]])
    expect(d.elemanlar[1].dunya[0]).toEqual([5, 5, 0])
  })

  it('101 köşeyi aşan çizgiyi uç noktaları paylaşan parçalara böler, aynı graphic group', async () => {
    const konumlar = Array.from({ length: 250 }, (_, i) => [i, i % 7])
    const { veri, uyarilar } = await dgnYaz(fc(obje({ type: 'LineString', coordinates: konumlar })))
    const parcalar = oku(veri).elemanlar
    expect(parcalar.map((p) => p.noktalar.length)).toEqual([101, 101, 50])
    expect(parcalar[0].dunya.at(-1)).toEqual(parcalar[1].dunya[0])
    expect(parcalar.flatMap((p, i) => (i === 0 ? p.dunya : p.dunya.slice(1)))).toEqual(konumlar)
    expect(parcalar[0].grup).toBeGreaterThan(0)
    expect(new Set(parcalar.map((p) => p.grup)).size).toBe(1)
    expect(uyarilar.some((u) => u.includes('101 köşe'))).toBe(true)
  })

  it('delikli poligon: dış shape + HOLE bayraklı delik shape, ortak graphic group', async () => {
    const { veri, uyarilar } = await dgnYaz(fc(obje({ type: 'Polygon', coordinates: [kare(0, 0, 10), kare(2, 2, 2)] }), obje({ type: 'Polygon', coordinates: [kare(20, 20, 1)] })))
    const [dis, delik, tek] = oku(veri).elemanlar
    expect([dis.tip, delik.tip, tek.tip]).toEqual([6, 6, 6])
    expect(dis.ozellik & DGN_DELIK).toBe(0)
    expect(delik.ozellik & DGN_DELIK).toBe(DGN_DELIK)
    expect(dis.grup).toBe(delik.grup)
    expect(dis.grup).toBeGreaterThan(0)
    expect(tek.grup).toBe(0)
    expect(delik.dunya[0]).toEqual(delik.dunya.at(-1))
    expect(uyarilar.some((u) => u.includes('hole'))).toBe(true)
  })

  it('101 köşeyi aşan halka → complex shape (tip 14) + complex bitli line string alt elemanları', async () => {
    const h = halka(150, 50, 300000, 4000000)
    const { veri } = await dgnYaz(fc(obje({ type: 'Polygon', coordinates: [h] })))
    const d = oku(veri)
    const [baslik, ...altlar] = d.elemanlar
    expect(baslik.tip).toBe(DGN_TIP.KARMASIK_SEKIL)
    expect(baslik.karmasik).toBe(false)
    expect(baslik.altSayisi).toBe(altlar.length)
    expect(altlar.length).toBe(2)
    // ISFF: totlength = başlığın ilk 19 kelimesi dışındaki tüm kelimeler
    expect(baslik.toplamUzunluk).toBe(baslik.kelimeler - 19 + altlar.reduce((t, a) => t + a.kelimeler, 0))
    for (const a of altlar) {
      expect(a.tip).toBe(DGN_TIP.CIZGI_DIZISI)
      expect(a.karmasik).toBe(true)
    }
    const birlesik = altlar.flatMap((a, i) => (i === 0 ? a.dunya : a.dunya.slice(1)))
    expect(birlesik).toHaveLength(151)
    expect(birlesik[0]).toEqual(birlesik.at(-1))
    birlesik.slice(0, -1).forEach((k, i) => expect(yakin(k, h[i], 0.5 / d.uor)).toBe(true))
    // Başlık aralığı tüm alt elemanları kapsar
    for (const a of altlar) {
      expect(a.aralik[0]).toBeGreaterThanOrEqual(baslik.aralik[0])
      expect(a.aralik[3]).toBeLessThanOrEqual(baslik.aralik[3])
    }
  })

  it('çok geniş yayılımda UOR düşürülür ve uyarılır; 63 level sınırı', async () => {
    const { veri, uyarilar } = await dgnYaz(fc(obje({ type: 'LineString', coordinates: [[-5000000, 0], [5000000, 0]] })))
    const d = oku(veri)
    expect(d.uor).toBe(100)
    expect(d.elemanlar[0].dunya).toEqual([[-5000000, 0], [5000000, 0]])
    expect(uyarilar.some((u) => u.includes('çözünürlüğü 0.01 m'))).toBe(true)

    const cok = fc(...Array.from({ length: 70 }, (_, i) => obje({ type: 'Point', coordinates: [i, 0] }, { layer: `K${i}` })))
    const s = await dgnYaz(cok)
    const leveller = oku(s.veri).elemanlar.map((e) => e.level)
    expect(Math.max(...leveller)).toBe(63)
    expect(s.uyarilar.some((u) => u.includes('63 level'))).toBe(true)
  })

  it('desteklenmeyen geometride istisna atmaz', async () => {
    const { veri, uyarilar } = await dgnYaz(fc(obje({ type: 'Curve' }), obje({ type: 'Point', coordinates: [] })))
    expect(oku(veri).elemanlar).toEqual([])
    expect(uyarilar.join('\n')).toMatch(/"Curve"/)
  })
})
