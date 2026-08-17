import { describe, it, expect } from 'vitest';
import {
  ownerSeqOf, deviceTagOf, isEmployeeNumber, shouldTagDevice, takenOwnerNumbers,
  nextOwnerSeq, formatOwnerNumber, allocateOwnerNumber, duplicateNumbers,
  DEVICE_SEP, FIRST_SEQ,
} from '../invoiceNumber';

/**
 * ترقيم الفواتير — الرقم هو ما يقوله الزبون عند الخلاف.
 *
 * التكرار لا يُصدر خطأً ولا يظهر في أي شاشة؛ يظهر بعد شهور حين يقول الزبون «وصلي رقم
 * ٢٠٤٤» فيجد التاجر وصلين بمبلغين. لذلك تُغطّى هنا الحالات التي لا يراها أحد: جهازان
 * أوفلاين، وتبويبان، وفواتير موظفين تتسلّل إلى تسلسل المالك.
 */

const inv = (invoiceNumber: string, deviceTag?: string) => ({ invoiceNumber, deviceTag });

describe('قراءة رقم الفاتورة', () => {
  it('يقرأ الرقم العربي البسيط', () => {
    expect(ownerSeqOf('٢٠٤٤')).toBe(2044);
  });

  it('يقرأ الرقم اللاتيني (بيانات قديمة أو مستوردة)', () => {
    expect(ownerSeqOf('2044')).toBe(2044);
  });

  it('يقرأ التسلسل من رقم موسوم بجهاز', () => {
    expect(ownerSeqOf(`٢٠٤٤${DEVICE_SEP}٧٣`)).toBe(2044);
    expect(deviceTagOf(`٢٠٤٤${DEVICE_SEP}٧٣`)).toBe('73');
  });

  it('🔴 رقم الموظف لا يدخل تسلسل المالك أبداً', () => {
    expect(isEmployeeNumber('٤٣٨٢-٧')).toBe(true);
    expect(ownerSeqOf('٤٣٨٢-٧'), 'تسلّل رقم موظف ⇒ يقفز ترقيم المالك آلافاً').toBeNull();
    expect(deviceTagOf('٤٣٨٢-٧')).toBe('');
  });

  it('المُدخل التالف يُرفض بهدوء ولا يُفسد التسلسل', () => {
    for (const bad of ['', '   ', 'أ ب', 'فاتورة', `${DEVICE_SEP}٧٣`]) {
      expect(ownerSeqOf(bad), `«${bad}» مرّ`).toBeNull();
    }
  });

  it('الرقم غير الموسوم بلا رمز جهاز', () => {
    expect(deviceTagOf('٢٠٤٤')).toBe('');
  });
});

describe('التسلسل التالي', () => {
  it('محل جديد بلا فواتير يبدأ من الرقم الأول', () => {
    expect(nextOwnerSeq([])).toBe(FIRST_SEQ + 1);
  });

  it('يأخذ الأعلى + ١ لا الأخير في القائمة', () => {
    expect(nextOwnerSeq([inv('٢٠٤٤'), inv('٢٠٩٩'), inv('٢٠٥٠')])).toBe(2100);
  });

  it('🔴 لا تُزيحه فواتير الموظفين مهما كبرت', () => {
    expect(
      nextOwnerSeq([inv('٢٠٤٤'), inv('٩٩٩٩-٥٠٠')]),
      'رقم موظف رفع تسلسل المالك',
    ).toBe(2045);
  });

  it('يحسب من الأرقام الموسومة كما من العادية', () => {
    expect(nextOwnerSeq([inv(`٢٠٩٩${DEVICE_SEP}١٦`)])).toBe(2100);
  });
});

describe('وسم الجهاز — لا يظهر إلا عند الحاجة', () => {
  it('🔴 الجهاز الوحيد لا يوسم شيئاً — تاجر الجهاز الواحد لا يرى أي تغيير', () => {
    const data = [inv('٢٠٤٣'), inv('٢٠٤٤'), inv('٢٠٤٥')];
    expect(shouldTagDevice(data, '73')).toBe(false);
    expect(allocateOwnerNumber(data, '73')).toBe('٢٠٤٦');
  });

  it('فواتيري وحدها لا تُفعّل الوسم مهما كثرت', () => {
    expect(shouldTagDevice([inv('٢٠٤٣', '73'), inv('٢٠٤٤', '73')], '73')).toBe(false);
    expect(shouldTagDevice([inv(`٢٠٤٤${DEVICE_SEP}٧٣`, '73')], '73')).toBe(false);
  });

  it('🔴 حقل الجهاز — لا شكل الرقم — هو ما يكشف الجهاز الثاني', () => {
    // الجهاز الأول يُصدر أرقاماً **عادية** يحمل حقلها رمزه. لو انتظرنا رقماً موسوماً
    // لما وسم أحدٌ أولاً، ولاصطدم الجهازان في أول فاتورة.
    const data = [inv('٢٠٤٣', '16'), inv('٢٠٤٤', '16')];
    expect(shouldTagDevice(data, '73')).toBe(true);
    expect(allocateOwnerNumber(data, '73')).toBe(`٢٠٤٥${DEVICE_SEP}٧٣`);
  });

  it('يُفعّله أيضاً رقمٌ موسوم سابقاً (بيانات أقدم من الحقل)', () => {
    const data = [inv('٢٠٤٣'), inv(`٢٠٤٤${DEVICE_SEP}١٦`)];
    expect(shouldTagDevice(data, '73')).toBe(true);
  });

  it('الفواتير القديمة بلا حقل ولا وسم لا تُفعّل شيئاً — لا كسر للبيانات القائمة', () => {
    const legacy = [inv('٢٠٤٣'), inv('٢٠٤٤'), inv('٢٠٤٥')];
    expect(shouldTagDevice(legacy, '73')).toBe(false);
    expect(allocateOwnerNumber(legacy, '73')).toBe('٢٠٤٦');
  });

  it('جهاز بلا رمز (تعذّر التخزين) يعود للسلوك القديم بلا كسر', () => {
    const data = [inv(`٢٠٤٤${DEVICE_SEP}١٦`, '16')];
    expect(shouldTagDevice(data, '')).toBe(false);
    expect(allocateOwnerNumber(data, '')).toBe('٢٠٤٥');
  });

  it('رقم الموظف لا يُفعّل وسم الجهاز (ترقيمه محصّن أصلاً)', () => {
    expect(shouldTagDevice([inv('٤٣٨٢-٧')], '73')).toBe(false);
  });
});

describe('🔴 الرقم المُسلَّم حرٌّ دائماً', () => {
  /**
   * الخاصيّة الجوهرية: مهما كانت البيانات، لا يُسلَّم رقمٌ مستعمل. تُفحص كخاصيّة على
   * حالات كثيرة لا كمثال واحد — لأن المثال الواحد قد يمرّ صدفةً وهو لا يفحص شيئاً.
   */
  const cases: Array<[string, ReturnType<typeof inv>[]]> = [
    ['بيانات فارغة', []],
    ['تسلسل متصل', [inv('٢٠٤٤'), inv('٢٠٤٥'), inv('٢٠٤٦')]],
    ['ثغرات في التسلسل', [inv('٢٠٤٤'), inv('٢٠٩٩')]],
    ['كتابة مختلطة عربي/لاتيني', [inv('٢٠٤٤'), inv('2045')]],
    ['مع فواتير موظفين', [inv('٢٠٤٤'), inv('٤٣٨٢-٧'), inv('٩٩٩٩-١')]],
    ['مع أرقام موسومة', [inv(`٢٠٤٤${DEVICE_SEP}١٦`, '16'), inv('٢٠٤٥', '16')]],
    ['أرقام تالفة بينها', [inv('٢٠٤٤'), inv('فاتورة'), inv('')]],
  ];

  it.each(cases)('«%s» — الرقم الجديد غير مستعمل', (_label, data) => {
    for (const myTag of ['', '73']) {
      const issued = allocateOwnerNumber(data, myTag);
      expect(takenOwnerNumbers(data).has(issued.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))))
        .toBe(false);
    }
  });

  it('الرقم الجديد يسبق كل الأرقام السابقة — لا يعود للخلف', () => {
    const data = [inv('٢٠٤٤'), inv('٢٠٩٩'), inv('٢٠٥٠')];
    expect(allocateOwnerNumber(data, '')).toBe('٢١٠٠');
  });

  it('إصدار متتالٍ على الجهاز نفسه لا يكرّر (كل فاتورة تدخل البيانات)', () => {
    const data = [inv('٢٠٤٤')];
    const issued: string[] = [];
    for (let i = 0; i < 5; i++) {
      const n = allocateOwnerNumber(data, '73');
      issued.push(n);
      data.push(inv(n, '73'));
    }
    expect(new Set(issued).size, 'تكرّر رقم في إصدار متتالٍ').toBe(5);
    expect(issued).toEqual(['٢٠٤٥', '٢٠٤٦', '٢٠٤٧', '٢٠٤٨', '٢٠٤٩']);
  });

  it('الموسوم لا يصطدم بالموسوم — رقمان لجهازين مختلفين يتعايشان', () => {
    const data = [inv(`٢٠٤٥${DEVICE_SEP}١٦`, '16')];
    // جهازي (٧٣) يرى جهازاً آخر ⇒ يوسم، والرقم ٢٠٤٦ حرّ
    expect(allocateOwnerNumber(data, '73')).toBe(`٢٠٤٦${DEVICE_SEP}٧٣`);
  });

  it('🔴 جهازان مقطوعان عن الإنترنت لا ينتجان الرقم نفسه', () => {
    // كلٌّ يرى بيانات الأمس ولا يرى فاتورة الآخر اليوم — لكن كلاهما يعلم بوجود الآخر
    // من حقل الجهاز على فواتير الأمس، فيوسم كلٌّ رقمه فينفصلان.
    const shared = [inv('٢٠٤٢', '16'), inv('٢٠٤٣', '73')];
    const a = allocateOwnerNumber(shared, '73');
    const b = allocateOwnerNumber(shared, '16');
    expect(a).not.toBe(b);
    expect(a).toBe(`٢٠٤٤${DEVICE_SEP}٧٣`);
    expect(b).toBe(`٢٠٤٤${DEVICE_SEP}١٦`);
  });

  it('🔴 الجهاز الثاني في أول يوم لا يصطدم بالأول', () => {
    // الأول أصدر أرقاماً عادية، لكن حقلها يحمل رمزه — فالثاني يعرف فوراً ويوسم أول فاتورة له
    const first = [inv('٢٠٤٣', '16'), inv('٢٠٤٤', '16')];
    expect(allocateOwnerNumber(first, '73')).toBe(`٢٠٤٥${DEVICE_SEP}٧٣`);
    // والأول حين يرى فاتورة الثاني يوسم هو أيضاً
    const after = [...first, inv(`٢٠٤٥${DEVICE_SEP}٧٣`, '73')];
    expect(allocateOwnerNumber(after, '16')).toBe(`٢٠٤٦${DEVICE_SEP}١٦`);
  });

  it('محل جديد: أول رقم كما كان تماماً', () => {
    expect(allocateOwnerNumber([], '73')).toBe('١٠٠٢');
  });

  it('الأرقام المحجوزة تُقرأ لاتينياً للمقارنة', () => {
    const taken = takenOwnerNumbers([inv('٢٠٤٤'), inv('٤٣٨٢-٧'), inv(`٢٠٤٥${DEVICE_SEP}١٦`)]);
    expect(taken.has('2044')).toBe(true);
    expect(taken.has(`2045${DEVICE_SEP}16`)).toBe(true);
    expect(taken.has('4382-7'), 'رقم موظف دخل مجموعة أرقام المالك').toBe(false);
  });
});

describe('تنسيق الرقم', () => {
  it('بلا رمز = رقم عربي صرف', () => {
    expect(formatOwnerNumber(2044)).toBe('٢٠٤٤');
  });

  it('مع رمز = تسلسل ثم فاصل ثم الرمز، كله عربي', () => {
    expect(formatOwnerNumber(2044, '73')).toBe('٢٠٤٤/٧٣');
  });

  it('الفاصل يختلف عن فاصل الموظفين فلا يلتبسان', () => {
    expect(DEVICE_SEP).not.toBe('-');
    expect(isEmployeeNumber(formatOwnerNumber(2044, '73'))).toBe(false);
  });
});

describe('كشف التكرار الذي وقع سابقاً', () => {
  it('بيانات سليمة ⇒ لا تنبيه', () => {
    expect(duplicateNumbers([inv('٢٠٤٤'), inv('٢٠٤٥')])).toEqual([]);
  });

  it('🔴 يكشف رقمين متطابقين', () => {
    const dups = duplicateNumbers([inv('٢٠٤٤'), inv('٢٠٤٤'), inv('٢٠٤٥')]);
    expect(dups).toHaveLength(1);
    expect(dups[0]).toEqual({ number: '٢٠٤٤', count: 2 });
  });

  it('يكشف التكرار عبر اختلاف كتابة الأرقام (٢٠٤٤ و 2044 رقم واحد)', () => {
    expect(duplicateNumbers([inv('٢٠٤٤'), inv('2044')])).toHaveLength(1);
  });

  it('يرتّب الأكثر تكراراً أولاً — الأخطر أولاً', () => {
    const dups = duplicateNumbers([
      inv('٢٠٤٤'), inv('٢٠٤٤'),
      inv('٢٠٥٠'), inv('٢٠٥٠'), inv('٢٠٥٠'),
    ]);
    expect(dups.map(d => d.count)).toEqual([3, 2]);
  });

  it('الرقمان الموسومان بجهازين مختلفين ليسا تكراراً', () => {
    expect(duplicateNumbers([
      inv(`٢٠٤٤${DEVICE_SEP}٧٣`),
      inv(`٢٠٤٤${DEVICE_SEP}١٦`),
    ])).toEqual([]);
  });

  it('يشمل فواتير الموظفين — التكرار خطر أينما وقع', () => {
    expect(duplicateNumbers([inv('٤٣٨٢-٧'), inv('٤٣٨٢-٧')])).toHaveLength(1);
  });
});
