// M5 — islemci.js'yi mesaj protokolüyle saran Web Worker.
//
// İstek  (ana → worker): { id: number, tip: 'oku' | 'donustur' | 'wgs84e', yuk }
//   oku      → yuk: { ad: string, veri: ArrayBuffer }            (veri transfer edilir)
//   donustur → yuk: { geojson, hedefUzanti, secenekler }
//   wgs84e   → yuk: { geojson, kaynakCrs }
// Yanıt  (worker → ana):
//   { id, tip: 'ilerleme', ilerleme: { yuzde, asama } }
//   { id, tip: 'sonuc', sonuc }                                   (Uint8Array çıktı transfer edilir)
//   { id, tip: 'hata', hata: { ad, mesaj, yigin } }

import { istekIsle } from './islemci.js';

/** Sonuç içindeki ikili çıktının tamponunu transfer listesine ekler. */
function transferListesi(tip, sonuc) {
  if (tip !== 'donustur') return [];
  const veri = sonuc?.sonuc?.veri;
  if (veri instanceof Uint8Array && veri.buffer instanceof ArrayBuffer && veri.buffer.byteLength > 0) {
    return [veri.buffer];
  }
  return [];
}

function hataNesnesi(hata) {
  if (hata instanceof Error) {
    return { ad: hata.name, mesaj: hata.message, yigin: hata.stack ?? null };
  }
  return { ad: 'Error', mesaj: String(hata ?? 'Bilinmeyen hata'), yigin: null };
}

self.addEventListener('message', async (olay) => {
  const { id, tip, yuk } = olay.data || {};
  if (typeof id !== 'number') return;

  const ilerle = (ilerleme) => {
    self.postMessage({ id, tip: 'ilerleme', ilerleme });
  };

  try {
    const sonuc = await istekIsle(tip, yuk, ilerle);
    try {
      self.postMessage({ id, tip: 'sonuc', sonuc }, transferListesi(tip, sonuc));
    } catch {
      // Transfer edilemeyen (ör. paylaşılan) tampon: kopyalayarak gönder.
      self.postMessage({ id, tip: 'sonuc', sonuc });
    }
  } catch (hata) {
    self.postMessage({ id, tip: 'hata', hata: hataNesnesi(hata) });
  }
});
