/**
 * Netcad / TKGM uyumlu GML yazıcısı.
 *
 * Python arka ucundaki `NetcadGMLYazici` (cografi_donusturucu.py) ile aynı yapıyı üretir; böylece
 * web ve masaüstü çıktısı Netcad'de aynı şekilde açılır:
 *
 *   <TKGM:FeatureCollection xmlns:TKGM="http://www.tkgm.gov.tr" xmlns:gml="http://www.opengis.net/gml">
 *     <TKGM:FeatureMember>
 *       <TKGM:Parsel>   (Netcad bu obje tipini TK_PARSEL katmanına alır; TKGM parsel GML'iyle aynı)
 *         <TKGM:id>…</TKGM:id> <TKGM:ad>ada/parsel</TKGM:ad>
 *         <TKGM:aciklama/> <TKGM:megsisId>0</TKGM:megsisId> <TKGM:onayDurum/> <TKGM:takbisId>0</TKGM:takbisId>
 *         <TKGM:tabaka>TK_PARSEL_abc</TKGM:tabaka>
 *         <TKGM:{öznitelik}>…</TKGM:{öznitelik}> …
 *         <TKGM:geom> gml:Polygon | gml:MultiPolygon (GML 2: outer/innerBoundaryIs, "x,y x,y") </TKGM:geom>
 *
 * Kurallar (Python ile aynı):
 *  - Yalnızca Polygon / MultiPolygon yazılır (GeometryCollection içindekiler de alınır).
 *  - `id` özniteliği yoksa her poligon parçası ayrı obje olur (id = 0, 1, 2 …).
 *  - `id` varsa aynı id'li poligonlar tek objede toplanır (tek parça → Polygon, çok → MultiPolygon);
 *    objeler id'ye göre sıralanır, diğer öznitelikler grubun ilk kaydından alınır.
 *    (Python bu durumda parçaları geometrik olarak birleştirir/dissolve eder; burada birleştirme
 *    yapılmaz, parçalar MultiPolygon üyesi olarak korunur.)
 *  - `ad` = ilcead (boş değilse), yoksa id.
 *  - Öznitelik adları geçerli XML adına çevrilir; null/NaN değerler yazılmaz; Z değerleri yazılmaz.
 */

const TKGM_NS = 'http://www.tkgm.gov.tr'
const GML_NS = 'http://www.opengis.net/gml'
const SABIT_ALANLAR = new Set(['geometry', 'ad', 'id', 'group_id', 'ilcead', 'geom', 'tabaka'])

/** TKGM parsel GML'indeki standart alanlar ve veride yoksa yazılacak varsayılanları (sırası önemli). */
export const TKGM_PARSEL_ALANLARI = Object.freeze([
  ['aciklama', ''],
  ['megsisId', '0'],
  ['onayDurum', ''],
  ['takbisId', '0'],
])

/** XML eleman satırı; boş değer TKGM örneğindeki gibi kendini kapatan eleman olarak yazılır. */
const elemanSatiri = (girinti, ad, deger) =>
  deger === '' ? `${girinti}<TKGM:${ad}/>` : `${girinti}<TKGM:${ad}>${xmlKacis(deger)}</TKGM:${ad}>`

// ---------------------------------------------------------------------------
// TKGM adlandırma (Kadastro Dairesi Başkanlığı, GML Converter 7.2 Güncelleme Notları)
//  - Parsel adı: "ada/parsel" (ör. 5494/14)
//  - Tabaka: TK_PARSEL_abc — abc, Tapu Planlarında Yanılma Sınırı Yönetmeliği Madde 9'daki
//    nokta konum doğruluğunun noktasız/virgülsüz yazımı: 0,21 → 021, 0,09 → 009, 1 → 100,
//    1,75 → 175. Doğruluk bilinmiyorsa "TK_PARSEL".
// ---------------------------------------------------------------------------

const KATLAMA = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' }
/** Sütun adını karşılaştırma için sadeleştirir: "Ada No" → "adano", "Nokta_Konum_Doğruluğu" → "noktakonumdogrulugu". */
const sutunAnahtari = (ad) =>
  String(ad).toLocaleLowerCase('tr').replace(/[çğıöşü]/g, (h) => KATLAMA[h]).replace(/[^a-z0-9]/g, '')

const ADA_SUTUNLARI = ['ada', 'adano', 'adanumarasi', 'adanum', 'adaadi']
const PARSEL_SUTUNLARI = ['parsel', 'parselno', 'parselnumarasi', 'parselnum', 'parseladi']
const ADA_PARSEL_SUTUNLARI = ['adaparsel', 'adaparselno', 'parseladi', 'adi']
const NKD_SUTUNLARI = ['nkd', 'noktakonumdogrulugu', 'konumdogrulugu', 'noktakonumdogruluk', 'nktkonumdogrulugu']
const TABAKA_SUTUNLARI = ['tabaka', 'katman', 'layer', 'tabakaadi']
const TABAKA_DESENI = /^TK_PARSEL(?:_\d{3})?$/i

// "Açıklama", "MEGSIS_ID" gibi yazımlar da standart alana sayılır; ek öznitelik olarak tekrar yazılmaz.
const STANDART_ANAHTARLAR = new Set(TKGM_PARSEL_ALANLARI.map(([alan]) => sutunAnahtari(alan)))
const standartAlanMi = (ad) => SABIT_ALANLAR.has(String(ad).toLowerCase()) || STANDART_ANAHTARLAR.has(sutunAnahtari(ad))

/** Özellik nesnesinde aday adlardan ilk bulunanın değerini döndürür. */
function sutunDegeri(ozellikler, adaylar) {
  const harita = new Map(Object.keys(ozellikler).map((k) => [sutunAnahtari(k), k]))
  for (const aday of adaylar) {
    const gercek = harita.get(aday)
    if (gercek !== undefined && !bosMu(ozellikler[gercek]) && String(ozellikler[gercek]).trim() !== '') {
      return ozellikler[gercek]
    }
  }
  return undefined
}

/** "14", 14, "14.0" → "14"; diğer metinler olduğu gibi (kırpılmış). */
function numaraMetni(deger) {
  const metin = String(deger).trim()
  return /^-?\d+\.0+$/.test(metin) ? metin.replace(/\.0+$/, '') : metin
}

/**
 * Nokta konum doğruluğundan TKGM tabaka adı üretir.
 * @param {number|string|null|undefined} dogruluk metre; "0,21" de kabul edilir
 * @returns {string|null} ör. "TK_PARSEL_021"; geçersizse null
 */
export function tabakaAdi(dogruluk) {
  if (bosMu(dogruluk) || String(dogruluk).trim() === '') return null
  const sayi = Number(String(dogruluk).trim().replace(',', '.'))
  if (!Number.isFinite(sayi)) return null
  const kod = Math.round(sayi * 100)
  if (kod < 1 || kod > 999) return null
  return `TK_PARSEL_${String(kod).padStart(3, '0')}`
}

/** Objenin TKGM parsel adı ("ada/parsel") — bulunamazsa null. */
export function adaParselAdi(ozellikler) {
  const ada = sutunDegeri(ozellikler, ADA_SUTUNLARI)
  const parsel = sutunDegeri(ozellikler, PARSEL_SUTUNLARI)
  if (ada !== undefined && parsel !== undefined) return `${numaraMetni(ada)}/${numaraMetni(parsel)}`
  const birlesik = sutunDegeri(ozellikler, ADA_PARSEL_SUTUNLARI)
  if (birlesik !== undefined && /^\s*\d+\s*\/\s*\d+\s*$/.test(String(birlesik))) return String(birlesik).replace(/\s+/g, '')
  return null
}

/**
 * Objenin TKGM tabaka adı. Öncelik: verideki geçerli tabaka değeri → verideki nokta konum
 * doğruluğu → varsayılan doğruluk → "TK_PARSEL".
 * @returns {{ tabaka: string, kaynak: 'veri' | 'nkd' | 'varsayilan' | 'yok' }}
 */
export function objeTabakasi(ozellikler, varsayilanDogruluk) {
  const mevcut = sutunDegeri(ozellikler, TABAKA_SUTUNLARI)
  if (mevcut !== undefined && TABAKA_DESENI.test(String(mevcut).trim())) {
    return { tabaka: String(mevcut).trim().toUpperCase(), kaynak: 'veri' }
  }
  const nkd = tabakaAdi(sutunDegeri(ozellikler, NKD_SUTUNLARI))
  if (nkd) return { tabaka: nkd, kaynak: 'nkd' }
  const varsayilan = tabakaAdi(varsayilanDogruluk)
  if (varsayilan) return { tabaka: varsayilan, kaynak: 'varsayilan' }
  return { tabaka: 'TK_PARSEL', kaynak: 'yok' }
}

function xmlKacis(metin) {
  return String(metin)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

/**
 * Öznitelik adını geçerli XML element adına çevirir (Python `gecerli_xml_adi` ile aynı kural):
 * Unicode harf/rakam, '_', '-', '.' korunur, diğerleri '_' olur; harf veya '_' ile başlamayan
 * ya da 'xml' ile başlayan adların başına '_' eklenir; çakışmalara _2, _3 … eklenir.
 */
export function gecerliXmlAdi(ad, kullanilanlar) {
  let temiz = String(ad).trim().normalize('NFC').replace(/[^\p{L}\p{N}_.-]/gu, '_').replace(/_+/g, '_')
  if (!temiz) temiz = 'alan'
  if (!/^[\p{L}_]/u.test(temiz) || temiz.toLowerCase().startsWith('xml')) temiz = `_${temiz}`
  if (kullanilanlar) {
    let aday = temiz
    for (let n = 2; kullanilanlar.has(aday); n++) aday = `${temiz}_${n}`
    kullanilanlar.add(aday)
    temiz = aday
  }
  return temiz
}

const bosMu = (d) => d === null || d === undefined || (typeof d === 'number' && Number.isNaN(d))

function degerMetni(d) {
  if (typeof d === 'object') return JSON.stringify(d)
  return String(d)
}

/** Geometriden poligonları (her biri halkalar dizisi) toplar; poligon olmayan parça sayısını döndürür. */
function poligonlariTopla(g, hedef) {
  if (!g) return 0
  switch (g.type) {
    case 'Polygon':
      if (Array.isArray(g.coordinates) && g.coordinates.length) hedef.push(g.coordinates)
      return 0
    case 'MultiPolygon':
      for (const p of g.coordinates || []) if (Array.isArray(p) && p.length) hedef.push(p)
      return 0
    case 'GeometryCollection':
      return (g.geometries || []).reduce((n, alt) => n + poligonlariTopla(alt, hedef), 0)
    default:
      return 1
  }
}

const halkaMetni = (halka) => halka.map((k) => `${k[0]},${k[1]}`).join(' ')

function poligonXml(halkalar, girinti) {
  const g = (n) => '  '.repeat(girinti + n)
  const satirlar = [`${g(0)}<gml:Polygon>`]
  halkalar.forEach((halka, i) => {
    const sinir = i === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs'
    satirlar.push(
      `${g(1)}<gml:${sinir}>`,
      `${g(2)}<gml:LinearRing>`,
      `${g(3)}<gml:coordinates>${halkaMetni(halka)}</gml:coordinates>`,
      `${g(2)}</gml:LinearRing>`,
      `${g(1)}</gml:${sinir}>`,
    )
  })
  satirlar.push(`${g(0)}</gml:Polygon>`)
  return satirlar
}

/** Değerleri doğal sıraya göre (sayısal kimlikler sayı gibi) sıralar. */
const kimlikKarsilastir = (a, b) => String(a).localeCompare(String(b), 'tr', { numeric: true })

/**
 * @param {object} fc GeoJSON FeatureCollection
 * @returns {{ metin: string, uyarilar: string[], objeSayisi: number }}
 */
export function netcadGmlYaz(fc, secenekler = {}) {
  const varsayilanDogruluk = secenekler.noktaKonumDogrulugu ?? null
  if (!bosMu(varsayilanDogruluk) && String(varsayilanDogruluk).trim() !== '' && !tabakaAdi(varsayilanDogruluk)) {
    throw new Error(`Nokta konum doğruluğu geçersiz: "${varsayilanDogruluk}". 0,01 ile 9,99 m arasında bir değer girin (ör. 0,21).`)
  }
  const features = (fc.features || []).filter((f) => f && typeof f === 'object')
  const uyarilar = []
  let atlananGeometri = 0
  let geometrisiz = 0

  // 1) Poligon parçalarını topla
  const kayitlar = [] // { poligonlar, ozellikler }
  for (const f of features) {
    if (!f.geometry) {
      geometrisiz++
      continue
    }
    const poligonlar = []
    atlananGeometri += poligonlariTopla(f.geometry, poligonlar)
    if (poligonlar.length) kayitlar.push({ poligonlar, ozellikler: f.properties || {} })
  }

  // 2) Gruplama: id varsa id'ye göre, yoksa her poligon parçası ayrı obje
  const idVar = kayitlar.some((k) => !bosMu(k.ozellikler.id))
  const gruplar = new Map()
  if (idVar) {
    let idsiz = 0
    for (const k of kayitlar) {
      let id = k.ozellikler.id
      if (bosMu(id)) {
        id = `id_yok_${++idsiz}`
      }
      const anahtar = String(id)
      const grup = gruplar.get(anahtar) || { id, ozellikler: k.ozellikler, poligonlar: [] }
      grup.poligonlar.push(...k.poligonlar)
      gruplar.set(anahtar, grup)
    }
    if (idsiz) uyarilar.push(`${idsiz} objede "id" değeri boş; bu objelere geçici kimlik verildi.`)
  } else {
    let sira = 0
    for (const k of kayitlar) {
      for (const p of k.poligonlar) {
        gruplar.set(String(sira), { id: sira, ozellikler: k.ozellikler, poligonlar: [p] })
        sira++
      }
    }
  }
  const siraliGruplar = [...gruplar.values()]
  if (idVar) siraliGruplar.sort((a, b) => kimlikKarsilastir(a.id, b.id))

  // 3) Öznitelik adı → XML adı (bir kez, çakışmasız)
  const kullanilan = new Set(SABIT_ALANLAR)
  const xmlAdlari = new Map()
  for (const g of siraliGruplar) {
    for (const anahtar of Object.keys(g.ozellikler)) {
      if (xmlAdlari.has(anahtar) || standartAlanMi(anahtar)) continue
      xmlAdlari.set(anahtar, gecerliXmlAdi(anahtar, kullanilan))
    }
  }
  const duzeltilen = [...xmlAdlari].filter(([a, x]) => a !== x)
  if (duzeltilen.length) {
    uyarilar.push(
      `GML alan adları XML kurallarına göre düzeltildi: ${duzeltilen.slice(0, 5).map(([a, x]) => `"${a}" → "${x}"`).join(', ')}${duzeltilen.length > 5 ? ` ve ${duzeltilen.length - 5} alan daha` : ''}.`,
    )
  }

  // 4) XML
  const satirlar = [
    "<?xml version='1.0' encoding='UTF-8'?>",
    `<TKGM:FeatureCollection xmlns:TKGM="${TKGM_NS}" xmlns:gml="${GML_NS}">`,
  ]
  let adaParselsiz = 0
  let tabakasiz = 0
  const tabakaSayaci = new Map()
  for (const g of siraliGruplar) {
    const adaParsel = adaParselAdi(g.ozellikler)
    const ad = adaParsel ?? (bosMu(g.ozellikler.ilcead) || g.ozellikler.ilcead === '' ? g.id : g.ozellikler.ilcead)
    if (!adaParsel) adaParselsiz++
    const { tabaka, kaynak } = objeTabakasi(g.ozellikler, varsayilanDogruluk)
    tabakaSayaci.set(tabaka, (tabakaSayaci.get(tabaka) || 0) + 1)
    if (kaynak === 'yok') tabakasiz++
    satirlar.push(
      '  <TKGM:FeatureMember>',
      '    <TKGM:Parsel>',
      `      <TKGM:id>${xmlKacis(g.id)}</TKGM:id>`,
      `      <TKGM:ad>${xmlKacis(ad)}</TKGM:ad>`,
    )
    for (const [alan, varsayilan] of TKGM_PARSEL_ALANLARI) {
      const deger = sutunDegeri(g.ozellikler, [sutunAnahtari(alan)])
      satirlar.push(elemanSatiri('      ', alan, deger === undefined ? varsayilan : degerMetni(deger)))
    }
    satirlar.push(`      <TKGM:tabaka>${xmlKacis(tabaka)}</TKGM:tabaka>`)
    for (const [anahtar, xmlAdi] of xmlAdlari) {
      const deger = g.ozellikler[anahtar]
      if (bosMu(deger)) continue
      satirlar.push(`      <TKGM:${xmlAdi}>${xmlKacis(degerMetni(deger))}</TKGM:${xmlAdi}>`)
    }
    satirlar.push('      <TKGM:geom>')
    if (g.poligonlar.length === 1) {
      satirlar.push(...poligonXml(g.poligonlar[0], 4))
    } else {
      satirlar.push('        <gml:MultiPolygon>')
      for (const p of g.poligonlar) {
        satirlar.push('          <gml:polygonMember>', ...poligonXml(p, 6), '          </gml:polygonMember>')
      }
      satirlar.push('        </gml:MultiPolygon>')
    }
    satirlar.push('      </TKGM:geom>', '    </TKGM:Parsel>', '  </TKGM:FeatureMember>')
  }
  satirlar.push('</TKGM:FeatureCollection>', '')

  if (atlananGeometri) {
    uyarilar.push(
      `Netcad GML yalnızca poligon taşır: ${atlananGeometri} poligon olmayan geometri (nokta/çizgi) yazılmadı. Çizgileri dahil etmek için "Geometri tipi: Çizgi → Poligon" seçin.`,
    )
  }
  if (adaParselsiz) {
    uyarilar.push(
      `${adaParselsiz} objede ada/parsel bilgisi bulunamadı ("ada" ve "parsel" sütunları); ad olarak ilçe adı veya kimlik yazıldı.`,
    )
  }
  if (tabakasiz) {
    uyarilar.push(
      `${tabakasiz} objede nokta konum doğruluğu yok; tabaka "TK_PARSEL" yazıldı. Yanılma sınırı hesabı için "Nokta konum doğruluğu" değerini girin veya veride "nkd" sütunu kullanın.`,
    )
  }
  if (siraliGruplar.length) {
    const ozet = [...tabakaSayaci].sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `${t}: ${n}`).join(', ')
    uyarilar.push(`Tabakalar — ${ozet}.`)
  }
  if (geometrisiz) uyarilar.push(`${geometrisiz} geometrisiz obje yazılmadı.`)
  if (siraliGruplar.length === 0) {
    throw new Error(
      'GML çıktısı için poligon bulunamadı. Netcad GML yalnızca poligon taşır; çizgilerden poligon üretmek için "Geometri tipi: Çizgi → Poligon" seçin.',
    )
  }

  return { metin: satirlar.join('\n'), uyarilar, objeSayisi: siraliGruplar.length }
}
