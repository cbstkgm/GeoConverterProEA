import { describe, it, expect } from 'vitest';
import { markdownYaz, mdHucre } from './markdown.js';

const fc = (features) => ({ type: 'FeatureCollection', features });
const obje = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });
const SALDIRI = '</script><script>alert(1)</script>';

const tumTipler = () =>
  fc([
    obje({ type: 'Point', coordinates: [32.85, 39.93] }, { ad: 'Ankara', il_kodu: 6 }),
    obje({ type: 'MultiPoint', coordinates: [[30, 40], [31, 41]] }, { ad: 'Çoklu' }),
    obje({ type: 'LineString', coordinates: [[30, 40], [31, 41], [32, 42]] }),
    obje({ type: 'MultiLineString', coordinates: [[[30, 40], [31, 41]]] }),
    obje({ type: 'Polygon', coordinates: [[[30, 40], [31, 40], [31, 41], [30, 40]]] }),
    obje({ type: 'MultiPolygon', coordinates: [[[[30, 40], [31, 40], [31, 41], [30, 40]]]] }),
    obje({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [33, 39] }] }),
    obje(null, { ad: 'Şişli', not: null }),
  ]);

/** Tablo satırlarını kaçışlı | dikkate alınarak hücrelere böler. */
const hucreler = (satir) => satir.slice(2, -2).split(/(?<!\\) \| /);

describe('markdownYaz', () => {
  it('özet + tüm geometri tipleriyle tablo', async () => {
    const { veri, onizleme, uyarilar } = await markdownYaz(tumTipler(), { crs: 'EPSG:4326' });
    expect(onizleme).toBe(veri);
    expect(uyarilar).toEqual([]);
    expect(veri).toContain('- **Obje sayısı:** 8');
    expect(veri).toContain(
      '- **Geometri tipleri:** Point: 1, MultiPoint: 1, LineString: 1, MultiLineString: 1, Polygon: 1, MultiPolygon: 1, GeometryCollection: 1, Geometrisiz: 1',
    );
    expect(veri).toContain('- **Koordinat sistemi:** WGS84 Coğrafi (Enlem/Boylam) (EPSG:4326)');
    expect(veri).toContain('- **Sınır kutusu:** X 30 … 33, Y 39 … 42');
    const satirlar = veri.split('\n').filter((s) => s.startsWith('| '));
    expect(satirlar[0]).toBe('| # | Geometri | ad | il_kodu | not |');
    expect(satirlar[1]).toBe('| ---: | --- | --- | --- | --- |');
    expect(satirlar).toHaveLength(10);
    expect(satirlar[2]).toBe('| 1 | Point (1 köşe) | Ankara | 6 |  |');
    expect(hucreler(satirlar[4])[1]).toBe('LineString (3 köşe)');
    expect(hucreler(satirlar[6])[1]).toBe('Polygon (4 köşe)');
    expect(hucreler(satirlar[8])[1]).toBe('GeometryCollection (1 köşe)');
    expect(satirlar[9]).toBe('| 8 | (yok) | Şişli |  |  |');
    // Her satırda aynı sayıda hücre.
    for (const s of satirlar) expect(hucreler(s)).toHaveLength(5);
  });

  it('wktSutunu: kısaltılmış WKT', async () => {
    const uzun = Array.from({ length: 50 }, (_, i) => [30 + i, 40]);
    const { veri } = await markdownYaz(
      fc([obje({ type: 'Point', coordinates: [1, 2] }), obje({ type: 'LineString', coordinates: uzun })]),
      { wktSutunu: true },
    );
    expect(veri).toContain('| 1 | POINT (1 2) |');
    const satir = veri.split('\n').find((s) => s.startsWith('| 2 |'));
    expect(satir).toMatch(/LINESTRING \(30 40, .*…/);
    expect(hucreler(satir)[1].length).toBeLessThanOrEqual(81);
  });

  it('hücre kaçışı: |, satır sonu, ters eğik çizgi, null, HTML/XSS', () => {
    expect(mdHucre('a|b')).toBe('a\\|b');
    expect(mdHucre('a\r\nb\nc\rd')).toBe('a<br>b<br>c<br>d');
    expect(mdHucre('C:\\yol')).toBe('C:\\\\yol');
    expect(mdHucre(null)).toBe('');
    expect(mdHucre(undefined)).toBe('');
    expect(mdHucre(0)).toBe('0');
    expect(mdHucre(false)).toBe('false');
    expect(mdHucre({ a: 1 })).toBe('{"a":1}');
    expect(mdHucre(SALDIRI)).toBe('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mdHucre('[x](javascript:alert(1))')).toBe('\\[x\\](javascript:alert(1))');
    expect(mdHucre('ĞÜŞİÖÇ ğüşıöç')).toBe('ĞÜŞİÖÇ ğüşıöç');
    expect(mdHucre('`kod`')).toBe('\\`kod\\`');
    expect(mdHucre('![r](x)')).toBe('!\\[r\\](x)');
  });

  it('okunabilirlik: gereksiz kaçış yok', () => {
    for (const s of ['il_kodu', 'a_b_c', 'ADA_NO', 'şehir_adı_ğ', 'parsel_2', '-5.25', '+90', '#12', '3.14', 'e-posta', 'a#b', 'C-2 blok']) {
      expect(mdHucre(s)).toBe(s);
    }
  });

  it('gerekli Markdown kaçışları: kelime sınırında _ * ~, satır başı blok işaretleri', () => {
    expect(mdHucre('_vurgu_')).toBe('\\_vurgu\\_');
    expect(mdHucre('__kalın__ x')).toBe('\\_\\_kalın\\_\\_ x');
    expect(mdHucre('a *b* c')).toBe('a \\*b\\* c');
    expect(mdHucre('a*b*c')).toBe('a\\*b\\*c');
    expect(mdHucre('~~çizik~~')).toBe('\\~\\~çizik\\~\\~');
    expect(mdHucre('# Başlık')).toBe('\\# Başlık');
    expect(mdHucre('### Başlık')).toBe('\\### Başlık');
    expect(mdHucre('- madde')).toBe('\\- madde');
    expect(mdHucre('+ madde')).toBe('\\+ madde');
    expect(mdHucre('1. madde\n2) ikinci')).toBe('1\\. madde<br>2\\) ikinci');
    expect(mdHucre('> alıntı')).toBe('&gt; alıntı');
    expect(mdHucre('a\\_b')).toBe('a\\\\\\_b');
  });

  it('saldırı dizeleri tabloyu bozmaz ve ham HTML üretmez', async () => {
    const kotu = `${SALDIRI}|x\ny`;
    const { veri } = await markdownYaz(fc([obje({ type: 'Point', coordinates: [1, 2] }, { [kotu]: kotu, 'ç': 'İ' })]), {
      baslik: SALDIRI,
    });
    expect(veri).not.toMatch(/<script|<\/script/);
    const satirlar = veri.split('\n').filter((s) => s.startsWith('| '));
    expect(satirlar).toHaveLength(3);
    for (const s of satirlar) expect(hucreler(s)).toHaveLength(4);
    expect(satirlar[2]).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;\\|x<br>y');
  });

  it('boş FC', async () => {
    const { veri, uyarilar } = await markdownYaz(fc([]));
    expect(veri).toContain('- **Obje sayısı:** 0');
    expect(veri).toContain('- **Geometri tipleri:** —');
    expect(veri).toContain('- **Koordinat sistemi:** belirtilmedi');
    expect(veri).toContain('- **Sınır kutusu:** —');
    expect(veri).toContain('_Tabloda gösterilecek obje yok._');
    expect(uyarilar).toHaveLength(1);
    await expect(markdownYaz({})).rejects.toThrow(/FeatureCollection/);
  });

  it('enFazlaSatir sonrası kesilir ve not düşülür; özet tüm veriyi sayar', async () => {
    const cok = fc(Array.from({ length: 1500 }, (_, i) => obje({ type: 'Point', coordinates: [i, i] }, { no: i })));
    const { veri, uyarilar } = await markdownYaz(cok);
    const satirlar = veri.split('\n').filter((s) => /^\| \d/.test(s));
    expect(satirlar).toHaveLength(1000);
    expect(veri).toContain('- **Obje sayısı:** 1500');
    expect(veri).toContain('> **Not:** Tablo 1000 satırla sınırlandı; kalan 500 obje gösterilmedi (toplam 1500).');
    expect(uyarilar).toHaveLength(1);
    const kisa = await markdownYaz(cok, { enFazlaSatir: 10 });
    expect(kisa.veri.split('\n').filter((s) => /^\| \d/.test(s))).toHaveLength(10);
  });

  it('bilinmeyen CRS kodu olduğu gibi yazılır', async () => {
    const { veri } = await markdownYaz(fc([]), { crs: 'EPSG:5255' });
    expect(veri).toContain('ITRF96 / 3° TM 33 (EPSG:5255)');
    expect((await markdownYaz(fc([]), { crs: 'EPSG:9999' })).veri).toContain('**Koordinat sistemi:** EPSG:9999');
  });
});
