// FileGDB sıkıştırılmış geometri kodlayıcısı (GDAL filegdbtable_write.cpp EncodeGeometry ile birebir).
//   Nokta:        tip | varuint((x-xo)*s+1) | varuint((y-yo)*s+1) [| varuint((z-zo)*zs+1)]
//   Çoklu nokta:  tip | n | zarf | XY farkları (varint) [| Z farkları]
//   Çizgi/poligon: tip | nokta sayısı | parça sayısı | zarf | parça boyları (sonuncusu hariç)
//                  | XY farkları (varint, ızgaraya yuvarlanmış) [| Z farkları]
//   zarf: varuint((minx-xo)*s), varuint((miny-yo)*s), varuint((maxx-minx)*s), varuint((maxy-miny)*s)
// Şekil tipleri (ESRI genişletilmiş): POINT 1 / Z 9, MULTIPOINT 8 / Z 20, ARC 3 / Z 10, POLYGON 5 / Z 19.
// Poligon halkaları ESRI kuralıyla yazılır: dış halka saat yönünde, delikler saat yönünün tersinde.

import { FgdbYazici } from './tablo.js'

const SEKIL = { nokta: [1, 9], cokluNokta: [8, 20], cizgi: [3, 10], poligon: [5, 19] }

/** C/C++ std::round (yarım değerlerde sıfırdan uzağa). */
const yuvarla = (v) => (v < 0 ? -Math.round(-v) : Math.round(v))
const tamKisim = (v) => Math.floor(v + 0.5)

/** İşaretli alan (y-yukarı eksende saat yönünün tersi pozitif). */
export function halkaAlani(h) {
  let a = 0
  const [ox, oy] = h[0]
  for (let i = 0; i + 1 < h.length; i++) a += (h[i][0] - ox) * (h[i + 1][1] - oy) - (h[i + 1][0] - ox) * (h[i][1] - oy)
  return a / 2
}
export const cizgiUzunlugu = (c) => c.slice(1).reduce((t, k, i) => t + Math.hypot(k[0] - c[i][0], k[1] - c[i][1]), 0)

function kapsam(noktalar, z) {
  const k = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity, minz: NaN, maxz: NaN }
  for (const p of noktalar) {
    k.minx = Math.min(k.minx, p[0])
    k.miny = Math.min(k.miny, p[1])
    k.maxx = Math.max(k.maxx, p[0])
    k.maxy = Math.max(k.maxy, p[1])
    if (z) {
      const pz = p[2] ?? 0
      k.minz = Number.isNaN(k.minz) ? pz : Math.min(k.minz, pz)
      k.maxz = Number.isNaN(k.maxz) ? pz : Math.max(k.maxz, pz)
    }
  }
  return k
}

function zarfYaz(w, k, g) {
  w.varuint(tamKisim((k.minx - g.xOrigin) * g.xyScale))
  w.varuint(tamKisim((k.miny - g.yOrigin) * g.xyScale))
  w.varuint(tamKisim((k.maxx - k.minx) * g.xyScale))
  w.varuint(tamKisim((k.maxy - k.miny) * g.xyScale))
}

function farklarYaz(w, noktalar, g, z) {
  let sx = 0
  let sy = 0
  for (const p of noktalar) {
    const x = yuvarla((p[0] - g.xOrigin) * g.xyScale)
    const y = yuvarla((p[1] - g.yOrigin) * g.xyScale)
    w.varint(x - sx)
    w.varint(y - sy)
    sx = x
    sy = y
  }
  if (z) {
    let sz = 0
    for (const p of noktalar) {
      const v = yuvarla(((p[2] ?? 0) - g.zOrigin) * g.zScale)
      w.varint(v - sz)
      sz = v
    }
  }
}

/**
 * GeoJSON geometrisini FileGDB geometri blob'una çevirir.
 * @param {object} geo Point | MultiPoint | LineString | MultiLineString | Polygon | MultiPolygon
 * @param {object} g geometri alanı ayarları (xOrigin, yOrigin, xyScale, zOrigin, zScale)
 * @param {boolean} z tablo Z'li mi (Z'siz koordinatlara 0 yazılır)
 * @returns {{ blob: Uint8Array, kapsam: object, alan: number, uzunluk: number, noktaSayisi: number } | null} boşsa null
 */
export function fgdbGeometrisi(geo, g, z) {
  const w = new FgdbYazici(64)
  const c = geo.coordinates
  const tip = (ad) => w.u8(SEKIL[ad][z ? 1 : 0])
  switch (geo.type) {
    case 'Point': {
      if (!Array.isArray(c) || c.length < 2) return null
      tip('nokta')
      w.varuint(tamKisim((c[0] - g.xOrigin) * g.xyScale + 1))
      w.varuint(tamKisim((c[1] - g.yOrigin) * g.xyScale + 1))
      if (z) w.varuint(tamKisim(((c[2] ?? 0) - g.zOrigin) * g.zScale + 1))
      return { blob: w.sonuc(), kapsam: kapsam([c], z), alan: 0, uzunluk: 0, noktaSayisi: 1 }
    }
    case 'MultiPoint': {
      if (!c.length) return null
      tip('cokluNokta')
      w.varuint(c.length)
      const k = kapsam(c, z)
      zarfYaz(w, k, g)
      farklarYaz(w, c, g, z)
      return { blob: w.sonuc(), kapsam: k, alan: 0, uzunluk: 0, noktaSayisi: c.length }
    }
    case 'LineString':
    case 'MultiLineString': {
      const parcalar = (geo.type === 'LineString' ? [c] : c).filter((p) => p.length)
      const noktalar = parcalar.flat()
      if (!noktalar.length) return null
      tip('cizgi')
      return sonlandir(w, parcalar, noktalar, g, z, 0, parcalar.reduce((t, p) => t + cizgiUzunlugu(p), 0))
    }
    case 'Polygon':
    case 'MultiPolygon': {
      const poligonlar = (geo.type === 'Polygon' ? [c] : c).filter((p) => p.length && p[0].length)
      const halkalar = []
      let alan = 0
      let uzunluk = 0
      for (const pl of poligonlar) {
        pl.forEach((h, i) => {
          if (!h.length) return
          const a = halkaAlani(h)
          // dış halka saat yönünde (alan < 0), delik saat yönünün tersinde (alan > 0)
          halkalar.push((i === 0 ? a > 0 : a < 0) ? [...h].reverse() : h)
          alan += i === 0 ? Math.abs(a) : -Math.abs(a)
          uzunluk += cizgiUzunlugu(h)
        })
      }
      const noktalar = halkalar.flat()
      if (!noktalar.length) return null
      tip('poligon')
      return sonlandir(w, halkalar, noktalar, g, z, alan, uzunluk)
    }
    default:
      throw new Error(`FileGDB'ye yazılamayan geometri tipi: ${geo.type}`)
  }
}

function sonlandir(w, parcalar, noktalar, g, z, alan, uzunluk) {
  w.varuint(noktalar.length)
  w.varuint(parcalar.length)
  const k = kapsam(noktalar, z)
  zarfYaz(w, k, g)
  for (let i = 0; i < parcalar.length - 1; i++) w.varuint(parcalar[i].length)
  farklarYaz(w, noktalar, g, z)
  return { blob: w.sonuc(), kapsam: k, alan, uzunluk, noktaSayisi: noktalar.length }
}
