// FileGDB sistem tablolarının sabit içerikleri.
// GDAL ogr/ogrsf_frmts/openfilegdb/ogropenfilegdbdatasource_write.cpp (CreateGDBDBTune, CreateGDBItemTypes,
// CreateGDBItemRelationshipTypes) ve ogr_openfilegdb.h'tan betikle aktarılmıştır (GDAL: MIT lisansı).

export const KLASOR_TIPI = '{f3783e6f-65ca-4514-8315-ce3985dad3b1}'
export const CALISMA_ALANI_TIPI = '{c673fe0f-7280-404f-8532-20755dd8fc06}'
export const OBJE_SINIFI_TIPI = '{70737809-852c-4a03-9e22-2cecea5b9bfa}'
export const TABLO_TIPI = '{cd06bc3b-789d-4c51-aafa-a467912b8965}'
export const KLASORDE_VERI_KUMESI = '{dc78f1ab-34e4-43ac-ba47-1c4eabd0e7c7}'

/** GDB_DBTune: [Keyword, ParameterName, ConfigString] */
export const DBTUNE = Object.freeze([
  ['DEFAULTS', 'UI_TEXT', 'The default datafile configuration.'],
  ['DEFAULTS', 'CHARACTER_FORMAT', 'UTF8'],
  ['DEFAULTS', 'GEOMETRY_FORMAT', 'Compressed'],
  ['DEFAULTS', 'GEOMETRY_STORAGE', 'InLine'],
  ['DEFAULTS', 'BLOB_STORAGE', 'InLine'],
  ['DEFAULTS', 'MAX_FILE_SIZE', '1TB'],
  ['DEFAULTS', 'RASTER_STORAGE', 'InLine'],
  ['TEXT_UTF16', 'UI_TEXT', 'The UTF16 text format configuration.'],
  ['TEXT_UTF16', 'CHARACTER_FORMAT', 'UTF16'],
  ['MAX_FILE_SIZE_4GB', 'UI_TEXT', 'The 4GB maximum datafile size configuration.'],
  ['MAX_FILE_SIZE_4GB', 'MAX_FILE_SIZE', '4GB'],
  ['MAX_FILE_SIZE_256TB', 'UI_TEXT', 'The 256TB maximum datafile size configuration.'],
  ['MAX_FILE_SIZE_256TB', 'MAX_FILE_SIZE', '256TB'],
  ['GEOMETRY_UNCOMPRESSED', 'UI_TEXT', 'The Uncompressed Geometry configuration.'],
  ['GEOMETRY_UNCOMPRESSED', 'GEOMETRY_FORMAT', 'Uncompressed'],
  ['GEOMETRY_OUTOFLINE', 'UI_TEXT', 'The Outofline Geometry configuration.'],
  ['GEOMETRY_OUTOFLINE', 'GEOMETRY_STORAGE', 'OutOfLine'],
  ['BLOB_OUTOFLINE', 'UI_TEXT', 'The Outofline Blob configuration.'],
  ['BLOB_OUTOFLINE', 'BLOB_STORAGE', 'OutOfLine'],
  ['GEOMETRY_AND_BLOB_OUTOFLINE', 'UI_TEXT', 'The Outofline Geometry and Blob configuration.'],
  ['GEOMETRY_AND_BLOB_OUTOFLINE', 'GEOMETRY_STORAGE', 'OutOfLine'],
  ['GEOMETRY_AND_BLOB_OUTOFLINE', 'BLOB_STORAGE', 'OutOfLine'],
  ['TERRAIN_DEFAULTS', 'UI_TERRAIN_TEXT', 'The terrains default configuration.'],
  ['TERRAIN_DEFAULTS', 'GEOMETRY_STORAGE', 'OutOfLine'],
  ['TERRAIN_DEFAULTS', 'BLOB_STORAGE', 'OutOfLine'],
  ['MOSAICDATASET_DEFAULTS', 'UI_MOSAIC_TEXT', 'The Outofline Raster and Blob configuration.'],
  ['MOSAICDATASET_DEFAULTS', 'RASTER_STORAGE', 'OutOfLine'],
  ['MOSAICDATASET_DEFAULTS', 'BLOB_STORAGE', 'OutOfLine'],
  ['MOSAICDATASET_INLINE', 'UI_MOSAIC_TEXT', 'The mosaic dataset inline configuration.'],
  ['MOSAICDATASET_INLINE', 'CHARACTER_FORMAT', 'UTF8'],
  ['MOSAICDATASET_INLINE', 'GEOMETRY_FORMAT', 'Compressed'],
  ['MOSAICDATASET_INLINE', 'GEOMETRY_STORAGE', 'InLine'],
  ['MOSAICDATASET_INLINE', 'BLOB_STORAGE', 'InLine'],
  ['MOSAICDATASET_INLINE', 'MAX_FILE_SIZE', '1TB'],
  ['MOSAICDATASET_INLINE', 'RASTER_STORAGE', 'InLine'],
])

/** GDB_ItemTypes: [UUID, ParentTypeID, Name] */
export const OGE_TIPLERI = Object.freeze([
  ['{8405add5-8df8-4227-8fac-3fcade073386}', '{00000000-0000-0000-0000-000000000000}', 'Item'],
  ['{f3783e6f-65ca-4514-8315-ce3985dad3b1}', '{8405add5-8df8-4227-8fac-3fcade073386}', 'Folder'],
  ['{ffd09c28-fe70-4e25-907c-af8e8a5ec5f3}', '{8405add5-8df8-4227-8fac-3fcade073386}', 'Resource'],
  ['{28da9e89-ff80-4d6d-8926-4ee2b161677d}', '{ffd09c28-fe70-4e25-907c-af8e8a5ec5f3}', 'Dataset'],
  ['{fbdd7dd6-4a25-40b7-9a1a-ecc3d1172447}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Tin'],
  ['{d4912162-3413-476e-9da4-2aefbbc16939}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'AbstractTable'],
  ['{b606a7e1-fa5b-439c-849c-6e9c2481537b}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Relationship Class'],
  ['{74737149-DCB5-4257-8904-B9724E32A530}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Feature Dataset'],
  ['{73718a66-afb9-4b88-a551-cffa0ae12620}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Geometric Network'],
  ['{767152d3-ed66-4325-8774-420d46674e07}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Topology'],
  ['{e6302665-416b-44fa-be33-4e15916ba101}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Survey Dataset'],
  ['{d5a40288-029e-4766-8c81-de3f61129371}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Schematic Dataset'],
  ['{db1b697a-3bb6-426a-98a2-6ee7a4c6aed3}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Toolbox'],
  ['{c673fe0f-7280-404f-8532-20755dd8fc06}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Workspace'],
  ['{dc9ef677-1aa3-45a7-8acd-303a5202d0dc}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Workspace Extension'],
  ['{77292603-930f-475d-ae4f-b8970f42f394}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Extension Dataset'],
  ['{8637f1ed-8c04-4866-a44a-1cb8288b3c63}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Domain'],
  ['{4ed4a58e-621f-4043-95ed-850fba45fcbc}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Replica'],
  ['{d98421eb-d582-4713-9484-43304d0810f6}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Replica Dataset'],
  ['{dc64b6e4-dc0f-43bd-b4f5-f22385dcf055}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'Historical Marker'],
  ['{cd06bc3b-789d-4c51-aafa-a467912b8965}', '{d4912162-3413-476e-9da4-2aefbbc16939}', 'Table'],
  ['{70737809-852c-4a03-9e22-2cecea5b9bfa}', '{d4912162-3413-476e-9da4-2aefbbc16939}', 'Feature Class'],
  ['{5ed667a3-9ca9-44a2-8029-d95bf23704b9}', '{d4912162-3413-476e-9da4-2aefbbc16939}', 'Raster Dataset'],
  ['{35b601f7-45ce-4aff-adb7-7702d3839b12}', '{d4912162-3413-476e-9da4-2aefbbc16939}', 'Raster Catalog'],
  ['{7771fc7d-a38b-4fd3-8225-639d17e9a131}', '{77292603-930f-475d-ae4f-b8970f42f394}', 'Network Dataset'],
  ['{76357537-3364-48af-a4be-783c7c28b5cb}', '{77292603-930f-475d-ae4f-b8970f42f394}', 'Terrain'],
  ['{a3803369-5fc2-4963-bae0-13effc09dd73}', '{77292603-930f-475d-ae4f-b8970f42f394}', 'Parcel Fabric'],
  ['{a300008d-0cea-4f6a-9dfa-46af829a3df2}', '{77292603-930f-475d-ae4f-b8970f42f394}', 'Representation Class'],
  ['{787bea35-4a86-494f-bb48-500b96145b58}', '{77292603-930f-475d-ae4f-b8970f42f394}', 'Catalog Dataset'],
  ['{f8413dcb-2248-4935-bfe9-315f397e5110}', '{77292603-930f-475d-ae4f-b8970f42f394}', 'Mosaic Dataset'],
  ['{c29da988-8c3e-45f7-8b5c-18e51ee7beb4}', '{8637f1ed-8c04-4866-a44a-1cb8288b3c63}', 'Range Domain'],
  ['{8c368b12-a12e-4c7e-9638-c9c64e69e98f}', '{8637f1ed-8c04-4866-a44a-1cb8288b3c63}', 'Coded Value Domain'],
])

/** GDB_ItemRelationshipTypes: [UUID, OrigItemTypeID, DestItemTypeID, Name, ForwardLabel, BackwardLabel, IsContainment] */
export const ILISKI_TIPLERI = Object.freeze([
  ['{0d10b3a7-2f64-45e6-b7ac-2fc27bf2133c}', '{f3783e6f-65ca-4514-8315-ce3985dad3b1}', '{f3783e6f-65ca-4514-8315-ce3985dad3b1}', 'FolderInFolder', 'Parent Folder Of', 'Child Folder Of', 1],
  ['{5dd0c1af-cb3d-4fea-8c51-cb3ba8d77cdb}', '{f3783e6f-65ca-4514-8315-ce3985dad3b1}', '{8405add5-8df8-4227-8fac-3fcade073386}', 'ItemInFolder', 'Contains Item', 'Contained In Folder', 1],
  ['{a1633a59-46ba-4448-8706-d8abe2b2b02e}', '{74737149-DCB5-4257-8904-B9724E32A530}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'DatasetInFeatureDataset', 'Contains Dataset', 'Contained In FeatureDataset', 1],
  ['{dc78f1ab-34e4-43ac-ba47-1c4eabd0e7c7}', '{f3783e6f-65ca-4514-8315-ce3985dad3b1}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'DatasetInFolder', 'Contains Dataset', 'Contained in Dataset', 1],
  ['{17e08adb-2b31-4dcd-8fdd-df529e88f843}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', '{8637f1ed-8c04-4866-a44a-1cb8288b3c63}', 'DomainInDataset', 'Contains Domain', 'Contained in Dataset', 0],
  ['{725badab-3452-491b-a795-55f32d67229c}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'DatasetsRelatedThrough', 'Origin Of', 'Destination Of', 0],
  ['{d088b110-190b-4229-bdf7-89fddd14d1ea}', '{767152d3-ed66-4325-8774-420d46674e07}', '{70737809-852c-4a03-9e22-2cecea5b9bfa}', 'FeatureClassInTopology', 'Spatially Manages Feature Class', 'Participates In Topology', 0],
  ['{dc739a70-9b71-41e8-868c-008cf46f16d7}', '{73718a66-afb9-4b88-a551-cffa0ae12620}', '{70737809-852c-4a03-9e22-2cecea5b9bfa}', 'FeatureClassInGeometricNetwork', 'Spatially Manages Feature Class', 'Participates In Geometric Network', 0],
  ['{b32b8563-0b96-4d32-92c4-086423ae9962}', '{7771fc7d-a38b-4fd3-8225-639d17e9a131}', '{70737809-852c-4a03-9e22-2cecea5b9bfa}', 'FeatureClassInNetworkDataset', 'Spatially Manages Feature Class', 'Participates In Network Dataset', 0],
  ['{908a4670-1111-48c6-8269-134fdd3fe617}', '{7771fc7d-a38b-4fd3-8225-639d17e9a131}', '{cd06bc3b-789d-4c51-aafa-a467912b8965}', 'TableInNetworkDataset', 'Manages Table', 'Participates In Network Dataset', 0],
  ['{55d2f4dc-cb17-4e32-a8c7-47591e8c71de}', '{76357537-3364-48af-a4be-783c7c28b5cb}', '{70737809-852c-4a03-9e22-2cecea5b9bfa}', 'FeatureClassInTerrain', 'Spatially Manages Feature Class', 'Participates In Terrain', 0],
  ['{583a5baa-3551-41ae-8aa8-1185719f3889}', '{a3803369-5fc2-4963-bae0-13effc09dd73}', '{70737809-852c-4a03-9e22-2cecea5b9bfa}', 'FeatureClassInParcelFabric', 'Spatially Manages Feature Class', 'Participates In Parcel Fabric', 0],
  ['{5f9085e0-788f-4354-ae3c-34c83a7ea784}', '{a3803369-5fc2-4963-bae0-13effc09dd73}', '{cd06bc3b-789d-4c51-aafa-a467912b8965}', 'TableInParcelFabric', 'Manages Table', 'Participates In Parcel Fabric', 0],
  ['{e79b44e3-f833-4b12-90a1-364ec4ddc43e}', '{70737809-852c-4a03-9e22-2cecea5b9bfa}', '{a300008d-0cea-4f6a-9dfa-46af829a3df2}', 'RepresentationOfFeatureClass', 'Feature Class Representation', 'Represented Feature Class', 0],
  ['{8db31af1-df7c-4632-aa10-3cc44b0c6914}', '{4ed4a58e-621f-4043-95ed-850fba45fcbc}', '{d98421eb-d582-4713-9484-43304d0810f6}', 'ReplicaDatasetInReplica', 'Replicated Dataset', 'Participates In Replica', 1],
  ['{d022de33-45bd-424c-88bf-5b1b6b957bd3}', '{d98421eb-d582-4713-9484-43304d0810f6}', '{28da9e89-ff80-4d6d-8926-4ee2b161677d}', 'DatasetOfReplicaDataset', 'Replicated Dataset', 'Dataset of Replicated Dataset', 0],
])
