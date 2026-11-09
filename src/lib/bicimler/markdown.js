// Markdown yazıcısı: özet + GitHub Flavored Markdown öznitelik tablosu.
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
import wellknown from 'wellknown';

import { geometriKonumlariniGez, istatistikHesapla } from '../geometri.js';
import { KOORDINAT_SISTEMLERI } from '../katalog.js';

export const VARSAYILAN_MD_BASLIGI = 'GeoConverterProEA Öznitelik Tablosu';
const VARSAYILAN_EN_FAZLA_SATIR = 1000;
const WKT_EN_FAZLA_KARAKTER = 80;

const HARF_RAKAM = /[\p{L}\p{N}]/u;

/** _ yalnızca kelime sınırındaysa (iki yanı birden harf/rakam değilse) kaçırılır. */
function altCizgiKacis(metin) {
  return metin.replace(/_/g, (k, i, s) =>
    HARF_RAKAM.test(s[i - 1] ?? '') && HARF_RAKAM.test(s[i + 1] ?? '') ? k : '\\_',
  );
}

/**
 * Tablo hücresi kaçışı (GFM), okunabilirliği bozmadan yalnızca gerekli olanlar:
 * - \ ` | [ ] → ters eğik çizgiyle (tablo bozulmaz, kod/bağlantı oluşmaz);
 * - < > & → HTML varlığı (ham HTML/betik oluşmaz);
 * - * ve ~ → her zaman (GFM'de kelime içinde de vurgu/üstü çizili üretebilirler);
 * - _ → yalnızca kelime sınırında (GFM'de kelime içi _ vurgu üretmez: il_kodu aynen kalır);
 * - satır başındaki # + - ve "1." (ardından boşluk varsa) → kaçışlı; > zaten &gt; olur;
 * - satır sonu → <br>; null/undefined → boş.
 */
export function mdHucre(deger) {
  if (deger === null || deger === undefined) return '';
  const metin = typeof deger === 'object' ? JSON.stringify(deger) : String(deger);
  return altCizgiKacis(
    metin
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/[\\`*~[\]|]/g, (k) => `\\${k}`)
      // Blok işaretleri ancak ardından boşluk/satır sonu gelirse etkilidir: "-5", "#1" dokunulmaz.
      .replace(/^([ \t]*)(#{1,6}|[+-])(?=[ \t]|$)/gm, '$1\\$2')
      .replace(/^([ \t]*\d{1,9})([.)])(?=[ \t]|$)/gm, '$1\\$2'),
  )
    .replace(/\r\n|\r|\n|[\u2028\u2029]/g, '<br>')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\t/g, ' ');
}

function crsMetni(crs) {
  if (crs == null || crs === '') return 'belirtilmedi';
  const kod = String(crs).trim();
  const tanim = KOORDINAT_SISTEMLERI.find((s) => s.kod.toUpperCase() === kod.toUpperCase());
  return tanim ? tanim.ad : kod;
}

function koseSayisi(g) {
  let n = 0;
  geometriKonumlariniGez(g, () => {
    n++;
  });
  return n;
}

function geometriHucresi(g, wktSutunu) {
  if (g == null || typeof g !== 'object') return '(yok)';
  if (wktSutunu) {
    const wkt = wellknown.stringify(g) || g.type;
    const kisa = wkt.length > WKT_EN_FAZLA_KARAKTER ? `${wkt.slice(0, WKT_EN_FAZLA_KARAKTER)}…` : wkt;
    return mdHucre(kisa);
  }
  const n = koseSayisi(g);
  return mdHucre(`${g.type} (${n} köşe)`);
}

const satir = (hucreler) => `| ${hucreler.join(' | ')} |`;

/**
 * GeoJSON FeatureCollection → GFM Markdown.
 * secenekler.crs: hedef EPSG kodu (özet için, opsiyonel).
 * secenekler.wktSutunu: true → Geometri sütununda kısaltılmış WKT.
 * secenekler.enFazlaSatir: tablo satır sınırı (varsayılan 1000).
 * secenekler.baslik: belge başlığı.
 */
export async function markdownYaz(fc, secenekler = {}) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.');
  }
  const uyarilar = [];
  const objeler = fc.features.filter((f) => f && typeof f === 'object');
  const enFazla =
    Number.isInteger(secenekler.enFazlaSatir) && secenekler.enFazlaSatir > 0
      ? secenekler.enFazlaSatir
      : VARSAYILAN_EN_FAZLA_SATIR;
  const baslik =
    typeof secenekler.baslik === 'string' && secenekler.baslik.trim() ? secenekler.baslik.trim() : VARSAYILAN_MD_BASLIGI;

  const ist = istatistikHesapla({ type: 'FeatureCollection', features: objeler });
  const geometrisiz = objeler.filter((f) => f.geometry == null).length;
  const tipler = Object.entries(ist.geometriTipleri).map(([t, n]) => `${t}: ${n}`);
  if (geometrisiz) tipler.push(`Geometrisiz: ${geometrisiz}`);

  const parcalar = [`# ${mdHucre(baslik)}`, '', '## Özet', ''];
  parcalar.push(`- **Obje sayısı:** ${objeler.length}`);
  parcalar.push(`- **Geometri tipleri:** ${tipler.length ? tipler.join(', ') : '—'}`);
  parcalar.push(`- **Koordinat sistemi:** ${mdHucre(crsMetni(secenekler.crs))}`);
  parcalar.push(
    `- **Sınır kutusu:** ${ist.bbox ? `X ${ist.bbox[0]} … ${ist.bbox[2]}, Y ${ist.bbox[1]} … ${ist.bbox[3]}` : '—'}`,
  );
  parcalar.push('', '## Öznitelikler', '');

  if (!objeler.length) {
    parcalar.push('_Tabloda gösterilecek obje yok._');
    uyarilar.push('Veri boş; Markdown tablosu satır içermiyor.');
  } else {
    const sutunlar = [];
    const gorulen = new Set();
    for (const f of objeler) {
      const p = f.properties && typeof f.properties === 'object' ? f.properties : {};
      for (const k of Object.keys(p)) {
        if (!gorulen.has(k)) {
          gorulen.add(k);
          sutunlar.push(k);
        }
      }
    }
    parcalar.push(satir(['#', 'Geometri', ...sutunlar.map(mdHucre)]));
    parcalar.push(satir(['---:', '---', ...sutunlar.map(() => '---')]));
    const gosterilen = objeler.slice(0, enFazla);
    gosterilen.forEach((f, i) => {
      const p = f.properties && typeof f.properties === 'object' ? f.properties : {};
      parcalar.push(satir([String(i + 1), geometriHucresi(f.geometry, secenekler.wktSutunu === true), ...sutunlar.map((k) => mdHucre(p[k]))]));
    });
    if (objeler.length > enFazla) {
      const kalan = objeler.length - enFazla;
      const not = `Tablo ${enFazla} satırla sınırlandı; kalan ${kalan} obje gösterilmedi (toplam ${objeler.length}).`;
      parcalar.push('', `> **Not:** ${not}`);
      uyarilar.push(not);
    }
  }

  const veri = `${parcalar.join('\n')}\n`;
  return { veri, onizleme: veri, uyarilar };
}
