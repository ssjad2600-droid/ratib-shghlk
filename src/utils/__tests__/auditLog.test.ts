import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { periodRange } from '../reportPeriod';

/**
 * 🔴 سجل التدقيق: الحماية ممتازة والوصول كان قاصراً.
 *
 * قواعد Firestore تمنع الموظف من محو أثره (وهو جوهر السجل وقد أُصيب). لكن العرض كان
 * `limit(500)` **أعمى بلا نافذة ولا صفحات**: في البرنامج ٣٧ موضع تسجيل، فمحلٌّ متوسط
 * الحركة يستهلك الخمسمئة في أسبوع أو اثنين — وبعدها تبقى عملية الشهر الماضي في قاعدة
 * البيانات ولا سبيل لرؤيتها من البرنامج. والسجل موجودٌ أصلاً للسؤال المتأخّر.
 */

const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const hook = read('src/utils/auditLog.ts');
const view = read('src/components/AuditLogView.tsx');
const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

describe('🔴 الوصول إلى الماضي', () => {
  it('المسح يرى الملفات فعلاً', () => {
    expect(hook).toContain('useAuditLogs');
    expect(view).toContain('AuditLogView');
  });

  it('🔴 الاشتراك يقبل نافذة زمنية لا حدّاً أعمى', () => {
    expect(/sinceMs/.test(hook), 'الحدّ وحده يبتر التاريخ بلا سبيل لما وراءه').toBe(true);
    expect(/where\('createdAt', '>=', sinceMs\)/.test(hook)).toBe(true);
  });

  it('🔴 الشاشة تختار الفترة ولا تُثبّت ٥٠٠', () => {
    expect(/useAuditLogs\(500\)/.test(view), 'عاد الحدّ الأعمى').toBe(false);
    expect(/periodRange\(/.test(view)).toBe(true);
    expect(/useAuditLogs\(sinceMs\)/.test(view)).toBe(true);
  });

  it('🔴 بلوغ السقف يُعلَن ولا يُبتر بصمت', () => {
    expect(/reachedCap/.test(hook)).toBe(true);
    expect(/reachedCap/.test(view), 'المستخدم لا يعرف أن ما يراه ناقص').toBe(true);
  });

  it('الاستعلام على حقلٍ واحد ⇒ لا فهرس مركّب مطلوب', () => {
    // where + orderBy على `createdAt` نفسه — يستفيد من الفهرس المفرد التلقائي
    const m = hook.match(/where\('(\w+)', '>=', sinceMs\)[\s\S]{0,60}orderBy\('(\w+)'/);
    expect(m, 'شكل الاستعلام تغيّر').not.toBeNull();
    expect(m![1]).toBe(m![2]);
  });

  it('🔴 فرع النافذة يُطبّق `where` فعلاً — لا يتظاهر بها', () => {
    /**
     * طفرةٌ واقعية: يبقى `sinceMs` في التوقيع وتُحذف `where` من الاستعلام، فيبدو الكود
     * موصولاً بالنافذة وهو يُرجع آخر N عملية دائماً — أخطر من الحدّ الأعمى الصريح
     * لأنه يدّعي ما لا يفعل. نُلزم أن يكون الفرعان مختلفين فعلاً.
     */
    const ternary = hook.match(/const q = sinceMs > 0\s*\?([\s\S]*?):([\s\S]*?);\n/);
    expect(ternary, 'اختفى تفرّع النافذة').not.toBeNull();
    expect(/where\(/.test(ternary![1]), 'فرع النافذة بلا شرط زمني').toBe(true);
    expect(/where\(/.test(ternary![2]), 'فرع «كل التاريخ» يجب أن يكون بلا شرط').toBe(false);
  });
});

describe('🔴 نطاق النافذة يطابق ما تعلنه الشاشة', () => {
  const NOW = new Date(2026, 7, 17, 12, 0);
  it('الفترات تعطي مدداً صحيحة', () => {
    expect(periodRange('daily', NOW).days).toBe(1);
    expect(periodRange('weekly', NOW).days).toBe(7);
    expect(periodRange('monthly', NOW).days).toBe(30);
    expect(periodRange('yearly', NOW).days).toBe(365);
  });

  it('«كل التاريخ» يُترجم إلى صفر (بلا شرط زمني)', () => {
    expect(/period === 'all' \? 0 :/.test(view)).toBe(true);
  });
});

describe('🟠 التصنيف والمرشِّحات', () => {
  it('🔴 نقل البضاعة والفروع لهما نوعاهما', () => {
    const types = read('src/types.ts');
    expect(/'stock_transfer' \| 'branch'/.test(types)).toBe(true);
    expect(/stock_transfer: 'نقل بضاعة'/.test(view)).toBe(true);
    expect(/branch: 'فرع أو مخزن'/.test(view)).toBe(true);
  });

  it('🔴 المصدر يسجّل بالنوع الصحيح لا بـ«منتج»/«إعدادات»', () => {
    const st = read('src/components/StockTransfersView.tsx');
    const bv = read('src/components/BranchesView.tsx');
    expect(/entity: 'stock_transfer'/.test(st), 'النقل يختلط بتعديلات المنتجات').toBe(true);
    expect(/entity: 'product'/.test(st), 'بقي تسجيل نقل باسم منتج').toBe(false);
    expect(/entity: 'branch'/.test(bv)).toBe(true);
  });

  it('🟠 مرشِّح المنفِّذ موجود — أوّل سؤال مساءلة', () => {
    expect(/كل المنفّذين/.test(view)).toBe(true);
    expect(/actor === 'all' \|\| item\.actorName === actor/.test(view)).toBe(true);
  });

  it('🟡 «لا سجل» تُميَّز عن «لا نتيجة»', () => {
    expect(/items\.length === 0/.test(view)).toBe(true);
    expect(/لا توجد عمليات مطابقة للمرشِّحات/.test(view)).toBe(true);
  });
});

describe('🟠 التصدير لا يدّعي الشمول', () => {
  it('يذكر النطاق في العنوان', () => {
    expect(/subtitle: `سجل التدقيق — \$\{scopeText\}/.test(view)).toBe(true);
  });

  it('🔴 ويحمل تحفّظاً صريحاً عند بلوغ السقف', () => {
    expect(
      /note: reachedCap[\s\S]{0,200}بُلغ سقف التحميل/.test(view),
      'الورقة تُقرأ خارج البرنامج بلا سياقه — فلا تدّعي ما ليس فيها',
    ).toBe(true);
  });
});

/**
 * 🛡️ حارس الحماية: الطبقة التي لا تُصلَح لاحقاً.
 */
describe('🛡️ قواعد الوصول — جوهر السجل', () => {
  it('الموظف ينشئ ولا يقرأ ولا يعدّل ولا يحذف', () => {
    const block = rules.match(/match \/audit_logs\/\{id\} \{[\s\S]*?\}/)?.[0] ?? '';
    expect(block, 'كتلة audit_logs غير موجودة').toContain('allow create');
    expect(/allow (read|update|delete)/.test(block), 'الموظف يستطيع طمس أثره').toBe(false);
  });

  it('🔴 لا ينتحل هوية غيره', () => {
    const block = rules.match(/match \/audit_logs\/\{id\} \{[\s\S]*?\}/)?.[0] ?? '';
    expect(/actorUid == request\.auth\.uid/.test(block)).toBe(true);
  });

  it('🔴 كل تسجيل يمرّ بشجرة المالك لا شجرة الموظف', () => {
    expect(
      /const treeUid = ownerUid \|\| actorUid/.test(hook),
      'بدونه يُكتب سجل الموظف في شجرته الخاصة فلا يراه المالك أبداً',
    ).toBe(true);
  });

  it('🔴 فشل التسجيل لا يُفشل العملية الأصلية', () => {
    expect(/catch \(err\)[\s\S]{0,120}console\.error\('\[Audit\] write failed/.test(hook)).toBe(true);
  });
});

/**
 * حارس التغطية: العمليات الحسّاسة تُسجَّل فعلاً.
 */
describe('حارس: العمليات الحسّاسة مغطّاة', () => {
  it('كل شاشة تمسّ المال أو المخزون تسجّل', () => {
    const dir = join(process.cwd(), 'src', 'components');
    const missing: string[] = [];
    const mustLog = [
      'InvoicesView.tsx', 'DebtView.tsx', 'CustomersView.tsx', 'ProductsView.tsx',
      'InventoryAdjustmentsView.tsx', 'StockTransfersView.tsx', 'ExpiryView.tsx',
      'SuppliersView.tsx', 'PurchaseInvoicesView.tsx', 'SupplierAccountsView.tsx',
      'CashClosingView.tsx', 'ExpensesView.tsx', 'BranchesView.tsx', 'EmployeeManagement.tsx',
    ];
    for (const f of mustLog) {
      const src = readFileSync(join(dir, f), 'utf8');
      if (!/logAudit\(/.test(src)) missing.push(f);
    }
    expect(missing, `شاشات حسّاسة بلا تسجيل: ${missing.join(', ')}`).toEqual([]);
  });

  it('المسح يرى ملفات المكوّنات', () => {
    expect(readdirSync(join(process.cwd(), 'src', 'components')).length).toBeGreaterThan(20);
  });
});
