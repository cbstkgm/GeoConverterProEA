import { desteklenen_formatlar } from '../data/formatlar';

// Tarayıcıda yazılabilen formatlar ayrı ve en üstte; planlananlar kategorileriyle, devre dışı.
// `durum` alanı olmayan format güvenli tarafta kalınarak 'planlanan' sayılır.
export const TARAYICI_FORMATLARI = desteklenen_formatlar.flatMap((g) =>
  g.formatlar.filter((f) => f.durum === 'tarayici'),
);

export const PLANLANAN_GRUPLAR = desteklenen_formatlar
  .map((g) => ({ kategori: g.kategori, formatlar: g.formatlar.filter((f) => f.durum !== 'tarayici') }))
  .filter((g) => g.formatlar.length > 0);

export const VARSAYILAN_HEDEF =
  TARAYICI_FORMATLARI.find((f) => f.uzanti === '.wkt')?.uzanti ?? TARAYICI_FORMATLARI[0]?.uzanti ?? '';

// Türkçe karakter yazmadan da bulunabilsin: "gorunum" → "görünüm", "Iges" → "ıges/iges".
const KATLAMA = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
export function aramaMetni(metin) {
  return String(metin ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]/g, (h) => KATLAMA[h])
    .replace(/\s+/g, ' ')
    .trim();
}

/** Aramadaki her kelime format adı, uzantısı veya kategorisinde geçmeli. */
export function formatEslesir(format, kategori, arama) {
  const kelimeler = aramaMetni(arama).split(' ').filter(Boolean);
  if (kelimeler.length === 0) return true;
  const hedef = aramaMetni(`${format.aciklama} ${format.uzanti} ${kategori ?? ''}`);
  return kelimeler.every((k) => hedef.includes(k));
}
