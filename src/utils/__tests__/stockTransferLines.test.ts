import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeTransferLines, duplicateCount, shortagesOf } from '../stockTransferLines';

/**
 * 🔴 المادة المكرَّرة في نقل واحد.
 *
 * قِسْتُ سلوك Firestore ولم أفترضه: تحديثان بـ`increment` على وثيقة واحدة داخل دفعة
 * واحدة **يتراكمان** (٥+٣ ⟵ ٨). فالمخزون لا يضيع. والضرر ضرران:
 *   ١) فحص الكفاية يقارن كل سطر وحده ⟵ ٦٠+٦٠ من رصيد ١٠٠ تمرّ بلا تحذير ⟵ رصيد سالب صامت.
 *   ٢) fromBefore/toBefore يُلتقطان من لقطة واحدة ⟵ السجل يعطي أرقاماً مستحيلة.
 *
 * وظننتُ ضرراً ثالثاً — أن المنتج القديم بلا خريطة فروع يفقد كمية، لأن `transferUpdate`
 * يُرجع له `branchStock` مطلقاً فيمحو الثاني الأول — فقِسْتُه ولم يقع:
 * `useBranchStockMigration` يُرحّل كل منتج بلا خريطة فور بدء جلسة المالك، فلا يبلغ
 * المسارَ المطلق منتجٌ في التطبيق الحيّ.
 */

describe('دمج الأسطر المكرَّرة', () => {
  it('🔴 سطران لنفس المادة يصيران سطراً واحداً بمجموعهما', () => {
    const out = mergeTransferLines([
      { productId: 'حليب', quantity: 60 },
      { productId: 'حليب', quantity: 60 },
    ]);
    expect(out).toEqual([{ productId: 'حليب', quantity: 120 }]);
  });

  it('يحفظ ترتيب أول ظهور — لا تقفز الأسطر أمام عين التاجر', () => {
    const out = mergeTransferLines([
      { productId: 'ب', quantity: 1 },
      { productId: 'أ', quantity: 2 },
      { productId: 'ب', quantity: 3 },
    ]);
    expect(out.map(l => l.productId)).toEqual(['ب', 'أ']);
    expect(out[0].quantity).toBe(4);
  });

  it('يُسقط ما لا مادة له أو كميته ليست موجبة', () => {
    const out = mergeTransferLines([
      { productId: '', quantity: 5 },
      { productId: 'أ', quantity: 0 },
      { productId: 'ب', quantity: -3 },
      { productId: 'ج', quantity: NaN },
      { productId: 'د', quantity: 2 },
    ]);
    expect(out).toEqual([{ productId: 'د', quantity: 2 }]);
  });

  it('الكمية الكسرية تُجمع كما هي (وحدات وزنية)', () => {
    const out = mergeTransferLines([
      { productId: 'لحم', quantity: 1.5 },
      { productId: 'لحم', quantity: 2.25 },
    ]);
    expect(out[0].quantity).toBeCloseTo(3.75);
  });

  it('بلا تكرار: لا يتغيّر شيء — السلوك القديم محفوظ حرفياً', () => {
    const input = [{ productId: 'أ', quantity: 3 }, { productId: 'ب', quantity: 7 }];
    expect(mergeTransferLines(input)).toEqual(input);
  });

  it('المجموع الكلّي لا يتغيّر بالدمج أبداً', () => {
    const input = [
      { productId: 'أ', quantity: 5 }, { productId: 'ب', quantity: 2 },
      { productId: 'أ', quantity: 8 }, { productId: 'أ', quantity: 1 },
    ];
    const before = input.reduce((s, l) => s + l.quantity, 0);
    const after = mergeTransferLines(input).reduce((s, l) => s + l.quantity, 0);
    expect(after).toBe(before);
  });
});

describe('عدّ المكرَّر — كي لا يجري الدمج في صمت', () => {
  it('يعدّ الأسطر الزائدة لا المواد', () => {
    expect(duplicateCount([
      { productId: 'أ', quantity: 1 },
      { productId: 'أ', quantity: 1 },
      { productId: 'أ', quantity: 1 },
    ])).toBe(2);
  });

  it('بلا تكرار ⇒ صفر، فلا رسالة تُزعج التاجر بلا سبب', () => {
    expect(duplicateCount([{ productId: 'أ', quantity: 1 }, { productId: 'ب', quantity: 1 }])).toBe(0);
  });
});

describe('🔴 فحص الكفاية على المجموع لا على السطر', () => {
  const have = (m: Record<string, number>) => (id: string) => (id in m ? m[id] : null);

  it('٦٠ + ٦٠ من رصيد ١٠٠ تُكشف — وكانت تمرّ صامتة', () => {
    const merged = mergeTransferLines([
      { productId: 'حليب', quantity: 60 },
      { productId: 'حليب', quantity: 60 },
    ]);
    const s = shortagesOf(merged, have({ حليب: 100 }));
    expect(s, 'سطران كلٌّ منهما كافٍ ومجموعهما لا ⇒ رصيد سالب بلا إنذار').toEqual([
      { productId: 'حليب', requested: 120, available: 100 },
    ]);
  });

  it('المجموع المساوي للرصيد ليس نقصاً', () => {
    expect(shortagesOf([{ productId: 'أ', quantity: 100 }], have({ أ: 100 }))).toEqual([]);
  });

  it('الرصيد السالب أصلاً يُعدّ نقصاً', () => {
    const s = shortagesOf([{ productId: 'أ', quantity: 1 }], have({ أ: -5 }));
    expect(s[0]).toEqual({ productId: 'أ', requested: 1, available: -5 });
  });

  it('المادة المجهولة ليست نقصاً بل غياباً', () => {
    expect(shortagesOf([{ productId: 'شبح', quantity: 9 }], have({ أ: 1 }))).toEqual([]);
  });
});

/**
 * 🔴 حارس: لا يُكتب النقل من الأسطر الخام.
 *
 * اختبار الوحدة يُثبت أن الدمج يعمل، ولا يُثبت أن الشاشة تستدعيه. والخطأ الواقعي هو
 * **النسيان** لا الخلل: يعود أحدهم لاحقاً فيبني `items` من `lines` مباشرة، فتعود العلّة
 * الثلاثية كاملةً والاختبارات كلها خضراء. فنفحص المصدر.
 */
describe('حارس: الشاشة تدمج قبل أن تكتب', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'StockTransfersView.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('transferUpdate');
    expect(src).toContain('StockTransferItem');
  });

  it('🔴 items تُبنى من الأسطر المدموجة', () => {
    expect(
      /const items:\s*StockTransferItem\[\]\s*=\s*merged\.map\(/.test(src),
      'items تُبنى من lines/valid مباشرة ⇒ المادة المكرَّرة تُكتب سطرين برصيدٍ سابقٍ واحد، '
      + 'وتُنقل ناقصةً للمنتج القديم بلا خريطة فروع',
    ).toBe(true);
    expect(src).toContain('mergeTransferLines(');
  });

  it('🔴 فحص النقص يجري على المدموج لا على كل سطر', () => {
    expect(
      /shortagesOf\(\s*merged/.test(src),
      'الفحص عاد يقارن كل سطر وحده بالرصيد نفسه ⇒ ٦٠+٦٠ من ١٠٠ تمرّ بلا تحذير',
    ).toBe(true);
  });

  it('🔴 رقم النقل لا يُحسب من طول القائمة المحلية', () => {
    expect(
      /transfers\.length\s*\+\s*1/.test(src),
      'الرقم يُحسب من عدد النقولات على هذا الجهاز ⇒ جهازان يُصدران TR-٧ نفسه، والحذف يُعيد الرقم',
    ).toBe(false);
    expect(src).toContain('allocateTransferNumber(');
  });
});
