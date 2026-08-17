import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  balanceDirection, balanceLabel, balanceStatus, debtLineForSupplier,
  supplierWhatsappText, supplierKey, findDuplicateSupplier,
} from '../supplierBalance';

/**
 * 🔴 اتجاه رصيد المورد.
 *
 * الاتجاه محسوم من الكود الذي **يكتب** الرصيد لا من التسميات:
 *   · فاتورة شراء آجلة ⟵ `balance: increment(remaining)`
 *   · تسديد للمورد     ⟵ `balance: increment(-paid)`
 * إذن الموجب = **المحل يدين للمورد**. وكانت رسالة الواتساب تقلبه في الطرفين، فيرسل
 * التاجر إلى مورّده مطالبةً بما يدين به هو نفسه — ونصٌّ يغادر البرنامج لا يكتشفه صاحبه.
 */

const money = (n: number) => `${n} د.ع`;

describe('اتجاه الرصيد', () => {
  it('الموجب = علينا له، والسالب = لنا عنده', () => {
    expect(balanceDirection(5000)).toBe('shop_owes');
    expect(balanceDirection(-5000)).toBe('supplier_owes');
    expect(balanceDirection(0)).toBe('settled');
  });

  it('القيم التالفة تُعدّ متزنة لا ديناً وهمياً', () => {
    expect(balanceDirection(NaN)).toBe('settled');
    expect(balanceDirection(Infinity)).toBe('settled');
  });

  it('التسميات تذكر الاتجاه صراحةً — «الرصيد» وحده يحتمل القراءتين', () => {
    expect(balanceLabel(5000)).toBe('علينا له');
    expect(balanceLabel(-5000)).toBe('لنا عنده');
    expect(balanceStatus(5000)).toMatch(/علينا/);
    expect(balanceStatus(-5000)).toMatch(/لنا/);
  });
});

describe('🔴 سطر الدين في الرسالة المُرسَلة للمورد', () => {
  it('نحن المدينون ⇒ «لكم علينا» لا «عليكم لنا»', () => {
    const line = debtLineForSupplier(5_000_000, money);
    expect(line, 'الاتجاه المقلوب يجعل التاجر يطالب مورّده بما يدين به هو').toMatch(/لكم علينا/);
    expect(line).not.toMatch(/عليك/);
  });

  it('دفعنا زيادة ⇒ النصّ يقول ذلك ولا يطالبه بشيء', () => {
    const line = debtLineForSupplier(-300_000, money);
    expect(line).toMatch(/زيادةً عن المستحق/);
    expect(line).toContain('300000');
  });

  it('المبلغ يُعرض موجباً دائماً — لا إشارة سالبة في رسالة', () => {
    expect(debtLineForSupplier(-300_000, money)).not.toContain('-300000');
  });

  it('المتزن لا يذكر مبلغاً إطلاقاً', () => {
    const line = debtLineForSupplier(0, money);
    expect(line).toMatch(/متزن/);
    expect(line).not.toMatch(/\d/);
  });

  /**
   * خاصيّة تحرس الانقلاب مهما أُعيدت الصياغة: النصّ الموجّه للمورد لا يجوز أن يجعله
   * هو المدين حين نكون نحن المدينين.
   */
  it('🔴 خاصيّة: الموجب لا يُنتج أبداً نصّاً يجعل المورد مديناً', () => {
    for (const b of [1, 1000, 5_000_000, 999_999_999]) {
      const line = debtLineForSupplier(b, money);
      expect(/عليك|عليكم|متبقي عليك|بذمّتك/.test(line), `انقلب الاتجاه عند ${b}: «${line}»`).toBe(false);
      expect(/علينا/.test(line), `لم يذكر أن الدين علينا عند ${b}`).toBe(true);
    }
  });
});

describe('نصّ الواتساب الكامل', () => {
  const text = (balance: number) => supplierWhatsappText({
    storeName: 'اسواق النور', supplierName: 'موزّع الرافدين', balance,
    notes: 'يوصل الثلاثاء', dateText: '١٣/٨/٢٠٢٦', money,
  });

  it('يحمل اسم المحل والمورد والتاريخ والملاحظة', () => {
    const t = text(5000);
    expect(t).toContain('اسواق النور');
    expect(t).toContain('موزّع الرافدين');
    expect(t).toContain('١٣/٨/٢٠٢٦');
    expect(t).toContain('يوصل الثلاثاء');
  });

  it('بلا ملاحظة ⇒ لا سطر ملاحظات فارغ', () => {
    const t = supplierWhatsappText({
      supplierName: 'م', balance: 0, dateText: 'اليوم', money,
    });
    expect(t).not.toContain('ملاحظات:');
  });

  it('🔴 الاتجاه في النصّ الكامل صحيح أيضاً', () => {
    expect(text(5000)).toMatch(/لكم علينا/);
    expect(text(-5000)).toMatch(/زيادةً/);
  });
});

describe('🟠 كشف المورد المكرَّر', () => {
  const sup = (id: string, name: string, phone = '') => ({ id, name, phone });

  it('نفس الهاتف بصيغتين مختلفتين ⇒ تكرار', () => {
    expect(supplierKey({ phone: '0770 123 4567' })).toBe(supplierKey({ phone: '٠٧٧٠١٢٣٤٥٦٧' }));
  });

  it('يجد المكرَّر بالهاتف ولو اختلف الاسم', () => {
    const list = [sup('a', 'أبو أحمد', '07701234567')];
    expect(findDuplicateSupplier(list, { name: 'ابو احمد', phone: '٠٧٧٠-١٢٣-٤٥٦٧' })?.id).toBe('a');
  });

  it('بلا هاتف: يقع الاعتماد على الاسم المجرَّد من المسافات', () => {
    const list = [sup('a', 'موزّع  النور')];
    expect(findDuplicateSupplier(list, { name: 'موزّع النور' })?.id).toBe('a');
  });

  it('🔴 المورد ليس تكراراً لنفسه عند التعديل', () => {
    const list = [sup('a', 'أبو أحمد', '07701234567')];
    expect(
      findDuplicateSupplier(list, { name: 'أبو أحمد المحترم', phone: '07701234567' }, 'a'),
      'لولا الاستثناء لمنع تعديلُ المورد نفسَه',
    ).toBeNull();
  });

  it('هاتفان مختلفان ⇒ لا تكرار ولو تشابه الاسم', () => {
    const list = [sup('a', 'أبو أحمد', '07701234567')];
    expect(findDuplicateSupplier(list, { name: 'أبو أحمد', phone: '07809998887' })).toBeNull();
  });

  it('مُدخَل فارغ تماماً لا يطابق شيئاً', () => {
    expect(findDuplicateSupplier([sup('a', '')], {})).toBeNull();
  });
});

/**
 * 🔴 حارس: الشاشة لا تكتب وثيقة المورد كاملةً، ولا تصف الدين بنصّ محلّي.
 */
describe('حارس: شاشة الموردين', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'SuppliersView.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('Supplier');
    expect(src).toContain('handleFormSubmit');
  });

  it('🔴 التعديل لا يكتب balance', () => {
    expect(
      /balance:\s*before/.test(src),
      'setDoc كامل يكتب الرصيد من لقطة محلية ⇒ فاتورة آجلة من جهاز آخر تُمحى، و`?? 0` يُصفّر الذمّة',
    ).toBe(false);
    expect(/updateDoc\(/.test(src), 'التعديل يجب أن يكتب الحقول المحرَّرة وحدها').toBe(true);
  });

  it('🔴 نصّ الواتساب من المصدر الموحّد لا من نصّ محلّي', () => {
    expect(/supplierWhatsappText\(/.test(src)).toBe(true);
    expect(
      /متبقي عليك للمحل|لصالحك عند المحل/.test(src),
      'عاد النصّ المقلوب الذي يطالب المورد بما يدين به التاجر نفسه',
    ).toBe(false);
  });

  it('🔴 الحذف يحمي الاتجاهين لا الموجب وحده', () => {
    expect(
      /balanceDirection\(sup\.balance\) === 'supplier_owes'/.test(src),
      'حذف مورد دفعنا له زيادة يُسقط حقّنا عنده بضغطة',
    ).toBe(true);
  });

  it('🟡 لا قراءة شبكية زائدة للفواتير — وهي محمَّلة في المكوّن', () => {
    expect(
      /getDocs\(/.test(src),
      'رحلة شبكة عند كل حذف، ومسار actor.uid يقرأ شجرةً فارغة لو فُتحت الشاشة لموظف',
    ).toBe(false);
  });
});
