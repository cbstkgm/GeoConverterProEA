/**
 * Leica PTX yazıcısı. PTX, tarayıcı (scanner) başına ızgaralı (sütun × satır) bir biçimdir:
 *   sütun sayısı
 *   satır sayısı
 *   tarayıcı konumu (x y z)
 *   tarayıcı X ekseni / Y ekseni / Z ekseni (3 satır)
 *   4×4 dönüşüm matrisi (4 satır, satır başına 4 sayı; son satır öteleme)
 *   sütun × satır nokta satırı "x y z yoğunluk"
 *
 * CBS verisi yapılandırılmamış olduğundan YAKLAŞIM: tek tarama, 1 sütun × N satır ızgarası,
 * tarayıcı konumu 0 0 0, eksenler ve dönüşüm birim; noktalar mutlak (hedef CRS) koordinatlarla
 * yazılır. Yoğunluk PTX'te 0–1 aralığında normalize edilir; ölçüm olmadığından varsayılan 0.5
 * (orta gri; 0 birçok görüntüleyicide siyah/"dönüş yok" gibi görünür) yazılır.
 * PTX'te (0, 0, 0) noktası "ölçüm yok" anlamına gelir; böyle noktalar varsa uyarılır.
 */
import { sayiMetni } from './xyz.js'
import { noktaBulutuTopla, satirOnizleme } from './pts.js'

export async function ptxYaz(fc, secenekler = {}) {
  const b = noktaBulutuTopla(fc)
  if (!b.adet) {
    // Boş tarama (0 satır) PTX okuyucularının çoğunda (Cyclone, CloudCompare, PCL) hata verir.
    throw new Error('PTX yazılamadı: yazılacak nokta yok. PTX en az bir noktalık tarama ızgarası gerektirir.')
  }
  const yogunluk = Number.isFinite(secenekler.yogunluk) ? Math.min(1, Math.max(0, secenekler.yogunluk)) : 0.5
  const uyarilar = [
    'PTX yaklaşımı: yapılandırılmamış veri tek tarama, 1 sütun × N satır ızgarası olarak yazıldı; tarayıcı konumu (0,0,0), eksen ve dönüşüm matrisleri birim.',
    ...b.uyarilar,
  ]
  if (secenekler.crs) uyarilar.push('PTX biçimi koordinat sistemi bilgisi taşımaz; noktalar hedef CRS koordinatlarıyla yazıldı.')
  const baslik = [
    '1',
    String(b.adet),
    '0 0 0',
    '1 0 0',
    '0 1 0',
    '0 0 1',
    '1 0 0 0',
    '0 1 0 0',
    '0 0 1 0',
    '0 0 0 1',
  ]
  const yStr = sayiMetni(yogunluk)
  const satirlar = new Array(b.adet)
  let sifir = 0
  for (let i = 0; i < b.adet; i++) {
    if (b.x[i] === 0 && b.y[i] === 0 && b.z[i] === 0) sifir++
    satirlar[i] = `${sayiMetni(b.x[i])} ${sayiMetni(b.y[i])} ${sayiMetni(b.z[i])} ${yStr}`
  }
  if (sifir) uyarilar.push(`${sifir} nokta (0, 0, 0) konumunda; PTX okuyucuları bu noktaları "ölçüm yok" sayabilir.`)
  const veri = `${baslik.join('\n')}\n${satirlar.join('\n')}\n`
  return { veri, onizleme: satirOnizleme(satirlar, baslik), uyarilar }
}
