import { KOORDINAT_SISTEMLERI } from '../lib/katalog';
import { TARAYICI_FORMATLARI, PLANLANAN_GRUPLAR } from './formatSecenekleri';

const HASSASIYETLER = [2, 3, 4, 5, 6, 7, 8];

function CrsSecici({ id, etiket, deger, onDegistir, devreDisi, not }) {
  return (
    <div className="form-grubu">
      <label htmlFor={id}>{etiket}</label>
      <select
        id={id}
        value={deger}
        onChange={(e) => onDegistir(e.target.value)}
        disabled={devreDisi}
        aria-describedby={not ? `${id}-not` : undefined}
      >
        {KOORDINAT_SISTEMLERI.map((k) => (
          <option key={k.kod} value={k.kod}>
            {k.ad}
          </option>
        ))}
      </select>
      {not && (
        <small id={`${id}-not`} className="alan-notu">
          {not}
        </small>
      )}
    </div>
  );
}

export default function DonusumPaneli({
  hedefFormat,
  onHedefFormat,
  kaynakCrs,
  onKaynakCrs,
  hedefCrs,
  onHedefCrs,
  hedefCrsKilitli,
  zTemizle,
  onZTemizle,
  hassasiyet,
  onHassasiyet,
  onBaslat,
  baslatilabilir,
  mesgul,
  ilerleme,
}) {
  const yuzde = Math.max(0, Math.min(100, Math.round(ilerleme?.yuzde ?? 0)));

  return (
    <div className="fluent-panel kontrol-paneli">
      <h2 className="panel-baslik">Dönüşüm Ayarları</h2>

      <div className="form-grubu">
        <label htmlFor="hedef-format">Hedef format</label>
        <select
          id="hedef-format"
          value={hedefFormat}
          onChange={(e) => onHedefFormat(e.target.value)}
          disabled={mesgul}
        >
          <optgroup label="Tarayıcıda desteklenen">
            {TARAYICI_FORMATLARI.map((f) => (
              <option key={`t-${f.uzanti}`} value={f.uzanti}>
                {f.aciklama} ({f.uzanti})
              </option>
            ))}
          </optgroup>
          {PLANLANAN_GRUPLAR.map((g) => (
            <optgroup key={g.kategori} label={`${g.kategori} — yakında`}>
              {g.formatlar.map((f) => (
                <option key={`${g.kategori}-${f.uzanti}`} value={f.uzanti} disabled>
                  {f.aciklama} ({f.uzanti}) (yakında)
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="crs-izgara">
        <CrsSecici
          id="kaynak-crs"
          etiket="Kaynak koordinat sistemi"
          deger={kaynakCrs}
          onDegistir={onKaynakCrs}
          devreDisi={mesgul}
        />
        <CrsSecici
          id="hedef-crs"
          etiket="Hedef koordinat sistemi"
          deger={hedefCrs}
          onDegistir={onHedefCrs}
          devreDisi={mesgul || hedefCrsKilitli}
          not={hedefCrsKilitli ? 'KML/KMZ standardı yalnızca WGS84 (EPSG:4326) koordinatlarını kabul eder.' : null}
        />
      </div>

      <div className="form-grubu">
        <label htmlFor="hassasiyet">Koordinat hassasiyeti</label>
        <select
          id="hassasiyet"
          value={hassasiyet ?? ''}
          onChange={(e) => onHassasiyet(e.target.value === '' ? null : Number(e.target.value))}
          disabled={mesgul}
        >
          <option value="">Değiştirme</option>
          {HASSASIYETLER.map((b) => (
            <option key={b} value={b}>
              {b} ondalık basamak
            </option>
          ))}
        </select>
      </div>

      <label className="onay-kutusu">
        <input type="checkbox" checked={zTemizle} onChange={(e) => onZTemizle(e.target.checked)} disabled={mesgul} />
        Z değerlerini kaldır
      </label>

      <button type="button" className="fluent-buton" onClick={onBaslat} disabled={!baslatilabilir || mesgul}>
        {mesgul ? 'İşleniyor…' : 'Dönüştürmeyi Başlat'}
      </button>

      <div
        className={`ilerleme-kapsayici${ilerleme ? ' aktif' : ''}`}
        role="progressbar"
        aria-label="İşlem ilerlemesi"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ilerleme ? yuzde : undefined}
        aria-valuetext={ilerleme ? `%${yuzde} ${ilerleme.asama ?? ''}`.trim() : undefined}
      >
        <div className="ilerleme-cubugu" style={{ width: `${yuzde}%` }} />
      </div>
      {ilerleme?.asama && <p className="sonuc-bilgi">{ilerleme.asama} (%{yuzde})</p>}
    </div>
  );
}
