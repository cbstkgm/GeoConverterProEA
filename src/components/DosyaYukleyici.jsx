import { useRef, useState } from 'react';
import { DESTEKLENEN_GIRDILER } from '../lib/katalog';

const KABUL = DESTEKLENEN_GIRDILER.map((g) => g.uzanti).join(',');
const UZANTI_LISTESI = DESTEKLENEN_GIRDILER.map((g) => g.uzanti).join(', ');

export default function DosyaYukleyici({ dosyaAdi, onDosya, devreDisi }) {
  const girdiRef = useRef(null);
  const [surukleniyor, setSurukleniyor] = useState(false);

  const dosyaSecDiyalogu = () => {
    if (!devreDisi) girdiRef.current?.click();
  };

  const tusaBasildi = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dosyaSecDiyalogu();
    }
  };

  const secildi = (e) => {
    const dosya = e.target.files?.[0];
    // Aynı dosyanın tekrar seçilebilmesi için değer sıfırlanır.
    e.target.value = '';
    if (dosya) onDosya(dosya);
  };

  const suruklemeUstunde = (e) => {
    e.preventDefault();
    if (!surukleniyor) setSurukleniyor(true);
  };

  const suruklemeAyrildi = (e) => {
    // Alt öğeler arasında gezinirken titreşmeyi önle: yalnızca alanın dışına çıkınca kapat.
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setSurukleniyor(false);
  };

  const birakildi = (e) => {
    e.preventDefault();
    setSurukleniyor(false);
    if (devreDisi) return;
    const dosya = e.dataTransfer.files?.[0];
    if (dosya) onDosya(dosya);
  };

  return (
    <div
      className={`dosya-yukleme-alani${surukleniyor ? ' surukleniyor' : ''}${devreDisi ? ' devre-disi' : ''}`}
      role="button"
      tabIndex={0}
      aria-disabled={devreDisi || undefined}
      aria-label={dosyaAdi ? `Seçili dosya: ${dosyaAdi}. Değiştirmek için seçin.` : 'Dosya seç'}
      aria-describedby="dosya-uzantilari"
      onClick={dosyaSecDiyalogu}
      onKeyDown={tusaBasildi}
      onDragEnter={suruklemeUstunde}
      onDragOver={suruklemeUstunde}
      onDragLeave={suruklemeAyrildi}
      onDrop={birakildi}
    >
      <div className="dosya-yukleme-ikon" aria-hidden="true">📂</div>
      <p className="dosya-adi">{dosyaAdi || 'Dosya Seç (Tıklayın veya Sürükleyin)'}</p>
      <p id="dosya-uzantilari" className="dosya-uzantilari">
        Desteklenen: {UZANTI_LISTESI}
      </p>
      <input
        type="file"
        ref={girdiRef}
        className="gizli"
        accept={KABUL}
        onChange={secildi}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}
