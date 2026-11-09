/**
 * ASPRS LAS 1.2 yazıcısı (nokta veri formatı 0, kayıt 20 bayt).
 *
 * Kaynak: ASPRS "LAS Specification Version 1.2" (2008). Başlık 227 bayttır (1.3/1.4'teki 235/375
 * değil). Tüm çok baytlı alanlar küçük endian.
 *  - Ölçek: projeksiyonlu 0.001 (mm); coğrafi (EPSG:4326) X/Y 1e-7 derece (~1 cm), Z 0.001 m.
 *  - Öteleme: her eksenin minimum sınırı (aşağı yuvarlanmış tamsayı) — böylece tamsayılar ≥ 0 olur
 *    ve INT32 aralığının tamamı (≈ 2.1e9 adım) kullanılabilir. Aralık yine de INT32'yi aşarsa ölçek
 *    10 kat büyütülerek sığdırılır ve uyarılır.
 *  - Dönüş: her nokta tek dönüşlü (return 1 / 1); "noktalar dönüş sayısına göre" dizisi [N,0,0,0,0].
 *  - Sınıflandırma 1 (sınıflanmamış). Point Source ID = objenin fc.features içindeki sırası
 *    (0 tabanlı); 65535'i aşan sıralar 65536'ya göre sarılır ve uyarılır.
 *  - CRS: LASF_Projection / 34735 GeoKeyDirectoryTag VLR. Coğrafi: GTModelType=2,
 *    GeographicTypeGeoKey(2048)=EPSG; projeksiyonlu: GTModelType=1, ProjectedCSTypeGeoKey(3072)=EPSG,
 *    ProjLinearUnitsGeoKey(3076)=9001 (metre). EPSG kodu 16 bit (≤ 65535) olmalıdır.
 */
import { noktaBulutuTopla, epsgNumarasi } from './pts.js'

const BASLIK_BOYU = 227
const KAYIT_BOYU = 20
const VLR_BASLIK_BOYU = 54
const INT32_AZAMI = 2147483647
const COGRAFI_EPSG = new Set([4326])

function asciiYaz(u8, ofset, metin, boy) {
  for (let i = 0; i < Math.min(boy, metin.length); i++) u8[ofset + i] = metin.charCodeAt(i) & 0x7f
}

/** Bir eksen için ölçek/öteleme seçer; INT32'ye sığmazsa ölçeği büyütür. */
function eksenAyarla(min, max, temelOlcek, eksen, uyarilar) {
  const oteleme = Math.floor(min)
  let olcek = temelOlcek
  while ((max - oteleme) / olcek > INT32_AZAMI) olcek *= 10
  if (olcek !== temelOlcek) {
    uyarilar.push(`${eksen} aralığı ${temelOlcek} ölçeğiyle INT32'ye sığmadı; ölçek ${olcek} yapıldı (hassasiyet azaldı).`)
  }
  return { olcek, oteleme }
}

/** GeoKeyDirectoryTag (34735) içeriği: unsigned short dizisi. */
export function geoAnahtarDizini(epsg) {
  const cografi = COGRAFI_EPSG.has(epsg)
  const anahtarlar = cografi
    ? [[1024, 0, 1, 2], [1025, 0, 1, 1], [2048, 0, 1, epsg]]
    : [[1024, 0, 1, 1], [1025, 0, 1, 1], [3072, 0, 1, epsg], [3076, 0, 1, 9001]]
  return [1, 1, 0, anahtarlar.length, ...anahtarlar.flat()]
}

/**
 * GeoJSON FeatureCollection → LAS 1.2 (Uint8Array).
 * Boş FC/nokta yoksa 0 noktalı geçerli bir LAS üretilir ve uyarılır (LAS 0 nokta kaydına izin verir).
 */
export async function lasYaz(fc, secenekler = {}) {
  const b = noktaBulutuTopla(fc)
  const uyarilar = [...b.uyarilar]
  const epsg = epsgNumarasi(secenekler.crs)
  let vlr = null
  if (secenekler.crs == null || secenekler.crs === '') {
    uyarilar.push('Hedef koordinat sistemi belirtilmedi; LAS dosyasına GeoKey (CRS) VLR yazılmadı.')
  } else if (epsg === null || epsg > 65535) {
    uyarilar.push(`"${secenekler.crs}" GeoTIFF anahtarına (16 bit EPSG) yazılamıyor; CRS VLR yazılmadı.`)
  } else {
    vlr = geoAnahtarDizini(epsg)
  }
  const cografi = epsg !== null ? COGRAFI_EPSG.has(epsg)
    : !!b.sinir && b.sinir.xmin >= -180 && b.sinir.xmax <= 180 && b.sinir.ymin >= -90 && b.sinir.ymax <= 90
  const s = b.sinir ?? { xmin: 0, ymin: 0, zmin: 0, xmax: 0, ymax: 0, zmax: 0 }
  const ex = eksenAyarla(s.xmin, s.xmax, cografi ? 1e-7 : 0.001, 'X', uyarilar)
  const ey = eksenAyarla(s.ymin, s.ymax, cografi ? 1e-7 : 0.001, 'Y', uyarilar)
  const ez = eksenAyarla(s.zmin, s.zmax, 0.001, 'Z', uyarilar)

  const vlrBoyu = vlr ? VLR_BASLIK_BOYU + vlr.length * 2 : 0
  const noktaOfseti = BASLIK_BOYU + vlrBoyu
  const veri = new Uint8Array(noktaOfseti + KAYIT_BOYU * b.adet)
  const dv = new DataView(veri.buffer)

  // --- Nokta kayıtları (önce: nicemlenmiş min/max başlığa yazılacak)
  const nic = (v, e) => Math.round((v - e.oteleme) / e.olcek)
  const qmin = [Infinity, Infinity, Infinity]
  const qmax = [-Infinity, -Infinity, -Infinity]
  let sarilan = 0
  let o = noktaOfseti
  for (let i = 0; i < b.adet; i++) {
    const q = [nic(b.x[i], ex), nic(b.y[i], ey), nic(b.z[i], ez)]
    for (let k = 0; k < 3; k++) {
      if (q[k] < qmin[k]) qmin[k] = q[k]
      if (q[k] > qmax[k]) qmax[k] = q[k]
    }
    dv.setInt32(o, q[0], true)
    dv.setInt32(o + 4, q[1], true)
    dv.setInt32(o + 8, q[2], true)
    dv.setUint16(o + 12, 0, true) // yoğunluk
    veri[o + 14] = 1 | (1 << 3) // dönüş no 1, dönüş sayısı 1, tarama yönü 0, kenar 0
    veri[o + 15] = 1 // sınıf: sınıflanmamış
    veri[o + 16] = 0 // tarama açısı
    veri[o + 17] = 0 // kullanıcı verisi
    if (b.obje[i] > 65535) sarilan++
    dv.setUint16(o + 18, b.obje[i] & 0xffff, true) // Point Source ID = obje sırası
    o += KAYIT_BOYU
  }
  if (sarilan) uyarilar.push(`${sarilan} noktanın obje sırası 65535'i aşıyor; Point Source ID 65536'ya göre sarıldı.`)

  // --- Başlık (227 bayt)
  const bugun = secenekler.tarih instanceof Date ? secenekler.tarih : new Date()
  const yilBasi = Date.UTC(bugun.getUTCFullYear(), 0, 1)
  const gun = Math.floor((Date.UTC(bugun.getUTCFullYear(), bugun.getUTCMonth(), bugun.getUTCDate()) - yilBasi) / 86400000) + 1
  asciiYaz(veri, 0, 'LASF', 4)
  dv.setUint16(4, 0, true) // File Source ID
  dv.setUint16(6, 0, true) // Global Encoding (GPS hafta zamanı; zaman alanı yok)
  // 8–23: Proje kimliği (GUID) — 0
  veri[24] = 1 // sürüm büyük
  veri[25] = 2 // sürüm küçük
  asciiYaz(veri, 26, 'OTHER', 32) // Sistem tanımlayıcı
  asciiYaz(veri, 58, 'GeoConverterProEA', 32) // Üreten yazılım
  dv.setUint16(90, gun, true)
  dv.setUint16(92, bugun.getUTCFullYear(), true)
  dv.setUint16(94, BASLIK_BOYU, true)
  dv.setUint32(96, noktaOfseti, true)
  dv.setUint32(100, vlr ? 1 : 0, true)
  veri[104] = 0 // nokta veri formatı 0
  dv.setUint16(105, KAYIT_BOYU, true)
  dv.setUint32(107, b.adet, true)
  dv.setUint32(111, b.adet, true) // dönüş 1
  // 115–130: dönüş 2–5 = 0
  const eksenler = [ex, ey, ez]
  eksenler.forEach((e, k) => {
    dv.setFloat64(131 + 8 * k, e.olcek, true)
    dv.setFloat64(155 + 8 * k, e.oteleme, true)
  })
  eksenler.forEach((e, k) => {
    const mx = b.adet ? qmax[k] * e.olcek + e.oteleme : 0
    const mn = b.adet ? qmin[k] * e.olcek + e.oteleme : 0
    dv.setFloat64(179 + 16 * k, mx, true)
    dv.setFloat64(187 + 16 * k, mn, true)
  })

  // --- VLR: LASF_Projection / 34735
  if (vlr) {
    const v = BASLIK_BOYU
    dv.setUint16(v, 0, true) // ayrılmış (1.2: 0)
    asciiYaz(veri, v + 2, 'LASF_Projection', 16)
    dv.setUint16(v + 18, 34735, true)
    dv.setUint16(v + 20, vlr.length * 2, true)
    asciiYaz(veri, v + 22, 'GeoKeyDirectoryTag', 32)
    vlr.forEach((d, i) => dv.setUint16(v + VLR_BASLIK_BOYU + 2 * i, d, true))
  }
  if (!b.adet) uyarilar.push('Yazılacak nokta bulunamadı; LAS dosyası 0 nokta içeriyor.')

  const onizleme = [
    'ASPRS LAS 1.2 — nokta formatı 0',
    `Nokta sayısı: ${b.adet}`,
    `Ölçek: ${ex.olcek} ${ey.olcek} ${ez.olcek}`,
    `Öteleme: ${ex.oteleme} ${ey.oteleme} ${ez.oteleme}`,
    b.sinir ? `Sınır: X ${s.xmin} … ${s.xmax}, Y ${s.ymin} … ${s.ymax}, Z ${s.zmin} … ${s.zmax}` : 'Sınır: (boş)',
    vlr ? `CRS: EPSG:${epsg} (${cografi ? 'GeographicTypeGeoKey 2048' : 'ProjectedCSTypeGeoKey 3072'})` : 'CRS: yazılmadı',
    `Dosya boyutu: ${veri.length} bayt`,
  ].join('\n')
  return { veri, onizleme, uyarilar }
}
