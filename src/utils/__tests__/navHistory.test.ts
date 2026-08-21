import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createNavHistory, createExitGuard, decideBack,
  registerBackInterceptor, runBackInterceptors, _clearBackInterceptors,
  MAX_DEPTH,
} from '../navHistory';

/**
 * زرّ الرجوع في أندرويد.
 *
 * 🔴 العلّة الأصلية: لا Router في البرنامج، فزرّ الرجوع **يُغلق التطبيق من أي
 * شاشة**. يفتح التاجر «الديون»، يضغط رجوع ظانّاً أنه يعود للرئيسية، فيخرج.
 */

beforeEach(() => _clearBackInterceptors());

describe('مكدّس الشاشات', () => {
  it('يبدأ من الجذر ولا يرجع منه', () => {
    const h = createNavHistory('dashboard');
    expect(h.current()).toBe('dashboard');
    expect(h.depth()).toBe(1);
    expect(h.back(), 'الرجوع من الجذر يعني الخروج لا شاشةً أخرى').toBeNull();
  });

  it('يرجع خطوةً خطوة بترتيب الزيارة', () => {
    const h = createNavHistory('dashboard');
    h.push('invoices'); h.push('customers'); h.push('debts');
    expect(h.current()).toBe('debts');
    expect(h.back()).toBe('customers');
    expect(h.back()).toBe('invoices');
    expect(h.back()).toBe('dashboard');
    expect(h.back()).toBeNull();
  });

  it('🔴 الانتقال إلى الشاشة نفسها لا يُسجَّل', () => {
    const h = createNavHistory('dashboard');
    h.push('invoices'); h.push('invoices'); h.push('invoices');
    expect(
      h.depth(),
      'ضغطُ زرّ الشاشة الحالية مرّاتٍ يُراكم خطواتٍ وهمية فلا يرجع الزرّ إلى شيء',
    ).toBe(2);
  });

  it('الدورات تُسجَّل كما هي — رجوعٌ متوقَّع لا ذكيّ', () => {
    const h = createNavHistory('dashboard');
    h.push('invoices'); h.push('dashboard');
    expect(h.back()).toBe('invoices');
    expect(h.back()).toBe('dashboard');
    expect(h.back()).toBeNull();
  });

  it(`🔴 لا ينمو بلا حدّ — سقفه ${MAX_DEPTH}`, () => {
    const h = createNavHistory('dashboard');
    for (let i = 0; i < 200; i++) h.push(`screen-${i}`);
    expect(
      h.depth(),
      'جلسة تاجرٍ تمتدّ يوماً بمئات الانتقالات — مصفوفٌ بلا سقف يتضخّم',
    ).toBe(MAX_DEPTH);
  });

  it('وبعد القصّ يبقى الرجوع سليماً حتى يتوقّف', () => {
    const h = createNavHistory('dashboard');
    for (let i = 0; i < MAX_DEPTH + 10; i++) h.push(`s${i}`);
    let steps = 0;
    while (h.back() !== null) steps++;
    expect(steps).toBe(MAX_DEPTH - 1);
  });

  it('reset يُعيد جذراً جديداً — عند تبديل المستخدم', () => {
    const h = createNavHistory('dashboard');
    h.push('a'); h.push('b');
    h.reset('dashboard');
    expect(h.depth()).toBe(1);
    expect(h.back()).toBeNull();
  });
});

describe('🔴 معترضات الرجوع — النوافذ تُغلق قبل الانتقال', () => {
  it('بلا معترضاتٍ لا يُستهلك الرجوع', () => {
    expect(runBackInterceptors()).toBe(false);
  });

  it('المعترض يستهلك الرجوع', () => {
    const close = vi.fn(() => true);
    registerBackInterceptor(close);
    expect(runBackInterceptors()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('🔴 آخِرُ مسجَّلٍ أوّلُ منفَّذ — وهو ترتيب النوافذ البصري', () => {
    const order: string[] = [];
    registerBackInterceptor(() => { order.push('تحت'); return true; });
    registerBackInterceptor(() => { order.push('فوق'); return true; });
    runBackInterceptors();
    expect(
      order,
      'إغلاق النافذة السفلى أولاً يترك العليا معلّقةً فوق شاشةٍ تبدّلت',
    ).toEqual(['فوق']);
  });

  it('معترضٌ يرفض التعامل يمرّ إلى الذي تحته', () => {
    const order: string[] = [];
    registerBackInterceptor(() => { order.push('تحت'); return true; });
    registerBackInterceptor(() => { order.push('فوق-رفض'); return false; });
    expect(runBackInterceptors()).toBe(true);
    expect(order).toEqual(['فوق-رفض', 'تحت']);
  });

  it('🔴 إلغاء التسجيل يعمل — وإلا بقيت نافذةٌ مغلقة تبتلع الرجوع للأبد', () => {
    const unregister = registerBackInterceptor(() => true);
    unregister();
    expect(
      runBackInterceptors(),
      'معترضٌ لنافذةٍ أُغلقت يمنع الرجوع من العمل نهائياً',
    ).toBe(false);
  });

  it('وإلغاءٌ مكرّر لا يحذف معترضاً آخر', () => {
    const un1 = registerBackInterceptor(() => true);
    registerBackInterceptor(() => true);
    un1(); un1();
    expect(runBackInterceptors()).toBe(true);
  });
});

describe('القرار الموحَّد', () => {
  it('نافذةٌ مفتوحة ⟶ تُغلق ولا ننتقل', () => {
    const h = createNavHistory('dashboard');
    h.push('debts');
    const nav = vi.fn();
    registerBackInterceptor(() => true);
    expect(decideBack(h, nav)).toBe('closed');
    expect(nav, 'الشاشة تبدّلت تحت نافذةٍ مفتوحة').not.toHaveBeenCalled();
    expect(h.current(), 'المكدّس تحرّك رغم أن الرجوع استُهلك').toBe('debts');
  });

  it('بلا نافذة ⟶ نرجع شاشةً', () => {
    const h = createNavHistory('dashboard');
    h.push('debts');
    const nav = vi.fn();
    expect(decideBack(h, nav)).toBe('navigated');
    expect(nav).toHaveBeenCalledWith('dashboard');
  });

  it('في الجذر ⟶ root (يقرّر المستدعي الخروج)', () => {
    const h = createNavHistory('dashboard');
    const nav = vi.fn();
    expect(decideBack(h, nav)).toBe('root');
    expect(nav).not.toHaveBeenCalled();
  });
});

describe('🔴 حارس الخروج — ضغطتان لا واحدة', () => {
  it('الأولى تُلمّح والثانية تُخرج', () => {
    const g = createExitGuard(2000);
    expect(g.press(1000), 'الضغطة الأولى أخرجت التاجر بلا تحذير').toBe(false);
    expect(g.press(1500)).toBe(true);
  });

  it('بعد انقضاء المهلة تعود الضغطة أولى', () => {
    const g = createExitGuard(2000);
    expect(g.press(1000)).toBe(false);
    expect(
      g.press(5000),
      'ضغطةٌ بعد دقائق تُحتسب استكمالاً لضغطةٍ منسيّة ⟶ خروجٌ مفاجئ',
    ).toBe(false);
  });

  it('الحدّ تماماً يُقبل', () => {
    const g = createExitGuard(2000);
    g.press(1000);
    expect(g.press(3000)).toBe(true);
  });

  it('🔴 وثالثةٌ بعد خروجٍ ملغى لا تُخرج فوراً', () => {
    const g = createExitGuard(2000);
    g.press(1000);
    expect(g.press(1500)).toBe(true);      // خرج
    expect(
      g.press(1600),
      'الدورة لم تُصفَّر بعد الخروج ⟶ أول ضغطةٍ في الجلسة التالية تُخرج مباشرة',
    ).toBe(false);
  });
});
