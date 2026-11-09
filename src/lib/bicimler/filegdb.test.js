import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { filegdbYaz } from './filegdb.js'
import { guidBaytlari, FgdbYazici } from './filegdb/tablo.js'

const kare = (x, y, b, z) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]].map((k) => (z === undefined ? k : [...k, z]))
const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
const utf8 = new TextDecoder()

// ---------------------------------------------------------------- bağımsız asgari FileGDB okuyucu
function okuyucu(b, o = 0) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const r = {
    get o() {
      return o
    },
    set o(v) {
      o = v
    },
    u8: () => b[o++],
    u16: () => ((o += 2), dv.getUint16(o - 2, true)),
    i16: () => ((o += 2), dv.getInt16(o - 2, true)),
    u32: () => ((o += 4), dv.getUint32(o - 4, true)),
    i32: () => ((o += 4), dv.getInt32(o - 4, true)),
    u64: () => ((o += 8), Number(dv.getBigUint64(o - 8, true))),
    f64: () => ((o += 8), dv.getFloat64(o - 8, true)),
    bayt: (n) => ((o += n), b.subarray(o - n, o)),
    varuint: () => {
      let v = 0
      let c = 1
      for (;;) {
        const x = b[o++]
        v += (x & 0x7f) * c
        if (x < 0x80) return v
        c *= 128
      }
    },
    varint: () => {
      const x = b[o++]
      let v = x & 0x3f
      const negatif = x & 0x40
      if (x & 0x80) v += r.varuint() * 64
      return negatif ? -v : v
    },
    utf16: (n) => String.fromCharCode(...Array.from({ length: n }, () => r.u16())),
  }
  return r
}

function tabloOku(tablo, tablx) {
  const r = okuyucu(tablo)
  const bas = { surum: r.u32(), gecerli: r.u32(), enBuyuk: r.u32(), sihir: [r.u32(), r.u32(), r.u32()], boy: r.u64(), fdOfset: r.u64() }
  r.o = bas.fdOfset
  const fdBoy = r.u32()
  expect(r.u32()).toBe(4)
  const bayrak = r.u32()
  const n = r.u16()
  const z = bayrak >= 2 ** 31
  const alanlar = []
  for (let i = 0; i < n; i++) {
    const a = { ad: r.utf16(r.u8()), alias: r.utf16(r.u8()), tip: r.u8() }
    if (a.tip === 7) {
      r.u8()
      a.bayrak = r.u8()
      a.wkt = r.utf16(r.u16() / 2)
      const gf = r.u8()
      const v = Array.from({ length: 10 }, () => r.f64())
      a.geom = { gf, xOrigin: v[0], yOrigin: v[1], xyScale: v[2], zOrigin: v[5], zScale: v[6] }
      a.kapsam = Array.from({ length: z ? 6 : 4 }, () => r.f64())
      r.u8()
      a.izgara = Array.from({ length: r.u32() }, () => r.f64())
    } else if (a.tip === 4) {
      a.genislik = r.u32()
      a.bayrak = r.u8()
      r.bayt(r.varuint())
    } else if (a.tip === 6 || a.tip === 8 || a.tip === 12 || a.tip === 10 || a.tip === 11) {
      a.genislik = r.u8()
      a.bayrak = r.u8()
    } else {
      a.genislik = r.u8()
      a.bayrak = r.u8()
      r.bayt(r.u8())
    }
    alanlar.push(a)
  }
  expect(Array.from(r.bayt(4))).toEqual([0xde, 0xad, 0xbe, 0xef])
  expect(r.o).toBe(bas.fdOfset + 4 + fdBoy)

  const x = okuyucu(tablx)
  const tx = { surum: x.u32(), blok: x.u32(), toplam: x.u32(), ofsetBoyu: x.u32() }
  const nullable = alanlar.filter((a) => a.bayrak & 1).length
  const satirlar = []
  for (let i = 0; i < tx.toplam; i++) {
    x.o = 16 + i * tx.ofsetBoyu
    let ofset = 0
    for (let k = 0; k < tx.ofsetBoyu; k++) ofset += x.u8() * 256 ** k
    r.o = ofset
    const boy = r.u32()
    const son = r.o + boy
    const bitmap = r.bayt(Math.ceil(nullable / 8))
    let iNull = 0
    const satir = { OBJECTID: i + 1 }
    for (const a of alanlar) {
      if (a.tip === 6) continue
      if (a.bayrak & 1) {
        const bos = (bitmap[iNull >> 3] >> (iNull & 7)) & 1
        iNull++
        if (bos) {
          satir[a.ad] = null
          continue
        }
      }
      if (a.tip === 0) satir[a.ad] = r.i16()
      else if (a.tip === 1) satir[a.ad] = r.i32()
      else if (a.tip === 3 || a.tip === 5) satir[a.ad] = r.f64()
      else if (a.tip === 4 || a.tip === 12) satir[a.ad] = utf8.decode(r.bayt(r.varuint()))
      else if (a.tip === 7 || a.tip === 8) satir[a.ad] = r.bayt(r.varuint()).slice()
      else if (a.tip === 10 || a.tip === 11) satir[a.ad] = r.bayt(16).slice()
    }
    expect(r.o).toBe(son)
    satirlar.push(satir)
  }
  x.o = 16 + tx.blok * 1024 * tx.ofsetBoyu
  tx.kuyruk = [x.u32(), x.u32(), x.u32(), x.u32()]
  expect(x.o).toBe(tablx.length)
  return { bas, bayrak, alanlar, satirlar, tx }
}

/** FileGDB geometri blob'unu çözer: { tip, parcalar: [[[x,y(,z)]...]...] }. */
function geometriCoz(blob, g) {
  const r = okuyucu(blob)
  const tip = r.u8()
  const z = [9, 20, 10, 19].includes(tip)
  if (tip === 1 || tip === 9) {
    const p = [(r.varuint() - 1) / g.xyScale + g.xOrigin, (r.varuint() - 1) / g.xyScale + g.yOrigin]
    if (z) p.push((r.varuint() - 1) / g.zScale + g.zOrigin)
    return { tip, parcalar: [[p]] }
  }
  const n = r.varuint()
  const parcaSayisi = tip === 8 || tip === 20 ? 1 : r.varuint()
  for (let i = 0; i < 4; i++) r.varuint()
  const boylar = []
  for (let i = 0; i < parcaSayisi - 1; i++) boylar.push(r.varuint())
  boylar.push(n - boylar.reduce((t, v) => t + v, 0))
  const noktalar = []
  let x = 0
  let y = 0
  for (let i = 0; i < n; i++) {
    x += r.varint()
    y += r.varint()
    noktalar.push([x / g.xyScale + g.xOrigin, y / g.xyScale + g.yOrigin])
  }
  if (z) {
    let zz = 0
    for (const p of noktalar) {
      zz += r.varint()
      p.push(zz / g.zScale + g.zOrigin)
    }
  }
  expect(r.o).toBe(blob.length)
  const parcalar = []
  let k = 0
  for (const b of boylar) {
    parcalar.push(noktalar.slice(k, k + b))
    k += b
  }
  return { tip, parcalar }
}

const alan = (h) => h.slice(0, -1).reduce((t, [x0, y0], i) => t + x0 * h[i + 1][1] - h[i + 1][0] * y0, 0) / 2
const yakin = (a, b, tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

async function ac(veri, ad = 'cikti') {
  const zip = await JSZip.loadAsync(veri)
  const dosyalar = {}
  for (const [yol, d] of Object.entries(zip.files)) if (!d.dir) dosyalar[yol.replace(`${ad}.gdb/`, '')] = await d.async('uint8array')
  const tablo = (no) => {
    const a = `a${no.toString(16).padStart(8, '0')}`
    return tabloOku(dosyalar[`${a}.gdbtable`], dosyalar[`${a}.gdbtablx`])
  }
  return { dosyalar, tablo }
}

describe('filegdbYaz', () => {
  it('GDAL ile aynı sistem tablolarını ve katman tablosunu yazar (delikli poligon, Türkçe öznitelik)', async () => {
    const { veri, uyarilar, onizleme } = await filegdbYaz(
      fc(obje({ type: 'Polygon', coordinates: [kare(500000, 4400000, 100), kare(500010, 4400010, 10)] }, { ad: 'Şükrü Çağlar', sayi: 7, oran: 0.5 })),
      { crs: 'EPSG:5255' },
    )
    expect(uyarilar).toEqual([])
    expect(onizleme).toContain('cikti.gdb')
    const { dosyalar, tablo } = await ac(veri)
    expect(Object.keys(dosyalar).sort()).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7].flatMap((n) => [`a0000000${n}.gdbtable`, `a0000000${n}.gdbtablx`]),
      'a00000009.gdbindexes', 'a00000009.gdbtable', 'a00000009.gdbtablx', 'gdb', 'timestamps',
    ].sort())
    expect(Array.from(dosyalar.gdb)).toEqual([5, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef])
    expect(dosyalar.timestamps).toHaveLength(400)

    const katalog = tablo(1)
    expect(katalog.satirlar.map((s) => s.Name)).toEqual([
      'GDB_SystemCatalog', 'GDB_DBTune', 'GDB_SpatialRefs', 'GDB_Items', 'GDB_ItemTypes', 'GDB_ItemRelationships', 'GDB_ItemRelationshipTypes', 'GDB_ReplicaLog', 'objeler',
    ])
    expect(katalog.satirlar.map((s) => s.FileFormat)).toEqual([0, 0, 0, 0, 0, 0, 0, 2, 0])
    expect(tablo(2).satirlar).toHaveLength(35)
    expect(tablo(5).satirlar).toHaveLength(32)
    expect(tablo(7).satirlar).toHaveLength(16)
    const srs = tablo(3).satirlar
    expect(srs).toHaveLength(2)
    expect(srs[1].SRTEXT).toMatch(/^PROJCS\["TUREF_TM33"/)
    expect(srs[1].SRTEXT).not.toContain('TOWGS84')
    expect(srs[1]).toMatchObject({ FalseX: -2147483647, XYUnits: 10000, XYTolerance: 0.001 })

    const ogeler = tablo(4).satirlar
    expect(ogeler.map((s) => s.Name)).toEqual(['', 'Workspace', 'objeler'])
    expect(ogeler[2]).toMatchObject({ PhysicalName: 'OBJELER', Path: '\\objeler', DatasetSubtype1: 1, DatasetSubtype2: 4, DatasetInfo1: 'SHAPE' })
    const tanim = ogeler[2].Definition
    expect(tanim).toContain('<typens:DEFeatureClassInfo')
    expect(tanim).toContain('<ShapeType>esriGeometryPolygon</ShapeType>')
    expect(tanim).toContain('<WKID>5255</WKID>')
    expect(tanim).toContain('<AreaFieldName>Shape_Area</AreaFieldName>')
    expect(tanim).toContain('<DSID>3</DSID>')
    const iliski = tablo(6).satirlar
    expect(iliski).toHaveLength(1)
    expect(Array.from(iliski[0].OriginID)).toEqual(Array.from(ogeler[0].UUID))
    expect(Array.from(iliski[0].DestID)).toEqual(Array.from(ogeler[2].UUID))

    const k = tablo(9)
    expect(k.bayrak & 0xff).toBe(4) // poligon
    expect(k.tx).toMatchObject({ surum: 3, blok: 1, toplam: 1, ofsetBoyu: 5 })
    expect(k.tx.kuyruk).toEqual([0, 1, 1, 0])
    expect(k.alanlar.map((a) => [a.ad, a.tip, a.bayrak])).toEqual([
      ['SHAPE', 7, 7], ['OBJECTID', 6, 2], ['Shape_Area', 3, 3], ['Shape_Length', 3, 3], ['ad', 4, 5], ['sayi', 1, 5], ['oran', 3, 5],
    ])
    const sekil = k.alanlar[0]
    expect(sekil.wkt).toBe(srs[1].SRTEXT)
    expect(sekil.kapsam).toEqual([500000, 4400000, 500100, 4400100])
    expect(sekil.izgara).toEqual([100])
    const [s] = k.satirlar
    expect(s).toMatchObject({ OBJECTID: 1, Shape_Area: 9900, Shape_Length: 440, ad: 'Şükrü Çağlar', sayi: 7, oran: 0.5 })
    const g = geometriCoz(s.SHAPE, sekil.geom)
    expect(g.tip).toBe(5)
    expect(g.parcalar).toHaveLength(2)
    expect(alan(g.parcalar[0])).toBeLessThan(0) // dış halka saat yönünde
    expect(alan(g.parcalar[1])).toBeGreaterThan(0) // delik saat yönünün tersinde
    expect(g.parcalar[0].map((p) => p.map((v) => Math.round(v)))).toEqual([[500000, 4400000], [500000, 4400100], [500100, 4400100], [500100, 4400000], [500000, 4400000]])

    expect(Array.from(dosyalar['a00000009.gdbindexes'].subarray(0, 8))).toEqual([1, 0, 0, 0, 12, 0, 0, 0])
  })

  it('aileleri katmanlara böler; Z, null geometri, tarih, alan adı kuralları', async () => {
    const { veri, uyarilar } = await filegdbYaz(
      fc(
        obje({ type: 'Point', coordinates: [500123.456, 4400987.654, 812.5] }, { ad: 'ğüşiöçİ', tarih: '2024-02-29', aktif: true }),
        obje({ type: 'MultiPoint', coordinates: [[500001, 4400001, 1], [500002, 4400002, 2]] }, { ad: 'çoklu' }),
        obje({ type: 'LineString', coordinates: [[500000, 4400000], [500030, 4400040]] }, { 'şerit sayısı': 2, OBJECTID: 99, Shape: 'x', select: 1, '1ad': 'r' }),
        obje({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [500005, 4400005] }, { type: 'LineString', coordinates: [[500000, 4400000], [500001, 4400001]] }] }, { kaynak: 'gc' }),
        obje(null, { ad: 'geometrisiz' }),
      ),
      { crs: 'EPSG:5255', ad: 'deneme', katman: 'Kadastro Ölçüm' },
    )
    const metin = uyarilar.join('\n')
    expect(metin).toMatch(/2 tabloya bölündü/)
    expect(metin).toMatch(/GeometryCollection saklayamaz/)
    expect(metin).toMatch(/"OBJECTID" özniteliği "OBJECTID_1"/)
    expect(metin).toMatch(/"Shape" özniteliği "Shape_1"/)
    const { tablo } = await ac(veri, 'deneme')
    expect(tablo(1).satirlar.slice(8).map((s) => s.Name)).toEqual(['Kadastro_Olcum_nokta', 'Kadastro_Olcum_cizgi'])

    const nokta = tablo(9)
    expect(nokta.bayrak & 0xff).toBe(2) // çoklu nokta
    expect(nokta.bayrak >= 2 ** 31).toBe(true) // Z
    expect(nokta.alanlar.map((a) => a.ad)).toEqual(['SHAPE', 'OBJECTID', 'ad', 'tarih', 'aktif', 'kaynak'])
    expect(nokta.alanlar.find((a) => a.ad === 'tarih').tip).toBe(5)
    expect(nokta.alanlar.find((a) => a.ad === 'aktif').tip).toBe(0)
    expect(nokta.satirlar).toHaveLength(4)
    const g = nokta.alanlar[0].geom
    const p = geometriCoz(nokta.satirlar[0].SHAPE, g)
    expect(p.tip).toBe(20)
    expect(yakin(p.parcalar[0][0], [500123.456, 4400987.654, 812.5], 1e-4)).toBe(true)
    expect(nokta.satirlar[0]).toMatchObject({ ad: 'ğüşiöçİ', tarih: 45351, aktif: 1 }) // 2024-02-29 = 45351 (1899-12-30'dan beri gün)
    expect(nokta.satirlar.map((s) => s.ad)).toEqual(['ğüşiöçİ', 'çoklu', null, 'geometrisiz'])
    expect(nokta.satirlar[3].SHAPE).toBeNull()
    expect(nokta.alanlar[0].kapsam).toEqual([500001, 4400001, 500123.456, 4400987.654, 0, 812.5]) // GC noktası Z'siz → 0

    const cizgi = tablo(10)
    expect(cizgi.alanlar.map((a) => a.ad)).toEqual(['SHAPE', 'OBJECTID', 'Shape_Length', 'serit_sayisi', 'OBJECTID_1', 'Shape_1', 'select_', 'F1ad', 'kaynak'])
    expect(cizgi.satirlar[0]).toMatchObject({ Shape_Length: 50, serit_sayisi: 2, OBJECTID_1: 99, Shape_1: 'x', select_: 1, F1ad: 'r' })
    const c = geometriCoz(cizgi.satirlar[0].SHAPE, cizgi.alanlar[0].geom)
    expect(c.tip).toBe(3)
    expect(c.parcalar[0].map((q) => q.map(Math.round))).toEqual([[500000, 4400000], [500030, 4400040]])
    expect(cizgi.satirlar[1].kaynak).toBe('gc')
    expect(tablo(4).satirlar.map((s) => s.Definition && /<DSID>(\d+)/.exec(s.Definition)?.[1])).toEqual([null, undefined, '3', '4'])
  })

  it('WGS84 coğrafi ızgara ayarları ve boş FC', async () => {
    const w = await filegdbYaz(fc(obje({ type: 'LineString', coordinates: [[32.85, 39.93], [32.86, 39.94]] }, { ad: 'Ankara' })), { crs: 'EPSG:4326' })
    const { tablo } = await ac(w.veri)
    const k = tablo(9)
    expect(k.alanlar[0].geom).toMatchObject({ xOrigin: -400, yOrigin: -400, xyScale: 1e9 })
    expect(k.alanlar[0].wkt).toMatch(/^GEOGCS\["GCS_WGS_1984"/)
    expect(tablo(4).satirlar[2].Definition).toContain('typens:GeographicCoordinateSystem')
    const c = geometriCoz(k.satirlar[0].SHAPE, k.alanlar[0].geom)
    expect(yakin(c.parcalar[0][1], [32.86, 39.94], 1e-8)).toBe(true)

    const bos = await filegdbYaz(fc(), { crs: 'EPSG:5254' })
    const b = await ac(bos.veri)
    const t = b.tablo(9)
    expect(t.satirlar).toEqual([])
    expect(t.tx).toMatchObject({ blok: 0, toplam: 0 })
    expect(t.alanlar[0].kapsam.every(Number.isNaN)).toBe(true)
    expect(b.tablo(1).satirlar.at(-1).Name).toBe('objeler')

    const bilinmeyen = await filegdbYaz(fc(obje({ type: 'Point', coordinates: [1, 2] })), { crs: 'EPSG:2320' })
    expect(bilinmeyen.uyarilar.join(' ')).toMatch(/EPSG:2320/)
    const u = await ac(bilinmeyen.veri)
    expect(u.tablo(9).alanlar[0].wkt).toBe('{B286C06B-0879-11D2-AACA-00C04FA33C20}')
  })

  it('GUID ve varint kodlaması GDAL ile aynı', () => {
    expect(Array.from(guidBaytlari('{f3783e6f-65ca-4514-8315-ce3985dad3b1}'), (b) => b.toString(16).padStart(2, '0')).join('')).toBe('6f3e78f3ca6514458315ce3985dad3b1')
    const w = new FgdbYazici()
    w.varint(-1)
    w.varint(63)
    w.varint(64)
    w.varint(-200)
    w.varuint(300)
    expect(Array.from(w.sonuc())).toEqual([0x41, 0x3f, 0x80, 0x01, 0xc8, 0x03, 0xac, 0x02])
    const r = okuyucu(w.sonuc())
    expect([r.varint(), r.varint(), r.varint(), r.varint(), r.varuint()]).toEqual([-1, 63, 64, -200, 300])
  })
})
