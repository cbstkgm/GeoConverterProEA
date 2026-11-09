"""GeoConverterPro - GeoPandas tabanlı coğrafi veri dönüştürücü.

Kütüphane olarak kullanım:
    from cografi_donusturucu import DonusturucuYoneticisi
    DonusturucuYoneticisi().format_algila_ve_donustur("girdi.csv", "cikti.gpkg",
                                                       kaynak_crs="EPSG:4326",
                                                       hedef_crs="EPSG:5254")

Komut satırı:
    python cografi_donusturucu.py girdi.csv cikti.gpkg --kaynak-crs EPSG:4326 \
        --hedef-crs EPSG:5254 --kolonlar a,b --geometri-kolonu wkt
"""
import argparse
import logging
import math
import os
import re
import sys
import tempfile
import unicodedata
import zipfile

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from lxml import etree
from shapely import wkt

# Fiona isteğe bağlıdır (GeoPandas 1.x varsayılan olarak pyogrio kullanır).
# Kuruluysa KML/LIBKML sürücülerini yazma için etkinleştir.
try:  # pragma: no cover - ortama bağlı
    import fiona

    fiona.drvsupport.supported_drivers['KML'] = 'rw'
    fiona.drvsupport.supported_drivers['LIBKML'] = 'rw'
except Exception:  # fiona yok ya da sürücü tablosu farklı
    fiona = None

# Kütüphane olarak import edildiğinde global logging yapılandırılmaz; yalnız logger alınır.
logger = logging.getLogger(__name__)

VARSAYILAN_CRS = "EPSG:4326"
KML_CRS = "EPSG:4326"


# ---------------------------------------------------------------------------
# Yardımcı fonksiyonlar
# ---------------------------------------------------------------------------

_TR_ASCII = str.maketrans("çğıöşüÇĞİÖŞÜâîûÂÎÛ", "cgiosuCGIOSUaiuAIU")


def kolon_adi_normalize(ad) -> str:
    """Sütun adını karşılaştırma için normalize eder: küçük harf, Türkçe karakter -> ASCII,
    harf/rakam dışı karakterler (boşluk, _, -, . vb.) silinir. Örn: 'X_Koord' -> 'xkoord'."""
    metin = str(ad).strip().translate(_TR_ASCII).lower()
    metin = unicodedata.normalize("NFKD", metin)
    metin = "".join(c for c in metin if not unicodedata.combining(c))
    return re.sub(r"[^0-9a-z]", "", metin)


# Öncelik sırasına göre aday adlar (normalize edilmiş halleriyle, TAM eşleşme aranır).
WKT_KOLON_ADLARI = [
    "wkt", "geometrywkt", "wktgeometry", "geomwkt", "wktgeom", "thegeom",
    "geometry", "geometri", "geom", "shape", "wktdata", "geometriwkt", "wktgeometri",
]
X_KOLON_ADLARI = [
    "x", "lon", "lng", "long", "longitude", "boylam", "easting", "east", "dogu",
    "xkoord", "xkoordinat", "koordinatx", "koordx", "xcoord", "xcoordinate", "coordx", "pointx", "saga",
]
Y_KOLON_ADLARI = [
    "y", "lat", "latitude", "enlem", "northing", "north", "kuzey",
    "ykoord", "ykoordinat", "koordinaty", "koordy", "ycoord", "ycoordinate", "coordy", "pointy", "yukari",
]


def kolon_bul(kolonlar, adaylar, haric=()):
    """`adaylar` listesindeki öncelik sırasıyla, normalize adı TAM eşleşen ilk sütunu döndürür."""
    normalize = {}
    for kolon in kolonlar:
        if kolon in haric:
            continue
        normalize.setdefault(kolon_adi_normalize(kolon), kolon)
    for aday in adaylar:
        if aday in normalize:
            return normalize[aday]
    return None


def guvenli_wkt(deger):
    """Tek bir değeri WKT olarak çözer; çözülemezse None döner."""
    if deger is None or (isinstance(deger, float) and np.isnan(deger)):
        return None
    metin = str(deger).strip()
    if not metin:
        return None
    try:
        return wkt.loads(metin)
    except Exception:
        return None


def sayiya_cevir(seri: pd.Series) -> pd.Series:
    """Sayısal olmayan değerleri NaN yapar; ondalık virgülü ('41,02') noktaya çevirir."""
    if pd.api.types.is_numeric_dtype(seri):
        return pd.to_numeric(seri, errors="coerce")
    metin = seri.astype(str).str.strip().str.replace(",", ".", regex=False)
    return pd.to_numeric(metin, errors="coerce")


def katman_adlari(dosya_yolu: str):
    """Dosyadaki katman adlarını döndürür (GeoPandas >=1.0 list_layers, yoksa fiona)."""
    if hasattr(gpd, "list_layers"):
        return list(gpd.list_layers(dosya_yolu)["name"])
    if fiona is not None:  # pragma: no cover - eski sürümler
        return list(fiona.listlayers(dosya_yolu))
    return [None]  # pragma: no cover


def tum_katmanlari_oku(dosya_yolu: str, katmanlar=None, katman_kolonu=None) -> gpd.GeoDataFrame:
    """Birden fazla katmanlı dosyalarda (KML klasörleri, GPX) boş olmayan tüm katmanları birleştirir."""
    if katmanlar is None:
        try:
            katmanlar = katman_adlari(dosya_yolu)
        except Exception as e:
            logger.debug(f"Katmanlar listelenemedi ({e}); tek katman okunuyor.")
            return gpd.read_file(dosya_yolu)

    parcalar = []
    for katman in katmanlar:
        try:
            parca = gpd.read_file(dosya_yolu, layer=katman) if katman is not None else gpd.read_file(dosya_yolu)
        except Exception as e:
            logger.warning(f"'{katman}' katmanı okunamadı, atlanıyor: {e}")
            continue
        if parca.empty:
            continue
        if katman_kolonu:
            parca[katman_kolonu] = katman
        parcalar.append(parca)

    if not parcalar:
        raise ValueError(f"Dosyada okunabilir (boş olmayan) katman bulunamadı: {dosya_yolu}")
    if len(parcalar) == 1:
        return parcalar[0]
    crs = next((p.crs for p in parcalar if p.crs is not None), None)
    parcalar = [p.to_crs(crs) if (crs is not None and p.crs is not None and p.crs != crs) else p for p in parcalar]
    birlesik = pd.concat(parcalar, ignore_index=True)
    return gpd.GeoDataFrame(birlesik, geometry="geometry", crs=crs)


def crs_ata(gdf: gpd.GeoDataFrame, kaynak_crs=None) -> gpd.GeoDataFrame:
    """CRS'siz veriye kaynak CRS (yoksa EPSG:4326) atar. Kullanıcı açıkça bir kaynak CRS verdiyse
    ve dosyanın CRS'si farklıysa, kullanıcının değeri esas alınır (yeniden projeksiyon YAPILMAZ)."""
    if gdf.crs is None:
        crs = kaynak_crs or VARSAYILAN_CRS
        if kaynak_crs is None:
            logger.info(f"Girdide CRS bilgisi yok; varsayılan {VARSAYILAN_CRS} atanıyor.")
        return gdf.set_crs(crs)
    if kaynak_crs is not None:
        hedef = gpd.GeoSeries([], crs=kaynak_crs).crs
        if gdf.crs != hedef:
            logger.warning(f"Dosyanın CRS'si ({gdf.crs.to_string()}) kullanıcı kaynak CRS'si ({kaynak_crs}) ile "
                           f"değiştiriliyor (koordinatlar dönüştürülmez).")
            return gdf.set_crs(kaynak_crs, allow_override=True)
    return gdf


def gecerli_xml_adi(ad, kullanilanlar=None) -> str:
    """Sütun adını geçerli bir XML element adına (NCName) çevirir.
    Unicode harfler (Türkçe dahil), rakam, '_', '-', '.' korunur; diğerleri '_' olur.
    Harf/'_' ile başlamayan veya 'xml' ile başlayan adların başına '_' eklenir."""
    metin = unicodedata.normalize("NFC", str(ad).strip())
    temiz = "".join(c if (c.isalnum() or c in "_-.") else "_" for c in metin)
    temiz = re.sub(r"_+", "_", temiz)
    if not temiz:
        temiz = "alan"
    if not (temiz[0].isalpha() or temiz[0] == "_") or temiz.lower().startswith("xml"):
        temiz = "_" + temiz
    if kullanilanlar is not None:
        aday, sayac = temiz, 2
        while aday in kullanilanlar:
            aday = f"{temiz}_{sayac}"
            sayac += 1
        temiz = aday
        kullanilanlar.add(temiz)
    return temiz


def bos_mu(deger) -> bool:
    """None / NaN / NaT / pd.NA için True döndürür (liste vb. için False)."""
    if deger is None:
        return True
    try:
        sonuc = pd.isna(deger)
    except Exception:
        return False
    return bool(sonuc) if np.ndim(sonuc) == 0 else False


# ---------------------------------------------------------------------------
# Okuyucular
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# TKGM adlandırma (Kadastro Dairesi Başkanlığı, GML Converter 7.2 Güncelleme Notları)
#  - Parsel adı: "ada/parsel" (ör. 5494/14)
#  - Tabaka: TK_PARSEL_abc — abc, Tapu Planlarında Yanılma Sınırı Yönetmeliği Madde 9'daki nokta
#    konum doğruluğunun noktasız/virgülsüz yazımı (0,21 -> 021, 0,09 -> 009, 1 -> 100, 1,75 -> 175).
#    Doğruluk bilinmiyorsa "TK_PARSEL".
# Web uygulamasındaki src/lib/gml.js ile birebir aynı kurallar (çıktılar bayt bayt aynıdır).
# ---------------------------------------------------------------------------

_TR_KATLAMA = str.maketrans({"ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u"})

ADA_SUTUNLARI = ['ada', 'adano', 'adanumarasi', 'adanum', 'adaadi']
PARSEL_SUTUNLARI = ['parsel', 'parselno', 'parselnumarasi', 'parselnum', 'parseladi']
ADA_PARSEL_SUTUNLARI = ['adaparsel', 'adaparselno', 'parseladi', 'adi']
NKD_SUTUNLARI = ['nkd', 'noktakonumdogrulugu', 'konumdogrulugu', 'noktakonumdogruluk', 'nktkonumdogrulugu']
TABAKA_SUTUNLARI = ['tabaka', 'katman', 'layer', 'tabakaadi']
TABAKA_DESENI = re.compile(r"^TK_PARSEL(?:_\d{3})?$", re.IGNORECASE)


def sutun_anahtari(ad) -> str:
    """Sütun adını karşılaştırma için sadeleştirir: "Ada No" -> "adano", "Nokta Konum Doğruluğu" -> "noktakonumdogrulugu"."""
    metin = str(ad).replace("I", "ı").replace("İ", "i").lower().translate(_TR_KATLAMA)
    return re.sub(r"[^a-z0-9]", "", metin)


def _bos_metin_mi(deger) -> bool:
    return bos_mu(deger) or str(deger).strip() == ""


def sutun_degeri(ozellikler: dict, adaylar):
    """Özellikler içinde aday adlardan ilk bulunanın (boş olmayan) değerini döndürür; yoksa None."""
    harita = {}
    for anahtar in ozellikler:
        harita.setdefault(sutun_anahtari(anahtar), anahtar)
    for aday in adaylar:
        gercek = harita.get(aday)
        if gercek is not None and not _bos_metin_mi(ozellikler[gercek]):
            return ozellikler[gercek]
    return None


def numara_metni(deger) -> str:
    """14, "14", 14.0, "14.0" -> "14"; diğer metinler kırpılmış olarak."""
    if isinstance(deger, (float, np.floating)) and float(deger).is_integer():
        return str(int(deger))
    metin = str(deger).strip()
    return re.sub(r"\.0+$", "", metin) if re.fullmatch(r"-?\d+\.0+", metin) else metin


def tabaka_adi(dogruluk):
    """Nokta konum doğruluğundan (metre; "0,21" de olur) TKGM tabaka adı; geçersizse None."""
    if _bos_metin_mi(dogruluk):
        return None
    try:
        sayi = float(str(dogruluk).strip().replace(",", "."))
    except ValueError:
        return None
    if not math.isfinite(sayi):
        return None
    kod = math.floor(sayi * 100 + 0.5)  # JS Math.round ile aynı (Python round() yarımları çifte yuvarlar)
    if kod < 1 or kod > 999:
        return None
    return f"TK_PARSEL_{kod:03d}"


def ada_parsel_adi(ozellikler: dict):
    """Objenin TKGM parsel adı ("ada/parsel"); bulunamazsa None."""
    ada = sutun_degeri(ozellikler, ADA_SUTUNLARI)
    parsel = sutun_degeri(ozellikler, PARSEL_SUTUNLARI)
    if ada is not None and parsel is not None:
        return f"{numara_metni(ada)}/{numara_metni(parsel)}"
    birlesik = sutun_degeri(ozellikler, ADA_PARSEL_SUTUNLARI)
    if birlesik is not None and re.fullmatch(r"\s*\d+\s*/\s*\d+\s*", str(birlesik)):
        return re.sub(r"\s+", "", str(birlesik))
    return None


def obje_tabakasi(ozellikler: dict, varsayilan_dogruluk=None):
    """(tabaka, kaynak) — öncelik: verideki geçerli tabaka -> nkd sütunu -> varsayılan -> "TK_PARSEL"."""
    mevcut = sutun_degeri(ozellikler, TABAKA_SUTUNLARI)
    if mevcut is not None and TABAKA_DESENI.match(str(mevcut).strip()):
        return str(mevcut).strip().upper(), "veri"
    nkd = tabaka_adi(sutun_degeri(ozellikler, NKD_SUTUNLARI))
    if nkd:
        return nkd, "nkd"
    varsayilan = tabaka_adi(varsayilan_dogruluk)
    if varsayilan:
        return varsayilan, "varsayilan"
    return "TK_PARSEL", "yok"


class VeriOkuyucuBase:
    """Veri okumak için temel arayüz (Interface)."""
    def oku(self, dosya_yolu: str, geometri_kolonu=None) -> gpd.GeoDataFrame:
        raise NotImplementedError("Bu metot alt sınıflar tarafından ezilmelidir.")


class GenelOkuyucu(VeriOkuyucuBase):
    """GeoPandas'ın doğrudan desteklediği (SHP, GPKG, GML, GeoJSON vb.) dosyaları okur."""
    def oku(self, dosya_yolu: str, geometri_kolonu=None) -> gpd.GeoDataFrame:
        logger.info(f"GenelOkuyucu ile okunuyor: {dosya_yolu}")
        return gpd.read_file(dosya_yolu)


class KmlOkuyucu(VeriOkuyucuBase):
    """KML dosyasını okur; klasör (katman) yapısındaki tüm katmanları birleştirir."""
    def oku(self, dosya_yolu: str, geometri_kolonu=None) -> gpd.GeoDataFrame:
        logger.info(f"KmlOkuyucu ile okunuyor: {dosya_yolu}")
        return tum_katmanlari_oku(dosya_yolu)


class KmzOkuyucu(VeriOkuyucuBase):
    """KMZ (zip içinde KML) dosyasından doc.kml'i (yoksa ilk .kml'i) çıkarıp okur."""
    def oku(self, dosya_yolu: str, geometri_kolonu=None) -> gpd.GeoDataFrame:
        logger.info(f"KmzOkuyucu ile okunuyor: {dosya_yolu}")
        with zipfile.ZipFile(dosya_yolu) as zf:
            kml_adlari = [ad for ad in zf.namelist() if ad.lower().endswith(".kml")]
            if not kml_adlari:
                raise ValueError(f"KMZ arşivinde .kml dosyası bulunamadı: {dosya_yolu}")
            secilen = next((ad for ad in kml_adlari if os.path.basename(ad).lower() == "doc.kml"), kml_adlari[0])
            with tempfile.TemporaryDirectory(prefix="geoconv_kmz_") as gecici_klasor:
                gecici_kml = os.path.join(gecici_klasor, "doc.kml")
                with zf.open(secilen) as kaynak, open(gecici_kml, "wb") as hedef:
                    hedef.write(kaynak.read())
                gdf = tum_katmanlari_oku(gecici_kml)
                # Dosya kilidi kalmasın diye belleğe tamamen alınmış kopya döndür.
                return gdf.copy()


class ZipShapefileOkuyucu(VeriOkuyucuBase):
    """Zip içindeki Shapefile(lar)ı okur. Birden fazla .shp varsa hepsi birleştirilir."""
    def oku(self, dosya_yolu: str, geometri_kolonu=None) -> gpd.GeoDataFrame:
        logger.info(f"ZipShapefileOkuyucu ile okunuyor: {dosya_yolu}")
        with zipfile.ZipFile(dosya_yolu) as zf:
            shp_adlari = [ad for ad in zf.namelist() if ad.lower().endswith(".shp")]
        if not shp_adlari:
            raise ValueError(f"Zip arşivinde Shapefile (.shp) bulunamadı: {dosya_yolu}")
        mutlak = os.path.abspath(dosya_yolu).replace("\\", "/")
        parcalar = []
        for ad in shp_adlari:
            parca = gpd.read_file(f"/vsizip/{mutlak}/{ad}")
            if len(shp_adlari) > 1:
                parca["kaynak_katman"] = os.path.splitext(os.path.basename(ad))[0]
            parcalar.append(parca)
        if len(parcalar) == 1:
            return parcalar[0]
        crs = next((p.crs for p in parcalar if p.crs is not None), None)
        parcalar = [p.to_crs(crs) if (crs is not None and p.crs is not None and p.crs != crs) else p for p in parcalar]
        return gpd.GeoDataFrame(pd.concat(parcalar, ignore_index=True), geometry="geometry", crs=crs)


class GpxOkuyucu(VeriOkuyucuBase):
    """GPX dosyasının waypoints / routes / tracks katmanlarını okur ve birleştirir."""
    KATMANLAR = ["waypoints", "routes", "tracks"]

    def oku(self, dosya_yolu: str, geometri_kolonu=None) -> gpd.GeoDataFrame:
        logger.info(f"GpxOkuyucu ile okunuyor: {dosya_yolu}")
        return tum_katmanlari_oku(dosya_yolu, katmanlar=self.KATMANLAR, katman_kolonu="gpx_katman")


class CsvOkuyucu(VeriOkuyucuBase):
    """CSV formatındaki verileri okur ve geometriye çevirir."""

    @staticmethod
    def csv_oku(dosya_yolu: str) -> pd.DataFrame:
        try:
            # Önce noktalı virgül ve hatalı satır atlama ile dene (CBS dosyaları için en sağlıklısı)
            df = pd.read_csv(dosya_yolu, sep=';', on_bad_lines='skip', encoding_errors='replace', low_memory=False)
            if len(df.columns) < 2:  # Noktalı virgül değilse virgülle ayırmayı zorla
                df = pd.read_csv(dosya_yolu, sep=',', on_bad_lines='skip', encoding_errors='replace', low_memory=False)
        except Exception:
            df = pd.read_csv(dosya_yolu, sep=',', on_bad_lines='skip', encoding_errors='replace', low_memory=False)
        return df

    @staticmethod
    def wkt_kolonu_bul(kolonlar):
        return kolon_bul(kolonlar, WKT_KOLON_ADLARI)

    @staticmethod
    def koordinat_kolonlari_bul(kolonlar):
        """(x_kolonu, y_kolonu) döndürür; bulunamayan None olur. Tam/normalize eşleşme kullanılır."""
        x_kol = kolon_bul(kolonlar, X_KOLON_ADLARI)
        y_kol = kolon_bul(kolonlar, Y_KOLON_ADLARI, haric=(x_kol,))
        return x_kol, y_kol

    def oku(self, dosya_yolu: str, geometri_kolonu=None) -> gpd.GeoDataFrame:
        logger.info(f"CsvOkuyucu ile okunuyor: {dosya_yolu}")
        df = self.csv_oku(dosya_yolu)

        # WKT (Well-Known Text) kolonu: kullanıcı belirttiyse o, yoksa tam/normalize ad eşleşmesi
        if geometri_kolonu:
            if geometri_kolonu not in df.columns:
                raise ValueError(f"Belirtilen geometri kolonu CSV'de yok: {geometri_kolonu}")
            kolon = geometri_kolonu
        else:
            kolon = self.wkt_kolonu_bul(df.columns)

        if kolon is not None:
            geometriler = df[kolon].apply(guvenli_wkt)
            gecerli = geometriler.notna()
            if gecerli.any():
                logger.info(f"CSV'de WKT geometrisi bulundu: {kolon}")
                atlanan = int((~gecerli).sum())
                if atlanan:
                    logger.warning(f"{atlanan} satırın WKT değeri çözülemedi, atlandı.")
                df = df.loc[gecerli].copy()
                if kolon == "geometry":
                    df = df.drop(columns=["geometry"])
                return gpd.GeoDataFrame(df, geometry=gpd.GeoSeries(geometriler[gecerli].values, index=df.index))
            if geometri_kolonu:
                raise ValueError(f"'{geometri_kolonu}' kolonunda çözülebilir WKT geometrisi yok.")
            logger.warning(f"'{kolon}' kolonu WKT olarak çözülemedi; koordinat kolonları aranıyor.")

        # X, Y veya Enlem, Boylam kolonları (tam/normalize eşleşme)
        x_kol, y_kol = self.koordinat_kolonlari_bul(df.columns)
        if x_kol is not None and y_kol is not None:
            logger.info(f"CSV'de koordinat kolonları bulundu: X={x_kol}, Y={y_kol}")
            x_deger = sayiya_cevir(df[x_kol])
            y_deger = sayiya_cevir(df[y_kol])
            gecerli = x_deger.notna() & y_deger.notna()
            atlanan = int((~gecerli).sum())
            if atlanan:
                logger.warning(f"{atlanan} satırda koordinat sayıya çevrilemedi, atlandı.")
            if not gecerli.any():
                raise ValueError(f"'{x_kol}'/'{y_kol}' kolonlarında geçerli sayısal koordinat yok.")
            df = df.loc[gecerli].copy()
            if "geometry" in df.columns:
                df = df.drop(columns=["geometry"])
            return gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(x_deger[gecerli], y_deger[gecerli]))

        raise ValueError("CSV dosyasında geometri (WKT) veya koordinat (X, Y) kolonları bulunamadı!")


class WktOkuyucu(VeriOkuyucuBase):
    """WKT formatındaki verileri (satır başına bir geometri) okur."""
    def oku(self, dosya_yolu: str, geometri_kolonu=None) -> gpd.GeoDataFrame:
        logger.info(f"WktOkuyucu ile okunuyor: {dosya_yolu}")
        with open(dosya_yolu, 'r', encoding='utf-8-sig') as f:
            lines = f.readlines()

        geoms = []
        for satir_no, line in enumerate(lines, start=1):
            line = line.strip()
            if line:
                try:
                    geoms.append(wkt.loads(line))
                except Exception as e:
                    logger.warning(f"WKT parse hatası, satır {satir_no} atlanıyor: {e}")

        if not geoms:
            raise ValueError("Dosyada geçerli bir WKT geometrisi bulunamadı.")

        return gpd.GeoDataFrame(geometry=geoms)


# ---------------------------------------------------------------------------
# Yazıcılar
# ---------------------------------------------------------------------------

class VeriYaziciBase:
    """Veri yazmak için temel arayüz (Interface)."""
    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        raise NotImplementedError("Bu metot alt sınıflar tarafından ezilmelidir.")


class GenelYazici(VeriYaziciBase):
    """GeoPandas'ın doğrudan desteklediği standart formatlarda yazar (SHP, GPKG vb.)."""
    def __init__(self, surucu=None):
        self.surucu = surucu

    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        logger.info(f"Dosya yazılıyor ({self.surucu if self.surucu else 'Otomatik Sürücü'}): {dosya_yolu}")
        if self.surucu:
            gdf.to_file(dosya_yolu, driver=self.surucu)
        else:
            gdf.to_file(dosya_yolu)


class KmlYazici(VeriYaziciBase):
    """KML yazar. KML her zaman WGS84 (EPSG:4326) olduğundan gerekirse yeniden projekte eder.
    Önce LIBKML, kullanılamazsa GDAL'ın KML sürücüsü denenir."""
    SURUCULER = ("LIBKML", "KML")

    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        if gdf.crs is None:
            logger.warning(f"KML için CRS bilinmiyor; {KML_CRS} varsayılıyor.")
            gdf = gdf.set_crs(KML_CRS)
        elif gdf.crs != gpd.GeoSeries([], crs=KML_CRS).crs:
            logger.info(f"KML için {gdf.crs.to_string()} -> {KML_CRS} dönüşümü yapılıyor.")
            gdf = gdf.to_crs(KML_CRS)

        son_hata = None
        for surucu in self.SURUCULER:
            try:
                if os.path.exists(dosya_yolu):
                    os.remove(dosya_yolu)
                gdf.to_file(dosya_yolu, driver=surucu)
                logger.info(f"KML yazıldı ({surucu}): {dosya_yolu}")
                return
            except Exception as e:
                logger.debug(f"{surucu} sürücüsü ile KML yazılamadı: {e}")
                son_hata = e
        raise RuntimeError(f"KML yazılamadı (denenen sürücüler: {', '.join(self.SURUCULER)}): {son_hata}")


class CsvYazici(VeriYaziciBase):
    """Veriyi CSV olarak yazar (Geometriyi WKT olarak ekler)."""
    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        logger.info(f"CsvYazici ile yazılıyor: {dosya_yolu}")
        df = pd.DataFrame(gdf.drop(columns=[gdf.geometry.name]))
        df['geometry'] = gdf.geometry.to_wkt()
        df.to_csv(dosya_yolu, index=False)


class WktYazici(VeriYaziciBase):
    """Her satıra bir geometri olacak şekilde düz WKT dosyası yazar (öznitelikler yazılmaz)."""
    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        logger.info(f"WktYazici ile yazılıyor: {dosya_yolu}")
        sayac = 0
        with open(dosya_yolu, 'w', encoding='utf-8', newline='\n') as f:
            for geom in gdf.geometry:
                if geom is None or geom.is_empty:
                    continue
                f.write(geom.wkt + "\n")
                sayac += 1
        logger.info(f"{sayac} geometri WKT olarak yazıldı.")


class NetcadGMLYazici(VeriYaziciBase):
    """Orijinal koda sadık kalarak, poligonları NetCAD/TKGM GML formatında yazar."""
    TKGM_NS = "http://www.tkgm.gov.tr"
    GML_NS = "http://www.opengis.net/gml"
    SABIT_ALANLAR = {'geometry', 'ad', 'id', 'group_id', 'ilcead', 'geom', 'tabaka'}
    # TKGM parsel GML'indeki standart alanlar ve veride yoksa yazılacak varsayılanlar (sırası önemli).
    TKGM_PARSEL_ALANLARI = (('aciklama', ''), ('megsisId', '0'), ('onayDurum', ''), ('takbisId', '0'))

    @classmethod
    def standart_alan_mi(cls, ad) -> bool:
        anahtar = sutun_anahtari(ad)
        return (str(ad).lower() in cls.SABIT_ALANLAR
                or any(anahtar == sutun_anahtari(alan) for alan, _ in cls.TKGM_PARSEL_ALANLARI))

    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str, nokta_konum_dogrulugu=None):
        """nokta_konum_dogrulugu: verideki nkd sütunu yoksa kullanılacak varsayılan (m), ör. 0.21 -> TK_PARSEL_021."""
        logger.info(f"NetcadGMLYazici ile işleniyor ve yazılıyor: {dosya_yolu}")
        TKGM, GML = self.TKGM_NS, self.GML_NS
        if not _bos_metin_mi(nokta_konum_dogrulugu) and tabaka_adi(nokta_konum_dogrulugu) is None:
            raise ValueError(f"Nokta konum doğruluğu geçersiz: '{nokta_konum_dogrulugu}'. "
                             "0,01 ile 9,99 m arasında bir değer girin (ör. 0,21).")

        # Sadece poligon ve multipoligon alınıyor
        gdf = gdf[gdf.geometry.geom_type.isin(['Polygon', 'MultiPolygon'])]
        if gdf.empty:
            logger.warning("Dosyada işlenecek Polygon veya MultiPolygon bulunamadı.")
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
                    logger.error(f"Geometri onarımı sırasında hata: {e}")
                    return None
            return geom

        gdf = gdf.copy()
        gdf['geometry'] = gdf.geometry.apply(geometri_temizle)
        gdf = gdf.dropna(subset=['geometry'])

        if 'id' not in gdf.columns:
            logger.warning("'id' kolonu bulunamadı. Yeni bir group_id oluşturuluyor.")
            gdf['group_id'] = range(len(gdf))
            grup_kolonu = 'group_id'
        else:
            grup_kolonu = 'id'

        # geopandas 1.x: unary_union kaldırıldı/deprecated -> shapely.union_all
        toplanmis_gdf = gdf.groupby(grup_kolonu).agg({
            'geometry': lambda geoms: shapely.union_all(np.asarray(list(geoms), dtype=object)),
            **{col: 'first' for col in gdf.columns if col not in ['geometry', grup_kolonu]}
        })
        toplanmis_gdf = gpd.GeoDataFrame(toplanmis_gdf, geometry='geometry', crs=gdf.crs)

        kok_eleman = etree.Element(f"{{{TKGM}}}FeatureCollection", nsmap={'TKGM': TKGM, 'gml': GML})

        # Sütun adı -> geçerli XML element adı eşlemesi (bir kez hesaplanır, çakışmalar önlenir)
        kullanilan_adlar = set(self.SABIT_ALANLAR)
        xml_adlari = {}
        for kolon in toplanmis_gdf.columns:
            if self.standart_alan_mi(kolon):
                continue
            xml_adlari[kolon] = gecerli_xml_adi(kolon, kullanilan_adlar)
            if xml_adlari[kolon] != str(kolon):
                logger.info(f"GML alan adı düzeltildi: '{kolon}' -> '{xml_adlari[kolon]}'")

        def delikli_poligon_ekle(poligon, ebeveyn_eleman):
            gml_poligon = etree.SubElement(ebeveyn_eleman, f"{{{GML}}}Polygon")

            dis_sinir = etree.SubElement(gml_poligon, f"{{{GML}}}outerBoundaryIs")
            dis_cizgi = etree.SubElement(dis_sinir, f"{{{GML}}}LinearRing")
            koordinatlar_dis = etree.SubElement(dis_cizgi, f"{{{GML}}}coordinates")
            koordinatlar_dis.text = " ".join([f"{x},{y}" for x, y, *_ in poligon.exterior.coords])

            for ic_sinir in poligon.interiors:
                ic_alan = etree.SubElement(gml_poligon, f"{{{GML}}}innerBoundaryIs")
                ic_cizgi = etree.SubElement(ic_alan, f"{{{GML}}}LinearRing")
                koordinatlar_ic = etree.SubElement(ic_cizgi, f"{{{GML}}}coordinates")
                koordinatlar_ic.text = " ".join([f"{x},{y}" for x, y, *_ in ic_sinir.coords])

        ada_parselsiz = 0
        tabakasiz = 0
        tabaka_sayaci = {}
        for id_degeri, satir in toplanmis_gdf.iterrows():
            try:
                geom = satir.geometry
                if geom is None or geom.is_empty:
                    continue

                ozellik_elemani = etree.SubElement(kok_eleman, f"{{{TKGM}}}FeatureMember")
                # Netcad bu obje tipini TK_PARSEL katmanına alır (TKGM parsel GML'iyle aynı yapı).
                ozel_alan = etree.SubElement(ozellik_elemani, f"{{{TKGM}}}Parsel")
                etree.SubElement(ozel_alan, f"{{{TKGM}}}id").text = str(id_degeri)
                ozellikler = {k: satir[k] for k in satir.index if k != 'geometry'}
                ada_parsel = ada_parsel_adi(ozellikler)
                if ada_parsel is None:
                    ada_parselsiz += 1
                    ad = satir.get("ilcead", id_degeri)
                    ad = id_degeri if _bos_metin_mi(ad) else ad
                else:
                    ad = ada_parsel
                etree.SubElement(ozel_alan, f"{{{TKGM}}}ad").text = str(ad)
                for alan, varsayilan in self.TKGM_PARSEL_ALANLARI:
                    deger = sutun_degeri(ozellikler, [sutun_anahtari(alan)])
                    metin = varsayilan if deger is None else str(deger)
                    eleman = etree.SubElement(ozel_alan, f"{{{TKGM}}}{alan}")
                    if metin != '':
                        eleman.text = metin
                tabaka, kaynak = obje_tabakasi(ozellikler, nokta_konum_dogrulugu)
                tabaka_sayaci[tabaka] = tabaka_sayaci.get(tabaka, 0) + 1
                if kaynak == "yok":
                    tabakasiz += 1
                etree.SubElement(ozel_alan, f"{{{TKGM}}}tabaka").text = tabaka

                for kolon, xml_adi in xml_adlari.items():
                    deger = satir[kolon]
                    if bos_mu(deger):  # None / NaN değerler "nan" olarak yazılmaz, atlanır
                        continue
                    etree.SubElement(ozel_alan, f"{{{TKGM}}}{xml_adi}").text = str(deger)

                geom_eleman = etree.SubElement(ozel_alan, f"{{{TKGM}}}geom")

                if geom.geom_type == 'Polygon':
                    delikli_poligon_ekle(geom, geom_eleman)
                elif geom.geom_type == 'MultiPolygon':
                    gml_multi_poligon = etree.SubElement(geom_eleman, f"{{{GML}}}MultiPolygon")
                    for alt_poligon in geom.geoms:
                        poligon_uyesi = etree.SubElement(gml_multi_poligon, f"{{{GML}}}polygonMember")
                        delikli_poligon_ekle(alt_poligon, poligon_uyesi)

            except Exception as e:
                logger.error(f"'{id_degeri}' id'li nesne islenirken hata: {e}")

        if ada_parselsiz:
            logger.warning(f"{ada_parselsiz} objede ada/parsel bilgisi bulunamadı ('ada' ve 'parsel' sütunları); "
                           "ad olarak ilçe adı veya kimlik yazıldı.")
        if tabakasiz:
            logger.warning(f"{tabakasiz} objede nokta konum doğruluğu yok; tabaka 'TK_PARSEL' yazıldı. "
                           "Yanılma sınırı hesabı için --nkd değeri verin veya veride 'nkd' sütunu kullanın.")
        if tabaka_sayaci:
            logger.info("Tabakalar: " + ", ".join(f"{t}: {n}" for t, n in sorted(tabaka_sayaci.items())))

        agac = etree.ElementTree(kok_eleman)
        agac.write(dosya_yolu, pretty_print=True, xml_declaration=True, encoding="UTF-8")
        logger.info(f"Netcad (TKGM) GML dönüşümü tamamlandı: {dosya_yolu}")


class KmzYazici(VeriYaziciBase):
    """KML oluşturup onu zipleyerek KMZ formatına çeviren yazıcı sınıfı."""
    def __init__(self, kml_yazici=None):
        self.kml_yazici = kml_yazici or KmlYazici()

    def yaz(self, gdf: gpd.GeoDataFrame, dosya_yolu: str):
        # Geçici KML, hedef yoldan bağımsız ayrı bir geçici klasörde oluşturulur.
        with tempfile.TemporaryDirectory(prefix="geoconv_kmz_") as gecici_klasor:
            gecici_kml = os.path.join(gecici_klasor, "doc.kml")
            try:
                self.kml_yazici.yaz(gdf, gecici_kml)
            except Exception as e:
                logger.error(f"KML yazılırken hata (KMZ oluşturma adımı 1): {e}")
                raise

            try:
                with zipfile.ZipFile(dosya_yolu, 'w', zipfile.ZIP_DEFLATED) as zf:
                    zf.write(gecici_kml, arcname='doc.kml')
            except Exception as e:
                logger.error(f"KMZ zipleme hatası (KMZ oluşturma adımı 2): {e}")
                raise

        logger.info(f"KMZ dönüşümü başarıyla tamamlandı: {dosya_yolu}")


# ---------------------------------------------------------------------------
# Yönetici
# ---------------------------------------------------------------------------

class DonusturucuYoneticisi:
    """Uzantılara göre uygun okuyucu ve yazıcı sınıfları çalıştıran yönetici (Factory)."""

    def __init__(self):
        # Okuyucu haritalaması
        self.okuyucular = {
            '.csv': CsvOkuyucu(),
            '.shp': GenelOkuyucu(),
            '.zip': ZipShapefileOkuyucu(),
            '.gml': GenelOkuyucu(),
            '.geojson': GenelOkuyucu(),
            '.json': GenelOkuyucu(),
            '.kml': KmlOkuyucu(),
            '.kmz': KmzOkuyucu(),
            '.gpkg': GenelOkuyucu(),
            '.gpx': GpxOkuyucu(),
            '.wkt': WktOkuyucu()
        }

        # Yazıcı haritalaması
        self.yazicilar = {
            '.csv': CsvYazici(),
            '.shp': GenelYazici(surucu='ESRI Shapefile'),
            '.geojson': GenelYazici(surucu='GeoJSON'),
            '.gpkg': GenelYazici(surucu='GPKG'),
            '.kml': KmlYazici(),
            '.kmz': KmzYazici(),
            '.ncz': NetcadGMLYazici(),  # Kullanıcı NCZ isterse NetCAD uyumlu GML yazıyoruz.
            '.gml': NetcadGMLYazici(),  # Varsayılan GML çıktısını Serhat'ın özel TKGM koduna yönlendiriyoruz.
            '.wkt': WktYazici()
        }

    def format_algila_ve_donustur(self, girdi_yolu: str, cikti_yolu: str, hedef_kolonlar=None,
                                  geometri_kolonu=None, kaynak_crs=None, hedef_crs=None,
                                  nokta_konum_dogrulugu=None):
        """Girdiyi okur, (isteğe bağlı) CRS atar/dönüştürür, kolon filtreler ve çıktıyı yazar.

        kaynak_crs: Girdide CRS yoksa atanacak CRS (verilmezse EPSG:4326). Girdide farklı CRS
                    varsa ve bu parametre açıkça verildiyse girdinin CRS'si bununla değiştirilir.
        hedef_crs:  Verilirse veri yazılmadan önce bu CRS'ye dönüştürülür (to_crs).
        nokta_konum_dogrulugu: GML/NCZ çıktısında verideki 'nkd' sütunu yoksa kullanılacak varsayılan
                    nokta konum doğruluğu (m); TKGM tabaka adını belirler (0,21 -> TK_PARSEL_021).
        """
        girdi_uzanti = os.path.splitext(girdi_yolu)[1].lower()
        cikti_uzanti = os.path.splitext(cikti_yolu)[1].lower()

        okuyucu = self.okuyucular.get(girdi_uzanti)
        if not okuyucu:
            raise ValueError(f"Desteklenmeyen girdi formatı: {girdi_uzanti}")

        yazici = self.yazicilar.get(cikti_uzanti)
        if not yazici:
            raise ValueError(f"Desteklenmeyen çıktı formatı: {cikti_uzanti}")

        if cikti_uzanti == '.ncz':
            logger.info("Uyarı: Açık kaynak kütüphaneler ile doğrudan binary (.ncz) oluşturulamaz. Dosya Netcad'in GML formatı standartlarında (Netcad GML / TKGM) dışa aktarılacaktır.")

        logger.info("Dönüşüm başlatılıyor...")
        hedef_kolonlar = list(hedef_kolonlar) if hedef_kolonlar else None  # çağıranın listesini değiştirme

        # 1. Oku (CSV okuyucu kullanıcı geometri kolonunu doğrudan kullanır)
        gdf = okuyucu.oku(girdi_yolu, geometri_kolonu=geometri_kolonu)

        # Diğer formatlarda kullanıcı manuel bir WKT geometri kolonu seçmişse onu geometri yap
        if (geometri_kolonu and not isinstance(okuyucu, CsvOkuyucu)
                and geometri_kolonu in gdf.columns and geometri_kolonu != gdf.geometry.name):
            try:
                yeni_geom = gdf[geometri_kolonu].apply(guvenli_wkt)
                gecerli = yeni_geom.notna()
                gdf = gdf.loc[gecerli].copy()
                gdf = gdf.set_geometry(gpd.GeoSeries(yeni_geom[gecerli], index=gdf.index, crs=gdf.crs))
                logger.info(f"Kullanıcı seçimiyle '{geometri_kolonu}' geometri olarak ayarlandı.")
            except Exception as e:
                logger.warning(f"Kullanıcı geometri kolonu ({geometri_kolonu}) işlenirken hata: {e}")

        if gdf.geometry.name != 'geometry':
            gdf = gdf.rename_geometry('geometry')

        # 1.2 CRS ata / dönüştür
        gdf = crs_ata(gdf, kaynak_crs)
        if hedef_crs:
            logger.info(f"CRS dönüşümü: {gdf.crs.to_string()} -> {hedef_crs}")
            gdf = gdf.to_crs(hedef_crs)

        # GPKG/SHP'de 'geom' adı geometri kolonu için rezerve edildiğinden çakışmayı önlemek için adını değiştir
        for col_name in list(gdf.columns):
            if str(col_name).lower() == 'geom' and col_name != 'geometry':
                new_col_name = f"{col_name}_data"
                gdf = gdf.rename(columns={col_name: new_col_name})
                if hedef_kolonlar and col_name in hedef_kolonlar:
                    hedef_kolonlar[hedef_kolonlar.index(col_name)] = new_col_name

        # EĞER Kullanıcı manuel öznitelik (kolon) filtresi belirlediyse
        if hedef_kolonlar:
            # Sadece var olan kolonları al, geometry zorunlu ekle
            secilecekler = [col for col in hedef_kolonlar if col in gdf.columns]
            eksikler = [col for col in hedef_kolonlar if col not in gdf.columns]
            if eksikler:
                logger.warning(f"İstenen ama bulunamayan kolonlar yok sayıldı: {eksikler}")
            if 'geometry' not in secilecekler:
                secilecekler.append('geometry')
            gdf = gdf[secilecekler]
            logger.info(f"Kullanıcı seçimiyle sadece şu kolonlar dışa aktarılacak: {secilecekler}")

        # 1.5. Gereksiz KML/GeoJSON Sütunlarını Temizle (Eğer veri kml veya togeojson üzerinden geldiyse kirlilik olmasın)
        kml_gereksiz_alanlar = {k.lower() for k in [
            'Name', 'description', 'timestamp', 'begin', 'end',
            'altitudeMode', 'tessellate', 'extrude', 'visibility',
            'drawOrder', 'icon', 'snippet'
        ]}

        dusurulecekler = []
        for kolon in gdf.columns:
            if kolon == 'geometry' or str(kolon).lower() not in kml_gereksiz_alanlar:
                continue
            # Kullanıcı kendi "Name" alanını oluşturmuş olabilir; yalnız boş/varsayılan değerliyse düşür.
            essiz_degerler = gdf[kolon].dropna().unique()
            if len(essiz_degerler) == 0:  # Tümü boş
                dusurulecekler.append(kolon)
            elif all(val in [-1, 0, "-1", "0", ""] for val in essiz_degerler):
                dusurulecekler.append(kolon)

        if dusurulecekler:
            gdf = gdf.drop(columns=dusurulecekler)
            logger.info(f"Gereksiz varsayılan sütunlar temizlendi: {dusurulecekler}")

        # ESRI Shapefile kısıtlaması nedeniyle tamamen boş (NA/NULL) sütunları da düşür
        tum_bos_kolonlar = [col for col in gdf.columns if col != 'geometry' and gdf[col].isnull().all()]
        if tum_bos_kolonlar:
            gdf = gdf.drop(columns=tum_bos_kolonlar)
            logger.info(f"Tamamen boş olan sütunlar temizlendi: {tum_bos_kolonlar}")

        # 2. Yaz
        if isinstance(yazici, NetcadGMLYazici):
            yazici.yaz(gdf, cikti_yolu, nokta_konum_dogrulugu=nokta_konum_dogrulugu)
        else:
            yazici.yaz(gdf, cikti_yolu)
        logger.info("Dönüşüm başarıyla tamamlandı!")
        return cikti_yolu


# ---------------------------------------------------------------------------
# Komut satırı arayüzü
# ---------------------------------------------------------------------------

def arguman_ayristirici() -> argparse.ArgumentParser:
    ayristirici = argparse.ArgumentParser(
        prog="cografi_donusturucu",
        description="Coğrafi veri formatları arasında dönüşüm (CSV, WKT, SHP, ZIP, GeoJSON, GPKG, KML, KMZ, GPX, GML/NCZ).",
    )
    ayristirici.add_argument("girdi", help="Girdi dosyası (uzantıya göre format algılanır)")
    ayristirici.add_argument("cikti", help="Çıktı dosyası (uzantıya göre format algılanır)")
    ayristirici.add_argument("--kaynak-crs", default=None,
                             help=f"Girdinin CRS'si (CRS'siz girdilerde varsayılan {VARSAYILAN_CRS})")
    ayristirici.add_argument("--hedef-crs", default=None, help="Çıktı CRS'si (ör. EPSG:5254); verilirse to_crs yapılır")
    ayristirici.add_argument("--kolonlar", default=None, help="Virgülle ayrılmış, dışa aktarılacak kolonlar (ör. a,b)")
    ayristirici.add_argument("--geometri-kolonu", default=None, help="WKT içeren geometri kolonunun adı")
    ayristirici.add_argument("--nkd", default=None,
                             help="GML/NCZ: verideki 'nkd' sütunu yoksa kullanılacak nokta konum doğruluğu (m), "
                                  "ör. 0.21 -> tabaka TK_PARSEL_021")
    ayristirici.add_argument("-v", "--ayrintili", action="store_true", help="Ayrıntılı (DEBUG) log")
    return ayristirici


def main(argv=None) -> int:
    args = arguman_ayristirici().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.ayrintili else logging.INFO,
                        format='%(asctime)s - %(levelname)s - %(message)s')
    kolonlar = [k.strip() for k in args.kolonlar.split(",") if k.strip()] if args.kolonlar else None
    try:
        DonusturucuYoneticisi().format_algila_ve_donustur(
            args.girdi, args.cikti,
            hedef_kolonlar=kolonlar,
            geometri_kolonu=args.geometri_kolonu,
            kaynak_crs=args.kaynak_crs,
            hedef_crs=args.hedef_crs,
            nokta_konum_dogrulugu=args.nkd,
        )
    except Exception as e:
        logger.error(f"Dönüşüm başarısız: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
