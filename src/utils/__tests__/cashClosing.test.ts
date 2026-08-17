import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCashMethod } from '../paymentMethods';

/**
 * 🔴 تقفيل الصندوق — المعادلة سليمة والعلل في **مداخلها**.
 *
 * الفرع كان يتسرّب من ثلاث جهات (المصاريف، فواتير الشراء، تسديدات الديون)، وطريقة الدفع
 * ناقصة من جهة رابعة (المصاريف والإيرادات اليدوية)، وربط السجل بالتاريخ مكسور للفروع.
 */

/** نسخة مطابقة لـ`toDayKey` في الشاشة — لإثبات كسر معرّف الفرع بلا تشغيل React. */
const toDayKey = (dateStr: string): string => {
  if (!dateStr) return '';
  const s = String(dateStr).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const parts = s.replace(/\//g, '-').split('-').map(p => p.trim()).filter(Boolean);
  if (parts.length === 3) {
    let y: number, mo: number, da: number;
    if (parts[0].length === 4) { y = +parts[0]; mo = +parts[1]; da = +parts[2]; }
    else { da = +parts[0]; mo = +parts[1]; y = +parts[2]; }
    if (y < 100) y += 2000;
    if (y && mo && da) return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  }
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return 'parsed';
  return '';
};

describe('🔴 معرّف الإقفال ليس تاريخاً في الفروع', () => {
  const day = '2026-08-13';
  const branchDocId = `branch_1786294963922-tth3nq_${day}`;

  it('الرئيسي: المعرّف = التاريخ فلا يظهر العطل', () => {
    expect(toDayKey(day)).toBe(day);
  });

  it('🔴 الفرع: المعرّف لا يُقرأ تاريخاً إطلاقاً', () => {
    expect(
      toDayKey(branchDocId),
      'استعمال c.id كتاريخ يجعل selectedDay نصّاً لا يطابق شيئاً ⇒ كل الأرقام أصفار',
    ).toBe('');
    expect(new Date(`${branchDocId}T00:00:00`).getTime()).toBeNaN();
  });

  it('الحقل `date` بجواره صحيح دائماً', () => {
    expect(toDayKey(day)).toBe(day);   // c.date يحمل هذه القيمة في الحالتين
  });
});

describe('فصل النقد عن الإلكتروني — القاعدة الواحدة', () => {
  it('غياب الطريقة = كاش (توافق رجعي مع كل البيانات السابقة)', () => {
    expect(isCashMethod(undefined)).toBe(true);
    expect(isCashMethod('')).toBe(true);
    expect(isCashMethod('كاش')).toBe(true);
  });

  it('التحويل والبطاقة ليست نقداً في الدرج', () => {
    for (const m of ['تحويل بنكي', 'ZainCash', 'Visa', 'FIB']) {
      expect(isCashMethod(m), `${m} حُسب نقداً`).toBe(false);
    }
  });

  it('🔴 مصروف بتحويل يجب ألّا يُخصم من الدرج', () => {
    const dayExpense = [{ amount: 5_000_000, method: 'تحويل بنكي' }, { amount: 100_000, method: 'كاش' }];
    const cash = dayExpense.reduce((s, t) => s + (isCashMethod(t.method) ? t.amount : 0), 0);
    const electronic = dayExpense.reduce((s, t) => s + (isCashMethod(t.method) ? 0 : t.amount), 0);
    expect(cash, 'جمعُ الكل كان يرفع الخارج فيهبط المتوقَّع ⇒ فائض وهمي بقيمة التحويل').toBe(100_000);
    expect(electronic).toBe(5_000_000);
  });
});

describe('🔴 حارس: مداخل تقفيل الصندوق', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');

  const cc = read('src/components/CashClosingView.tsx');
  const ex = read('src/components/ExpensesView.tsx');
  const dv = read('src/components/DebtView.tsx');

  it('المسح يرى الملفات فعلاً', () => {
    expect(cc).toContain('cashOut');
    expect(ex).toContain('FinancialTransaction');
    expect(dv).toContain('savePayment');
  });

  it('🔴 السجل يربط بالتاريخ لا بالمعرّف', () => {
    expect(/setSelectedDay\(c\.id\)/.test(cc), 'النقر يكسر الشاشة في الفروع').toBe(false);
    expect(/const isSel = c\.id === selectedDay/.test(cc)).toBe(false);
    expect(/formatDayAr\(c\.id\)/.test(cc), 'يعرض المعرّف الخام بدل التاريخ').toBe(false);
    expect(/setSelectedDay\(c\.date\)/.test(cc)).toBe(true);
  });

  it('🔴 كل مصادر النقد مصفّاة بالفرع', () => {
    for (const [name, re] of [
      ['تسديدات الديون', /const dayPayments = payments[\s\S]{0,160}matchesActiveBranch/],
      ['المصاريف والإيرادات', /const dayTx = transactions[\s\S]{0,160}matchesActiveBranch/],
      ['فواتير الشراء', /const dayPurchases = purchaseInvoices[\s\S]{0,220}matchesActiveBranch/],
      ['تسديدات الموردين', /daySupplierPayments[\s\S]{0,200}matchesActiveBranch/],
    ] as const) {
      expect(re.test(cc), `${name}: تتسرّب بين الفروع فصندوق الفرع ليس فرعياً فعلاً`).toBe(true);
    }
  });

  it('🔴 المصاريف والإيرادات تُفصل بالطريقة', () => {
    expect(
      /const expenses = dayExpense\.reduce\(\(s, t\) => s \+ \(isCashMethod\(t\.method\)/.test(cc),
      'إيجار محوَّل مصرفياً يُخصم من نقدٍ لم يمسّه ⇒ فائض وهمي، وهي أكبر بنود الخارج',
    ).toBe(true);
    expect(/const manualRevenue = dayRevenue\.reduce\(\(s, t\) => s \+ \(isCashMethod\(t\.method\)/.test(cc)).toBe(true);
  });

  it('🔴 النموذج المحلي يُعلن الحقول وإلا بقيت محجوبة عن الحساب', () => {
    expect(/interface FinancialTransaction[\s\S]{0,400}branchId\?: string;/.test(cc)).toBe(true);
    expect(/interface FinancialTransaction[\s\S]{0,400}method\?: string;/.test(cc)).toBe(true);
    expect(/interface DebtPayment[\s\S]{0,300}branchId\?: string;/.test(cc)).toBe(true);
  });

  it('🔴 المصدر يكتب الحقلين — الحارس بلا كتابة أعمى', () => {
    expect(/method: formMethod,/.test(ex), 'المصاريف تُكتب بلا طريقة دفع').toBe(true);
    expect(/branchId: stampBranchId,/.test(ex)).toBe(true);
    expect(/branchId: stampBranchId,/.test(dv), 'تسديد الدين يُكتب بلا فرع').toBe(true);
  });

  it('🟠 المدفوع إلكترونياً يُعرض لا يُحسب ويُهمل', () => {
    expect(/day\.electronicOut/.test(cc), 'حُسب أمس ولم يُعرض — التاجر لا يعرف أين ذهب المال').toBe(true);
  });

  it('🟡 كل مصادر النقد ضمن نافذة زمنية', () => {
    for (const c of ['debt_payments', 'financial_transactions', 'purchase_invoices', 'supplier_payments']) {
      expect(
        new RegExp(`useCollection<[^>]+>\\('${c}', invWindow\\)`).test(cc),
        `${c}: تُقرأ كاملةً — كل تاريخ المحل لحساب يومٍ واحد`,
      ).toBe(true);
    }
  });
});
