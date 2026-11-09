import { describe, it, expect } from 'vitest';
import { uyarilariGrupla } from './uyariGrupla.js';

const mesaj = 'geometri hücresi boş, satır atlandı.';

describe('uyarilariGrupla', () => {
  it('aynı mesajlı satırları tek kalemde, ardışıkları aralık olarak toplar', () => {
    const uyarilar = [364, 1550, 4792, 4793, 4794, 4795, 4796, 4797, 4798, 11632, 11633].map((n) => `Satır ${n}: ${mesaj}`);
    expect(uyarilariGrupla(uyarilar)).toEqual([
      { metin: `Satır 364, 1550, 4792–4798, 11632–11633: ${mesaj} (toplam 11 satır)`, adet: 11 },
    ]);
  });

  it('farklı mesajları ayrı kalem yapar, ilk görülme sırasını korur', () => {
    const sonuc = uyarilariGrupla(['Satır 5: b', 'Satır 2: a', 'Satır 3: a', 'Genel uyarı']);
    expect(sonuc.map((k) => k.metin)).toEqual(['Satır 5: b', 'Satır 2–3: a (toplam 2 satır)', 'Genel uyarı']);
  });

  it('çok satırlı aralık etiketlerini (Satır 6–7) ve sırasız girdiyi işler', () => {
    const sonuc = uyarilariGrupla(['Satır 10–12: x', 'Satır 2: x', 'Satır 13: x']);
    expect(sonuc[0]).toEqual({ metin: 'Satır 2, 10–13: x (toplam 5 satır)', adet: 5 });
  });

  it('aralık sayısını sınırlar', () => {
    const uyarilar = Array.from({ length: 20 }, (_, i) => `Satır ${i * 10}: x`);
    expect(uyarilariGrupla(uyarilar, 3)[0].metin).toBe('Satır 0, 10, 20 ve 17 aralık daha: x (toplam 20 satır)');
  });

  it('tekrarlanan serbest uyarıyı sayar; boş girdide boş döner', () => {
    expect(uyarilariGrupla(['A', 'A', 'B'])).toEqual([{ metin: 'A (2 kez)', adet: 2 }, { metin: 'B', adet: 1 }]);
    expect(uyarilariGrupla(undefined)).toEqual([]);
  });
});
