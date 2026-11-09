import { useCallback, useMemo, useRef, useState } from 'react';
import { useDonusturucu, iptalHatasiMi } from './hooks/useDonusturucu';
import Harita from './components/Harita';
import DosyaYukleyici from './components/DosyaYukleyici';
import DonusumPaneli from './components/DonusumPaneli';
import { VARSAYILAN_HEDEF } from './components/formatSecenekleri';
import MetinOnizleme from './components/MetinOnizleme';
import IstatistikKarti from './components/IstatistikKarti';
import Bildirim from './components/Bildirim';
import { WGS84, wgs84ZorunluMu } from './lib/katalog';
import './App.css';
const KAYNAK_RENK = '#ff4c4c';
const SONUC_RENK = '#4cc2ff';

const hataMesaji = (err) => err?.message || String(err);

function indirmeAdi(orijinalAd, uzanti) {
  const kok = (orijinalAd || 'donusturulmus_veri').replace(/\.[^./\\]+$/, '') || 'donusturulmus_veri';
  return kok + uzanti;
}

function dosyayiIndir(veri, mime, ad) {
  // string veya Uint8Array doğrudan BlobPart olarak verilir (ikili veri metne çevrilmez).
  const blob = new Blob([veri], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const baglanti = document.createElement('a');
  baglanti.href = url;
  baglanti.download = ad;
  document.body.appendChild(baglanti);
  baglanti.click();
  baglanti.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function App() {
  const { oku, donustur, wgs84e, mesgul, ilerleme } = useDonusturucu();

  const [dosya, setDosya] = useState(null);
  const [kaynak, setKaynak] = useState(null); // { geojson, uyarilar, istatistik, tahminiCrs }
  const [kaynakHarita, setKaynakHarita] = useState(null);
  const [sonuc, setSonuc] = useState(null); // { sonuc, haritaGeojson, istatistik }

  const [hedefFormat, setHedefFormat] = useState(VARSAYILAN_HEDEF);
  const [kaynakCrs, setKaynakCrs] = useState(WGS84);
  const [secilenHedefCrs, setHedefCrs] = useState(WGS84);
  // KML/KMZ yalnızca WGS84 taşıyabilir: bu formatlarda kullanıcının seçimi korunur ama uygulanmaz.
  const hedefCrsKilitli = wgs84ZorunluMu(hedefFormat);
  const hedefCrs = hedefCrsKilitli ? WGS84 : secilenHedefCrs;
  const [zTemizle, setZTemizle] = useState(false);
  const [hassasiyet, setHassasiyet] = useState(null);
  const [geometriTipi, setGeometriTipi] = useState(null);

  const [bildirim, setBildirim] = useState(null);
  const istekNo = useRef(0);

  const bildir = useCallback((tur, mesaj) => setBildirim({ tur, mesaj }), []);
  const hataBildir = useCallback((mesaj) => bildir('hata', mesaj), [bildir]);

  const kaynakHaritasiniHazirla = async (geojson, crs, no) => {
    if (crs === WGS84) {
      setKaynakHarita(geojson);
      return;
    }
    try {
      const donmus = await wgs84e(geojson, crs);
      if (no === istekNo.current) setKaynakHarita(donmus);
    } catch (err) {
      if (no !== istekNo.current || iptalHatasiMi(err)) return;
      setKaynakHarita(null);
      hataBildir(`Kaynak harita için ${crs} → WGS84 dönüşümü yapılamadı: ${hataMesaji(err)}`);
    }
  };

  const dosyaSecildi = async (yeniDosya) => {
    const no = ++istekNo.current;
    setDosya(yeniDosya);
    setKaynak(null);
    setKaynakHarita(null);
    setSonuc(null);
    bildir('bilgi', `'${yeniDosya.name}' okunuyor…`);
    try {
      const okunan = await oku(yeniDosya);
      if (no !== istekNo.current) return;
      const crs = okunan.tahminiCrs || WGS84;
      setKaynak(okunan);
      setKaynakCrs(crs);
      const ozet = `'${yeniDosya.name}' okundu: ${okunan.istatistik?.objeSayisi ?? okunan.geojson.features.length} obje.`;
      if (!okunan.tahminiCrs && okunan.istatistik?.koordinatSayisi > 0) {
        // Koordinatlar WGS84 aralığında değil: yanlış yerde çizmek yerine kullanıcıdan CRS iste.
        bildir('bilgi', `${ozet} Koordinatlar WGS84 aralığında değil; haritada görmek için kaynak koordinat sistemini seçin.`);
        return;
      }
      bildir('basari', ozet);
      await kaynakHaritasiniHazirla(okunan.geojson, crs, no);
    } catch (err) {
      if (no !== istekNo.current || iptalHatasiMi(err)) return;
      hataBildir(`Dosya okunamadı: ${hataMesaji(err)}`);
    }
  };

  const kaynakCrsDegisti = (crs) => {
    setKaynakCrs(crs);
    setSonuc(null);
    if (kaynak) {
      const no = ++istekNo.current;
      kaynakHaritasiniHazirla(kaynak.geojson, crs, no);
    }
  };

  const donusumuBaslat = async () => {
    if (!kaynak) return;
    const no = ++istekNo.current;
    try {
      const yeni = await donustur(kaynak.geojson, hedefFormat, { kaynakCrs, hedefCrs, zTemizle, hassasiyet, geometriTipi });
      if (no !== istekNo.current) return;
      setSonuc(yeni);
      bildir('basari', `Dönüştürüldü: '${dosya.name}' → ${yeni.sonuc.uzanti} (${hedefCrs}).`);
    } catch (err) {
      if (no !== istekNo.current || iptalHatasiMi(err)) return;
      hataBildir(`Dönüşüm başarısız: ${hataMesaji(err)}`);
    }
  };

  const indir = () => {
    if (!sonuc) return;
    const { veri, mime, uzanti } = sonuc.sonuc;
    const ad = indirmeAdi(dosya?.name, uzanti);
    try {
      dosyayiIndir(veri, mime, ad);
      bildir('basari', `'${ad}' indirildi.`);
    } catch (err) {
      hataBildir(`İndirme başarısız: ${hataMesaji(err)}`);
    }
  };

  const kaynakMetni = useMemo(() => (kaynak ? JSON.stringify(kaynak.geojson, null, 2) : ''), [kaynak]);
  const sonucOnizleme = sonuc?.sonuc.onizleme ?? '';
  const sonucKopya = typeof sonuc?.sonuc.veri === 'string' ? sonuc.sonuc.veri : sonucOnizleme;

  return (
    <div className="uygulama-kapsayici">
      <header className="baslik-alani">
        <h1>GeoConverterProEA</h1>
        <p className="aciklama">Gelişmiş Harita &amp; Geometri Dönüştürücüsü — veriler tarayıcıdan çıkmaz</p>
        <Bildirim bildirim={bildirim} onKapat={() => setBildirim(null)} />
      </header>

      <main className="grid-kapsayici">
        <section className="fluent-panel" aria-labelledby="kaynak-baslik">
          <h2 id="kaynak-baslik" className="panel-baslik">1. Kaynak Veri</h2>
          <DosyaYukleyici dosyaAdi={dosya?.name} onDosya={dosyaSecildi} devreDisi={mesgul} />

          <div className="harita-alani harita-kaynak">
            {kaynakHarita ? (
              <Harita veri={kaynakHarita} renk={KAYNAK_RENK} etiket="Kaynak veri haritası" />
            ) : (
              <div className="harita-bos">Harita (Kaynak)</div>
            )}
          </div>

          <IstatistikKarti baslik="Kaynak istatistikleri" istatistik={kaynak?.istatistik} uyarilar={kaynak?.uyarilar} />

          <MetinOnizleme
            id="kaynak-metin"
            baslik="Kaynak veri (GeoJSON)"
            metin={kaynakMetni}
            placeholder="Dosya seçildiğinde GeoJSON karşılığı burada görünecek..."
            onHata={hataBildir}
          />
        </section>

        <DonusumPaneli
          hedefFormat={hedefFormat}
          onHedefFormat={setHedefFormat}
          kaynakCrs={kaynakCrs}
          onKaynakCrs={kaynakCrsDegisti}
          hedefCrs={hedefCrs}
          onHedefCrs={setHedefCrs}
          hedefCrsKilitli={hedefCrsKilitli}
          zTemizle={zTemizle}
          onZTemizle={setZTemizle}
          hassasiyet={hassasiyet}
          geometriTipi={geometriTipi}
          onGeometriTipi={setGeometriTipi}
          onHassasiyet={setHassasiyet}
          onBaslat={donusumuBaslat}
          baslatilabilir={Boolean(kaynak && hedefFormat)}
          mesgul={mesgul}
          ilerleme={ilerleme}
        />

        <section className="fluent-panel" aria-labelledby="sonuc-baslik">
          <h2 id="sonuc-baslik" className="panel-baslik">2. Sonuç Veri</h2>

          <div className="harita-alani harita-sonuc">
            {sonuc?.haritaGeojson ? (
              <Harita veri={sonuc.haritaGeojson} renk={SONUC_RENK} etiket="Sonuç veri haritası" />
            ) : (
              <div className="harita-bos">Harita (Sonuç)</div>
            )}
          </div>

          <IstatistikKarti baslik="Sonuç istatistikleri" istatistik={sonuc?.istatistik} uyarilar={sonuc?.uyarilar} />

          <MetinOnizleme
            id="sonuc-metin"
            baslik={`Dönüştürülen veri${sonuc ? ` (${sonuc.sonuc.uzanti})` : ''}`}
            metin={sonucOnizleme}
            kopyalanacak={sonucKopya}
            placeholder="Dönüşüm tamamlandığında çıktı burada görünecek..."
            onHata={hataBildir}
          />

          <div className="buton-grubu">
            <button type="button" className="fluent-buton" disabled={!sonuc} onClick={indir}>
              ⬇️ Dosyayı İndir{sonuc ? ` (${indirmeAdi(dosya?.name, sonuc.sonuc.uzanti)})` : ''}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
