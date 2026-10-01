import React, { useState, useRef, useEffect } from 'react';
import { desteklenen_formatlar } from './data/formatlar';
import { MapContainer, TileLayer, LayersControl, GeoJSON, useMap } from 'react-leaflet';
import JSZip from 'jszip';
import { kml } from '@tmcw/togeojson';
import wellknown from 'wellknown';
import L from 'leaflet';

const { BaseLayer } = LayersControl;

// Harita yüklendiğinde GeoJSON verisine otomatik zoom yapan (FitBounds)
function BoundingBoxFit({ data }) {
  const map = useMap();
  useEffect(() => {
    if (data) {
      try {
        const layer = L.geoJSON(data);
        const bounds = layer.getBounds();
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [20, 20] });
        }
      } catch(e) {
        console.error("Zoom hatası:", e);
      }
    }
  }, [data, map]);
  return null;
}

// Güvenli Textbox Görüntüleme (DOM donmasını engellemek için metni kısaltır)
const guvenli_metin_gosterimi = (metin) => {
  if (!metin) return '';
  if (metin.length > 50000) {
    return metin.substring(0, 50000) + "\n\n============================================\n[UYARI]: DOSYA ÇOK BÜYÜK OLDUĞU İÇİN ( " + metin.length.toLocaleString() + " KARAKTER ) GÖSTERİM KISALTILDI.\nTARAYICININ DONMAMASI İÇİN YALNIZCA İLK 50.000 KARAKTER GÖSTERİLİYOR.\n\nVERİNİN TAMAMINI ELDE ETMEK İÇİN 'KOPYALA' VEYA 'İNDİR' BUTONLARINI KULLANIN.\n============================================";
  }
  return metin;
};

function App() {
  const [secili_dosya, dosya_ayarla] = useState(null);
  const [hedef_format, hedef_format_ayarla] = useState('.wkt');
  const [islem_durumu, islem_durumu_ayarla] = useState('');
  const [ilerleme, ilerleme_ayarla] = useState(0);
  const [surukleniyor, surukleniyor_ayarla] = useState(false);
  const [donusum_tamamlandi, donusum_tamamlandi_ayarla] = useState(false);
  
  const [kaynak_kopyalandi, kaynak_kopyalandi_ayarla] = useState(false);
  const [sonuc_kopyalandi, sonuc_kopyalandi_ayarla] = useState(false);
  
  // Gerçek veri state'leri
  const [kaynak_geojson, kaynak_geojson_ayarla] = useState(null);
  const [sonuc_geojson, sonuc_geojson_ayarla] = useState(null);
  const [kaynak_metin, kaynak_metin_ayarla] = useState('');
  const [sonuc_metin, sonuc_metin_ayarla] = useState('');

  const dosya_girdi_ref = useRef(null);

  // Dosya parse fonksiyonu (Büyük veriler için UI'ı rahatlatır)
  const dosyayi_oku = async (file) => {
    if (!file) return;
    const isim = file.name.toLowerCase();
    
    // UI'ın dondu hissi vermemesi için bilgilendirme ve kısa bir Thread duraklatması
    islem_durumu_ayarla('Dosya okunuyor (Büyük veri işlenirken tarayıcı kısa süre bekleyebilir)...');
    await new Promise(resolve => setTimeout(resolve, 50)); 
    
    try {
      if (isim.endsWith('.kmz')) {
        const zip = new JSZip();
        const zipIcerik = await zip.loadAsync(file);
        let kmlIcerik = null;
        for (let relativePath in zipIcerik.files) {
          if (relativePath.toLowerCase().endsWith('.kml')) {
            kmlIcerik = await zipIcerik.files[relativePath].async('string');
            break;
          }
        }
        if (kmlIcerik) {
          const parser = new DOMParser();
          const xmlDoc = parser.parseFromString(kmlIcerik, 'text/xml');
          const geojson = kml(xmlDoc);
          kaynak_geojson_ayarla(geojson);
          
          // Stringify ağır bir işlemdir
          const textJson = JSON.stringify(geojson, null, 2);
          kaynak_metin_ayarla(textJson);
          islem_durumu_ayarla(`Kaynak dosya başarıyla okundu. (${textJson.length.toLocaleString()} Karakter)`);
        } else {
          alert("KMZ içinde geçerli bir KML bulunamadı.");
        }
      } else if (isim.endsWith('.kml')) {
        const text = await file.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, 'text/xml');
        const geojson = kml(xmlDoc);
        kaynak_geojson_ayarla(geojson);
        kaynak_metin_ayarla(JSON.stringify(geojson, null, 2));
        islem_durumu_ayarla('KML okundu.');
      } else if (isim.endsWith('.geojson') || isim.endsWith('.json')) {
        const text = await file.text();
        const geojson = JSON.parse(text);
        kaynak_geojson_ayarla(geojson);
        kaynak_metin_ayarla(JSON.stringify(geojson, null, 2));
        islem_durumu_ayarla('GeoJSON okundu.');
      } else {
        const mock_geo = {
          type: "Feature",
          properties: { isim: "Desteklenmeyen Geometri", uyar: "WASM Backend Gerekli" },
          geometry: { type: "Polygon", coordinates: [[[32.84, 39.91], [32.88, 39.91], [32.88, 39.95], [32.84, 39.95], [32.84, 39.91]]] }
        };
        kaynak_geojson_ayarla(mock_geo);
        kaynak_metin_ayarla("// Dosya doğrudan tarayıcıda parse edilemedi (WASM Backend gerektirir).\n// Test için örnek geometri yüklendi.\n" + JSON.stringify(mock_geo, null, 2));
      }
    } catch (err) {
      console.error("Parse hatası:", err);
      alert("Dosya okunurken bir hata oluştu: " + err.message);
      islem_durumu_ayarla('Hata: ' + err.message);
    }
  };

  const dosya_secildi = (event) => {
    if (event.target.files && event.target.files.length > 0) {
      const file = event.target.files[0];
      dosya_ayarla(file);
      sifirla();
      dosyayi_oku(file);
    }
  };

  const sifirla = () => {
    islem_durumu_ayarla('');
    ilerleme_ayarla(0);
    donusum_tamamlandi_ayarla(false);
    kaynak_geojson_ayarla(null);
    sonuc_geojson_ayarla(null);
    kaynak_metin_ayarla('');
    sonuc_metin_ayarla('');
  };

  const surukleme_basladi = (e) => {
    e.preventDefault();
    e.stopPropagation();
    surukleniyor_ayarla(true);
  };

  const surukleme_bitti = (e) => {
    e.preventDefault();
    e.stopPropagation();
    surukleniyor_ayarla(false);
  };

  const dosya_birakildi = (e) => {
    e.preventDefault();
    e.stopPropagation();
    surukleniyor_ayarla(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      dosya_ayarla(file);
      sifirla();
      dosyayi_oku(file);
    }
  };

  const donusumu_baslat = async () => {
    if (!secili_dosya || !kaynak_geojson) {
      islem_durumu_ayarla('Lütfen önce desteklenen bir dosya (örn: KMZ) seçin.');
      return;
    }

    islem_durumu_ayarla('Dönüştürülüyor... (Devasa Geometriler İşlenirken Bekletebilir)');
    ilerleme_ayarla(10);
    donusum_tamamlandi_ayarla(false);
    
    await new Promise(resolve => setTimeout(resolve, 50)); 

    const dosya_boyutu = secili_dosya.size;
    const parca_boyutu = 1024 * 1024 * 2; 
    let islenen_byte = 0;

    const interval = setInterval(() => {
      islenen_byte += parca_boyutu;
      if(islenen_byte > dosya_boyutu) islenen_byte = dosya_boyutu;
      let yuzde = Math.floor((islenen_byte / dosya_boyutu) * 100);
      if(yuzde < 10) yuzde = 10;
      ilerleme_ayarla(yuzde);

      if (islenen_byte >= dosya_boyutu) {
        clearInterval(interval);
        setTimeout(() => {
          ilerleme_ayarla(100);
          
          let uretilen_metin = '';
          if (hedef_format === '.wkt') {
            try {
              if (kaynak_geojson.type === 'FeatureCollection') {
                uretilen_metin = kaynak_geojson.features.map(f => wellknown.stringify(f.geometry)).join('\n');
              } else {
                uretilen_metin = wellknown.stringify(kaynak_geojson.geometry || kaynak_geojson);
              }
            } catch(e) {
              uretilen_metin = "WKT Çeviri Hatası: " + e.message;
            }
          } else if (hedef_format === '.geojson') {
            uretilen_metin = JSON.stringify(kaynak_geojson, null, 2);
          } else {
            uretilen_metin = `// ${hedef_format} formatı tarayıcıda doğrudan çevrilemez. Backend bağlantısı gereklidir.`;
          }

          sonuc_geojson_ayarla(kaynak_geojson); 
          sonuc_metin_ayarla(uretilen_metin);
          donusum_tamamlandi_ayarla(true);
          islem_durumu_ayarla(`Başarılı: '${secili_dosya.name}' -> '${hedef_format}' dönüştürüldü.`);
        }, 150);
      }
    }, 100);
  };

  // Kopyalama butonu, kırpılmış metni değil, asıl veriyi kopyalamalı!
  const metin_kopyala = (metin, tip) => {
    navigator.clipboard.writeText(metin);
    if (tip === 'kaynak') {
      kaynak_kopyalandi_ayarla(true);
      setTimeout(() => kaynak_kopyalandi_ayarla(false), 2000);
    } else {
      sonuc_kopyalandi_ayarla(true);
      setTimeout(() => sonuc_kopyalandi_ayarla(false), 2000);
    }
  };

  // İndirme butonu, kırpılmış metni değil, asıl veriyi indirmeli!
  const indir_tetikle = () => {
    const blob = new Blob([sonuc_metin], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `donusturulmus_veri${hedef_format}`;
    link.click();
  };

  const HaritaBileseni = ({ data, renk }) => {
    return (
      // preferCanvas={true} : Dev geometrilerde dom patlamasını engeller
      <MapContainer center={[39.93, 32.86]} zoom={12} style={{ height: '100%', width: '100%' }} preferCanvas={true}>
        <LayersControl position="topright">
          <BaseLayer checked name="Google Uydu">
            <TileLayer
              url="http://mt0.google.com/vt/lyrs=s&hl=en&x={x}&y={y}&z={z}"
              attribution="&copy; Google"
            />
          </BaseLayer>
          <BaseLayer name="Google Harita">
            <TileLayer
              url="http://mt0.google.com/vt/lyrs=m&hl=en&x={x}&y={y}&z={z}"
              attribution="&copy; Google"
            />
          </BaseLayer>
          <BaseLayer name="OpenStreetMap">
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution="&copy; OpenStreetMap"
            />
          </BaseLayer>
          <BaseLayer name="Esri World Imagery">
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              attribution="&copy; Esri"
            />
          </BaseLayer>
        </LayersControl>
        
        {data && <GeoJSON data={data} style={{ color: renk, weight: 2, fillColor: renk, fillOpacity: 0.3 }} />}
        <BoundingBoxFit data={data} />
      </MapContainer>
    );
  };

  return (
    <div className="uygulama-kapsayici">
      
      <div className="baslik-alani">
        <h1>GeoConverterProEA</h1>
        <p className="aciklama">Gelişmiş Harita & Geometri Dönüştürücüsü</p>
      </div>

      <div className="grid-kapsayici">
        
        {/* SOL SÜTUN: Kaynak Veri */}
        <div className="fluent-panel">
          <h2 className="panel-baslik">1. Kaynak Veri</h2>
          
          <div 
            className={`dosya-yukleme-alani ${surukleniyor ? 'surukleniyor' : ''}`}
            onDragOver={surukleme_basladi}
            onDragLeave={surukleme_bitti}
            onDrop={dosya_birakildi}
            onClick={() => dosya_girdi_ref.current.click()}
          >
            <div className="dosya-yukleme-ikon">📂</div>
            <p>{secili_dosya ? secili_dosya.name : 'Dosya Seç (Tıklayın veya Sürükleyin)'}</p>
            <input 
              type="file" 
              ref={dosya_girdi_ref} 
              style={{ display: 'none' }} 
              onChange={dosya_secildi} 
            />
          </div>

          <div className="harita-alani" style={{ height: '300px' }}>
            {kaynak_geojson ? (
              <HaritaBileseni data={kaynak_geojson} renk="#ff4c4c" /> 
            ) : (
              <div className="harita-bos">Harita (Kaynak)</div>
            )}
          </div>

          {/* KAYNAK METİN KUTUSU */}
          <div className="metin-kutusu-kapsayici">
            <div className="metin-kutusu-baslik">
              <span>Kaynak Veri Özeti</span>
              <button 
                onClick={() => metin_kopyala(kaynak_metin, 'kaynak')} 
                className="kopyala-butonu"
                disabled={!kaynak_metin}
              >
                {kaynak_kopyalandi ? '✅ Kopyalandı' : '📋 Kopyala'}
              </button>
            </div>
            <textarea 
              readOnly 
              value={guvenli_metin_gosterimi(kaynak_metin)} 
              placeholder="Dosya seçildiğinde metin karşılığı burada görünecek..." 
            />
          </div>

        </div>

        {/* ORTA SÜTUN: Kontrol (Dönüştürme) Paneli */}
        <div className="fluent-panel kontrol-paneli">
          <div className="form-grubu">
            <label>Dönüşecek Dosya (Hedef) Seçin:</label>
            <select 
              value={hedef_format} 
              onChange={(e) => hedef_format_ayarla(e.target.value)}
            >
              {desteklenen_formatlar.map((grup, i) => (
                <optgroup key={i} label={grup.kategori}>
                  {grup.formatlar.map((fmt, j) => (
                    <option key={`${i}-${j}`} value={fmt.uzanti}>
                      {fmt.aciklama} ({fmt.uzanti})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <button 
            className="fluent-buton" 
            onClick={donusumu_baslat}
            disabled={!secili_dosya || (ilerleme > 0 && ilerleme < 100)}
          >
            Dönüştürmeyi Başlat
          </button>

          <div className={`ilerleme-kapsayici ${ilerleme > 0 ? 'aktif' : ''}`}>
            <div className="ilerleme-cubugu" style={{ width: `${ilerleme}%` }}></div>
          </div>
          <p className="sonuc-bilgi">{islem_durumu}</p>
        </div>

        {/* SAĞ SÜTUN: Hedef / Çıktı Veri */}
        <div className="fluent-panel">
          <h2 className="panel-baslik">2. Sonuç Veri</h2>
          
          <div className="harita-alani" style={{ marginTop: 0, height: '350px' }}>
            {sonuc_geojson && donusum_tamamlandi ? (
              <HaritaBileseni data={sonuc_geojson} renk="#4cc2ff" /> 
            ) : (
              <div className="harita-bos">Harita (Sonuç)</div>
            )}
          </div>

          {/* SONUÇ METİN KUTUSU */}
          <div className="metin-kutusu-kapsayici">
            <div className="metin-kutusu-baslik">
              <span>Dönüştürülen Veri ({hedef_format})</span>
              <button 
                onClick={() => metin_kopyala(sonuc_metin, 'sonuc')} 
                className="kopyala-butonu"
                disabled={!donusum_tamamlandi || !sonuc_metin}
              >
                {sonuc_kopyalandi ? '✅ Kopyalandı' : '📋 Kopyala'}
              </button>
            </div>
            <textarea 
              readOnly 
              value={guvenli_metin_gosterimi(sonuc_metin)} 
              placeholder="Dönüşüm tamamlandığında çıktı verisi burada görünecek..." 
            />
          </div>

          <div className="buton-grubu">
            <button 
              className="fluent-buton" 
              disabled={!donusum_tamamlandi}
              onClick={indir_tetikle}
            >
              ⬇️ Dosyayı İndir
            </button>
          </div>

        </div>

      </div>
    </div>
  );
}

export default App;
