import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataUrlBytes, fitsInDocument, scaledSize,
  MAX_IMAGE_DATA_BYTES, IMAGE_MAX_EDGE,
} from '../productImage';

/**
 * صورة المنتج.
 *
 * 🔴 العلّة: كانت تُقبل حتى ٢ ميغابايت وتُخزَّن Base64 **داخل وثيقة المنتج**. وحدّ
 * Firestore للوثيقة ١ ميبي بايت، وBase64 يُضخّم ٣٣٪ — فأي صورة من كاميرا هاتف حديث
 * تجعل الكتابة تفشل. والفشل صامت (`fire-and-forget` بلا رسالة)، فيرى التاجر
 * «تم حفظ المنتج بنجاح» ولا يُحفظ شيء.
 *
 * الرسم على canvas يلزمه متصفح، فيُختبر هنا **القرار** لا الرسم: كم يزن الناتج، وهل
 * يُقبل، وكم يصير المقاس.
 */

/** يبني data URL بحمولة بالحجم المطلوب تقريباً. */
const fakeDataUrl = (payloadChars: number) =>
  `data:image/jpeg;base64,${'A'.repeat(payloadChars)}`;

describe('حساب حجم الصورة المُرمَّزة', () => {
  it('يقيس الحمولة لا طول النصّ', () => {
    // ٤ محارف Base64 = ٣ بايت
    expect(dataUrlBytes(fakeDataUrl(4))).toBe(3);
    expect(dataUrlBytes(fakeDataUrl(400))).toBe(300);
  });

  it('يحسب الحشو (=) صحيحاً', () => {
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('data:image/png;base64,AAA=')).toBe(2);
    expect(dataUrlBytes('data:image/png;base64,AA==')).toBe(1);
  });

  it('نصّ بلا فاصلة يُرجع صفراً بدل أن يكسر', () => {
    expect(dataUrlBytes('ليس داتا يو آر إل')).toBe(0);
    expect(dataUrlBytes('')).toBe(0);
  });
});

describe('🔴 حدّ ما يُقبل داخل الوثيقة', () => {
  it('الحدّ أقلّ بكثير من حدّ Firestore (١ ميبي) — الوثيقة تحمل حقولاً أخرى', () => {
    expect(MAX_IMAGE_DATA_BYTES).toBeLessThan(1024 * 1024);
    expect(MAX_IMAGE_DATA_BYTES).toBeGreaterThan(50 * 1024); // ويكفي لصورة واضحة
  });

  it('صورة صغيرة تُقبل', () => {
    expect(fitsInDocument(fakeDataUrl(40 * 1024))).toBe(true);
  });

  it('🔴 صورة كاميرا هاتف (٢ ميغا) تُرفض — وكانت تُقبل فتُفشل الحفظ', () => {
    const twoMegaBase64 = Math.ceil((2 * 1024 * 1024 * 4) / 3);
    expect(fitsInDocument(fakeDataUrl(twoMegaBase64))).toBe(false);
  });

  it('عند الحدّ بالضبط يُقبل، وفوقه بقليل يُرفض', () => {
    const atLimit = Math.floor((MAX_IMAGE_DATA_BYTES * 4) / 3);
    expect(fitsInDocument(fakeDataUrl(atLimit))).toBe(true);
    expect(fitsInDocument(fakeDataUrl(atLimit + 4000))).toBe(false);
  });
});

describe('التصغير مع حفظ النسبة', () => {
  it('يصغّر أطول ضلع إلى الحدّ', () => {
    expect(scaledSize(2000, 1000)).toEqual({ w: IMAGE_MAX_EDGE, h: IMAGE_MAX_EDGE / 2 });
    expect(scaledSize(1000, 2000)).toEqual({ w: IMAGE_MAX_EDGE / 2, h: IMAGE_MAX_EDGE });
  });

  it('🔴 لا يُكبّر صورة أصغر من الحدّ', () => {
    expect(scaledSize(120, 80)).toEqual({ w: 120, h: 80 });
  });

  it('المربّعة تبقى مربّعة', () => {
    const s = scaledSize(3000, 3000);
    expect(s.w).toBe(s.h);
    expect(s.w).toBe(IMAGE_MAX_EDGE);
  });

  it('النسبة محفوظة في كل الحالات', () => {
    for (const [w, h] of [[4032, 3024], [1920, 1080], [800, 1200], [5000, 300]] as const) {
      const s = scaledSize(w, h);
      expect(Math.abs(s.w / s.h - w / h)).toBeLessThan(0.02);
      expect(Math.max(s.w, s.h)).toBeLessThanOrEqual(IMAGE_MAX_EDGE);
    }
  });

  it('الأبعاد الصفرية لا تكسر الحساب', () => {
    expect(scaledSize(0, 0)).toEqual({ w: 0, h: 0 });
  });

  it('الضلع الناتج لا ينزل تحت واحد', () => {
    const s = scaledSize(10000, 3);
    expect(s.h).toBeGreaterThanOrEqual(1);
  });
});

/**
 * 🔴 حارس: الصورة لا تُخزَّن خاماً، والحفظ لا يفشل صامتاً.
 */
describe('حارس: صور المنتجات مُلغاة', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'ProductsView.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('المسح يرى الملف', () => {
    expect(src.length).toBeGreaterThan(50000);
  });

  /**
   * 🔴 انقلب هذا الحارس: كان يشترط **ضغط** صورة المنتج، وصار يشترط **غيابها**.
   *
   * أُلغيت صور المنتجات بقرارٍ من المالك؛ والقائمة ولوحة التفاصيل تعرضان رمز
   * التصنيف الذي كان أصلاً بديلاً جاهزاً للمنتجات بلا صور.
   *
   * ولماذا يبقى حارساً بدل أن يُحذف؟ لأن عودة الميزة سهلةٌ بلا انتباه — سطرُ
   * `<input type="file">` واحد يُعيد تخزين Base64 داخل وثيقة المنتج، وهو
   * بالضبط ما كان يُفشل الحفظ صامتاً قبل أن يُضغط. فليكن الرجوع قراراً واعياً.
   */
  it('🔴 رفع صور المنتجات مُلغى — ولا يعود بلا قرار', () => {
    expect(/compressProductImage/.test(src), 'عاد ضغط صور المنتجات').toBe(false);
    expect(/type="file"/.test(src), 'خانة رفع ملف في شاشة المنتجات').toBe(false);
    expect(/formImageUrl/.test(src), 'عادت حالة صورة النموذج').toBe(false);
    expect(
      /reader\.readAsDataURL/.test(src),
      'قراءة خام للملف داخل الشاشة ⇒ تخزين بلا ضغط',
    ).toBe(false);
  });

  it('🧹 والصورة الموروثة تُجرَّد عند كل تعديل', () => {
    // غير مشروط: `formImageUrl ? ... : deleteField()` كان يُبقيها لو بقيت الحالة
    expect(/imageUrl: deleteField\(\)/.test(src)).toBe(true);
  });

  it('🔴 فشل حفظ المنتج يُعلَن للتاجر لا للكونسول وحده', () => {
    const silent = /save product:', err\)\);/.test(src);
    expect(silent, 'catch يطبع في الكونسول فقط ⇒ التاجر يرى «تم الحفظ» ولا يُحفظ شيء').toBe(false);
    expect(/لم يُحفَظ/.test(src), 'لا رسالة فشل للتاجر').toBe(true);
  });
});
