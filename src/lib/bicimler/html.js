// HTML harita yazıcısı: Leaflet 1.9.4 + OSM altlıkla tek başına açılabilen bir sayfa.
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
// Sayfaya gömülen veri yalnızca type="application/json" bloğunda, < > & U+2028 U+2029
// kaçışlı JSON olarak durur; sayfa betiği sabittir ve veriyi JSON.parse + textContent ile işler.
import { istatistikHesapla } from '../geometri.js';
import { KOORDINAT_SISTEMLERI } from '../katalog.js';

export const VARSAYILAN_HARITA_BASLIGI = 'GeoConverterProEA Haritası';
const ONIZLEME_KARAKTER = 200000;

/** cdnjs Leaflet 1.9.4 dosyaları ve SRI (sha512) değerleri — npm dist ile doğrulandı. */
export const LEAFLET = Object.freeze({
  surum: '1.9.4',
  css: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css',
  cssSri: 'sha512-Zcn6bjR/8RZbLEpLIeOwNtzREBAJnUKESxces60Mpoj+2okopSAcSUIUOseddDm0cxnGQzxIR7vJgsLZbdLE3w==',
  js: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js',
  jsSri: 'sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg==',
});

const WGS84_KODLARI = new Set(['EPSG:4326', '4326', 'CRS:84', 'OGC:CRS84', 'URN:OGC:DEF:CRS:EPSG::4326', 'URN:OGC:DEF:CRS:OGC:1.3:CRS84']);

export const wgs84Mu = (crs) => crs == null || crs === '' || WGS84_KODLARI.has(String(crs).trim().toUpperCase());

// U+2028 / U+2029 satır ayırıcıları (kaynakta ham karakter bulunmasın diye kod noktasından).
const SATIR_AYIRICILAR_DESENI = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const KACIS_ONEKI = '\\u';

/** HTML metin/öznitelik kaçışı. */
export function htmlKacis(metin) {
  return String(metin)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON'u <script type="application/json"> içine güvenle gömer: < > & ve U+2028/U+2029
 * \\uXXXX kaçışlarıyla yazılır; böylece </script>, <!-- gibi diziler bloğu kıramaz.
 */
export function guvenliJson(deger) {
  return JSON.stringify(deger)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(SATIR_AYIRICILAR_DESENI, (k) => KACIS_ONEKI + k.charCodeAt(0).toString(16));
}

function crsAdi(crs) {
  if (crs == null || crs === '') return null;
  const kod = String(crs).trim();
  const tanim = KOORDINAT_SISTEMLERI.find((s) => s.kod.toUpperCase() === kod.toUpperCase());
  return tanim ? tanim.ad : kod;
}

function fcDenetle(fc, ad) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error(`${ad} geçerli bir GeoJSON FeatureCollection değil.`);
  }
}

const geometriVar = (f) => f && typeof f === 'object' && f.geometry != null && typeof f.geometry === 'object';

/**
 * Altlık haritalar. İlki varsayılandır. CARTO ve Esri döşemeleri Referer istemez; böylece
 * file:// ile (çift tıklayarak) açılan sayfada da altlık görünür. OSM standart altlığı
 * Referer olmadan engellenebilir, bu yüzden varsayılan değildir.
 * `alanAdlari`: CSP img-src listesine giren ana makineler (testle URL'lerle eşleştirilir).
 */
export const ALTLIKLAR = Object.freeze([
  Object.freeze({
    ad: 'CARTO Voyager',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    secenekler: {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıcıları &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
    alanAdlari: ['https://a.basemaps.cartocdn.com', 'https://b.basemaps.cartocdn.com', 'https://c.basemaps.cartocdn.com', 'https://d.basemaps.cartocdn.com'],
  }),
  Object.freeze({
    ad: 'Esri Uydu Görüntüsü',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    secenekler: {
      maxZoom: 19,
      attribution:
        'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
    alanAdlari: ['https://server.arcgisonline.com'],
  }),
  Object.freeze({
    ad: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    secenekler: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıcıları',
    },
    alanAdlari: ['https://tile.openstreetmap.org'],
  }),
]);

/** Gömülen GeoJSON bu boyutu (bayt) aşarsa uyarı verilir; sert sınır yoktur. */
export const BUYUK_VERI_ESIGI = 20 * 1024 * 1024;

// Sayfa betiği SABİTTİR (kullanıcı verisi içermez; altlık listesi modülün sabitidir);
// CSP'de sha256 özetiyle izin verilir.
const SAYFA_BETIGI = `(function () {
  'use strict';
  var ayar = JSON.parse(document.getElementById('gc-ayar').textContent);
  var veri = JSON.parse(document.getElementById('gc-veri').textContent);
  var ALTLIKLAR = ${JSON.stringify(ALTLIKLAR.map(({ ad, url, secenekler }) => ({ ad, url, secenekler })))};
  // Çizgi/poligonlar varsayılan kaplama bölmesinde (canvas, z 400); noktalar üstteki ayrı
  // bölmede (SVG, z 650) çizilir; böylece poligonun içindeki nokta da tıklanabilir.
  var harita = L.map('harita', { preferCanvas: true });
  harita.createPane('noktalar').style.zIndex = 650;
  var noktaCizici = L.svg({ pane: 'noktalar' });
  var altliklar = {};
  ALTLIKLAR.forEach(function (a, i) {
    var k = L.tileLayer(a.url, a.secenekler);
    altliklar[a.ad] = k;
    if (i === 0) k.addTo(harita);
  });
  L.control.layers(altliklar, null, { collapsed: true }).addTo(harita);
  function metin(d) {
    if (d === null || d === undefined) return '';
    if (typeof d === 'object') return JSON.stringify(d);
    return String(d);
  }
  function pencere(f) {
    var kap = document.createElement('div');
    kap.className = 'gc-pencere';
    var p = f && f.properties && typeof f.properties === 'object' ? f.properties : {};
    var anahtarlar = Object.keys(p);
    if (!anahtarlar.length) {
      var bos = document.createElement('em');
      bos.textContent = 'Öznitelik yok';
      kap.appendChild(bos);
      return kap;
    }
    var tablo = document.createElement('table');
    anahtarlar.forEach(function (k) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.textContent = k;
      var td = document.createElement('td');
      td.textContent = metin(p[k]);
      tr.appendChild(th);
      tr.appendChild(td);
      tablo.appendChild(tr);
    });
    kap.appendChild(tablo);
    return kap;
  }
  var katman = null;
  if (ayar.ciz) {
    katman = L.geoJSON(veri, {
      style: function () { return { color: '#d6336c', weight: 2, fillOpacity: 0.25 }; },
      pointToLayer: function (f, ll) {
        return L.circleMarker(ll, { pane: 'noktalar', renderer: noktaCizici, radius: 6, color: '#ffffff', weight: 1.5, fillColor: '#d6336c', fillOpacity: 0.9 });
      },
      onEachFeature: function (f, l) { l.bindPopup(function () { return pencere(f); }, { maxWidth: 420 }); }
    }).addTo(harita);
  }
  var sinir = katman ? katman.getBounds() : null;
  if (sinir && sinir.isValid()) harita.fitBounds(sinir, { padding: [24, 24], maxZoom: 18 });
  else harita.setView([39, 35], 6);
})();`;

async function sha256Base64(metin) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return null;
  const ozet = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(metin)));
  let ikili = '';
  for (const b of ozet) ikili += String.fromCharCode(b);
  return btoa(ikili);
}

const STIL = `
:root { color-scheme: light dark; --zemin: #ffffff; --yazi: #1d2433; --ikincil: #5b6475; --kenar: #d9dde5; --uyari-zemin: #fff4d6; --uyari-yazi: #6b4a00; }
@media (prefers-color-scheme: dark) {
  :root { --zemin: #161a22; --yazi: #e7eaf0; --ikincil: #a3abba; --kenar: #2c3340; --uyari-zemin: #3d3110; --uyari-yazi: #ffd98a; }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--zemin); color: var(--yazi); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
body { display: flex; flex-direction: column; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; padding: 8px 16px; border-bottom: 1px solid var(--kenar); }
header h1 { margin: 0; font-size: 16px; font-weight: 600; }
header span { color: var(--ikincil); font-size: 13px; }
.gc-uyari { margin: 0; padding: 8px 16px; background: var(--uyari-zemin); color: var(--uyari-yazi); border-bottom: 1px solid var(--kenar); }
#harita { flex: 1; min-height: 300px; }
.gc-pencere table { border-collapse: collapse; font-size: 12px; }
.gc-pencere th, .gc-pencere td { text-align: left; vertical-align: top; padding: 2px 6px; border-bottom: 1px solid #e3e6ec; overflow-wrap: anywhere; white-space: pre-wrap; }
.gc-pencere th { font-weight: 600; color: #444; }
`;

/**
 * GeoJSON FeatureCollection → tek başına açılabilen Leaflet HTML sayfası.
 * secenekler.crs: verinin EPSG kodu (opsiyonel).
 * secenekler.haritaGeojson: verinin WGS84 kopyası (crs 4326 değilse haritada bu kullanılır).
 * secenekler.baslik: sayfa başlığı (varsayılan 'GeoConverterProEA Haritası').
 */
export async function htmlYaz(fc, secenekler = {}) {
  fcDenetle(fc, 'Yazılacak veri');
  const uyarilar = [];
  const baslik =
    typeof secenekler.baslik === 'string' && secenekler.baslik.trim() ? secenekler.baslik.trim() : VARSAYILAN_HARITA_BASLIGI;
  const crs = secenekler.crs;
  const bantlar = [];

  let haritaVerisi = fc;
  let ciz = true;
  if (secenekler.haritaGeojson != null) {
    fcDenetle(secenekler.haritaGeojson, 'haritaGeojson');
    haritaVerisi = secenekler.haritaGeojson;
  } else if (!wgs84Mu(crs)) {
    const bbox = istatistikHesapla(fc).bbox;
    const dereceAraliginda = !bbox || (bbox[0] >= -180 && bbox[2] <= 180 && bbox[1] >= -90 && bbox[3] <= 90);
    ciz = dereceAraliginda;
    const mesaj = ciz
      ? `Veri ${crsAdi(crs)} koordinat sisteminde; harita yalnızca WGS84 (EPSG:4326) gösterebildiği için konumlar hatalı görünebilir.`
      : `Veri ${crsAdi(crs)} koordinat sisteminde; harita yalnızca WGS84 (EPSG:4326) gösterebildiği için objeler haritaya çizilmedi.`;
    bantlar.push(mesaj);
    uyarilar.push(mesaj);
  }

  const cizilecek = haritaVerisi.features.filter(geometriVar);
  const geometrisiz = haritaVerisi.features.length - cizilecek.length;
  if (geometrisiz > 0) {
    const mesaj = `${geometrisiz} obje geometrisiz olduğu için haritada gösterilmedi.`;
    bantlar.push(mesaj);
    uyarilar.push(mesaj);
  }
  const gomulu = { type: 'FeatureCollection', features: cizilecek };
  const ayar = { ciz };
  const gomuluMetin = guvenliJson(gomulu);
  const gomuluBayt = new TextEncoder().encode(gomuluMetin).length;
  if (gomuluBayt > BUYUK_VERI_ESIGI) {
    uyarilar.push(
      `Haritaya gömülen veri ${(gomuluBayt / 1024 / 1024).toFixed(1)} MB; 20 MB'ı aştığı için sayfa tarayıcıda yavaş açılabilir.`,
    );
  }

  const betikOzeti = await sha256Base64(SAYFA_BETIGI);
  if (!betikOzeti) {
    uyarilar.push(
      'Bu ortamda Web Crypto (crypto.subtle) bulunmadığı için sayfaya içerik güvenlik politikası (CSP) eklenemedi.',
    );
  }
  const csp = betikOzeti
    ? [
        "default-src 'none'",
        `script-src https://cdnjs.cloudflare.com 'sha256-${betikOzeti}'`,
        "style-src https://cdnjs.cloudflare.com 'unsafe-inline'",
        // cdnjs: Leaflet CSS'inin katman seçici simgesi (images/layers.png).
        `img-src ${ALTLIKLAR.flatMap((a) => a.alanAdlari).join(' ')} https://cdnjs.cloudflare.com data:`,
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ')
    : null;

  const altBilgi = [`${fc.features.length} obje`];
  if (crs) altBilgi.push(crsAdi(crs));

  const veri = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` : ''}<meta name="generator" content="GeoConverterProEA">
<title>${htmlKacis(baslik)}</title>
<link rel="stylesheet" href="${LEAFLET.css}" integrity="${LEAFLET.cssSri}" crossorigin="anonymous" referrerpolicy="no-referrer">
<style>${STIL}</style>
</head>
<body>
<header><h1>${htmlKacis(baslik)}</h1><span>${htmlKacis(altBilgi.join(' · '))}</span></header>
${bantlar.map((b) => `<p class="gc-uyari" role="alert">${htmlKacis(b)}</p>`).join('\n')}
<div id="harita" role="application" aria-label="Harita"></div>
<script type="application/json" id="gc-ayar">${guvenliJson(ayar)}</script>
<script type="application/json" id="gc-veri">${gomuluMetin}</script>
<script src="${LEAFLET.js}" integrity="${LEAFLET.jsSri}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>${SAYFA_BETIGI}</script>
</body>
</html>
`;
  const onizleme =
    veri.length > ONIZLEME_KARAKTER
      ? `${veri.slice(0, ONIZLEME_KARAKTER)}\n… ${veri.length - ONIZLEME_KARAKTER} karakter daha`
      : veri;
  return { veri, onizleme, uyarilar };
}

export { SAYFA_BETIGI as _SAYFA_BETIGI };
