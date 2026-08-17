import { describe, it, expect } from 'vitest';
import { decideBalanceWrite } from '../customerBalance';
import { parseAmount } from '../arabicFormatters';

/**
 * رصيد الزبون = دَينه. كل خطأ هنا مالٌ يضيع أو دَينٌ يُطالَب به ظلماً.
 *
 * العلّتان اللتان وُلد منهما هذا الملف:
 *  ١) الكتابة المطلقة تمحو ما تغيّر أثناء التعديل — والتاجر لم يلمس خانة الرصيد أصلاً.
 *  ٢) `Number('٥٥٠٠٠')` = NaN، ثم `|| 0` كان يحوّل الدين كله إلى صفر بصمت.
 */

describe('🔴 الحالة الغالبة: تعديل بيانات بلا مساس بالمال', () => {
  it('تعديل العنوان وحده لا يمسّ الرصيد', () => {
    expect(decideBalanceWrite({ loaded: 50000, live: 50000, typed: 50000 }))
      .toEqual({ kind: 'skip' });
  });

  it('🔴 ولو تغيّر الرصيد أثناء التعديل — لا نكتب فوقه', () => {
    // هذا هو السيناريو الذي كان يُبخّر ٢٠٬٠٠٠: فُتح الملف على ٥٠٬٠٠٠، باع الكاشير
    // بالدين ٢٠٬٠٠٠ فصار ٧٠٬٠٠٠، والتاجر يصحّح العنوان فقط ثم يحفظ.
    expect(decideBalanceWrite({ loaded: 50000, live: 70000, typed: 50000 }))
      .toEqual({ kind: 'skip' });
  });

  it('رصيد صفر يبقى صفراً بلا كتابة', () => {
    expect(decideBalanceWrite({ loaded: 0, live: 0, typed: 0 })).toEqual({ kind: 'skip' });
  });

  it('فروق الكسور لا تُعدّ تعديلاً', () => {
    expect(decideBalanceWrite({ loaded: 50000.4, live: 50000, typed: 50000.2 }))
      .toEqual({ kind: 'skip' });
  });
});

describe('تعديل مقصود بلا تعارض ⇒ فرق يُطبَّق بأمان', () => {
  it('زيادة الدين', () => {
    expect(decideBalanceWrite({ loaded: 50000, live: 50000, typed: 75000 }))
      .toEqual({ kind: 'apply', delta: 25000 });
  });

  it('تخفيض الدين', () => {
    expect(decideBalanceWrite({ loaded: 50000, live: 50000, typed: 20000 }))
      .toEqual({ kind: 'apply', delta: -30000 });
  });

  it('تصفير الدين', () => {
    expect(decideBalanceWrite({ loaded: 50000, live: 50000, typed: 0 }))
      .toEqual({ kind: 'apply', delta: -50000 });
  });

  it('قلبه إلى أمانة له عندك', () => {
    expect(decideBalanceWrite({ loaded: 10000, live: 10000, typed: -5000 }))
      .toEqual({ kind: 'apply', delta: -15000 });
  });

  it('🔴 الفرق المطبَّق يعطي القيمة المكتوبة بالضبط', () => {
    for (const [loaded, typed] of [[50000, 75000], [0, 12000], [-3000, 4000], [9000, -9000]]) {
      const d = decideBalanceWrite({ loaded, live: loaded, typed });
      expect(d.kind).toBe('apply');
      if (d.kind === 'apply') expect(loaded + d.delta).toBe(typed);
    }
  });
});

describe('🔴 التعارض: تغيّر الرصيد والتاجر يعدّله معاً', () => {
  it('يُبلَّغ عنه ولا يُكتب فوقه بصمت', () => {
    const d = decideBalanceWrite({ loaded: 50000, live: 70000, typed: 60000 });
    expect(d.kind).toBe('conflict');
  });

  it('يحمل الأرقام الثلاثة ليراها التاجر ويقرّر', () => {
    const d = decideBalanceWrite({ loaded: 50000, live: 70000, typed: 60000 });
    if (d.kind !== 'conflict') throw new Error('توقّعنا تعارضاً');
    expect(d.loaded).toBe(50000);
    expect(d.live).toBe(70000);
    expect(d.typed).toBe(60000);
  });

  it('🔴 الفرق عند الإصرار يُحسب من الرصيد الحيّ لا من اللقطة القديمة', () => {
    // لو حُسب من اللقطة (٦٠٬٠٠٠−٥٠٬٠٠٠=+١٠٬٠٠٠) لصار الرصيد ٨٠٬٠٠٠ — لا ٦٠٬٠٠٠ كما أراد
    const d = decideBalanceWrite({ loaded: 50000, live: 70000, typed: 60000 });
    if (d.kind !== 'conflict') throw new Error('توقّعنا تعارضاً');
    expect(d.deltaIfForced).toBe(-10000);
    expect(d.live + d.deltaIfForced, 'الإصرار لم يُعطِ القيمة المكتوبة').toBe(60000);
  });

  it('يعمل حين ينخفض الرصيد أثناء التعديل (تسديد دين)', () => {
    const d = decideBalanceWrite({ loaded: 50000, live: 20000, typed: 45000 });
    if (d.kind !== 'conflict') throw new Error('توقّعنا تعارضاً');
    expect(d.live + d.deltaIfForced).toBe(45000);
  });

  it('لا تعارض حين يكتب التاجر نفس القيمة الحيّة الجديدة صدفةً', () => {
    const d = decideBalanceWrite({ loaded: 50000, live: 70000, typed: 70000 });
    if (d.kind !== 'conflict') throw new Error('توقّعنا تعارضاً');
    expect(d.deltaIfForced, 'كتابة تساوي الحيّ يجب ألّا تغيّر شيئاً').toBe(0);
  });
});

describe('🔴 قراءة ما يكتبه التاجر — parseAmount لا Number', () => {
  it('الأرقام العربية تُقرأ صحيحة (كانت تصير صفراً)', () => {
    expect(parseAmount('٥٥٠٠٠')).toBe(55000);
    expect(Number('٥٥٠٠٠'), 'إثبات العلّة القديمة').toBeNaN();
  });

  it('الفواصل العربية واللاتينية تُقبل', () => {
    expect(parseAmount('55,000')).toBe(55000);
    expect(parseAmount('٥٥،٠٠٠')).toBe(55000);
  });

  it('المسافات تُتجاهل', () => {
    expect(parseAmount(' ٥٥ ٠٠٠ ')).toBe(55000);
  });

  it('السالب يُقرأ (أمانة له عندك)', () => {
    expect(parseAmount('-٥٠٠٠')).toBe(-5000);
  });

  it('🔴 النص غير الرقمي يُرجع NaN — لا صفراً يمحو الدين', () => {
    for (const bad of ['', '   ', 'خمسون ألف', 'أ٥٠']) {
      expect(Number.isNaN(parseAmount(bad)), `«${bad}» لم يُرفض`).toBe(true);
    }
  });

  it('السلسلة كاملة: نص عربي ⇒ رقم ⇒ قرار صحيح', () => {
    const typed = parseAmount('٧٥٬٠٠٠'.replace('٬', ''));
    const d = decideBalanceWrite({ loaded: 50000, live: 50000, typed });
    expect(d).toEqual({ kind: 'apply', delta: 25000 });
  });
});
