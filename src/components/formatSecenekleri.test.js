import { describe, it, expect } from 'vitest';
import { aramaMetni, formatEslesir, TARAYICI_FORMATLARI, VARSAYILAN_HEDEF } from './formatSecenekleri.js';

const fmt = (aciklama, uzanti) => ({ aciklama, uzanti });

describe('format arama', () => {
  it('Türkçe karakterleri katlar ve büyük/küçük harfe duyarsızdır', () => {
    expect(aramaMetni('  GÖRÜNÜM  İzmir   Işık ')).toBe('gorunum izmir isik');
  });

  it('ad, uzantı ve kategoride arar; her kelime eşleşmeli', () => {
    expect(formatEslesir(fmt('KML', '.kml'), 'Tarayıcıda desteklenen', 'kml')).toBe(true);
    expect(formatEslesir(fmt('Well-Known Text', '.wkt'), 'X', '.WKT')).toBe(true);
    expect(formatEslesir(fmt('Netcad Drawing', '.ncz'), 'CAD, Yerli Yazılımlar', 'yerli netcad')).toBe(true);
    expect(formatEslesir(fmt('LASer', '.las'), 'Nokta Bulutu (Lidar)', 'nokta bulutu')).toBe(true);
    expect(formatEslesir(fmt('Netcad Drawing', '.ncz'), 'CAD', 'netcad kml')).toBe(false);
  });

  it('Türkçe karakter yazmadan Türkçe adı bulur', () => {
    expect(formatEslesir(fmt('BIM / Yapı Bilgi Modellemesi', '.ifc'), '3B Kent', 'yapi bilgi')).toBe(true);
  });

  it('boş arama her şeyle eşleşir', () => {
    expect(formatEslesir(fmt('KML', '.kml'), '', '   ')).toBe(true);
  });

  it('varsayılan hedef WKT ve tarayıcı listesinde', () => {
    expect(VARSAYILAN_HEDEF).toBe('.wkt');
    expect(TARAYICI_FORMATLARI.map((f) => f.uzanti)).toContain('.wkt');
  });
});
