import { useCallback, useMemo, useRef, useState } from 'react';
import { useDonusturucu, iptalHatasiMi } from './hooks/useDonusturucu';
import Harita from './components/Harita';
import DosyaYukleyici from './components/DosyaYukleyici';
import DonusumPaneli from './components/DonusumPaneli';
import { VARSAYILAN_HEDEF } from './components/formatSecenekleri';
import MetinOnizleme from './components/MetinOnizleme';
import IstatistikKarti from './components/IstatistikKarti';
import Bildirim from './components/Bildirim';
import { WGS84, zorunluCrs, indirmeUzantisi } from './lib/katalog';
import { itrf96Mi, veridenItrf96Dilimi } from './lib/dilim';
import './App.css';
const KAYNAK_RENK = '#ff4c4c';
const SONUC_RENK = '#4cc2ff';

const hataMesaji = (err) => err?.message || String(err);

function indirmeAdi(orijinalAd, uzanti) {
  const kok = (orijinalAd || 'donusturulmus_veri').replace(/\.[^./\\]+$/, '') || 'donusturulmus_veri';
  // Klasör tabanlı formatlar (File Geodatabase, MapInfo TAB) ZIP içinde iner: ad.gdb.zip
  return kok + indirmeUzantisi(uzanti);
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

const ondalik = (sayi) => sayi.toFixed(2).replace('.', ',');

function hedefCrsNotuOlustur({ formatCrs, tkgmModu, tkgmOtomatik, otomatikDilim, hedefCrs }) {
  if (formatCrs) return { metin: formatCrs.not };
  if (!tkgmModu) return null;
  if (!tkgmOtomatik) {
    return itrf96Mi(hedefCrs)
      ? { metin: 'Hedef koordinat sistemi elle seçildi.' }
      : { metin: 'TKGM uyumlu GML için ITRF96 / 3° TM önerilir; seçilen sistem TKGM ile uyumsuz olabilir.', hata: true };
  }
  if (!otomatikDilim) {
    return { metin: 'TKGM uyumlu GML: ITRF96 / 3° TM. Veri yüklendiğinde dilim, verinin konumuna göre otomatik seçilir.' };
  }
  let metin = `TKGM uyumlu GML: dilim veri konumuna göre otomatik seçildi (orta boylam ${ondalik(otomatikDilim.boylam)}° → TM ${otomatikDilim.dom}).`;
  if (otomatikDilim.disarida) metin += ' Veri Türkiye dilimlerinin dışında; en yakın dilim seçildi.';
  else if (otomatikDilim.coklu) metin += ` Veri birden çok dilime yayılıyor (DOM ${otomatikDilim.dilimler.join(', ')}); orta dilim kullanıldı.`;
  return { metin, hata: otomatikDilim.disarida };
}

function App() {
  const { oku, donustur, wgs84e, mesgul, ilerleme } = useDonusturucu();

  const [dosya, setDosya] = useState(null);
  const [kaynak, setKaynak] = useState(null); // { geojson, uyarilar, istatistik, tahminiCrs }
  const [sonuc, setSonuc] = useState(null); // { sonuc, haritaGeojson, istatistik }

  const [hedefFormat, setHedefFormat] = useState(VARSAYILAN_HEDEF);
  const [kaynakCrs, setKaynakCrs] = useState(WGS84);
  const [secilenHedefCrs, setSecilenHedefCrs] = useState(WGS84);
  // TKGM GML'de hedef CRS veri konumuna göre otomatik seçilir; kullanıcı elle değiştirirse o korunur.
  const [hedefCrsElle, setHedefCrsElle] = useState(false);
  const [kaynakHarita, setKaynakHarita] = useState(null);
  const otomatikDilim = useMemo(() => (kaynakHarita ? veridenItrf96Dilimi(kaynakHarita) : null), [kaynakHarita]);
  const tkgmModu = hedefFormat === '.gml';
  const tkgmOtomatik = tkgmModu && !hedefCrsElle;
  // KML/KMZ (WGS84) ve MVT (Web Mercator) CRS'i formatın kendisi belirler: kullanıcının seçimi korunur ama uygulanmaz.
  const formatCrs = zorunluCrs(hedefFormat);
  const hedefCrsKilitli = formatCrs !== null;
  let hedefCrs = secilenHedefCrs;
  if (formatCrs) hedefCrs = formatCrs.kod;
  else if (tkgmOtomatik) {
    hedefCrs =
      otomatikDilim?.kod ??
      (itrf96Mi(kaynakCrs) ? kaynakCrs : itrf96Mi(secilenHedefCrs) ? secilenHedefCrs : 'EPSG:5255');
  }
  const hedefCrsNotu = hedefCrsNotuOlustur({ formatCrs, tkgmModu, tkgmOtomatik, otomatikDilim, hedefCrs });

  const hedefCrsSecildi = (crs) => {
    setSecilenHedefCrs(crs);
    if (tkgmModu) setHedefCrsElle(true);
  };
  const hedefFormatSecildi = (uzanti) => {
    setHedefFormat(uzanti);
    setHedefCrsElle(false);
  };
  // Varsayılan: Z (yükseklik) değerleri olmadan, 2B çıktı.
  const [zTemizle, setZTemizle] = useState(true);
  const [hassasiyet, setHassasiyet] = useState(null);
  const [geometriTipi, setGeometriTipi] = useState(null);
  const [noktaKonumDogrulugu, setNoktaKonumDogrulugu] = useState('');

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
    setHedefCrsElle(false);
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
      const yeni = await donustur(kaynak.geojson, hedefFormat, {
        kaynakCrs,
        hedefCrs,
        zTemizle,
        hassasiyet,
        geometriTipi,
        noktaKonumDogrulugu: noktaKonumDogrulugu.trim() || null,
      });
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

          <IstatistikKarti
            baslik="Kaynak istatistikleri"
            istatistik={kaynak?.istatistik}
            uyarilar={kaynak?.uyarilar}
            gecerlilik={kaynak?.gecerlilik}
          />

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
          onHedefFormat={hedefFormatSecildi}
          kaynakCrs={kaynakCrs}
          onKaynakCrs={kaynakCrsDegisti}
          hedefCrs={hedefCrs}
          onHedefCrs={hedefCrsSecildi}
          hedefCrsKilitli={hedefCrsKilitli}
          hedefCrsNotu={hedefCrsNotu}
          onHedefCrsOtomatik={tkgmModu && hedefCrsElle ? () => setHedefCrsElle(false) : null}
          zTemizle={zTemizle}
          onZTemizle={setZTemizle}
          hassasiyet={hassasiyet}
          geometriTipi={geometriTipi}
          onGeometriTipi={setGeometriTipi}
          noktaKonumDogrulugu={noktaKonumDogrulugu}
          onNoktaKonumDogrulugu={setNoktaKonumDogrulugu}
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
              <Harita
                veri={sonuc.haritaGeojson}
                renk={SONUC_RENK}
                etiket="Sonuç veri haritası"
                sorunlar={sonuc.gecerlilik?.sorunlar}
              />
            ) : (
              <div className="harita-bos">Harita (Sonuç)</div>
            )}
          </div>

          <IstatistikKarti
            baslik="Sonuç istatistikleri"
            istatistik={sonuc?.istatistik}
            uyarilar={sonuc?.uyarilar}
            gecerlilik={sonuc?.gecerlilik}
          />

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
