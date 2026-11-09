// "Satır 12: …" biçimindeki uyarıları mesajlarına göre gruplar; ardışık satırları aralık yapar.
// Binlerce satırlık uyarı listesini okunur birkaç kaleme indirir.

const SATIR_DESENI = /^Satır (\d+)(?:[–-](\d+))?: ([\s\S]*)$/;

function araligaCevir([a, b]) {
  return a === b ? String(a) : `${a}–${b}`;
}

/**
 * @param {string[]} uyarilar
 * @param {number} [azamiAralik=6] kalem başına gösterilecek en fazla satır aralığı
 * @returns {{ metin: string, adet: number }[]} adet: kalemin kapsadığı satır (veya uyarı) sayısı
 */
export function uyarilariGrupla(uyarilar, azamiAralik = 6) {
  const kalemler = new Map(); // anahtar → { tur, mesaj, araliklar, adet }
  for (const u of uyarilar || []) {
    const m = SATIR_DESENI.exec(u);
    if (!m) {
      const kalem = kalemler.get(u) || { tur: 'serbest', mesaj: u, adet: 0 };
      kalem.adet++;
      kalemler.set(u, kalem);
      continue;
    }
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    const anahtar = `satir:${m[3]}`;
    const kalem = kalemler.get(anahtar) || { tur: 'satir', mesaj: m[3], araliklar: [], adet: 0 };
    kalem.araliklar.push([Math.min(a, b), Math.max(a, b)]);
    kalem.adet += Math.abs(b - a) + 1;
    kalemler.set(anahtar, kalem);
  }

  return [...kalemler.values()].map((k) => {
    if (k.tur === 'serbest') {
      return { metin: k.adet > 1 ? `${k.mesaj} (${k.adet} kez)` : k.mesaj, adet: k.adet };
    }
    const sirali = k.araliklar.sort((x, y) => x[0] - y[0]);
    const birlesik = [];
    for (const [a, b] of sirali) {
      const son = birlesik[birlesik.length - 1];
      if (son && a <= son[1] + 1) son[1] = Math.max(son[1], b);
      else birlesik.push([a, b]);
    }
    const gosterilen = birlesik.slice(0, azamiAralik).map(araligaCevir).join(', ');
    const kalan = birlesik.length - azamiAralik;
    const satirlar = kalan > 0 ? `${gosterilen} ve ${kalan} aralık daha` : gosterilen;
    const toplam = k.adet > 1 ? ` (toplam ${k.adet.toLocaleString('tr-TR')} satır)` : '';
    return { metin: `Satır ${satirlar}: ${k.mesaj}${toplam}`, adet: k.adet };
  });
}
