import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toArabicDigits, toLatinDigits } from '../arabicFormatters';

/**
 * البحث في الفواتير — العيب الذي يجعل التاجر يظنّ وصله ضاع.
 *
 * رقم الفاتورة يُخزَّن **عربياً-هندياً** (`toArabicDigits`)، والتاجر يقرأ الرقم من الورقة
 * ويكتبه على لوحة الأرقام فيخرج **لاتينياً**. المقارنة النصّية الخام لا تطابق بينهما،
 * فتظهر «لم نعثر على أي فاتورة» والفاتورة موجودة. لا خطأ يظهر — ثقة تُهدر فقط.
 */

describe('توحيد الأرقام للبحث', () => {
  it('يحوّل العربية-الهندية إلى لاتينية', () => {
    expect(toLatinDigits('٢٠٤٣')).toBe('2043');
    expect(toLatinDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('يحوّل الفارسية أيضاً (تصل من النسخ واللصق)', () => {
    expect(toLatinDigits('۲۰۴۳')).toBe('2043');
  });

  it('لا يمسّ الحروف ولا العلامات', () => {
    expect(toLatinDigits('فاتورة ٢٠٤٣ — أحمد')).toBe('فاتورة 2043 — أحمد');
    expect(toLatinDigits('2026-08-11')).toBe('2026-08-11');
  });

  it('يحتمل الفارغ والأرقام', () => {
    expect(toLatinDigits('')).toBe('');
    expect(toLatinDigits(2043)).toBe('2043');
  });

  it('عكس toArabicDigits تماماً — ذهاباً وإياباً', () => {
    for (const n of [0, 7, 42, 1001, 999999]) {
      expect(toLatinDigits(toArabicDigits(n))).toBe(String(n));
    }
  });
});

/**
 * محاكاة شرط البحث كما في الشاشة — قبل الإصلاح وبعده، لإظهار الفرق العملي.
 */
const matches = (invoiceNumber: string, search: string) => {
  const q = search.trim().toLowerCase();
  const qDigits = toLatinDigits(q);
  return !q || toLatinDigits(invoiceNumber).includes(qDigits);
};

describe('🔴 البحث برقم الفاتورة يجد الفاتورة بأي كتابة', () => {
  const stored = toArabicDigits(2043); // كما تُحفظ فعلاً

  it('الكتابة اللاتينية تجدها (كانت تفشل)', () => {
    expect(matches(stored, '2043')).toBe(true);
  });

  it('الكتابة العربية تجدها كما كانت', () => {
    expect(matches(stored, '٢٠٤٣')).toBe(true);
  });

  it('جزء من الرقم يكفي — التاجر يتذكّر آخر رقمين', () => {
    expect(matches(stored, '43')).toBe(true);
    expect(matches(stored, '٤٣')).toBe(true);
  });

  it('رقم مختلف لا يُطابَق كذباً', () => {
    expect(matches(stored, '2044')).toBe(false);
  });

  it('البحث الفارغ يمرّر الكل', () => {
    expect(matches(stored, '   ')).toBe(true);
  });

  it('رقم فاتورة موظف (بصيغة بادئة-تسلسل) يُبحث عنه بالطريقتين', () => {
    const empNum = `${toArabicDigits(4382)}-${toArabicDigits(7)}`;
    expect(matches(empNum, '4382-7')).toBe(true);
    expect(matches(empNum, '٤٣٨٢-٧')).toBe(true);
  });
});

/**
 * 🔴 حارس مصدر — يحمي القرارات التي لا يكشف كسرَها أي اختبار وحدة، لأنها تعيش
 * في **ربط** الشاشة لا في دالة مستقلة.
 */
describe('حارس: شاشة الفواتير تحترم الفرع', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'InvoicesView.tsx'), 'utf8');

  it('البيع من العرض المجمّع ممنوع — لا نخمّن فرع البضاعة', () => {
    expect(src).toContain('isAggregateView');
    expect(
      /isAggregateView\s*&&\s*!isEditing/.test(src),
      'حارس الإصدار في وضع «كل الفروع» اختفى — الفواتير ستُنسب للرئيسي صامتاً',
    ).toBe(true);
  });

  it('طباعة الفترة تُصفّى بالفرع كالقائمة', () => {
    const range = src.slice(src.indexOf('const rangeInvoices'), src.indexOf('const applyDatePreset'));
    expect(
      range.includes('matchesActiveBranch'),
      'طباعة الفترة رجعت تقرأ كل الفروع — التاجر سيطبع فواتير فرع لم يخترْه',
    ).toBe(true);
  });

  it('الفاتورة المعروضة تتبع الفرع', () => {
    expect(src).toMatch(/const activeInvoice[\s\S]{0,160}matchesActiveBranch/);
  });

  it('تبديل الفرع يمسح التحديد والمعاينة', () => {
    expect(src).toMatch(/setSelectedForPrint\(new Set\(\)\)[\s\S]{0,80}\[activeBranchId\]/);
  });

  it('⚡ القائمة المصفّاة محفوظة بالذاكرة — التجميع لا يُعاد مع كل حرف', () => {
    expect(
      /const filteredInvoices = useMemo\(/.test(src),
      'filteredInvoices عادت تُبنى في كل رندر — ذاكرة groupedInvoices تصبح بلا فائدة',
    ).toBe(true);
  });

  it('اسم الفرع يظهر للتاجر (لا يبقى مستورداً بلا استعمال)', () => {
    const uses = src.match(/branchName\(/g) ?? [];
    expect(uses.length, 'branchName غير مستعمل — لا شيء يميّز فاتورة المخزن من فاتورة المحل').toBeGreaterThan(1);
  });
});
