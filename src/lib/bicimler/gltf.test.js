import { describe, it, expect } from 'vitest';
import { gltfYaz, glbYaz, base64 } from './gltf.js';

const X0 = 500000;
const Y0 = 4400000;
const kare = (x, y, b, z = 100) => [[x, y, z], [x + b, y, z], [x + b, y + b, z], [x, y + b, z], [x, y, z]];
const DELIKLI = { type: 'Polygon', coordinates: [kare(X0, Y0, 10), kare(X0 + 2, Y0 + 2, 2).reverse()] };
const ornekFc = () => ({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { ad: 'Çağlayan Şişli', alan: 96, buyuk: 12n }, geometry: DELIKLI },
    {
      type: 'Feature',
      properties: { no: 2 },
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'MultiPolygon', coordinates: [[kare(X0 + 20, Y0, 1)], [kare(X0 + 30, Y0, 1)]] },
          { type: 'LineString', coordinates: [[X0, Y0 + 20, 100], [X0 + 5, Y0 + 20, 100], [X0 + 5, Y0 + 25, 100]] },
          { type: 'Point', coordinates: [X0 + 1, Y0 + 30, 105] },
        ],
      },
    },
    { type: 'Feature', properties: {}, geometry: null },
  ],
});
const MERKEZ = [X0 + 15.5, Y0 + 15, 100];

function base64Coz(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** GLB → { json, bin } (başlık ve chunk uzunluklarını doğrulayarak). */
function glbCoz(bayt) {
  const dv = new DataView(bayt.buffer, bayt.byteOffset, bayt.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67);
  expect(dv.getUint32(4, true)).toBe(2);
  expect(dv.getUint32(8, true)).toBe(bayt.length);
  const jsonUz = dv.getUint32(12, true);
  expect(jsonUz % 4).toBe(0);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a);
  const jsonBayt = bayt.subarray(20, 20 + jsonUz);
  const json = JSON.parse(new TextDecoder().decode(jsonBayt)); // sondaki boşluk dolgusu JSON için geçerli
  let bin = new Uint8Array(0);
  if (20 + jsonUz < bayt.length) {
    const b = 20 + jsonUz;
    const binUz = dv.getUint32(b, true);
    expect(binUz % 4).toBe(0);
    expect(dv.getUint32(b + 4, true)).toBe(0x004e4942);
    expect(b + 8 + binUz).toBe(bayt.length);
    bin = bayt.subarray(b + 8, b + 8 + binUz);
    expect(json.buffers[0].byteLength).toBeLessThanOrEqual(binUz);
    expect(binUz - json.buffers[0].byteLength).toBeLessThan(4);
    expect([...bin.subarray(json.buffers[0].byteLength)].every((x) => x === 0)).toBe(true);
  }
  return { json, bin };
}

/** Accessor verisini okur ve Validator kurallarını denetler. */
function accessorOku(json, bin, i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  expect(bv.byteStride).toBeUndefined();
  expect(bv.byteOffset % 4).toBe(0);
  expect(a.byteOffset ?? 0).toBe(0);
  const Tur = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
  const bilesen = { SCALAR: 1, VEC3: 3 }[a.type];
  expect(bv.byteLength).toBe(a.count * bilesen * Tur.BYTES_PER_ELEMENT);
  const kopya = bin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength);
  return { a, bv, veri: Array.from(new Tur(kopya.buffer)) };
}

/** Tüm sahneyi üçgen/çizgi/nokta listelerine çözer (Z-yukarı mutlak koordinata geri çevirerek). */
function sahneCoz(json, bin) {
  const kok = json.nodes[json.scenes[json.scene].nodes[0]];
  const [tx, ty, tz] = kok.translation;
  const geri = (x, y, z) => [x + tx, -(z + tz), y + ty]; // glTF (x, y, z) = kaynak (x, z, -y)
  const sonuc = [];
  for (const ni of kok.children ?? []) {
    const node = json.nodes[ni];
    const mesh = json.meshes[node.mesh];
    const obje = { ad: node.name, extras: node.extras, ucgen: [], cizgi: [], nokta: [] };
    for (const p of mesh.primitives) {
      const { a, veri: k } = accessorOku(json, bin, p.attributes.POSITION);
      const koseler = [];
      for (let i = 0; i < k.length; i += 3) koseler.push(geri(k[i], k[i + 1], k[i + 2]));
      // min/max zorunlu ve veriyle birebir
      expect(a.min).toEqual([0, 1, 2].map((e) => Math.min(...k.filter((_, i) => i % 3 === e))));
      expect(a.max).toEqual([0, 1, 2].map((e) => Math.max(...k.filter((_, i) => i % 3 === e))));
      expect(json.bufferViews[a.bufferView].target).toBe(34962);
      if (p.mode === 0) {
        obje.nokta.push(...koseler);
        continue;
      }
      const ix = accessorOku(json, bin, p.indices);
      expect(json.bufferViews[ix.a.bufferView].target).toBe(34963);
      const grup = p.mode === 4 ? 3 : 2;
      for (let i = 0; i < ix.veri.length; i += grup) {
        (p.mode === 4 ? obje.ucgen : obje.cizgi).push(ix.veri.slice(i, i + grup).map((j) => koseler[j]));
      }
    }
    sonuc.push(obje);
  }
  return sonuc;
}

const alan = ([a, b, c]) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

describe('glTF — ortak model', () => {
  it.each([['gltf'], ['glb']])('%s: gidiş-dönüş', async (tur) => {
    let json;
    let bin;
    if (tur === 'gltf') {
      const r = await gltfYaz(ornekFc(), { crs: 'EPSG:5255' });
      expect(typeof r.veri).toBe('string');
      json = JSON.parse(r.veri);
      const uri = json.buffers[0].uri;
      expect(uri.startsWith('data:application/octet-stream;base64,')).toBe(true);
      bin = base64Coz(uri.split(',')[1]);
      expect(bin.length).toBe(json.buffers[0].byteLength);
      expect(r.onizleme).not.toContain(uri.split(',')[1].slice(0, 40));
      expect(r.uyarilar.join(' ')).toMatch(/1 obje geometrisiz/);
    } else {
      const r = await glbYaz(ornekFc(), { crs: 'EPSG:5255' });
      expect(r.veri).toBeInstanceOf(Uint8Array);
      ({ json, bin } = glbCoz(r.veri));
      expect(json.buffers[0].uri).toBeUndefined();
    }

    expect(json.asset).toMatchObject({ version: '2.0', extras: { merkez: MERKEZ, crs: 'EPSG:5255' } });
    expect(json.nodes[0].translation).toEqual([MERKEZ[0], MERKEZ[2], -MERKEZ[1]]);
    expect(json.materials.map((m) => m.name)).toEqual(['yuzey', 'cizgi', 'nokta']);

    const objeler = sahneCoz(json, bin);
    expect(objeler.map((o) => o.ad)).toEqual(['Çağlayan Şişli', 'Obje 2']);
    expect(objeler[0].extras).toEqual({ ad: 'Çağlayan Şişli', alan: 96, buyuk: '12' });
    // Delikli poligon: 8 üçgen, CCW (Y-yukarı dönüşüm sarımı korur), toplam alan 96
    expect(objeler[0].ucgen).toHaveLength(8);
    expect(objeler[0].ucgen.every((u) => alan(u) > 0)).toBe(true);
    expect(objeler[0].ucgen.reduce((s, u) => s + alan(u), 0)).toBeCloseTo(96, 6);
    expect(objeler[0].ucgen.flat()).toContainEqual([X0 + 4, Y0 + 4, 100]);
    // Çok parçalı obje: 2 kare (4 üçgen) + çizgi (2 kenar) + nokta
    expect(objeler[1].ucgen).toHaveLength(4);
    expect(objeler[1].cizgi).toEqual([
      [[X0, Y0 + 20, 100], [X0 + 5, Y0 + 20, 100]],
      [[X0 + 5, Y0 + 20, 100], [X0 + 5, Y0 + 25, 100]],
    ]);
    expect(objeler[1].nokta).toEqual([[X0 + 1, Y0 + 30, 105]]);
    expect(json.meshes[1].primitives.map((p) => p.mode)).toEqual([4, 1, 0]);
  });

  it('65535 üstü köşede UNSIGNED_INT indeks', async () => {
    const halka = Array.from({ length: 70000 }, (_, i) => [Math.cos((i / 70000) * 2 * Math.PI) * 1000, Math.sin((i / 70000) * 2 * Math.PI) * 1000]);
    halka.push(halka[0]);
    const { veri } = await glbYaz({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: halka } }] });
    const { json } = glbCoz(veri);
    expect(json.accessors[json.meshes[0].primitives[0].indices].componentType).toBe(5125);
  });

  it('küçük ağda UNSIGNED_SHORT indeks; 4 bayt hizalama korunur', async () => {
    const { veri } = await glbYaz({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] } }, { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [5, 5] } }] });
    const { json, bin } = glbCoz(veri);
    expect(json.accessors[1].componentType).toBe(5123);
    expect(json.bufferViews[1].byteLength).toBe(6); // 3 × uint16 → sonraki görünüm 4'e hizalanmalı
    expect(json.bufferViews[2].byteOffset % 4).toBe(0);
    expect(sahneCoz(json, bin)[1].nokta).toEqual([[5, 5, 0]]);
  });

  it('boş FC: yalnızca kök düğüm, buffer yok, GLB BIN chunk yok', async () => {
    const r = await gltfYaz({ type: 'FeatureCollection', features: [] });
    const json = JSON.parse(r.veri);
    expect(json.nodes).toEqual([{ name: 'GeoConverterProEA', translation: [0, 0, 0] }]);
    expect(json.buffers).toBeUndefined();
    expect(json.meshes).toBeUndefined();
    expect(r.uyarilar.join(' ')).toMatch(/geometri yok/);
    const g = await glbYaz({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null }] });
    const { json: j2, bin } = glbCoz(g.veri);
    expect(bin.length).toBe(0);
    expect(j2.scenes[0].nodes).toEqual([0]);
  });

  it('base64 kodlayıcı', () => {
    const ornek = new TextEncoder().encode('glTF ikili veri ğüşiöç');
    for (let n = 0; n <= ornek.length; n++) {
      expect(base64(ornek.subarray(0, n))).toBe(btoa(String.fromCharCode(...ornek.subarray(0, n))));
    }
  });
});
