import { describe, it, expect } from 'vitest';
import {
  transferSeqOf, transferDeviceTagOf, shouldTagTransfer, nextTransferSeq,
  formatTransferNumber, allocateTransferNumber, duplicateTransferNumbers,
} from '../transferNumber';

/**
 * ترقيم النقل — نفس علّة الفواتير: `transfers.length + 1` يعدّ من قائمة هذا الجهاز.
 * جهازان ينقلان معاً ⟵ رقمان متطابقان لحركتين مختلفتين، وحذف نقلٍ يُعيد استعمال رقمه.
 */

const t = (transferNumber: string, deviceTag?: string) => ({ transferNumber, deviceTag });

describe('تحليل الرقم', () => {
  it('يقبل الصيغتين: عربية ولاتينية، موسومة وغير موسومة', () => {
    expect(transferSeqOf('TR-٧')).toBe(7);
    expect(transferSeqOf('TR-7')).toBe(7);
    expect(transferSeqOf('TR-٢٠٤٤/٧٣')).toBe(2044);
    expect(transferDeviceTagOf('TR-٢٠٤٤/٧٣')).toBe('73');
    expect(transferDeviceTagOf('TR-٢٠٤٤')).toBe('');
  });

  it('يرفض التالف بدل أن يتسرّب إلى التسلسل', () => {
    for (const bad of ['', 'TR-', 'TR-أ', '٧', 'INV-٧', 'TR-٧ب', undefined]) {
      expect(transferSeqOf(bad as string), `قبل «${bad}»`).toBeNull();
    }
  });
});

describe('🔴 التسلسل من أعلى رقم مستعمل لا من طول القائمة', () => {
  it('أول نقل = ١', () => {
    expect(nextTransferSeq([])).toBe(1);
    expect(allocateTransferNumber([])).toBe('TR-١');
  });

  it('الحذف لا يُعيد استعمال رقم — وهذا هو الفرق كله عن العدّ', () => {
    // ثلاثة نقولات (١ ٢ ٣) ثم حُذف الأوسط ⇒ الطول ٢ فالعدّ يعطي ٣ **وهو مستعمل**
    const after = [t('TR-١'), t('TR-٣')];
    expect(after.length + 1, 'العدّ القديم كان يُعيد رقم ٣ المستعمل').toBe(3);
    expect(nextTransferSeq(after)).toBe(4);
  });

  it('الأرقام التالفة لا تُوقف التسلسل', () => {
    expect(nextTransferSeq([t('TR-٥'), t('خربان'), t('TR-')])).toBe(6);
  });

  it('الرقم المُصدَر لم يكن مستعملاً قطّ — خاصيّة على أشكال بيانات مختلفة', () => {
    const shapes = [
      [], [t('TR-١')], [t('TR-٩'), t('TR-٢')], [t('TR-١'), t('TR-١')],
      [t('TR-١٠٠/٧٣'), t('TR-٩٩/١٦')], [t('تالف'), t('TR-٤')], [t('TR-٣'), t('')],
    ];
    for (const list of shapes) {
      const issued = allocateTransferNumber(list, '73');
      const seq = transferSeqOf(issued)!;
      const used = list.map(x => transferSeqOf(x.transferNumber)).filter(s => s !== null);
      expect(used, `الرقم ${issued} كان مستعملاً في ${JSON.stringify(list)}`).not.toContain(seq);
    }
  });
});

describe('🔴 وسم الجهاز يبدأ من الحقل لا من شكل الرقم', () => {
  it('جهاز واحد ⇒ لا وسم إطلاقاً — صاحب الجهاز الواحد لا يرى فرقاً', () => {
    expect(allocateTransferNumber([t('TR-١', '73'), t('TR-٢', '73')], '73')).toBe('TR-٣');
  });

  it('ظهور جهاز ثانٍ ⇒ يوسم **كلاهما**', () => {
    const data = [t('TR-١', '73'), t('TR-٢', '16')];
    expect(allocateTransferNumber(data, '73')).toBe('TR-٣/٧٣');
    expect(allocateTransferNumber(data, '16')).toBe('TR-٣/١٦');
  });

  it('🔴 لو كانت الإشارة شكلَ الرقم لما وسم أحدٌ أولاً فاصطدما', () => {
    // بيانات جهاز واحد: لا رقم موسوم بعد. الحقل وحده يكشف الجهاز الآخر.
    expect(shouldTagTransfer([t('TR-١', '16')], '73'), 'الحقل يكشف التعدّد من أول نقل').toBe(true);
    expect(shouldTagTransfer([t('TR-١', '73')], '73')).toBe(false);
  });

  it('بيانات قديمة موسومة داخل الرقم بلا حقل تُفهم أيضاً', () => {
    expect(shouldTagTransfer([t('TR-١/١٦')], '73')).toBe(true);
  });

  it('بلا رمز جهاز (تخزين محلي معطَّل) ⇒ لا وسم ولا كسر', () => {
    expect(shouldTagTransfer([t('TR-١', '16')], '')).toBe(false);
    expect(allocateTransferNumber([t('TR-١', '16')], '')).toBe('TR-٢');
  });

  it('الوسم يفصل مساحتي الترقيم فصلاً تامّاً ولو دام الانقطاع', () => {
    const shared = [t('TR-١', '73'), t('TR-١', '16')];
    const a = allocateTransferNumber(shared, '73');
    const b = allocateTransferNumber(shared, '16');
    expect(a).not.toBe(b);
  });
});

describe('كشف ما وقع قبل الإصلاح', () => {
  it('يُظهر المكرَّر ويسكت عن السليم', () => {
    expect(duplicateTransferNumbers([t('TR-١'), t('TR-١'), t('TR-٢')]))
      .toEqual([{ number: 'TR-١', count: 2 }]);
    expect(duplicateTransferNumbers([t('TR-١'), t('TR-٢')])).toEqual([]);
  });

  it('العربي واللاتيني لنفس الرقم تكرارٌ واحد', () => {
    expect(duplicateTransferNumbers([t('TR-٧'), t('TR-7')])[0].count).toBe(2);
  });

  it('الفارغ ليس تكراراً', () => {
    expect(duplicateTransferNumbers([t(''), t('')])).toEqual([]);
  });
});

describe('صياغة الرقم', () => {
  it('عربية دائماً — كما يراها التاجر ويكتبها', () => {
    expect(formatTransferNumber(2044)).toBe('TR-٢٠٤٤');
    expect(formatTransferNumber(2044, '73')).toBe('TR-٢٠٤٤/٧٣');
  });

  it('ما يُصاغ يُقرأ (رحلة ذهاب وإياب)', () => {
    for (const seq of [1, 9, 10, 999, 100000]) {
      expect(transferSeqOf(formatTransferNumber(seq, '73'))).toBe(seq);
      expect(transferDeviceTagOf(formatTransferNumber(seq, '73'))).toBe('73');
    }
  });
});
