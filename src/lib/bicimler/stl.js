/**
 * STL yazıcısı (`.stl`) — 3B baskı / mesh değişim formatı.
 *
 * Saf JavaScript: DOM / window kullanmaz; Web Worker'da ve Node'da (Vitest) çalışır.
 * Geometri `ortak/ag.js` → `agOlustur(fc)` ile hazırlanır (CCW üçgenler, Z-yukarı).
 *
 * İkili STL (varsayılan):
 *   80 bayt başlık (ASCII; "solid" ile BAŞLAMAZ — aksi halde bazı okuyucular dosyayı ASCII sanar)
 *   uint32 üçgen sayısı
 *   her üçgen 50 bayt: normal (3×float32) + 3 köşe (9×float32) + uint16 öznitelik bayt sayısı (0)
 *   Tüm sayılar little-endian.
 * ASCII STL (`secenekler.ascii === true`):
 *   solid <ad> / facet normal … / outer loop / vertex … / endloop / endfacet / endsolid <ad>
 *
 * STL koordinatları float32'dir (ASCII'de de okuyucular float32'ye çevirir); projeksiyonlu
 * koordinatlarda (500000, 4400000) bu santimetre hassasiyetini yok eder. Bu yüzden merkezleme
 * ZORUNLUDUR: köşeler merkeze göre yazılır, merkez başlığa / solid adına gömülür.
 *
 * STL yalnızca üçgen yüzey taşır: çizgi ve noktalar atlanır ve uyarılır. Öznitelik ve obje
 * ayrımı da yoktur; tüm objeler tek gövdede birleşir. Üçgen normali köşelerden hesaplanır
 * (sağ el kuralı, CCW → yataysa +Z); dejenere üçgende 0 0 0.
 */
import { agOlustur } from './ortak/ag.js';
import { merkezMetni, sayiMetni } from './obj.js';

/** Üç köşeden birim normal (float32'ye yuvarlanmış köşelerle). */
function normalHesapla(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  return l > 0 ? n.map((x) => x / l) : [0, 0, 0];
}

/** Tüm yüzey parçalarının üçgenlerini [[a,b,c], …] (her köşe float32'ye yuvarlanmış [x,y,z]) olarak döndürür. */
function ucgenler(parcalar) {
  const sonuc = [];
  for (const p of parcalar) {
    if (p.tip !== 'yuzey') continue;
    const k = p.konumlar;
    const kose = (i) => [Math.fround(k[i * 3]), Math.fround(k[i * 3 + 1]), Math.fround(k[i * 3 + 2])];
    for (let i = 0; i < p.indeksler.length; i += 3) {
      sonuc.push([kose(p.indeksler[i]), kose(p.indeksler[i + 1]), kose(p.indeksler[i + 2])]);
    }
  }
  return sonuc;
}

const ascii = (n) => {
  const s = Math.fround(n).toExponential(8);
  return Object.is(n, -0) ? s.replace('-', '') : s;
};

/**
 * @param {object} fc GeoJSON FeatureCollection (koordinatlar hedef CRS'te)
 * @param {{ ascii?: boolean, crs?: string }} [secenekler]
 * @returns {Promise<{veri: string | Uint8Array, onizleme: string, uyarilar: string[]}>}
 */
export async function stlYaz(fc, secenekler = {}) {
  const s = secenekler || {};
  const ag = agOlustur(fc, { merkezle: true });
  const uyarilar = [...ag.uyarilar];
  const atlanan = ag.sayac.cizgi + ag.sayac.nokta;
  if (atlanan) {
    uyarilar.push(
      `STL yalnızca üçgen yüzey taşır: ${ag.sayac.cizgi} çizgi ve ${ag.sayac.nokta} nokta parçası atlandı.`,
    );
  }
  const liste = ucgenler(ag.parcalar);
  if (!liste.length) uyarilar.push('Yazılacak yüzey (poligon) yok; STL dosyası 0 üçgen içeriyor.');
  const merkez = merkezMetni(ag.merkez);
  const ozet = `${liste.length} üçgen; merkez ötelemesi (mutlak = dosya + merkez): ${merkez}`;

  if (s.ascii === true) {
    const ad = `GeoConverterProEA_merkez_${ag.merkez.map(sayiMetni).join('_')}`;
    const satirlar = [`solid ${ad}`];
    for (const [a, b, c] of liste) {
      const n = normalHesapla(a, b, c);
      satirlar.push(
        `  facet normal ${n.map(ascii).join(' ')}`,
        '    outer loop',
        ...[a, b, c].map((v) => `      vertex ${v.map(ascii).join(' ')}`),
        '    endloop',
        '  endfacet',
      );
    }
    satirlar.push(`endsolid ${ad}`);
    const veri = `${satirlar.join('\n')}\n`;
    const onizleme = satirlar.length > 200 ? `${satirlar.slice(0, 200).join('\n')}\n… (${ozet})` : veri;
    return { veri, onizleme, uyarilar };
  }

  const bayt = new Uint8Array(84 + liste.length * 50);
  const dv = new DataView(bayt.buffer);
  // Başlık: yalnızca yazdırılabilir ASCII, en çok 80 bayt, "solid" ile başlamaz.
  // Merkez tam hassasiyetle sığmazsa milimetreye yuvarlanır (öteleme için fazlasıyla yeterli).
  let baslik = `GeoConverterProEA merkez=${ag.merkez.map(sayiMetni).join(',')}`;
  if (baslik.length > 80) {
    baslik = `GeoConverterProEA merkez=${ag.merkez.map((v) => sayiMetni(Number(v.toFixed(3)))).join(',')}`;
    uyarilar.push('STL başlığına sığması için merkez ötelemesi milimetreye yuvarlanarak yazıldı.');
  }
  baslik = baslik.replace(/[^\x20-\x7E]/g, '?').slice(0, 80);
  for (let i = 0; i < baslik.length; i++) bayt[i] = baslik.charCodeAt(i);
  dv.setUint32(80, liste.length, true);
  let o = 84;
  for (const [a, b, c] of liste) {
    for (const x of [...normalHesapla(a, b, c), ...a, ...b, ...c]) {
      dv.setFloat32(o, x, true);
      o += 4;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  const onizleme = [
    'İkili STL (little-endian)',
    `Başlık: ${baslik}`,
    `Üçgen sayısı: ${liste.length}`,
    `Dosya boyutu: ${bayt.length} bayt`,
    `Merkez ötelemesi: ${merkez}`,
    'Eksen: Z yukarı',
  ].join('\n');
  return { veri: bayt, onizleme, uyarilar };
}
