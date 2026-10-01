export const desteklenen_formatlar = [
  {
    kategori: "CAD, Yerli Yazılımlar ve Üretim",
    formatlar: [
      { uzanti: ".dwg", aciklama: "AutoCAD Drawing" },
      { uzanti: ".ncz", aciklama: "Netcad Drawing" },
      { uzanti: ".stp", aciklama: "STEP" },
      { uzanti: ".step", aciklama: "STEP" },
      { uzanti: ".igs", aciklama: "IGES" },
      { uzanti: ".iges", aciklama: "IGES" },
      { uzanti: ".dxf", aciklama: "Drawing Exchange Format" },
      { uzanti: ".sat", aciklama: "ACIS SAT" },
      { uzanti: ".dgn", aciklama: "MicroStation Design" },
      { uzanti: ".3dm", aciklama: "Rhino 3D Model" },
      { uzanti: ".x_t", aciklama: "Parasolid Text" },
      { uzanti: ".x_b", aciklama: "Parasolid Binary" }
    ]
  },
  {
    kategori: "3B Kent Modelleri ve Kadastro",
    formatlar: [
      { uzanti: ".gml", aciklama: "CityGML / GML" },
      { uzanti: ".xml", aciklama: "LandXML / TKGM CityGML" },
      { uzanti: ".ifc", aciklama: "BIM / Yapı Bilgi Modellemesi" }
    ]
  },
  {
    kategori: "CBS ve Veritabanı Geometri",
    formatlar: [
      { uzanti: ".gdb", aciklama: "Esri File Geodatabase" },
      { uzanti: ".shp", aciklama: "Shapefile" },
      { uzanti: ".geojson", aciklama: "GeoJSON" },
      { uzanti: ".kml", aciklama: "KML" },
      { uzanti: ".kmz", aciklama: "KMZ" },
      { uzanti: ".gpkg", aciklama: "GeoPackage" },
      { uzanti: ".sqlite", aciklama: "SpatiaLite" },
      { uzanti: "postgis", aciklama: "PostGIS Veritabanı (Geom)" },
      { uzanti: ".wkt", aciklama: "Well-Known Text" },
      { uzanti: ".wkb", aciklama: "Well-Known Binary" },
      { uzanti: ".mvt", aciklama: "Vector Tile Geometrisi" },
      { uzanti: ".pbf", aciklama: "Protocolbuffer Binary Format" },
      { uzanti: ".tab", aciklama: "MapInfo TAB" },
      { uzanti: ".map", aciklama: "MapInfo MAP" },
      { uzanti: ".e00", aciklama: "ArcInfo Interchange File" }
    ]
  },
  {
    kategori: "3D Modelleme, Mesh ve Animasyon",
    formatlar: [
      { uzanti: ".obj", aciklama: "Wavefront OBJ" },
      { uzanti: ".stl", aciklama: "Stereolithography" },
      { uzanti: ".fbx", aciklama: "Filmbox" },
      { uzanti: ".gltf", aciklama: "glTF" },
      { uzanti: ".glb", aciklama: "glTF Binary" },
      { uzanti: ".usd", aciklama: "Universal Scene Description" },
      { uzanti: ".usdz", aciklama: "USD Zipped" },
      { uzanti: ".ply", aciklama: "Polygon File Format" },
      { uzanti: ".dae", aciklama: "Collada" },
      { uzanti: ".3ds", aciklama: "3D Studio" },
      { uzanti: ".blend", aciklama: "Blender" },
      { uzanti: ".c4d", aciklama: "Cinema 4D" },
      { uzanti: ".ma", aciklama: "Maya ASCII" },
      { uzanti: ".mb", aciklama: "Maya Binary" },
      { uzanti: ".wrl", aciklama: "VRML" },
      { uzanti: ".x3d", aciklama: "X3D" },
      { uzanti: ".abc", aciklama: "Alembic" }
    ]
  },
  {
    kategori: "Nokta Bulutu (Lidar)",
    formatlar: [
      { uzanti: ".las", aciklama: "LASer" },
      { uzanti: ".laz", aciklama: "LASer Zipped" },
      { uzanti: ".xyz", aciklama: "XYZ Point Cloud" },
      { uzanti: ".e57", aciklama: "ASTM E57 3D" },
      { uzanti: ".pts", aciklama: "PTS Point Cloud" },
      { uzanti: ".ptx", aciklama: "PTX Point Cloud" },
      { uzanti: ".pcd", aciklama: "Point Cloud Data" }
    ]
  },
  {
    kategori: "Bilimsel Veri ve Metin Formatları",
    formatlar: [
      { uzanti: ".nc", aciklama: "NetCDF" },
      { uzanti: ".h5", aciklama: "HDF5" },
      { uzanti: ".ffs", aciklama: "FME FFS" },
      { uzanti: ".csv", aciklama: "Comma Separated Values" },
      { uzanti: ".txt", aciklama: "Metin Belgesi" },
      { uzanti: ".md", aciklama: "Markdown" },
      { uzanti: ".json", aciklama: "JSON" },
      { uzanti: ".sql", aciklama: "SQL Script" },
      { uzanti: ".html", aciklama: "HTML Document" }
    ]
  }
];

export const tum_formatlari_duz_liste = () => {
  let liste = [];
  desteklenen_formatlar.forEach(grup => {
    grup.formatlar.forEach(fmt => {
      liste.push({
        kategori: grup.kategori,
        uzanti: fmt.uzanti,
        aciklama: fmt.aciklama
      });
    });
  });
  return liste;
};
