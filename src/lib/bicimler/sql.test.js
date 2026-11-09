import { describe, it, expect } from 'vitest';
import { sqlYaz, metinTirnakla, tanimlayiciTirnakla, adTemizle } from './sql.js';
import { wktCoz } from '../wkt.js';

const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (properties, geometry = { type: 'Point', coordinates: [500000, 4500000] }) => ({
  type: 'Feature',
  properties,
  geometry,
});

/** Betikteki EWKB hex değerlerini sırayla çıkarır. */
const ewkbler = (sql) => [...sql.matchAll(/ST_GeomFromEWKB\('\\x([0-9A-F]+)'::bytea\)/g)].map((m) => m[1]);

describe('sqlYaz — betik yapısı', () => {
  it('başlık, BEGIN, CREATE TABLE, INSERT, GIST indeksi, COMMIT sırası', async () => {
    const { veri, uyarilar } = await sqlYaz(fc([obje({ ad: 'Ankara', nufus: 5700000 })]), { crs: 'EPSG:5255' });
    expect(veri.startsWith('-- ')).toBe(true);
    const sira = [
      "SET client_encoding = 'UTF8';",
      'SET standard_conforming_strings = on;',
      'BEGIN;',
      'CREATE TABLE "objeler" (',
      'INSERT INTO "objeler" ("ad", "nufus", geom) VALUES',
      'CREATE INDEX "objeler_geom_gist" ON "objeler" USING GIST (geom);',
      'COMMIT;',
    ].map((p) => veri.indexOf(p));
    expect(sira.every((i) => i >= 0)).toBe(true);
    expect([...sira].sort((a, b) => a - b)).toEqual(sira);
    expect(veri).toContain('  id serial PRIMARY KEY,\n  "ad" text,\n  "nufus" bigint,\n  geom geometry(Point, 5255)\n);');
    expect(veri).toContain("  ('Ankara', 5700000, ST_GeomFromEWKB('\\x01010000208714");
    expect(uyarilar).toEqual([]);
  });

  it('EWKB geometrisi SRID ile gidiş-dönüş yapar', async () => {
    const g = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const { veri } = await sqlYaz(fc([obje({}, g)]), { crs: 'EPSG:5255' });
    const [h] = ewkbler(veri);
    expect(h.slice(10, 18)).toBe('87140000'); // SRID 5255 little-endian
    expect(wktCoz(h)).toEqual(g);
  });

  it('şema ve tablo adı tırnaklanır; Türkçe karakter korunur', async () => {
    const { veri } = await sqlYaz(fc([obje({ 'İlçe Adı': 'Çankaya' })]), {
      crs: 'EPSG:4326', sema: 'cbs', tabloAdi: 'Parseller "2024"',
    });
    expect(veri).toContain('CREATE TABLE "cbs"."Parseller ""2024""" (');
    expect(veri).toContain('"İlçe Adı" text');
    expect(veri).toContain("('Çankaya',");
    expect(veri).toContain('CREATE INDEX "Parseller ""2024""_geom_gist" ON "cbs"."Parseller ""2024"""');
  });

  it('SRID verilmezse 4326 varsayılır ve uyarılır', async () => {
    const { veri, uyarilar } = await sqlYaz(fc([obje({})]));
    expect(veri).toContain('geom geometry(Point, 4326)');
    expect(uyarilar.join(' ')).toMatch(/SRID 4326/);
    const r = await sqlYaz(fc([obje({})]), { crs: 'benim-sistemim' });
    expect(r.uyarilar.join(' ')).toMatch(/"benim-sistemim".*SRID 4326/);
  });

  it('Z geometri → PointZ; karışık tipte Geometry; karışık Z uyarısı', async () => {
    let r = await sqlYaz(fc([obje({}, { type: 'Point', coordinates: [1, 2, 3] })]), { crs: 'EPSG:4326' });
    expect(r.veri).toContain('geom geometry(PointZ, 4326)');
    r = await sqlYaz(
      fc([obje({}), obje({}, { type: 'LineString', coordinates: [[0, 0, 1], [1, 1, 1]] })]),
      { crs: 'EPSG:4326' },
    );
    expect(r.veri).toContain('geom geometry(GeometryZ, 4326)');
    expect(r.uyarilar.join(' ')).toMatch(/Z = 0/);
    expect(wktCoz(ewkbler(r.veri)[0])).toEqual({ type: 'Point', coordinates: [500000, 4500000, 0] });
  });
});

describe('sqlYaz — kaçış ve enjeksiyon', () => {
  it("O'Brien ve ';DROP TABLE' metin olarak kalır", async () => {
    const { veri } = await sqlYaz(fc([obje({ ad: "O'Brien", not: "x'); DROP TABLE objeler; --" })]), { crs: 'EPSG:4326' });
    expect(veri).toContain("'O''Brien'");
    expect(veri).toContain("'x''); DROP TABLE objeler; --'");
    // Enjeksiyon satır başında komut olarak yer almaz.
    expect(veri.split('\n').some((s) => s.trim().startsWith('DROP'))).toBe(false);
  });

  it('ters bölü olduğu gibi, NUL ayıklanır', async () => {
    expect(metinTirnakla('C:\\yol\\dosya')).toBe("'C:\\yol\\dosya'");
    expect(metinTirnakla('a\u0000b')).toBe("'ab'");
  });

  it('çift tırnaklı sütun adı kaçışlanır', async () => {
    const { veri } = await sqlYaz(fc([obje({ 'say"ı': 1, 'a"; DROP TABLE x; --': 'v' })]), { crs: 'EPSG:4326' });
    expect(veri).toContain('"say""ı" bigint');
    expect(veri).toContain('"a""; DROP TABLE x; --" text');
  });

  it("'id' ve 'geom' çakışmaları yeniden adlandırılır ve uyarılır", async () => {
    const { veri, uyarilar } = await sqlYaz(fc([obje({ id: 7, GEOM: 'x', id_1: 'var' })]), { crs: 'EPSG:4326' });
    expect(veri).toContain('"id_2" bigint');
    expect(veri).toContain('"GEOM_1" text');
    expect(veri).toContain('"id_1" text');
    expect(uyarilar.filter((u) => /çakıştığı/.test(u))).toHaveLength(2);
  });

  it('tanımlayıcı yardımcıları: 63 bayt kırpma, boş ad', async () => {
    expect(tanimlayiciTirnakla('a"b')).toBe('"a""b"');
    expect(new TextEncoder().encode(adTemizle('ş'.repeat(40))).length).toBe(62);
    const { veri } = await sqlYaz(fc([obje({ '': 1 })]), { crs: 'EPSG:4326', tabloAdi: '  ' });
    expect(veri).toContain('"sutun_1" bigint');
    expect(veri).toContain('CREATE TABLE "objeler"');
  });

  it('yorum satırlarına satır sonu sızmaz', async () => {
    const { veri } = await sqlYaz(fc([]), { crs: 'EPSG:4326', tabloAdi: 'a\nDROP TABLE b;' });
    expect(veri.split('\n').some((s) => s.startsWith('DROP'))).toBe(false);
  });
});

describe('sqlYaz — tip çıkarımı ve değerler', () => {
  it('bigint / double / boolean / jsonb / text', async () => {
    const { veri } = await sqlYaz(
      fc([
        obje({ t: 1, d: 1, b: true, j: { a: 1 }, k: 1, m: 'x' }),
        obje({ t: 2, d: 2.5, b: false, j: [1, "o'"], k: 'iki', m: null }),
      ]),
      { crs: 'EPSG:4326' },
    );
    expect(veri).toMatch(/"t" bigint,\n {2}"d" double precision,\n {2}"b" boolean,\n {2}"j" jsonb,\n {2}"k" text,\n {2}"m" text/);
    expect(veri).toContain(`(1, 1, TRUE, '{"a":1}'::jsonb, '1', 'x',`);
    expect(veri).toContain(`(2, 2.5, FALSE, '[1,"o''"]'::jsonb, 'iki', NULL,`);
  });

  it('NaN/Infinity tırnaklı yazılır; tamamı null sütun text', async () => {
    const { veri } = await sqlYaz(fc([obje({ s: NaN, n: null }), obje({ s: Infinity })]), { crs: 'EPSG:4326' });
    expect(veri).toContain('"s" double precision');
    expect(veri).toContain('"n" text');
    expect(veri).toContain("('NaN', NULL,");
    expect(veri).toContain("('Infinity', NULL,");
  });

  it('null geometri ve eksik öznitelik → NULL', async () => {
    const { veri, uyarilar } = await sqlYaz(fc([obje({ a: 1 }, null), obje({})]), { crs: 'EPSG:4326' });
    expect(veri).toContain('  (1, NULL),');
    expect(veri).toMatch(/ {2}\(NULL, ST_GeomFromEWKB/);
    expect(uyarilar.join(' ')).toMatch(/1 obje geometrisiz/);
  });
});

describe('sqlYaz — toplu INSERT ve boş veri', () => {
  it('500\'erli VALUES blokları', async () => {
    const features = Array.from({ length: 1201 }, (_, i) => obje({ n: i }, { type: 'Point', coordinates: [i, i] }));
    const { veri } = await sqlYaz(fc(features), { crs: 'EPSG:4326' });
    expect(veri.match(/^INSERT INTO /gm)).toHaveLength(3);
    const bloklar = veri.split(/^INSERT INTO .*VALUES\n/m).slice(1).map((b) => b.split(';\n')[0].split(',\n').length);
    expect(bloklar).toEqual([500, 500, 201]);
    expect(ewkbler(veri)).toHaveLength(1201);
  });

  it('topluBoyut seçeneği', async () => {
    const features = Array.from({ length: 5 }, () => obje({}));
    const { veri } = await sqlYaz(fc(features), { crs: 'EPSG:4326', topluBoyut: 2 });
    expect(veri.match(/^INSERT INTO /gm)).toHaveLength(3);
  });

  it('boş FC: tablo + indeks, INSERT yok', async () => {
    const { veri, uyarilar } = await sqlYaz(fc([]), { crs: 'EPSG:5254' });
    expect(veri).toContain('  id serial PRIMARY KEY,\n  geom geometry(Geometry, 5254)\n);');
    expect(veri).not.toContain('INSERT');
    expect(veri).toContain('USING GIST (geom)');
    expect(veri).toContain('COMMIT;');
    expect(uyarilar.join(' ')).toMatch(/boş/);
  });

  it('geçersiz FC hata verir', async () => {
    await expect(sqlYaz(null)).rejects.toThrow(/FeatureCollection/);
  });
});

describe('sqlYaz — geometri tipi politikası', () => {
  const P = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const MP = { type: 'MultiPolygon', coordinates: [P.coordinates] };

  it('Polygon + MultiPolygon → MultiPolygon sütunu, tekiller yükseltilir', async () => {
    const { veri, uyarilar } = await sqlYaz(fc([obje({}, P), obje({}, MP)]), { crs: 'EPSG:5255' });
    expect(veri).toContain('geom geometry(MultiPolygon, 5255)');
    expect(ewkbler(veri).map(wktCoz)).toEqual([MP, MP]);
    expect(uyarilar.join(' ')).toMatch(/1 tekil geometri tek parçalı MultiPolygon/);
  });

  it('tek aileli GeometryCollection düzleştirilir', async () => {
    const gc = { type: 'GeometryCollection', geometries: [P, P] };
    const { veri, uyarilar } = await sqlYaz(fc([obje({}, gc)]), { crs: 'EPSG:5255' });
    expect(veri).toContain('geom geometry(MultiPolygon, 5255)');
    expect(wktCoz(ewkbler(veri)[0])).toEqual({ type: 'MultiPolygon', coordinates: [P.coordinates, P.coordinates] });
    expect(uyarilar.join(' ')).toMatch(/düzleştirildi/);
  });

  it('farklı aileler → Geometry, geometriler değişmez', async () => {
    const { veri } = await sqlYaz(fc([obje({}, P), obje({})]), { crs: 'EPSG:5255' });
    expect(veri).toContain('geom geometry(Geometry, 5255)');
    expect(wktCoz(ewkbler(veri)[0])).toEqual(P);
  });
});

describe('sqlYaz — tarih ve büyük tamsayı', () => {
  const sutunTipi = (veri, ad) => new RegExp(`\\n {2}"${ad}" ([a-z ]+),`).exec(veri)?.[1];

  it('date / timestamptz / timestamp / geçersiz takvim → text', async () => {
    const { veri } = await sqlYaz(
      fc([
        obje({ d: '2024-02-29', tz: '2024-05-01T12:30:00Z', ts: '2024-05-01T12:30:00', g: '2024-02-30', k: '2024-05-01', x: 1 }),
        obje({ d: '2000-12-31', tz: '2024-05-01 08:00:00.5+03:00', ts: '2024-05-01 23:59', g: '2024-01-01', k: '2024-05-01T10:00:00Z', x: 1 }),
      ]),
      { crs: 'EPSG:4326' },
    );
    expect(sutunTipi(veri, 'd')).toBe('date');
    expect(sutunTipi(veri, 'tz')).toBe('timestamptz');
    expect(sutunTipi(veri, 'ts')).toBe('timestamp');
    expect(sutunTipi(veri, 'g')).toBe('text');
    expect(sutunTipi(veri, 'k')).toBe('text'); // tarih + tarih-saat karışık
    expect(veri).toContain("('2024-02-29', '2024-05-01T12:30:00Z', '2024-05-01T12:30:00', '2024-02-30',");
  });

  it.each(['2023-02-29', '2024-13-01', '0000-01-01', '2024-05-01T24:00:00', '2024-05-01T12:60', '2024-5-1'])(
    '%s tarih sayılmaz',
    async (deger) => {
      const { veri } = await sqlYaz(fc([obje({ t: deger, x: 1 })]), { crs: 'EPSG:4326' });
      expect(sutunTipi(veri, 't')).toBe('text');
    },
  );

  it('güvenli olmayan tamsayı → double precision + uyarı', async () => {
    const { veri, uyarilar } = await sqlYaz(fc([obje({ n: 2 ** 60, m: 5, x: 1 })]), { crs: 'EPSG:4326' });
    expect(sutunTipi(veri, 'n')).toBe('double precision');
    expect(sutunTipi(veri, 'm')).toBe('bigint');
    expect(uyarilar.join(' ')).toMatch(/"n" sütununda güvenli tamsayı aralığını/);
    expect(uyarilar.join(' ')).not.toMatch(/"m" sütununda/);
  });

  it('BigInt değerleri: int64 içinde bigint, dışında uyarı', async () => {
    const { veri, uyarilar } = await sqlYaz(fc([obje({ a: 9007199254740993n, b: 2n ** 70n, x: 1 })]), { crs: 'EPSG:4326' });
    expect(sutunTipi(veri, 'a')).toBe('bigint');
    expect(veri).toContain('(9007199254740993, ');
    expect(uyarilar.join(' ')).toMatch(/"b" sütununda/);
  });
});

describe('sqlYaz — tabloyuDegistir ve indeks adı', () => {
  it('varsayılan: DROP yok; tabloyuDegistir: BEGIN sonrası DROP TABLE IF EXISTS', async () => {
    expect((await sqlYaz(fc([obje({})]), { crs: 'EPSG:4326' })).veri).not.toContain('DROP TABLE');
    const { veri } = await sqlYaz(fc([obje({})]), { crs: 'EPSG:4326', sema: 'cbs', tabloyuDegistir: true });
    const i = veri.indexOf('DROP TABLE IF EXISTS "cbs"."objeler";');
    expect(i).toBeGreaterThan(veri.indexOf('BEGIN;'));
    expect(i).toBeLessThan(veri.indexOf('CREATE TABLE'));
  });

  it('uzun tablo adlarında indeks adı 63 bayta sığar ve özetle ayrışır', async () => {
    const indeks = async (ad) => /CREATE INDEX "([^"]+)"/.exec((await sqlYaz(fc([]), { crs: 'EPSG:4326', tabloAdi: ad })).veri)[1];
    const kok = 'çok_uzun_kadastro_tablosu_'.repeat(2);
    const a = await indeks(`${kok}A`);
    const b = await indeks(`${kok}B`);
    expect(new TextEncoder().encode(a).length).toBeLessThanOrEqual(63);
    expect(a).toMatch(/_[0-9a-f]{8}_geom_gist$/);
    expect(a).not.toBe(b);
    expect(await indeks('parsel')).toBe('parsel_geom_gist');
  });
});
