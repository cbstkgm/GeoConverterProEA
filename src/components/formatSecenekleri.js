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
  TARAYICI_FORMATLARI.find((f) => f.uzanti === '.geojson')?.uzanti ?? TARAYICI_FORMATLARI[0]?.uzanti ?? '';
