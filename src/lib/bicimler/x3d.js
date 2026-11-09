// X3D 4.0 XML (.x3d) yazıcısı — profil Interchange.
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
//
// Eksen kararı: X3D Y-yukarıdır. Koordinatları (x, z, -y) olarak dönüştürmek yerine veri Z-yukarı
// olduğu gibi yazılır ve en dıştaki Transform'a rotation="1 0 0 -π/2" verilir (X ekseni etrafında -90°,
// (x, y, z) → (x, z, -y) ile birebir aynı). Böylece koordinatlar CBS'deki değerlerle aynı kalır (okunabilir,
// gidiş-dönüşte kayıpsız) ve merkez ötelemesi de Z-yukarı çerçevede yazılabilir.
import { xmlKacis } from '../yazicilar.js';
import { AILE_RENKLERI, adUretici, degerMetni, merkeziBol, sahneHazirla, sayi } from './collada.js';

export const X3D_DONDURME = '1 0 0 -1.5707963267948966';

/** MFString öğesi: "…" içinde \ ve " kaçışı; ardından XML öznitelik kaçışı. */
export function mfString(metinler) {
  return xmlKacis(metinler.map((m) => `"${String(m).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' '));
}

const liste = (dizi) => dizi.map(sayi).join(' ');

function ozellikMeta(ozellikler) {
  const anahtarlar = Object.keys(ozellikler || {});
  if (!anahtarlar.length) return '';
  const ic = anahtarlar
    .map((k) => `<MetadataString containerField="value" name="${xmlKacis(k)}" value="${mfString([degerMetni(ozellikler[k])])}"/>`)
    .join('');
  return `<MetadataSet containerField="metadata" name="oznitelikler">${ic}</MetadataSet>`;
}

/** GeoJSON FeatureCollection → X3D 4.0 XML. */
export async function x3dYaz(fc, secenekler = {}) {
  const { objeler, uyarilar, merkez } = sahneHazirla(fc);
  const merkezParca = merkeziBol(merkez);
  const ad = adUretici(['ZYukari', 'Merkez', 'MerkezInce']);
  const baslik = typeof secenekler.baslik === 'string' && secenekler.baslik.trim() ? secenekler.baslik.trim() : 'GeoConverterProEA';
  const [ry, rc, rn] = [AILE_RENKLERI.yuzey, AILE_RENKLERI.cizgi, AILE_RENKLERI.nokta].map((r) => r.join(' '));

  const dugumler = objeler.map((o) => {
    const sekiller = [];
    if (o.yuzey) {
      sekiller.push(
        `<Shape><Appearance><Material diffuseColor="${ry}"/></Appearance>` +
          `<IndexedTriangleSet solid="false" ccw="true" index="${o.yuzey.indeksler.join(' ')}"><Coordinate point="${liste(o.yuzey.konumlar)}"/></IndexedTriangleSet></Shape>`,
      );
    }
    if (o.cizgiler.length) {
      const konum = [];
      const indeks = [];
      for (const c of o.cizgiler) {
        const bas = konum.length / 3;
        konum.push(...c);
        for (let i = 0; i < c.length / 3; i++) indeks.push(bas + i);
        indeks.push(-1);
      }
      sekiller.push(
        `<Shape><Appearance><Material diffuseColor="0 0 0" emissiveColor="${rc}"/></Appearance>` +
          `<IndexedLineSet coordIndex="${indeks.join(' ')}"><Coordinate point="${liste(konum)}"/></IndexedLineSet></Shape>`,
      );
    }
    if (o.noktalar.length) {
      sekiller.push(
        `<Shape><Appearance><Material diffuseColor="0 0 0" emissiveColor="${rn}"/></Appearance>` +
          `<PointSet><Coordinate point="${liste(o.noktalar)}"/></PointSet></Shape>`,
      );
    }
    return `<Transform DEF="${ad(o.ad)}">${ozellikMeta(o.ozellikler)}${sekiller.join('')}</Transform>`;
  });

  const sahneMeta = [
    `<MetadataDouble containerField="value" name="merkez" value="${liste(merkez)}"/>`,
    '<MetadataString containerField="value" name="yukariEkseni" value="&quot;Z&quot;"/>',
    '<MetadataString containerField="value" name="birim" value="&quot;metre&quot;"/>',
  ];
  if (secenekler.crs) sahneMeta.push(`<MetadataString containerField="value" name="crs" value="${mfString([secenekler.crs])}"/>`);

  const veri = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE X3D PUBLIC "ISO//Web3D//DTD X3D 4.0//EN" "https://www.web3d.org/specifications/x3d-4.0.dtd">',
    '<X3D profile="Interchange" version="4.0" xmlns:xsd="http://www.w3.org/2001/XMLSchema-instance" xsd:noNamespaceSchemaLocation="https://www.web3d.org/specifications/x3d-4.0.xsd">',
    '<head>',
    `<meta name="title" content="${xmlKacis(baslik)}"/>`,
    '<meta name="generator" content="GeoConverterProEA"/>',
    `<meta name="merkez" content="${liste(merkez)}"/>`,
    ...(secenekler.crs ? [`<meta name="crs" content="${xmlKacis(String(secenekler.crs))}"/>`] : []),
    '</head>',
    '<Scene>',
    `<Transform DEF="ZYukari" rotation="${X3D_DONDURME}">`,
    `<MetadataSet containerField="metadata" name="GeoConverterProEA">${sahneMeta.join('')}</MetadataSet>`,
    // SFVec3f float32'dir: merkez tam metre (Merkez) + kesir (MerkezInce) olarak iki Transform'a bölünür.
    `<Transform DEF="Merkez" translation="${liste(merkezParca.kaba)}">`,
    `<Transform DEF="MerkezInce" translation="${liste(merkezParca.ince)}">`,
    ...dugumler,
    '</Transform>',
    '</Transform>',
    '</Transform>',
    '</Scene>',
    '</X3D>',
    '',
  ].join('\n');
  return { veri, onizleme: veri, uyarilar };
}
