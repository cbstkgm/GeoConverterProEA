// FileGDB .gdbtable / .gdbtablx yazıcısı (OpenFileGDB, tablo sürümü 3 — "FGDB 10").
// Yapı GDAL ogr/ogrsf_frmts/openfilegdb/filegdbtable_write.cpp + filegdbtable_write_fields.cpp ile birebir:
//   .gdbtable: başlık (40 bayt + oluşturucu metni) → alan tanımları → satırlar (uint32 boy + gövde)
//   .gdbtablx: başlık (16 bayt) → 1024'lük sayfalarda satır ofsetleri → kuyruk (blok haritası)
// Satırlar 1'den başlayan sıralı OBJECTID ile eklenir (seyrek tablo/blok haritası gerekmez).

import { BaytYazici } from '../geopackage.js'

export const ALAN = Object.freeze({
  INT16: 0,
  INT32: 1,
  FLOAT32: 2,
  FLOAT64: 3,
  STRING: 4,
  DATETIME: 5,
  OBJECTID: 6,
  GEOMETRY: 7,
  BINARY: 8,
  GUID: 10,
  GLOBALID: 11,
  XML: 12,
})
export const TABLO_GEOMETRISI = Object.freeze({ YOK: 0, NOKTA: 1, COKLU_NOKTA: 2, CIZGI: 3, POLIGON: 4 })

const NULLABLE = 1
const REQUIRED = 2
const EDITABLE = 4
const SAYFA = 1024
const OLUSTURUCU = 'GeoConverterProEA'
const utf8 = new TextEncoder()

/** FileGDB ikili yazıcısı: BaytYazici + uint16/uint64/varuint/varint/UTF-16. */
export class FgdbYazici extends BaytYazici {
  u16(v) {
    this.yer(2)
    this.dv.setUint16(this.o, v, true)
    this.o += 2
  }
  i16(v) {
    this.yer(2)
    this.dv.setInt16(this.o, v, true)
    this.o += 2
  }
  u64(v) {
    this.yer(8)
    this.dv.setBigUint64(this.o, BigInt(v), true)
    this.o += 8
  }
  baytlar(b) {
    this.yer(b.length)
    this.tampon.set(b, this.o)
    this.o += b.length
  }
  /** İşaretsiz değişken uzunluklu tamsayı (7 bit + devam biti); 2^53'e kadar güvenli. */
  varuint(n) {
    let v = n
    while (v >= 0x80) {
      this.u8((v % 0x80) | 0x80)
      v = Math.floor(v / 0x80)
    }
    this.u8(v)
  }
  /** İşaretli: ilk bayt 6 bit değer + bit6 işaret + bit7 devam; kalanı varuint. */
  varint(n) {
    const negatif = n < 0
    let v = Math.abs(n)
    const ilk = (v % 0x40) | (negatif ? 0x40 : 0)
    if (v >= 0x40) {
      this.u8(ilk | 0x80)
      v = Math.floor(v / 0x40)
      this.varuint(v)
    } else this.u8(ilk)
  }
  /** UTF-16LE: karakter sayısı uint8 önekli. */
  utf16Kisa(s) {
    this.u8(s.length)
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i))
  }
  /** UTF-16LE: bayt sayısı uint16 önekli. */
  utf16Uzun(s) {
    this.u16(s.length * 2)
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i))
  }
}

/** '{8405add5-8df8-4227-8fac-3fcade073386}' → 16 bayt (ilk üç grup little-endian). */
export function guidBaytlari(guid) {
  const h = guid.replace(/[{}-]/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(h)) throw new Error(`geçersiz GUID: ${guid}`)
  const b = Array.from({ length: 16 }, (_, i) => parseInt(h.substr(i * 2, 2), 16))
  return Uint8Array.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.slice(8)])
}

/** Rastgele GUID, GDAL/FileGDB SDK biçiminde: {XXXXXXXX-XXXX-4XXX-YXXX-XXXXXXXXXXXX}. */
export function yeniGuid() {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join('')
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`
}

/**
 * Alan tanımı: { ad, tip, nullable, required, editable, genislik (STRING), geom (GEOMETRY) }.
 * geom: { wkt, xOrigin, yOrigin, xyScale, zOrigin, zScale, mOrigin, mScale, xyTolerance, zTolerance, mTolerance }
 */
export class FgdbTablo {
  constructor({ geometriTipi = TABLO_GEOMETRISI.YOK, z = false, m = false, ofsetBoyu = 4, alanlar }) {
    this.geometriTipi = geometriTipi
    this.z = z
    this.m = m
    this.ofsetBoyu = ofsetBoyu
    this.alanlar = alanlar
    this.nullableSayisi = alanlar.filter((a) => a.nullable).length
    this.satirlar = []
    this.kapsam = { minx: NaN, miny: NaN, maxx: NaN, maxy: NaN, minz: NaN, maxz: NaN }
    this.izgara = [0]
  }

  /** Kapsamı genişletir (GDAL EncodeFeature ile aynı: boş olmayan geometrilerde). */
  kapsamaEkle(k) {
    const a = this.kapsam
    if (Number.isNaN(a.minx)) Object.assign(a, k)
    else {
      a.minx = Math.min(a.minx, k.minx)
      a.miny = Math.min(a.miny, k.miny)
      a.maxx = Math.max(a.maxx, k.maxx)
      a.maxy = Math.max(a.maxy, k.maxy)
      a.minz = Math.min(a.minz, k.minz)
      a.maxz = Math.max(a.maxz, k.maxz)
    }
  }

  /** Satır ekler. degerler: alanlarla aynı sırada; OBJECTID yok sayılır, GEOMETRY için Uint8Array | null. */
  satirEkle(degerler) {
    const w = new FgdbYazici(64)
    const bitmap = new Uint8Array(Math.ceil(this.nullableSayisi / 8)).fill(0xff)
    w.baytlar(bitmap)
    let iNull = 0
    this.alanlar.forEach((a, i) => {
      if (a.tip === ALAN.OBJECTID) return
      const v = degerler[i]
      if (v == null) {
        if (!a.nullable) throw new Error(`"${a.ad}" alanı NULL olamaz`)
        iNull++
        return
      }
      switch (a.tip) {
        case ALAN.INT16:
          w.i16(v)
          break
        case ALAN.INT32:
          w.i32(v)
          break
        case ALAN.FLOAT64:
        case ALAN.DATETIME:
          w.f64(v)
          break
        case ALAN.STRING:
        case ALAN.XML: {
          const b = utf8.encode(String(v))
          w.varuint(b.length)
          w.baytlar(b)
          break
        }
        case ALAN.GEOMETRY:
        case ALAN.BINARY:
          w.varuint(v.length)
          w.baytlar(v)
          break
        case ALAN.GUID:
        case ALAN.GLOBALID:
          w.baytlar(guidBaytlari(v))
          break
        default:
          throw new Error(`desteklenmeyen alan tipi ${a.tip}`)
      }
      if (a.nullable) {
        w.tampon[iNull >> 3] &= ~(1 << (iNull & 7))
        iNull++
      }
    })
    this.satirlar.push(w.sonuc())
  }

  alanTanimlari() {
    const w = new FgdbYazici(512)
    w.u32(0) // boy, sonra yamanır
    w.u32(4)
    const bayrak =
      this.geometriTipi + (1 << 8) + (this.geometriTipi !== TABLO_GEOMETRISI.YOK ? 1 << 9 : 0) + (this.m ? 2 ** 30 : 0) + (this.z ? 2 ** 31 : 0)
    w.u32(bayrak)
    w.u16(this.alanlar.length)
    for (const a of this.alanlar) {
      w.utf16Kisa(a.ad)
      w.utf16Kisa(a.alias || '')
      w.u8(a.tip)
      const bayrakAlan = (a.nullable ? NULLABLE : 0) | (a.required ? REQUIRED : 0) | (a.editable ? EDITABLE : 0)
      switch (a.tip) {
        case ALAN.INT16:
          w.u8(2)
          w.u8(bayrakAlan)
          w.u8(0)
          break
        case ALAN.INT32:
        case ALAN.FLOAT32:
          w.u8(4)
          w.u8(bayrakAlan)
          w.u8(0)
          break
        case ALAN.FLOAT64:
        case ALAN.DATETIME:
          w.u8(8)
          w.u8(bayrakAlan)
          w.u8(0)
          break
        case ALAN.STRING:
          w.u32(a.genislik)
          w.u8(bayrakAlan)
          w.u8(0)
          break
        case ALAN.OBJECTID:
          w.u8(4)
          w.u8(2)
          break
        case ALAN.GEOMETRY: {
          const g = a.geom
          w.u8(0)
          w.u8(bayrakAlan)
          w.utf16Uzun(g.wkt)
          w.u8(1 | 2 | 4) // M ve Z köken/ölçek/tolerans var
          for (const v of [g.xOrigin, g.yOrigin, g.xyScale, g.mOrigin, g.mScale, g.zOrigin, g.zScale, g.xyTolerance, g.mTolerance, g.zTolerance]) w.f64(v)
          const k = this.kapsam
          for (const v of [k.minx, k.miny, k.maxx, k.maxy]) w.f64(v)
          if (this.z) {
            w.f64(k.minz)
            w.f64(k.maxz)
          }
          w.u8(0)
          w.u32(this.izgara.length)
          for (const v of this.izgara) w.f64(v)
          break
        }
        case ALAN.BINARY:
        case ALAN.XML:
          w.u8(0)
          w.u8(bayrakAlan)
          break
        case ALAN.GUID:
        case ALAN.GLOBALID:
          w.u8(38)
          w.u8(bayrakAlan)
          break
        default:
          throw new Error(`desteklenmeyen alan tipi ${a.tip}`)
      }
    }
    w.baytlar(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))
    w.dv.setUint32(0, w.o - 4, true)
    return w.sonuc()
  }

  /** { gdbtable, gdbtablx } baytları. */
  dosyalar() {
    const olusturucu = OLUSTURUCU
    const basBoyu = 40 + 4 + olusturucu.length
    const fd = this.alanTanimlari()
    let boy = basBoyu + fd.length
    const ofsetler = this.satirlar.map((s) => {
      const o = boy
      boy += 4 + s.length
      return o
    })
    const enBuyuk = Math.max(fd.length - 4, ...this.satirlar.map((s) => s.length))
    const t = new FgdbYazici(boy)
    t.u32(3)
    t.u32(this.satirlar.length)
    t.u32(enBuyuk)
    t.u32(5)
    t.u32(0)
    t.u32(0)
    t.u64(boy)
    t.u64(basBoyu)
    t.u32(olusturucu.length)
    t.baytlar(utf8.encode(olusturucu))
    t.baytlar(fd)
    for (const s of this.satirlar) {
      t.u32(s.length)
      t.baytlar(s)
    }

    const n = this.satirlar.length
    const blok = Math.ceil(n / SAYFA)
    const x = new FgdbYazici(16 + blok * SAYFA * this.ofsetBoyu + 16)
    x.u32(3)
    x.u32(blok)
    x.u32(n)
    x.u32(this.ofsetBoyu)
    for (let i = 0; i < blok * SAYFA; i++) {
      let v = i < n ? ofsetler[i] : 0
      for (let b = 0; b < this.ofsetBoyu; b++) {
        x.u8(v % 256)
        v = Math.floor(v / 256)
      }
    }
    x.u32(0) // blok haritası yok (sıralı OBJECTID)
    x.u32(blok)
    x.u32(blok)
    x.u32(0)
    return { gdbtable: t.sonuc(), gdbtablx: x.sonuc() }
  }
}
