import { useEffect, useRef, useState } from 'react';

const AZAMI_GOSTERIM = 50000;

function kisalt(metin) {
  if (!metin) return '';
  if (metin.length <= AZAMI_GOSTERIM) return metin;
  return (
    metin.slice(0, AZAMI_GOSTERIM) +
    '\n\n============================================\n' +
    `[UYARI]: Veri çok büyük olduğu için (${metin.length.toLocaleString('tr-TR')} karakter) ` +
    'yalnızca ilk 50.000 karakter gösteriliyor.\n' +
    "Verinin tamamı için 'Kopyala' veya 'İndir' düğmelerini kullanın.\n" +
    '============================================'
  );
}

/**
 * metin: ekranda gösterilecek (kırpılabilir) metin.
 * kopyalanacak: panoya kopyalanacak TAM metin (verilmezse metin kullanılır).
 */
export default function MetinOnizleme({ id, baslik, metin, kopyalanacak, placeholder, onHata }) {
  const [kopyalandi, setKopyalandi] = useState(false);
  const zamanlayici = useRef(null);

  useEffect(() => () => clearTimeout(zamanlayici.current), []);

  const kopyala = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Tarayıcı pano erişimini desteklemiyor.');
      await navigator.clipboard.writeText(kopyalanacak ?? metin);
      setKopyalandi(true);
      clearTimeout(zamanlayici.current);
      zamanlayici.current = setTimeout(() => setKopyalandi(false), 2000);
    } catch (err) {
      onHata?.(`Panoya kopyalanamadı: ${err?.message || err}`);
    }
  };

  return (
    <div className="metin-kutusu-kapsayici">
      <div className="metin-kutusu-baslik">
        <label htmlFor={id}>{baslik}</label>
        <button type="button" onClick={kopyala} className="kopyala-butonu" disabled={!metin}>
          {kopyalandi ? '✅ Kopyalandı' : '📋 Kopyala'}
        </button>
      </div>
      <textarea id={id} readOnly value={kisalt(metin)} placeholder={placeholder} spellCheck={false} />
    </div>
  );
}
