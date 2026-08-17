import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 🔴 نطاق الاستعلامات — ما يُقيَّد على الخادم وما يبقى كاملاً **عن قصد**.
 *
 * كل `useCollection` بلا قيود يفتح اشتراكاً على المجموعة **كاملةً**. وفاتورة فايرستور
 * تُحاسَب بعدد الوثائق المقروءة لا بحجمها، فالكلفة تتضاعف بعمر المحل لا بحجم الشاشة.
 *
 * ⚠️ لكن التقييد ليس دائماً صحيحاً، وهذا ما يحرسه هذا الملف من الطرفين:
 *
 *   · شاشة الفواتير **تحتاج السجل كاملاً لصحّتها لا لعرضها**: الرقم التالي يُشتقّ من
 *     `nextOwnerSeq(invoices)`، وكشفُ السيريال المُباع سابقاً من `serialSaleCounts`،
 *     وتعديلُ فاتورة قديمة يتطلّب وجودها. فنافذةٌ عليها **تُعيد الترقيم من أوّله**
 *     وتُنتج أرقاماً مكرّرة — وهذا أسوأ من بطء التحميل بكثير.
 *
 *   · والنسخة الاحتياطية كاملةٌ بالتعريف.
 *
 * فالحارس يُثبّت ما قُيِّد، **ويُثبّت أيضاً ما يجب ألّا يُقيَّد**.
 */

const root = join(process.cwd(), 'src');
const read = (p: string) => readFileSync(join(root, ...p.split('/')), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const modal = read('components/CustomerHistoryModal.tsx');
const shell = read('components/DashboardLayout.tsx');
const invoices = read('components/InvoicesView.tsx');
const backup = read('components/BackupView.tsx');

describe('🔴 ما قُيِّد على الخادم', () => {
  it('المسح يرى الملفات فعلاً', () => {
    expect(modal).toContain('custInvoices');
    expect(shell).toContain('currentNotifs');
    expect(invoices).toContain('handleSubmitForm');
  });

  it('🔴 سجلّ الزبون يُقيَّد بمعرّفه — لا تنزيل الدفتر كله لعرض عشرة سطور', () => {
    expect(
      /where\('customerId', '==', customer\.id\)/.test(modal),
      'كان يُحمّل كل فواتير المحل وكل تسديداته ثم يفلتر في المتصفح',
    ).toBe(true);
    // المجموعتان معاً — لا واحدة دون الأخرى
    expect(/useCollection<Invoice>\('invoices', invoiceQuery\)/.test(modal)).toBe(true);
    expect(/useCollection<DebtPayment>\('debt_payments', invoiceQuery\)/.test(modal)).toBe(true);
  });

  it('🔴 جرس التنبيهات يُقيَّد — والقشرة تلفّ كل الشاشات فاشتراكها دائم', () => {
    expect(/where\('balance', '>', 0\)/.test(shell)).toBe(true);
    expect(/where\('status', '==', 'active'\)/.test(shell)).toBe(true);
  });

  it('🔴 والقيود مُذكّرة بـuseMemo — وإلا أُعيد الاشتراك كل رندر', () => {
    expect(
      /const invoiceQuery = useMemo\(/.test(modal),
      'مصفوفة قيود جديدة كل رندر تُعيد فتح الاشتراك — أسوأ من غياب القيد',
    ).toBe(true);
    expect(/const debtorsQuery = useMemo\(/.test(shell)).toBe(true);
    expect(/const activeBatchesQuery = useMemo\(/.test(shell)).toBe(true);
  });

  it('🔴 وكل قيد بحقل واحد — فلا يحتاج فهرساً مركّباً يجب إنشاؤه يدوياً', () => {
    for (const [name, src] of [['المودال', modal], ['القشرة', shell]] as const) {
      for (const m of src.matchAll(/useCollection<[^>]+>\('([a-z_]+)',\s*(\w+)\)/g)) {
        const decl = new RegExp(`const ${m[2]} = useMemo\\(\\(\\) => \\[([^\\]]*)\\]`);
        const found = src.match(decl);
        expect(found, `${name}: قيد ${m[2]} غير مُعرَّف بـuseMemo`).toBeTruthy();
        const clauses = (found![1].match(/where\(/g) ?? []).length;
        expect(clauses, `${name}: ${m[1]} فيه ${clauses} شروط — أكثر من واحد يستلزم فهرساً مركّباً`).toBeLessThanOrEqual(1);
      }
    }
  });
});

/**
 * 🛡️ الطرف الآخر من الحارس — ما يجب أن يبقى كاملاً.
 */
describe('🛡️ ما يبقى كاملاً عن قصد', () => {
  it('🔴 شاشة الفواتير تشترك على المجموعة كاملةً — صحّة الترقيم رهينة ذلك', () => {
    expect(
      /useCollection<Invoice>\('invoices'\)/.test(invoices),
      'نافذةٌ هنا تجعل nextOwnerSeq يعدّ من قائمة منقوصة ⟵ أرقام فواتير مكرّرة',
    ).toBe(true);
  });

  it('🔴 والترقيم فعلاً مشتقّ من القائمة (سبب المنع)', () => {
    expect(/allocateOwnerNumber\(invoices/.test(invoices)).toBe(true);
    expect(
      /serialSaleCounts\(/.test(invoices),
      'كشف السيريال المُباع سابقاً يحتاج التاريخ كله أيضاً',
    ).toBe(true);
  });

  it('🔴 والنسخة الاحتياطية كاملة بالتعريف', () => {
    expect(/useCollection<Invoice>\('invoices'\)/.test(backup)).toBe(true);
    expect(/useCollection<Customer>\('customers'\)/.test(backup)).toBe(true);
  });

  it('🔴 ومنتجات الجرس كاملة — الحدّ لكل منتج، ولا مقارنة بين حقلين في استعلام', () => {
    expect(
      /useCollection<Product>\('products'\)/.test(shell),
      'lowStockThreshold يختلف لكل منتج ⟵ لا يمكن ترشيحه على الخادم',
    ).toBe(true);
  });
});
