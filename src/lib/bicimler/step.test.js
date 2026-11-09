import { describe, it, expect } from 'vitest'
import { stepYaz, p21Dize, p21Sayi, katmanNumaralari, cbsParcalari } from './step.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
const kare = (x, y, b, z) =>
  [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]].map((k) => (z === undefined ? k : [...k, z]))
const ZAMAN = '2026-01-02T03:04:05Z'

/** Part 21 dize çözücü: '' → ', \\ → \, \X2\…\X0\ ve \X4\…\X0\. */
function dizeCoz(govde) {
  let s = govde.slice(1, -1).replace(/''/g, "'")
  s = s.replace(/\\X2\\([0-9A-F]+)\\X0\\/g, (_, h) => String.fromCharCode(...h.match(/.{4}/g).map((x) => parseInt(x, 16))))
  s = s.replace(/\\X4\\([0-9A-F]+)\\X0\\/g, (_, h) => String.fromCodePoint(...h.match(/.{8}/g).map((x) => parseInt(x, 16))))
  return s.replace(/\\\\/g, '\\')
}

/** Basit Part 21 ayrıştırıcı: varlıklar, referans çözümleme. */
function p21Ayristir(metin) {
  const satirlar = metin.split(/\r?\n/)
  expect(satirlar[0]).toBe('ISO-10303-21;')
  expect(satirlar).toContain('END-ISO-10303-21;')
  const dataBas = satirlar.indexOf('DATA;')
  const dataSon = satirlar.lastIndexOf('ENDSEC;')
  expect(dataBas).toBeGreaterThan(0)
  const varliklar = new Map()
  for (const s of satirlar.slice(dataBas + 1, dataSon)) {
    const m = /^#(\d+)=(.*);$/.exec(s)
    if (!m) throw new Error(`Geçersiz varlık satırı: ${s}`)
    if (varliklar.has(Number(m[1]))) throw new Error(`Yinelenen varlık #${m[1]}`)
    const govde = m[2]
    const dizesiz = govde.replace(/'(?:[^']|'')*'/g, "''")
    const tip = /^\(?([A-Z0-9_]+)/.exec(dizesiz)[1]
    const referanslar = [...dizesiz.matchAll(/#(\d+)/g)].map((r) => Number(r[1]))
    varliklar.set(Number(m[1]), { no: Number(m[1]), tip, govde, dizesiz, referanslar })
  }
  for (const v of varliklar.values()) {
    for (const r of v.referanslar) if (!varliklar.has(r)) throw new Error(`#${v.no} çözümlenemeyen referans #${r}`)
  }
  const tipte = (tip) => [...varliklar.values()].filter((v) => v.tip === tip)
  const dizeler = (v) => [...v.govde.matchAll(/'(?:[^']|'')*'/g)].map((d) => dizeCoz(d[0]))
  const sayilar = (v) => [...v.dizesiz.matchAll(/\(([-0-9.E,]+)\)/g)].at(-1)[1].split(',').map(Number)
  return { varliklar, tipte, dizeler, sayilar, satirlar }
}

describe('p21 yardımcıları', () => {
  it('dize kaçışı: tırnak, ters bölü, Türkçe ve BMP dışı karakterler', () => {
    expect(p21Dize("O'Neil")).toBe("'O''Neil'")
    expect(p21Dize('a\\b')).toBe("'a\\\\b'")
    expect(p21Dize('Çınar')).toBe("'\\X2\\00C70131\\X0\\nar'")
    expect(p21Dize('😀x')).toBe("'\\X4\\0001F600\\X0\\x'")
    expect(p21Dize('a\nb')).toBe("'a\\X2\\000A\\X0\\b'")
    for (const m of ["Şişli 'Ada' \\ 😀 ğüç", 'düz']) expect(dizeCoz(p21Dize(m))).toBe(m)
  })

  it('sayılar nokta ondalıklı; çok uzunlar üstel', () => {
    expect(p21Sayi(5)).toBe('5.0')
    expect(p21Sayi(4500000.125)).toBe('4500000.125')
    expect(p21Sayi(1e-300)).toBe('1.E-300')
    expect(p21Sayi(1.5e300)).toBe('1.5E300')
    expect(Number(p21Sayi(1.5e300))).toBe(1.5e300)
  })

  it('katmanNumaralari: tamsayılar korunur, adlar boş numaralara eşlenir, taşma bildirilir', () => {
    const h = katmanNumaralari(['yol', '2', 'bina', 7, 'su'], { min: 1, maks: 3 })
    expect(h.numara('2')).toBe(2)
    expect(h.numara('7')).toBe(3) // aralık dışı → ad gibi
    expect(h.numara('yol')).toBe(1)
    expect(h.numara('bina')).toBe(3)
    expect(h.numara('su')).toBe(3)
    expect(h.tasan).toBe(2)
  })

  it('cbsParcalari istisna atmaz, uyarı üretir', () => {
    const { parcalar, uyarilar } = cbsParcalari(fc(obje(null), obje({ type: 'Curve' }), obje({ type: 'LineString', coordinates: [[0, 0]] }), null))
    expect(parcalar).toEqual([])
    expect(uyarilar[0]).toBe('1 obje geometrisiz olduğu için yazılmadı.')
    expect(uyarilar.join('\n')).toMatch(/"Curve" geometri tipi desteklenmiyor/)
  })
})

describe('stepYaz', () => {
  it('boş FC için geçerli AP214 iskeleti', async () => {
    const { veri, uyarilar } = await stepYaz(fc(), { zaman: ZAMAN })
    expect(typeof veri).toBe('string')
    const d = p21Ayristir(veri)
    expect(veri).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));")
    expect(veri).toContain("'2026-01-02T03:04:05'")
    expect(d.tipte('PRODUCT')).toHaveLength(1)
    expect(d.tipte('APPLICATION_PROTOCOL_DEFINITION')).toHaveLength(1)
    expect(veri).toContain('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.))')
    expect(uyarilar).toEqual([])
  })

  it('her geometri tipini tel kafes olarak yazar; referanslar çözümlenir; koordinatlar geri okunur', async () => {
    const { veri, uyarilar } = await stepYaz(
      fc(
        obje({ type: 'Point', coordinates: [500000.25, 4400000.5, 12] }, { ad: 'Röper Şişli' }),
        obje({ type: 'LineString', coordinates: [[0, 0], [10, 5]] }, { name: "O'Neil" }),
        obje({ type: 'Polygon', coordinates: [kare(0, 0, 10), kare(2, 2, 2)] }),
        obje({ type: 'MultiPoint', coordinates: [[1, 1], [2, 2]] }),
        obje({ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { type: 'MultiPolygon', coordinates: [[kare(5, 5, 1)]] }] }),
        obje(null),
      ),
      { zaman: ZAMAN },
    )
    expect(uyarilar).toEqual(['1 obje geometrisiz olduğu için yazılmadı.'])
    const d = p21Ayristir(veri)
    const urunler = d.tipte('PRODUCT').map((u) => d.dizeler(u)[1])
    expect(urunler).toEqual(['GeoConverter', 'Röper Şişli', "O'Neil", 'Obje 3', 'Obje 4', 'Obje 5'])
    expect(d.tipte('NEXT_ASSEMBLY_USAGE_OCCURRENCE')).toHaveLength(5)
    expect(d.tipte('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')).toHaveLength(5)
    expect(d.tipte('GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION')).toHaveLength(5)
    expect(d.tipte('MANIFOLD_SURFACE_SHAPE_REPRESENTATION')).toHaveLength(0)

    const nokta = (no) => d.sayilar(d.varliklar.get(no))
    // İlk obje: tek nokta
    const kumeler = d.tipte('GEOMETRIC_CURVE_SET')
    expect(kumeler[0].referanslar.map(nokta)).toEqual([[500000.25, 4400000.5, 12]])
    // Poligon: iki kapalı polyline (dış + delik), ilk ve son nokta aynı varlık
    const polyler = kumeler[2].referanslar.map((r) => d.varliklar.get(r))
    expect(polyler.map((p) => p.tip)).toEqual(['POLYLINE', 'POLYLINE'])
    for (const p of polyler) expect(p.referanslar[0]).toBe(p.referanslar.at(-1))
    expect(polyler[0].referanslar.map(nokta)).toEqual([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0]])
    // Açık çizgi kapanmaz
    const cizgi = d.varliklar.get(kumeler[1].referanslar[0])
    expect(cizgi.referanslar.map(nokta)).toEqual([[0, 0, 0], [10, 5, 0]])
    // Karma koleksiyon: çizgi + halka
    expect(kumeler[4].referanslar).toHaveLength(2)
  })

  it('yuzeyler === true ise delikli poligonu üçgen FACE_SURFACE kümesi olarak ekler', async () => {
    const { veri } = await stepYaz(fc(obje({ type: 'Polygon', coordinates: [kare(0, 0, 10, 3), kare(2, 2, 2, 3)] })), { yuzeyler: true, zaman: ZAMAN })
    const d = p21Ayristir(veri)
    const yuzler = d.tipte('FACE_SURFACE')
    expect(yuzler).toHaveLength(8) // delikli kare: 8 üçgen
    expect(d.tipte('SHELL_BASED_SURFACE_MODEL')).toHaveLength(1)
    expect(d.tipte('OPEN_SHELL')[0].referanslar).toHaveLength(8)
    expect(d.tipte('MANIFOLD_SURFACE_SHAPE_REPRESENTATION')).toHaveLength(1)
    for (const dongu of d.tipte('POLY_LOOP')) {
      const k = dongu.referanslar.map((r) => d.sayilar(d.varliklar.get(r)))
      expect(k).toHaveLength(3)
      expect(k.every((n) => n[2] === 3)).toBe(true)
      // CCW (yukarıdan): normal +Z
      const alan = (k[1][0] - k[0][0]) * (k[2][1] - k[0][1]) - (k[2][0] - k[0][0]) * (k[1][1] - k[0][1])
      expect(alan).toBeGreaterThan(0)
    }
    expect(d.tipte('DIRECTION').some((v) => /\(0\.0,0\.0,1\.0\)/.test(v.govde))).toBe(true)
  })

  it('coğrafi CRS için uyarır', async () => {
    const { uyarilar } = await stepYaz(fc(obje({ type: 'Point', coordinates: [32, 39] })), { crs: 'EPSG:4326' })
    expect(uyarilar.some((u) => u.includes('coğrafi'))).toBe(true)
  })
})
