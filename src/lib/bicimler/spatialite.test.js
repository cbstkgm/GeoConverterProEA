import { describe, it, expect, beforeAll } from 'vitest'
import initSqlJs from 'sql.js'
import { spatialiteYaz, spatialiteGeometrisi } from './spatialite.js'

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

const TIPLER = { 1: 'Point', 2: 'LineString', 3: 'Polygon', 4: 'MultiPoint', 5: 'MultiLineString', 6: 'MultiPolygon', 7: 'GeometryCollection' }

/** Spesifikasyona göre bağımsız SpatiaLite BLOB çözücüsü. */
function slCoz(blob) {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  expect(blob[0]).toBe(0x00)
  expect(blob[1]).toBe(0x01)
  const le = true
  const srid = dv.getInt32(2, le)
  const mbr = [0, 1, 2, 3].map((i) => dv.getFloat64(6 + i * 8, le))
  expect(blob[38]).toBe(0x7c)
  expect(blob[blob.length - 1]).toBe(0xfe)
  let o = 39
  const u32 = () => {
    const v = dv.getUint32(o, le)
    o += 4
    return v
  }
  const f64 = () => {
    const v = dv.getFloat64(o, le)
    o += 8
    return v
  }
  const sinif = u32()
  const z = sinif >= 1000
  const konum = () => (z ? [f64(), f64(), f64()] : [f64(), f64()])
  const konumlar = () => Array.from({ length: u32() }, konum)
  function govde(kod) {
    const tip = TIPLER[kod % 1000]
    switch (tip) {
      case 'Point':
        return { type: tip, coordinates: konum() }
      case 'LineString':
        return { type: tip, coordinates: konumlar() }
      case 'Polygon':
        return { type: tip, coordinates: Array.from({ length: u32() }, konumlar) }
      default: {
        const n = u32()
        const parcalar = Array.from({ length: n }, () => {
          expect(blob[o]).toBe(0x69)
          o += 1
          return govde(u32())
        })
        return tip === 'GeometryCollection' ? { type: tip, geometries: parcalar } : { type: tip, coordinates: parcalar.map((p) => p.coordinates) }
      }
    }
  }
  const geometri = govde(sinif)
  expect(o).toBe(blob.length - 1)
  return { srid, mbr, sinif, geometri }
}

describe('spatialiteYaz', () => {
  it('SpatiaLite 4.x meta tablolarını ve BLOB biçimini yazar', async () => {
    const delikli = { type: 'Polygon', coordinates: [kare(500000, 4400000, 100), kare(500010, 4400010, 10)] }
    const { veri, uyarilar, onizleme } = await spatialiteYaz(
      fc(obje(delikli, { ada: 101, parsel: 7, malik: 'Şükrü Çağlar Öğüt İı' }), obje({ type: 'MultiPolygon', coordinates: [[kare(0, 0, 1)]] }, { ada: 5 }), obje(null, { ada: 9 })),
      { crs: 'EPSG:5255' },
    )
    expect(new TextDecoder().decode(veri.subarray(0, 15))).toBe('SQLite format 3')
    expect(onizleme).toContain('SpatiaLite 4.x')
    expect(uyarilar).toEqual(['"objeler" tablosunda tekil ve çoklu geometriler karışık; 1 tekil geometri MultiPolygon tipine yükseltildi.'])
    const db = ac(veri)
    expect(db.exec('PRAGMA integrity_check')[0].values[0][0]).toBe('ok')
    expect(db.exec('PRAGMA foreign_key_check')).toEqual([])
    expect(sorgu(db, 'PRAGMA table_info(geometry_columns)').map((c) => c.name)).toEqual(['f_table_name', 'f_geometry_column', 'geometry_type', 'coord_dimension', 'srid', 'spatial_index_enabled'])
    expect(sorgu(db, 'PRAGMA table_info(spatial_ref_sys)').map((c) => c.name)).toEqual(['srid', 'auth_name', 'auth_srid', 'ref_sys_name', 'proj4text', 'srtext'])
    const srs = sorgu(db, 'SELECT * FROM spatial_ref_sys ORDER BY srid')
    expect(srs.map((s) => s.srid)).toEqual([-1, 0, 4326, 5255])
    expect(srs[3]).toMatchObject({ auth_name: 'epsg', auth_srid: 5255, ref_sys_name: 'TUREF / TM33' })
    expect(srs[3].proj4text).toContain('+proj=tmerc +lat_0=0 +lon_0=33')
    expect(srs[3].srtext).toMatch(/^PROJCS\["TUREF \/ TM33"/)
    expect(srs[2].proj4text).toBe('+proj=longlat +datum=WGS84 +no_defs')
    expect(sorgu(db, 'SELECT * FROM geometry_columns')).toEqual([
      { f_table_name: 'objeler', f_geometry_column: 'geom', geometry_type: 6, coord_dimension: 2, srid: 5255, spatial_index_enabled: 0 },
    ])
    expect(sorgu(db, 'SELECT COUNT(*) AS n FROM spatialite_history')[0].n).toBe(3)

    const satirlar = sorgu(db, 'SELECT * FROM objeler ORDER BY fid')
    expect(satirlar).toHaveLength(3)
    expect(satirlar[0].malik).toBe('Şükrü Çağlar Öğüt İı')
    const a = slCoz(satirlar[0].geom)
    expect(a.srid).toBe(5255)
    expect(a.sinif).toBe(6)
    expect(a.mbr).toEqual([500000, 4400000, 500100, 4400100])
    expect(a.geometri).toEqual({ type: 'MultiPolygon', coordinates: [delikli.coordinates] })
    expect(slCoz(satirlar[1].geom).geometri).toEqual({ type: 'MultiPolygon', coordinates: [[kare(0, 0, 1)]] })
    expect(satirlar[2]).toMatchObject({ geom: null, ada: 9 })
    db.close()
  })

  it('tüm tipleri ve Z’yi (1000+ sınıf kodları, 0x69 öğe işaretçisi) gidiş-dönüş korur', () => {
    const geometriler = [
      { type: 'Point', coordinates: [1.5, -2.25] },
      { type: 'LineString', coordinates: [[0, 0, 1], [1, 1, 2]] },
      { type: 'Polygon', coordinates: [kare(0, 0, 1)] },
      { type: 'MultiPoint', coordinates: [[0, 0], [5, 5]] },
      { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
      { type: 'MultiPolygon', coordinates: [[kare(0, 0, 1, 7)], [kare(5, 5, 1, 8)]] },
      { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [9, 9] }, { type: 'MultiLineString', coordinates: [[[0, 0], [1, 2]]] }] },
    ]
    for (const g of geometriler) {
      const c = slCoz(spatialiteGeometrisi(g, 4326))
      expect(c.srid).toBe(4326)
      expect(c.geometri).toEqual(g)
    }
    const z = slCoz(spatialiteGeometrisi(geometriler[1], 4326))
    expect(z.sinif).toBe(1002)
    // Z'siz geometri XYZ sütununda Z=0 ile yazılır
    expect(slCoz(spatialiteGeometrisi({ type: 'Point', coordinates: [1, 2] }, 4326, true)).geometri.coordinates).toEqual([1, 2, 0])
    expect(spatialiteGeometrisi({ type: 'Polygon', coordinates: [] }, 4326)).toBeNull()
  })

  it('farklı aileleri tablolara böler; Z tablosu XYZ (coord_dimension 3, tip +1000)', async () => {
    const { veri, uyarilar } = await spatialiteYaz(
      fc(obje({ type: 'Point', coordinates: [1, 2, 3] }, { ad: 'nokta' }), obje({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { ad: 'çizgi' })),
      { crs: 'EPSG:23036', tabloAdi: 'Katman' },
    )
    expect(uyarilar.join('\n')).toMatch(/2 tabloya bölündü/)
    const db = ac(veri)
    expect(db.exec('PRAGMA foreign_key_check')).toEqual([])
    expect(sorgu(db, 'SELECT f_table_name, geometry_type, coord_dimension, srid FROM geometry_columns ORDER BY f_table_name')).toEqual([
      { f_table_name: 'katman_cizgi', geometry_type: 2, coord_dimension: 2, srid: 23036 },
      { f_table_name: 'katman_nokta', geometry_type: 1001, coord_dimension: 3, srid: 23036 },
    ])
    expect(slCoz(sorgu(db, 'SELECT geom FROM katman_nokta')[0].geom).geometri).toEqual({ type: 'Point', coordinates: [1, 2, 3] })
    expect(sorgu(db, 'SELECT ad FROM katman_cizgi')[0].ad).toBe('çizgi')
    expect(sorgu(db, 'SELECT proj4text FROM spatial_ref_sys WHERE srid = 23036')[0].proj4text).toContain('+proj=utm +zone=36')
    db.close()
  })

  it('boş FC ve bilinmeyen / eksik CRS', async () => {
    const bos = await spatialiteYaz(fc(), { crs: 'EPSG:5254' })
    const db = ac(bos.veri)
    expect(sorgu(db, 'SELECT geometry_type, srid FROM geometry_columns')).toEqual([{ geometry_type: 0, srid: 5254 }])
    expect(sorgu(db, 'SELECT COUNT(*) AS n FROM objeler')[0].n).toBe(0)
    db.close()

    const bilinmeyen = await spatialiteYaz(fc(obje({ type: 'Point', coordinates: [1, 2] })), { crs: 'EPSG:2320' })
    expect(bilinmeyen.uyarilar.join(' ')).toMatch(/EPSG:2320/)
    expect(sorgu(ac(bilinmeyen.veri), 'SELECT proj4text, srtext FROM spatial_ref_sys WHERE srid = 2320')).toEqual([{ proj4text: '', srtext: 'Undefined' }])

    const eksik = await spatialiteYaz(fc(obje({ type: 'Point', coordinates: [30, 40] })))
    expect(eksik.uyarilar.join(' ')).toMatch(/4326/)
  })

  it('boş geometriyi NULL yazar ve uyarır; geom/fid öznitelik çakışmasını çözer', async () => {
    const { veri, uyarilar } = await spatialiteYaz(fc(obje({ type: 'LineString', coordinates: [] }, { geom: 'x', fid: 3 })), { crs: 'EPSG:4326' })
    expect(uyarilar.some((u) => u.includes('NULL'))).toBe(true)
    const db = ac(veri)
    expect(sorgu(db, 'SELECT * FROM objeler')).toEqual([{ fid: 1, geom: null, geom_1: 'x', fid_1: 3 }])
    db.close()
  })
})
