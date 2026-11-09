import { describe, it, expect } from 'vitest'
import { ptxYaz } from './ptx.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })

/** Asgari PTX okuyucu: tarama başlığı + sütun×satır nokta. */
function ptxOku(metin) {
  const s = metin.trimEnd().split('\n')
  const sutun = Number(s[0])
  const satir = Number(s[1])
  const sayilar = (i) => s[i].split(' ').map(Number)
  return {
    sutun, satir,
    tarayici: sayilar(2),
    eksenler: [sayilar(3), sayilar(4), sayilar(5)],
    matris: [sayilar(6), sayilar(7), sayilar(8), sayilar(9)],
    noktalar: s.slice(10).map((x) => x.split(' ').map(Number)),
    satirSayisi: s.length,
  }
}

describe('ptxYaz', () => {
  it('1 sütun × N satır ızgara, birim eksen/matris, "x y z i" noktalar; yaklaşım uyarısı', async () => {
    const { veri, uyarilar, onizleme } = await ptxYaz(fc(
      obje({ type: 'Polygon', coordinates: [[[500000, 4400000, 10], [500010, 4400000, 11], [500010, 4400010, 12], [500000, 4400000, 10]]] }, { ad: 'Çatı' }),
      obje(null),
    ), { crs: 'EPSG:5255' })
    const p = ptxOku(veri)
    expect([p.sutun, p.satir]).toEqual([1, 3])
    expect(p.tarayici).toEqual([0, 0, 0])
    expect(p.eksenler).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    expect(p.matris).toEqual([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    expect(p.noktalar).toEqual([[500000, 4400000, 10, 0.5], [500010, 4400000, 11, 0.5], [500010, 4400010, 12, 0.5]])
    expect(p.satirSayisi).toBe(10 + p.sutun * p.satir)
    expect(uyarilar[0]).toMatch(/PTX yaklaşımı/)
    expect(uyarilar.join(' ')).toMatch(/1 obje boş \(null\)/)
    expect(uyarilar.join(' ')).toMatch(/koordinat sistemi bilgisi taşımaz/)
    expect(onizleme.split('\n').slice(0, 2)).toEqual(['1', '3'])
  })

  it('Z yoksa 0 yazılır; (0,0,0) noktası uyarılır; yoğunluk seçeneği', async () => {
    const { veri, uyarilar } = await ptxYaz(fc(obje({ type: 'MultiPoint', coordinates: [[0, 0], [1, 2]] })), { yogunluk: 0.25 })
    expect(ptxOku(veri).noktalar).toEqual([[0, 0, 0, 0.25], [1, 2, 0, 0.25]])
    expect(uyarilar.join(' ')).toMatch(/Veride Z \(yükseklik\) yok/)
    expect(uyarilar.join(' ')).toMatch(/1 nokta \(0, 0, 0\)/)
  })

  it('boş FC / yalnız null geometri anlaşılır hata verir (0 satırlı tarama okunamaz)', async () => {
    await expect(ptxYaz(fc())).rejects.toThrow(/yazılacak nokta yok/)
    await expect(ptxYaz(fc(obje(null)))).rejects.toThrow(/yazılacak nokta yok/)
  })
})
