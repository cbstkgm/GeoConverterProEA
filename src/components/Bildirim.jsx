/**
 * Erişilebilir bildirim alanı. Canlı bölgeler (live region) her zaman DOM'da durur;
 * yalnızca içerikleri değişir — ekran okuyucuların duyurması için gereklidir.
 * bildirim: { tur: 'bilgi' | 'basari' | 'hata', mesaj: string } | null
 */
export default function Bildirim({ bildirim, onKapat }) {
  const hata = bildirim?.tur === 'hata';
  const icerik = bildirim && (
    <div className={`bildirim bildirim-${bildirim.tur}`}>
      <span className="bildirim-mesaj">{bildirim.mesaj}</span>
      <button type="button" className="bildirim-kapat" onClick={onKapat} aria-label="Bildirimi kapat">
        ×
      </button>
    </div>
  );

  return (
    <div className="bildirim-alani">
      <div role="alert" aria-atomic="true">
        {hata ? icerik : null}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        {!hata ? icerik : null}
      </div>
    </div>
  );
}
