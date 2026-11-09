// M5 — Saf işlem boru hattı.
// Worker'dan bağımsızdır: hem donusturucu.worker.js içinde, hem ana iş parçacığında
// (Worker kullanılamadığında) hem de Node/Vitest altında aynı şekilde çalışır.
// React, window, document veya DOM API'si KULLANMAZ.

import { dosyaOku } from '../lib/okuyucular.js';
import { dosyaYaz } from '../lib/yazicilar.js';
import { zDegerleriniKaldir, hassasiyetUygula, istatistikHesapla, geometriTipiDonustur } from '../lib/geometri.js';
import { koordinatDonustur, wgs84OlabilirMi } from '../lib/projeksiyon.js';
import { WGS84, wgs84ZorunluMu } from '../lib/katalog.js';

export { WGS84 };

/**
 * İlerleme geri çağrısını güvenle çağırır. Geri çağrı bir Promise döndürürse beklenir;
 * ana iş parçacığı yedeğinde bu, tarayıcının aşamalar arasında ekranı boyamasını sağlar.
 * @param {((ilerleme: { yuzde: number, asama: string }) => unknown) | undefined} ilerle
 */
async function bildir(ilerle, yuzde, asama) {
  if (typeof ilerle !== 'function') return;
  await ilerle({ yuzde: Math.max(0, Math.min(100, Math.round(yuzde))), asama });
}

function featureCollectionDogrula(geojson, baglam) {
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error(`${baglam}: Geçerli bir GeoJSON FeatureCollection bekleniyordu.`);
  }
}

function crsDogrula(kod, alan) {
  if (typeof kod !== 'string' || kod.trim() === '') {
    throw new Error(`Koordinat sistemi belirtilmedi (${alan}).`);
  }
}

function arrayBufferAl(veri) {
  if (veri instanceof ArrayBuffer) return veri;
  if (ArrayBuffer.isView(veri)) {
    return veri.buffer.slice(veri.byteOffset, veri.byteOffset + veri.byteLength);
  }
  throw new Error('Dosya içeriği okunamadı: ArrayBuffer bekleniyordu.');
}

/**
 * Dosyayı okur, istatistik çıkarır ve koordinat sistemini tahmin eder.
 * @param {{ ad: string, veri: ArrayBuffer | Uint8Array }} girdi
 * @param {(ilerleme: { yuzde: number, asama: string }) => unknown} [ilerle]
 * @returns {Promise<{ geojson, uyarilar: string[], istatistik, tahminiCrs: string | null }>}
 */
export async function oku(girdi, ilerle) {
  if (!girdi || typeof girdi.ad !== 'string' || girdi.ad.trim() === '') {
    throw new Error('Dosya adı belirtilmedi.');
  }
  const veri = arrayBufferAl(girdi.veri);
  if (veri.byteLength === 0) {
    throw new Error(`"${girdi.ad}" dosyası boş.`);
  }

  await bildir(ilerle, 5, 'Dosya okunuyor');
  const { geojson, uyarilar } = await dosyaOku({ ad: girdi.ad, veri });
  featureCollectionDogrula(geojson, 'Okuma sonucu');

  await bildir(ilerle, 70, 'İstatistikler hesaplanıyor');
  const istatistik = istatistikHesapla(geojson);

  await bildir(ilerle, 85, 'Koordinat sistemi tahmin ediliyor');
  const tahminiCrs = istatistik.koordinatSayisi > 0 && wgs84OlabilirMi(geojson) ? WGS84 : null;

  await bildir(ilerle, 100, 'Tamamlandı');
  return { geojson, uyarilar: Array.isArray(uyarilar) ? uyarilar : [], istatistik, tahminiCrs };
}

/**
 * Sözleşmedeki sıra: koordinatDonustur → (geometriTipi) geometriTipiDonustur → (zTemizle) zDegerleriniKaldir →
 * (hassasiyet) hassasiyetUygula → dosyaYaz. Ardından harita için EPSG:4326 kopyası.
 * @param {object} geojson FeatureCollection
 * @param {string} hedefUzanti örn. '.wkt'
 * @param {{ kaynakCrs: string, hedefCrs: string, zTemizle?: boolean, hassasiyet?: number | null, geometriTipi?: 'Polygon' | 'LineString' | null }} secenekler
 * @param {(ilerleme: { yuzde: number, asama: string }) => unknown} [ilerle]
 */
export async function donustur(geojson, hedefUzanti, secenekler, ilerle) {
  featureCollectionDogrula(geojson, 'Dönüştürme girdisi');
  if (typeof hedefUzanti !== 'string' || hedefUzanti.trim() === '') {
    throw new Error('Hedef dosya formatı belirtilmedi.');
  }
  const { kaynakCrs, hedefCrs, zTemizle = false, hassasiyet = null, geometriTipi = null } = secenekler || {};
  crsDogrula(kaynakCrs, 'kaynak');
  crsDogrula(hedefCrs, 'hedef');
  if (wgs84ZorunluMu(hedefUzanti) && hedefCrs.trim().toUpperCase() !== WGS84) {
    throw new Error(
      `${hedefUzanti.trim().toUpperCase()} çıktısı yalnızca WGS84 (EPSG:4326) koordinatları taşıyabilir; hedef koordinat sistemi olarak ${hedefCrs} seçilemez.`,
    );
  }

  let fc = geojson;

  await bildir(ilerle, 5, 'Koordinatlar dönüştürülüyor');
  if (kaynakCrs !== hedefCrs) {
    fc = koordinatDonustur(fc, kaynakCrs, hedefCrs);
  }

  const uyarilar = [];
  if (geometriTipi) {
    await bildir(ilerle, 25, geometriTipi === 'Polygon' ? 'Çizgiler poligona çevriliyor' : 'Poligonlar çizgiye çevriliyor');
    const tipSonucu = geometriTipiDonustur(fc, geometriTipi);
    fc = tipSonucu.geojson;
    uyarilar.push(...tipSonucu.uyarilar);
  }

  if (zTemizle) {
    await bildir(ilerle, 35, 'Z değerleri temizleniyor');
    fc = zDegerleriniKaldir(fc);
  }

  if (hassasiyet !== null && hassasiyet !== undefined) {
    if (!Number.isInteger(hassasiyet) || hassasiyet < 0) {
      throw new Error('Hassasiyet sıfır veya pozitif bir tam sayı olmalıdır.');
    }
    await bildir(ilerle, 45, 'Hassasiyet uygulanıyor');
    fc = hassasiyetUygula(fc, hassasiyet);
  }

  await bildir(ilerle, 55, 'Dosya yazılıyor');
  const sonuc = await dosyaYaz(fc, hedefUzanti);

  await bildir(ilerle, 80, 'Harita önizlemesi hazırlanıyor');
  const haritaGeojson = hedefCrs === WGS84 ? fc : koordinatDonustur(fc, hedefCrs, WGS84);

  await bildir(ilerle, 92, 'İstatistikler hesaplanıyor');
  const istatistik = istatistikHesapla(fc);

  await bildir(ilerle, 100, 'Tamamlandı');
  return {
    sonuc: { veri: sonuc.veri, mime: sonuc.mime, uzanti: sonuc.uzanti, onizleme: sonuc.onizleme },
    haritaGeojson,
    istatistik,
    uyarilar,
  };
}

/**
 * Haritada göstermek için FeatureCollection'ı EPSG:4326'ya çevirir.
 */
export async function wgs84e(geojson, kaynakCrs, ilerle) {
  featureCollectionDogrula(geojson, 'Harita girdisi');
  crsDogrula(kaynakCrs, 'kaynak');
  await bildir(ilerle, 10, 'Koordinatlar WGS84\'e dönüştürülüyor');
  const sonuc = kaynakCrs === WGS84 ? geojson : koordinatDonustur(geojson, kaynakCrs, WGS84);
  await bildir(ilerle, 100, 'Tamamlandı');
  return sonuc;
}

/** Mesaj protokolündeki `tip` → işleyici eşlemesi (worker ve yedek mod ortak kullanır). */
export function istekIsle(tip, yuk, ilerle) {
  switch (tip) {
    case 'oku':
      return oku(yuk, ilerle);
    case 'donustur':
      return donustur(yuk?.geojson, yuk?.hedefUzanti, yuk?.secenekler, ilerle);
    case 'wgs84e':
      return wgs84e(yuk?.geojson, yuk?.kaynakCrs, ilerle);
    default:
      return Promise.reject(new Error(`Bilinmeyen işlem türü: ${String(tip)}`));
  }
}
