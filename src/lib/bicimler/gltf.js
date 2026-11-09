/**
 * glTF 2.0 yazıcıları: `.gltf` (JSON, gömülü base64 buffer) ve `.glb` (ikili kapsayıcı).
 *
 * Saf JavaScript: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
 * Geometri `ortak/ag.js` → `agOlustur(fc)` ile hazırlanır (CCW üçgenler, Z-yukarı, merkez ötelemesi).
 *
 * Sahne yapısı:
 *   scene 0 → kök düğüm "GeoConverterProEA" (translation = merkez ötelemesi, Y-yukarı eksende)
 *             └─ her GeoJSON objesi için bir düğüm (name = ad özniteliği, extras = öznitelikler) + bir mesh
 *                  primitive'ler: yüzeyler mode 4 (TRIANGLES, indeksli), çizgiler mode 1 (LINES, indeksli,
 *                  ardışık köşe çiftleri), noktalar mode 0 (POINTS)
 *   asset.extras.merkez = kaynak eksende (Z-yukarı) merkez ötelemesi; kök translation'ı ile aynı bilgi.
 *
 * Eksen: glTF Y-yukarı, +Z ileri; kaynak (x doğu, y kuzey, z yukarı) → glTF (x, z, -y). Bu bir dönmedir
 * (determinant +1), dolayısıyla üçgen sarım yönü (CCW) korunur ve yatay yüzlerin normali +Y olur.
 *
 * glTF Validator kuralları:
 *  - Her bufferView 4 bayt hizalı başlar; accessor byteOffset 0; byteStride yazılmaz (sıkı paketli).
 *  - POSITION accessor'larında min/max ZORUNLU ve float32'ye yuvarlanmış veriden hesaplanır.
 *  - İndeks tipi: köşe sayısı ≤ 65535 ise UNSIGNED_SHORT, değilse UNSIGNED_INT (en büyük değer
 *    ilkel yeniden başlatma için ayrıldığından 65535 köşe sınırı).
 *  - bufferView target: köşeler 34962 (ARRAY_BUFFER), indeksler 34963 (ELEMENT_ARRAY_BUFFER).
 *  - Boş diziler yazılmaz (şema minItems 1); boş FC'de yalnızca kök düğüm vardır.
 *  - NORMAL yazılmaz: glTF, normal yoksa istemcinin düz (flat) normal hesaplamasını zorunlu kılar.
 * GLB: 12 bayt başlık ('glTF', 2, toplam uzunluk) + JSON chunk (boşlukla 4'e doldurulur) + BIN chunk
 * (sıfırla 4'e doldurulur).
 */
import { agOlustur } from './ortak/ag.js';
import { objeAdiHam, objelereGrupla, tekSatir } from './obj.js';

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

const MALZEMELER = {
  yuzey: { name: 'yuzey', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.76, 0.66, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true },
  cizgi: { name: 'cizgi', pbrMetallicRoughness: { baseColorFactor: [0.85, 0.2, 0.15, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
  nokta: { name: 'nokta', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.35, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
};

/** Z-yukarı → Y-yukarı: (x, y, z) → (x, z, -y). -0 üretmemek için 0 - y yerine koşullu. */
const yYukari = (x, y, z) => [x, z, y === 0 ? 0 : -y];

/** Öznitelikleri JSON'a güvenle yazılabilir hâle getirir (BigInt → metin, undefined atılır). */
function extrasYap(ozellikler) {
  try {
    return JSON.parse(JSON.stringify(ozellikler, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch {
    return {};
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bağımlılıksız base64 kodlayıcı (worker/Node'da btoa'ya ve Buffer'a gerek yok). */
export function base64(bayt) {
  const parcalar = [];
  let s = '';
  for (let i = 0; i < bayt.length; i += 3) {
    const n = (bayt[i] << 16) | ((bayt[i + 1] ?? 0) << 8) | (bayt[i + 2] ?? 0);
    s += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
    s += i + 1 < bayt.length ? BASE64[(n >> 6) & 63] : '=';
    s += i + 2 < bayt.length ? BASE64[n & 63] : '=';
    if (s.length >= 8192) {
      parcalar.push(s);
      s = '';
    }
  }
  parcalar.push(s);
  return parcalar.join('');
}

/**
 * Ortak model kurucu: glTF JSON nesnesi + BIN baytları.
 * @returns {{ json: object, bin: Uint8Array, uyarilar: string[] }}
 */
export function gltfModeli(fc, secenekler = {}) {
  const ag = agOlustur(fc, { merkezle: true });
  const uyarilar = [...ag.uyarilar];

  const parcaBaytlari = [];
  let binUzunluk = 0;
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  const materials = [];
  const malzemeIndeksi = {};

  function bufferViewEkle(bayt, target) {
    const bosluk = (4 - (binUzunluk % 4)) % 4;
    if (bosluk) {
      parcaBaytlari.push(new Uint8Array(bosluk));
      binUzunluk += bosluk;
    }
    bufferViews.push({ buffer: 0, byteOffset: binUzunluk, byteLength: bayt.byteLength, target });
    parcaBaytlari.push(new Uint8Array(bayt.buffer, bayt.byteOffset, bayt.byteLength));
    binUzunluk += bayt.byteLength;
    return bufferViews.length - 1;
  }

  function konumAccessor(duzKonumlar) {
    const f = new Float32Array(duzKonumlar.length);
    for (let i = 0; i < duzKonumlar.length; i += 3) {
      const [x, y, z] = yYukari(duzKonumlar[i], duzKonumlar[i + 1], duzKonumlar[i + 2]);
      f[i] = x;
      f[i + 1] = y;
      f[i + 2] = z;
    }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < f.length; i++) {
      min[i % 3] = Math.min(min[i % 3], f[i]);
      max[i % 3] = Math.max(max[i % 3], f[i]);
    }
    accessors.push({ bufferView: bufferViewEkle(f, ARRAY_BUFFER), componentType: FLOAT, count: f.length / 3, type: 'VEC3', min, max });
    return accessors.length - 1;
  }

  function indeksAccessor(indeksler, koseSayisi) {
    const dizi = koseSayisi <= 65535 ? Uint16Array.from(indeksler) : Uint32Array.from(indeksler);
    accessors.push({
      bufferView: bufferViewEkle(dizi, ELEMENT_ARRAY_BUFFER),
      componentType: dizi instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
      count: dizi.length,
      type: 'SCALAR',
    });
    return accessors.length - 1;
  }

  function malzeme(tip) {
    if (malzemeIndeksi[tip] === undefined) {
      materials.push(MALZEMELER[tip]);
      malzemeIndeksi[tip] = materials.length - 1;
    }
    return malzemeIndeksi[tip];
  }

  for (const g of objelereGrupla(ag.parcalar)) {
    const primitives = [];
    for (const tip of ['yuzey', 'cizgi', 'nokta']) {
      const parcalar = g.parcalar.filter((p) => p.tip === tip);
      if (!parcalar.length) continue;
      const konumlar = [];
      const indeksler = [];
      for (const p of parcalar) {
        const taban = konumlar.length / 3;
        const adet = p.konumlar.length / 3;
        for (const v of p.konumlar) konumlar.push(v);
        if (tip === 'yuzey') for (const i of p.indeksler) indeksler.push(i + taban);
        else if (tip === 'cizgi') for (let i = 0; i + 1 < adet; i++) indeksler.push(taban + i, taban + i + 1);
      }
      const primitive = { attributes: { POSITION: konumAccessor(konumlar) }, mode: { yuzey: 4, cizgi: 1, nokta: 0 }[tip], material: malzeme(tip) };
      if (tip !== 'nokta') primitive.indices = indeksAccessor(indeksler, konumlar.length / 3);
      primitives.push(primitive);
    }
    const ad = objeAdiHam(g.ozellikler, g.objeIndeks);
    meshes.push({ name: ad, primitives });
    const node = { name: ad, mesh: meshes.length - 1 };
    const extras = extrasYap(g.ozellikler);
    if (Object.keys(extras).length) node.extras = extras;
    nodes.push(node);
  }

  const [mx, my, mz] = ag.merkez;
  const kok = { name: 'GeoConverterProEA', translation: yYukari(mx, my, mz) };
  if (nodes.length) kok.children = nodes.map((_, i) => i + 1);

  const json = {
    asset: {
      version: '2.0',
      generator: 'GeoConverterProEA',
      extras: {
        merkez: [mx, my, mz],
        eksen: 'Kaynak X=doğu, Y=kuzey, Z=yukarı; glTF (x, z, -y). Mutlak koordinat = konum + merkez (kök düğüm translation).',
        ...(secenekler.crs ? { crs: tekSatir(secenekler.crs) } : {}),
      },
    },
    scene: 0,
    scenes: [{ name: 'GeoConverterProEA', nodes: [0] }],
    nodes: [kok, ...nodes],
  };
  if (meshes.length) {
    Object.assign(json, { meshes, materials, accessors, bufferViews, buffers: [{ byteLength: binUzunluk }] });
  } else {
    uyarilar.push('Yazılacak 3B geometri yok; glTF sahnesi yalnızca kök düğüm içeriyor.');
  }

  const bin = new Uint8Array(binUzunluk);
  let o = 0;
  for (const p of parcaBaytlari) {
    bin.set(p, o);
    o += p.length;
  }
  return { json, bin, uyarilar };
}

function onizlemeJson(json, binUzunluk) {
  const kopya = structuredClone(json);
  if (kopya.buffers?.[0]?.uri) kopya.buffers[0].uri = `data:application/octet-stream;base64,… (${binUzunluk} bayt)`;
  return JSON.stringify(kopya, null, 2);
}

/**
 * `.gltf`: tek JSON dosyası, buffer data URI (base64) olarak gömülü.
 * @returns {Promise<{veri: string, onizleme: string, uyarilar: string[]}>}
 */
export async function gltfYaz(fc, secenekler = {}) {
  const { json, bin, uyarilar } = gltfModeli(fc, secenekler || {});
  if (json.buffers) json.buffers[0].uri = `data:application/octet-stream;base64,${base64(bin)}`;
  return { veri: JSON.stringify(json), onizleme: onizlemeJson(json, bin.length), uyarilar };
}

/**
 * `.glb`: ikili kapsayıcı (başlık + JSON chunk + BIN chunk).
 * @returns {Promise<{veri: Uint8Array, onizleme: string, uyarilar: string[]}>}
 */
export async function glbYaz(fc, secenekler = {}) {
  const { json, bin, uyarilar } = gltfModeli(fc, secenekler || {});
  const jsonHam = new TextEncoder().encode(JSON.stringify(json));
  const jsonUz = Math.ceil(jsonHam.length / 4) * 4;
  const binUz = Math.ceil(bin.length / 4) * 4;
  const toplam = 12 + 8 + jsonUz + (bin.length ? 8 + binUz : 0);
  const bayt = new Uint8Array(toplam);
  const dv = new DataView(bayt.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, toplam, true);
  dv.setUint32(12, jsonUz, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  bayt.set(jsonHam, 20);
  bayt.fill(0x20, 20 + jsonHam.length, 20 + jsonUz);
  if (bin.length) {
    const b = 20 + jsonUz;
    dv.setUint32(b, binUz, true);
    dv.setUint32(b + 4, 0x004e4942, true); // 'BIN\0'
    bayt.set(bin, b + 8); // kalan dolgu baytları zaten 0
  }
  return {
    veri: bayt,
    onizleme: `GLB (glTF 2.0 ikili), ${toplam} bayt; BIN ${bin.length} bayt\n${onizlemeJson(json, bin.length)}`,
    uyarilar,
  };
}
