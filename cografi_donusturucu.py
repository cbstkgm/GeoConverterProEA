import os
import zipfile
import logging
import geopandas as gpd
import pandas as pd
from shapely import wkt
from shapely.geometry import Point
from lxml import etree
import fiona

# KML/KMZ Sürücü Desteğini Aktif Etme
fiona.drvsupport.supported_drivers['KML'] = 'rw'
fiona.drvsupport.supported_drivers['LIBKML'] = 'rw'

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class VeriOkuyucuBase:
    """Veri okumak için temel arayüz (Interface)."""
    def oku(self, dosya_yolu: str) -> gpd.GeoDataFrame:
        raise NotImplementedError("Bu metot alt sınıflar tarafından ezilmelidir.")

class GenelOkuyucu(VeriOkuyucuBase):
    """GeoPandas'ın doğrudan desteklediği (SHP, GPKG, GML, GeoJSON vb.) dosyaları okur."""
    def oku(self, dosya_yolu: str) -> gpd.GeoDataFrame:
        logging.info(f"GenelOkuyucu ile okunuyor: {dosya_yolu}")
        return gpd.read_file(dosya_yolu)

class CsvOkuyucu(VeriOkuyucuBase):
    """CSV formatındaki verileri okur ve geometriye çevirir."""
    def oku(self, dosya_yolu: str) -> gpd.GeoDataFrame:
        logging.info(f"CsvOkuyucu ile okunuyor: {dosya_yolu}")
        
        try:
            # Önce noktalı virgül ve hatalı satır atlama ile dene (CBS dosyaları için en sağlıklısı)
            df = pd.read_csv(dosya_yolu, sep=';', on_bad_lines='skip', encoding_errors='replace', low_memory=False)
            if len(df.columns) < 2: # Noktalı virgül değilse virgülle ayırmayı zorla
                df = pd.read_csv(dosya_yolu, sep=',', on_bad_lines='skip', encoding_errors='replace', low_memory=False)
        except Exception:
            df = pd.read_csv(dosya_yolu, sep=',', on_bad_lines='skip', encoding_errors='replace', low_memory=False)
            
        # WKT (Well-Known Text) kolonu var mı kontrol et (kısmi eşleşme: the_geom, wkt_data vb.)
        wkt_kolonlari = [col for col in df.columns if any(k in str(col).lower() for k in ['wkt', 'geom', 'geometri'])]
        if wkt_kolonlari:
            kolon = wkt_kolonlari[0]
            logging.info(f"CSV'de WKT geometrisi bulundu: {kolon}")
            
            def guvenli_wkt(deger):
                try: 
                    return wkt.loads(str(deger))
                except: 
                    return None
                    
            df['geometry'] = df[kolon].apply(guvenli_wkt)
            df = df.dropna(subset=['geometry']) # Parse edilemeyenleri çıkar
            return gpd.GeoDataFrame(df, geometry='geometry')

        # X, Y veya Enlem, Boylam kolonları var mı kontrol et (kısmi eşleşme)
        x_kolonlari = [col for col in df.columns if any(k in str(col).lower() for k in ['x', 'lon', 'boylam', 'easting'])]
        y_kolonlari = [col for col in df.columns if any(k in str(col).lower() for k in ['y', 'lat', 'enlem', 'northing'])]
        
        if x_kolonlari and y_kolonlari:
            x_kol = x_kolonlari[0]
            y_kol = y_kolonlari[0]
            logging.info(f"CSV'de koordinat kolonları bulundu: X={x_kol}, Y={y_kol}")
            df['geometry'] = df.apply(lambda row: Point(float(row[x_kol]), float(row[y_kol])), axis=1)
            return gpd.GeoDataFrame(df, geometry='geometry')
            
        raise ValueError("CSV dosyasında geometri (WKT) veya koordinat (X, Y) kolonları bulunamadı!")


class VeriYaziciBase:
    """Veri yazmak için temel arayüz (Interface)."""
    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        raise NotImplementedError("Bu metot alt sınıflar tarafından ezilmelidir.")

class GenelYazici(VeriYaziciBase):
    """GeoPandas'ın doğrudan desteklediği standart formatlarda yazar (SHP, GPKG vb.)."""
    def __init__(self, surucu=None):
        self.surucu = surucu

    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        logging.info(f"Dosya yazılıyor ({self.surucu if self.surucu else 'Otomatik Sürücü'}): {dosya_yolu}")
        if self.surucu:
            gdf.to_file(dosya_yolu, driver=self.surucu)
        else:
            gdf.to_file(dosya_yolu)

class CsvYazici(VeriYaziciBase):
    """Veriyi CSV olarak yazar (Geometriyi WKT olarak ekler)."""
    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        logging.info(f"CsvYazici ile yazılıyor: {dosya_yolu}")
        df = pd.DataFrame(gdf)
        df['geometry'] = gdf.geometry.apply(lambda x: x.wkt if x else None)
        df.to_csv(dosya_yolu, index=False)

class NetcadGMLYazici(VeriYaziciBase):
    """Orijinal koda sadık kalarak, poligonları NetCAD/TKGM GML formatında yazar."""
    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        logging.info(f"NetcadGMLYazici ile işleniyor ve yazılıyor: {dosya_yolu}")
        
        # Sadece poligon ve multipoligon alınıyor
        gdf = gdf[gdf.geometry.type.isin(['Polygon', 'MultiPolygon'])]
        if gdf.empty:
            logging.warning("Dosyada işlenecek Polygon veya MultiPolygon bulunamadı.")
            return

        gdf = gdf.explode(index_parts=False)

        def geometri_temizle(geom):
            if geom is None or geom.is_empty:
                return None
            if not geom.is_valid:
                try:
                    onarilmis = geom.buffer(0)
                    if onarilmis is None or onarilmis.is_empty:
                        return None
                    return onarilmis
                except Exception as e:
                    logging.error(f"Geometri onarımı sırasında hata: {e}")
                    return None
            return geom

        gdf['geometry'] = gdf['geometry'].apply(geometri_temizle)
        gdf.dropna(subset=['geometry'], inplace=True)

        if 'id' not in gdf.columns:
            logging.warning("'id' kolonu bulunamadı. Yeni bir group_id oluşturuluyor.")
            gdf['group_id'] = range(len(gdf))
            grup_kolonu = 'group_id'
        else:
            grup_kolonu = 'id'

        toplanmis_gdf = gdf.groupby(grup_kolonu).agg({
            'geometry': lambda geoms: geoms.unary_union,
            **{col: 'first' for col in gdf.columns if col not in ['geometry', grup_kolonu]}
        })
        toplanmis_gdf = gpd.GeoDataFrame(toplanmis_gdf, geometry='geometry')

        isim_alani = {
            'TKGM': "http://www.tkgm.gov.tr",
            'gml': "http://www.opengis.net/gml"
        }
        kok_eleman = etree.Element("{http://www.tkgm.gov.tr}FeatureCollection", nsmap=isim_alani)

        def delikli_poligon_ekle(poligon, ebeveyn_eleman):
            gml_poligon = etree.SubElement(ebeveyn_eleman, "{http://www.opengis.net/gml}Polygon")
            
            dis_sinir = etree.SubElement(gml_poligon, "{http://www.opengis.net/gml}outerBoundaryIs")
            dis_cizgi = etree.SubElement(dis_sinir, "{http://www.opengis.net/gml}LinearRing")
            koordinatlar_dis = etree.SubElement(dis_cizgi, "{http://www.opengis.net/gml}coordinates")
            koordinatlar_dis.text = " ".join([f"{x},{y}" for x, y, *_ in poligon.exterior.coords])
            
            for ic_sinir in poligon.interiors:
                ic_alan = etree.SubElement(gml_poligon, "{http://www.opengis.net/gml}innerBoundaryIs")
                ic_cizgi = etree.SubElement(ic_alan, "{http://www.opengis.net/gml}LinearRing")
                koordinatlar_ic = etree.SubElement(ic_cizgi, "{http://www.opengis.net/gml}coordinates")
                koordinatlar_ic.text = " ".join([f"{x},{y}" for x, y, *_ in ic_sinir.coords])

        for id_degeri, satir in toplanmis_gdf.iterrows():
            try:
                geom = satir.geometry
                if geom is None or geom.is_empty:
                    continue

                ozellik_elemani = etree.SubElement(kok_eleman, "{http://www.tkgm.gov.tr}FeatureMember")
                ozel_alan = etree.SubElement(ozellik_elemani, "{http://www.tkgm.gov.tr}OzelAlanZemin")
                etree.SubElement(ozel_alan, "{http://www.tkgm.gov.tr}id").text = str(id_degeri)
                etree.SubElement(ozel_alan, "{http://www.tkgm.gov.tr}ad").text = str(satir.get("ilcead", id_degeri))

                for kolon in satir.index:
                    if str(kolon).lower() in ['geometry', 'ad', 'id', 'group_id', 'ilcead']:
                        continue
                    if satir[kolon] is not None:
                        etree.SubElement(ozel_alan, f"{{http://www.tkgm.gov.tr}}{kolon}").text = str(satir[kolon])

                geom_eleman = etree.SubElement(ozel_alan, "{http://www.tkgm.gov.tr}geom")

                if geom.geom_type == 'Polygon':
                    delikli_poligon_ekle(geom, geom_eleman)
                elif geom.geom_type == 'MultiPolygon':
                    gml_multi_poligon = etree.SubElement(geom_eleman, "{http://www.opengis.net/gml}MultiPolygon")
                    for alt_poligon in geom.geoms:
                        poligon_uyesi = etree.SubElement(gml_multi_poligon, "{http://www.opengis.net/gml}polygonMember")
                        delikli_poligon_ekle(alt_poligon, poligon_uyesi)

            except Exception as e:
                logging.error(f"'{id_degeri}' id'li nesne islenirken hata: {e}")

        agac = etree.ElementTree(kok_eleman)
        agac.write(dosya_yolu, pretty_print=True, xml_declaration=True, encoding="UTF-8")
        logging.info(f"Netcad (TKGM) GML dönüşümü tamamlandı: {dosya_yolu}")

class KmzYazici(VeriYaziciBase):
    """KML oluşturup onu zipleyerek KMZ formatına çeviren yazıcı sınıfı."""
    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        # Geçici kml oluştur
        gecici_kml = dosya_yolu.replace('.kmz', '.kml')
        
        # Geopandas ve Fiona ile KML olarak yaz (Sürücü LIBKML)
        try:
            gdf.to_file(gecici_kml, driver="LIBKML")
        except Exception as e:
            logging.error(f"KML yazılırken hata (KMZ oluşturma adımı 1): {e}")
            raise
            
        # Ziple (.kmz oluştur)
        try:
            with zipfile.ZipFile(dosya_yolu, 'w', zipfile.ZIP_DEFLATED) as zf:
                zf.write(gecici_kml, arcname='doc.kml')
        except Exception as e:
            logging.error(f"KMZ zipleme hatası (KMZ oluşturma adımı 2): {e}")
            raise
        finally:
            # İşlem bittikten sonra geçici KML dosyasını sil
            if os.path.exists(gecici_kml):
                os.remove(gecici_kml)
                
        logging.info(f"KMZ dönüşümü başarıyla tamamlandı: {dosya_yolu}")

class WktOkuyucu(VeriOkuyucuBase):
    """WKT formatındaki verileri okur."""
    def oku(self, dosya_yolu: str) -> gpd.GeoDataFrame:
        logging.info(f"WktOkuyucu ile okunuyor: {dosya_yolu}")
        with open(dosya_yolu, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            
        geoms = []
        for line in lines:
            line = line.strip()
            if line:
                try:
                    geoms.append(wkt.loads(line))
                except Exception as e:
                    logging.warning(f"WKT parse hatası, satır atlanıyor: {e}")
                    
        if not geoms:
            raise ValueError("Dosyada geçerli bir WKT geometrisi bulunamadı.")
            
        return gpd.GeoDataFrame(geometry=geoms)


class DonusturucuYoneticisi:
    """Uzantılara göre uygun okuyucu ve yazıcı sınıfları çalıştıran yönetici (Factory)."""
    
    def __init__(self):
        # Okuyucu haritalaması
        self.okuyucular = {
            '.csv': CsvOkuyucu(),
            '.shp': GenelOkuyucu(),
            '.gml': GenelOkuyucu(),
            '.geojson': GenelOkuyucu(),
            '.kml': GenelOkuyucu(),
            '.kmz': GenelOkuyucu(),
            '.gpkg': GenelOkuyucu(),
            '.wkt': WktOkuyucu()
        }
        
        # Yazıcı haritalaması
        self.yazicilar = {
            '.csv': CsvYazici(),
            '.shp': GenelYazici(),
            '.geojson': GenelYazici(surucu='GeoJSON'),
            '.gpkg': GenelYazici(surucu='GPKG'),
            '.kml': GenelYazici(surucu='LIBKML'),
            '.kmz': KmzYazici(),
            '.ncz': NetcadGMLYazici(), # Kullanıcı NCZ isterse NetCAD uyumlu GML yazıyoruz.
            '.gml': NetcadGMLYazici(), # Varsayılan GML çıktısını Serhat'ın özel TKGM koduna yönlendiriyoruz.
            '.wkt': CsvYazici()        # WKT aslında geometri sütunu içeren bir CSV gibi çıktı üretebilir. Ancak daha temiz olsun diye aşağıda WktYazici da yazabiliriz.
        }

    def format_algila_ve_donustur(self, girdi_yolu: str, cikti_yolu: str, hedef_kolonlar=None, geometri_kolonu=None):
        girdi_uzanti = os.path.splitext(girdi_yolu)[1].lower()
        cikti_uzanti = os.path.splitext(cikti_yolu)[1].lower()

        okuyucu = self.okuyucular.get(girdi_uzanti)
        if not okuyucu:
            raise ValueError(f"Desteklenmeyen girdi formatı: {girdi_uzanti}")

        yazici = self.yazicilar.get(cikti_uzanti)
        if not yazici:
            raise ValueError(f"Desteklenmeyen çıktı formatı: {cikti_uzanti}")

        if cikti_uzanti == '.ncz':
            logging.info("Uyarı: Açık kaynak kütüphaneler ile doğrudan binary (.ncz) oluşturulamaz. Dosya Netcad'in GML formatı standartlarında (Netcad GML / TKGM) dışa aktarılacaktır.")

        logging.info("Dönüşüm başlatılıyor...")
        
        # Eğer kullanıcı özellikle bir geometri kolonu belirttiyse ve dosya CSV ise, özel parse yapabiliriz. 
        # Ancak zaten CsvOkuyucu genel olarak okuyor, biz CsvOkuyucu yerine burada okunan GDF üzerinde işlem yapalım.
        gdf = okuyucu.oku(girdi_yolu)
        
        # EĞER Kullanıcı manuel bir Geometri kolonu seçmişse ve bu kolon WKT ise onu geometry olarak ayarla
        if geometri_kolonu and geometri_kolonu in gdf.columns and geometri_kolonu != 'geometry':
            try:
                def guvenli_wkt(deger):
                    try: return wkt.loads(str(deger))
                    except: return None
                gdf['geometry'] = gdf[geometri_kolonu].apply(guvenli_wkt)
                gdf = gdf.dropna(subset=['geometry'])
                gdf = gdf.set_geometry('geometry')
                logging.info(f"Kullanıcı seçimiyle '{geometri_kolonu}' geometri olarak ayarlandı.")
            except Exception as e:
                logging.warning(f"Kullanıcı geometri kolonu ({geometri_kolonu}) işlenirken hata: {e}")

        # GPKG/SHP'de 'geom' adı geometri kolonu için rezerve edildiğinden çakışmayı önlemek için adını değiştir
        for col_name in list(gdf.columns):
            if col_name.lower() == 'geom' and col_name != 'geometry':
                new_col_name = f"{col_name}_data"
                gdf.rename(columns={col_name: new_col_name}, inplace=True)
                if hedef_kolonlar and col_name in hedef_kolonlar:
                    hedef_kolonlar[hedef_kolonlar.index(col_name)] = new_col_name
                
        # EĞER Kullanıcı manuel öznitelik (kolon) filtresi belirlediyse
        if hedef_kolonlar and isinstance(hedef_kolonlar, list) and len(hedef_kolonlar) > 0:
            # Sadece var olan kolonları al, geometry zorunlu ekle
            secilecekler = [col for col in hedef_kolonlar if col in gdf.columns]
            if 'geometry' not in secilecekler:
                secilecekler.append('geometry')
            gdf = gdf[secilecekler]
            logging.info(f"Kullanıcı seçimiyle sadece şu kolonlar dışa aktarılacak: {secilecekler}")
        
        # 1.5. Gereksiz KML/GeoJSON Sütunlarını Temizle (Eğer veri kml veya togeojson üzerinden geldiyse kirlilik olmasın)
        kml_gereksiz_alanlar = [
            'Name', 'description', 'timestamp', 'begin', 'end', 
            'altitudeMode', 'tessellate', 'extrude', 'visibility', 
            'drawOrder', 'icon', 'snippet'
        ]
        
        dusurulecekler = []
        for kolon in gdf.columns:
            if kolon in kml_gereksiz_alanlar or kolon.lower() in [k.lower() for k in kml_gereksiz_alanlar]:
                # Sadece eğer tüm değerleri null, boş, 0 veya -1 ise düşür
                # veya kullanıcı verisi olmadığından emin olmak için direkt düşürebiliriz
                # Kullanıcı kendi "Name" alanını oluşturmuş olabilir. Bu yüzden değerlerin boş veya standart olup olmadığına bakalım.
                essiz_degerler = gdf[kolon].dropna().unique()
                if len(essiz_degerler) == 0: # Tümü boş
                    dusurulecekler.append(kolon)
                elif all(val in [-1, 0, "-1", "0", ""] for val in essiz_degerler):
                    dusurulecekler.append(kolon)
                
        if dusurulecekler:
            gdf = gdf.drop(columns=dusurulecekler)
            logging.info(f"Gereksiz varsayılan sütunlar temizlendi: {dusurulecekler}")

        # Ayrıca ESRI Shapefile kısıtlaması nedeniyle tamamen boş (NA/NULL) tüm sütunları da düşürebiliriz (opsiyonel ama iyi olabilir)
        tum_bos_kolonlar = [col for col in gdf.columns if gdf[col].isnull().all() and col != 'geometry']
        if tum_bos_kolonlar:
            gdf = gdf.drop(columns=tum_bos_kolonlar)
            logging.info(f"Tamamen boş olan sütunlar temizlendi: {tum_bos_kolonlar}")
            
        # 2. Yaz
        yazici.yaz(gdf, cikti_yolu)
        logging.info("Dönüşüm başarıyla tamamlandı!")

# Test Amaçlı Kullanım
if __name__ == "__main__":
    donusturucu = DonusturucuYoneticisi()
    # Örnek Kullanım:
    # donusturucu.format_algila_ve_donustur("ornek_veri.csv", "cikti_veri.ncz")
    # donusturucu.format_algila_ve_donustur("ornek_veri.shp", "cikti_veri.kml")
    pass
