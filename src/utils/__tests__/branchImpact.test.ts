import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  strandedStock, impactVerdict, linkedSummary, totalLinked,
  findDuplicateBranch, branchNameKey, EMPTY_COUNTS, LinkedCounts,
} from '../branchImpact';
import { Product } from '../../types';

/**
 * 🔴 أفعال شاشة الفروع لها آثار بعيدة في شاشات أخرى، وكانت تُنفَّذ **بلا إعلان أثرها**.
 * الحماية للبيانات كانت موجودة؛ الناقص حماية **قرار التاجر** بالمعلومة.
 */

const prod = (id: string, branchStock: Record<string, number>): Product =>
  ({ id, name: id, barcode: '', category: '', unit: 'قطعة', sellPrice: 1000, quantity: 0,
     lowStockThreshold: 1, createdAt: '2026-01-01', hasWholesale: false, branchStock } as Product);

const counts = (over: Partial<LinkedCounts> = {}): LinkedCounts => ({ ...EMPTY_COUNTS, ...over });

describe('البضاعة المعلّقة', () => {
  it('يكشف ما بقي في الموقع مرتّباً بالأكبر', () => {
    const products = [prod('قليل', { wh: 2 }), prod('كثير', { wh: 50 }), prod('غيره', { main: 9 })];
    const s = strandedStock(products, 'wh');
    expect(s.map(x => x.productId)).toEqual(['كثير', 'قليل']);
  });

  it('🔴 الرصيد السالب معلَّق أيضاً — لا يُتجاهَل', () => {
    expect(strandedStock([prod('سالب', { wh: -5 })], 'wh')).toHaveLength(1);
  });

  it('الموقع الفارغ ⇒ لا شيء معلَّق', () => {
    expect(strandedStock([prod('أ', { wh: 0, main: 5 })], 'wh')).toEqual([]);
  });
});

describe('🔴 الحذف: يمنع البضاعة ويُعلن التاريخ', () => {
  it('بضاعة باقية ⇒ **منع** مع توجيه للنقل', () => {
    const v = impactVerdict({
      action: 'delete', branchName: 'المخزن', countsChecked: true, counts: counts(),
      stranded: strandedStock([prod('حليب', { wh: 30 })], 'wh'),
    });
    expect(v.blocked).toBe(true);
    expect(v.message).toMatch(/نقل بضاعة/);
    expect(v.message).toMatch(/تعطيل/);
  });

  it('🔴 بلا بضاعة لكن بتاريخ ⇒ **لا منع**، بل إعلان ما سيُيتَّم', () => {
    const v = impactVerdict({
      action: 'delete', branchName: 'فرع البصرة', stranded: [], countsChecked: true,
      counts: counts({ invoices: 340, closings: 90, employees: 2 }),
    });
    expect(v.blocked, 'منعه من تنظيم فروعه وصايةٌ لا حماية').toBe(false);
    expect(v.message, 'كان يحذف سنةً من مبيعاته دون أن يعرف كم').toMatch(/٣٤٠ فاتورة بيع/);
    expect(v.message).toMatch(/٩٠ إقفال صندوق/);
    expect(v.message).toMatch(/٢ موظف/);
    expect(v.message).toMatch(/سجلات بلا فرع/);
  });

  it('فرع نظيف ⇒ رسالة مطمئنة بلا تهويل', () => {
    const v = impactVerdict({
      action: 'delete', branchName: 'تجريبي', stranded: [], counts: counts(), countsChecked: true,
    });
    expect(v.message).toMatch(/لا سجلات مرتبطة/);
    expect(v.message).not.toMatch(/لن تُحذف/);
  });

  it('🔴 تعذّر العدّ يُقال صراحةً — الصفر الكاذب هو الخطر', () => {
    const v = impactVerdict({
      action: 'delete', branchName: 'فرع', stranded: [], counts: counts(), countsChecked: false,
    });
    expect(v.message, 'ادّعاء الخلوّ بلا فحص أسوأ من الاعتراف بالجهل').toMatch(/تعذّر فحص/);
    expect(v.message).not.toMatch(/لا سجلات مرتبطة/);
  });
});

describe('🔴 التحويل إلى مخزن يُعلن آثاره الثلاثة', () => {
  const v = impactVerdict({
    action: 'toWarehouse', branchName: 'فرع الكرادة', stranded: [], countsChecked: true,
    counts: counts({ invoices: 120, closings: 40 }),
  });

  it('لا يُمنع — لكنه يشرح ما سيخرج منه', () => {
    expect(v.blocked).toBe(false);
    expect(v.message).toMatch(/تقفيل الصندوق/);
    expect(v.message).toMatch(/أداء الفروع/);
    expect(v.message).toMatch(/الموظفين/);
  });

  it('يطمئن أن البيانات تبقى والتحويل قابل للعكس', () => {
    expect(v.message).toMatch(/تبقى محفوظة/);
    expect(v.message).toMatch(/إعادته محلاً/);
  });
});

describe('🟠 التعطيل يُعلن أنه يُخفي الفرع، ويدلّ على إفراغه', () => {
  it('يذكر المبدّل وإسناد الموظفين', () => {
    const v = impactVerdict({
      action: 'disable', branchName: 'مخزن ٢', stranded: [], counts: counts(), countsChecked: true,
    });
    expect(v.message).toMatch(/مبدّل الفروع/);
    expect(v.blocked).toBe(false);
  });

  it('🔴 فيه بضاعة ⇒ يدلّ صراحةً على أن النقل **منه** يبقى ممكناً', () => {
    const v = impactVerdict({
      action: 'disable', branchName: 'مخزن ٢', counts: counts(), countsChecked: true,
      stranded: strandedStock([prod('أ', { wh: 5 }), prod('ب', { wh: 3 })], 'wh'),
    });
    expect(v.message, 'الشاشة تنصح بالتعطيل بدل الحذف، وكان التعطيل يسدّ باب الإفراغ').toMatch(/النقل \*\*منه\*\*/);
    expect(v.message).toMatch(/٢ مادة/);
  });
});

describe('وصف السجلات المرتبطة', () => {
  it('يذكر الموجود ويسكت عن الصفر', () => {
    const s = linkedSummary(counts({ invoices: 5, employees: 1 }));
    expect(s).toBe('٥ فاتورة بيع · ١ موظف');
  });

  it('المجموع يشمل الأنواع الخمسة', () => {
    expect(totalLinked(counts({ invoices: 1, transactions: 2, closings: 3, employees: 4, transfers: 5 }))).toBe(15);
  });

  it('لا شيء ⇒ نصّ فارغ', () => {
    expect(linkedSummary(counts())).toBe('');
  });
});

describe('🟠 الاسم المكرَّر', () => {
  const list = [{ id: 'a', name: 'مخزن الطابق الثاني' }, { id: 'b', name: 'المحل' }];

  it('يكشف التكرار رغم المسافات وحالة الأحرف', () => {
    expect(findDuplicateBranch(list, '  مخزن   الطابق الثاني ')?.id).toBe('a');
  });

  it('الموقع ليس تكراراً لنفسه عند التعديل', () => {
    expect(findDuplicateBranch(list, 'مخزن الطابق الثاني', 'a')).toBeNull();
  });

  it('اسم جديد ⇒ لا تكرار', () => {
    expect(findDuplicateBranch(list, 'فرع البصرة')).toBeNull();
  });

  it('الفارغ لا يطابق شيئاً', () => {
    expect(findDuplicateBranch(list, '   ')).toBeNull();
    expect(branchNameKey('  ')).toBe('');
  });
});

/**
 * 🔴 حارس: الأفعال الثلاثة تمرّ من المسار الواحد، والعدّ لا يُنزّل الوثائق.
 */
describe('حارس: شاشة الفروع', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');

  const bv = read('src/components/BranchesView.tsx');
  const st = read('src/components/StockTransfersView.tsx');

  it('المسح يرى الملفات فعلاً', () => {
    expect(bv).toContain('handleDelete');
    expect(st).toContain('StockTransfer');
  });

  it('🔴 الأفعال الثلاثة من `impactVerdict`', () => {
    expect(/confirmWithImpact\('delete'/.test(bv)).toBe(true);
    expect(/confirmWithImpact\('disable'/.test(bv)).toBe(true);
    expect(/confirmWithImpact\('toWarehouse'/.test(bv)).toBe(true);
  });

  it('🔴 العدّ بالتجميع لا بتنزيل الفواتير', () => {
    expect(
      /getCountFromServer\(/.test(bv),
      'تنزيل سنةٍ من الفواتير لعرض رقمٍ واحد',
    ).toBe(true);
    // ويعدّ المجموعات الخمس فعلاً — لا يكتفي بواحدة ويدّعي الشمول
    for (const c of ['invoices', 'financial_transactions', 'cash_closings', 'employees', 'stock_transfers']) {
      expect(bv.includes(`'${c}'`), `لا يُعدّ ${c}`).toBe(true);
    }
  });

  it('🔴 لا مسار يتخطّى العدّ ويدّعي الخلوّ', () => {
    // طفرةٌ واقعية: `return { counts: EMPTY_COUNTS, checked: true }` مبكراً تُظهر «لا سجلات»
    // لفرعٍ فيه سنةُ عمل. الادّعاء الكاذب أخطر من الاعتراف بالجهل.
    expect(
      /return \{ counts: EMPTY_COUNTS, checked: true \}/.test(bv),
      'مسارٌ يُرجع خلوّاً مؤكَّداً بلا فحص',
    ).toBe(false);
  });

  it('🟠 قائمة مصدر النقل ليست `activeBranches`', () => {
    expect(
      /\{activeBranches\.map\(b => \(/.test(st),
      'قائمة المصدر عادت للفعّالة وحدها ⟵ بضاعة الفرع المعطَّل محبوسة',
    ).toBe(false);
  });

  it('🟠 التعطيل يكتب الحقل وحده لا الوثيقة كاملة', () => {
    expect(
      /saveBranch\(\{\s*\.\.\.b,\s*active/.test(bv),
      'استبدال من لقطة محلية: جهازٌ يعطّل وآخر يعيد التسمية ⟵ التسمية تُمحى',
    ).toBe(false);
    expect(/updateDoc\(/.test(bv)).toBe(true);
  });

  it('🟠 الاسم المكرَّر يُفحص قبل الحفظ', () => {
    expect(/findDuplicateBranch\(/.test(bv)).toBe(true);
  });

  it('🟠 النقل من فرع معطَّل ما زال ممكناً', () => {
    expect(
      /sourceBranches/.test(st),
      'التعطيل كان يُخفي الفرع من قائمة المصدر فيحبس بضاعته — والشاشة تنصح به بدل الحذف',
    ).toBe(true);
  });
});
