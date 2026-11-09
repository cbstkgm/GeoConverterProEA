import { describe, it, expect } from 'vitest'
import { dxfYaz, dxfSayi, katmanAdiTemizle, poligonIcNoktasi, poligonIcindeMi, cizgiOrtaNoktasi, xdataDizgeleri } from './dxf.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })
const kare = (x, y, b, z) =>
  [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]].map((k) => (z === undefined ? k : [...k, z]))

function dogrula(kosul, mesaj) {
  if (!kosul) throw new Error(`DXF yapısı geçersiz: ${mesaj}`)
}

/** Basit R12 DXF ayrıştırıcısı: grup kodu/değer çiftleri → bölümler → varlıklar. */
function ayristir(metin) {
  expect(metin.endsWith('\r\n')).toBe(true)
  // Her satır CRLF ile bitmeli; tek başına LF olmamalı
  expect(/[^\r]\n/.test(metin)).toBe(false)
  const satirlar = metin.slice(0, -2).split('\r\n')
  expect(satirlar.length % 2).toBe(0)
  const ciftler = []
  for (let i = 0; i < satirlar.length; i += 2) {
    const kod = satirlar[i].trim()
    dogrula(/^\d+$/.test(kod), `grup kodu sayı değil: "${kod}"`)
    ciftler.push([Number(kod), satirlar[i + 1]])
  }
  expect(ciftler.at(-1)).toEqual([0, 'EOF'])

  const bolumler = {}
  let i = 0
  while (ciftler[i][1] !== 'EOF') {
    expect(ciftler[i]).toEqual([0, 'SECTION'])
    expect(ciftler[i + 1][0]).toBe(2)
    const ad = ciftler[i + 1][1]
    i += 2
    const icerik = []
    while (!(ciftler[i][0] === 0 && ciftler[i][1] === 'ENDSEC')) icerik.push(ciftler[i++])
    i++
    bolumler[ad] = icerik
  }

  // Varlıklar: 0 koduyla başlayan gruplar
  const gruplar = (dizi) => {
    const sonuc = []
    for (const [kod, deger] of dizi) {
      if (kod === 0) sonuc.push({ tip: deger, kodlar: [] })
      else sonuc.at(-1).kodlar.push([kod, deger])
    }
    return sonuc
  }
  const al = (g, kod) => g.kodlar.find(([k]) => k === kod)?.[1]
  const sayi = (g, kod) => Number(al(g, kod))
  /** XDATA: 1001 uygulama adından sonra gelen 1000 dizgeleri; 1001 varlığın son grup kodları olmalı. */
  const xdataAl = (g) => {
    const i = g.kodlar.findIndex(([k]) => k === 1001)
    if (i < 0) return null
    const sonrasi = g.kodlar.slice(i + 1)
    dogrula(sonrasi.every(([k]) => k === 1000), 'XDATA sonrasında XDATA olmayan grup kodu')
    return { uygulama: g.kodlar[i][1], dizgeler: sonrasi.map(([, v]) => v) }
  }

  // POLYLINE/VERTEX/SEQEND eşleşmesini çöz
  const ham = gruplar(bolumler.ENTITIES || [])
  const varliklar = []
  for (let j = 0; j < ham.length; j++) {
    const g = ham[j]
    if (g.tip === 'POLYLINE') {
      expect(al(g, 66)).toBe('1')
      const koseler = []
      j++
      while (ham[j] && ham[j].tip === 'VERTEX') {
        koseler.push([sayi(ham[j], 10), sayi(ham[j], 20), sayi(ham[j], 30)])
        dogrula(al(ham[j], 8) === al(g, 8), 'VERTEX katmanı POLYLINE ile aynı değil')
        dogrula(xdataAl(ham[j]) === null, 'VERTEX üzerinde XDATA olmamalı')
        j++
      }
      expect(ham[j]?.tip).toBe('SEQEND')
      varliklar.push({ tip: 'POLYLINE', katman: al(g, 8), bayrak: sayi(g, 70), koseler, xdata: xdataAl(g), g })
    } else if (g.tip === 'VERTEX' || g.tip === 'SEQEND') {
      throw new Error(`Sahipsiz ${g.tip}`)
    } else {
      varliklar.push({ tip: g.tip, katman: al(g, 8), konum: [sayi(g, 10), sayi(g, 20), sayi(g, 30)], metin: al(g, 1), xdata: xdataAl(g), g })
    }
  }

  const baslik = {}
  let anahtar = null
  for (const [kod, deger] of bolumler.HEADER) {
    if (kod === 9) {
      anahtar = deger
      baslik[anahtar] = []
    } else baslik[anahtar].push([kod, deger])
  }
  const tablolar = gruplar(bolumler.TABLES)
  const katmanlar = tablolar.filter((t) => t.tip === 'LAYER').map((t) => al(t, 2))
  const appidler = tablolar.filter((t) => t.tip === 'APPID').map((t) => al(t, 2))
  return { bolumler, baslik, varliklar, katmanlar, appidler, seqendSayisi: ham.filter((g) => g.tip === 'SEQEND').length }
}

describe('dxfSayi', () => {
  it('yerel ayardan bağımsız, nokta ondalıklı, üstelsiz ve tam hassasiyetli yazar', () => {
    expect(dxfSayi(5)).toBe('5.0')
    expect(dxfSayi(-0)).toBe('0.0')
    expect(dxfSayi(412345.678901234)).toBe('412345.678901234')
    expect(dxfSayi(1e-7)).toBe('0.0000001')
    expect(dxfSayi(-1.25e-8)).toBe('-0.0000000125')
    expect(dxfSayi(1e21)).toBe('1000000000000000000000.0')
    expect(dxfSayi(1.5e22)).toBe('15000000000000000000000.0')
    for (const n of [0.1 + 0.2, 4567890.123456789, -33.000001, 1e-7, 1.5e22, 123e-20]) {
      expect(Number(dxfSayi(n))).toBe(n)
    }
    expect(() => dxfSayi(NaN)).toThrow()
  })
})

describe('katmanAdiTemizle', () => {
  it('R12 kurallarına göre temizler, Türkçe harfleri korur', () => {
    expect(katmanAdiTemizle('yapı sınırı')).toBe('YAPI_SINIRI')
    expect(katmanAdiTemizle('isim')).toBe('İSİM')
    expect(katmanAdiTemizle('a<b>c/d\\e"f:g;h?i*j|k=l`m')).toBe('A_B_C_D_E_F_G_H_İ_J_K_L_M')
    expect(katmanAdiTemizle('Çğöşü$-_9')).toBe('ÇĞÖŞÜ$-_9')
    expect(katmanAdiTemizle('x'.repeat(50))).toHaveLength(31)
    expect(katmanAdiTemizle('  ')).toBeNull()
    expect(katmanAdiTemizle('***')).toBeNull()
    expect(katmanAdiTemizle(12)).toBe('12')
  })
})

describe('dxfYaz', () => {
  it('boş FC için geçerli bir R12 iskeleti üretir', async () => {
    const { veri, onizleme, uyarilar } = await dxfYaz(fc())
    expect(veri).toBeInstanceOf(Uint8Array)
    const d = ayristir(onizleme)
    expect(Object.keys(d.bolumler)).toEqual(['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES'])
    expect(d.baslik.$ACADVER).toEqual([[1, 'AC1009']])
    expect(d.baslik.$DWGCODEPAGE).toEqual([[3, 'ANSI_1254']])
    expect(d.baslik.$INSUNITS).toEqual([[70, '6']])
    expect(d.varliklar).toEqual([])
    expect(d.katmanlar).toEqual(['0'])
    expect(uyarilar).toEqual([])
  })

  it('geçersiz girdide istisna atar', async () => {
    await expect(dxfYaz(null)).rejects.toThrow(/FeatureCollection/)
  })

  it('her geometri tipini yazar ve koordinatları geri okur', async () => {
    const { onizleme, uyarilar } = await dxfYaz(
      fc(
        obje({ type: 'Point', coordinates: [412345.678, 4523456.789] }),
        obje({ type: 'LineString', coordinates: [[0, 0], [10, 5], [20, 0]] }),
        obje({ type: 'Polygon', coordinates: [kare(100, 100, 50), kare(110, 110, 10)] }),
        obje({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }),
        obje({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }),
        obje({ type: 'MultiPolygon', coordinates: [[kare(0, 0, 1)], [kare(5, 5, 2), kare(5.5, 5.5, 0.5)]] }),
        obje({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [7, 8] }, { type: 'LineString', coordinates: [[0, 0], [9, 9]] }] }),
      ),
    )
    expect(uyarilar).toEqual([])
    const d = ayristir(onizleme)
    const noktalar = d.varliklar.filter((v) => v.tip === 'POINT')
    const cizgiler = d.varliklar.filter((v) => v.tip === 'POLYLINE' && v.bayrak === 0)
    const halkalar = d.varliklar.filter((v) => v.tip === 'POLYLINE' && v.bayrak === 1)
    expect(noktalar.map((n) => n.konum)).toEqual([[412345.678, 4523456.789, 0], [1, 2, 0], [3, 4, 0], [7, 8, 0]])
    expect(noktalar.every((n) => n.katman === 'NOKTA')).toBe(true)
    expect(cizgiler).toHaveLength(4)
    expect(cizgiler.every((c) => c.katman === 'CIZGI')).toBe(true)
    expect(cizgiler[0].koseler).toEqual([[0, 0, 0], [10, 5, 0], [20, 0, 0]])
    // Polygon: dış + delik; MultiPolygon: 1 + (dış + delik) = 5 kapalı halka
    expect(halkalar).toHaveLength(5)
    expect(halkalar.every((h) => h.katman === 'POLIGON')).toBe(true)
    // Kapalı halkada tekrarlanan son köşe yazılmaz
    expect(halkalar[0].koseler).toEqual([[100, 100, 0], [150, 100, 0], [150, 150, 0], [100, 150, 0]])
    expect(halkalar[1].koseler[0]).toEqual([110, 110, 0])
    expect(d.seqendSayisi).toBe(cizgiler.length + halkalar.length)
    expect(d.katmanlar).toEqual(['0', 'CIZGI', 'NOKTA', 'POLIGON'])
  })

  it('sınır kutusunu $EXTMIN/$EXTMAX olarak yazar', async () => {
    const { onizleme } = await dxfYaz(
      fc(obje({ type: 'Point', coordinates: [-5, 3, 2] }), obje({ type: 'LineString', coordinates: [[10, -7], [12, 40, -1]] })),
    )
    const d = ayristir(onizleme)
    expect(d.baslik.$EXTMIN.map(([, v]) => Number(v))).toEqual([-5, -7, -1])
    expect(d.baslik.$EXTMAX.map(([, v]) => Number(v))).toEqual([12, 40, 2])
  })

  it('Z değerlerini korur: POINT 30 kodu, 3B polyline bayrak 8 ve köşe bayrağı 32', async () => {
    const { onizleme } = await dxfYaz(
      fc(
        obje({ type: 'Point', coordinates: [1, 2, 3.5] }),
        obje({ type: 'LineString', coordinates: [[0, 0, 10], [1, 1, 11]] }),
        obje({ type: 'Polygon', coordinates: [kare(0, 0, 1, 99)] }),
      ),
    )
    const d = ayristir(onizleme)
    expect(d.varliklar[0].konum).toEqual([1, 2, 3.5])
    expect(d.varliklar[1].bayrak).toBe(8)
    expect(d.varliklar[1].koseler).toEqual([[0, 0, 10], [1, 1, 11]])
    expect(d.varliklar[2].bayrak).toBe(9)
    expect(d.varliklar[2].koseler.every((k) => k[2] === 99)).toBe(true)
    const vertex3B = onizleme.split('VERTEX').length - 1
    expect(onizleme.match(/ 70\r\n32\r\n/g)).toHaveLength(vertex3B)
  })

  it('katmanı layer/katman/tabaka özniteliğinden alır ve temizler; Türkçe karakterleri Windows-1254 ile kodlar', async () => {
    const { veri, onizleme, uyarilar } = await dxfYaz(
      fc(
        obje({ type: 'Point', coordinates: [0, 0] }, { Layer: 'yol aksı' }),
        obje({ type: 'Point', coordinates: [1, 1] }, { katman: 'BİNA' }),
        obje({ type: 'Point', coordinates: [2, 2] }, { tabaka: 'a/b' }),
        obje({ type: 'Point', coordinates: [3, 3] }, { layer: '' }),
      ),
    )
    const d = ayristir(onizleme)
    expect(d.varliklar.map((v) => v.katman)).toEqual(['YOL_AKSI', 'BİNA', 'A_B', 'NOKTA'])
    expect(d.katmanlar).toEqual(['0', 'A_B', 'BİNA', 'NOKTA', 'YOL_AKSI'])
    expect(uyarilar.some((u) => u.includes('katman adı') && u.includes('"yol aksı" → "YOL_AKSI"'))).toBe(true)
    // Bayt düzeyi: İ = 0xDD, Windows-1254 ile geri çözülünce önizlemeyle aynı
    expect(Array.from(veri)).toContain(0xdd)
    expect(new TextDecoder('windows-1254').decode(veri)).toBe(onizleme)
  })

  it('etiketler === true ise name/ad özniteliğinden TEXT yazar', async () => {
    const veriler = fc(
      obje({ type: 'Point', coordinates: [10, 20, 5] }, { name: 'Röper 1' }),
      obje({ type: 'MultiPoint', coordinates: [[1, 1], [2, 2]] }, { ad: 'Çift' }),
      obje({ type: 'Point', coordinates: [0, 0] }, { ad: '日' }),
      obje({ type: 'LineString', coordinates: [[0, 0, 0], [10, 0, 10], [10, 10, 20]] }, { name: 'Yol' }),
    )
    const etiketsiz = ayristir((await dxfYaz(veriler)).onizleme)
    expect(etiketsiz.varliklar.filter((v) => v.tip === 'TEXT')).toHaveLength(0)

    const { onizleme } = await dxfYaz(veriler, { etiketler: true, etiketYuksekligi: 2.5 })
    const metinler = ayristir(onizleme).varliklar.filter((v) => v.tip === 'TEXT')
    expect(metinler.map((m) => m.metin)).toEqual(['Röper 1', 'Çift', 'Çift', '\\U+65E5', 'Yol'])
    expect(metinler[0].konum).toEqual([10, 20, 5])
    expect(metinler[0].katman).toBe('NOKTA')
    expect(metinler[0].g.kodlar.find(([k]) => k === 40)[1]).toBe('2.5')
    // Orta-orta hizalama: 72=1, 73=2, hizalama noktası 11/21/31 = konum
    for (const m of metinler) {
      const kod = (k) => m.g.kodlar.find(([c]) => c === k)?.[1]
      expect(kod(72)).toBe('1')
      expect(kod(73)).toBe('2')
      expect([Number(kod(11)), Number(kod(21)), Number(kod(31))]).toEqual(m.konum)
    }
    // Çizgi: uzunluğun ortası (toplam 20 → 10. birim = ikinci köşe), Z enterpolasyonlu
    expect(metinler[4].konum).toEqual([10, 0, 10])
    expect(metinler[4].katman).toBe('CIZGI')
  })

  it('poligon etiketini her parçanın gerçekten İÇİNE koyar (dışbükey, U, C, delikli, elmas)', async () => {
    const U = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30], [0, 0]]
    const C = [[0, 0], [30, 0], [30, 5], [5, 5], [5, 25], [30, 25], [30, 30], [0, 30], [0, 0]]
    // Ağırlık merkezi (15,15) deliğe düşen kare
    const delikli = [kare(0, 0, 30), kare(5, 5, 20)]
    const elmas = [[0, 15], [10, 0], [20, 15], [10, 30], [0, 15]]
    const durumlar = [
      ['Kare', [kare(100, 100, 10)]],
      ['U', [U]],
      ['C', [C]],
      ['Delikli', delikli],
      ['Elmas', [elmas]],
    ]
    const veriler = fc(
      ...durumlar.map(([ad, halkalar]) => obje({ type: 'Polygon', coordinates: halkalar }, { ad })),
      obje({ type: 'MultiPolygon', coordinates: [[U], delikli] }, { ad: 'Çoklu' }),
    )
    const { onizleme, uyarilar } = await dxfYaz(veriler, { etiketler: true })
    expect(uyarilar).toEqual([])
    const metinler = ayristir(onizleme).varliklar.filter((v) => v.tip === 'TEXT')
    expect(metinler.map((m) => m.metin)).toEqual(['Kare', 'U', 'C', 'Delikli', 'Elmas', 'Çoklu', 'Çoklu'])
    const beklenen = [...durumlar.map(([, h]) => h), [U], delikli]
    metinler.forEach((m, i) => {
      expect(poligonIcindeMi(m.konum[0], m.konum[1], beklenen[i])).toBe(true)
      expect(m.katman).toBe('POLIGON')
    })
    expect(metinler[0].konum).toEqual([105, 105, 0]) // dışbükeyde ağırlık merkezi
  })

  it('poligonIcNoktasi: ağırlık merkezi dışarıdayken iç nokta bulur; Z ortalaması; alansızda null', () => {
    const U = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]]
    const C = [[0, 0], [30, 0], [30, 5], [5, 5], [5, 25], [30, 25], [30, 30], [0, 30]]
    const dis = [[0, 0], [30, 0], [30, 30], [0, 30]]
    const delik = [[5, 5], [25, 5], [25, 25], [5, 25]]
    expect(poligonIcindeMi(15, 15, [U])).toBe(false)
    expect(poligonIcindeMi(15, 15, [dis, delik])).toBe(false)
    for (const halkalar of [[U], [C], [dis, delik]]) {
      const [x, y] = poligonIcNoktasi(halkalar[0], halkalar.slice(1))
      expect(poligonIcindeMi(x, y, halkalar)).toBe(true)
    }
    expect(poligonIcNoktasi([[0, 0, 10], [4, 0, 20], [4, 4, 30], [0, 4, 40]])).toEqual([2, 2, 25])
    expect(poligonIcNoktasi([[0, 0], [1, 1], [2, 2]])).toBeNull()
    expect(cizgiOrtaNoktasi([[0, 0], [0, 0]])).toEqual([0, 0])
  })

  it('öznitelikleri XDATA olarak yazar: APPID kaydı, 1001/1000 yapısı, POLYLINE üzerinde', async () => {
    const veriler = fc(
      obje({ type: 'Point', coordinates: [1, 2] }, { ad: 'Röper', no: 7, a: null, 'k=v': true, o: { x: 1 } }),
      obje({ type: 'MultiPolygon', coordinates: [[kare(0, 0, 10), kare(2, 2, 2)], [kare(20, 20, 5)]] }, { parsel: '5494/14' }),
      obje({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, {}),
    )
    const { onizleme, uyarilar } = await dxfYaz(veriler)
    expect(uyarilar).toEqual([])
    const d = ayristir(onizleme)
    expect(d.appidler).toEqual(['ACAD', 'GEOCONVERTER'])
    const [nokta, ...digerleri] = d.varliklar
    expect(nokta.xdata).toEqual({ uygulama: 'GEOCONVERTER', dizgeler: ['ad=Röper', 'no=7', 'k_v=true', 'o={"x":1}'] })
    const halkalar = digerleri.filter((v) => v.bayrak === 1)
    expect(halkalar).toHaveLength(3)
    for (const h of halkalar) expect(h.xdata).toEqual({ uygulama: 'GEOCONVERTER', dizgeler: ['parsel=5494/14'] })
    expect(digerleri.at(-1).xdata).toBeNull() // özniteliksiz obje: XDATA yok
    // POLYLINE'da XDATA 70 bayrağından sonra, ilk VERTEX'ten önce
    expect(onizleme).toMatch(/ 70\r\n1\r\n1001\r\nGEOCONVERTER\r\n1000\r\nparsel=5494\/14\r\n  0\r\nVERTEX/)

    const kapali = ayristir((await dxfYaz(veriler, { oznitelikler: false })).onizleme)
    expect(kapali.varliklar.every((v) => v.xdata === null)).toBe(true)
  })

  it('XDATA 255 bayt dizge sınırını ve 16 KB varlık sınırını uygular, uyarır', async () => {
    const uzun = 'ş'.repeat(300)
    const kacisli = 'a'.repeat(250) + '日本'
    const { dizgeler, kesilenDeger } = xdataDizgeleri({ uzun, kacisli })
    expect(kesilenDeger).toBe(2)
    expect(dizgeler[0]).toBe('uzun=' + 'ş'.repeat(250))
    // \U+65E5 kaçışı bölünmez: "kacisli=" (8) + 250 a = 258 > 255 → kesilir, kaçış hiç yazılmaz
    expect(dizgeler[1]).toBe('kacisli=' + 'a'.repeat(247))

    const { veri, onizleme, uyarilar } = await dxfYaz(fc(obje({ type: 'Point', coordinates: [0, 0] }, { uzun })))
    const x = ayristir(onizleme).varliklar[0].xdata
    expect(x.dizgeler[0]).toBe('uzun=' + 'ş'.repeat(250))
    // Bayt düzeyi: Windows-1254'te her karakter tek bayt → 1000 değeri tam 255 bayt
    expect(veri.length).toBe(onizleme.length)
    expect(uyarilar).toContain('1 öznitelik değeri DXF XDATA sınırı (255 bayt) nedeniyle kısaltıldı.')

    const cok = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`alan${i}`, 'x'.repeat(240)]))
    const sonuc = xdataDizgeleri(cok)
    expect(sonuc.toplamKesildi).toBe(true)
    const toplam = 'GEOCONVERTER'.length + 4 + sonuc.dizgeler.reduce((t, d) => t + d.length + 4, 0)
    expect(toplam).toBeLessThanOrEqual(16383)
    expect(sonuc.dizgeler.length).toBeGreaterThan(60)
    const y = await dxfYaz(fc(obje({ type: 'Point', coordinates: [0, 0] }, cok)))
    expect(y.uyarilar.some((u) => u.includes('16 KB'))).toBe(true)
  })

  it('null geometri ve sorunlu geometrilerde istisna atmaz, Türkçe uyarı ekler', async () => {
    const { onizleme, uyarilar } = await dxfYaz(
      fc(
        obje(null, { a: 1 }),
        obje({ type: 'Point', coordinates: [] }),
        obje({ type: 'LineString', coordinates: [[0, 0]] }),
        obje({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] }),
        obje({ type: 'LineString', coordinates: [[0, 0], [NaN, 1], [2, 2]] }),
        obje({ type: 'Curve', coordinates: [] }),
        obje({ type: 'GeometryCollection', geometries: [] }),
        null,
      ),
    )
    const d = ayristir(onizleme)
    expect(d.varliklar).toHaveLength(1)
    expect(d.varliklar[0].koseler).toEqual([[0, 0, 0], [2, 2, 0]])
    expect(uyarilar[0]).toBe("1 obje geometrisiz olduğu için DXF'e yazılmadı.")
    expect(uyarilar.join('\n')).toMatch(/Obje 2: nokta koordinatı geçersiz/)
    expect(uyarilar.join('\n')).toMatch(/Obje 3: çizgi en az 2/)
    expect(uyarilar.join('\n')).toMatch(/Obje 4 dış halka: halka en az 3/)
    expect(uyarilar.join('\n')).toMatch(/Obje 5: 1 geçersiz koordinat/)
    expect(uyarilar.join('\n')).toMatch(/"Curve" geometri tipi/)
    expect(uyarilar.join('\n')).toMatch(/Obje 7: boş çoklu geometri/)
  })

  it('coğrafi CRS için birimsiz yazar ve uyarır', async () => {
    const { onizleme, uyarilar } = await dxfYaz(fc(obje({ type: 'Point', coordinates: [32.85, 39.92] })), { crs: 'EPSG:4326' })
    expect(ayristir(onizleme).baslik.$INSUNITS).toEqual([[70, '0']])
    expect(uyarilar.some((u) => u.includes('coğrafi'))).toBe(true)
    const p = await dxfYaz(fc(obje({ type: 'Point', coordinates: [500000, 4400000] })), { crs: 'EPSG:5255' })
    expect(ayristir(p.onizleme).baslik.$INSUNITS).toEqual([[70, '6']])
    expect(p.uyarilar).toEqual([])
  })

  it('büyük veride yığın taşması olmadan çalışır', async () => {
    const konumlar = Array.from({ length: 200000 }, (_, i) => [i, i * 0.5])
    const { onizleme } = await dxfYaz(fc(obje({ type: 'LineString', coordinates: konumlar })))
    const d = ayristir(onizleme)
    expect(d.varliklar[0].koseler).toHaveLength(200000)
    expect(d.varliklar[0].koseler.at(-1)).toEqual([199999, 99999.5, 0])
  })
})
