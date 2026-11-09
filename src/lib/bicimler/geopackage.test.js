import { describe, it, expect, beforeAll } from 'vitest'
import initSqlJs from 'sql.js'
import { geopackageYaz, geopackageGeometrisi } from './geopackage.js'
import { wktCoz } from '../wkt.js'

const kare = (x, y, b, z) => [[x, y], [x + b, y], [x + b, y + b], [x, y + b], [x, y]].map((k) => (z === undefined ? k : [...k, z]))
const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry })
const fc = (...features) => ({ type: 'FeatureCollection', features })

let SQL
beforeAll(async () => {
  SQL = await initSqlJs()
})

const ac = (veri) => new SQL.Database(veri)
const sorgu = (db, sql) => {
  const r = db.exec(sql)[0]
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []
}

/** GeoPackageBinary başlığını çözer; WKB'yi projedeki wkt.js çözücüsüyle GeoJSON'a çevirir. */
function gpkgCoz(blob) {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  expect(String.fromCharCode(blob[0], blob[1])).toBe('GP')
  expect(blob[2]).toBe(0)
  const bayrak = blob[3]
  const le = (bayrak & 1) === 1
  const zarfTipi = (bayrak >> 1) & 7
  const bos = ((bayrak >> 4) & 1) === 1
  const srsId = dv.getInt32(4, le)
  const n = [0, 4, 6, 6, 8][zarfTipi]
  const zarf = Array.from({ length: n }, (_, i) => dv.getFloat64(8 + i * 8, le))
  const wkb = blob.subarray(8 + n * 8)
  const hex = Array.from(wkb, (b) => b.toString(16).padStart(2, '0')).join('')
  return { le, zarfTipi, bos, srsId, zarf, wkb, geometri: wktCoz(hex) }
}

describe('geopackageYaz', () => {
  it('GeoPackage 1.3 başlığını ve zorunlu tabloları yazar', async () => {
    const { veri, uyarilar, onizleme } = await geopackageYaz(
      fc(obje({ type: 'Point', coordinates: [500100.5, 4400200.25] }, { ad: 'Çağlayan Şükrü İğdır', no: 7 })),
      { crs: 'EPSG:5255' },
    )
    expect(veri).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(veri.subarray(0, 15))).toBe('SQLite format 3')
    expect(uyarilar).toEqual([])
    expect(onizleme).toContain('EPSG:5255')
    const db = ac(veri)
    expect(db.exec('PRAGMA application_id')[0].values[0][0]).toBe(0x47504b47)
    expect(db.exec('PRAGMA user_version')[0].values[0][0]).toBe(10300)
    expect(db.exec('PRAGMA integrity_check')[0].values[0][0]).toBe('ok')
    expect(db.exec('PRAGMA foreign_key_check')).toEqual([])

    const srs = sorgu(db, 'SELECT * FROM gpkg_spatial_ref_sys ORDER BY srs_id')
    expect(srs.map((s) => s.srs_id)).toEqual([-1, 0, 4326, 5255])
    expect(srs[0].definition).toBe('undefined')
    expect(srs[2].organization).toBe('EPSG')
    expect(srs[2].definition).toMatch(/^GEOGCS\["WGS 84"/)
    expect(srs[3].definition).toMatch(/^PROJCS\["TUREF \/ TM33"/)
    expect(srs[3].definition).toContain('PARAMETER["central_meridian",33]')
    expect(srs[3].definition).toContain('AUTHORITY["EPSG","5255"]')

    const [icerik] = sorgu(db, 'SELECT * FROM gpkg_contents')
    expect(icerik).toMatchObject({ table_name: 'objeler', data_type: 'features', srs_id: 5255, min_x: 500100.5, max_x: 500100.5, min_y: 4400200.25, max_y: 4400200.25 })
    expect(icerik.last_change).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(sorgu(db, 'SELECT * FROM gpkg_geometry_columns')).toEqual([
      { table_name: 'objeler', column_name: 'geom', geometry_type_name: 'POINT', srs_id: 5255, z: 0, m: 0 },
    ])
    const [satir] = sorgu(db, 'SELECT * FROM objeler')
    expect(satir.fid).toBe(1)
    expect(satir.ad).toBe('Çağlayan Şükrü İğdır')
    expect(satir.no).toBe(7)
    const g = gpkgCoz(satir.geom)
    expect(g).toMatchObject({ le: true, zarfTipi: 1, bos: false, srsId: 5255 })
    expect(g.zarf).toEqual([500100.5, 500100.5, 4400200.25, 4400200.25])
    expect(g.geometri).toEqual({ type: 'Point', coordinates: [500100.5, 4400200.25] })
    db.close()
  })

  it('öznitelik tiplerini çıkarır; nesne/dizi JSON metin olur', async () => {
    const { veri } = await geopackageYaz(
      fc(
        obje({ type: 'Point', coordinates: [1, 2] }, { tam: 1, ondalik: 1, mantik: true, metin: 'ğüşöç', karisik: 1, nesne: { a: [1, 'ı'] }, bos: null }),
        obje({ type: 'Point', coordinates: [3, 4] }, { tam: 2, ondalik: 2.5, mantik: false, metin: 'İ', karisik: 'x', nesne: [1, 2] }),
      ),
      { crs: 'EPSG:4326' },
    )
    const db = ac(veri)
    const tipler = Object.fromEntries(sorgu(db, 'PRAGMA table_info(objeler)').map((c) => [c.name, c.type]))
    expect(tipler).toEqual({ fid: 'INTEGER', geom: 'POINT', tam: 'INTEGER', ondalik: 'REAL', mantik: 'BOOLEAN', metin: 'TEXT', karisik: 'TEXT', nesne: 'TEXT', bos: 'TEXT' })
    const satirlar = sorgu(db, 'SELECT tam, ondalik, mantik, metin, karisik, nesne, bos FROM objeler ORDER BY fid')
    expect(satirlar).toEqual([
      { tam: 1, ondalik: 1, mantik: 1, metin: 'ğüşöç', karisik: '1', nesne: '{"a":[1,"ı"]}', bos: null },
      { tam: 2, ondalik: 2.5, mantik: 0, metin: 'İ', karisik: 'x', nesne: '[1,2]', bos: null },
    ])
    expect(sorgu(db, 'SELECT srs_id FROM gpkg_spatial_ref_sys ORDER BY srs_id').map((s) => s.srs_id)).toEqual([-1, 0, 4326])
    db.close()
  })

  it("'geom' / 'fid' adlı öznitelik ve büyük/küçük harf çakışmalarını çözer ve uyarır", async () => {
    const { veri, uyarilar } = await geopackageYaz(
      fc(obje({ type: 'Point', coordinates: [1, 2] }, { geom: 'öznitelik geometri', fid: 99, FID: 'x', Ad: 'a', ad: 'b', geom_1: 'ç' })),
      { crs: 'EPSG:4326' },
    )
    const db = ac(veri)
    const adlar = sorgu(db, 'PRAGMA table_info(objeler)').map((c) => c.name)
    expect(adlar).toEqual(['fid', 'geom', 'geom_1', 'fid_1', 'FID_2', 'Ad', 'ad_1', 'geom_1_1'])
    const [s] = sorgu(db, 'SELECT * FROM objeler')
    expect(s.fid).toBe(1)
    expect(gpkgCoz(s.geom).geometri).toEqual({ type: 'Point', coordinates: [1, 2] })
    expect(s).toMatchObject({ geom_1: 'öznitelik geometri', fid_1: 99, FID_2: 'x', Ad: 'a', ad_1: 'b', geom_1_1: 'ç' })
    expect(uyarilar.some((u) => u.includes('"geom"') && u.includes('rezerve'))).toBe(true)
    expect(uyarilar.some((u) => u.includes('"fid"') && u.includes('rezerve'))).toBe(true)
    expect(uyarilar).toHaveLength(5)
    db.close()
  })

  it("Z'li delikli poligonu ve çoklu poligonu yazar (ISO WKB 1000+ kodları, xyz zarfı)", async () => {
    const delikli = { type: 'Polygon', coordinates: [kare(0, 0, 10, 5), kare(2, 2, 2, 7)] }
    const coklu = { type: 'MultiPolygon', coordinates: [[kare(20, 20, 5, 1)], [kare(40, 40, 5, 3), kare(41, 41, 1, 3)]] }
    const { veri } = await geopackageYaz(fc(obje(delikli), obje(coklu)), { crs: 'EPSG:23036' })
    const db = ac(veri)
    // Polygon + MultiPolygon → MULTIPOLYGON tablosu, tekil poligon yükseltilir
    expect(sorgu(db, 'SELECT table_name, geometry_type_name, z FROM gpkg_geometry_columns')).toEqual([{ table_name: 'objeler', geometry_type_name: 'MULTIPOLYGON', z: 1 }])
    expect(sorgu(db, 'SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id = 23036')[0].definition).toMatch(/^PROJCS\["ED50 \/ UTM zone 36N".*"central_meridian",33.*"scale_factor",0.9996/)
    expect(sorgu(db, 'SELECT min_x, min_y, max_x, max_y FROM gpkg_contents')).toEqual([{ min_x: 0, min_y: 0, max_x: 45, max_y: 45 }])
    const [a, b] = sorgu(db, 'SELECT geom FROM objeler ORDER BY fid').map((s) => gpkgCoz(s.geom))
    expect(a.zarfTipi).toBe(2)
    expect(a.zarf).toEqual([0, 10, 0, 10, 5, 7])
    expect(new DataView(a.wkb.buffer, a.wkb.byteOffset).getUint32(1, true)).toBe(1006)
    expect(a.geometri).toEqual({ type: 'MultiPolygon', coordinates: [delikli.coordinates] })
    // tekil geometrinin kendisi (tablo dışı) 1003 koduyla yazılır
    const tekil = gpkgCoz(geopackageGeometrisi(delikli, 23036).blob)
    expect(new DataView(tekil.wkb.buffer, tekil.wkb.byteOffset).getUint32(1, true)).toBe(1003)
    expect(tekil.geometri).toEqual(delikli)
    expect(new DataView(b.wkb.buffer, b.wkb.byteOffset).getUint32(1, true)).toBe(1006)
    expect(b.geometri).toEqual(coklu)
    expect(b.zarf).toEqual([20, 45, 20, 45, 1, 3])
    db.close()
  })

  it('tüm geometri tiplerini (GeometryCollection dahil) GeoPackageBinary gidiş-dönüşünde korur', () => {
    const geometriler = [
      { type: 'Point', coordinates: [1.5, -2.25] },
      { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] },
      { type: 'Polygon', coordinates: [kare(0, 0, 1)] },
      { type: 'MultiPoint', coordinates: [[0, 0], [5, 5]] },
      { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
      { type: 'MultiPolygon', coordinates: [[kare(0, 0, 1)], [kare(5, 5, 1)]] },
      { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [9, 9, 1] }, { type: 'LineString', coordinates: [[0, 0, 2], [1, 2, 3]] }] },
    ]
    for (const g of geometriler) {
      const c = gpkgCoz(geopackageGeometrisi(g, 3857).blob)
      expect(c.srsId).toBe(3857)
      expect(c.geometri).toEqual(g)
    }
  })

  it('farklı aileleri aile başına tablolara böler; her tablonun gpkg_* kaydı ve bbox’ı ayrı', async () => {
    const { veri, uyarilar, onizleme } = await geopackageYaz(
      fc(
        obje({ type: 'Point', coordinates: [1, 2] }, { ad: 'nokta1' }),
        obje({ type: 'MultiPoint', coordinates: [[3, 4], [5, 6]] }, { ad: 'nokta2' }),
        obje({ type: 'LineString', coordinates: [[10, 10], [20, 25]] }, { uzunluk: 18.5 }),
        obje({ type: 'Polygon', coordinates: [kare(100, 200, 10)] }, { ada: 101, parsel: 7 }),
        obje(null, { ad: 'geometrisiz' }),
        // tek aileli GC → MultiLineString (çizgi tablosuna)
        obje({ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { type: 'MultiLineString', coordinates: [[[2, 2], [3, 3]]] }] }),
        // karışık GC → _karisik
        obje({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [7, 7] }, { type: 'Polygon', coordinates: [kare(0, 0, 1)] }] }, { tur: 'karma' }),
      ),
      { crs: 'EPSG:5256' },
    )
    const db = ac(veri)
    expect(db.exec('PRAGMA foreign_key_check')).toEqual([])
    expect(db.exec('PRAGMA integrity_check')[0].values[0][0]).toBe('ok')
    expect(sorgu(db, 'SELECT table_name, data_type, identifier, srs_id, min_x, min_y, max_x, max_y FROM gpkg_contents ORDER BY table_name')).toEqual([
      { table_name: 'objeler_cizgi', data_type: 'features', identifier: 'objeler_cizgi', srs_id: 5256, min_x: 0, min_y: 0, max_x: 20, max_y: 25 },
      { table_name: 'objeler_karisik', data_type: 'features', identifier: 'objeler_karisik', srs_id: 5256, min_x: 0, min_y: 0, max_x: 7, max_y: 7 },
      { table_name: 'objeler_nokta', data_type: 'features', identifier: 'objeler_nokta', srs_id: 5256, min_x: 1, min_y: 2, max_x: 5, max_y: 6 },
      { table_name: 'objeler_poligon', data_type: 'features', identifier: 'objeler_poligon', srs_id: 5256, min_x: 100, min_y: 200, max_x: 110, max_y: 210 },
    ])
    expect(sorgu(db, 'SELECT table_name, column_name, geometry_type_name, srs_id, z, m FROM gpkg_geometry_columns ORDER BY table_name')).toEqual([
      { table_name: 'objeler_cizgi', column_name: 'geom', geometry_type_name: 'MULTILINESTRING', srs_id: 5256, z: 0, m: 0 },
      { table_name: 'objeler_karisik', column_name: 'geom', geometry_type_name: 'GEOMETRY', srs_id: 5256, z: 0, m: 0 },
      { table_name: 'objeler_nokta', column_name: 'geom', geometry_type_name: 'MULTIPOINT', srs_id: 5256, z: 0, m: 0 },
      { table_name: 'objeler_poligon', column_name: 'geom', geometry_type_name: 'POLYGON', srs_id: 5256, z: 0, m: 0 },
    ])
    expect(sorgu(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'objeler'")).toEqual([])

    // nokta: Point yükseltildi; geometrisiz obje ilk tabloya NULL geom ile
    const nokta = sorgu(db, 'SELECT fid, geom, ad FROM objeler_nokta ORDER BY fid')
    expect(nokta.map((s) => s.ad)).toEqual(['nokta1', 'nokta2', 'geometrisiz'])
    expect(gpkgCoz(nokta[0].geom).geometri).toEqual({ type: 'MultiPoint', coordinates: [[1, 2]] })
    expect(gpkgCoz(nokta[1].geom).geometri).toEqual({ type: 'MultiPoint', coordinates: [[3, 4], [5, 6]] })
    expect(nokta[2].geom).toBeNull()
    // her tablo yalnızca kendi objelerinin özniteliklerini taşır
    expect(sorgu(db, 'PRAGMA table_info(objeler_nokta)').map((c) => c.name)).toEqual(['fid', 'geom', 'ad'])
    expect(sorgu(db, 'PRAGMA table_info(objeler_poligon)').map((c) => c.name)).toEqual(['fid', 'geom', 'ada', 'parsel'])

    const cizgi = sorgu(db, 'SELECT fid, geom, uzunluk FROM objeler_cizgi ORDER BY fid')
    expect(cizgi.map((s) => s.fid)).toEqual([1, 2])
    expect(gpkgCoz(cizgi[0].geom).geometri).toEqual({ type: 'MultiLineString', coordinates: [[[10, 10], [20, 25]]] })
    expect(gpkgCoz(cizgi[1].geom).geometri).toEqual({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] })

    const [poligon] = sorgu(db, 'SELECT geom, ada, parsel FROM objeler_poligon')
    expect(gpkgCoz(poligon.geom).geometri).toEqual({ type: 'Polygon', coordinates: [kare(100, 200, 10)] })
    expect(poligon).toMatchObject({ ada: 101, parsel: 7 })

    const [karisik] = sorgu(db, 'SELECT geom, tur FROM objeler_karisik')
    expect(gpkgCoz(karisik.geom).geometri.type).toBe('GeometryCollection')
    expect(karisik.tur).toBe('karma')

    const metin = uyarilar.join('\n')
    expect(metin).toMatch(/4 tabloya bölündü/)
    expect(metin).toMatch(/Geometrisi olmayan 1 obje "objeler_nokta"/)
    expect(metin).toMatch(/1 GeometryCollection tek aileden/)
    expect(metin).toMatch(/objeler_karisik/)
    expect(metin).toMatch(/"objeler_nokta" tablosunda .*1 tekil geometri MultiPoint/)
    expect(metin).toMatch(/"objeler_cizgi" tablosunda .*1 tekil geometri MultiLineString/)
    expect(onizleme).toContain('tablo sayısı: 4')
    expect(onizleme).toContain('Tablo: objeler_poligon')
    db.close()
  })

  it('tek ailede tablo adı son eksiz kalır; tekil+çoklu karışımı MULTI olarak beyan edilip uyarılır', async () => {
    const { veri, uyarilar } = await geopackageYaz(
      fc(obje({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }), obje({ type: 'MultiLineString', coordinates: [[[2, 2], [3, 3]]] }), obje(null)),
      { crs: 'EPSG:4326', tabloAdi: 'yollar' },
    )
    const db = ac(veri)
    expect(sorgu(db, 'SELECT table_name, geometry_type_name FROM gpkg_geometry_columns')).toEqual([{ table_name: 'yollar', geometry_type_name: 'MULTILINESTRING' }])
    const satirlar = sorgu(db, 'SELECT geom FROM yollar ORDER BY fid')
    expect(satirlar).toHaveLength(3)
    expect(gpkgCoz(satirlar[0].geom).geometri).toEqual({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] })
    expect(satirlar[2].geom).toBeNull()
    expect(uyarilar).toEqual(['"yollar" tablosunda tekil ve çoklu geometriler karışık; 1 tekil geometri MultiLineString tipine yükseltildi.'])
  })

  it('yalnız null geometrili objelerde de öznitelikler yazılır (GEOMETRY tablo)', async () => {
    const { veri, uyarilar } = await geopackageYaz(fc(obje(null, { ad: 'geometrisiz' }), obje(null, { ad: 'ikinci' })), { crs: 'EPSG:3857' })
    expect(uyarilar).toEqual([])
    const db = ac(veri)
    expect(sorgu(db, 'SELECT geom, ad FROM objeler ORDER BY fid')).toEqual([{ geom: null, ad: 'geometrisiz' }, { geom: null, ad: 'ikinci' }])
    expect(sorgu(db, 'SELECT geometry_type_name FROM gpkg_geometry_columns')[0].geometry_type_name).toBe('GEOMETRY')
    expect(sorgu(db, 'SELECT min_x FROM gpkg_contents')[0].min_x).toBeNull()
    expect(sorgu(db, 'SELECT srs_name FROM gpkg_spatial_ref_sys WHERE srs_id = 3857')[0].srs_name).toBe('WGS 84 / Pseudo-Mercator')
    db.close()
  })

  it('ISO 8601 tarihleri DATE / DATETIME olarak beyan eder; karışıkta TEXT kalır', async () => {
    const { veri } = await geopackageYaz(
      fc(
        obje({ type: 'Point', coordinates: [1, 2] }, { tarih: '2024-02-29', zaman: '2024-02-29T13:45:00Z', zaman2: '2024-02-29T13:45:00.123', karma: '2024-02-29', bicimsiz: '29.02.2024' }),
        obje({ type: 'Point', coordinates: [1, 2] }, { tarih: '2025-12-31', zaman: '2025-01-01T00:00:00.000Z', zaman2: null, karma: '2025-01-01T00:00:00Z', bicimsiz: '2024-13-01' }),
      ),
      { crs: 'EPSG:4326' },
    )
    const db = ac(veri)
    const tipler = Object.fromEntries(sorgu(db, 'PRAGMA table_info(objeler)').map((c) => [c.name, c.type]))
    expect(tipler).toMatchObject({ tarih: 'DATE', zaman: 'DATETIME', zaman2: 'DATETIME', karma: 'TEXT', bicimsiz: 'TEXT' })
    const [s] = sorgu(db, 'SELECT tarih, zaman, typeof(tarih) AS t FROM objeler WHERE fid = 1')
    expect(s).toEqual({ tarih: '2024-02-29', zaman: '2024-02-29T13:45:00Z', t: 'text' })
    db.close()
  })

  it('güvenli olmayan tam sayılarda hassasiyet kaybını uyarır', async () => {
    const { veri, uyarilar } = await geopackageYaz(
      fc(obje({ type: 'Point', coordinates: [1, 2] }, { buyuk: 2 ** 60, normal: 5, kocaman: 2n ** 70n })),
      { crs: 'EPSG:4326' },
    )
    expect(uyarilar.filter((u) => u.includes('hassasiyet'))).toHaveLength(2)
    expect(uyarilar.some((u) => u.includes('"buyuk"') && u.includes('2^53'))).toBe(true)
    expect(uyarilar.some((u) => u.includes('"kocaman"'))).toBe(true)
    expect(uyarilar.some((u) => u.includes('"normal"'))).toBe(false)
    const db = ac(veri)
    const tipler = Object.fromEntries(sorgu(db, 'PRAGMA table_info(objeler)').map((c) => [c.name, c.type]))
    expect(tipler).toMatchObject({ buyuk: 'REAL', normal: 'INTEGER', kocaman: 'REAL' })
    expect(sorgu(db, 'SELECT buyuk FROM objeler')[0].buyuk).toBe(2 ** 60)
    db.close()
  })

  it('boş geometride boş bayrağını ayarlar ve zarf yazmaz', () => {
    const { blob } = geopackageGeometrisi({ type: 'Polygon', coordinates: [] }, 4326)
    const g = gpkgCoz(blob)
    expect(g).toMatchObject({ bos: true, zarfTipi: 0, srsId: 4326, geometri: null })
    const nokta = gpkgCoz(geopackageGeometrisi({ type: 'Point', coordinates: [] }, 4326).blob)
    expect(nokta.bos).toBe(true)
    expect(nokta.geometri).toBeNull() // NaN koordinatlı boş nokta
  })

  it('boş FeatureCollection için geçerli, boş tablolu GeoPackage üretir', async () => {
    const { veri, uyarilar } = await geopackageYaz(fc(), { crs: 'EPSG:5254' })
    expect(uyarilar).toEqual([])
    const db = ac(veri)
    expect(db.exec('PRAGMA application_id')[0].values[0][0]).toBe(0x47504b47)
    expect(sorgu(db, 'SELECT COUNT(*) AS n FROM objeler')[0].n).toBe(0)
    expect(sorgu(db, 'SELECT min_x, srs_id FROM gpkg_contents')).toEqual([{ min_x: null, srs_id: 5254 }])
    expect(sorgu(db, 'SELECT geometry_type_name FROM gpkg_geometry_columns')[0].geometry_type_name).toBe('GEOMETRY')
    db.close()
  })

  it('CRS verilmezse 4326 varsayar ve uyarır; bilinmeyen EPSG için tanımı undefined yazar', async () => {
    const a = await geopackageYaz(fc(obje({ type: 'Point', coordinates: [30, 40] })))
    expect(a.uyarilar.join(' ')).toMatch(/4326/)
    expect(sorgu(ac(a.veri), 'SELECT srs_id FROM gpkg_contents')[0].srs_id).toBe(4326)
    const b = await geopackageYaz(fc(obje({ type: 'Point', coordinates: [30, 40] })), { crs: 'EPSG:2320' })
    expect(b.uyarilar.join(' ')).toMatch(/EPSG:2320/)
    expect(sorgu(ac(b.veri), 'SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id = 2320')[0].definition).toBe('undefined')
  })

  it('karışık Z ve geçersiz koordinatlarda uyarır', async () => {
    const { veri, uyarilar } = await geopackageYaz(
      fc(obje({ type: 'Point', coordinates: [1, 2, 3] }), obje({ type: 'Point', coordinates: [1, 2] }), obje({ type: 'Point', coordinates: ['a', 2] })),
      { crs: 'EPSG:4326' },
    )
    expect(uyarilar.some((u) => u.includes('3. objenin'))).toBe(true)
    expect(uyarilar.some((u) => u.includes('z=2'))).toBe(true)
    const db = ac(veri)
    expect(sorgu(db, 'SELECT z, geometry_type_name FROM gpkg_geometry_columns')).toEqual([{ z: 2, geometry_type_name: 'POINT' }])
    expect(sorgu(db, 'SELECT geom FROM objeler WHERE fid = 3')[0].geom).toBeNull()
    expect(gpkgCoz(sorgu(db, 'SELECT geom FROM objeler WHERE fid = 1')[0].geom).geometri.coordinates).toEqual([1, 2, 3])
  })
})
