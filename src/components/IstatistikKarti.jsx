const sayi = (n) => (typeof n === 'number' ? n.toLocaleString('tr-TR') : '—');
const koord = (n) => (Number.isFinite(n) ? Number(n.toFixed(6)).toString() : '?');

function GecerlilikOzeti({ gecerlilik }) {
  const { denetlenen, gecerli, gecersiz, sorunlar, kesildi } = gecerlilik;
  if (denetlenen === 0) return null;
  return (
    <div className={`gecerlilik ${gecersiz > 0 ? 'gecerlilik-hatali' : 'gecerlilik-tamam'}`} role={gecersiz > 0 ? 'alert' : undefined}>
      <p className="gecerlilik-ozet">
        {gecersiz === 0
          ? `✅ Geometriler geçerli (${sayi(gecerli)} / ${sayi(denetlenen)})`
          : `❌ ${sayi(gecersiz)} geçersiz geometri (${sayi(denetlenen)} geometriden)`}
      </p>
      {sorunlar.length > 0 && (
        <ul className="gecerlilik-listesi" aria-label="Geçersiz geometriler">
          {sorunlar.map((s, i) => (
            <li key={i}>
              <strong>Obje {sayi(s.obje)}</strong> ({s.tip}): {s.neden}
              {s.konum && <span className="gecerlilik-konum"> — {s.konum.map(koord).join(', ')}</span>}
            </li>
          ))}
          {kesildi && <li>… ve diğerleri (ilk {sorunlar.length} sorun gösteriliyor)</li>}
        </ul>
      )}
    </div>
  );
}

export default function IstatistikKarti({ baslik, istatistik, uyarilar, gecerlilik }) {
  if (!istatistik && !uyarilar?.length) return null;

  const tipler = istatistik ? Object.entries(istatistik.geometriTipleri || {}) : [];
  const bbox = istatistik?.bbox;

  return (
    <section className="istatistik-karti" aria-label={baslik}>
      <h3 className="istatistik-baslik">{baslik}</h3>
      {istatistik && (
        <dl className="istatistik-liste">
          <div>
            <dt>Obje sayısı</dt>
            <dd>{sayi(istatistik.objeSayisi)}</dd>
          </div>
          <div>
            <dt>Koordinat sayısı</dt>
            <dd>{sayi(istatistik.koordinatSayisi)}</dd>
          </div>
          <div>
            <dt>Geometri tipleri</dt>
            <dd>{tipler.length ? tipler.map(([t, n]) => `${t}: ${sayi(n)}`).join(', ') : '—'}</dd>
          </div>
          <div>
            <dt>Z değeri</dt>
            <dd>{istatistik.zIceriyor ? 'Var' : 'Yok'}</dd>
          </div>
          {istatistik.bosGeometriSayisi > 0 && (
            <div>
              <dt>Boş geometri</dt>
              <dd>{sayi(istatistik.bosGeometriSayisi)}</dd>
            </div>
          )}
          <div className="istatistik-genis">
            <dt>Sınırlar (bbox)</dt>
            <dd className="istatistik-bbox">{bbox ? bbox.map(koord).join(', ') : '—'}</dd>
          </div>
        </dl>
      )}
      {gecerlilik && <GecerlilikOzeti gecerlilik={gecerlilik} />}
      {uyarilar?.length > 0 && (
        <ul className="uyari-listesi" aria-label="Uyarılar">
          {uyarilar.map((u, i) => (
            <li key={i}>⚠️ {u}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
