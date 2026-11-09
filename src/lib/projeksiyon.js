/**
 * Koordinat sistemi dönüşümleri (M3) — proj4 tabanlı.
 *
 * Saf JavaScript: React/DOM kullanmaz; Web Worker ve Node (Vitest) içinde çalışır.
 * Koordinat sırası her zaman GeoJSON sırasıdır: [x (doğu / boylam), y (kuzey / enlem), z?].
 * Z (yükseklik) ve sonraki bileşenler dönüşüme sokulmaz, olduğu gibi korunur
 * (datum kaydırması elipsoidal yüksekliği değiştirir; ortometrik yüksekliklerin
 * bozulmaması için yalnızca yatay konum dönüştürülür).
 */
import proj4 from 'proj4'
import { KOORDINAT_SISTEMLERI, KOORDINAT_SISTEMI_TANIMLARI } from './katalog.js'
import { fcDogrula, fcKonumlariniEsle, geometriKonumlariniGez } from './geometri.js'

for (const s of KOORDINAT_SISTEMI_TANIMLARI) proj4.defs(s.kod, s.tanim)

/** Arayüzde gösterilecek koordinat sistemleri listesi (katalog.js'den). */
export { KOORDINAT_SISTEMLERI }

const TANIMLAR = new Map(KOORDINAT_SISTEMI_TANIMLARI.map((s) => [s.kod, s.tanim]))

function kodNormalle(kod) {
  if (typeof kod !== 'string') return kod
  return kod.trim().toUpperCase()
}

function tanimAl(kod, rol) {
  const n = kodNormalle(kod)
  if (!TANIMLAR.has(n)) {
    throw new Error(`Bilinmeyen ${rol} koordinat sistemi: "${kod}". Desteklenen sistemlerden birini seçin.`)
  }
  return n
}

/**
 * FeatureCollection'ı kaynak koordinat sisteminden hedefe dönüştürür.
 * Aynı kod verilirse derin kopya döndürülür. Dönüşümde bbox alanları
 * (artık geçersiz olacağından) kaldırılır.
 */
export function koordinatDonustur(fc, kaynakKod, hedefKod) {
  const kaynak = tanimAl(kaynakKod, 'kaynak')
  const hedef = tanimAl(hedefKod, 'hedef')
  if (kaynak === hedef) {
    return fcKonumlariniEsle(fc, (k) => k.slice(), (b) => (Array.isArray(b) ? b.slice() : b))
  }
  const donusturucu = proj4(kaynak, hedef)
  return fcKonumlariniEsle(
    fc,
    (k) => {
      const [x, y] = k
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`Geçersiz koordinat: [${k.join(', ')}] sayısal değil.`)
      }
      let sonuc
      try {
        sonuc = donusturucu.forward([x, y])
      } catch (e) {
        throw new Error(`Koordinat dönüştürülemedi [${x}, ${y}] (${kaynak} → ${hedef}): ${e.message}`)
      }
      if (!sonuc || !Number.isFinite(sonuc[0]) || !Number.isFinite(sonuc[1])) {
        throw new Error(
          `Koordinat dönüştürülemedi [${x}, ${y}] (${kaynak} → ${hedef}). Kaynak koordinat sistemini kontrol edin.`,
        )
      }
      return [sonuc[0], sonuc[1], ...k.slice(2)]
    },
    () => undefined,
  )
}

/**
 * Tüm koordinatlar boylam -180..180 ve enlem -90..90 aralığındaysa true döner.
 * Hiç koordinat yoksa (karar verilemez) false döner.
 */
export function wgs84OlabilirMi(fc) {
  let koordinatVar = false
  let uygun = true
  try {
    fcDogrula(fc)
    for (const f of fc.features) {
      geometriKonumlariniGez(f && f.geometry, (k) => {
        koordinatVar = true
        const [x, y] = k
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90) uygun = false
      })
      if (!uygun) return false
    }
  } catch {
    return false
  }
  return koordinatVar && uygun
}
