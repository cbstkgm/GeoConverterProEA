import { describe, it, expect } from 'vitest'
import { mvtYaz, wgs84tenMercatora, kapsayanDoseme, doseSinirlari } from './mvt.js'

const obje = (geometry, properties = {}, id) => ({ type: 'Feature', ...(id === undefined ? {} : { id }), properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })

// ---------------------------------------------------------------- bağımsız protobuf çözücü
function okuyucu(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let o = 0
  const varint = () => {
    let v = 0
    let c = 1
    for (;;) {
      const x = b[o++]
      v += (x & 0x7f) * c
      if (x < 0x80) return v
      c *= 128
    }
  }
  return {
    bitti: () => o >= b.length,
    alan: () => {
      const t = varint()
      return [Math.floor(t / 8), t % 8]
    },
    varint,
    uzunluklu: () => {
      const n = varint()
      const s = b.subarray(o, o + n)
      o += n
      return s
    },
    double: () => {
      const v = dv.getFloat64(o, true)
      o += 8
      return v
    },
  }
}
const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2)
const paketli = (b) => {
  const r = okuyucu(b)
  const d = []
  while (!r.bitti()) d.push(r.varint())
  return d
}
const metin = (b) => new TextDecoder().decode(b)

function deger(b) {
  const r = okuyucu(b)
  const [alan] = r.alan()
  if (alan === 1) return metin(r.uzunluklu())
  if (alan === 3) return r.double()
  if (alan === 6) return zz(r.varint())
  if (alan === 7) return r.varint() === 1
  throw new Error(`beklenmeyen Value alanı ${alan}`)
}

function geometriCoz(komutlar) {
  const halkalar = []
  let x = 0
  let y = 0
  let i = 0
  let mevcut = null
  while (i < komutlar.length) {
    const id = komutlar[i] & 7
    const sayi = komutlar[i] >> 3
    i++
    if (id === 7) {
      mevcut.kapali = true
      continue
    }
    for (let n = 0; n < sayi; n++) {
      x += zz(komutlar[i++])
      y += zz(komutlar[i++])
      if (id === 1) {
        mevcut = { noktalar: [] }
        halkalar.push(mevcut)
      }
      mevcut.noktalar.push([x, y])
    }
  }
  return halkalar
}

function mvtCoz(veri) {
  const r = okuyucu(veri)
  const katmanlar = []
  while (!r.bitti()) {
    const [alan] = r.alan()
    expect(alan).toBe(3)
    const k = okuyucu(r.uzunluklu())
    const katman = { objeler: [], anahtarlar: [], degerler: [] }
    while (!k.bitti()) {
      const [a, tel] = k.alan()
      if (a === 1) katman.ad = metin(k.uzunluklu())
      else if (a === 2) {
        const f = okuyucu(k.uzunluklu())
        const obje = {}
        while (!f.bitti()) {
          const [fa] = f.alan()
          if (fa === 1) obje.id = f.varint()
          else if (fa === 2) obje.etiketler = paketli(f.uzunluklu())
          else if (fa === 3) obje.tip = f.varint()
          else if (fa === 4) obje.geometri = paketli(f.uzunluklu())
        }
        katman.objeler.push(obje)
      } else if (a === 3) katman.anahtarlar.push(metin(k.uzunluklu()))
      else if (a === 4) katman.degerler.push(deger(k.uzunluklu()))
      else if (a === 5) katman.extent = k.varint()
      else if (a === 15) katman.surum = k.varint()
      else throw new Error(`beklenmeyen alan ${a}/${tel}`)
    }
    for (const o of katman.objeler) {
      o.ozellikler = {}
      for (let i = 0; i < (o.etiketler || []).length; i += 2) o.ozellikler[katman.anahtarlar[o.etiketler[i]]] = katman.degerler[o.etiketler[i + 1]]
      o.parcalar = geometriCoz(o.geometri)
    }
    katmanlar.push(katman)
  }
  return katmanlar
}

const alan = (h) => h.reduce((t, [x0, y0], i) => {
  const [x1, y1] = h[(i + 1) % h.length]
  return t + x0 * y1 - x1 * y0
}, 0) / 2

describe('mvtYaz', () => {
  it('3857 verisini kapsayan döşemeye yazar; koordinatlar, id ve öznitelikler geri çözülür', async () => {
    const s = doseSinirlari(10, 600, 380)
    const b = (s.maxx - s.minx) / 4096
    // döşeme ızgarasına denk gelen koordinatlar → birebir geri dönmeli
    const xy = (px, py) => [s.minx + px * b, s.maxy - py * b]
    const dis = [xy(100, 100), xy(100, 300), xy(300, 300), xy(300, 100), xy(100, 100)] // y-yukarıda saat yönü
    const delik = [xy(150, 150), xy(250, 150), xy(250, 250), xy(150, 250), xy(150, 150)]
    const { veri, onizleme, uyarilar } = await mvtYaz(
      fc(
        obje({ type: 'Point', coordinates: xy(10, 20) }, { ad: 'Çeşme', no: 7, oran: 0.5, aktif: true, negatif: -3 }, 11),
        obje({ type: 'LineString', coordinates: [xy(0, 0), xy(50, 60), xy(4000, 4090)] }, { ad: 'Yol' }, 12),
        obje({ type: 'Polygon', coordinates: [dis, delik] }, { ad: 'Şükrü' }, 13),
        obje({ type: 'MultiPoint', coordinates: [xy(1, 1), xy(2, 2)] }, {}, 14),
      ),
      { crs: 'EPSG:3857', z: 10, x: 600, y: 380 },
    )
    expect(uyarilar).toEqual([])
    expect(onizleme).toContain('10/600/380')
    const [k] = mvtCoz(veri)
    expect(k).toMatchObject({ ad: 'objeler', extent: 4096, surum: 2 })
    expect(k.objeler.map((o) => [o.id, o.tip])).toEqual([[11, 1], [12, 2], [13, 3], [14, 1]])
    const [nokta, cizgi, poligon, coklu] = k.objeler
    expect(nokta.ozellikler).toEqual({ ad: 'Çeşme', no: 7, oran: 0.5, aktif: true, negatif: -3 })
    expect(nokta.parcalar).toEqual([{ noktalar: [[10, 20]] }])
    expect(cizgi.parcalar).toEqual([{ noktalar: [[0, 0], [50, 60], [4000, 4090]] }])
    expect(poligon.ozellikler.ad).toBe('Şükrü')
    expect(poligon.parcalar).toHaveLength(2)
    expect(poligon.parcalar.every((p) => p.kapali)).toBe(true)
    expect(alan(poligon.parcalar[0].noktalar)).toBeGreaterThan(0) // dış: y-aşağıda saat yönü
    expect(alan(poligon.parcalar[1].noktalar)).toBeLessThan(0) // delik
    expect(poligon.parcalar[0].noktalar).toHaveLength(4) // kapanış köşesi yazılmaz
    expect(coklu.geometri[0]).toBe(17) // MoveTo, sayı 2
    expect(coklu.parcalar).toEqual([{ noktalar: [[1, 1]] }, { noktalar: [[2, 2]] }])
    // değer tablosu yinelenmez: 'ad' anahtarı tek
    expect(k.anahtarlar.filter((a) => a === 'ad')).toHaveLength(1)
  })

  it('4326 girdiyi Mercator’a çevirir ve veriyi kapsayan en büyük zoom’u seçer', async () => {
    const ankara = [32.85, 39.93]
    const { veri, onizleme } = await mvtYaz(
      fc(obje({ type: 'LineString', coordinates: [ankara, [32.86, 39.94]] }, { ad: 'a' })),
      { crs: 'EPSG:4326', katman: 'yollar' },
    )
    const m0 = wgs84tenMercatora(ankara)
    const m1 = wgs84tenMercatora([32.86, 39.94])
    const d = kapsayanDoseme({ minx: m0[0], miny: m0[1], maxx: m1[0], maxy: m1[1] })
    expect(onizleme).toContain(`${d.z}/${d.x}/${d.y}`)
    expect(d.z).toBeGreaterThan(10)
    // bir zoom yukarısı veriyi kapsamamalı (en büyük zoom)
    const ust = kapsayanDoseme({ minx: m0[0], miny: m0[1], maxx: m1[0], maxy: m1[1] }, d.z + 1)
    expect(ust.z).toBe(d.z)
    const [k] = mvtCoz(veri)
    expect(k.ad).toBe('yollar')
    const s = doseSinirlari(d.z, d.x, d.y)
    const geri = k.objeler[0].parcalar[0].noktalar.map(([px, py]) => [s.minx + (px / 4096) * (s.maxx - s.minx), s.maxy - (py / 4096) * (s.maxy - s.miny)])
    const tolerans = (s.maxx - s.minx) / 4096
    expect(Math.abs(geri[0][0] - m0[0])).toBeLessThanOrEqual(tolerans)
    expect(Math.abs(geri[1][1] - m1[1])).toBeLessThanOrEqual(tolerans)
    // Mercator formülü: 0,0 → 0,0; 180 → E
    expect(wgs84tenMercatora([180, 0])[0]).toBeCloseTo(20037508.342789244, 6)
    expect(wgs84tenMercatora([0, 0])[1]).toBeCloseTo(0, 6)
  })

  it('verilen döşemede kırpar; dışarıdakileri atar ve raporlar', async () => {
    const s = doseSinirlari(5, 10, 10)
    const b = (s.maxx - s.minx) / 4096
    const xy = (px, py) => [s.minx + px * b, s.maxy - py * b]
    const { veri, uyarilar, onizleme } = await mvtYaz(
      fc(
        obje({ type: 'LineString', coordinates: [xy(-1000, 100), xy(5000, 100)] }),
        obje({ type: 'Polygon', coordinates: [[xy(-500, -500), xy(-500, 1000), xy(1000, 1000), xy(1000, -500), xy(-500, -500)]] }),
        obje({ type: 'Point', coordinates: xy(9000, 9000) }),
      ),
      { crs: 'EPSG:3857', z: 5, x: 10, y: 10 },
    )
    const [k] = mvtCoz(veri)
    expect(k.objeler).toHaveLength(2)
    expect(k.objeler[0].parcalar[0].noktalar).toEqual([[-64, 100], [4160, 100]])
    const halka = k.objeler[1].parcalar[0].noktalar
    expect(halka.every(([x, y]) => x >= -64 && y >= -64 && x <= 4160 && y <= 4160)).toBe(true)
    expect(alan(halka)).toBeGreaterThan(0)
    expect(uyarilar.join('\n')).toMatch(/kırpıldı/)
    expect(uyarilar.join('\n')).toMatch(/1 obje döşeme dışında/)
    expect(onizleme).toMatch(/Kırpılan obje: 3/)
  })

  it('null geometri, boş FC, GeometryCollection bölme ve CRS hatası', async () => {
    const bos = await mvtYaz(fc(), { crs: 'EPSG:3857' })
    const [k] = mvtCoz(bos.veri)
    expect(k.objeler).toEqual([])
    expect(bos.onizleme).toContain('0/0/0')

    const r = await mvtYaz(
      fc(obje(null, { a: 1 }), obje({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [30, 40, 5] }, { type: 'LineString', coordinates: [[30, 40], [30.001, 40.001]] }] }, { a: 2 })),
      { crs: 'EPSG:4326' },
    )
    const [k2] = mvtCoz(r.veri)
    expect(k2.objeler.map((o) => o.tip)).toEqual([1, 2])
    expect(k2.objeler.map((o) => o.ozellikler.a)).toEqual([2, 2])
    const metin = r.uyarilar.join('\n')
    expect(metin).toMatch(/Geometrisi olmayan/)
    expect(metin).toMatch(/GeometryCollection/)
    expect(metin).toMatch(/Z değerleri/)

    await expect(mvtYaz(fc(), { crs: 'EPSG:5255' })).rejects.toThrow(/EPSG:3857/)
    const eksik = await mvtYaz(fc(obje({ type: 'Point', coordinates: [30, 40] })))
    expect(eksik.uyarilar.join(' ')).toMatch(/4326/)
  })
})
