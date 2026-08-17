import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataUrlBytes, fitsInDocument, scaledSize,
  MAX_IMAGE_DATA_BYTES, MAX_LOGO_DATA_BYTES, LOGO_MAX_EDGE, IMAGE_MAX_EDGE,
} from '../productImage';
import { parseAmount, isValidExchangeRate } from '../arabicFormatters';

/**
 * شاشة الإعدادات — سليمة النيّة، متأخّرة عن إصلاحات إخوتها.
 *
 * كل علّة فيها لها نظيرٌ عولج في شاشة أخرى وبقيت هي: ضغط الصور (المنتجات)، قراءة
 * الأرقام العربية (فواتير الشراء)، حارس الاتصال قبل المعاملة (الجرد الفعلي)، والإبلاغ
 * بالعدد والنقص (النسخ الاحتياطي).
 */

describe('🔴 حدود الشعار تحت سقف Firestore', () => {
  const FIRESTORE_DOC_LIMIT = 1024 * 1024;

  it('الحدّ القديم (٢٫٥ ميغا) كان يتجاوز السقف بعد Base64 — هذا أصل العلّة', () => {
    const oldLimitRaw = 2.5 * 1024 * 1024;
    const afterBase64 = oldLimitRaw * 4 / 3;
    expect(afterBase64, 'كان يمرّ من الفحص ثم تفشل الكتابة').toBeGreaterThan(FIRESTORE_DOC_LIMIT);
  });

  it('🔴 حدّ الشعار الجديد يبقى تحت السقف بهامش واسع', () => {
    expect(MAX_LOGO_DATA_BYTES).toBeLessThan(FIRESTORE_DOC_LIMIT);
    // الوثيقة تحمل حقولاً أخرى (اسم، عنوان، هاتف…) فالهامش مقصود
    expect(MAX_LOGO_DATA_BYTES * 4).toBeLessThan(FIRESTORE_DOC_LIMIT);
  });

  it('الشعار أصغر من صورة المنتج — ترويسة لا بطاقة', () => {
    expect(MAX_LOGO_DATA_BYTES).toBeLessThan(MAX_IMAGE_DATA_BYTES);
    expect(LOGO_MAX_EDGE).toBeLessThan(IMAGE_MAX_EDGE);
  });

  it('الفحص يحترم الحدّ المُمرَّر لا الافتراضي وحده', () => {
    const payload = 'a'.repeat(Math.ceil((150 * 1024) * 4 / 3));
    const url = `data:image/jpeg;base64,${payload}`;
    expect(fitsInDocument(url, MAX_IMAGE_DATA_BYTES), '١٥٠ك تحت حدّ المنتج').toBe(true);
    expect(fitsInDocument(url, MAX_LOGO_DATA_BYTES), '١٥٠ك فوق حدّ الشعار').toBe(false);
  });

  it('حساب حجم Base64 دقيق', () => {
    expect(dataUrlBytes('data:image/png;base64,QUJD')).toBe(3);      // "ABC"
    expect(dataUrlBytes('data:image/png;base64,QUJDRA==')).toBe(4);  // "ABCD"
    expect(dataUrlBytes('نصّ بلا فاصلة')).toBe(0);
  });

  it('التصغير يحترم الضلع المُمرَّر ولا يُكبّر الصغير', () => {
    expect(scaledSize(1200, 600, LOGO_MAX_EDGE)).toEqual({ w: 300, h: 150 });
    expect(scaledSize(1200, 600, IMAGE_MAX_EDGE)).toEqual({ w: 400, h: 200 });
    expect(scaledSize(100, 80, LOGO_MAX_EDGE), 'لا تكبير').toEqual({ w: 100, h: 80 });
  });
});

describe('🔴 قراءة سعر الصرف', () => {
  it('`Number` تكسر الأرقام العربية وتفريغ الحقل — هذا ما كان', () => {
    expect(Number('١٥٠٠')).toBeNaN();
    expect(Number(''), 'المسح كان يعطي صفراً فلا يستطيع إعادة الكتابة').toBe(0);
  });

  it('🔴 `parseAmount` تقرأ العربية والفارسية واللاتينية', () => {
    expect(parseAmount('١٥٠٠')).toBe(1500);
    expect(parseAmount('۱۵۰۰')).toBe(1500);
    expect(parseAmount('1,500')).toBe(1500);
  });

  it('الفراغ يُرفض بوضوح بدل أن يصير صفراً', () => {
    expect(isValidExchangeRate(parseAmount(''))).toBe(false);
    expect(isValidExchangeRate(parseAmount('١٥٠٠'))).toBe(true);
  });

  it('القيمة خارج المدى تُرفض — تكسر كل تحويلات الدولار', () => {
    expect(isValidExchangeRate(0)).toBe(false);
    expect(isValidExchangeRate(-100)).toBe(false);
    expect(isValidExchangeRate(NaN)).toBe(false);
  });
});

/**
 * 🔴 حارس: الشاشة لحقت بإصلاحات إخوتها.
 */
describe('حارس: شاشة الإعدادات', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'SettingsView.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import .*$/gm, '');

  it('المسح يرى الملف فعلاً', () => {
    expect(src).toContain('saveGeneralSettings');
    expect(src).toContain('handleActivateLicense');
  });

  it('🔴 الشعار يُضغط ولا يُخزَّن خاماً', () => {
    expect(/compressLogo\(/.test(src)).toBe(true);
    expect(
      /file\.size > 2\.5 \* 1024 \* 1024/.test(src),
      'حدٌّ ثلاثة أضعاف سقف Firestore ⟵ يمرّ من الفحص وتفشل الكتابة',
    ).toBe(false);
    expect(/reader\.readAsDataURL\(file\)/.test(src), 'عادت القراءة الخام بلا ضغط').toBe(false);
  });

  it('🔴 الشعار لا يُكتب قبل الحفظ', () => {
    expect(
      /updateUser\(\{ logoUrl: reader\.result \}\)/.test(src),
      'كان يُحفظ فور الاختيار فيبقى ولو غادر التاجر بلا حفظ',
    ).toBe(false);
  });

  it('🔴 سعر الصرف نصّ خام يُقرأ بـ`parseAmount`', () => {
    expect(
      /setRate\(Number\(e\.target\.value\)\)/.test(src),
      '`Number` تُنتج NaN للعربية وصفراً للفراغ',
    ).toBe(false);
    expect(/setRate\(e\.target\.value\)/.test(src)).toBe(true);
    expect(/exchangeRate: parseAmount\(rate\)/.test(src)).toBe(true);
  });

  it('🔴 التفعيل يشترط قراءة من الخادم قبل المعاملة', () => {
    expect(
      /getDocFromServer\(codeRef\)/.test(src),
      'runTransaction تُكمل من الكاش (مقيسة) فيظهر «تم التفعيل مدى الحياة» ثم يرفضه الخادم',
    ).toBe(true);
    expect(/message === 'offline'/.test(src), 'حالة انعدام الاتصال بلا رسالة خاصة').toBe(true);
  });

  it('🟡 النسخة الفورية تذكر العدد والنقص المحتمل', () => {
    expect(/payload\.totalDocs/.test(src)).toBe(true);
    expect(/payload\.fromCache/.test(src)).toBe(true);
  });

  it('🟡 هاتف المحل يُفحص — يظهر على الفواتير المطبوعة', () => {
    expect(/toWhatsappNumber\(phone\)/.test(src)).toBe(true);
  });

  it('🟠 تناقض سلوك الحفظ مُعلَن للمستخدم', () => {
    expect(
      /parseAmount\(rate\) !== settings\.exchangeRate/.test(src),
      'العملة تُطبَّق فوراً والسعر ينتظر الحفظ — والتاجر لا يُخبَر',
    ).toBe(true);
  });
});
