/**
 * IGES yazıcısı: GeoJSON FeatureCollection → IGES 5.3 ASCII (sabit 80 sütun).
 *
 * Kayıt düzeni (her satır tam 80 sütun):
 *   1–72 veri, 73 bölüm harfi (S/G/D/P/T), 74–80 bölüm içi sıra numarası (sağa yaslı).
 *   P bölümünde 1–64 parametre verisi, 66–72 varlığın D bölümündeki ilk satırının sıra numarası.
 * Bölümler: S (başlangıç metni) → G (global parametreler, Hollerith dizeleri "nH…") →
 *   D (her varlık için 2 satır, 9×8 sütunluk alanlar) → P (parametre verisi) → T (bölüm sayımları).
 *
 * Varlık seçimi:
 *  - Point → 116 (Point).
 *  - LineString ve poligon halkaları → 106 form 12 (Copious Data, 3B parçalı doğrusal eğri; IP=2,
 *    x,y,z üçlüleri). Gerekçe: 110 (Line) ile her kenar ayrı varlık olurdu — dosya ~3 kat büyür ve
 *    çizgi/halka bütünlüğü (seçim, ofset, kapalı sınır) kaybolur. 106/12 tek varlıkta tüm köşeleri
 *    taşır ve OCCT/FreeCAD, Rhino, CATIA, NX tarafından okunur. Halkalar kapalıdır: ilk köşe sonda
 *    tekrarlanır (106'da ayrı kapalılık bayrağı yoktur); delikler ayrı 106 varlığıdır.
 *  - Z yoksa 0 yazılır (form 12 her zaman 3B; form 11'in ortak-Z kısıtı karışık verilerde bozulurdu).
 *
 * Katman: `layer`/`katman`/`tabaka` özniteliği (yoksa NOKTA/CIZGI/POLIGON) D bölümündeki level
 *   alanına yazılır. IGES level'ı tamsayıdır: tamsayı adlar olduğu gibi, diğerleri sırayla 1, 2, …
 *   numaralarına eşlenir ve eşleme uyarı olarak bildirilir.
 *
 * Metin: IGES 7 bitlik ASCII'dir. Türkçe harfler ASCII karşılıklarına çevrilir (Ç→C, ğ→g, ı→i …),
 *   diğer ASCII dışı karakterler "?" olur. Obje adı (name/ad) D bölümündeki 8 karakterlik varlık
 *   etiketine (entity label) kısaltılarak yazılır; aynı objenin parçaları alt numara (subscript) alır.
 *
 * Satır sonu: varsayılan CRLF. IGES kayıtları sabit 80 sütundur; okuyucular (OCCT igesread, Rhino,
 *   NX…) yalnızca sütunlara bakar, sonlandırıcı 80. sütundan sonra geldiği için LF/CRLF fark etmez.
 *   Windows CAD araçlarının ürettiği/aldığı IGES dosyalarıyla aynı olsun diye CRLF seçildi;
 *   secenekler.satirSonu = '\n' ile değiştirilebilir.
 *
 * Birim: Global 14 = 6 (metre), 15 = "M". Coğrafi CRS'te uyarı verilir.
 *
 * Saf JS: DOM yok; worker ve Node'da çalışır.
 */
import {
  cbsParcalari,
  katmanNumaralari,
  eslemeUyarisi,
  objeAdi,
  objeKatmani,
  cografiMi,
  zamanAl,
  p21Sayi,
  zVar,
  VARSAYILAN_KATMANLAR,
} from './step.js'

const TURKCE_ASCII = { Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U', ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' }

/** Metni IGES için 7 bitlik yazdırılabilir ASCII'ye çevirir. */
export function igesAscii(metin) {
  return String(metin)
    .replace(/[ÇĞİÖŞÜçğıöşü]/g, (h) => TURKCE_ASCII[h])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?')
}

/** Hollerith dizesi: "5HHello". */
export const hollerith = (metin) => {
  const a = igesAscii(metin)
  return `${a.length}H${a}`
}

const igesSayi = (n) => p21Sayi(n)
const sagaYasla = (deger, genislik) => String(deger).padStart(genislik, ' ').slice(-genislik)

/** Bir satır: 72 sütun veri + bölüm harfi + 7 sütun sıra numarası. */
const kayit = (veri, bolum, sira) => `${veri.padEnd(72, ' ')}${bolum}${sagaYasla(sira, 7)}`

/**
 * Belirteçleri (parametreleri) satır genişliğine sığacak şekilde paketler; ayraçlar belirtecin
 * sonundadır. Tek belirteç genişliği aşarsa bölünür (yalnızca çok uzun Hollerith dizelerinde).
 */
function paketle(belirtecler, genislik) {
  const satirlar = []
  let satir = ''
  for (const b of belirtecler) {
    if (satir.length + b.length <= genislik) {
      satir += b
      continue
    }
    if (satir) satirlar.push(satir)
    satir = ''
    let kalan = b
    while (kalan.length > genislik) {
      satirlar.push(kalan.slice(0, genislik))
      kalan = kalan.slice(genislik)
    }
    satir = kalan
  }
  if (satir) satirlar.push(satir)
  return satirlar
}

/** Parametre listesini ayraçlarıyla belirteçlere çevirir: [a, b, c] → ["a,", "b,", "c;"]. */
const belirtecler = (parametreler) => parametreler.map((p, i) => `${p}${i === parametreler.length - 1 ? ';' : ','}`)

/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {object} [secenekler]
 * @param {string} [secenekler.crs] hedef EPSG kodu
 * @param {string} [secenekler.dosyaAdi] Global bölümdeki dosya adı (varsayılan "cikti.igs")
 * @param {Date|string} [secenekler.zaman] dosya tarihi (varsayılan: şimdi)
 * @param {string} [secenekler.satirSonu] '\r\n' (varsayılan) ya da '\n'
 * @returns {Promise<{veri: string, onizleme: string, uyarilar: string[]}>}
 */
export async function igesYaz(fc, secenekler = {}) {
  const ayarlar = secenekler || {}
  const satirSonu = ayarlar.satirSonu === '\n' ? '\n' : '\r\n'
  const { parcalar, uyarilar } = cbsParcalari(fc)
  if (cografiMi(ayarlar.crs)) {
    uyarilar.push('Koordinatlar coğrafi (derece) ancak IGES birimi metre olarak yazıldı; CAD yazılımında ölçüler anlamsız olur. Projeksiyonlu bir koordinat sistemi seçin.')
  }

  // Katman → level
  const katmanAdi = (p) => {
    const ham = objeKatmani(p.ozellikler)
    return ham === undefined ? VARSAYILAN_KATMANLAR[p.tip] : String(ham).trim()
  }
  const adlar = [...new Set(parcalar.map(katmanAdi))]
  const levelHaritasi = katmanNumaralari(adlar, { min: 1, maks: 99999999 })
  const eslemeMetni = eslemeUyarisi(levelHaritasi.eslemeler, 'IGES level')
  if (eslemeMetni) uyarilar.push(eslemeMetni)

  // Varlıklar: { tip, form, parametreler, level, etiket, altNo }
  const varliklar = []
  let azamiKoordinat = 0
  const k3 = (k) => {
    const z = zVar(k) ? k[2] : 0
    azamiKoordinat = Math.max(azamiKoordinat, Math.abs(k[0]), Math.abs(k[1]), Math.abs(z))
    return [igesSayi(k[0]), igesSayi(k[1]), igesSayi(z)]
  }
  const altNumaralar = new Map()
  for (const p of parcalar) {
    const level = levelHaritasi.numara(katmanAdi(p))
    const etiket = igesAscii(objeAdi(p.ozellikler, p.objeIndeks)).replace(/\s+/g, '_').slice(0, 8)
    const egriler = p.tip === 'cizgi' ? [p.konumlar] : p.tip === 'poligon' ? p.halkalar.map((h) => [...h, h[0]]) : []
    const ekle = (tip, form, parametreler) => {
      const altNo = (altNumaralar.get(p.objeIndeks) ?? 0) + 1
      altNumaralar.set(p.objeIndeks, altNo)
      varliklar.push({ tip, form, parametreler, level, etiket, altNo })
    }
    if (p.tip === 'nokta') ekle(116, 0, [116, ...k3(p.konum), 0])
    for (const e of egriler) ekle(106, 12, [106, 2, e.length, ...e.flatMap(k3)])
  }

  // P ve D bölümleri
  const dSatirlari = []
  const pSatirlari = []
  varliklar.forEach((v, i) => {
    const dSira = i * 2 + 1
    const pBaslangic = pSatirlari.length + 1
    const pVeri = paketle(belirtecler(v.parametreler), 64)
    for (const s of pVeri) {
      const sira = pSatirlari.length + 1
      pSatirlari.push(`${s.padEnd(64, ' ')} ${sagaYasla(dSira, 7)}P${sagaYasla(sira, 7)}`)
    }
    const alanlar1 = [v.tip, pBaslangic, 0, 0, v.level, 0, 0, 0, '00000000']
    const alanlar2 = [v.tip, 0, 0, pVeri.length, v.form, '', '', v.etiket, v.altNo]
    dSatirlari.push(kayit(alanlar1.map((a) => sagaYasla(a, 8)).join(''), 'D', dSira))
    dSatirlari.push(kayit(alanlar2.map((a) => sagaYasla(a, 8)).join(''), 'D', dSira + 1))
  })

  // S ve G bölümleri
  const zaman = zamanAl(ayarlar.zaman)
  const iki = (n) => String(n).padStart(2, '0')
  const tarih = `${zaman.getUTCFullYear()}${iki(zaman.getUTCMonth() + 1)}${iki(zaman.getUTCDate())}.${iki(zaman.getUTCHours())}${iki(zaman.getUTCMinutes())}${iki(zaman.getUTCSeconds())}`
  const sSatirlari = ['GeoConverterProEA - CBS geometrisinin IGES tel kafes aktarimi'].map((s, i) => kayit(s, 'S', i + 1))
  const global = [
    '1H,', '1H;',
    hollerith('GeoConverterProEA'), // 3 gönderen ürün kimliği
    hollerith(ayarlar.dosyaAdi || 'cikti.igs'), // 4 dosya adı
    hollerith('GeoConverterProEA'), // 5 yerel sistem
    hollerith('GeoConverterProEA IGES 1.0'), // 6 ön işlemci sürümü
    32, 38, 6, 308, 15, // 7–11 tamsayı bit sayısı, tek/çift hassasiyet büyüklükleri
    hollerith('GeoConverterProEA'), // 12 alıcı ürün kimliği
    '1.0', // 13 model uzayı ölçeği
    6, hollerith('M'), // 14–15 birim: metre
    1, '0.001', // 16–17 çizgi kalınlığı kademe sayısı / en büyük kalınlık
    hollerith(tarih), // 18 dosya oluşturma tarihi
    '0.000001', // 19 en küçük çözünürlük
    igesSayi(azamiKoordinat), // 20 en büyük koordinat değeri
    hollerith('GeoConverterProEA'), '', // 21–22 yazar / kurum
    11, 0, // 23 IGES 5.3, 24 çizim standardı yok
    hollerith(tarih), // 25 model oluşturma tarihi
  ].map(String)
  const gSatirlari = paketle(belirtecler(global), 72).map((s, i) => kayit(s, 'G', i + 1))

  const t = `S${sagaYasla(sSatirlari.length, 7)}G${sagaYasla(gSatirlari.length, 7)}D${sagaYasla(dSatirlari.length, 7)}P${sagaYasla(pSatirlari.length, 7)}`
  const tumu = [...sSatirlari, ...gSatirlari, ...dSatirlari, ...pSatirlari, kayit(t, 'T', 1)]
  const metin = tumu.join(satirSonu) + satirSonu
  return { veri: metin, onizleme: metin, uyarilar }
}
