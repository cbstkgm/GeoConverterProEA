import { memo, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, LayersControl, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';

const { BaseLayer } = LayersControl;

const BASLANGIC_MERKEZ = [39.93, 32.86];
const BASLANGIC_ZOOM = 6;

const ALTLIKLAR = [
  {
    ad: 'Uydu (Esri World Imagery)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Görüntü &copy; <a href="https://www.esri.com/">Esri</a> — Kaynak: Esri, Maxar, Earthstar Geographics ve GIS Kullanıcı Topluluğu',
    maxZoom: 19,
  },
  {
    ad: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıcıları',
    maxZoom: 19,
  },
  {
    ad: 'Koyu (CARTO)',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıcıları &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  },
];

const HTML_KACIS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function htmlKacis(deger) {
  return String(deger).replace(/[&<>"']/g, (k) => HTML_KACIS[k]);
}

function degerMetni(deger) {
  if (deger === null || deger === undefined) return '';
  if (typeof deger === 'object') {
    try {
      return JSON.stringify(deger);
    } catch {
      return String(deger);
    }
  }
  return String(deger);
}

function popupHtml(ozellikler) {
  const anahtarlar = ozellikler ? Object.keys(ozellikler) : [];
  if (anahtarlar.length === 0) return '<em>Öznitelik yok</em>';
  const satirlar = anahtarlar
    .map((k) => `<tr><th>${htmlKacis(k)}</th><td>${htmlKacis(degerMetni(ozellikler[k]))}</td></tr>`)
    .join('');
  return `<table class="popup-tablo">${satirlar}</table>`;
}

function noktaKatmani(renk) {
  return (_obje, konum) =>
    L.circleMarker(konum, { radius: 6, color: '#ffffff', weight: 1.5, fillColor: renk, fillOpacity: 0.9 });
}

function her_obje(obje, katman) {
  katman.bindPopup(() => popupHtml(obje.properties), { maxWidth: 320, maxHeight: 260 });
}

// GeoJSON bileşeni data değişimini izlemediği için her yeni nesneye kararlı bir anahtar verilir.
const kimlikler = new WeakMap();
let sonKimlik = 0;
function veriKimligi(veri) {
  if (!kimlikler.has(veri)) kimlikler.set(veri, ++sonKimlik);
  return kimlikler.get(veri);
}

function SinirlaraSigdir({ veri }) {
  const harita = useMap();
  useEffect(() => {
    if (!veri) return;
    try {
      const sinirlar = L.geoJSON(veri, { pointToLayer: (_o, konum) => L.circleMarker(konum) }).getBounds();
      if (sinirlar.isValid()) harita.fitBounds(sinirlar, { padding: [20, 20], maxZoom: 18 });
    } catch {
      // Geçersiz geometri: yakınlaştırma atlanır.
    }
  }, [veri, harita]);
  return null;
}

function Harita({ veri, renk, etiket }) {
  const secenekler = useMemo(
    () => ({
      stil: { color: renk, weight: 2, fillColor: renk, fillOpacity: 0.3 },
      noktaKatmani: noktaKatmani(renk),
    }),
    [renk],
  );

  return (
    <MapContainer
      center={BASLANGIC_MERKEZ}
      zoom={BASLANGIC_ZOOM}
      className="harita"
      preferCanvas
      aria-label={etiket}
    >
      <LayersControl position="topright">
        {ALTLIKLAR.map((a, i) => (
          <BaseLayer key={a.ad} checked={i === 0} name={a.ad}>
            <TileLayer
              url={a.url}
              attribution={a.attribution}
              maxZoom={a.maxZoom}
              {...(a.subdomains ? { subdomains: a.subdomains } : {})}
            />
          </BaseLayer>
        ))}
      </LayersControl>
      {veri && (
        <GeoJSON
          key={veriKimligi(veri)}
          data={veri}
          style={secenekler.stil}
          pointToLayer={secenekler.noktaKatmani}
          onEachFeature={her_obje}
        />
      )}
      <SinirlaraSigdir veri={veri} />
    </MapContainer>
  );
}

export default memo(Harita);
