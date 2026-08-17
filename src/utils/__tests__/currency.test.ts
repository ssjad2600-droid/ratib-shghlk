import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatCurrency, INVALID_AMOUNT, toArabicDigits,
  EXCHANGE_RATE_MIN, EXCHANGE_RATE_MAX,
} from '../arabicFormatters';

/**
 * عرض المبالغ — أخطر دالة في البرنامج لأنها الأكثر استدعاءً (١٩٣ موضعاً في ٢١ ملفاً).
 *
 * 🔴 العلّة التي وُلد منها هذا الملف: فرع الدولار **لم يكن يقسم على سعر الصرف إطلاقاً**.
 * كان يستقبل `exchangeRate` ولا يمسّه، فيضع علامة $ على مبلغ الدينار كما هو:
 * ٥٥٠٬٠٠٠ د.ع تُعرَض «$٥٥٠٬٠٠٠.٠٠» بدل «$٣٦٦.٦٧».
 *
 * ونجت العلّة سنةً كاملة لسببين: TypeScript لا يشتكي من وسيطٍ غير مستعمل، ولم يكن ثمّة
 * اختبارٌ واحد يمسّ فرع الدولار. ولهذا الاختبار الجوهري هنا **خاصيّة** لا مثال:
 * تغيير سعر الصرف يجب أن يغيّر الناتج — وهي بالضبط ما كان مكسوراً.
 */

describe('🔴 الدولار يُحوَّل فعلاً', () => {
  it('يقسم على سعر الصرف', () => {
    expect(formatCurrency(1500, 'USD', 1500)).toBe('$١.٠٠');
    expect(formatCurrency(550000, 'USD', 1500)).toBe('$٣٦٦.٦٧');
  });

  it('🔴 تغيير سعر الصرف يغيّر الناتج — الخاصيّة التي كانت مكسورة', () => {
    const a = formatCurrency(3000, 'USD', 1500);
    const b = formatCurrency(3000, 'USD', 3000);
    expect(a, 'الناتج لا يتأثّر بسعر الصرف ⇒ الوسيط مُهمَل').not.toBe(b);
    expect(a).toBe('$٢.٠٠');
    expect(b).toBe('$١.٠٠');
  });

  it('🔴 الناتج بالدولار لا يساوي رقم الدينار أبداً (ما لم يكن صفراً)', () => {
    for (const amount of [1000, 55000, 550000, 12345]) {
      const usd = formatCurrency(amount, 'USD', 1500);
      const raw = toArabicDigits(amount.toLocaleString('en-US'));
      expect(usd.includes(raw), `طُبع رقم الدينار بعلامة $ عند ${amount}`).toBe(false);
    }
  });

  it('الصفر يبقى صفراً في العملتين', () => {
    expect(formatCurrency(0, 'USD', 1500)).toBe('$٠.٠٠');
    expect(formatCurrency(0, 'IQD')).toBe('٠ د.ع');
  });

  it('المبالغ السالبة (مرتجع/أمانة) تُحوَّل كذلك', () => {
    expect(formatCurrency(-3000, 'USD', 1500)).toBe('$-٢.٠٠');
  });

  it('كل أسعار الصرف الصالحة تُنتج تحويلاً صحيحاً', () => {
    for (const rate of [EXCHANGE_RATE_MIN, 1000, 1500, 1530, EXCHANGE_RATE_MAX]) {
      const out = formatCurrency(rate, 'USD', rate);
      expect(out, `سعر ${rate}`).toBe('$١.٠٠');
    }
  });
});

describe('الدينار — السلوك القديم لم يتغيّر', () => {
  it('يُقرَّب ويُفصَل بالآلاف ويُكتب بالعربية', () => {
    expect(formatCurrency(550000, 'IQD')).toBe('٥٥٠,٠٠٠ د.ع');
    expect(formatCurrency(1234.6, 'IQD')).toBe('١,٢٣٥ د.ع');
  });

  it('سعر الصرف لا يمسّ الدينار', () => {
    expect(formatCurrency(5000, 'IQD', 1500)).toBe(formatCurrency(5000, 'IQD', 3000));
  });
});

describe('🔴 القيم غير الصالحة لا تُطبع رقماً كاذباً', () => {
  it('NaN لا تُطبع «NaN د.ع» على الشاشة ولا على الورق', () => {
    expect(formatCurrency(NaN, 'IQD')).toBe(INVALID_AMOUNT);
    expect(formatCurrency(NaN, 'USD', 1500)).toBe(INVALID_AMOUNT);
  });

  it('اللانهاية كذلك', () => {
    expect(formatCurrency(Infinity, 'IQD')).toBe(INVALID_AMOUNT);
    expect(formatCurrency(-Infinity, 'USD', 1500)).toBe(INVALID_AMOUNT);
  });

  it('البديل واضح للعين ولا يُخلط برقم', () => {
    expect(INVALID_AMOUNT).not.toMatch(/[0-9٠-٩]/);
  });
});

describe('سعر صرف غير منطقي: نقول ما نعرفه لا ما نخمّنه', () => {
  it('الصفر لا يُنتج لانهاية', () => {
    const out = formatCurrency(5000, 'USD', 0);
    expect(out).not.toContain('Infinity');
    expect(out, 'نعود للدينار الذي نعرفه يقيناً').toBe('٥,٠٠٠ د.ع');
  });

  it('السالب وخارج الحدود يعودان للدينار', () => {
    for (const bad of [-1500, 1, 99999, NaN]) {
      expect(formatCurrency(5000, 'USD', bad)).toBe('٥,٠٠٠ د.ع');
    }
  });
});

/**
 * 🔴 حارس: كل منسّق سعر يحوّل عند الدولار.
 *
 * التحويل كان صحيحاً في طباعة الفواتير وخاطئاً على الشاشة وفي ملصقات الباركود —
 * ثلاثة منسّقات مستقلة، اثنان منها منسيّان. الحارس يفرض أن أي مكان يعرض `$` يعرف
 * سعر الصرف.
 */
describe('حارس: لا منسّق سعر يتجاهل سعر الصرف', () => {
  const files = [
    'src/utils/printInvoices.ts',
    'src/utils/printPurchaseList.ts',
    'src/components/BarcodeLabelsModal.tsx',
  ];

  it.each(files)('«%s» يقسم على سعر الصرف عند الدولار', (rel) => {
    const src = readFileSync(join(process.cwd(), rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src, 'يعرض الدولار').toMatch(/USD|'\$'|\$\{/);
    expect(
      /\/\s*exchangeRate/.test(src),
      'يعرض مبلغاً بالدولار بلا قسمة على سعر الصرف ⇒ رقمٌ أكبر ١٥٠٠ ضعفاً',
    ).toBe(true);
  });
});
