// M5 — Dönüştürme işlerini Web Worker'da yürüten React hook'u.
// Worker kullanılamazsa (veya yüklenirken çökerse) islemci.js ana iş parçacığında,
// dinamik import ile ve aynı API'yle çalıştırılır.

import { useCallback, useEffect, useRef, useState } from 'react';

const IPTAL_ADI = 'AbortError';

function iptalHatasi(mesaj) {
  const hata = new Error(mesaj);
  hata.name = IPTAL_ADI;
  return hata;
}

/**
 * Bir hatanın iptal (eskimiş istek ya da bileşen kaldırılması) kaynaklı olup olmadığını söyler.
 * Arayüz bu hataları kullanıcıya göstermemelidir.
 */
export function iptalHatasiMi(hata) {
  return hata?.name === IPTAL_ADI;
}

function workerCokmesiHatasi(ayrinti) {
  const hata = new Error(
    `İşlem birimi (Web Worker) beklenmedik şekilde durdu${ayrinti ? `: ${ayrinti}` : '.'}`,
  );
  hata.workerCokmesi = true;
  return hata;
}

/** Web Worker motoru. Worker oluşturulamazsa null döner. */
function workerMotoruOlustur() {
  if (typeof Worker === 'undefined') return null;
  let worker;
  try {
    worker = new Worker(new URL('../workers/donusturucu.worker.js', import.meta.url), {
      type: 'module',
    });
  } catch {
    return null;
  }

  const bekleyenler = new Map(); // id → { resolve, reject, ilerle }
  let bozuk = false;

  const hepsiniReddet = (hata) => {
    for (const b of bekleyenler.values()) b.reject(hata);
    bekleyenler.clear();
  };

  const cok = (ayrinti) => {
    if (bozuk) return;
    bozuk = true;
    worker.terminate();
    hepsiniReddet(workerCokmesiHatasi(ayrinti));
  };

  worker.onmessage = (olay) => {
    const { id, tip } = olay.data || {};
    const b = bekleyenler.get(id);
    if (!b) return;
    if (tip === 'ilerleme') {
      b.ilerle(olay.data.ilerleme);
    } else if (tip === 'sonuc') {
      bekleyenler.delete(id);
      b.resolve(olay.data.sonuc);
    } else if (tip === 'hata') {
      bekleyenler.delete(id);
      const h = olay.data.hata || {};
      const hata = new Error(h.mesaj || 'Bilinmeyen hata');
      hata.name = h.ad || 'Error';
      if (h.yigin) hata.workerYigini = h.yigin;
      b.reject(hata);
    }
  };
  worker.onerror = (olay) => {
    olay.preventDefault?.();
    cok(olay.message);
  };
  worker.onmessageerror = () => cok('Worker yanıtı çözümlenemedi.');

  return {
    tur: 'worker',
    calistir(id, tip, yuk, transfer, ilerle) {
      return new Promise((resolve, reject) => {
        if (bozuk) {
          reject(workerCokmesiHatasi());
          return;
        }
        bekleyenler.set(id, { resolve, reject, ilerle });
        try {
          worker.postMessage({ id, tip, yuk }, transfer);
        } catch (hata) {
          bekleyenler.delete(id);
          reject(hata);
        }
      });
    },
    kapat(hata) {
      bozuk = true;
      worker.terminate();
      hepsiniReddet(hata);
    },
  };
}

/** Ana iş parçacığı yedek motoru: islemci.js dinamik import ile yüklenir. */
function anaMotorOlustur() {
  let modulSozu = null;
  let kapali = false;
  return {
    tur: 'ana',
    async calistir(id, tip, yuk, _transfer, ilerle) {
      modulSozu ??= import('../workers/islemci.js');
      const { istekIsle } = await modulSozu;
      return istekIsle(tip, yuk, async (i) => {
        if (kapali) throw iptalHatasi('İşlem iptal edildi.');
        ilerle(i);
        // Aşamalar arasında tarayıcıya ekranı boyama fırsatı ver.
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    kapat() {
      kapali = true;
    },
  };
}

function motorOlustur() {
  return workerMotoruOlustur() ?? anaMotorOlustur();
}

/**
 * @returns {{
 *   oku: (file: File) => Promise<{ geojson, uyarilar: string[], istatistik, gecerlilik, tahminiCrs: string | null }>,
 *   donustur: (geojson, hedefUzanti: string, secenekler: { kaynakCrs: string, hedefCrs: string, zTemizle: boolean, hassasiyet: number | null, geometriTipi?: 'Polygon' | 'LineString' | null }) => Promise<{ sonuc, haritaGeojson, istatistik, gecerlilik, uyarilar: string[] }>,
 *   wgs84e: (geojson, kaynakCrs: string) => Promise<object>,
 *   mesgul: boolean,
 *   ilerleme: { yuzde: number, asama: string } | null,
 * }}
 *
 * Aynı türden yeni bir istek başlatıldığında, henüz bitmemiş eski istek `AbortError`
 * ile reddedilir (sonucu yeni durumu ezmez). Unmount'ta bekleyen tüm istekler de
 * `AbortError` ile reddedilir. Bkz. `iptalHatasiMi`.
 */
export function useDonusturucu() {
  const [mesgul, setMesgul] = useState(false);
  const [ilerleme, setIlerleme] = useState(null);

  const motorRef = useRef(null);
  const aktifRef = useRef(false);
  const sayacRef = useRef(0);
  const sonIstekRef = useRef(0);
  const bekleyenRef = useRef(new Map()); // id → { tip, reddet }

  useEffect(() => {
    aktifRef.current = true;
    motorRef.current = motorOlustur();
    const bekleyenler = bekleyenRef.current;
    return () => {
      aktifRef.current = false;
      const hata = iptalHatasi('Bileşen kaldırıldı; işlem iptal edildi.');
      motorRef.current?.kapat(hata);
      motorRef.current = null;
      for (const { reddet } of [...bekleyenler.values()]) reddet(hata);
      bekleyenler.clear();
    };
  }, []);

  const calistir = useCallback((tip, hazirla) => {
    if (!aktifRef.current) {
      return Promise.reject(iptalHatasi('Bileşen etkin değil; işlem başlatılamadı.'));
    }
    const id = ++sayacRef.current;
    sonIstekRef.current = id;
    const bekleyenler = bekleyenRef.current;

    // Aynı türdeki eski istekler eskidi: sonuçları artık kimseyi ilgilendirmez.
    for (const [eskiId, b] of [...bekleyenler]) {
      if (b.tip === tip && eskiId !== id) {
        b.reddet(iptalHatasi('Daha yeni bir istek başlatıldığı için bu istek iptal edildi.'));
      }
    }

    setMesgul(true);
    setIlerleme({ yuzde: 0, asama: 'Hazırlanıyor' });

    return new Promise((resolve, reject) => {
      let bitti = false;

      const sonlandir = () => {
        bitti = true;
        bekleyenler.delete(id);
        if (!aktifRef.current) return;
        if (bekleyenler.size === 0) {
          setMesgul(false);
          setIlerleme(null);
        } else if (sonIstekRef.current === id) {
          // İlerleme sahibi bitti; kalan en yeni isteğe devret.
          sonIstekRef.current = Math.max(...bekleyenler.keys());
        }
      };

      bekleyenler.set(id, {
        tip,
        reddet: (hata) => {
          if (bitti) return;
          sonlandir();
          reject(hata);
        },
      });

      const ilerle = (i) => {
        if (!bitti && aktifRef.current && sonIstekRef.current === id && i) setIlerleme(i);
      };

      (async () => {
        const hazir = await hazirla(ilerle);
        if (bitti) return;
        const motor = motorRef.current;
        if (!motor) throw iptalHatasi('İşlem iptal edildi.');
        try {
          return await motor.calistir(id, tip, hazir.yuk, hazir.transfer ?? [], ilerle);
        } catch (hata) {
          if (!hata?.workerCokmesi || bitti || !aktifRef.current) throw hata;
          // Worker yüklenemedi/çöktü: ana iş parçacığı yedeğine geç ve isteği yeniden dene.
          if (motorRef.current === motor) motorRef.current = anaMotorOlustur();
          const yeniden = await hazirla(ilerle); // aktarılan tampon artık kullanılamaz
          if (bitti) return;
          return motorRef.current.calistir(id, tip, yeniden.yuk, [], ilerle);
        }
      })().then(
        (sonuc) => {
          if (bitti) return;
          sonlandir();
          resolve(sonuc);
        },
        (hata) => {
          if (bitti) return;
          sonlandir();
          reject(hata);
        },
      );
    });
  }, []);

  const oku = useCallback(
    (file) => {
      if (!file || typeof file.arrayBuffer !== 'function') {
        return Promise.reject(new Error('Okunacak dosya seçilmedi.'));
      }
      return calistir('oku', async (ilerle) => {
        ilerle({ yuzde: 1, asama: 'Dosya belleğe alınıyor' });
        const veri = await file.arrayBuffer();
        return { yuk: { ad: file.name, veri }, transfer: [veri] };
      });
    },
    [calistir],
  );

  const donustur = useCallback(
    (geojson, hedefUzanti, secenekler) =>
      calistir('donustur', async () => ({ yuk: { geojson, hedefUzanti, secenekler } })),
    [calistir],
  );

  const wgs84e = useCallback(
    (geojson, kaynakCrs) => calistir('wgs84e', async () => ({ yuk: { geojson, kaynakCrs } })),
    [calistir],
  );

  return { oku, donustur, wgs84e, mesgul, ilerleme };
}
