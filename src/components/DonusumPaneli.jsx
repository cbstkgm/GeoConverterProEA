import { KOORDINAT_SISTEMLERI, GEOMETRI_TIPI_SECENEKLERI } from '../lib/katalog';
import HedefFormatSecici from './HedefFormatSecici';
import { tabakaAdi } from '../lib/gml';

const HASSASIYETLER = [2, 3, 4, 5, 6, 7, 8];

function CrsSecici({ id, etiket, deger, onDegistir, devreDisi, not, notHata, eylem }) {
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
        <small id={`${id}-not`} className={`alan-notu${notHata ? ' alan-notu-hata' : ''}`}>
          {not}
          {eylem && (
            <>
              {' '}
              <button type="button" className="metin-buton" onClick={eylem.onTikla} disabled={devreDisi}>
                {eylem.etiket}
              </button>
            </>
          )}
        </small>
      )}
    </div>
  );
}

function TkgmAyarlari({ deger, onDegistir, devreDisi }) {
  const bos = !deger || !String(deger).trim();
  const tabaka = bos ? null : tabakaAdi(deger);
  let not;
  if (bos) not = 'Boş bırakılırsa verideki "nkd" sütunu kullanılır; o da yoksa tabaka "TK_PARSEL" olur.';
  else if (tabaka) not = `Tabaka: ${tabaka} (verideki "nkd" sütunu varsa o önceliklidir). Parsel adı "ada/parsel" biçiminde yazılır.`;
  else not = "Geçersiz değer: 0,01 ile 9,99 m arasında girin (ör. 0,21).";
  return (
    <div className="form-grubu tkgm-ayarlari">
      <label htmlFor="nkd">Nokta konum doğruluğu (m) — TKGM tabaka adı</label>
      <input
        id="nkd"
        type="text"
        inputMode="decimal"
        className="format-arama"
        placeholder="ör. 0,21 → TK_PARSEL_021"
        value={deger}
        onChange={(e) => onDegistir(e.target.value)}
        disabled={devreDisi}
        aria-invalid={!bos && !tabaka}
        aria-describedby="nkd-not"
        autoComplete="off"
      />
      <small id="nkd-not" className={`alan-notu${!bos && !tabaka ? ' alan-notu-hata' : ''}`}>
        {not}
      </small>
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
  hedefCrsNotu,
  onHedefCrsOtomatik,
  zTemizle,
  onZTemizle,
  hassasiyet,
  onHassasiyet,
  geometriTipi,
  onGeometriTipi,
  noktaKonumDogrulugu,
  onNoktaKonumDogrulugu,
  onBaslat,
  baslatilabilir,
  mesgul,
  ilerleme,
}) {
  const yuzde = Math.max(0, Math.min(100, Math.round(ilerleme?.yuzde ?? 0)));

  return (
    <div className="fluent-panel kontrol-paneli">
      <h2 className="panel-baslik">Dönüşüm Ayarları</h2>

      <HedefFormatSecici deger={hedefFormat} onDegistir={onHedefFormat} devreDisi={mesgul} />

      {hedefFormat === '.gml' && (
        <TkgmAyarlari deger={noktaKonumDogrulugu} onDegistir={onNoktaKonumDogrulugu} devreDisi={mesgul} />
      )}

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
          not={hedefCrsNotu?.metin ?? null}
          notHata={Boolean(hedefCrsNotu?.hata)}
          eylem={onHedefCrsOtomatik ? { etiket: 'Konuma göre seç', onTikla: onHedefCrsOtomatik } : null}
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

      <div className="form-grubu">
        <label htmlFor="geometri-tipi">Geometri tipi</label>
        <select
          id="geometri-tipi"
          value={geometriTipi ?? ''}
          onChange={(e) => onGeometriTipi(e.target.value === '' ? null : e.target.value)}
          disabled={mesgul}
        >
          {GEOMETRI_TIPI_SECENEKLERI.map((s) => (
            <option key={s.deger ?? 'yok'} value={s.deger ?? ''}>
              {s.ad}
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
