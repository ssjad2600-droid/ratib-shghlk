import { describe, it, expect, beforeEach } from 'vitest';
import { sanitize, buildReport, createFloodGate, __resetReporter } from '../errorReporter';

/**
 * تقارير الأخطاء تُرسَل من أجهزة زبائنك إلى مجموعة تقرؤها أنت.
 * لذلك خطّان أحمران يُختبران هنا:
 *  ١. **لا يتسرّب أي بيان تجاري أو شخصي** مهما كان نص الخطأ.
 *  ٢. **لا يتحوّل المبلِّغ نفسه إلى مشكلة** (ألف وثيقة من حلقة رندر).
 */

beforeEach(() => __resetReporter());

describe('تنقية النص قبل الإرسال', () => {
  it('يمسح البريد الإلكتروني', () => {
    expect(sanitize('فشل لحساب ahmed.ali@gmail.com')).toBe('فشل لحساب [بريد]');
  });

  // 🔴 اسم مستخدم ويندوز يظهر داخل مسارات آثار التنفيذ. والصيغة ذات الشرطة **الأمامية**
  // هي الشائعة فعلياً (Electron والمتصفح: file:///C:/Users/…) وكانت تتسرّب — هذه تحرسها.
  it.each([
    ['ويندوز شرطة خلفية', 'at fn (C:\\Users\\husam\\app\\main.js:12:5)'],
    ['Electron شرطة أمامية', 'at fn (file:///C:/Users/husam/AppData/app.js:9:1)'],
    ['شرطة أمامية بلا file', 'at fn (C:/Users/husam/dist/index.js:3:1)'],
    ['لينكس', 'at fn (/home/husam/app/main.js:2:1)'],
    ['ماك', 'at fn (/Users/husam/app/main.js:2:1)'],
  ])('يمسح المسار ولا يسرّب اسم المستخدم — %s', (_label, input) => {
    const out = sanitize(input);
    expect(out).toContain('[مسار]');
    expect(out).not.toContain('husam');
  });

  it('يمسح الأرقام الطويلة (هواتف، مبالغ، معرّفات)', () => {
    expect(sanitize('الزبون 07701234567 عليه 2500000')).toBe('الزبون [رقم] عليه [رقم]');
  });

  it('يُبقي الأرقام القصيرة — لا تكشف شيئاً وتفيد في التشخيص', () => {
    expect(sanitize('السطر 42 العمود 7')).toBe('السطر 42 العمود 7');
  });

  // 🔴 لا يكفي أن يمسح المنقّي؛ يجب ألّا **يُفرط**. نمط بلا حدّ كلمة كان يطابق `p:/`
  // داخل `http://` فيمسخ عناوين الوحدات ويُتلف معلومة الملف والسطر — أي يقتل فائدة التقرير.
  it('لا يمسخ عناوين http — معلومة الملف والسطر هي جوهر التشخيص', () => {
    const url = 'at GeneralDashboard (http://localhost:3000/src/components/GeneralDashboard.tsx:27:9)';
    const out = sanitize(url);
    expect(out).not.toContain('[مسار]');
    expect(out).toContain('GeneralDashboard.tsx');
  });

  it('يمسح المسار المحلي ويُبقي عنوان الوحدة في نفس السطر', () => {
    const mixed = 'at fn (file:///C:/Users/husam/app.js) via http://localhost:3000/src/x.ts:3:1';
    const out = sanitize(mixed);
    expect(out).not.toContain('husam');
    expect(out).toContain('x.ts');
  });

  it('نص عربي عادي يمرّ كما هو', () => {
    expect(sanitize('تعذّر حفظ الفاتورة')).toBe('تعذّر حفظ الفاتورة');
  });
});

describe('بناء التقرير', () => {
  it('يحمل الحقول المسموحة حصراً — تطابق قاعدة Firestore', () => {
    const r = buildReport(new Error('boom'), 'invoices', 'render', 'uid1', 1000);
    expect(Object.keys(r).sort()).toEqual(
      ['appVersion', 'createdAt', 'id', 'message', 'online', 'screen', 'source', 'stack', 'uid', 'userAgent'].sort(),
    );
  });

  it('يُنقّي الرسالة والأثر معاً لا الرسالة وحدها', () => {
    const err = new Error('فشل عند ali@x.com');
    err.stack = 'Error: فشل\n    at C:\\Users\\husam\\x.js';
    const r = buildReport(err, 'products', 'render', 'uid1');
    expect(r.message).not.toContain('@x.com');
    expect(r.stack).not.toContain('husam');
  });

  it('يقصّ النصوص الطويلة ضمن حدود القاعدة (٤٠٠ و ١٢٠٠)', () => {
    const err = new Error('ء'.repeat(5000));
    err.stack = 'x'.repeat(9000);
    const r = buildReport(err, 's', 'render', 'uid1');
    expect(r.message.length).toBeLessThanOrEqual(400);
    expect(r.stack.length).toBeLessThanOrEqual(1200);
  });

  it('يتعامل مع ما ليس Error أصلاً (نص، كائن، null)', () => {
    expect(buildReport('انهيار نصّي', 's', 'window', 'u').message).toBe('انهيار نصّي');
    expect(buildReport(null, 's', 'promise', 'u').message).toBeTruthy();
  });

  it('ينسب التقرير لصاحبه — شرط قبول القاعدة', () => {
    expect(buildReport(new Error('x'), 's', 'render', 'uid-42').uid).toBe('uid-42');
  });
});

describe('ضوابط منع الإغراق', () => {
  it('🔴 نفس الخطأ لا يُرسَل مرتين — حلقة رندر تُنتج تقريراً واحداً لا ألفاً', () => {
    const g = createFloodGate(5);
    expect(g.allow('نفس-التوقيع')).toBe(true);
    for (let i = 0; i < 1000; i++) expect(g.allow('نفس-التوقيع')).toBe(false);
    expect(g.sent).toBe(1);
  });

  it('السقف خمسة للجلسة حتى لو اختلفت التواقيع', () => {
    const g = createFloodGate(5);
    const allowed = Array.from({ length: 20 }, (_, i) => g.allow(`sig-${i}`)).filter(Boolean);
    expect(allowed).toHaveLength(5);
    expect(g.sent).toBe(5);
  });

  it('الفحص والتسجيل في نداء واحد — لا فجوة يتسلّل منها تكرار', () => {
    const g = createFloodGate(3);
    expect(g.allow('a')).toBe(true);
    expect(g.allow('a')).toBe(false); // سُجّل فور السماح
  });

  it('إعادة الضبط تعيد السماح — لجلسة جديدة', () => {
    const g = createFloodGate(1);
    expect(g.allow('x')).toBe(true);
    expect(g.allow('y')).toBe(false);
    g.reset();
    expect(g.allow('y')).toBe(true);
    __resetReporter(); // بوابة الوحدة نفسها تُصفَّر أيضاً
  });
});
