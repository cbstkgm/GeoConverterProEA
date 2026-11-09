// Rhino 3DM (.3dm) yazıcısı — rhino3dm (openNURBS WASM) ile.
// Saf JS: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
//
// WASM tembel ve önbellekli yüklenir (geopackage.js'teki sql.js deseni). Tarayıcı/worker'da
// `secenekler.rhinoWasmUrl` verilmelidir (Vite: `import url from 'rhino3dm/rhino3dm.wasm?url'`);
// Node'da paket WASM'ı kendi klasöründen okur.
//
// Merkez: 3DM'de dönüşüm hiyerarşisi yoktur. Varsayılan olarak geometri merkeze göre yazılır (Rhino büyük
// koordinatlarda görüntü hassasiyeti kaybeder); merkez belge ayarlarında modelBasePoint olarak ve
// belge dizelerinde ("GeoConverterProEA/merkez") saklanır. `secenekler.merkezle: false` → mutlak koordinat.
import { agOlustur } from './ortak/ag.js';
import { AILE_RENKLERI, degerMetni, objeleriGrupla, sayi } from './collada.js';

let rhinoSozu = null;

function rhinoYukle(rhinoWasmUrl) {
  if (!rhinoSozu) {
    rhinoSozu = (async () => {
      const modul = await import('rhino3dm/rhino3dm.module.js');
      const baslat = modul.default ?? modul;
      return baslat(rhinoWasmUrl ? { locateFile: () => rhinoWasmUrl } : {});
    })();
    // Başarısız yükleme önbellekte kalmasın; sonraki çağrı yeniden denesin.
    rhinoSozu.catch(() => {
      rhinoSozu = null;
    });
  }
  return rhinoSozu;
}

/** Katman özniteliği (layer/katman/Layer/LAYER/KATMAN) ya da null. */
function katmanOzniteligi(p) {
  const deger = p.layer ?? p.katman ?? p.Layer ?? p.LAYER ?? p.KATMAN ?? p.Katman;
  if (deger === null || deger === undefined) return null;
  const ad = String(deger)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/::/g, ':')
    .trim();
  return ad || null;
}

const VARSAYILAN_KATMAN = 'GeoConverterProEA';

const rgb = ([r, g, b]) => ({ r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a: 255 });

/** GeoJSON FeatureCollection → Rhino 3DM (Uint8Array). */
export async function rhinoYaz(fc, secenekler = {}) {
  const ag = agOlustur(fc, { merkezle: secenekler.merkezle !== false });
  const objeler = objeleriGrupla(ag);
  const uyarilar = [...ag.uyarilar];
  if (!objeler.length) uyarilar.push('Yazılacak geometri bulunamadı; boş bir 3DM dosyası üretildi.');

  const rh = await rhinoYukle(secenekler.rhinoWasmUrl);
  const dosya = new rh.File3dm();
  const silinecek = [dosya];
  try {
    const ayar = dosya.settings();
    ayar.modelUnitSystem = rh.UnitSystem.Meters;
    ayar.modelBasePoint = ag.merkez;
    const dizeler = dosya.strings();
    dizeler.set('GeoConverterProEA/merkez', ag.merkez.map(sayi).join(' '));
    dizeler.set('GeoConverterProEA/yukariEkseni', 'Z');
    if (secenekler.crs) dizeler.set('GeoConverterProEA/crs', String(secenekler.crs));

    const katmanlar = new Map();
    const katmanIndeksi = (ad) => {
      if (!katmanlar.has(ad)) {
        const k = new rh.Layer();
        silinecek.push(k);
        k.name = ad;
        k.color = rgb(AILE_RENKLERI.yuzey);
        katmanlar.set(ad, dosya.layers().add(k));
      }
      return katmanlar.get(ad);
    };
    katmanIndeksi(VARSAYILAN_KATMAN);

    const nesneler = dosya.objects();
    const sayac = { mesh: 0, egri: 0, nokta: 0 };
    for (const o of objeler) {
      const nitelik = new rh.ObjectAttributes();
      silinecek.push(nitelik);
      nitelik.name = o.ad;
      nitelik.layerIndex = katmanIndeksi(katmanOzniteligi(o.ozellikler) ?? VARSAYILAN_KATMAN);
      for (const k of Object.keys(o.ozellikler)) nitelik.setUserString(k, degerMetni(o.ozellikler[k]));

      if (o.yuzey) {
        const mesh = new rh.Mesh();
        silinecek.push(mesh);
        const kose = mesh.vertices();
        const k = o.yuzey.konumlar;
        for (let i = 0; i < k.length; i += 3) kose.add(k[i], k[i + 1], k[i + 2]);
        const yuz = mesh.faces();
        const ind = o.yuzey.indeksler;
        for (let i = 0; i < ind.length; i += 3) yuz.addTriFace(ind[i], ind[i + 1], ind[i + 2]);
        mesh.normals().computeNormals();
        mesh.compact();
        nesneler.addMesh(mesh, nitelik);
        sayac.mesh++;
      }
      for (const c of o.cizgiler) {
        const noktalar = [];
        for (let i = 0; i < c.length; i += 3) noktalar.push([c[i], c[i + 1], c[i + 2]]);
        const egri = new rh.PolylineCurve(noktalar);
        silinecek.push(egri);
        nesneler.add(egri, nitelik);
        sayac.egri++;
      }
      for (let i = 0; i < o.noktalar.length; i += 3) {
        nesneler.addPoint([o.noktalar[i], o.noktalar[i + 1], o.noktalar[i + 2]], nitelik);
        sayac.nokta++;
      }
    }

    const veri = dosya.toByteArray();
    const onizleme = [
      'Rhino 3DM (openNURBS)',
      `Birim: metre · Merkez (modelBasePoint): ${ag.merkez.map(sayi).join(' ')}${secenekler.crs ? ` · CRS: ${secenekler.crs}` : ''}`,
      `Mesh: ${sayac.mesh} · Polyline eğri: ${sayac.egri} · Nokta: ${sayac.nokta}`,
      `Katmanlar: ${[...katmanlar.keys()].join(', ')}`,
      `Boyut: ${veri.length} bayt`,
    ].join('\n');
    return { veri: new Uint8Array(veri), onizleme, uyarilar };
  } finally {
    for (const n of silinecek) {
      try {
        n.delete?.();
      } catch {
        // embind nesnesi zaten serbest bırakılmış olabilir.
      }
    }
  }
}
