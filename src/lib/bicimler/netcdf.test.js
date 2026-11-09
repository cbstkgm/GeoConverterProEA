import { describe, it, expect } from 'vitest'
import { netcdfYaz, cfCrsOznitelikleri, NC_FILL_DOUBLE } from './netcdf.js'

const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })

/** Asgari bağımsız NetCDF klasik (CDF-1/CDF-2) okuyucu. */
function ncOku(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let o = 0
  const int = () => { const v = dv.getInt32(o, false); o += 4; return v }
  const pad = () => { o = (o + 3) & ~3 }
  const ad = () => { const n = int(); const s = new TextDecoder().decode(u8.subarray(o, o + n)); o += n; pad(); return s }
  const boy = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 }
  const degerler = (tip, n, bas) => {
    if (tip === 2) return new TextDecoder().decode(u8.subarray(bas, bas + n))
    const r = []
    for (let i = 0; i < n; i++) {
      const p = bas + i * boy[tip]
      r.push(tip === 6 ? dv.getFloat64(p, false) : tip === 4 ? dv.getInt32(p, false) : tip === 1 ? dv.getInt8(p) : NaN)
    }
    return r
  }
  const attlar = () => {
    const etiket = int(); const n = int()
    if (etiket === 0) { expect(n).toBe(0); return {} }
    expect(etiket).toBe(0x0c)
    const a = {}
    for (let i = 0; i < n; i++) {
      const isim = ad(); const tip = int(); const adet = int()
      a[isim] = degerler(tip, adet, o)
      o += adet * boy[tip]; pad()
    }
    return a
  }
  const imza = new TextDecoder().decode(u8.subarray(0, 3))
  const surum = u8[3]
  o = 4
  const numrecs = int()
  const boyutlar = []
  let etiket = int(); let n = int()
  if (etiket) { expect(etiket).toBe(0x0a); for (let i = 0; i < n; i++) boyutlar.push({ ad: ad(), uzunluk: int() }) }
  const gatt = attlar()
  const degiskenler = {}
  etiket = int(); n = int()
  expect(etiket).toBe(0x0b)
  for (let i = 0; i < n; i++) {
    const isim = ad()
    const nd = int()
    const dimidler = Array.from({ length: nd }, () => int())
    const att = attlar()
    const tip = int()
    const vsize = dv.getUint32(o, false); o += 4
    const begin = surum === 1 ? int() : Number((o += 8, dv.getBigInt64(o - 8, false)))
    const sekil = dimidler.map((d) => boyutlar[d].uzunluk)
    const adet = sekil.reduce((a, b) => a * b, 1)
    expect(vsize).toBe((adet * boy[tip] + 3) & ~3)
    let veri
    if (tip === 2 && sekil.length === 2) {
      veri = Array.from({ length: sekil[0] }, (_, k) => new TextDecoder()
        .decode(u8.subarray(begin + k * sekil[1], begin + (k + 1) * sekil[1])).replace(/\0+$/, ''))
    } else veri = degerler(tip, adet, begin)
    degiskenler[isim] = { boyutlar: dimidler.map((d) => boyutlar[d].ad), att, tip, begin, veri }
  }
  const baslikSonu = o
  return { imza, surum, numrecs, boyutlar, gatt, degiskenler, baslikSonu }
}
const boyutBul = (r, ad) => r.boyutlar.find((d) => d.ad === ad)?.uzunluk

describe('netcdfYaz', () => {
  it('tek aile (poligon): CF-1.8 container, delik/çoklu parça, halka yönü, CRS ve Türkçe öznitelikler', async () => {
    const girdi = fc(
      obje({ type: 'Polygon', coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], // CCW dış
        [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]], // CCW delik → CW'ye çevrilmeli
      ] }, { ad: 'Çiğdem Mah.', alan: 96.5, tescil: true, 'ilçe adı': 'Şişli' }),
      obje({ type: 'MultiPolygon', coordinates: [
        [[[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]]], // CW dış → CCW'ye çevrilmeli
        [[[30, 0], [31, 0], [31, 1], [30, 0]]],
      ] }, { ad: 'İkinci', alan: null, tescil: false }),
    )
    const { veri, uyarilar, onizleme } = await netcdfYaz(girdi, { crs: 'EPSG:5255' })
    const r = ncOku(veri)
    expect(r.imza).toBe('CDF')
    expect(r.surum).toBe(1)
    expect(r.numrecs).toBe(0)
    expect(r.gatt.Conventions).toBe('CF-1.8')
    expect(boyutBul(r, 'poligon_instance')).toBe(2)
    expect(boyutBul(r, 'poligon_part')).toBe(4)
    expect(boyutBul(r, 'poligon_node')).toBe(4 + 4 + 4 + 3)

    const v = r.degiskenler
    const kap = v.poligon_geometri.att
    expect(kap).toMatchObject({
      geometry_type: 'polygon', node_count: 'poligon_node_count', node_coordinates: 'poligon_x poligon_y',
      part_node_count: 'poligon_part_node_count', interior_ring: 'poligon_interior_ring', grid_mapping: 'crs',
    })
    expect(v.poligon_node_count.veri).toEqual([8, 7])
    expect(v.poligon_part_node_count.veri).toEqual([4, 4, 4, 3])
    expect(v.poligon_interior_ring.veri).toEqual([0, 1, 0, 0])
    // Halkalar kapalı yazılmaz; dış CCW, iç CW
    expect(v.poligon_x.veri.slice(0, 8)).toEqual([0, 10, 10, 0, 2, 4, 4, 2])
    expect(v.poligon_y.veri.slice(0, 8)).toEqual([0, 0, 10, 10, 4, 4, 2, 2])
    expect(v.poligon_x.veri.slice(8, 12)).toEqual([25, 25, 20, 20])
    expect(v.poligon_x.att).toMatchObject({ standard_name: 'projection_x_coordinate', units: 'm', axis: 'X' })
    expect(v.poligon_z).toBeUndefined()

    // CRS
    expect(v.crs.att).toMatchObject({
      grid_mapping_name: 'transverse_mercator', epsg_code: 'EPSG:5255',
      longitude_of_central_meridian: [33], scale_factor_at_central_meridian: [1], false_easting: [500000],
      semi_major_axis: [6378137], inverse_flattening: [298.257222101],
    })
    expect(v.crs.att.crs_wkt).toContain('TUREF_TM33')

    // Öznitelikler
    expect(v.ad).toMatchObject({ tip: 2, boyutlar: ['poligon_instance', 'ad_strlen'], veri: ['Çiğdem Mah.', 'İkinci'] })
    expect(v.ad.att).toMatchObject({ long_name: 'ad', geometry: 'poligon_geometri', _Encoding: 'utf-8' })
    expect(boyutBul(r, 'ad_strlen')).toBe(new TextEncoder().encode('Çiğdem Mah.').length)
    expect(v.alan).toMatchObject({ tip: 6, veri: [96.5, NC_FILL_DOUBLE] })
    expect(v.alan.att._FillValue).toEqual([NC_FILL_DOUBLE])
    expect(v.tescil).toMatchObject({ tip: 1, veri: [1, 0] })
    expect(v.tescil.att).toMatchObject({ flag_values: [0, 1], flag_meanings: 'false true' })
    expect(v.ilce_adi.veri).toEqual(['Şişli', ''])
    expect(v.ilce_adi.att.long_name).toBe('ilçe adı')

    // Veri bölümü başlıktan sonra, 4 bayt hizalı ve dosya sonuna dek
    const beginler = Object.values(v).map((x) => x.begin).sort((a, b) => a - b)
    expect(beginler[0]).toBe(r.baslikSonu)
    expect(beginler.every((b) => b % 4 === 0)).toBe(true)
    expect(uyarilar.join(' ')).toMatch(/2 poligon halkasının yönü CF kuralına göre çevrildi/)
    expect(onizleme).toContain('poligon_geometri (geometry_type = polygon)')
  })

  it('karışık aileler ayrı container; Z; null geometri en kalabalık aileye 0 düğümle eklenir', async () => {
    const girdi = fc(
      obje({ type: 'Point', coordinates: [30.5, 39.5, 900] }, { ad: 'Nokta 1' }),
      obje({ type: 'MultiPoint', coordinates: [[31, 40, 1], [32, 41]] }, { ad: 'Nokta 2' }),
      obje({ type: 'LineString', coordinates: [[30, 39], [31, 40]] }, { ad: 'Yol' }),
      obje(null, { ad: 'Geometrisiz' }),
    )
    const { veri, uyarilar } = await netcdfYaz(girdi, { crs: 'EPSG:4326' })
    const r = ncOku(veri)
    const v = r.degiskenler
    expect(v.nokta_geometri.att.geometry_type).toBe('point')
    expect(v.cizgi_geometri.att.geometry_type).toBe('line')
    expect(v.cizgi_part_node_count).toBeUndefined() // tek parçalı çizgiler
    expect(v.nokta_geometri.att.node_coordinates).toBe('nokta_x nokta_y nokta_z')
    expect(v.nokta_node_count.veri).toEqual([1, 2, 0])
    expect(v.nokta_z.veri).toEqual([900, 1, 0])
    expect(v.nokta_ad.veri).toEqual(['Nokta 1', 'Nokta 2', 'Geometrisiz'])
    expect(v.cizgi_ad.veri).toEqual(['Yol'])
    expect(v.cizgi_ad.att.geometry).toBe('cizgi_geometri')
    expect(v.nokta_x.att).toMatchObject({ standard_name: 'longitude', units: 'degrees_east' })
    expect(v.crs.att).toMatchObject({ grid_mapping_name: 'latitude_longitude', epsg_code: 'EPSG:4326' })
    expect(r.gatt.featureType).toBe('mixed')
    expect(uyarilar.join(' ')).toMatch(/1 geometrisiz obje "nokta" ailesine 0 düğümlü/)
    expect(uyarilar.join(' ')).toMatch(/1 düğümün Z değeri yok/)
    expect(uyarilar.join(' ')).toMatch(/ayrı CF geometry container/)
  })

  it('çok parçalı çizgi part_node_count yazar; CRS yoksa grid_mapping yok', async () => {
    const { veri, uyarilar } = await netcdfYaz(fc(obje({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] })))
    const v = ncOku(veri).degiskenler
    expect(v.cizgi_part_node_count.veri).toEqual([2, 3])
    expect(v.cizgi_node_count.veri).toEqual([5])
    expect(v.crs).toBeUndefined()
    expect(v.cizgi_geometri.att.grid_mapping).toBeUndefined()
    expect(uyarilar.join(' ')).toMatch(/grid_mapping \(crs\) değişkeni yazılmadı/)
  })

  it('katalogdaki tüm CRS\'ler için CF grid_mapping üretilir (ED50 towgs84 dahil)', () => {
    const ed50 = cfCrsOznitelikleri('EPSG:23036').oznitelikler
    const bul = (ad) => ed50.find((a) => a.ad === ad).deger
    expect(bul('longitude_of_central_meridian')).toEqual([33])
    expect(bul('scale_factor_at_central_meridian')).toEqual([0.9996])
    expect(bul('semi_major_axis')).toEqual([6378388])
    expect(bul('inverse_flattening')).toEqual([297])
    expect(bul('towgs84')).toEqual([-84.1, -101.8, -129.7, 0, 0, 0.468, 1.05])
    expect(cfCrsOznitelikleri('EPSG:3857').oznitelikler[0].deger).toBe('mercator')
    expect(cfCrsOznitelikleri('EPSG:2320')).toBeNull()
  })

  it('boş FC ve yalnız null geometri anlaşılır hata verir', async () => {
    await expect(netcdfYaz(fc())).rejects.toThrow(/hiç obje içermiyor/)
    await expect(netcdfYaz(fc(obje(null, { a: 1 })))).rejects.toThrow(/geometrisi olan obje yok/)
  })
})
