import { describe, it, expect } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { netcadGmlYaz, gecerliXmlAdi, tabakaAdi, adaParselAdi, objeTabakasi } from './gml.js'
import { dosyaYaz } from './yazicilar.js'

const TKGM = 'http://www.tkgm.gov.tr'
const GML = 'http://www.opengis.net/gml'
const kare = (x, y, b, z) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]].map((k) => (z === undefined ? k : [...k, z]))
const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })

function ayristir(metin) {
  const hatalar = []
  const doc = new DOMParser({ onError: (_d, m) => hatalar.push(m) }).parseFromString(metin, 'text/xml')
  expect(hatalar).toEqual([])
  return doc
}
const uyeler = (doc) => Array.from(doc.getElementsByTagNameNS(TKGM, 'OzelAlanZemin'))
const alan = (el, ad) => el.getElementsByTagNameNS(TKGM, ad)[0]?.textContent

describe('netcadGmlYaz', () => {
  it('Netcad/TKGM yapısında geçerli XML üretir; delikli poligonu GML 2 ile yazar', () => {
    const { metin, uyarilar, objeSayisi } = netcadGmlYaz(fc(obje({ type: 'Polygon', coordinates: [kare(0, 0, 10, 5), kare(2, 2, 2)] }, { ada: 101, parsel: 7 })))
    expect(metin.startsWith("<?xml version='1.0' encoding='UTF-8'?>")).toBe(true)
    const doc = ayristir(metin)
    expect(doc.documentElement.localName).toBe('FeatureCollection')
    expect(doc.documentElement.namespaceURI).toBe(TKGM)
    const [u] = uyeler(doc)
    expect(u.parentNode.localName).toBe('FeatureMember')
    expect(alan(u, 'id')).toBe('0')
    expect(alan(u, 'ad')).toBe('101/7') // TKGM: ada/parsel
    expect(alan(u, 'tabaka')).toBe('TK_PARSEL')
    expect(alan(u, 'ada')).toBe('101')
    expect(alan(u, 'parsel')).toBe('7')
    const poligon = u.getElementsByTagNameNS(GML, 'Polygon')[0]
    expect(poligon.getElementsByTagNameNS(GML, 'outerBoundaryIs')).toHaveLength(1)
    expect(poligon.getElementsByTagNameNS(GML, 'innerBoundaryIs')).toHaveLength(1)
    // Z yazılmaz, "x,y x,y" biçimi
    expect(poligon.getElementsByTagNameNS(GML, 'coordinates')[0].textContent).toBe('0,0 10,0 10,10 0,10 0,0')
    expect(objeSayisi).toBe(1)
    expect(uyarilar.join(' ')).toMatch(/1 objede nokta konum doğruluğu yok/)
    expect(uyarilar.join(' ')).toMatch(/Tabakalar — TK_PARSEL: 1/)
  })

  it('id yoksa MultiPolygon parçaları ayrı objeler olur (Python explode ile aynı)', () => {
    const { metin } = netcadGmlYaz(fc(obje({ type: 'MultiPolygon', coordinates: [[kare(0, 0, 1)], [kare(5, 5, 1)]] }, { ad: 'x' })))
    const u = uyeler(ayristir(metin))
    expect(u.map((e) => alan(e, 'id'))).toEqual(['0', '1'])
    expect(u.every((e) => e.getElementsByTagNameNS(GML, 'MultiPolygon').length === 0)).toBe(true)
  })

  it('id varsa aynı id gruplanır (MultiPolygon), id sırasına dizilir; ad = ilcead', () => {
    const { metin } = netcadGmlYaz(
      fc(
        obje({ type: 'Polygon', coordinates: [kare(0, 0, 1)] }, { id: 10, ilcead: 'Çankaya', mahalle: 'A' }),
        obje({ type: 'Polygon', coordinates: [kare(5, 5, 1)] }, { id: 2 }),
        obje({ type: 'Polygon', coordinates: [kare(9, 9, 1)] }, { id: 10, mahalle: 'B' }),
      ),
    )
    const u = uyeler(ayristir(metin))
    expect(u.map((e) => alan(e, 'id'))).toEqual(['2', '10'])
    const on = u[1]
    expect(alan(on, 'ad')).toBe('Çankaya')
    expect(alan(on, 'mahalle')).toBe('A') // grubun ilk kaydı
    expect(on.getElementsByTagNameNS(GML, 'polygonMember')).toHaveLength(2)
    expect(alan(on, 'ilcead')).toBeUndefined() // sabit alan ayrıca yazılmaz
  })

  it('öznitelik adlarını XML kuralına çevirir, değerleri kaçışlar, null/NaN yazmaz', () => {
    const { metin, uyarilar } = netcadGmlYaz(
      fc(obje({ type: 'Polygon', coordinates: [kare(0, 0, 1)] }, { 'Ada No': 5, '1alan': 'a & <b>', xmlTip: 1, Şehir: 'İzmir', bos: null, nan: NaN, liste: [1, 2] })),
    )
    const [u] = uyeler(ayristir(metin))
    expect(alan(u, 'Ada_No')).toBe('5')
    expect(alan(u, '_1alan')).toBe('a & <b>')
    expect(alan(u, '_xmlTip')).toBe('1')
    expect(alan(u, 'Şehir')).toBe('İzmir')
    expect(alan(u, 'bos')).toBeUndefined()
    expect(alan(u, 'nan')).toBeUndefined()
    expect(alan(u, 'liste')).toBe('[1,2]')
    expect(uyarilar.join(' ')).toMatch(/"Ada No" → "Ada_No"/)
  })

  it('poligon olmayanları atlar ve uyarır; GeometryCollection içindeki poligonu alır', () => {
    const { metin, uyarilar } = netcadGmlYaz(
      fc(
        obje({ type: 'Point', coordinates: [1, 2] }),
        obje({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }),
        obje(null),
        obje({ type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [kare(0, 0, 1)] }, { type: 'Point', coordinates: [0, 0] }] }),
      ),
    )
    expect(uyeler(ayristir(metin))).toHaveLength(1)
    expect(uyarilar.join(' ')).toMatch(/3 poligon olmayan geometri/)
    expect(uyarilar.join(' ')).toMatch(/Çizgi → Poligon/)
    expect(uyarilar.join(' ')).toMatch(/1 geometrisiz obje/)
  })

  it('hiç poligon yoksa yönlendirici hata verir', () => {
    expect(() => netcadGmlYaz(fc(obje({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })))).toThrow(/Çizgi → Poligon/)
  })
})

describe('gecerliXmlAdi', () => {
  it.each([
    ['ada', 'ada'],
    ['Ada No', 'Ada_No'],
    ['  a  b  ', 'a_b'],
    ['2023', '_2023'],
    ['XMLad', '_XMLad'],
    ['', 'alan'],
    ['Ğüşiöç', 'Ğüşiöç'],
    ['a/b?c', 'a_b_c'],
  ])('%s → %s', (girdi, beklenen) => {
    expect(gecerliXmlAdi(girdi)).toBe(beklenen)
  })

  it('çakışmalara sonek ekler', () => {
    const k = new Set(['id'])
    expect([gecerliXmlAdi('a b', k), gecerliXmlAdi('a_b', k), gecerliXmlAdi('id', k)]).toEqual(['a_b', 'a_b_2', 'id_2'])
  })
})

describe('dosyaYaz(.gml)', () => {
  it('mime, uzantı ve uyarıları döndürür', async () => {
    const s = await dosyaYaz(fc(obje({ type: 'Polygon', coordinates: [kare(0, 0, 1)] }), obje({ type: 'Point', coordinates: [0, 0] })), '.GML')
    expect(s.uzanti).toBe('.gml')
    expect(s.mime).toBe('application/gml+xml')
    expect(s.onizleme).toBe(s.veri)
    expect(s.uyarilar.join(' ')).toMatch(/1 poligon olmayan/)
  })
})

describe('TKGM adlandırma (GML Converter 7.2)', () => {
  it.each([
    [0.09, 'TK_PARSEL_009'],
    [0.9, 'TK_PARSEL_090'],
    [1, 'TK_PARSEL_100'],
    [1.01, 'TK_PARSEL_101'],
    [1.51, 'TK_PARSEL_151'],
    ['0,21', 'TK_PARSEL_021'],
    ['0.25', 'TK_PARSEL_025'],
    [0.5, 'TK_PARSEL_050'],
    [1.75, 'TK_PARSEL_175'],
    [0.07 + 0.14, 'TK_PARSEL_021'], // kayan nokta: 0.21000000000000002
    [0.125, 'TK_PARSEL_013'], // yarım değer yukarı (Python tarafı da aynı)
  ])('nokta konum doğruluğu %s → %s', (nkd, beklenen) => {
    expect(tabakaAdi(nkd)).toBe(beklenen)
  })

  it.each([null, '', 'abc', 0, 0.004, 10, -1])('geçersiz doğruluk %s → null', (nkd) => {
    expect(tabakaAdi(nkd)).toBeNull()
  })

  it.each([
    [{ ada: 5494, parsel: 14 }, '5494/14'],
    [{ ADA: '5494', PARSEL: '14' }, '5494/14'],
    [{ 'Ada No': 5494.0, 'Parsel No': '14.0' }, '5494/14'],
    [{ ada_no: '101', parsel_no: '7' }, '101/7'],
    [{ adaparsel: '5494 / 9' }, '5494/9'],
    [{ ada: 5494 }, null],
    [{ parsel: 3 }, null],
    [{}, null],
  ])('%j → %s', (ozellikler, beklenen) => {
    expect(adaParselAdi(ozellikler)).toBe(beklenen)
  })

  it('tabaka önceliği: verideki tabaka → nkd sütunu → varsayılan → TK_PARSEL', () => {
    expect(objeTabakasi({ tabaka: 'tk_parsel_151', nkd: 0.21 }, 0.5)).toEqual({ tabaka: 'TK_PARSEL_151', kaynak: 'veri' })
    expect(objeTabakasi({ tabaka: 'BINA', 'Nokta Konum Doğruluğu': '0,21' }, 0.5)).toEqual({ tabaka: 'TK_PARSEL_021', kaynak: 'nkd' })
    expect(objeTabakasi({}, '1,75')).toEqual({ tabaka: 'TK_PARSEL_175', kaynak: 'varsayilan' })
    expect(objeTabakasi({}, null)).toEqual({ tabaka: 'TK_PARSEL', kaynak: 'yok' })
  })

  it('PDF örneğindeki gibi: her parsel ada/parsel adı ve kendi tabakasıyla yazılır', () => {
    const ornek = [
      ['14', 1.01], ['15', 0.21], ['12', 1], ['11', 0.09], ['10', 0.9], ['9', 1.51], ['8', 0.5], ['7', 0.25],
    ].map(([parsel, nkd], i) => obje({ type: 'Polygon', coordinates: [kare(i * 2, 0, 1)] }, { ada: 5494, parsel, nkd }))
    const { metin, uyarilar } = netcadGmlYaz(fc(...ornek))
    const u = uyeler(ayristir(metin))
    expect(u.map((e) => [alan(e, 'ad'), alan(e, 'tabaka')])).toEqual([
      ['5494/14', 'TK_PARSEL_101'], ['5494/15', 'TK_PARSEL_021'], ['5494/12', 'TK_PARSEL_100'], ['5494/11', 'TK_PARSEL_009'],
      ['5494/10', 'TK_PARSEL_090'], ['5494/9', 'TK_PARSEL_151'], ['5494/8', 'TK_PARSEL_050'], ['5494/7', 'TK_PARSEL_025'],
    ])
    expect(uyarilar.join(' ')).not.toMatch(/ada\/parsel bilgisi bulunamadı|nokta konum doğruluğu yok/)
  })

  it('varsayılan doğruluk seçeneği uygulanır; geçersiz değer hata verir; ada/parselsiz obje uyarılır', () => {
    const veri = fc(obje({ type: 'Polygon', coordinates: [kare(0, 0, 1)] }, { mahalle: 'X' }))
    const { metin, uyarilar } = netcadGmlYaz(veri, { noktaKonumDogrulugu: '0,21' })
    const [u] = uyeler(ayristir(metin))
    expect(alan(u, 'tabaka')).toBe('TK_PARSEL_021')
    expect(uyarilar.join(' ')).toMatch(/1 objede ada\/parsel bilgisi bulunamadı/)
    expect(() => netcadGmlYaz(veri, { noktaKonumDogrulugu: '12' })).toThrow(/0,01 ile 9,99/)
  })
})
