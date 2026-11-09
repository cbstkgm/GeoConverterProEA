import { describe, expect, it } from 'vitest';
import { boylamdanItrf96Dilimi, itrf96Mi, veridenItrf96Dilimi } from './dilim';

const fc = (...boylamlar) => ({
  type: 'FeatureCollection',
  features: boylamlar.map((x) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [x, 39] } })),
});

describe('boylamdanItrf96Dilimi', () => {
  it.each([
    [26, 'EPSG:5253', 27],
    [29.0, 'EPSG:5254', 30], // İstanbul
    [32.85, 'EPSG:5255', 33], // Ankara
    [35.3, 'EPSG:5256', 36], // Adana
    [39.7, 'EPSG:5257', 39], // Trabzon
    [43.0, 'EPSG:5258', 42], // Van
    [44.5, 'EPSG:5259', 45],
  ])('%f° → %s', (boylam, kod, dom) => {
    expect(boylamdanItrf96Dilimi(boylam)).toEqual({ kod, dom, disarida: false });
  });

  it('dilim sınırı (DOM ± 1,5°) bir sonraki dilime geçer', () => {
    expect(boylamdanItrf96Dilimi(31.4).dom).toBe(30);
    expect(boylamdanItrf96Dilimi(31.6).dom).toBe(33);
  });

  it('Türkiye dışı boylamlar en yakın dilime sıkıştırılır ve işaretlenir', () => {
    expect(boylamdanItrf96Dilimi(10)).toEqual({ kod: 'EPSG:5253', dom: 27, disarida: true });
    expect(boylamdanItrf96Dilimi(50)).toEqual({ kod: 'EPSG:5259', dom: 45, disarida: true });
  });

  it('geçersiz boylamda null döner', () => {
    expect(boylamdanItrf96Dilimi(NaN)).toBeNull();
  });
});

describe('veridenItrf96Dilimi', () => {
  it('sınır kutusu ortasına göre dilim seçer', () => {
    const s = veridenItrf96Dilimi(fc(32.84, 32.86));
    expect(s).toMatchObject({ kod: 'EPSG:5255', dom: 33, coklu: false, dilimler: [33] });
    expect(s.boylam).toBeCloseTo(32.85);
  });

  it('birden çok dilime yayılan veriyi bildirir', () => {
    expect(veridenItrf96Dilimi(fc(29, 36))).toMatchObject({ dom: 33, coklu: true, dilimler: [30, 33, 36] });
  });

  it('iç içe ve koleksiyon geometrilerini gezer, boş veride null döner', () => {
    const veri = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: null },
        {
          type: 'Feature',
          geometry: {
            type: 'GeometryCollection',
            geometries: [{ type: 'Polygon', coordinates: [[[39.6, 41], [39.8, 41], [39.8, 41.1], [39.6, 41]]] }],
          },
        },
      ],
    };
    expect(veridenItrf96Dilimi(veri).kod).toBe('EPSG:5257');
    expect(veridenItrf96Dilimi({ type: 'FeatureCollection', features: [] })).toBeNull();
  });
});

describe('itrf96Mi', () => {
  it('yalnızca EPSG:5253–5259 için doğrudur', () => {
    expect(itrf96Mi('EPSG:5253')).toBe(true);
    expect(itrf96Mi('EPSG:5259')).toBe(true);
    expect(itrf96Mi('EPSG:4326')).toBe(false);
    expect(itrf96Mi('EPSG:23036')).toBe(false);
  });
});
