"""cografi_donusturucu.py için pytest testleri."""
import json
import os
import sys
import zipfile

import pytest

gpd = pytest.importorskip("geopandas")
pytest.importorskip("pyogrio")
etree = pytest.importorskip("lxml.etree")

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import cografi_donusturucu as cd  # noqa: E402
from shapely.geometry import Point, Polygon  # noqa: E402


@pytest.fixture
def yonetici():
    return cd.DonusturucuYoneticisi()


def yaz(yol, metin):
    yol.write_text(metin, encoding="utf-8")
    return str(yol)


# ---------------------------------------------------------------------------
# Sütun tespiti regresyon testleri
# ---------------------------------------------------------------------------

class TestKolonTespiti:
    def test_index_ve_max_alan_x_sayilmaz(self):
        x, y = cd.CsvOkuyucu.koordinat_kolonlari_bul(["index", "max_alan", "yukseklik", "x", "y"])
        assert (x, y) == ("x", "y")

    def test_alt_dize_eslesmesi_yok(self):
        # Eski kod: 'index' -> X (içinde 'x'), 'yil' / 'party' -> Y (içinde 'y')
        x, y = cd.CsvOkuyucu.koordinat_kolonlari_bul(["index", "yil", "party", "max_alan"])
        assert x is None and y is None

    @pytest.mark.parametrize("x_ad,y_ad", [
        ("X", "Y"), ("lon", "lat"), ("Longitude", "Latitude"), ("Boylam", "Enlem"),
        ("easting", "northing"), ("X_Koord", "Y_Koord"), ("Doğu", "Kuzey"), ("x koordinat", "y koordinat"),
    ])
    def test_bilinen_adlar(self, x_ad, y_ad):
        assert cd.CsvOkuyucu.koordinat_kolonlari_bul(["id", x_ad, y_ad]) == (x_ad, y_ad)

    def test_wkt_kolonu_tam_eslesme(self):
        assert cd.CsvOkuyucu.wkt_kolonu_bul(["id", "geometry_type", "geomatik_not", "WKT"]) == "WKT"
        assert cd.CsvOkuyucu.wkt_kolonu_bul(["id", "the_geom"]) == "the_geom"
        assert cd.CsvOkuyucu.wkt_kolonu_bul(["id", "geometry_type", "geomatik"]) is None

    def test_normalize(self):
        assert cd.kolon_adi_normalize(" X_Koord ") == "xkoord"
        assert cd.kolon_adi_normalize("Doğu") == "dogu"


# ---------------------------------------------------------------------------
# CSV okuma
# ---------------------------------------------------------------------------

class TestCsvOkuyucu:
    def test_xy_ve_yaniltici_kolonlar(self, tmp_path):
        yol = yaz(tmp_path / "n.csv", "index;max_alan;x;y\n1;10;30.5;40.1\n2;20;31.0;41.0\n")
        gdf = cd.CsvOkuyucu().oku(yol)
        assert len(gdf) == 2
        assert gdf.geometry.iloc[0].equals(Point(30.5, 40.1))
        assert list(gdf["index"]) == [1, 2]

    def test_bozuk_float_satiri_atlanir(self, tmp_path):
        yol = yaz(tmp_path / "n.csv", "ad,lon,lat\na,30,40\nb,abc,41\nc,32,\nd,33,43\n")
        gdf = cd.CsvOkuyucu().oku(yol)
        assert list(gdf["ad"]) == ["a", "d"]

    def test_ondalik_virgul(self, tmp_path):
        yol = yaz(tmp_path / "n.csv", "ad;boylam;enlem\na;30,25;40,75\n")
        gdf = cd.CsvOkuyucu().oku(yol)
        assert gdf.geometry.iloc[0].equals(Point(30.25, 40.75))

    def test_wkt_kolonu(self, tmp_path):
        yol = yaz(tmp_path / "w.csv", 'ad;wkt\na;POINT (1 2)\nb;bozuk\nc;"POLYGON ((0 0, 1 0, 1 1, 0 0))"\n')
        gdf = cd.CsvOkuyucu().oku(yol)
        assert list(gdf["ad"]) == ["a", "c"]
        assert gdf.geometry.iloc[1].geom_type == "Polygon"

    def test_kullanici_geometri_kolonu(self, tmp_path):
        yol = yaz(tmp_path / "w.csv", "ad;sekil\na;POINT (5 6)\n")
        gdf = cd.CsvOkuyucu().oku(yol, geometri_kolonu="sekil")
        assert gdf.geometry.iloc[0].equals(Point(5, 6))

    def test_geometri_yoksa_hata(self, tmp_path):
        yol = yaz(tmp_path / "n.csv", "index;max_alan\n1;2\n")
        with pytest.raises(ValueError):
            cd.CsvOkuyucu().oku(yol)


# ---------------------------------------------------------------------------
# Dönüşümler + CRS
# ---------------------------------------------------------------------------

class TestDonusum:
    def test_csv_to_geojson_varsayilan_crs(self, tmp_path, yonetici):
        girdi = yaz(tmp_path / "n.csv", "ad;x;y\na;30;40\nb;31;41\n")
        cikti = str(tmp_path / "c.geojson")
        yonetici.format_algila_ve_donustur(girdi, cikti)
        gdf = gpd.read_file(cikti)
        assert len(gdf) == 2
        assert gdf.crs.to_epsg() == 4326
        assert gdf.geometry.iloc[0].equals(Point(30, 40))

    def test_csv_to_gpkg_hedef_crs(self, tmp_path, yonetici):
        girdi = yaz(tmp_path / "n.csv", "ad;lon;lat\na;30;40\n")
        cikti = str(tmp_path / "c.gpkg")
        yonetici.format_algila_ve_donustur(girdi, cikti, kaynak_crs="EPSG:4326", hedef_crs="EPSG:3857")
        gdf = gpd.read_file(cikti)
        assert gdf.crs.to_epsg() == 3857
        assert abs(gdf.geometry.iloc[0].x - 3339584.72) < 1.0

    def test_kolon_filtresi_cagiranin_listesini_degistirmez(self, tmp_path, yonetici):
        girdi = yaz(tmp_path / "n.csv", "a;b;c;geom;x;y\n1;2;3;g;30;40\n")
        cikti = str(tmp_path / "c.geojson")
        kolonlar = ["a", "geom"]
        yonetici.format_algila_ve_donustur(girdi, cikti, hedef_kolonlar=kolonlar)
        assert kolonlar == ["a", "geom"]
        gdf = gpd.read_file(cikti)
        assert set(gdf.columns) == {"a", "geom_data", "geometry"}

    def test_wkt_to_wkt(self, tmp_path, yonetici):
        girdi = yaz(tmp_path / "g.wkt", "POINT (1 2)\n\nbozuk satir\nLINESTRING (0 0, 1 1)\n")
        cikti = tmp_path / "c.wkt"
        yonetici.format_algila_ve_donustur(girdi, str(cikti))
        satirlar = cikti.read_text(encoding="utf-8").splitlines()
        assert satirlar == ["POINT (1 2)", "LINESTRING (0 0, 1 1)"]

    def test_geojson_to_csv(self, tmp_path, yonetici):
        fc = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"ad": "a"}, "geometry": {"type": "Point", "coordinates": [1, 2]}}]}
        girdi = yaz(tmp_path / "g.geojson", json.dumps(fc))
        cikti = tmp_path / "c.csv"
        yonetici.format_algila_ve_donustur(girdi, str(cikti))
        icerik = cikti.read_text(encoding="utf-8")
        assert "POINT (1 2)" in icerik and "ad" in icerik

    def test_kaynak_crs_csvye_atanir(self, tmp_path, yonetici):
        girdi = yaz(tmp_path / "n.csv", "ad;x;y\na;500000;4500000\n")
        cikti = str(tmp_path / "c.gpkg")
        yonetici.format_algila_ve_donustur(girdi, cikti, kaynak_crs="EPSG:5254")
        assert gpd.read_file(cikti).crs.to_epsg() == 5254

    def test_zip_shapefile_okuma(self, tmp_path, yonetici):
        klasor = tmp_path / "shp"
        klasor.mkdir()
        gpd.GeoDataFrame({"ad": ["a"]}, geometry=[Point(1, 2)], crs="EPSG:4326").to_file(klasor / "k.shp")
        zip_yol = tmp_path / "k.zip"
        with zipfile.ZipFile(zip_yol, "w") as zf:
            for f in klasor.iterdir():
                zf.write(f, arcname=f"alt/{f.name}")
        cikti = str(tmp_path / "c.geojson")
        yonetici.format_algila_ve_donustur(str(zip_yol), cikti)
        gdf = gpd.read_file(cikti)
        assert list(gdf["ad"]) == ["a"]

    def test_gpx_okuma(self, tmp_path, yonetici):
        gpx = ('<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">'
               '<wpt lat="40.0" lon="30.0"><name>n1</name></wpt></gpx>')
        girdi = yaz(tmp_path / "g.gpx", gpx)
        cikti = str(tmp_path / "c.geojson")
        yonetici.format_algila_ve_donustur(girdi, cikti)
        gdf = gpd.read_file(cikti)
        assert len(gdf) == 1 and gdf.geometry.iloc[0].equals(Point(30, 40))

    def test_desteklenmeyen_format(self, tmp_path, yonetici):
        with pytest.raises(ValueError):
            yonetici.format_algila_ve_donustur(str(tmp_path / "a.xyz"), str(tmp_path / "b.csv"))


# ---------------------------------------------------------------------------
# KML / KMZ
# ---------------------------------------------------------------------------

def _kml_surucusu_var():
    import pyogrio
    suruculer = pyogrio.list_drivers()
    return any("w" in suruculer.get(s, "") for s in ("LIBKML", "KML"))


@pytest.mark.skipif(not _kml_surucusu_var(), reason="GDAL KML/LIBKML yazma sürücüsü yok")
class TestKml:
    def test_kmz_yaz_ve_oku_yolda_kmz_gecse_bile(self, tmp_path, yonetici):
        klasor = tmp_path / "proje.kmz.klasor"
        klasor.mkdir()
        girdi = yaz(tmp_path / "n.csv", "ad;x;y\na;30;40\n")
        cikti = klasor / "sonuc.kmz"
        yonetici.format_algila_ve_donustur(girdi, str(cikti))
        assert zipfile.is_zipfile(cikti)
        with zipfile.ZipFile(cikti) as zf:
            assert "doc.kml" in zf.namelist()
        assert not list(klasor.glob("*.kml"))
        gdf = cd.KmzOkuyucu().oku(str(cikti))
        assert len(gdf) == 1
        assert gdf.geometry.iloc[0].x == pytest.approx(30)

    def test_kml_projekte_veriden_4326(self, tmp_path, yonetici):
        girdi = yaz(tmp_path / "n.csv", "ad;x;y\na;3339584.72;4865942.28\n")
        cikti = str(tmp_path / "c.kml")
        yonetici.format_algila_ve_donustur(girdi, cikti, kaynak_crs="EPSG:3857")
        gdf = gpd.read_file(cikti)
        assert gdf.geometry.iloc[0].x == pytest.approx(30, abs=1e-6)


# ---------------------------------------------------------------------------
# Netcad / TKGM GML
# ---------------------------------------------------------------------------

class TestNetcadGml:
    def test_gml_xml_adlari_ve_nan(self, tmp_path):
        gdf = gpd.GeoDataFrame(
            {"id": [1, 1, 2], "parsel no": ["5", "5", None], "1alan": [1.5, 1.5, float("nan")],
             "mahalle/köy": ["A", "A", "B"]},
            geometry=[Polygon([(0, 0), (1, 0), (1, 1)]), Polygon([(2, 2), (3, 2), (3, 3)]),
                      Polygon([(5, 5), (6, 5), (6, 6)])],
            crs="EPSG:4326",
        )
        cikti = tmp_path / "c.gml"
        cd.NetcadGMLYazici().yaz(gdf, str(cikti))
        agac = etree.parse(str(cikti))  # geçerli XML olmalı
        ns = {"T": cd.NetcadGMLYazici.TKGM_NS, "gml": cd.NetcadGMLYazici.GML_NS}
        uyeler = agac.findall(".//T:OzelAlanZemin", ns)
        assert len(uyeler) == 2
        etiketler = {etree.QName(e).localname for e in uyeler[0]}
        assert {"parsel_no", "_1alan", "mahalle_köy"} <= etiketler
        # id=1 iki poligon -> union -> MultiPolygon
        assert uyeler[0].find(".//gml:MultiPolygon", ns) is not None
        # id=2'de NaN/None değerler yazılmaz
        etiketler2 = {etree.QName(e).localname for e in uyeler[1]}
        assert "parsel_no" not in etiketler2 and "_1alan" not in etiketler2
        assert "nan" not in cikti.read_text(encoding="utf-8")

    @pytest.mark.parametrize("girdi,beklenen", [
        ("parsel no", "parsel_no"), ("1alan", "_1alan"), ("xmlAlan", "_xmlAlan"),
        ("ölçü", "ölçü"), ("a/b", "a_b"), ("", "alan"),
    ])
    def test_gecerli_xml_adi(self, girdi, beklenen):
        assert cd.gecerli_xml_adi(girdi) == beklenen
        etree.Element(cd.gecerli_xml_adi(girdi))  # lxml kabul etmeli

    def test_xml_adi_cakismasi(self):
        kullanilan = {"id"}
        assert cd.gecerli_xml_adi("a b", kullanilan) == "a_b"
        assert cd.gecerli_xml_adi("a/b", kullanilan) == "a_b_2"


# ---------------------------------------------------------------------------
# CLI ve import yan etkisi
# ---------------------------------------------------------------------------

def test_cli(tmp_path):
    girdi = yaz(tmp_path / "n.csv", "a;b;c;wkt\n1;2;3;POINT (30 40)\n")
    cikti = str(tmp_path / "c.gpkg")
    kod = cd.main([girdi, cikti, "--kaynak-crs", "EPSG:4326", "--hedef-crs", "EPSG:5254",
                   "--kolonlar", "a,b", "--geometri-kolonu", "wkt"])
    assert kod == 0
    gdf = gpd.read_file(cikti)
    assert gdf.crs.to_epsg() == 5254
    assert set(gdf.columns) == {"a", "b", "geometry"}


def test_cli_hata_kodu(tmp_path):
    assert cd.main([str(tmp_path / "yok.csv"), str(tmp_path / "c.gpkg")]) == 1


def test_import_global_logging_yapilandirmaz():
    import subprocess
    # Temiz bir yorumlayıcıda import edildiğinde root logger'a handler eklenmemeli.
    proje = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    kod = ("import sys, logging; sys.path.insert(0, sys.argv[1]); import cografi_donusturucu; "
           "print(len(logging.getLogger().handlers))")
    sonuc = subprocess.run([sys.executable, "-c", kod, proje], capture_output=True, text=True, check=True)
    assert sonuc.stdout.strip() == "0"
