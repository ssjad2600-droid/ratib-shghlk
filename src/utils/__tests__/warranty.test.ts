import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeSerial, warrantyStatus, findSerial, serialSaleCounts,
  serialKeysOf, removedSerialKeys,
} from '../warranty';
import { warrantyEntriesOf } from '../warrantyIndex';
import { Invoice } from '../../types';

/**
 * الضمان والسيريال.
 *
 * 🔴 العلّة الكبرى: مرآة الضمان (`warranty_index`) كانت تُكتب ولا تُحذف أبداً. فالزبون
 * يُرجع الجهاز ويقبض ثمنه، ثم يعود بعد شهرين فيجد **الموظف** في المرآة «الضمان فعّال»
 * فيستبدله مجاناً — بينما لا يجد **المالك** في الفواتير شيئاً. جوابان متناقضان لنفس
 * الجهاز، والخسارة تقع لأن الموظف على الكاونتر يجيب أولاً.
 */

const item = (name: string, serials?: string[], warrantyMonths?: number) => ({
  itemId: '1', name, quantity: 1, price: 1000, total: 1000,
  ...(serials ? { serials } : {}),
  ...(warrantyMonths ? { warrantyMonths } : {}),
});

const invoice = (id: string, date: string, items: ReturnType<typeof item>[]): Invoice => ({
  id, invoiceNumber: id, customerName: 'زبون', totalAmount: 1000, discount: 0, tax: 0,
  finalAmount: 1000, date, type: 'general', items,
} as Invoice);

describe('تطبيع السيريال', () => {
  it('يتجاهل المسافات والشرطات وحالة الأحرف', () => {
    const forms = ['356938035643809', '35-69 38.03/56 438_09', '356938035643809 ', '\\356938035643809'];
    const keys = new Set(forms.map(normalizeSerial));
    expect(keys.size, 'صيغ نفس الرقم لم تتوحّد').toBe(1);
  });

  it('يحوّل الأرقام العربية', () => {
    expect(normalizeSerial('٣٥٦٩٣٨')).toBe('356938');
  });

  it('الأحرف تُرفع لحالة موحّدة', () => {
    expect(normalizeSerial('abc123')).toBe(normalizeSerial('ABC123'));
  });

  it('الفراغ يُرجع فراغاً — لا يُطابق شيئاً', () => {
    expect(normalizeSerial('   ')).toBe('');
    expect(normalizeSerial('')).toBe('');
  });
});

describe('حالة الضمان — حساب تقويمي حتمي', () => {
  it('١٢ شهراً تنتهي بنفس اليوم من العام التالي', () => {
    const w = warrantyStatus('2026-03-15', 12, '2026-08-11');
    expect(w.expiryKey).toBe('2027-03-15');
    expect(w.active).toBe(true);
  });

  it('🔴 انزلاق نهاية الشهر يُصحَّح (٣١ يناير + شهر ⇒ آخر فبراير)', () => {
    expect(warrantyStatus('2026-01-31', 1, '2026-02-10').expiryKey).toBe('2026-02-28');
  });

  it('اليوم الأخير ما زال فعّالاً — لا يُحرَم الزبون من يومه', () => {
    const w = warrantyStatus('2026-02-11', 6, '2026-08-11');
    expect(w.expiryKey).toBe('2026-08-11');
    expect(w.daysLeft).toBe(0);
    expect(w.active, 'انتهى الضمان في يومه الأخير').toBe(true);
  });

  it('اليوم التالي منتهٍ', () => {
    const w = warrantyStatus('2026-02-11', 6, '2026-08-12');
    expect(w.active).toBe(false);
    expect(w.daysLeft).toBe(-1);
  });

  it('بلا مدة ⇒ لا ضمان مسجَّل (لا «منتهٍ»)', () => {
    for (const m of [undefined, 0, -3]) {
      const w = warrantyStatus('2026-01-01', m, '2026-08-11');
      expect(w.hasWarranty).toBe(false);
      expect(w.active).toBe(false);
    }
  });

  it('تاريخ بيع تالف لا يكسر الحساب', () => {
    expect(warrantyStatus('', 12, '2026-08-11').hasWarranty).toBe(false);
    expect(warrantyStatus('نص', 12, '2026-08-11').hasWarranty).toBe(false);
  });
});

describe('البحث عن سيريال', () => {
  const invoices = [
    invoice('A', '2026-01-10', [item('هاتف', ['IMEI-111'], 12)]),
    invoice('B', '2026-05-20', [item('لابتوب', ['SN 222'], 6), item('شاحن')]),
    invoice('C', '2026-07-01', [item('هاتف مستعمل', ['imei111'], 3)]), // نفس الجهاز بِيع ثانيةً
  ];

  it('يجد بأي صيغة كُتب', () => {
    expect(findSerial(invoices, 'sn-222', '2026-08-11')).toHaveLength(1);
    expect(findSerial(invoices, 'SN222', '2026-08-11')).toHaveLength(1);
  });

  it('🔴 يُرجع كل المطابقات — التكرار إشارة تستحق المراجعة', () => {
    const hits = findSerial(invoices, 'IMEI111', '2026-08-11');
    expect(hits).toHaveLength(2);
    expect(hits[0].saleDate, 'الأحدث أولاً').toBe('2026-07-01');
  });

  it('الاستعلام الفارغ لا يُرجع شيئاً', () => {
    expect(findSerial(invoices, '   ', '2026-08-11')).toEqual([]);
  });

  it('يحمل ما يلزم لخدمة الزبون', () => {
    const [hit] = findSerial(invoices, 'IMEI-111', '2026-08-11');
    expect(hit.invoiceNumber).toBe('C');
    expect(hit.productName).toBe('هاتف مستعمل');
    expect(hit.warranty.monthsCovered).toBe(3);
  });

  it('عدّ مرات البيع لكل سيريال', () => {
    const counts = serialSaleCounts(invoices);
    expect(counts.get('IMEI111')).toBe(2);
    expect(counts.get('SN222')).toBe(1);
  });
});

describe('🔴 حذف مرآة الضمان — لا أشباح ضمان', () => {
  const before = [item('هاتف', ['A1', 'B2'], 12), item('غطاء')];

  it('الحذف الكامل ⇒ كل السيريالات تُحذف', () => {
    expect(removedSerialKeys(before, null).sort()).toEqual(['A1', 'B2']);
  });

  it('🔴 الإرجاع الجزئي ⇒ يُحذف المُرجَع فقط ويبقى الباقي', () => {
    const after = [item('هاتف', ['A1'], 12)];
    expect(removedSerialKeys(before, after)).toEqual(['B2']);
  });

  it('لا تغيير ⇒ لا حذف', () => {
    expect(removedSerialKeys(before, before)).toEqual([]);
  });

  it('🔴 تصحيح سيريال ⇒ القديم يُحذف (وإلا بقي رقمان لجهاز واحد)', () => {
    const corrected = [item('هاتف', ['A1', 'B3'], 12)];
    expect(removedSerialKeys(before, corrected)).toEqual(['B2']);
  });

  it('المقارنة بالمفتاح المُوحَّد لا بالنص الخام', () => {
    // نفس السيريال بصيغة مختلفة ⇒ لم يُحذف شيء
    expect(removedSerialKeys([item('x', ['A-1'])], [item('x', ['a1'])])).toEqual([]);
  });

  it('سطور بلا سيريال لا تُنتج مفاتيح', () => {
    expect(serialKeysOf([item('بضاعة عامة')]).size).toBe(0);
  });

  it('يقبل الفاتورة كاملةً أو سطورها', () => {
    const inv = invoice('X', '2026-01-01', before);
    expect([...serialKeysOf(inv)].sort()).toEqual(['A1', 'B2']);
    expect([...serialKeysOf(before)].sort()).toEqual(['A1', 'B2']);
  });

  it('🔴 المحذوف يطابق ما تكتبه المرآة — لا يبقى مفتاح يتيم', () => {
    const inv = invoice('X', '2026-01-01', before);
    const written = warrantyEntriesOf(inv).map(e => e.id).sort();
    const removed = removedSerialKeys(inv, null).sort();
    expect(removed, 'مفتاح كُتب ولا يُحذف ⇒ شبح ضمان').toEqual(written);
  });
});

/**
 * 🔴 حارس: كل مسار يُنقص سيريالاً يجب أن يحذف مرآته.
 *
 * لا اختبار وحدة يكشف **النسيان** — الدوال كلها سليمة، والعلّة أن أحداً لم يستدعِها.
 * نفس نمط حارس النسخة الاحتياطية ودليل الشاشات وكتابات المال.
 */
describe('حارس: المرآة تُحذف حيث تُكتب', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'InvoicesView.tsx'), 'utf8');
  /**
   * ⚠️ تُحذف التعليقات **وسطور الاستيراد** معاً.
   *
   * أول صياغة لهذا الحارس كانت تبحث عن اسم الدالة في الملف كلّه، فمرّت زوراً حين
   * ألغيتُ كل استدعاءاتها تجريبياً — لأن سطر `import` وحده كان يُرضيها. واستيرادُ دالةٍ
   * لا يعني استدعاءها، وحارسٌ يُرضيه الاستيراد لا يحرس شيئاً.
   */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import\s[\s\S]*?from\s+'[^']*';\s*$/gm, '');

  /**
   * 🔧 تغيّرت صياغة هذا الحارس حين صارت البيعة ذرّية (ISSUE-005): كتابة المرآة وحذفها
   * في مسار التعديل انتقلا إلى `stageSale`، فلم يعد `syncWarrantyIndex(` ولا استدعاءٌ
   * ثالث لـ`removeWarrantyIndexFromBatch` موجوداً في هذه الشاشة.
   *
   * ⚠️ ولم يُخفَّف: عدُّ الاستدعاءات فُحص كان يقيس **اسماً**، وهذا يقيس **الآلية** —
   * أن كل مسار يُنقص سيريالاً يُمرّر مفاتيحه إلى جهةٍ تحذفها فعلاً. وهو أضيق مسلكاً
   * من العدّ: لا يُرضيه استدعاءٌ زائد في مكان لا يلزم.
   */
  const sale = readFileSync(join(process.cwd(), 'src', 'utils', 'saleWrite.ts'), 'utf8');

  it('المسح يرى الملف فعلاً ويستبعد الاستيرادات', () => {
    expect(code.length).toBeGreaterThan(10000);
    expect(code, 'لم تُستبعد سطور الاستيراد').not.toContain("from '../utils/warranty'");
    expect(code).toContain('stageSale(');
  });

  it('🔴 المسارات الثلاثة مغطّاة: الحذف والإرجاع والتعديل', () => {
    // الحذف والإرجاع — حذفٌ مباشر في دفعة كلٍّ منهما
    const direct = code.match(/removeWarrantyIndexFromBatch\s*\(/g) ?? [];
    expect(
      direct.length,
      'مسارا حذف الفاتورة وإرجاعها يُنقصان سيريالات ويجب أن يحذفا مرآتها',
    ).toBeGreaterThanOrEqual(2);

    // التعديل — يُمرّر المفاتيح المنقوصة إلى خطّة البيعة
    expect(
      /removedSerialKeys: removedSerialKeys\(existing\.items, formattedItems\)/.test(code),
      'التعديل لا يُمرّر السيريالات المحذوفة ⇒ تبقى «أشباح ضمان» على أجهزة صُحِّحت أو أُزيلت',
    ).toBe(true);

    // وstageSale ملزَمة بحذفها فعلاً — وإلا صار التمرير زينة
    expect(
      /if \(plan\.removedSerialKeys\?\.length\)[\s\S]{0,120}removeWarrantyIndexFromBatch\(/.test(sale),
      'المفاتيح تُمرَّر ولا تُحذف ⇒ الحارس يمرّ والمرآة تبقى ملوّثة',
    ).toBe(true);
  });

  it('🔴 التحذير من السيريال المُباع سابقاً موصول لحظة الكتابة', () => {
    expect(
      /serialSaleCounts\s*\(/.test(code),
      'كشف التكرار مبنيّ ولا يُستدعى ⇒ لا يظهر إلا بعد وقوع الخطأ بشهور',
    ).toBe(true);
  });
});
