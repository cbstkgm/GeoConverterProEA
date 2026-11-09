/**
 * Point Cloud Library PCD v0.7 yazıcısı.
 *
 * Alanlar: x y z (TYPE F SIZE 8 = double) ve label (TYPE U SIZE 4 = obje sırası).
 * Hassasiyet kararı: projeksiyonlu koordinatlar (ör. 500000, 4400000) float32'de ~0.25–0.5 m
 * çözünürlüğe düşer. İki yol vardı: (a) double alan, (b) float32 + öteleme. PCD'de ötelemeyi
 * taşıyacak standart bir başlık alanı yoktur (VIEWPOINT sensör pozudur, veri dönüşümü değil);
 * ötelenmiş dosya başka araçlarda yanlış konumda görünür. Bu yüzden koordinatlar double (SIZE 8)
 * yazılır: veri kaybı yok, CloudCompare/PDAL/PCL (PCLPointCloud2) okur. Not: pcl::PointXYZ'e
 * doğrudan yüklemede PCL alan tipi uyuşmazlığı uyarısı verebilir.
 *
 * DATA ascii (varsayılan) ya da secenekler.ikili === true ise binary (küçük endian, paketli).
 * Saf JS: DOM / window yok.
 */
import { sayiMetni } from './xyz.js'
import { noktaBulutuTopla, satirOnizleme, ONIZLEME_SATIR } from './pts.js'

const KAYIT_BOYU = 8 * 3 + 4

export async function pcdYaz(fc, secenekler = {}) {
  const b = noktaBulutuTopla(fc)
  const uyarilar = [...b.uyarilar]
  if (secenekler.crs) uyarilar.push('PCD biçimi koordinat sistemi bilgisi taşımaz; noktalar hedef CRS koordinatlarıyla yazıldı.')
  if (!b.adet) uyarilar.push('Yazılacak nokta bulunamadı; PCD dosyası 0 nokta içeriyor.')
  const ikili = secenekler.ikili === true
  const baslik = [
    '# .PCD v0.7 - Point Cloud Data file format',
    'VERSION 0.7',
    'FIELDS x y z label',
    'SIZE 8 8 8 4',
    'TYPE F F F U',
    'COUNT 1 1 1 1',
    `WIDTH ${b.adet}`,
    'HEIGHT 1',
    'VIEWPOINT 0 0 0 1 0 0 0',
    `POINTS ${b.adet}`,
    `DATA ${ikili ? 'binary' : 'ascii'}`,
  ]
  const ornek = []
  for (let i = 0; i < Math.min(b.adet, ONIZLEME_SATIR); i++) {
    ornek.push(`${sayiMetni(b.x[i])} ${sayiMetni(b.y[i])} ${sayiMetni(b.z[i])} ${b.obje[i]}`)
  }
  let onizleme = satirOnizleme(ornek, ikili ? [...baslik, '(ikili veri; ilk noktalar metin olarak:)'] : baslik)
  if (b.adet > ornek.length) onizleme += `\n… ${b.adet - ornek.length} nokta daha`

  if (!ikili) {
    const satirlar = new Array(b.adet)
    for (let i = 0; i < b.adet; i++) {
      satirlar[i] = `${sayiMetni(b.x[i])} ${sayiMetni(b.y[i])} ${sayiMetni(b.z[i])} ${b.obje[i]}`
    }
    return { veri: `${baslik.join('\n')}\n${satirlar.length ? `${satirlar.join('\n')}\n` : ''}`, onizleme, uyarilar }
  }
  const ust = new TextEncoder().encode(`${baslik.join('\n')}\n`)
  const veri = new Uint8Array(ust.length + KAYIT_BOYU * b.adet)
  veri.set(ust, 0)
  const dv = new DataView(veri.buffer)
  let o = ust.length
  for (let i = 0; i < b.adet; i++) {
    dv.setFloat64(o, b.x[i], true)
    dv.setFloat64(o + 8, b.y[i], true)
    dv.setFloat64(o + 16, b.z[i], true)
    dv.setUint32(o + 24, b.obje[i], true)
    o += KAYIT_BOYU
  }
  return { veri, onizleme, uyarilar }
}
