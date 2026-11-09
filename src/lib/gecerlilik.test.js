import { describe, it, expect } from 'vitest'
import { gecerlilikDenetle, geometriDenetle } from './gecerlilik.js'

const kare = (x, y, b) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]]
const poligon = (...halkalar) => ({ type: 'Polygon', coordinates: halkalar })
const fc = (...geometriler) => ({
  type: 'FeatureCollection',
  features: geometriler.map((geometry) => ({ type: 'Feature', properties: {}, geometry })),
})

describe('geometriDenetle — geçerli geometriler', () => {
  it.each([
    ['nokta', { type: 'Point', coordinates: [30, 40] }],
    ['çizgi', { type: 'LineString', coordinates: [[0, 0], [1, 1]] }],
    ['kendini kesen çizgi (OGC: geçerli, yalnızca basit değil)', { type: 'LineString', coordinates: [[0, 0], [2, 2], [2, 0], [0, 2]] }],
    ['kare poligon', poligon(kare(0, 0, 10))],
    ['ters yönlü kare', poligon(kare(0, 0, 10).reverse())],
    ['tekrarlanan ardışık noktalar', poligon([[0, 0], [1, 0], [1, 0], [1, 1], [0, 1], [0, 0]])],
    ['delikli poligon', poligon(kare(0, 0, 10), kare(2, 2, 2))],
    ['dış sınıra tek noktada değen delik', poligon(kare(0, 0, 10), [[0, 5], [3, 4], [3, 6], [0, 5]])],
    ['iki ayrı parçalı MultiPolygon', { type: 'MultiPolygon', coordinates: [[kare(0, 0, 1)], [kare(5, 5, 1)]] }],
    ['köşede değen MultiPolygon parçaları', { type: 'MultiPolygon', coordinates: [[kare(0, 0, 1)], [kare(1, 1, 1)]] }],
    ['deliğin içindeki ada', { type: 'MultiPolygon', coordinates: [[kare(0, 0, 10), kare(2, 2, 6)], [kare(4, 4, 2)]] }],
  ])('%s geçerli', (_ad, g) => {
    expect(geometriDenetle(g)).toBeNull()
  })
})

describe('geometriDenetle — geçersiz geometriler', () => {
  it.each([
    ['sayısal olmayan koordinat', { type: 'Point', coordinates: [NaN, 1] }, /sayısal olmayan/],
    ['tek farklı noktalı çizgi', { type: 'LineString', coordinates: [[1, 1], [1, 1]] }, /2'den az farklı/],
    ['kapalı olmayan halka', poligon([[0, 0], [1, 0], [1, 1], [0, 1]]), /kapalı değil/],
    ['4ten az noktalı halka', poligon([[0, 0], [1, 1], [0, 0]]), /4'ten az/],
    ['3ten az farklı noktalı halka', poligon([[0, 0], [1, 1], [0, 0], [0, 0]]), /3'ten az farklı/],
    ['sıfır alanlı halka', poligon([[0, 0], [1, 1], [2, 2], [0, 0]]), /sıfır alanlı/],
    ['papyon (kendini kesen halka)', poligon([[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]), /kendisiyle kesişiyor/],
    ['kendine köşede değen halka (8 şekli)', poligon([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [1, 1], [0, 0]]), /kendisiyle kesişiyor/],
    ['geri dönüş (diken)', poligon([[0, 0], [4, 0], [4, 4], [4, 6], [4, 4], [0, 4], [0, 0]]), /geri dönüş/],
    ['dış sınırın dışındaki delik', poligon(kare(0, 0, 10), kare(20, 20, 2)), /dış sınırın dışında/],
    ['dış sınırı kesen delik', poligon(kare(0, 0, 10), kare(8, 8, 4)), /birbirini kesiyor/],
    ['iç içe delikler', poligon(kare(0, 0, 10), kare(1, 1, 8), kare(3, 3, 2)), /başka bir deliğin içinde/],
    ['örtüşen MultiPolygon parçaları', { type: 'MultiPolygon', coordinates: [[kare(0, 0, 4)], [kare(2, 2, 4)]] }, /MultiPolygon parçaları/],
    ['kenar paylaşan MultiPolygon parçaları', { type: 'MultiPolygon', coordinates: [[kare(0, 0, 2)], [kare(2, 0, 2)]] }, /MultiPolygon parçaları/],
    ['iç içe MultiPolygon parçaları', { type: 'MultiPolygon', coordinates: [[kare(0, 0, 10)], [kare(2, 2, 2)]] }, /içinde/],
  ])('%s', (_ad, g, beklenen) => {
    const sorun = geometriDenetle(g)
    expect(sorun).not.toBeNull()
    expect(sorun.neden).toMatch(beklenen)
  })

  it('papyonda kesişim noktasını doğru verir', () => {
    expect(geometriDenetle(poligon([[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]])).konum).toEqual([1, 1])
  })

  it('GeometryCollection içindeki geçersiz üyeyi bulur', () => {
    const g = { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }, poligon([[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]])] }
    expect(geometriDenetle(g).neden).toMatch(/kendisiyle kesişiyor/)
  })
})

describe('gecerlilikDenetle', () => {
  it('sayaçları ve 1 tabanlı obje sırasını döndürür, null geometriyi boş sayar', () => {
    const sonuc = gecerlilikDenetle(fc(poligon(kare(0, 0, 1)), null, poligon([[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]])))
    expect(sonuc).toMatchObject({ denetlenen: 2, gecerli: 1, gecersiz: 1, bos: 1, kesildi: false })
    expect(sonuc.sorunlar).toEqual([{ obje: 3, tip: 'Polygon', neden: expect.stringMatching(/kesişiyor/), konum: [1, 1] }])
  })

  it('sorun listesini 50 kayıtla sınırlar', () => {
    const papyon = poligon([[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]])
    const sonuc = gecerlilikDenetle(fc(...Array.from({ length: 60 }, () => papyon)))
    expect(sonuc.gecersiz).toBe(60)
    expect(sonuc.sorunlar).toHaveLength(50)
    expect(sonuc.kesildi).toBe(true)
  })

  it('bozuk koordinat dizisinde çökmez', () => {
    const sonuc = gecerlilikDenetle(fc({ type: 'Polygon', coordinates: [[1, 2, 3]] }))
    expect(sonuc.gecersiz).toBe(1)
  })

  it('FeatureCollection olmayan girdide Türkçe hata verir', () => {
    expect(() => gecerlilikDenetle({ type: 'Feature' })).toThrow(/FeatureCollection/)
  })

  it('20.000 köşeli halkayı hızlı denetler; tek kesişimi bulur', () => {
    const n = 20000
    const halka = Array.from({ length: n }, (_, i) => [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)])
    halka.push(halka[0])
    const t0 = Date.now()
    expect(geometriDenetle(poligon(halka))).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2000)

    // İki komşu olmayan köşeyi yer değiştirerek kesişim üret.
    const bozuk = halka.map((k) => k.slice())
    ;[bozuk[100], bozuk[102]] = [bozuk[102], bozuk[100]]
    expect(geometriDenetle(poligon(bozuk)).neden).toMatch(/kendisiyle kesişiyor/)
  })
})
