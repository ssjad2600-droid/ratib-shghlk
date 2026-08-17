import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSharedValue } from '../sharedValue';

/**
 * اختبارات القيمة المشتركة — الآلة التي تجعل «الفرع النشط» واحداً في كل الشاشات.
 *
 * العلّة التي وُلد منها هذا الملف: مبدّل الفروع في الرأس كان يبدّل نسخته وحدها،
 * والشاشة المفتوحة تبقى على الفرع القديم. فالتاجر يقرأ أرقام فرع ويظنّها فرعاً آخر.
 * لا خطأ يظهر، ولا رقم أحمر — قرار خاطئ بلا أي إنذار. لذلك تُغطّى هنا بدقّة.
 */

describe('createSharedValue — القيمة الواحدة', () => {
  it('تبدأ بالقيمة الابتدائية', () => {
    expect(createSharedValue('main').get()).toBe('main');
  });

  it('الضبط يغيّر القيمة لكل من يقرأها', () => {
    const s = createSharedValue('main');
    s.set('branch_2');
    expect(s.get()).toBe('branch_2');
  });

  it('🔴 كل المشتركين يُعلَمون بالتغيير — لا مشترك يبقى على قيمة قديمة', () => {
    const s = createSharedValue('main');
    const header = vi.fn();
    const screen = vi.fn();
    const report = vi.fn();
    s.subscribe(header); s.subscribe(screen); s.subscribe(report);

    s.set('branch_2');

    expect(header).toHaveBeenCalledTimes(1);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    // والأهم: كلهم يرون القيمة الجديدة نفسها
    expect(s.get()).toBe('branch_2');
  });

  it('🔴 ضبط القيمة نفسها لا يُعلم أحداً — لا رسم بلا سبب', () => {
    const s = createSharedValue('main');
    const cb = vi.fn();
    s.subscribe(cb);

    s.set('main');
    expect(cb).not.toHaveBeenCalled();

    s.set('branch_2');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('إلغاء الاشتراك يوقف الإعلام ولا يمسّ البقية', () => {
    const s = createSharedValue('main');
    const gone = vi.fn();
    const stays = vi.fn();
    const off = s.subscribe(gone);
    s.subscribe(stays);

    off();
    s.set('branch_2');

    expect(gone).not.toHaveBeenCalled();
    expect(stays).toHaveBeenCalledTimes(1);
    expect(s.listenerCount()).toBe(1);
  });

  it('إلغاء الاشتراك مرتين لا يكسر شيئاً', () => {
    const s = createSharedValue('main');
    const off = s.subscribe(vi.fn());
    off(); off();
    expect(s.listenerCount()).toBe(0);
    expect(() => s.set('x')).not.toThrow();
  });

  it('🔴 مشترك يُلغي اشتراكه أثناء الإعلام لا يُسقط من بعده', () => {
    const s = createSharedValue('main');
    const later = vi.fn();
    const off = s.subscribe(() => off());
    s.subscribe(later);

    expect(() => s.set('branch_2')).not.toThrow();
    expect(later, 'المشترك التالي لم يُعلَم — الإعلام انكسر في منتصفه').toHaveBeenCalledTimes(1);
  });

  it('القيمة المقروءة أثناء الإعلام هي الجديدة (لا لقطة قديمة)', () => {
    const s = createSharedValue('main');
    let seen = '';
    s.subscribe(() => { seen = s.get(); });
    s.set('branch_2');
    expect(seen).toBe('branch_2');
  });

  it('يعمل مع القيم غير النصّية ويقارن بالمرجع', () => {
    const a = { id: 1 };
    const s = createSharedValue<{ id: number }>(a);
    const cb = vi.fn();
    s.subscribe(cb);

    s.set(a);            // نفس المرجع ⇒ لا إعلام
    expect(cb).not.toHaveBeenCalled();
    s.set({ id: 1 });    // مرجع جديد ⇒ إعلام
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('كل مخزن مستقل عن الآخر', () => {
    const a = createSharedValue('main');
    const b = createSharedValue('main');
    a.set('branch_2');
    expect(b.get()).toBe('main');
  });

  it('«كل الفروع» (نص فارغ) قيمة صالحة لا تُخلط بالافتراضي', () => {
    const s = createSharedValue('main');
    s.set('');
    expect(s.get()).toBe('');
  });
});

/**
 * 🔴 حارس ضد عودة العلّة.
 *
 * لا اختبار وحدة يكشف رجوع الفرع النشط إلى `useState` — الدوال كلها ستبقى سليمة،
 * والعلّة تعيش في **مكان** الحالة لا في منطقها. فنفحص المصدر نفسه، كما فعلنا مع
 * حارس النسخة الاحتياطية وحارس دليل الشاشات.
 */
describe('حارس: الفرع النشط يبقى حالة مشتركة', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'hooks', 'useBranches.ts'), 'utf8');

  it('الخطّاف يقرأ الفرع النشط من مخزن مشترك', () => {
    expect(src).toContain('createSharedValue');
    expect(src).toContain('useSyncExternalStore');
  });

  it('🔴 لا حالة داخلية للفرع النشط — نسخة لكل مكوّن تُعيد العلّة', () => {
    expect(
      /useState\s*[<(]/.test(src),
      'عاد useState إلى useBranches — الفرع النشط سيصبح نسخة مستقلة لكل شاشة، وتبديل الفرع لن يظهر إلا بعد إعادة التحميل',
    ).toBe(false);
  });

  it('اختيار الفرع ما زال يُحفظ للجلسة القادمة', () => {
    expect(src).toContain('localStorage.setItem(activeKey(ownerUid), id)');
  });
});
