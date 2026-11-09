import { useId, useMemo, useState } from 'react';
import { TARAYICI_FORMATLARI, PLANLANAN_GRUPLAR, aramaMetni, formatEslesir } from './formatSecenekleri';

const AZAMI_LISTE_YUKSEKLIGI = 8;

export default function HedefFormatSecici({ deger, onDegistir, devreDisi }) {
  const [arama, setArama] = useState('');
  const kimlik = useId();
  const aramaId = `${kimlik}-arama`;
  const ozetId = `${kimlik}-ozet`;
  const aramaVar = aramaMetni(arama) !== '';

  const { tarayici, planlanan, eslesmeSayisi } = useMemo(() => {
    const t = TARAYICI_FORMATLARI.filter((f) => formatEslesir(f, 'Tarayıcıda desteklenen', arama));
    const p = PLANLANAN_GRUPLAR.map((g) => ({
      kategori: g.kategori,
      formatlar: g.formatlar.filter((f) => formatEslesir(f, g.kategori, arama)),
    })).filter((g) => g.formatlar.length > 0);
    return { tarayici: t, planlanan: p, eslesmeSayisi: t.length + p.reduce((n, g) => n + g.formatlar.length, 0) };
  }, [arama]);

  // Seçili format filtrede yoksa da listede kalsın; yoksa <select> yanlış değeri gösterir.
  const seciliFiltredeYok = !tarayici.some((f) => f.uzanti === deger);
  const seciliFormat = TARAYICI_FORMATLARI.find((f) => f.uzanti === deger);

  const tusBasildi = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (tarayici[0]) {
        onDegistir(tarayici[0].uzanti);
        setArama('');
      }
    } else if (e.key === 'Escape') {
      setArama('');
    }
  };

  let ozet = '';
  if (aramaVar) {
    if (eslesmeSayisi === 0) ozet = 'Eşleşen format yok.';
    else if (tarayici.length === 0) ozet = `${eslesmeSayisi} eşleşme var, ancak hiçbiri henüz desteklenmiyor (yakında).`;
    else ozet = `${tarayici.length} desteklenen format bulundu${planlanan.length ? `, ${eslesmeSayisi - tarayici.length} tanesi yakında` : ''}. Enter ile ilkini seçin.`;
  }

  const listeBoyu = Math.min(AZAMI_LISTE_YUKSEKLIGI, Math.max(2, eslesmeSayisi + planlanan.length + 1 + (seciliFiltredeYok ? 1 : 0)));

  return (
    <div className="form-grubu">
      <label htmlFor="hedef-format">Hedef format</label>
      <input
        id={aramaId}
        type="search"
        className="format-arama"
        placeholder="Format ara (ör. kml, netcad, nokta bulutu)"
        value={arama}
        onChange={(e) => setArama(e.target.value)}
        onKeyDown={tusBasildi}
        disabled={devreDisi}
        aria-label="Hedef formatlarda ara"
        aria-controls="hedef-format"
        aria-describedby={aramaVar ? ozetId : undefined}
        autoComplete="off"
      />
      <select
        id="hedef-format"
        value={deger}
        onChange={(e) => onDegistir(e.target.value)}
        disabled={devreDisi}
        // Arama varken eşleşmeler açılır liste açılmadan, doğrudan görünür liste olarak gösterilir.
        size={aramaVar ? listeBoyu : undefined}
        className={aramaVar ? 'format-liste-acik' : undefined}
      >
        {seciliFiltredeYok && seciliFormat && (
          <option value={seciliFormat.uzanti}>
            Seçili: {seciliFormat.aciklama} ({seciliFormat.uzanti})
          </option>
        )}
        {tarayici.length > 0 && (
          <optgroup label="Tarayıcıda desteklenen">
            {tarayici.map((f) => (
              <option key={`t-${f.uzanti}`} value={f.uzanti}>
                {f.aciklama} ({f.uzanti})
              </option>
            ))}
          </optgroup>
        )}
        {planlanan.map((g) => (
          <optgroup key={g.kategori} label={`${g.kategori} — yakında`}>
            {g.formatlar.map((f) => (
              <option key={`${g.kategori}-${f.uzanti}`} value={f.uzanti} disabled>
                {f.aciklama} ({f.uzanti}) (yakında)
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {aramaVar && (
        <small id={ozetId} className="alan-notu" role="status">
          {ozet}
        </small>
      )}
    </div>
  );
}
