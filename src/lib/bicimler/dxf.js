/**
 * DXF yazıcısı: GeoJSON FeatureCollection → ASCII DXF (AutoCAD R12 / AC1009).
 *
 * Neden R12 (AC1009)?
 *  - Netcad, AutoCAD (tüm sürümler), QGIS/GDAL, MicroStation, LibreCAD ve neredeyse her CAD/CBS
 *    aracı R12 ASCII DXF'i okur. R12 nesne tanıtıcıları (handle), sınıflar ve OBJECTS bölümü
 *    gerektirmez; AC1015'e (R2000) göre hatasız üretmesi çok daha kolay ve uyumluluğu daha geniştir.
 *  - R12'de LWPOLYLINE yoktur: çizgiler POLYLINE + VERTEX … + SEQEND olarak yazılır.
 *
 * Yapı: HEADER → TABLES (LTYPE, LAYER, STYLE) → BLOCKS (boş) → ENTITIES → EOF.
 *  - Point            → POINT (Z varsa 30 kodu; yoksa 0)
 *  - LineString       → açık POLYLINE
 *  - Polygon          → her halka (dış + delikler) ayrı kapalı POLYLINE (70 bayrağı 1)
 *  - Multi* / GeometryCollection → parçalanır, her parça kendi varlığı olur
 *  - Z varsa 3B polyline (70 bayrağı 8, VERTEX bayrağı 32); yoksa 2B polyline.
 *  - secenekler.etiketler === true ise `name`/`ad` özniteliğinden orta-orta hizalı TEXT eklenir:
 *    nokta → noktada; çizgi → uzunluğun ortasında; poligon → her parçanın İÇİNDE kalan noktada.
 *  - secenekler.oznitelikler !== false ise öznitelikler XDATA olarak yazılır (APPID GEOCONVERTER,
 *    1000 "anahtar=değer"); POLYLINE'da POLYLINE varlığına yazılır, VERTEX'lere değil.
 *
 * Karakter kodlaması kararı:
 *  R12 DXF Unicode değildir; metin $DWGCODEPAGE ile belirtilen kod sayfasında yorumlanır.
 *  Türkçe karakterleri (ÇĞİÖŞÜ çğıöşü) korumak için $DWGCODEPAGE = ANSI_1254 (Windows-1254,
 *  Türkçe) yazılır ve dosya baytları Windows-1254 olarak kodlanır (`veri` bir Uint8Array'dir).
 *  Netcad ve Türkçe AutoCAD bu kod sayfasını doğrudan tanır. Kod sayfasında karşılığı olmayan
 *  karakterler TEXT değerlerinde AutoCAD'in \U+XXXX kaçış biçimiyle, katman adlarında "_" ile yazılır.
 *  `onizleme` aynı içeriğin JS metni (Unicode) halidir.
 *
 * Katman adı kararı:
 *  R12 sembol adları en fazla 31 karakter; harf, rakam, "$", "-", "_" içerir ve büyük harflidir
 *  (uzun/serbest adlar ancak R2000'deki $EXTNAMES ile gelir). Bu yüzden adlar Türkçe yerel ayarla
 *  büyük harfe çevrilir (i → İ, ı → I), Türkçe harfler korunur (Windows-1254 ile kodlanır), boşluk
 *  ve <>/\":;?*|=` dahil diğer tüm karakterler "_" olur, 31 karaktere kırpılır.
 *
 * Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
 */
import { KOORDINAT_SISTEMI_TANIMLARI } from '../katalog.js'

const SATIR_SONU = '\r\n'
const KATMAN_AZAMI_UZUNLUK = 31
const TEXT_AZAMI_UZUNLUK = 255
const VARSAYILAN_KATMANLAR = { nokta: 'NOKTA', cizgi: 'CIZGI', poligon: 'POLIGON' }
const KATMAN_ANAHTARLARI = ['layer', 'katman', 'tabaka']
const AD_ANAHTARLARI = ['name', 'ad']
const XDATA_UYGULAMA = 'GEOCONVERTER'
/** R12 1000 grup kodu: en çok 255 bayt. */
const XDATA_DIZGE_AZAMI = 255
/** AutoCAD'in varlık başına XDATA sınırı 16 KB (16383 bayt). */
const XDATA_TOPLAM_AZAMI = 16383

// ---------------------------------------------------------------- Windows-1254 kodlama
// 0x00–0x7F ASCII; 0xA0–0xFF Latin-1 ile aynıdır, yalnızca 6 konum Türkçe harflere ayrılmıştır;
// 0x80–0x9F aralığı aşağıdaki tabloda.
const CP1254_OZEL = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86], ['‡', 0x87],
  ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c], ['‘', 0x91], ['’', 0x92],
  ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97], ['˜', 0x98], ['™', 0x99],
  ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c], ['Ÿ', 0x9f],
  ['Ğ', 0xd0], ['İ', 0xdd], ['Ş', 0xde], ['ğ', 0xf0], ['ı', 0xfd], ['ş', 0xfe],
])
// Latin-1'de olup Windows-1254'te Türkçe harfe verilen konumlar (Ð Ý Þ ð ý þ) kodlanamaz.
const CP1254_DISI_LATIN1 = new Set([0xd0, 0xdd, 0xde, 0xf0, 0xfd, 0xfe])

/** Karakterin Windows-1254 bayt değeri; karşılığı yoksa -1. */
function cp1254Bayt(karakter) {
  const kod = karakter.codePointAt(0)
  if (kod < 0x80) return kod
  const ozel = CP1254_OZEL.get(karakter)
  if (ozel !== undefined) return ozel
  if (kod >= 0xa0 && kod <= 0xff && !CP1254_DISI_LATIN1.has(kod)) return kod
  return -1
}

/** Yalnızca Windows-1254 ile temsil edilebilen karakterler içeren metni baytlara çevirir. */
function cp1254Kodla(metin) {
  const baytlar = new Uint8Array(metin.length)
  let i = 0
  for (const karakter of metin) {
    const b = cp1254Bayt(karakter)
    baytlar[i++] = b < 0 ? 0x3f /* ? */ : b
  }
  return baytlar.subarray(0, i)
}

/** TEXT değerleri: kod sayfası dışındaki karakterler AutoCAD \U+XXXX kaçışıyla yazılır. */
function metinDegeriHazirla(deger) {
  let sonuc = ''
  // eslint-disable-next-line no-control-regex
  const temiz = String(deger).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim()
  for (const karakter of temiz) {
    if (cp1254Bayt(karakter) >= 0) {
      sonuc += karakter
    } else {
      const kod = karakter.codePointAt(0)
      // BMP dışı karakterler (emoji vb.) \U+ ile temsil edilemez
      sonuc += kod > 0xffff ? '?' : `\\U+${kod.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return sonuc
}

// ---------------------------------------------------------------- Sayı biçimi
/**
 * Sayıyı yerel ayardan bağımsız, nokta ondalıklı, üstel gösterimsiz ve tam (gidiş-dönüş)
 * hassasiyetle yazar: 5 → "5.0", 1e-7 → "0.0000001", 412345.678 → "412345.678".
 */
export function dxfSayi(sayi) {
  if (!Number.isFinite(sayi)) throw new Error(`DXF'e sonlu olmayan sayı yazılamaz: ${sayi}`)
  if (Object.is(sayi, -0) || sayi === 0) return '0.0'
  const metin = String(sayi) // en kısa gidiş-dönüş gösterimi (ECMAScript Number::toString)
  const ust = metin.match(/^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/)
  if (!ust) return metin.includes('.') ? metin : `${metin}.0`
  const [, isaret, bas, kesir = '', usMetni] = ust
  const us = Number(usMetni)
  const rakamlar = bas + kesir
  if (us < 0) return `${isaret}0.${'0'.repeat(-us - 1)}${rakamlar}`
  const tam = rakamlar.padEnd(us + 1, '0')
  const kalan = rakamlar.slice(us + 1)
  return `${isaret}${tam}.${kalan || '0'}`
}

// ---------------------------------------------------------------- Katman adları
const katlanmisAnahtar = (k) => String(k).toLocaleLowerCase('tr')

/** Özniteliklerden (büyük/küçük harf duyarsız) aday adlardan ilk dolu değeri döndürür. */
function oznitelikDegeri(ozellikler, adaylar) {
  if (!ozellikler || typeof ozellikler !== 'object') return undefined
  const harita = new Map()
  for (const k of Object.keys(ozellikler)) {
    const a = katlanmisAnahtar(k)
    if (!harita.has(a)) harita.set(a, k)
  }
  for (const aday of adaylar) {
    const gercek = harita.get(aday)
    if (gercek === undefined) continue
    const deger = ozellikler[gercek]
    if (deger === null || deger === undefined || typeof deger === 'object') continue
    if (String(deger).trim() === '') continue
    return deger
  }
  return undefined
}

/**
 * Katman adını R12 kurallarına göre temizler (bkz. dosya başı açıklaması).
 * Boş sonuçta null döndürür (çağıran varsayılan katmanı kullanır).
 */
export function katmanAdiTemizle(ad) {
  if (ad === null || ad === undefined) return null
  let sonuc = ''
  for (const karakter of String(ad).trim().toLocaleUpperCase('tr')) {
    if (/[A-Z0-9$_-]/.test(karakter) || 'ÇĞİÖŞÜ'.includes(karakter)) sonuc += karakter
    else sonuc += '_'
  }
  sonuc = Array.from(sonuc).slice(0, KATMAN_AZAMI_UZUNLUK).join('')
  return /^_*$/.test(sonuc) ? null : sonuc
}

// ---------------------------------------------------------------- CRS
function cografiMi(crs) {
  if (typeof crs !== 'string') return false
  const kod = crs.trim().toUpperCase()
  const tanim = KOORDINAT_SISTEMI_TANIMLARI.find((s) => s.kod === kod)
  return tanim ? /\+proj=longlat\b/.test(tanim.tanim) : kod === 'EPSG:4326'
}

// ---------------------------------------------------------------- Yazım yardımcıları
function gecerliKonum(k) {
  return Array.isArray(k) && k.length >= 2 && Number.isFinite(k[0]) && Number.isFinite(k[1])
}
const zVar = (k) => k.length > 2 && Number.isFinite(k[2])

// ---------------------------------------------------------------- Etiket konumu
/** Çizginin uzunluk boyunca ortasındaki nokta (Z doğrusal enterpolasyonla). */
export function cizgiOrtaNoktasi(konumlar) {
  const parcaBoylari = []
  let toplam = 0
  for (let i = 1; i < konumlar.length; i++) {
    const b = Math.hypot(konumlar[i][0] - konumlar[i - 1][0], konumlar[i][1] - konumlar[i - 1][1])
    parcaBoylari.push(b)
    toplam += b
  }
  if (toplam === 0) return konumlar[0]
  let kalan = toplam / 2
  for (let i = 0; i < parcaBoylari.length; i++) {
    if (kalan <= parcaBoylari[i] || i === parcaBoylari.length - 1) {
      const t = parcaBoylari[i] === 0 ? 0 : Math.min(1, kalan / parcaBoylari[i])
      const [a, b] = [konumlar[i], konumlar[i + 1]]
      const sonuc = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      if (zVar(a) || zVar(b)) {
        const za = zVar(a) ? a[2] : 0
        const zb = zVar(b) ? b[2] : 0
        sonuc.push(za + (zb - za) * t)
      }
      return sonuc
    }
    kalan -= parcaBoylari[i]
  }
  return konumlar[0]
}

/** Çift-tek kuralıyla nokta-poligon testi (delikler dahil; sınır üzerindeki nokta belirsizdir). */
export function poligonIcindeMi(x, y, halkalar) {
  let ic = false
  for (const h of halkalar) {
    for (let i = 0, j = h.length - 1; i < h.length; j = i++) {
      const [xi, yi] = h[i]
      const [xj, yj] = h[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ic = !ic
    }
  }
  return ic
}

/** Halkanın alan ağırlıklı merkezi; alansızsa null. */
function halkaAgirlikMerkezi(h) {
  let a = 0
  let cx = 0
  let cy = 0
  // Sayısal kararlılık için ilk köşeye göre öteleme (büyük TM koordinatları)
  const [ox, oy] = h[0]
  for (let i = 0, j = h.length - 1; i < h.length; j = i++) {
    const x0 = h[j][0] - ox
    const y0 = h[j][1] - oy
    const x1 = h[i][0] - ox
    const y1 = h[i][1] - oy
    const c = x0 * y1 - x1 * y0
    a += c
    cx += (x0 + x1) * c
    cy += (y0 + y1) * c
  }
  if (a === 0) return null
  return [cx / (3 * a) + ox, cy / (3 * a) + oy]
}

/** Yatay tarama çizgisinin poligon içinde kalan en geniş aralığı: { x, genislik } ya da null. */
function enGenisIcAralik(y, halkalar) {
  const kesisimler = []
  for (const h of halkalar) {
    for (let i = 0, j = h.length - 1; i < h.length; j = i++) {
      const [xi, yi] = h[i]
      const [xj, yj] = h[j]
      if (yi > y !== yj > y) kesisimler.push(((xj - xi) * (y - yi)) / (yj - yi) + xi)
    }
  }
  kesisimler.sort((p, q) => p - q)
  let enIyi = null
  for (let i = 0; i + 1 < kesisimler.length; i += 2) {
    const genislik = kesisimler[i + 1] - kesisimler[i]
    if (genislik > 0 && (!enIyi || genislik > enIyi.genislik)) {
      enIyi = { x: (kesisimler[i] + kesisimler[i + 1]) / 2, genislik }
    }
  }
  return enIyi
}

/**
 * Poligonun kesinlikle içinde (deliklerin dışında) kalan etiket noktası.
 * 1) Dış halkanın ağırlık merkezi poligon içindeyse (deliğe düşmüyorsa) o kullanılır.
 * 2) Değilse (U/C biçimi, delik): sınır kutusu ortasından geçen yatay tarama çizgisinde en geniş
 *    iç aralığın ortası. Bu y aralık vermezse (ör. köşeye denk gelir), ardışık farklı köşe
 *    y'lerinin ortaları ortaya yakınlık sırasıyla denenir; bunlar hiçbir köşeden geçmez.
 * Bulunan nokta her durumda nokta-poligon testinden geçirilir. Z: dış halkanın Z ortalaması.
 */
export function poligonIcNoktasi(dis, delikler = []) {
  const halkalar = [dis, ...delikler]
  const zler = dis.filter(zVar).map((k) => k[2])
  const zEkle = (k) => (zler.length ? [...k, zler.reduce((t, z) => t + z, 0) / zler.length] : k)

  const merkez = halkaAgirlikMerkezi(dis)
  if (merkez && poligonIcindeMi(merkez[0], merkez[1], halkalar)) return zEkle(merkez)

  const ylar = [...new Set(halkalar.flat().map((k) => k[1]))].sort((p, q) => p - q)
  if (ylar.length < 2) return null
  const ortaY = (ylar[0] + ylar[ylar.length - 1]) / 2
  const adaylar = [ortaY]
  for (let i = 1; i < ylar.length; i++) adaylar.push((ylar[i - 1] + ylar[i]) / 2)
  adaylar.sort((p, q) => Math.abs(p - ortaY) - Math.abs(q - ortaY))
  for (const y of adaylar) {
    const aralik = enGenisIcAralik(y, halkalar)
    if (aralik && poligonIcindeMi(aralik.x, y, halkalar)) return zEkle([aralik.x, y])
  }
  return null
}

// ---------------------------------------------------------------- XDATA (öznitelikler)
function degeriMetneCevir(deger) {
  if (typeof deger === 'object') return JSON.stringify(deger)
  return String(deger)
}

/** Metni en çok `azami` bayta keser (Windows-1254'te karakter = bayt); \U+XXXX kaçışını bölmez. */
function baytaKes(metin, azami) {
  if (metin.length <= azami) return metin
  let kesik = metin.slice(0, azami)
  const kacis = kesik.lastIndexOf('\\U+')
  if (kacis >= 0 && kacis + 7 > kesik.length) kesik = kesik.slice(0, kacis)
  return kesik
}

/**
 * Özniteliklerden XDATA dizgeleri ("anahtar=değer") üretir.
 * Karar: 255 baytı aşan değer bölünmez, KESİLİR — bölünen parçalar okuyucuda yeni bir
 * "anahtar=değer" kaydıyla karıştırılabilir; kesmek kaydı tek ve anlamlı tutar (uyarı verilir).
 * Anahtardaki "=" "_" yapılır; okuyucular ilk "=" işaretinden böler. null/undefined yazılmaz.
 * Toplam XDATA (uygulama adı + dizgeler, grup başına 4 bayt ek yük sayılarak) 16383 baytı geçmez;
 * sığmayan öznitelikler (sırayla sondakiler) yazılmaz.
 */
export function xdataDizgeleri(ozellikler) {
  const dizgeler = []
  let kesilenDeger = 0
  let toplamKesildi = false
  let toplam = XDATA_UYGULAMA.length + 4
  for (const [anahtar, deger] of Object.entries(ozellikler || {})) {
    if (deger === null || deger === undefined) continue
    const ham = `${metinDegeriHazirla(anahtar).replace(/=/g, '_')}=${metinDegeriHazirla(degeriMetneCevir(deger))}`
    const dizge = baytaKes(ham, XDATA_DIZGE_AZAMI)
    if (dizge.length < ham.length) kesilenDeger++
    if (toplam + dizge.length + 4 > XDATA_TOPLAM_AZAMI) {
      toplamKesildi = true
      break
    }
    toplam += dizge.length + 4
    dizgeler.push(dizge)
  }
  return { dizgeler, kesilenDeger, toplamKesildi }
}

/** DXF varlıklarını biriktirir; sınır kutusunu ve kullanılan katmanları izler. */
class DxfYazici {
  constructor() {
    this.satirlar = []
    this.katmanlar = new Set()
    this.kutu = null
  }

  cift(kod, deger) {
    this.satirlar.push(String(kod).padStart(3, ' '), String(deger))
  }

  sayiCifti(kod, sayi) {
    this.cift(kod, dxfSayi(sayi))
  }

  kutuyaEkle(x, y, z) {
    if (!this.kutu) {
      this.kutu = [x, y, z, x, y, z]
      return
    }
    const b = this.kutu
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z)
    b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z)
  }

  /** XDATA: varlığın tüm grup kodlarından SONRA gelir (R12: 1001 uygulama adı, 1000 metinler). */
  xdata(dizgeler) {
    if (!dizgeler || dizgeler.length === 0) return
    this.cift(1001, XDATA_UYGULAMA)
    for (const d of dizgeler) this.cift(1000, d)
  }

  nokta(katman, k, xdata) {
    const z = zVar(k) ? k[2] : 0
    this.katmanlar.add(katman)
    this.cift(0, 'POINT')
    this.cift(8, katman)
    this.sayiCifti(10, k[0]); this.sayiCifti(20, k[1]); this.sayiCifti(30, z)
    this.xdata(xdata)
    this.kutuyaEkle(k[0], k[1], z)
  }

  /** Orta-orta hizalı TEXT (72=1 yatay orta, 73=2 dikey orta; 11/21/31 hizalama noktası). */
  metin(katman, k, deger, yukseklik) {
    const z = zVar(k) ? k[2] : 0
    this.katmanlar.add(katman)
    this.cift(0, 'TEXT')
    this.cift(8, katman)
    // Hizalama 0/0 değilken AutoCAD 10/20/30'u 11/21/31'den yeniden hesaplar; ikisine de aynı nokta yazılır.
    this.sayiCifti(10, k[0]); this.sayiCifti(20, k[1]); this.sayiCifti(30, z)
    this.sayiCifti(40, yukseklik)
    this.cift(1, deger)
    this.cift(72, 1)
    this.sayiCifti(11, k[0]); this.sayiCifti(21, k[1]); this.sayiCifti(31, z)
    this.cift(73, 2)
  }

  /** Konumlar önceden doğrulanmış olmalı; kapalıysa tekrarlanan son nokta çıkarılmış olmalı. */
  cokluCizgi(katman, konumlar, kapali, xdata) {
    const ucBoyutlu = konumlar.some(zVar)
    this.katmanlar.add(katman)
    this.cift(0, 'POLYLINE')
    this.cift(8, katman)
    this.cift(66, 1) // ardından VERTEX varlıkları gelir
    this.sayiCifti(10, 0); this.sayiCifti(20, 0); this.sayiCifti(30, 0)
    this.cift(70, (kapali ? 1 : 0) | (ucBoyutlu ? 8 : 0))
    this.xdata(xdata) // XDATA POLYLINE'a yazılır, VERTEX'lere değil
    for (const k of konumlar) {
      const z = zVar(k) ? k[2] : 0
      this.cift(0, 'VERTEX')
      this.cift(8, katman)
      this.sayiCifti(10, k[0]); this.sayiCifti(20, k[1]); this.sayiCifti(30, z)
      if (ucBoyutlu) this.cift(70, 32) // 3B polyline köşesi
      this.kutuyaEkle(k[0], k[1], z)
    }
    this.cift(0, 'SEQEND')
    this.cift(8, katman)
  }
}

// ---------------------------------------------------------------- Geometri → varlık
function geometriyiYaz(yazici, g, baglam, objeKatmani) {
  const katmanSec = (tur) => objeKatmani ?? VARSAYILAN_KATMANLAR[tur]
  const sorun = (mesaj) => baglam.sorunlar.push(mesaj)
  const etiketle = (katman, k) => {
    if (baglam.etiket === undefined || !k) return
    yazici.metin(katman, k, baglam.etiket, baglam.etiketYuksekligi)
    baglam.etiketSayisi++
  }

  const konumListesi = (dizi, tanim) => {
    if (!Array.isArray(dizi)) {
      sorun(`${tanim}: koordinat dizisi geçersiz, atlandı.`)
      return []
    }
    const gecerli = dizi.filter(gecerliKonum)
    if (gecerli.length !== dizi.length) sorun(`${tanim}: ${dizi.length - gecerli.length} geçersiz koordinat atlandı.`)
    return gecerli
  }

  const nokta = (k, tanim) => {
    if (!gecerliKonum(k)) {
      sorun(`${tanim}: nokta koordinatı geçersiz veya boş, atlandı.`)
      return
    }
    const katman = katmanSec('nokta')
    yazici.nokta(katman, k, baglam.xdata)
    baglam.varlikSayisi++
    etiketle(katman, k)
  }

  const cizgi = (dizi, tanim) => {
    const konumlar = konumListesi(dizi, tanim)
    if (konumlar.length < 2) {
      sorun(`${tanim}: çizgi en az 2 geçerli nokta içermiyor, atlandı.`)
      return
    }
    const katman = katmanSec('cizgi')
    yazici.cokluCizgi(katman, konumlar, false, baglam.xdata)
    baglam.varlikSayisi++
    if (baglam.etiket !== undefined) etiketle(katman, cizgiOrtaNoktasi(konumlar))
  }

  const halka = (dizi, tanim) => {
    let konumlar = konumListesi(dizi, tanim)
    if (konumlar.length >= 2) {
      const [a, b] = [konumlar[0], konumlar[konumlar.length - 1]]
      if (a[0] === b[0] && a[1] === b[1] && (a[2] ?? 0) === (b[2] ?? 0)) konumlar = konumlar.slice(0, -1)
    }
    if (konumlar.length < 3) {
      sorun(`${tanim}: halka en az 3 farklı nokta içermiyor, atlandı.`)
      return null
    }
    yazici.cokluCizgi(katmanSec('poligon'), konumlar, true, baglam.xdata)
    baglam.varlikSayisi++
    return konumlar
  }

  const poligon = (halkalar, tanim) => {
    if (!Array.isArray(halkalar) || halkalar.length === 0) {
      sorun(`${tanim}: boş poligon, atlandı.`)
      return
    }
    const yazilan = halkalar.map((h, i) => halka(h, i === 0 ? `${tanim} dış halka` : `${tanim} ${i}. delik`))
    if (baglam.etiket === undefined || !yazilan[0]) return
    const k = poligonIcNoktasi(yazilan[0], yazilan.slice(1).filter(Boolean))
    if (k) etiketle(katmanSec('poligon'), k)
    else sorun(`${tanim}: etiket için poligon içinde nokta bulunamadı (alansız poligon), etiket yazılmadı.`)
  }

  const parcalar = (dizi, tanim, fn) => {
    if (!Array.isArray(dizi) || dizi.length === 0) {
      sorun(`${tanim}: boş çoklu geometri, atlandı.`)
      return
    }
    dizi.forEach((p, i) => fn(p, `${tanim} ${i + 1}. parça`))
  }

  const yaz = (geo, tanim, derinlik) => {
    if (!geo || typeof geo !== 'object' || typeof geo.type !== 'string') {
      sorun(`${tanim}: geometri tanımsız, atlandı.`)
      return
    }
    switch (geo.type) {
      case 'Point': return nokta(geo.coordinates, tanim)
      case 'LineString': return cizgi(geo.coordinates, tanim)
      case 'Polygon': return poligon(geo.coordinates, tanim)
      case 'MultiPoint': return parcalar(geo.coordinates, tanim, nokta)
      case 'MultiLineString': return parcalar(geo.coordinates, tanim, cizgi)
      case 'MultiPolygon': return parcalar(geo.coordinates, tanim, poligon)
      case 'GeometryCollection':
        if (derinlik > 32) {
          sorun(`${tanim}: iç içe geometri koleksiyonu çok derin, atlandı.`)
          return
        }
        return parcalar(geo.geometries, tanim, (alt, t) => yaz(alt, t, derinlik + 1))
      default:
        sorun(`${tanim}: "${geo.type}" geometri tipi DXF'e yazılamıyor, atlandı.`)
    }
  }

  yaz(g, baglam.tanim, 0)
}

// ---------------------------------------------------------------- Bölümler
function basliklariYaz(cikti, kutu, birimKodu) {
  const [minX, minY, minZ, maxX, maxY, maxZ] = kutu ?? [1e20, 1e20, 1e20, -1e20, -1e20, -1e20]
  cikti.cift(0, 'SECTION')
  cikti.cift(2, 'HEADER')
  cikti.cift(9, '$ACADVER'); cikti.cift(1, 'AC1009')
  cikti.cift(9, '$DWGCODEPAGE'); cikti.cift(3, 'ANSI_1254')
  cikti.cift(9, '$INSBASE'); cikti.sayiCifti(10, 0); cikti.sayiCifti(20, 0); cikti.sayiCifti(30, 0)
  cikti.cift(9, '$EXTMIN'); cikti.sayiCifti(10, minX); cikti.sayiCifti(20, minY); cikti.sayiCifti(30, minZ)
  cikti.cift(9, '$EXTMAX'); cikti.sayiCifti(10, maxX); cikti.sayiCifti(20, maxY); cikti.sayiCifti(30, maxZ)
  if (kutu) {
    cikti.cift(9, '$LIMMIN'); cikti.sayiCifti(10, minX); cikti.sayiCifti(20, minY)
    cikti.cift(9, '$LIMMAX'); cikti.sayiCifti(10, maxX); cikti.sayiCifti(20, maxY)
  }
  // $INSUNITS R2000'de tanımlanmıştır; R12 okuyucular bilinmeyen başlık değişkenini yok sayar,
  // yeni sürümler (AutoCAD, Netcad, GDAL) ise birimi buradan alır. 6 = metre, 0 = birimsiz.
  cikti.cift(9, '$INSUNITS'); cikti.cift(70, birimKodu)
  cikti.cift(0, 'ENDSEC')
}

function tablolariYaz(cikti, katmanlar) {
  cikti.cift(0, 'SECTION')
  cikti.cift(2, 'TABLES')

  // XDATA kullanan her uygulama adı APPID tablosunda kayıtlı olmalıdır (ACAD her zaman bulunur).
  cikti.cift(0, 'TABLE'); cikti.cift(2, 'APPID'); cikti.cift(70, 2)
  for (const ad of ['ACAD', XDATA_UYGULAMA]) {
    cikti.cift(0, 'APPID'); cikti.cift(2, ad); cikti.cift(70, 0)
  }
  cikti.cift(0, 'ENDTAB')

  cikti.cift(0, 'TABLE'); cikti.cift(2, 'LTYPE'); cikti.cift(70, 1)
  cikti.cift(0, 'LTYPE'); cikti.cift(2, 'CONTINUOUS'); cikti.cift(70, 0)
  cikti.cift(3, 'Solid line'); cikti.cift(72, 65); cikti.cift(73, 0); cikti.sayiCifti(40, 0)
  cikti.cift(0, 'ENDTAB')

  cikti.cift(0, 'TABLE'); cikti.cift(2, 'LAYER'); cikti.cift(70, katmanlar.length)
  for (const ad of katmanlar) {
    cikti.cift(0, 'LAYER'); cikti.cift(2, ad); cikti.cift(70, 0)
    cikti.cift(62, 7); cikti.cift(6, 'CONTINUOUS')
  }
  cikti.cift(0, 'ENDTAB')

  cikti.cift(0, 'TABLE'); cikti.cift(2, 'STYLE'); cikti.cift(70, 1)
  cikti.cift(0, 'STYLE'); cikti.cift(2, 'STANDARD'); cikti.cift(70, 0)
  cikti.sayiCifti(40, 0); cikti.sayiCifti(41, 1); cikti.sayiCifti(50, 0); cikti.cift(71, 0)
  cikti.sayiCifti(42, 2.5); cikti.cift(3, 'txt'); cikti.cift(4, '')
  cikti.cift(0, 'ENDTAB')

  cikti.cift(0, 'ENDSEC')
}

// ---------------------------------------------------------------- Giriş noktası
/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler]
 * @param {string} [secenekler.crs] hedef EPSG kodu (ör. 'EPSG:5255'); birim ve etiket boyu için
 * @param {boolean} [secenekler.etiketler] true ise name/ad özniteliğinden TEXT eklenir
 * @param {boolean} [secenekler.oznitelikler] false değilse öznitelikler XDATA olarak yazılır
 * @param {number} [secenekler.etiketYuksekligi] TEXT yüksekliği (çizim biriminde)
 * @returns {Promise<{veri: Uint8Array, onizleme: string, uyarilar: string[]}>}
 */
export async function dxfYaz(fc, secenekler = {}) {
  const ayarlar = secenekler || {}
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.')
  }
  const uyarilar = []
  const cografi = cografiMi(ayarlar.crs)
  const etiketYuksekligi =
    Number.isFinite(ayarlar.etiketYuksekligi) && ayarlar.etiketYuksekligi > 0
      ? ayarlar.etiketYuksekligi
      : cografi ? 0.00002 : 1

  const yazici = new DxfYazici()
  const katmanEslemesi = new Map() // ham ad → temiz ad (uyarı için)
  let geometrisiz = 0
  let etiketSayisi = 0
  let kesilenDeger = 0
  let toplamiKesilenObje = 0
  const sorunlar = []

  fc.features.forEach((f, sira) => {
    if (!f || typeof f !== 'object') return
    if (f.geometry === null || f.geometry === undefined) {
      geometrisiz++
      return
    }
    const ozellikler = f.properties && typeof f.properties === 'object' ? f.properties : {}
    const hamKatman = oznitelikDegeri(ozellikler, KATMAN_ANAHTARLARI)
    let objeKatmani = null
    if (hamKatman !== undefined) {
      objeKatmani = katmanAdiTemizle(hamKatman)
      const ham = String(hamKatman)
      if (objeKatmani && objeKatmani !== ham) katmanEslemesi.set(ham, objeKatmani)
      if (!objeKatmani) sorunlar.push(`Obje ${sira + 1}: "${ham}" katman adı geçersiz, varsayılan katman kullanıldı.`)
    }
    const ad = ayarlar.etiketler === true ? oznitelikDegeri(ozellikler, AD_ANAHTARLARI) : undefined
    const etiket = ad === undefined ? undefined : metinDegeriHazirla(ad).slice(0, TEXT_AZAMI_UZUNLUK)
    let xdata
    if (ayarlar.oznitelikler !== false) {
      const sonuc = xdataDizgeleri(ozellikler)
      xdata = sonuc.dizgeler
      kesilenDeger += sonuc.kesilenDeger
      if (sonuc.toplamKesildi) toplamiKesilenObje++
    }
    const baglam = {
      tanim: `Obje ${sira + 1}`,
      sorunlar,
      xdata,
      etiket: etiket === '' ? undefined : etiket,
      etiketYuksekligi,
      varlikSayisi: 0,
      etiketSayisi: 0,
    }
    geometriyiYaz(yazici, f.geometry, baglam, objeKatmani)
    etiketSayisi += baglam.etiketSayisi
  })

  // Uyarılar (kısa ve toplu)
  if (geometrisiz) uyarilar.push(`${geometrisiz} obje geometrisiz olduğu için DXF'e yazılmadı.`)
  const SORUN_SINIRI = 10
  uyarilar.push(...sorunlar.slice(0, SORUN_SINIRI))
  if (sorunlar.length > SORUN_SINIRI) uyarilar.push(`… ve ${sorunlar.length - SORUN_SINIRI} benzer uyarı daha.`)
  if (katmanEslemesi.size) {
    const ornekler = [...katmanEslemesi].slice(0, 5).map(([a, b]) => `"${a}" → "${b}"`).join(', ')
    uyarilar.push(`${katmanEslemesi.size} katman adı DXF (R12) kurallarına göre düzeltildi (büyük harf, en çok 31 karakter, geçersiz karakterler "_"): ${ornekler}${katmanEslemesi.size > 5 ? ', …' : ''}.`)
  }
  if (kesilenDeger) {
    uyarilar.push(`${kesilenDeger} öznitelik değeri DXF XDATA sınırı (255 bayt) nedeniyle kısaltıldı.`)
  }
  if (toplamiKesilenObje) {
    uyarilar.push(`${toplamiKesilenObje} objenin öznitelikleri DXF'in varlık başına 16 KB XDATA sınırını aştığı için bir kısmı yazılmadı.`)
  }
  if (cografi) {
    uyarilar.push('Koordinatlar coğrafi (derece) — DXF çizim birimi "birimsiz" yazıldı. CAD yazılımlarında doğru ölçü için projeksiyonlu bir koordinat sistemi (ör. ITRF96 / 3° TM) seçin.')
  }
  if (ayarlar.etiketler === true && etiketSayisi === 0 && fc.features.length) {
    uyarilar.push('Etiket istendi ancak "name"/"ad" özniteliği olan obje bulunamadı.')
  }

  // Bölümleri sırayla birleştir (başlık sınır kutusu varlıklar yazıldıktan sonra bilinir).
  const katmanlar = ['0', ...[...yazici.katmanlar].filter((k) => k !== '0').sort()]
  const cikti = new DxfYazici()
  basliklariYaz(cikti, yazici.kutu, cografi ? 0 : 6)
  tablolariYaz(cikti, katmanlar)
  cikti.cift(0, 'SECTION'); cikti.cift(2, 'BLOCKS'); cikti.cift(0, 'ENDSEC')
  cikti.cift(0, 'SECTION'); cikti.cift(2, 'ENTITIES')
  const kapanis = new DxfYazici()
  kapanis.cift(0, 'ENDSEC')
  kapanis.cift(0, 'EOF')
  // Büyük veride yığın taşmasını önlemek için spread yerine concat
  const satirlar = cikti.satirlar.concat(yazici.satirlar, kapanis.satirlar)

  const metin = satirlar.join(SATIR_SONU) + SATIR_SONU
  return { veri: cp1254Kodla(metin), onizleme: metin, uyarilar }
}
