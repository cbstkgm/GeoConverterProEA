import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  htmlYaz,
  guvenliJson,
  htmlKacis,
  ALTLIKLAR,
  LEAFLET,
  VARSAYILAN_HARITA_BASLIGI,
  _SAYFA_BETIGI,
} from './html.js';

const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });
const SALDIRI = '</script><script>alert(1)</script>';

const tumTipler = () =>
  fc([
    obje({ type: 'Point', coordinates: [32.85, 39.93, 850] }, { ad: 'Ankara', şehir: 'Çankırı İğdır Şişli' }),
    obje({ type: 'MultiPoint', coordinates: [[30, 40], [31, 41]] }),
    obje({ type: 'LineString', coordinates: [[30, 40], [31, 41]] }),
    obje({ type: 'MultiLineString', coordinates: [[[30, 40], [31, 41]]] }),
    obje({ type: 'Polygon', coordinates: [[[30, 40], [31, 40], [31, 41], [30, 40]]] }),
    obje({ type: 'MultiPolygon', coordinates: [[[[30, 40], [31, 40], [31, 41], [30, 40]]]] }),
    obje({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [33, 39] }] }),
    obje(null, { ad: 'Geometrisiz' }),
  ]);

/** Sayfadaki type="application/json" bloğunu ayrıştırır (tarayıcının yapacağı gibi). */
function jsonBlok(html, id) {
  const m = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(html);
  return JSON.parse(m[1]);
}

describe('htmlYaz', () => {
  it('tek başına açılabilen sayfa: lang, charset, viewport, başlık, Leaflet SRI', async () => {
    const { veri, onizleme, uyarilar } = await htmlYaz(tumTipler(), { crs: 'EPSG:4326' });
    expect(veri.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(veri).toContain('<html lang="tr">');
    expect(veri).toContain('<meta charset="utf-8">');
    expect(veri).toContain('name="viewport"');
    expect(veri).toContain(`<title>${VARSAYILAN_HARITA_BASLIGI}</title>`);
    expect(veri).toContain(`src="${LEAFLET.js}" integrity="${LEAFLET.jsSri}" crossorigin="anonymous"`);
    expect(veri).toContain(`href="${LEAFLET.css}" integrity="${LEAFLET.cssSri}" crossorigin="anonymous"`);
    expect(LEAFLET.js).toMatch(/^https:\/\/cdnjs\.cloudflare\.com\/.*\/1\.9\.4\//);
    expect(veri).toContain('tile.openstreetmap.org');
    expect(veri).toContain('fitBounds');
    expect(veri).toContain('prefers-color-scheme: dark');
    expect(onizleme).toBe(veri);
    // Null geometri haritadan çıkarılır ve bildirilir.
    expect(uyarilar).toEqual(['1 obje geometrisiz olduğu için haritada gösterilmedi.']);
    const gomulu = jsonBlok(veri, 'gc-veri');
    expect(gomulu.features).toHaveLength(7);
    expect(gomulu.features[0].properties.şehir).toBe('Çankırı İğdır Şişli');
  });

  it('CSP betik özeti sabit sayfa betiğiyle eşleşir', async () => {
    const { veri } = await htmlYaz(fc([]));
    const ozet = createHash('sha256').update(_SAYFA_BETIGI, 'utf8').digest('base64');
    expect(veri).toContain(`'sha256-${ozet}'`);
    expect(veri).toContain(`<script>${_SAYFA_BETIGI}</script>`);
  });

  it('altlıklar: varsayılan CARTO (Referer istemez), Esri uydu, OSM; katman seçici; CSP img-src hepsini kapsar', async () => {
    const { veri } = await htmlYaz(fc([]));
    expect(ALTLIKLAR.map((a) => a.ad)).toEqual(['CARTO Voyager', 'Esri Uydu Görüntüsü', 'OpenStreetMap']);
    expect(ALTLIKLAR[0].url).toBe('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png');
    expect(ALTLIKLAR[0].secenekler.attribution).toMatch(/OpenStreetMap.*CARTO/);
    expect(ALTLIKLAR[1].url).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    );
    expect(ALTLIKLAR[1].secenekler.attribution).toMatch(/Esri, Maxar, Earthstar Geographics/);
    expect(_SAYFA_BETIGI).toContain('L.control.layers(altliklar');
    for (const a of ALTLIKLAR) expect(_SAYFA_BETIGI).toContain(JSON.stringify(a.url));

    const imgSrc = /img-src ([^;]+);/.exec(veri)[1].split(' ');
    for (const a of ALTLIKLAR) {
      const sablon = new URL(a.url.replace(/\{[^}]+\}/g, 'x')).host;
      const ornekler = a.url.includes('{s}')
        ? a.secenekler.subdomains.split('').map((s) => a.url.replace('{s}', s))
        : [a.url];
      for (const u of ornekler) {
        const origin = new URL(u.replace(/\{[^}]+\}/g, '0')).origin;
        expect(imgSrc, `${sablon} için ${origin}`).toContain(origin);
      }
    }
    expect(imgSrc).toContain('data:');
    // Katman seçici simgesi Leaflet CSS'iyle aynı kökten gelir.
    expect(imgSrc).toContain(new URL(LEAFLET.css).origin);
  });

  it('noktalar poligonların üstündeki ayrı bölmede (tıklanabilir)', () => {
    expect(_SAYFA_BETIGI).toContain("harita.createPane('noktalar').style.zIndex = 650");
    expect(_SAYFA_BETIGI).toMatch(/L\.circleMarker\(ll, \{ pane: 'noktalar', renderer: noktaCizici/);
    expect(_SAYFA_BETIGI).toContain("L.svg({ pane: 'noktalar' })");
  });

  it('20 MB üstü gömülü veride uyarı verir ama veriyi keser değil', async () => {
    const uzun = 'ç'.repeat(11 * 1024 * 1024); // UTF-8'de 2 bayt → ~22 MB
    const { veri, uyarilar } = await htmlYaz(fc([obje({ type: 'Point', coordinates: [30, 40] }, { uzun })]));
    expect(uyarilar.some((u) => /MB; 20 MB'ı aştığı/.test(u))).toBe(true);
    expect(veri.length).toBeGreaterThan(11 * 1024 * 1024);
    expect((await htmlYaz(fc([obje({ type: 'Point', coordinates: [30, 40] })]))).uyarilar).toEqual([]);
  });

  it('crypto.subtle yoksa CSP eklenmez ve bu uyarılara yazılır', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      const { veri, uyarilar } = await htmlYaz(fc([]));
      expect(veri).not.toContain('Content-Security-Policy');
      expect(uyarilar).toEqual([expect.stringMatching(/crypto\.subtle.*CSP/)]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect((await htmlYaz(fc([]))).veri).toContain('Content-Security-Policy');
  });

  it('saldırı dizeleri </script> bloğunu kıramaz ve veri bozulmadan geri okunur', async () => {
    const kotu = `${SALDIRI} <!-- & \u2028\u2029 | a\nb "'`;
    const { veri } = await htmlYaz(
      fc([obje({ type: 'Point', coordinates: [30, 40] }, { [kotu]: kotu, '<img src=x onerror=alert(1)>': 1 })]),
      { baslik: `${SALDIRI}<b>Başlık</b>` },
    );
    // Yalnızca sayfanın kendi 4 <script> etiketi var (2 JSON, Leaflet, sayfa betiği); saldırı etiketi yok.
    expect(veri.match(/<script/g)).toHaveLength(4);
    expect(veri.match(/<\/script>/g)).toHaveLength(4);
    expect(veri).not.toContain('<script>alert(1)');
    expect(veri).not.toContain('<img src=x');
    expect(veri).not.toMatch(/[\u2028\u2029]/);
    expect(veri).toContain('<title>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;Başlık&lt;/b&gt;</title>');
    const gomulu = jsonBlok(veri, 'gc-veri');
    expect(gomulu.features[0].properties[kotu]).toBe(kotu);
    // Açılır pencere innerHTML kullanmaz.
    expect(_SAYFA_BETIGI).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(_SAYFA_BETIGI).toContain('textContent');
  });

  it('guvenliJson ve htmlKacis', () => {
    expect(guvenliJson({ a: '</script>&\u2028' })).toBe('{"a":"\\u003c/script\\u003e\\u0026\\u2028"}');
    expect(JSON.parse(guvenliJson({ a: '</script>&\u2028' })).a).toBe('</script>&\u2028');
    expect(htmlKacis(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });

  it('CRS 4326 değil ve haritaGeojson yoksa uyarı bandı; metrik veride çizim kapalı', async () => {
    const metrik = fc([obje({ type: 'Point', coordinates: [500000, 4400000] })]);
    const { veri, uyarilar } = await htmlYaz(metrik, { crs: 'EPSG:5255' });
    expect(uyarilar).toHaveLength(1);
    expect(uyarilar[0]).toMatch(/ITRF96 \/ 3° TM 33.*çizilmedi/);
    expect(veri).toContain('class="gc-uyari"');
    expect(jsonBlok(veri, 'gc-ayar')).toEqual({ ciz: false });
  });

  it('haritaGeojson verilirse haritada o kullanılır, uyarı yok', async () => {
    const metrik = fc([obje({ type: 'Point', coordinates: [500000, 4400000] }, { ad: 'm' })]);
    const wgs = fc([obje({ type: 'Point', coordinates: [33, 39.7] }, { ad: 'm' })]);
    const { veri, uyarilar } = await htmlYaz(metrik, { crs: 'EPSG:5255', haritaGeojson: wgs });
    expect(uyarilar).toEqual([]);
    expect(veri).not.toContain('class="gc-uyari"');
    expect(jsonBlok(veri, 'gc-veri').features[0].geometry.coordinates).toEqual([33, 39.7]);
    expect(jsonBlok(veri, 'gc-ayar')).toEqual({ ciz: true });
    await expect(htmlYaz(metrik, { haritaGeojson: {} })).rejects.toThrow(/haritaGeojson/);
  });

  it('boş FC: geçerli sayfa, varsayılan görünüm', async () => {
    const { veri, uyarilar } = await htmlYaz(fc([]));
    expect(uyarilar).toEqual([]);
    expect(jsonBlok(veri, 'gc-veri').features).toEqual([]);
    expect(veri).toContain('setView([39, 35], 6)');
    await expect(htmlYaz(undefined)).rejects.toThrow(/FeatureCollection/);
  });

  it('büyük veride önizleme kısaltılır, veri tam kalır', async () => {
    const cok = fc(Array.from({ length: 5000 }, (_, i) => obje({ type: 'Point', coordinates: [30 + i / 1e4, 40] }, { no: i })));
    const { veri, onizleme } = await htmlYaz(cok);
    expect(jsonBlok(veri, 'gc-veri').features).toHaveLength(5000);
    expect(onizleme.length).toBeLessThan(veri.length);
    expect(onizleme).toMatch(/… \d+ karakter daha$/);
  });
});
