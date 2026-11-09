import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { mapinfoYaz, mapinfoAlanAdlari, cp1254Kodla, koordinatDonusumu, GEOM, MAPINFO_COORDSYS } from './mapinfo.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
const X = 500000, Y = 4400000

// ---------------------------------------------------------------- asgari bağımsız TAB okuyucu
const CP1254_GERI = new Map([[0xd0, 'Ğ'], [0xdd, 'İ'], [0xde, 'Ş'], [0xf0, 'ğ'], [0xfd, 'ı'], [0xfe, 'ş']])
const cp1254Coz = (b) => Array.from(b).map((x) => CP1254_GERI.get(x) ?? String.fromCharCode(x)).join('')

function tabOku(metin) {
  const satirlar = metin.split('\n')
  const fi = satirlar.findIndex((s) => /^\s*Fields \d+/.test(s))
  const n = Number(/Fields (\d+)/.exec(satirlar[fi])[1])
  const alanlar = satirlar.slice(fi + 1, fi + 1 + n).map((s) => {
    const m = /^\s+(\S+) (Char \((\d+)\)|Integer|SmallInt|Float|Date|Logical) ;$/.exec(s)
    return { ad: m[1], tip: m[2].startsWith('Char') ? 'Char' : m[2], uzunluk: m[3] ? Number(m[3]) : null }
  })
  return { surum: Number(/!version (\d+)/.exec(metin)[1]), charset: /!charset (\S+)/.exec(metin)[1], alanlar }
}

function datOku(u8, tabAlanlari) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const kayit = dv.getUint32(4, true)
  const baslik = dv.getUint16(8, true)
  const boy = dv.getUint16(10, true)
  const alanlar = []
  for (let o = 32; u8[o] !== 0x0d; o += 32) {
    alanlar.push({ ad: cp1254Coz(u8.subarray(o, o + 11)).replace(/\0.*$/, ''), dbf: String.fromCharCode(u8[o + 11]), uzunluk: u8[o + 16] })
  }
  expect(baslik).toBe(32 + 32 * alanlar.length + 1)
  expect(u8[u8.length - 1]).toBe(0x1a)
  const kayitlar = []
  for (let r = 0; r < kayit; r++) {
    let o = baslik + r * boy
    expect(u8[o]).toBe(0x20)
    o++
    const k = {}
    alanlar.forEach((a, i) => {
      const t = tabAlanlari[i].tip
      if (t === 'Integer') k[tabAlanlari[i].ad] = dv.getInt32(o, true)
      else if (t === 'Float') k[tabAlanlari[i].ad] = dv.getFloat64(o, true)
      else if (t === 'Logical') k[tabAlanlari[i].ad] = u8[o] === 1
      else if (t === 'Date') {
        const y = dv.getInt16(o, true)
        k[tabAlanlari[i].ad] = y ? `${y}-${String(u8[o + 2]).padStart(2, '0')}-${String(u8[o + 3]).padStart(2, '0')}` : null
      } else k[tabAlanlari[i].ad] = cp1254Coz(u8.subarray(o, o + a.uzunluk)).replace(/\0+$/, '')
      o += a.uzunluk
    })
    kayitlar.push(k)
  }
  return { alanlar, kayitlar, boy }
}

/** .map + .id okuyucu: başlık, CoordSys ve nesneleri gerçek koordinatlara çözer. */
function mapOku(u8, id) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const i32 = (o) => dv.getInt32(o, true)
  const i16 = (o) => dv.getInt16(o, true)
  const f64 = (o) => dv.getFloat64(o, true)
  const h = {
    sihir: i32(0x100), surum: i16(0x104), blok: i16(0x106),
    mbr: [i32(0x110), i32(0x114), i32(0x118), i32(0x11c)],
    ilkIndeks: i32(0x130), ilkArac: i32(0x138),
    sayilar: [i32(0x13c), i32(0x140), i32(0x144), i32(0x148)],
    derinlik: u8[0x15f], ceyrek: u8[0x161],
    kalem: u8[0x164], firca: u8[0x165], sembol: u8[0x166],
    datum: i16(0x16a), proj: u8[0x16d], elipsoit: u8[0x16e], birim: u8[0x16f],
    olcek: [f64(0x170), f64(0x178)], otel: [f64(0x180), f64(0x188)],
    param: [0, 1, 2, 3, 4, 5].map((i) => f64(0x190 + 8 * i)),
    kaydirma: [0, 1, 2].map((i) => f64(0x1c0 + 8 * i)),
    datumParam: [0, 1, 2, 3, 4].map((i) => f64(0x1d8 + 8 * i)),
  }
  const gercek = (x, y) => [(x - h.otel[0]) / h.olcek[0], (y - h.otel[1]) / h.olcek[1]]
  // Koordinat akışı okuyucu (blok sınırında sonraki bloğa geçer)
  const koordAkisi = (adres) => {
    let blok = adres - ((adres - 1024) % 512)
    let o = adres
    const bayt = (n) => {
      const cikti = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        if (o >= blok + 8 + i16(blok + 2)) {
          expect(i16(blok)).toBe(3)
          blok = i32(blok + 4)
          expect(blok).toBeGreaterThan(0)
          o = blok + 8
        }
        cikti[i] = u8[o++]
      }
      return new DataView(cikti.buffer)
    }
    return { i16: () => bayt(2).getInt16(0, true), i32: () => bayt(4).getInt32(0, true) }
  }
  const idDv = new DataView(id.buffer, id.byteOffset, id.byteLength)
  const nesneler = []
  for (let r = 0; r < id.length / 4; r++) {
    const a = idDv.getInt32(4 * r, true)
    if (!a) { nesneler.push(null); continue }
    const blok = a - ((a - 1024) % 512)
    expect(i16(blok)).toBe(2)
    const tip = u8[a]
    const nesne = { tip, id: i32(a + 1) }
    const sik = [GEOM.PLINE_C, GEOM.REGION_C, GEOM.MULTIPLINE_C, GEOM.MULTIPOINT_C].includes(tip)
    if (tip === GEOM.SYMBOL) {
      nesne.tur = 'Point'
      nesne.koordinatlar = gercek(i32(a + 5), i32(a + 9))
    } else if (tip === GEOM.MULTIPOINT || tip === GEOM.MULTIPOINT_C) {
      const ptr = i32(a + 5), n = i32(a + 9)
      const ox = sik ? i32(a + 9 + 4 + 15 + 2 + 4) : 0, oy = sik ? i32(a + 9 + 4 + 15 + 2 + 8) : 0
      const k = koordAkisi(ptr)
      nesne.tur = 'MultiPoint'
      nesne.koordinatlar = Array.from({ length: n }, () => (sik ? gercek(ox + k.i16(), oy + k.i16()) : gercek(k.i32(), k.i32())))
    } else {
      const ptr = i32(a + 5), boy = i32(a + 9)
      const coklu = tip !== GEOM.PLINE && tip !== GEOM.PLINE_C
      let o = a + 13
      const nb = coklu ? i16(o) : 1
      if (coklu) o += 2
      o += sik ? 4 : 8 // etiket
      const ox = sik ? i32(o) : 0, oy = sik ? i32(o + 4) : 0
      const k = koordAkisi(ptr)
      const kk = () => (sik ? gercek(ox + k.i16(), oy + k.i16()) : gercek(k.i32(), k.i32()))
      let bolumler
      if (!coklu) {
        bolumler = [{ n: boy / (sik ? 4 : 8), delik: 0 }]
      } else {
        bolumler = Array.from({ length: nb }, () => {
          const b = { n: k.i16(), delik: k.i16() }
          for (let i = 0; i < 4; i++) { if (sik) k.i16(); else k.i32() }
          b.ofset = k.i32()
          return b
        })
        let onceki = 0
        bolumler.forEach((b) => { expect(b.ofset).toBe(nb * 24 + onceki * 8); onceki += b.n })
      }
      for (const b of bolumler) b.konumlar = Array.from({ length: b.n }, kk)
      nesne.bolumler = bolumler
      nesne.veriBoyu = boy
    }
    nesneler.push(nesne)
  }
  return { h, nesneler }
}

async function ac(veri, ad = 'cikti') {
  const zip = await JSZip.loadAsync(veri)
  const al = (u) => zip.file(`${ad}.${u}`).async('uint8array')
  const tabMetni = await zip.file(`${ad}.tab`).async('string')
  const tab = tabOku(tabMetni)
  const dat = datOku(await al('dat'), tab.alanlar)
  const harita = mapOku(await al('map'), await al('id'))
  return { dosyalar: Object.keys(zip.files).sort(), tabMetni, tab, dat, harita }
}

const yakin = (a, b, tol = 1e-3) => {
  expect(a.length).toBe(b.length)
  a.forEach((k, i) => {
    expect(Math.abs(k[0] - b[i][0])).toBeLessThan(tol)
    expect(Math.abs(k[1] - b[i][1])).toBeLessThan(tol)
  })
}

// ---------------------------------------------------------------- testler
describe('mapinfoYaz — gidiş-dönüş', () => {
  const kare = (x, y, b) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]]
  const girdi = () => fc(
    obje({ type: 'Point', coordinates: [X + 0.123, Y + 0.456, 12] }, { ad: 'Çiğdem Şişli', tam: 1, ondalik: 1.5, mantik: true, tarih: '2024-02-29' }),
    obje({ type: 'LineString', coordinates: [[X, Y], [X + 100.001, Y + 50.002], [X + 200, Y]] }, { ad: 'ığüşöç ĞÜŞİÖÇ', tam: 2, ondalik: 2.25, mantik: false }),
    obje({ type: 'MultiLineString', coordinates: [[[X, Y], [X + 10, Y + 10]], [[X + 20, Y + 20], [X + 30, Y + 30], [X + 40, Y + 20]]] }, { ad: 'çoklu çizgi', tam: -3 }),
    obje({ type: 'Polygon', coordinates: [kare(X, Y, 100), [[X + 20, Y + 20], [X + 40, Y + 20], [X + 40, Y + 40], [X + 20, Y + 20]]] }, { ad: 'delikli', tam: 4 }),
    obje({ type: 'MultiPolygon', coordinates: [[kare(X + 200, Y, 1)], [kare(X + 400, Y, 1)]] }, { ad: 'çoklu poligon', tam: 5 }),
    obje({ type: 'MultiPoint', coordinates: [[X, Y], [X + 1, Y + 1]] }, { ad: 'çoklu nokta', tam: 6 }),
    obje(null, { ad: 'geometrisiz İ', tam: 7 }),
    obje({ type: 'LineString', coordinates: [[X - 90000, Y - 50000], [X + 90000, Y + 60000]] }, { ad: 'uzun', tam: 8 }),
  )

  it('dört dosya, .tab başlığı, .dat öznitelikleri (Windows-1254), .id ve tüm geometri tipleri', async () => {
    const g = girdi()
    const { veri, uyarilar, onizleme } = await mapinfoYaz(g, { crs: 'EPSG:5255' })
    const r = await ac(veri)
    expect(r.dosyalar).toEqual(['cikti.dat', 'cikti.id', 'cikti.map', 'cikti.tab'])
    expect(r.tab.surum).toBe(450) // MultiPoint + Date
    expect(r.tab.charset).toBe('WindowsTurkish')
    expect(r.tabMetni).toContain('  Type NATIVE Charset "WindowsTurkish"')
    expect(r.tab.alanlar).toEqual([
      { ad: 'ad', tip: 'Char', uzunluk: 13 }, // en uzun değerin Windows-1254 bayt sayısı
      { ad: 'tam', tip: 'Integer', uzunluk: null },
      { ad: 'ondalik', tip: 'Float', uzunluk: null },
      { ad: 'mantik', tip: 'Logical', uzunluk: null },
      { ad: 'tarih', tip: 'Date', uzunluk: null },
    ])
    expect(r.dat.alanlar.map((a) => [a.dbf, a.uzunluk])).toEqual([['C', 13], ['C', 4], ['C', 8], ['L', 1], ['C', 4]])
    expect(r.dat.kayitlar.map((k) => k.ad)).toEqual(g.features.map((f) => f.properties.ad))
    expect(r.dat.kayitlar[0]).toEqual({ ad: 'Çiğdem Şişli', tam: 1, ondalik: 1.5, mantik: true, tarih: '2024-02-29' })
    expect(r.dat.kayitlar[1]).toMatchObject({ mantik: false, tarih: null })
    expect(r.dat.kayitlar[2]).toMatchObject({ tam: -3, ondalik: 0 })

    const n = r.harita.nesneler
    expect(n.map((x) => x && x.tip)).toEqual([GEOM.SYMBOL, GEOM.PLINE, GEOM.MULTIPLINE, GEOM.REGION, GEOM.REGION, GEOM.MULTIPOINT_C, null, GEOM.PLINE])
    expect(n.map((x) => x && x.id)).toEqual([1, 2, 3, 4, 5, 6, null, 8])
    yakin([n[0].koordinatlar], [[X + 0.123, Y + 0.456]], 1e-4)
    yakin(n[1].bolumler[0].konumlar, g.features[1].geometry.coordinates, 1e-4)
    expect(n[2].bolumler.map((b) => b.n)).toEqual([2, 3])
    yakin(n[2].bolumler[1].konumlar, g.features[2].geometry.coordinates[1], 1e-4)
    expect(n[3].bolumler.map((b) => [b.n, b.delik])).toEqual([[5, 1], [4, 0]])
    yakin(n[3].bolumler[1].konumlar, g.features[3].geometry.coordinates[1], 1e-4)
    expect(n[4].bolumler.map((b) => [b.n, b.delik])).toEqual([[5, 0], [5, 0]])
    yakin(n[4].bolumler[1].konumlar, kare(X + 400, Y, 1), 1e-4)
    yakin(n[5].koordinatlar, [[X, Y], [X + 1, Y + 1]], 1e-4)

    const h = r.harita.h
    expect(h).toMatchObject({ sihir: 42424242, surum: 500, blok: 512, ceyrek: 1, kalem: 1, firca: 1, sembol: 1 })
    expect(h.sayilar).toEqual([2, 3, 2, 0]) // nokta+çoklu nokta, çizgi, bölge, metin
    expect(h.derinlik).toBe(2)
    expect(uyarilar.join(' ')).toMatch(/1 obje geometrisiz; kayıtları korunarak "none"/)
    expect(uyarilar.join(' ')).toMatch(/1 konumun Z değeri atıldı/)
    expect(onizleme).toContain('REGION 2')
  })

  it('.map başlığı: CoordSys (TUREF TM33 = 999/GRS80), GDAL ölçek formülü ve MBR', async () => {
    const { veri } = await mapinfoYaz(girdi(), { crs: 'EPSG:5255' })
    const { h, nesneler } = (await ac(veri)).harita
    expect(h).toMatchObject({ proj: 8, datum: 999, elipsoit: 0, birim: 7 })
    expect(h.param).toEqual([33, 0, 1, 500000, 0, 0])
    expect(h.kaydirma).toEqual([0, 0, 0])
    // Sınır: veri kapsamı merkez ± 0.6 × genişlik → çözünürlük < 1 mm
    expect(1 / h.olcek[0]).toBeLessThan(0.001)
    const d = koordinatDonusumu(X - 90000 + 200 - 216000 / 2 + 216000 / 2 - 108000, 0, 0, 1)
    expect(d.xOlcek).toBeCloseTo(2e9 / (0 - (X - 90000 + 200 - 108000)), 6)
    // MBR = nesnelerin tamsayı kapsamı
    const xs = nesneler.filter(Boolean).flatMap((n) => (n.koordinatlar ? (Array.isArray(n.koordinatlar[0]) ? n.koordinatlar : [n.koordinatlar]) : n.bolumler.flatMap((b) => b.konumlar)))
    const xmin = Math.min(...xs.map((k) => k[0]))
    expect(Math.abs((h.mbr[0] - h.otel[0]) / h.olcek[0] - xmin)).toBeLessThan(1e-3)
  })

  it('katalogdaki her CRS: WGS84, Web Mercator, TUREF TM27–45, ED50 UTM 35–38 (9999 + 7 parametre)', async () => {
    expect(Object.keys(MAPINFO_COORDSYS)).toHaveLength(13)
    const oku = async (crs, g) => (await ac((await mapinfoYaz(g, { crs })).veri)).harita.h
    const nokta = fc(obje({ type: 'Point', coordinates: [32.85, 39.92] }))
    expect(await oku('EPSG:4326', nokta)).toMatchObject({ proj: 1, datum: 104, elipsoit: 28, birim: 13 })
    expect(await oku('EPSG:3857', nokta)).toMatchObject({ proj: 10, datum: 157, elipsoit: 54, birim: 7 })
    for (let i = 0; i < 7; i++) {
      const h = await oku(`EPSG:${5253 + i}`, nokta)
      expect(h).toMatchObject({ proj: 8, datum: 999, elipsoit: 0 })
      expect(h.param).toEqual([27 + 3 * i, 0, 1, 500000, 0, 0])
    }
    for (const zon of [35, 36, 37, 38]) {
      const h = await oku(`EPSG:${23000 + zon}`, nokta)
      expect(h).toMatchObject({ proj: 8, datum: 9999, elipsoit: 5 })
      expect(h.param).toEqual([zon * 6 - 183, 0, 0.9996, 500000, 0, 0])
      expect(h.kaydirma).toEqual([-84.1, -101.8, -129.7])
      expect(h.datumParam).toEqual([-0, -0, -0.468, 1.05, 0])
    }
    const { veri, uyarilar } = await mapinfoYaz(nokta)
    expect((await ac(veri)).harita.h).toMatchObject({ proj: 0, datum: 0, birim: 7 })
    expect(uyarilar.join(' ')).toMatch(/NonEarth/)
  })

  it('küçük nesneler sıkıştırılmış (_C) türlerle, koordinat bloğu sınırını aşan veri zincirle yazılır', async () => {
    const halka = (cx, cy, r, n) => { const h = Array.from({ length: n }, (_, k) => [cx + r * Math.cos(k / n * 2 * Math.PI), cy + r * Math.sin(k / n * 2 * Math.PI)]); h.push(h[0]); return h }
    const g = fc(
      obje({ type: 'Polygon', coordinates: [halka(X, Y, 5000, 1000), halka(X, Y, 1000, 300).reverse()] }),
      // kapsam 12 km → ölçek ≈ 166667/m: 0.1 m'lik nesneler int16'ya sığar
      obje({ type: 'LineString', coordinates: [[X, Y], [X + 0.1, Y + 0.05]] }),
      obje({ type: 'MultiLineString', coordinates: [[[X, Y], [X + 0.1, Y]], [[X, Y + 0.1], [X + 0.1, Y + 0.1]]] }),
      obje({ type: 'Polygon', coordinates: [halka(X + 1, Y + 1, 0.05, 200)] }),
    )
    const { nesneler } = (await ac((await mapinfoYaz(g, { crs: 'EPSG:5255' })).veri)).harita
    expect(nesneler.map((n) => n.tip)).toEqual([GEOM.REGION, GEOM.PLINE_C, GEOM.MULTIPLINE_C, GEOM.REGION_C])
    expect(nesneler[0].veriBoyu).toBeGreaterThan(504 * 10)
    yakin(nesneler[0].bolumler[0].konumlar, g.features[0].geometry.coordinates[0])
    yakin(nesneler[0].bolumler[1].konumlar, g.features[0].geometry.coordinates[1])
    expect(nesneler[0].bolumler[0].delik).toBe(1)
    yakin(nesneler[3].bolumler[0].konumlar, g.features[3].geometry.coordinates[0])
    yakin(nesneler[1].bolumler[0].konumlar, g.features[1].geometry.coordinates)
  })

  it('çok sayıda obje: birden çok nesne bloğu ve iki seviyeli R-tree; .id adresleri nesneleri gösterir', async () => {
    const g = fc(...Array.from({ length: 3000 }, (_, i) => obje({ type: 'Point', coordinates: [X + (i % 60) * 100, Y + Math.floor(i / 60) * 100] }, { no: i })))
    const r = await ac((await mapinfoYaz(g, { crs: 'EPSG:5255' })).veri)
    expect(r.harita.nesneler.map((n) => n.id)).toEqual(g.features.map((_, i) => i + 1))
    yakin(r.harita.nesneler.map((n) => n.koordinatlar), g.features.map((f) => f.geometry.coordinates), 1e-4)
    expect(r.dat.kayitlar.map((k) => k.no)).toEqual(g.features.map((_, i) => i))
    expect(r.harita.h.derinlik).toBe(3) // kök + yaprak indeks seviyesi + nesne blokları
  })
})

describe('mapinfoYaz — öznitelik ve kenar durumları', () => {
  it('alan adları: ≤ 31 karakter, ASCII, harfle başlar, benzersiz', () => {
    const e = mapinfoAlanAdlari(['şehir adı', 'Şehir_adı', '2023', 'a'.repeat(40), 'a'.repeat(40) + 'b', ''])
    expect([...e.values()]).toEqual(['sehir_adi', 'Sehir_adi_1', 'F_2023', 'a'.repeat(31), `${'a'.repeat(29)}_1`, 'ALAN'])
  })

  it('cp1254: Türkçe harfler tek bayt; karşılığı olmayanlar "?"', () => {
    expect(Array.from(cp1254Kodla('ğĞıİşŞçÇöÖüÜ').baytlar)).toEqual([0xf0, 0xd0, 0xfd, 0xdd, 0xfe, 0xde, 0xe7, 0xc7, 0xf6, 0xd6, 0xfc, 0xdc])
    expect(cp1254Kodla('a€☃').eksik).toBe(1)
  })

  it('Char 254 bayt sınırı, tarih yoksa sürüm 300, karışık GeometryCollection önceliği', async () => {
    const { veri, uyarilar } = await mapinfoYaz(fc(
      obje({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [X, Y] }, { type: 'LineString', coordinates: [[X, Y], [X + 1, Y + 1]] }] }, { not: 'ş'.repeat(300) }),
    ), { crs: 'EPSG:5255' })
    const r = await ac(veri)
    expect(r.tab.surum).toBe(300)
    expect(r.tab.alanlar[0]).toEqual({ ad: 'not', tip: 'Char', uzunluk: 254 })
    expect(r.dat.kayitlar[0].not).toBe('ş'.repeat(254))
    expect(r.harita.nesneler[0].tip).toBe(GEOM.PLINE) // 1 m > int16 aralığı (ölçek 1e7/m)
    expect(uyarilar.join(' ')).toMatch(/1 metin değeri Char\(254\)/)
    expect(uyarilar.join(' ')).toMatch(/öncelik: bölge > çizgi > nokta/)
  })

  it('tamamen null geometri: kayıtlar korunur, .id sıfır, nesne yok', async () => {
    const { veri } = await mapinfoYaz(fc(obje(null, { a: 1 }), obje(null, { a: 2 })), { crs: 'EPSG:5255' })
    const r = await ac(veri)
    expect(r.dat.kayitlar).toEqual([{ a: 1 }, { a: 2 }])
    expect(r.harita.nesneler).toEqual([null, null])
    expect(r.harita.h.ilkIndeks).toBe(0)
    expect(r.harita.h.sayilar).toEqual([0, 0, 0, 0])
  })

  it('boş FC: 0 kayıtlı geçerli tablo + FID alanı + uyarı', async () => {
    const { veri, uyarilar } = await mapinfoYaz(fc(), { crs: 'EPSG:5255', ad: 'boş tablo' })
    const r = await ac(veri, 'bos_tablo')
    expect(r.tab.alanlar).toEqual([{ ad: 'FID', tip: 'Integer', uzunluk: null }])
    expect(r.dat.kayitlar).toEqual([])
    expect(r.harita.nesneler).toEqual([])
    expect(uyarilar.join(' ')).toMatch(/0 kayıtlı MapInfo tablosu/)
    await expect(mapinfoYaz({ type: 'Feature' })).rejects.toThrow(/FeatureCollection/)
  })
})
