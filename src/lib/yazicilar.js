// M2 — Yazıcılar: GeoJSON FeatureCollection → hedef dosya formatı.
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
import wellknown from 'wellknown';
import JSZip from 'jszip';

import { DESTEKLENEN_CIKTILAR } from './katalog.js';
import { netcadGmlYaz } from './gml.js';
import { dxfYaz } from './bicimler/dxf.js';
import { shapefileYaz } from './bicimler/shapefile.js';
import { geopackageYaz } from './bicimler/geopackage.js';
import { wkbYaz } from './bicimler/wkb.js';
import { sqlYaz } from './bicimler/sql.js';
import { xyzYaz } from './bicimler/xyz.js';
import { htmlYaz } from './bicimler/html.js';
import { markdownYaz } from './bicimler/markdown.js';
// İkinci dalga
import { stepYaz } from './bicimler/step.js';
import { igesYaz } from './bicimler/iges.js';
import { ifcYaz } from './bicimler/ifc.js';
import { dgnYaz } from './bicimler/dgn.js';
import { lasYaz } from './bicimler/las.js';
import { pcdYaz } from './bicimler/pcd.js';
import { ptsYaz } from './bicimler/pts.js';
import { ptxYaz } from './bicimler/ptx.js';
import { e57Yaz } from './bicimler/e57.js';
import { netcdfYaz } from './bicimler/netcdf.js';
import { spatialiteYaz } from './bicimler/spatialite.js';
import { mvtYaz } from './bicimler/mvt.js';
import { landxmlYaz } from './bicimler/landxml.js';
import { e00Yaz } from './bicimler/e00.js';
import { objYaz } from './bicimler/obj.js';
import { stlYaz } from './bicimler/stl.js';
import { plyYaz } from './bicimler/ply.js';
import { gltfYaz, glbYaz } from './bicimler/gltf.js';
import { ucDsYaz } from './bicimler/uc_ds.js';
import { colladaYaz } from './bicimler/collada.js';
import { x3dYaz } from './bicimler/x3d.js';
import { vrmlYaz } from './bicimler/vrml.js';
import { usdYaz, usdzYaz } from './bicimler/usd.js';
import { mayaYaz } from './bicimler/maya.js';
import { rhinoYaz } from './bicimler/rhino.js';
// CBS veritabanı
import { filegdbYaz } from './bicimler/filegdb.js';
import { mapinfoYaz } from './bicimler/mapinfo.js';

export { DESTEKLENEN_CIKTILAR };

const BOM = '﻿';

function uzantiNormallestir(uzanti) {
  if (typeof uzanti !== 'string' || uzanti.trim() === '') {
    throw new Error('Çıktı uzantısı belirtilmedi.');
  }
  const u = uzanti.trim().toLowerCase();
  return u.startsWith('.') ? u : `.${u}`;
}

function objeleriAl(fc) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('Yazılacak veri geçerli bir GeoJSON FeatureCollection değil.');
  }
  return fc.features.filter((f) => f && typeof f === 'object');
}

function geometriVarMi(f) {
  return f.geometry != null && typeof f.geometry === 'object' && typeof f.geometry.type === 'string';
}

function degeriMetneCevir(deger) {
  if (deger === null || deger === undefined) return '';
  if (typeof deger === 'object') return JSON.stringify(deger);
  return String(deger);
}

// ---------------------------------------------------------------- GeoJSON
function geojsonYaz(fc, secenekler) {
  const girinti = Number.isInteger(secenekler.girinti) && secenekler.girinti >= 0 ? secenekler.girinti : 2;
  const metin = JSON.stringify(fc, null, girinti);
  return { veri: metin, onizleme: metin };
}

// ---------------------------------------------------------------- WKT
function geometriWkt(geometri) {
  const wkt = wellknown.stringify(geometri);
  if (!wkt) throw new Error(`"${geometri.type}" geometrisi WKT'ye çevrilemedi.`);
  return wkt;
}

function wktYaz(fc) {
  const satirlar = objeleriAl(fc).filter(geometriVarMi).map((f) => geometriWkt(f.geometry));
  const metin = satirlar.join('\n');
  return { veri: metin, onizleme: metin };
}

// ---------------------------------------------------------------- KML
export function xmlKacis(metin) {
  return String(metin)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0'da izinsiz kontrol karakterlerini ayıkla
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function koordinatMetni(konum) {
  return konum.length > 2 && Number.isFinite(konum[2])
    ? `${konum[0]},${konum[1]},${konum[2]}`
    : `${konum[0]},${konum[1]}`;
}

function koordinatlar(dizi) {
  return `<coordinates>${dizi.map(koordinatMetni).join(' ')}</coordinates>`;
}

function halka(etiket, konumlar) {
  return `<${etiket}><LinearRing>${koordinatlar(konumlar)}</LinearRing></${etiket}>`;
}

function poligonKml(halkalar) {
  if (!halkalar.length) return '';
  const [dis, ...delikler] = halkalar;
  return `<Polygon>${halka('outerBoundaryIs', dis)}${delikler.map((d) => halka('innerBoundaryIs', d)).join('')}</Polygon>`;
}

function geometriKml(g) {
  switch (g.type) {
    case 'Point':
      return `<Point>${koordinatlar([g.coordinates])}</Point>`;
    case 'LineString':
      return `<LineString>${koordinatlar(g.coordinates)}</LineString>`;
    case 'Polygon':
      return poligonKml(g.coordinates);
    case 'MultiPoint':
      return `<MultiGeometry>${g.coordinates.map((c) => `<Point>${koordinatlar([c])}</Point>`).join('')}</MultiGeometry>`;
    case 'MultiLineString':
      return `<MultiGeometry>${g.coordinates.map((c) => `<LineString>${koordinatlar(c)}</LineString>`).join('')}</MultiGeometry>`;
    case 'MultiPolygon':
      return `<MultiGeometry>${g.coordinates.map(poligonKml).join('')}</MultiGeometry>`;
    case 'GeometryCollection':
      return `<MultiGeometry>${(g.geometries || []).filter(Boolean).map(geometriKml).join('')}</MultiGeometry>`;
    default:
      throw new Error(`Desteklenmeyen geometri tipi: "${g.type}".`);
  }
}

function placemarkKml(f, sira) {
  const ozellikler = f.properties && typeof f.properties === 'object' ? f.properties : {};
  const ad = ozellikler.name ?? ozellikler.ad ?? ozellikler.Name ?? ozellikler.NAME;
  const parcalar = ['<Placemark>'];
  if (ad !== undefined && ad !== null) parcalar.push(`<name>${xmlKacis(degeriMetneCevir(ad))}</name>`);
  else parcalar.push(`<name>Obje ${sira + 1}</name>`);
  const anahtarlar = Object.keys(ozellikler);
  if (anahtarlar.length) {
    parcalar.push('<ExtendedData>');
    for (const k of anahtarlar) {
      parcalar.push(`<Data name="${xmlKacis(k)}"><value>${xmlKacis(degeriMetneCevir(ozellikler[k]))}</value></Data>`);
    }
    parcalar.push('</ExtendedData>');
  }
  if (geometriVarMi(f)) parcalar.push(geometriKml(f.geometry));
  parcalar.push('</Placemark>');
  return parcalar.join('');
}

function kmlMetni(fc) {
  const objeler = objeleriAl(fc);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    '<name>GeoConverterProEA</name>',
    ...objeler.map(placemarkKml),
    '</Document>',
    '</kml>',
  ].join('\n');
}

function kmlYaz(fc) {
  const metin = kmlMetni(fc);
  return { veri: metin, onizleme: metin };
}

async function kmzYaz(fc) {
  const metin = kmlMetni(fc);
  const zip = new JSZip();
  zip.file('doc.kml', metin);
  const veri = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { veri, onizleme: metin };
}

// ---------------------------------------------------------------- CSV
function csvHucre(deger) {
  const metin = degeriMetneCevir(deger);
  return /[",\r\n]/.test(metin) ? `"${metin.replace(/"/g, '""')}"` : metin;
}

function csvYaz(fc) {
  const objeler = objeleriAl(fc);
  const basliklar = [];
  const gorulen = new Set();
  for (const f of objeler) {
    for (const k of Object.keys(f.properties || {})) {
      if (!gorulen.has(k)) {
        gorulen.add(k);
        basliklar.push(k);
      }
    }
  }
  const satirlar = [['WKT', ...basliklar].map(csvHucre).join(',')];
  for (const f of objeler) {
    const p = f.properties || {};
    const wkt = geometriVarMi(f) ? geometriWkt(f.geometry) : '';
    satirlar.push([wkt, ...basliklar.map((k) => p[k])].map(csvHucre).join(','));
  }
  const metin = satirlar.join('\r\n');
  return { veri: BOM + metin, onizleme: metin };
}

// ---------------------------------------------------------------- Giriş noktası
async function gmlYaz(fc, secenekler) {
  const { metin, uyarilar } = netcadGmlYaz(fc, { noktaKonumDogrulugu: secenekler.noktaKonumDogrulugu });
  return { veri: metin, onizleme: metin, uyarilar };
}

const YAZICILAR = {
  '.geojson': geojsonYaz,
  '.wkt': wktYaz,
  '.kml': kmlYaz,
  '.kmz': kmzYaz,
  '.csv': csvYaz,
  '.gml': gmlYaz,
  '.dxf': dxfYaz,
  '.zip': shapefileYaz,
  '.gpkg': geopackageYaz,
  '.wkb': wkbYaz,
  '.sql': sqlYaz,
  '.xyz': xyzYaz,
  '.html': htmlYaz,
  '.md': markdownYaz,
  // Uzantı eşdeğerleri: içerik mevcut yazıcılarla aynıdır.
  '.txt': wktYaz,
  '.json': geojsonYaz,
  // İkinci dalga — CAD
  '.step': stepYaz,
  '.stp': stepYaz,
  '.iges': igesYaz,
  '.igs': igesYaz,
  '.ifc': ifcYaz,
  '.dgn': dgnYaz,
  // Nokta bulutu ve bilimsel
  '.las': lasYaz,
  '.pcd': pcdYaz,
  '.pts': ptsYaz,
  '.ptx': ptxYaz,
  '.e57': e57Yaz,
  '.nc': netcdfYaz,
  // CBS / veritabanı
  '.sqlite': spatialiteYaz,
  '.mvt': mvtYaz,
  '.pbf': mvtYaz,
  '.xml': landxmlYaz,
  '.e00': e00Yaz,
  // 3B ağ ve sahne
  '.obj': objYaz,
  '.stl': stlYaz,
  '.ply': plyYaz,
  '.gltf': gltfYaz,
  '.glb': glbYaz,
  '.3ds': ucDsYaz,
  '.dae': colladaYaz,
  '.x3d': x3dYaz,
  '.wrl': vrmlYaz,
  '.usd': usdYaz,
  '.usdz': usdzYaz,
  '.ma': mayaYaz,
  '.3dm': rhinoYaz,
  '.gdb': filegdbYaz,
  '.tab': mapinfoYaz,
  '.map': mapinfoYaz,
};

export async function dosyaYaz(fc, uzanti, secenekler = {}) {
  const u = uzantiNormallestir(uzanti);
  const tanim = DESTEKLENEN_CIKTILAR.find((c) => c.uzanti === u);
  const yazici = YAZICILAR[u];
  if (!tanim || !yazici) {
    const liste = DESTEKLENEN_CIKTILAR.map((c) => c.uzanti).join(', ');
    throw new Error(`"${uzanti}" çıktı formatı tarayıcıda desteklenmiyor. Desteklenen formatlar: ${liste}.`);
  }
  objeleriAl(fc);
  const { veri, onizleme, uyarilar = [] } = await yazici(fc, secenekler || {});
  return { veri, mime: tanim.mime, uzanti: u, onizleme, uyarilar };
}
