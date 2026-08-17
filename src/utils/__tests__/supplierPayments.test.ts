import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allocatePayment, invoicePaymentUpdate } from '../debtAllocation';

/**
 * 🔴 آجل الموردين — شاشة كُتبت قبل الأدوات المشتركة ولم تُحدَّث معها:
 * `debtAllocation` موجودة ولا تُستعمل، الفواتير تُكتب مطلقةً والرصيد بفارق، التسديد بلا
 * طريقة دفع فيعدّه تقفيل الصندوق نقداً كلَّه، والإلغاء يحذف السجل بدل ختمه.
 *
 * المنطق النقي مُختبَر في مواضعه (debtAllocation 17، reversal 19) — هذه الاختبارات تحرس
 * **الاستعمال**: أن الشاشة والتقفيل يمرّان من الأدوات لا من نسخ يدوية.
 */

const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*import .*$/gm, '');

describe('جسر فاتورة الشراء إلى محرّك التوزيع', () => {
  const purchase = { id: 'a', finalAmount: 100_000, remainingAmount: 60_000, paidAmount: 40_000, createdAt: 1 };

  it('التوزيع يعمل على فواتير الشراء المجسَّرة', () => {
    const { allocations, unallocated } = allocatePayment([purchase], 50_000);
    expect(allocations).toEqual([{ invoiceId: 'a', amount: 50_000 }]);
    expect(unallocated).toBe(0);
  });

  it('🟠 الفائض عن الفواتير لا يمنع — يُخصم من الرصيد وحده', () => {
    // كان المنع تامّاً: دينٌ بلا فواتير مفتوحة تُغطّيه = دينٌ لا سبيل لإطفائه
    const { allocations, unallocated } = allocatePayment([purchase], 100_000);
    expect(allocations[0].amount).toBe(60_000);
    expect(unallocated, 'الرفض الكامل كان يحبس التاجر أمام دينٍ يراه ولا يستطيع تسديده').toBe(40_000);
  });

  it('الكتابة على الفاتورة بالفوارق لا بالقيم المطلقة', () => {
    const upd = invoicePaymentUpdate(purchase, 50_000);
    // increment sentinel لا رقم خام — وإلا محا جهازٌ تسديدَ جهازٍ آخر
    expect(typeof upd.remainingAmount).toBe('object');
    expect(typeof upd.paidAmount).toBe('object');
  });
});

describe('🔴 حارس: شاشة آجل الموردين', () => {
  const src = read('src/components/SupplierAccountsView.tsx');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('SupplierPayment');
    expect(src).toContain('submitPayment');
  });

  it('🔴 التوزيع والكتابة من الأدوات المشتركة لا من حلقة يدوية', () => {
    expect(/allocatePayment\(/.test(src), 'عادت الحلقة اليدوية التي ترفض الفائض رفضاً تامّاً').toBe(true);
    expect(/invoicePaymentUpdate\(/.test(src), 'عادت الكتابة المطلقة ⇒ جهازان يسدّدان فتضيع حركة').toBe(true);
    expect(
      /remainingAmount:\s*invoice\.remainingAmount\s*[-+]/.test(src),
      'كتابة مطلقة من لقطة محلية على فاتورة الشراء',
    ).toBe(false);
  });

  it('🔴 التسديد يحمل طريقته وفرعه', () => {
    expect(/method,/.test(src), 'بلا method يعدّ التقفيل التحويلَ المصرفي نقداً خرج من الدرج').toBe(true);
    expect(/branchId:\s*stampBranchId/.test(src), 'بلا فرع يُخصم تسديد المحل من صندوق المخزن').toBe(true);
  });

  it('🔴 لا `await batch.commit()` — يُعلّق الشاشة بلا إنترنت إلى الأبد', () => {
    expect(/await\s+batch\.commit\(\)/.test(src)).toBe(false);
    expect(/batch\.commit\(\)\.catch\(/.test(src)).toBe(true);
  });

  it('🔴 التراجع يختم ولا يحذف', () => {
    expect(/batch\.delete\(/.test(src), 'حذف التسديد يمحو «مَن دفع ومتى» من أمام التاجر').toBe(false);
    expect(/markReversedUpdate\(/.test(src)).toBe(true);
    expect(/canReverse\(/.test(src), 'بلا فحص: تراجع مرّتين يُعيد الرصيد مرّتين').toBe(true);
    expect(/reversalOfId:\s*payment\.id/.test(src)).toBe(true);
  });

  it('🟠 الموردون الدائنون لنا معروضون لا مخفيّون', () => {
    expect(/balance < 0/.test(src), 'المال الذي لك عند مورّدك لم تكن تعرضه أي شاشة').toBe(true);
  });
});

describe('🔴 حارس: تقفيل الصندوق يفصل تسديدات الموردين', () => {
  const src = read('src/components/CashClosingView.tsx');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('supplierPayments');
    expect(src).toContain('cashOut');
  });

  it('🔴 الطريقة تُفحص — التحويل المصرفي لا يُخصم من الدرج', () => {
    expect(
      /supplierSettled\s*=\s*daySupplierPayments\s*\.reduce\(\(s, sp\) => s \+ \(isCashMethod\(sp\.method\)/.test(src),
      'كل تسديد كان يُعدّ «نقداً خرج فعلاً» ⇒ فائض وهمي في الدرج بقيمة كل تحويل',
    ).toBe(true);
  });

  it('🔴 الفرع يُفحص — تسديد المحل لا يُخصم من صندوق المخزن', () => {
    expect(
      /daySupplierPayments\s*=\s*supplierPayments[\s\S]{0,200}matchesActiveBranch/.test(src),
      'كانت الوحيدة في هذا الحساب بلا تصفية فرع',
    ).toBe(true);
  });
});
