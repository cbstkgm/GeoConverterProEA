// Bağımlılıksız: verinin coğrafi konumuna göre ITRF96 / 3° TM dilimini (EPSG:5253–5259) bulur.
// Arayüz ana paketinde kullanıldığı için hiçbir kütüphane import etmez.

/** ITRF96 / 3° TM dilimlerinin dilim orta meridyenleri (DOM) ve EPSG kodları. */
export const ITRF96_DILIMLERI = Object.freeze(
  [27, 30, 33, 36, 39, 42, 45].map((dom, i) => Object.freeze({ dom, kod: `EPSG:${5253 + i}` })),
);

const ITRF96_KODLARI = new Set(ITRF96_DILIMLERI.map((d) => d.kod));

export const itrf96Mi = (kod) => ITRF96_KODLARI.has(kod);

/**
 * Boylama (derece, WGS84) göre ITRF96 3° TM dilimi.
 * Her dilim DOM ± 1,5° aralığını kapsar; Türkiye dışındaki boylamlar en yakın dilime sıkıştırılır.
 * Dönüş: { kod, dom, disarida } — disarida: boylam 25,5°–46,5° aralığı dışında.
 */
export function boylamdanItrf96Dilimi(boylam) {
  if (!Number.isFinite(boylam)) return null;
  const ham = Math.round(boylam / 3) * 3;
  const dom = Math.min(45, Math.max(27, ham));
  const kod = ITRF96_DILIMLERI.find((d) => d.dom === dom).kod;
  return { kod, dom, disarida: boylam < 25.5 || boylam > 46.5 };
}

function boylamAraligi(fc) {
  let min = Infinity;
  let max = -Infinity;
  const gez = (k) => {
    if (!Array.isArray(k)) return;
    if (typeof k[0] === 'number') {
      if (Number.isFinite(k[0])) {
        if (k[0] < min) min = k[0];
        if (k[0] > max) max = k[0];
      }
      return;
    }
    for (const alt of k) gez(alt);
  };
  const geometriGez = (g) => {
    if (!g) return;
    if (g.type === 'GeometryCollection') (g.geometries || []).forEach(geometriGez);
    else gez(g.coordinates);
  };
  for (const f of fc?.features || []) geometriGez(f?.geometry);
  return min === Infinity ? null : [min, max];
}

/**
 * WGS84 boylam/enlem FeatureCollection'ın sınır kutusu ortasına göre ITRF96 dilimini seçer.
 * Dönüş: null (koordinat yok) veya
 *   { kod, dom, boylam, disarida, coklu, dilimler } — coklu: veri birden çok dilime yayılıyor.
 */
export function veridenItrf96Dilimi(fcWgs84) {
  const aralik = boylamAraligi(fcWgs84);
  if (!aralik) return null;
  const [min, max] = aralik;
  const orta = (min + max) / 2;
  const secim = boylamdanItrf96Dilimi(orta);
  const ilk = boylamdanItrf96Dilimi(min).dom;
  const son = boylamdanItrf96Dilimi(max).dom;
  const dilimler = ITRF96_DILIMLERI.filter((d) => d.dom >= ilk && d.dom <= son).map((d) => d.dom);
  return { ...secim, boylam: orta, coklu: dilimler.length > 1, dilimler };
}
