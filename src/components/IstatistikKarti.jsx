const sayi = (n) => (typeof n === 'number' ? n.toLocaleString('tr-TR') : '—');
const koord = (n) => (Number.isFinite(n) ? Number(n.toFixed(6)).toString() : '?');

export default function IstatistikKarti({ baslik, istatistik, uyarilar }) {
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
