import { describe, it, expect } from 'vitest'
import { ifcYaz, ifcGuid } from './ifc.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
const kare = (x, y, b, z) =>
  [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]].map((k) => (z === undefined ? k : [...k, z]))
const ZAMAN = '2026-01-02T03:04:05Z'
const GUID_DESENI = /^[0-3][0-9A-Za-z_$]{21}$/

function dizeCoz(govde) {
  const s = govde.slice(1, -1).replace(/''/g, "'")
  return s
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/g, (_, h) => String.fromCharCode(...h.match(/.{4}/g).map((x) => parseInt(x, 16))))
    .replace(/\\\\/g, '\\')
}

/** Part 21 ayrıştırıcı + IFC'ye özgü yardımcılar. */
function ayristir(metin) {
  const satirlar = metin.split('\n')
  expect(satirlar[0]).toBe('ISO-10303-21;')
  expect(metin).toContain("FILE_SCHEMA(('IFC4'));")
  const varliklar = new Map()
  for (const s of satirlar.slice(satirlar.indexOf('DATA;') + 1, satirlar.lastIndexOf('ENDSEC;'))) {
    const m = /^#(\d+)=([A-Z0-9]+)\((.*)\);$/.exec(s)
    if (!m) throw new Error(`Geçersiz satır: ${s}`)
    const dizesiz = m[3].replace(/'(?:[^']|'')*'/g, "''")
    varliklar.set(Number(m[1]), {
      no: Number(m[1]),
      tip: m[2],
      govde: m[3],
      referanslar: [...dizesiz.matchAll(/#(\d+)/g)].map((r) => Number(r[1])),
      dizeler: [...m[3].matchAll(/'(?:[^']|'')*'/g)].map((d) => dizeCoz(d[0])),
    })
  }
  for (const v of varliklar.values()) {
    for (const r of v.referanslar) if (!varliklar.has(r)) throw new Error(`#${v.no} → #${r} çözümlenemedi`)
  }
  const tipte = (t) => [...varliklar.values()].filter((v) => v.tip === t)
  const al = (no) => varliklar.get(no)
  const GUIDLI = ['IFCPROJECT', 'IFCSITE', 'IFCRELAGGREGATES', 'IFCGEOGRAPHICELEMENT', 'IFCPROPERTYSET', 'IFCRELDEFINESBYPROPERTIES', 'IFCRELCONTAINEDINSPATIALSTRUCTURE']
  const guidler = [...varliklar.values()].filter((v) => GUIDLI.includes(v.tip)).map((v) => v.dizeler[0])
  return { varliklar, tipte, al, guidler }
}

const noktaListesi = (v) => [...v.govde.matchAll(/\(([-0-9.E]+),([-0-9.E]+),([-0-9.E]+)\)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])

describe('ifcGuid', () => {
  it('22 karakterlik IFC base64, deterministik ve dağınık', () => {
    const g = ifcGuid('a|1')
    expect(g).toMatch(GUID_DESENI)
    expect(ifcGuid('a|1')).toBe(g)
    const kume = new Set(Array.from({ length: 5000 }, (_, i) => ifcGuid(`t|${i}`)))
    expect(kume.size).toBe(5000)
    for (const x of kume) expect(x).toMatch(GUID_DESENI)
  })
})

describe('ifcYaz', () => {
  const ornek = () =>
    fc(
      obje({ type: 'Polygon', coordinates: [kare(500000, 4400000, 10, 100), kare(500002, 4400002, 2, 100)] }, { ad: 'Parsel Çınar', no: 7, alan: 96.5, onayli: true, ek: { a: 1 }, bos: null, layer: 'Kadastro' }),
      obje({ type: 'LineString', coordinates: [[500000, 4400000], [500020, 4400010]] }, { name: "Yol 'A'" }),
      obje({ type: 'MultiPoint', coordinates: [[500005, 4400005, 101]] }),
      obje(null, { x: 1 }),
    )

  it('hiyerarşi, georeferans, geometri ve öznitelikler', async () => {
    const { veri, uyarilar } = await ifcYaz(ornek(), { crs: 'EPSG:5255', zaman: ZAMAN })
    expect(uyarilar).toEqual(['1 obje geometrisiz olduğu için yazılmadı.'])
    const d = ayristir(veri)

    // Hiyerarşi: Project → Site → elemanlar
    const [proje] = d.tipte('IFCPROJECT')
    const [saha] = d.tipte('IFCSITE')
    const [agg] = d.tipte('IFCRELAGGREGATES')
    expect(agg.referanslar).toEqual([proje.no, saha.no])
    const elemanlar = d.tipte('IFCGEOGRAPHICELEMENT')
    expect(elemanlar.map((e) => e.dizeler[1])).toEqual(['Parsel Çınar', "Yol 'A'", 'Obje 3'])
    expect(elemanlar.map((e) => e.dizeler[2])).toEqual(['Kadastro', 'CIZGI', 'NOKTA'])
    expect(elemanlar.every((e) => e.govde.endsWith('.USERDEFINED.'))).toBe(true)
    const [icerik] = d.tipte('IFCRELCONTAINEDINSPATIALSTRUCTURE')
    expect(icerik.referanslar).toEqual([...elemanlar.map((e) => e.no), saha.no])

    // GUID'ler benzersiz ve geçerli
    expect(d.guidler.length).toBeGreaterThan(6)
    expect(new Set(d.guidler).size).toBe(d.guidler.length)
    for (const g of d.guidler) expect(g).toMatch(GUID_DESENI)

    // Georeferans: IfcProjectedCRS + IfcMapConversion (merkez = sınır kutusu alt-orta)
    const [crs] = d.tipte('IFCPROJECTEDCRS')
    expect(crs.dizeler.slice(0, 2)).toEqual(['EPSG:5255', 'ITRF96 / 3° TM 33 (EPSG:5255)'])
    expect(crs.dizeler).toContain('ITRF96')
    const [donusum] = d.tipte('IFCMAPCONVERSION')
    const [, , e, n, h] = donusum.govde.split(',')
    expect([Number(e), Number(n), Number(h)]).toEqual([500010, 4400005, 0])

    // Poligon: delikli → 8 üçgen; mutlak = yerel + öteleme
    const [yuzler] = d.tipte('IFCTRIANGULATEDFACESET')
    const indeksler = [...yuzler.govde.matchAll(/\((\d+),(\d+),(\d+)\)/g)]
    expect(indeksler).toHaveLength(8)
    const koordinatlar = noktaListesi(d.al(yuzler.referanslar[0]))
    expect(koordinatlar).toHaveLength(8)
    expect(koordinatlar[0]).toEqual([500000 - 500010, 4400000 - 4400005, 100])
    for (const m of indeksler) for (const i of m.slice(1)) expect(Number(i)).toBeLessThanOrEqual(8)

    // Çizgi: IfcPolyline; nokta: IfcCartesianPoint (Z korunur)
    const [poly] = d.tipte('IFCPOLYLINE')
    expect(poly.referanslar.map((r) => noktaListesi(d.al(r))[0])).toEqual([[-10, -5, 0], [10, 5, 0]])
    const kumeler = d.tipte('IFCGEOMETRICCURVESET')
    expect(noktaListesi(d.al(kumeler[1].referanslar[0]))[0]).toEqual([-5, 0, 101])

    // Öznitelikler: tip korunur, null yazılmaz
    const degerler = d.tipte('IFCPROPERTYSINGLEVALUE').map((v) => v.govde)
    expect(degerler).toContain("'ad',$,IFCLABEL('Parsel \\X2\\00C70131\\X0\\nar'),$")
    expect(degerler).toContain("'no',$,IFCINTEGER(7),$")
    expect(degerler).toContain("'alan',$,IFCREAL(96.5),$")
    expect(degerler).toContain("'onayli',$,IFCBOOLEAN(.T.),$")
    expect(degerler).toContain("'ek',$,IFCLABEL('{\"a\":1}'),$")
    expect(degerler.some((g) => g.startsWith("'bos'"))).toBe(false)
    const [pset] = d.tipte('IFCPROPERTYSET')
    expect(pset.dizeler[1]).toBe('CBS_Oznitelikler')
    const tanimlar = d.tipte('IFCRELDEFINESBYPROPERTIES')
    expect(tanimlar[0].referanslar).toEqual([elemanlar[0].no, pset.no])

    // Katman ataması
    expect(d.tipte('IFCPRESENTATIONLAYERASSIGNMENT').map((v) => v.dizeler[0])).toEqual(['Kadastro', 'CIZGI', 'NOKTA'])
  })

  it('GUID\'ler aynı girdide kararlı, farklı girdide farklı', async () => {
    const a = ayristir((await ifcYaz(ornek(), { crs: 'EPSG:5255', zaman: ZAMAN })).veri).guidler
    const b = ayristir((await ifcYaz(ornek(), { crs: 'EPSG:5255', zaman: ZAMAN })).veri).guidler
    expect(a).toEqual(b)
    const farkli = ornek()
    farkli.features[0].properties.no = 8
    const c = ayristir((await ifcYaz(farkli, { crs: 'EPSG:5255', zaman: ZAMAN })).veri).guidler
    expect(c.some((g) => a.includes(g))).toBe(false)
  })

  it('CRS yoksa ya da coğrafiyse georeferans yazmaz, mutlak koordinat kullanır ve uyarır', async () => {
    const veri1 = await ifcYaz(fc(obje({ type: 'Point', coordinates: [500000, 4400000] })))
    expect(veri1.uyarilar.some((u) => u.includes('georeferansı'))).toBe(true)
    const d = ayristir(veri1.veri)
    expect(d.tipte('IFCMAPCONVERSION')).toHaveLength(0)
    expect(noktaListesi(d.al(d.tipte('IFCGEOMETRICCURVESET')[0].referanslar[0]))[0]).toEqual([500000, 4400000, 0])
    const veri2 = await ifcYaz(fc(obje({ type: 'Point', coordinates: [32, 39] })), { crs: 'EPSG:4326' })
    expect(veri2.uyarilar.some((u) => u.includes('coğrafi'))).toBe(true)
    expect(ayristir(veri2.veri).tipte('IFCPROJECTEDCRS')).toHaveLength(0)
  })

  it('boş FC ve desteklenmeyen/null geometrilerde geçerli dosya', async () => {
    const bos = ayristir((await ifcYaz(fc(), { crs: 'EPSG:5255' })).veri)
    expect(bos.tipte('IFCPROJECT')).toHaveLength(1)
    expect(bos.tipte('IFCSITE')).toHaveLength(1)
    expect(bos.tipte('IFCGEOGRAPHICELEMENT')).toHaveLength(0)
    const { veri, uyarilar } = await ifcYaz(fc(obje(null), obje({ type: 'Curve' }), obje({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] })), { crs: 'EPSG:5255' })
    expect(ayristir(veri).tipte('IFCGEOGRAPHICELEMENT')).toHaveLength(0)
    expect(uyarilar.join('\n')).toMatch(/"Curve"/)
    expect(uyarilar.join('\n')).toMatch(/alansız/)
  })
})
