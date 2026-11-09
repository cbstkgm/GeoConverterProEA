/**
 * Autodesk 3D Studio (`.3ds`) yazıcısı.
 *
 * Saf JavaScript: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
 * Geometri `ortak/ag.js` → `agOlustur(fc)` ile hazırlanır (CCW üçgenler, Z-yukarı — 3DS de Z-yukarıdır).
 *
 * İkili chunk yapısı (tümü little-endian; her chunk: uint16 kimlik + uint32 uzunluk (6 baytlık başlık dahil)):
 *   0x4D4D MAIN
 *     0x0002 VERSION (uint32 3)
 *     0x3D3D EDIT3DS
 *       0x3D3E MESH_VERSION (uint32 3)
 *       0x0100 MASTER_SCALE (float32 1)
 *       0x4000 EDIT_OBJECT: ad (ASCII, en çok 10 karakter, benzersiz, NUL sonlu)
 *         0x4100 OBJ_TRIMESH
 *           0x4110 TRI_VERTEXL: uint16 n + n × (3 × float32)
 *           0x4120 TRI_FACEL1:  uint16 m + m × (3 × uint16 köşe + uint16 bayrak)
 *
 * Yüz bayrağı 0x0007: AB, BC, CA kenarları görünür (3ds Max / Blender varsayılanı).
 * Sınırlar: köşe ve yüz sayıları uint16 → obje başına en çok 65535 köşe ve 65535 yüz. Aşan objeler
 * birden çok 3DS nesnesine bölünür (ad_2, ad_3 …) ve uyarılır.
 * Koordinatlar float32: merkez ötelemesi uygulanır; 3DS'te merkez için standart bir alan olmadığından
 * merkez uyarı ile bildirilir. Çizgi ve noktalar 3DS ağında temsil edilemez: atlanır ve uyarılır.
 */
import { agOlustur } from './ortak/ag.js';
import { asciiAd, benzersizAdUretici, merkezMetni, objeAdiHam, objelereGrupla } from './obj.js';

export const UC_DS_SINIR = 65535;
const AD_SINIRI = 10;

/** Basit büyüyen ikili yazıcı. */
class Yazici {
  constructor() {
    this.bayt = new Uint8Array(1024);
    this.dv = new DataView(this.bayt.buffer);
    this.o = 0;
  }
  yer(n) {
    if (this.o + n <= this.bayt.length) return;
    let boy = this.bayt.length * 2;
    while (boy < this.o + n) boy *= 2;
    const yeni = new Uint8Array(boy);
    yeni.set(this.bayt.subarray(0, this.o));
    this.bayt = yeni;
    this.dv = new DataView(yeni.buffer);
  }
  u8(v) { this.yer(1); this.dv.setUint8(this.o, v); this.o += 1; }
  u16(v) { this.yer(2); this.dv.setUint16(this.o, v, true); this.o += 2; }
  u32(v) { this.yer(4); this.dv.setUint32(this.o, v, true); this.o += 4; }
  f32(v) { this.yer(4); this.dv.setFloat32(this.o, v, true); this.o += 4; }
  /** Chunk açar; içeriği `govde` yazar, uzunluk sonra doldurulur. */
  chunk(kimlik, govde) {
    const bas = this.o;
    this.u16(kimlik);
    this.u32(0);
    govde();
    this.dv.setUint32(bas + 2, this.o - bas, true);
  }
  sonuc() { return this.bayt.slice(0, this.o); }
}

/**
 * Bir objenin yüzey parçalarını 65535 köşe / 65535 yüz sınırına uyan alt ağlara böler.
 * @returns {Array<{ konumlar: number[], yuzler: number[] }>}
 */
export function agiBol(parcalar, sinir = UC_DS_SINIR) {
  const altlar = [];
  let gecerli = null;
  const yeni = () => {
    gecerli = { konumlar: [], yuzler: [], harita: null };
    altlar.push(gecerli);
  };
  yeni();
  for (const p of parcalar) {
    const harita = new Map(); // parça köşe indeksi → alt ağ köşe indeksi (alt ağ değişince sıfırlanır)
    gecerli.harita = harita;
    for (let i = 0; i < p.indeksler.length; i += 3) {
      const uc = [p.indeksler[i], p.indeksler[i + 1], p.indeksler[i + 2]];
      const yeniKose = uc.filter((k, j) => !gecerli.harita.has(k) && uc.indexOf(k) === j).length;
      if (gecerli.konumlar.length / 3 + yeniKose > sinir || gecerli.yuzler.length / 3 + 1 > sinir) {
        yeni();
        gecerli.harita = new Map();
      }
      for (const k of uc) {
        let h = gecerli.harita.get(k);
        if (h === undefined) {
          h = gecerli.konumlar.length / 3;
          gecerli.konumlar.push(p.konumlar[k * 3], p.konumlar[k * 3 + 1], p.konumlar[k * 3 + 2]);
          gecerli.harita.set(k, h);
        }
        gecerli.yuzler.push(h);
      }
    }
  }
  return altlar.filter((a) => a.yuzler.length).map(({ konumlar, yuzler }) => ({ konumlar, yuzler }));
}

/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {{ crs?: string }} [secenekler]
 * @returns {Promise<{veri: Uint8Array, onizleme: string, uyarilar: string[]}>}
 */
export async function ucDsYaz(fc, secenekler = {}) {
  void secenekler;
  const ag = agOlustur(fc, { merkezle: true });
  const uyarilar = [...ag.uyarilar];
  if (ag.sayac.cizgi || ag.sayac.nokta) {
    uyarilar.push(`3DS yalnızca üçgen ağ taşır: ${ag.sayac.cizgi} çizgi ve ${ag.sayac.nokta} nokta parçası atlandı.`);
  }

  const benzersiz = benzersizAdUretici(AD_SINIRI);
  const nesneler = [];
  for (const g of objelereGrupla(ag.parcalar)) {
    const yuzeyler = g.parcalar.filter((p) => p.tip === 'yuzey');
    if (!yuzeyler.length) continue;
    const kok = asciiAd(objeAdiHam(g.ozellikler, g.objeIndeks), AD_SINIRI) || `Obje${g.objeIndeks + 1}`.slice(0, AD_SINIRI);
    const altlar = agiBol(yuzeyler);
    if (altlar.length > 1) {
      uyarilar.push(`"${objeAdiHam(g.ozellikler, g.objeIndeks)}" 3DS'in 65535 köşe/yüz sınırını aştığı için ${altlar.length} nesneye bölündü.`);
    }
    for (const a of altlar) nesneler.push({ ad: benzersiz(kok), ...a });
  }

  if (nesneler.length) {
    uyarilar.push(
      `3DS koordinatları float32 olduğundan merkez ötelemesi uygulandı: mutlak = dosyadaki + (${merkezMetni(ag.merkez)}). Bu öteleme 3DS dosyasında saklanmaz.`,
    );
  } else {
    uyarilar.push('Yazılacak yüzey (poligon) yok; 3DS dosyası boş sahne içeriyor.');
  }

  const y = new Yazici();
  y.chunk(0x4d4d, () => {
    y.chunk(0x0002, () => y.u32(3));
    y.chunk(0x3d3d, () => {
      y.chunk(0x3d3e, () => y.u32(3));
      y.chunk(0x0100, () => y.f32(1));
      for (const n of nesneler) {
        y.chunk(0x4000, () => {
          for (let i = 0; i < n.ad.length; i++) y.u8(n.ad.charCodeAt(i));
          y.u8(0);
          y.chunk(0x4100, () => {
            y.chunk(0x4110, () => {
              y.u16(n.konumlar.length / 3);
              for (const v of n.konumlar) y.f32(v);
            });
            y.chunk(0x4120, () => {
              y.u16(n.yuzler.length / 3);
              for (let i = 0; i < n.yuzler.length; i += 3) {
                y.u16(n.yuzler[i]);
                y.u16(n.yuzler[i + 1]);
                y.u16(n.yuzler[i + 2]);
                y.u16(0x0007);
              }
            });
          });
        });
      }
    });
  });
  const veri = y.sonuc();
  const onizleme = [
    'Autodesk 3DS (ikili)',
    `Boyut: ${veri.length} bayt`,
    `Merkez ötelemesi: ${merkezMetni(ag.merkez)} (Z yukarı)`,
    `Nesne sayısı: ${nesneler.length}`,
    ...nesneler.slice(0, 200).map((n) => `  ${n.ad}: ${n.konumlar.length / 3} köşe, ${n.yuzler.length / 3} yüz`),
    ...(nesneler.length > 200 ? [`  … (${nesneler.length - 200} nesne daha)`] : []),
  ].join('\n');
  return { veri, onizleme, uyarilar };
}
