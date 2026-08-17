import { describe, it, expect } from 'vitest';
import { parseCustomerRows } from '../bulkImport';
import { csvNumber } from '../csv';
import { Customer } from '../../types';

/**
 * الاستيراد الجماعي — حيث يدخل ٥٠٠ زبون دفعةً واحدة.
 *
 * 🔴 العلّة التي وُلد منها هذا الملف: مفتاح مطابقة الهاتف كان `phone.replace(/\D/g,'')`،
 * و`\D` تعني «كل ما ليس رقماً **لاتينياً**». والبرنامج يخزّن الهواتف بأرقام عربية، فكان
 * «٠٧٧١٢٣٤٥٦٧٨» يصير مفتاحاً فارغاً — فيتكدّس كل الزبائن على مفتاح واحد ولا يبقى منهم
 * إلا الأخير، ثم يُطابَق أي صف بهاتف عربي مع ذلك الزبون العشوائي فيُصنَّف «تحديث»
 * وتُكتب بيانات صفٍّ غريب فوق سجل زبون لا علاقة له به.
 */

const cust = (id: string, name: string, phone: string, balance = 0): Customer => ({
  id, name, phone, address: '', notes: '', balance, dueDate: '', createdAt: '2026-01-01',
});

const row = (name: string, phone = '', extra: Record<string, string> = {}) => ({
  'اسم الزبون': name, 'الهاتف': phone, 'العنوان': '', 'الرصيد (دين عليه)': '',
  'تاريخ الاستحقاق': '', 'ملاحظات': '', ...extra,
});

describe('🔴 مطابقة الهاتف — لا يُكتب فوق زبون خاطئ', () => {
  const existing = [
    cust('c1', 'محمد الأمير', '٠٧٧٠١٢٣٤٥٦٧', 50000),
    cust('c2', 'علي محمد', '٠٧٧٢٣١٣٤٣٥٩', 20000),
    cust('c3', 'حسن كريم', '٠٧٨٠٠٠٠٠٠٠٠', 0),
  ];

  it('هاتف عربي يطابق صاحبه هو لا آخر زبون في القائمة', () => {
    const out = parseCustomerRows([row('محمد الأمير', '٠٧٧٠١٢٣٤٥٦٧')], existing);
    expect(out[0].action).toBe('update');
    expect(out[0].existingId, 'طابق زبوناً آخر — بياناته ستُكتب فوقه').toBe('c1');
  });

  it('🔴 هاتف عربي لزبون غير موجود يُنشئ سجلاً جديداً — لا يُحدّث غريباً', () => {
    const out = parseCustomerRows([row('زبون جديد تماماً', '٠٧٧٩٩٩٩٩٩٩٩')], existing);
    expect(out[0].action, 'صُنّف تحديثاً ⇒ سيُكتب فوق سجل زبون بريء').toBe('create');
    expect(out[0].existingId).toBeUndefined();
  });

  it('كل زبون له مفتاحه — ثلاثة هواتف عربية تطابق ثلاثة سجلات مختلفة', () => {
    const out = parseCustomerRows([
      row('محمد الأمير', '٠٧٧٠١٢٣٤٥٦٧'),
      row('علي محمد', '٠٧٧٢٣١٣٤٣٥٩'),
      row('حسن كريم', '٠٧٨٠٠٠٠٠٠٠٠'),
    ], existing);
    expect(out.map(r => r.existingId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('الكتابتان تجدان الزبون نفسه — ملف لاتيني وسجل عربي', () => {
    const out = parseCustomerRows([row('اسم مختلف', '07701234567')], existing);
    expect(out[0].existingId, 'الملف اللاتيني لم يجد السجل العربي').toBe('c1');
  });

  it('والعكس — ملف عربي وسجل لاتيني', () => {
    const latin = [cust('c9', 'سعد', '07709998887')];
    const out = parseCustomerRows([row('سعد', '٠٧٧٠٩٩٩٨٨٨٧')], latin);
    expect(out[0].existingId).toBe('c9');
  });

  it('الفواصل والمسافات في الهاتف لا تمنع المطابقة', () => {
    const out = parseCustomerRows([row('محمد الأمير', '0770-123 4567')], existing);
    expect(out[0].existingId).toBe('c1');
  });

  it('بلا هاتف: المطابقة بالاسم كما كانت', () => {
    const out = parseCustomerRows([row('علي محمد')], existing);
    expect(out[0].existingId).toBe('c2');
  });

  it('التكرار داخل الملف يُكشف رغم اختلاف كتابة الأرقام', () => {
    const out = parseCustomerRows([
      row('محمد الأمير', '٠٧٧٠١٢٣٤٥٦٧'),
      row('محمد الأمير', '07701234567'),
    ], existing);
    expect(out[1].action).toBe('error');
    expect(out[1].errors?.join()).toContain('مكرر');
  });
});

describe('🔴 الرصيد لا يُمسّ عند التحديث', () => {
  const existing = [cust('c1', 'محمد الأمير', '٠٧٧٠١٢٣٤٥٦٧', 50000)];

  it('صف يحمل رصيداً مختلفاً لا يمحو الدَّين القائم', () => {
    const out = parseCustomerRows(
      [row('محمد الأمير', '٠٧٧٠١٢٣٤٥٦٧', { 'الرصيد (دين عليه)': '0' })], existing);
    expect(out[0].data?.balance, 'الاستيراد محا ديناً قائماً').toBe(50000);
  });

  it('الزبون الجديد يأخذ الرصيد المكتوب في الملف', () => {
    const out = parseCustomerRows(
      [row('زبون جديد', '٠٧٧٥٥٥٥٥٥٥٥', { 'الرصيد (دين عليه)': '٣٠٠٠٠' })], existing);
    expect(out[0].data?.balance).toBe(30000);
  });

  it('الرصيد السالب يُرفض بسبب واضح', () => {
    const out = parseCustomerRows(
      [row('زبون جديد', '', { 'الرصيد (دين عليه)': '-500' })], []);
    expect(out[0].action).toBe('error');
    expect(out[0].errors?.join()).toContain('سالب');
  });

  it('الاسم الفارغ يُرفض', () => {
    expect(parseCustomerRows([row('')], [])[0].action).toBe('error');
  });
});

describe('csvNumber — أرقام ملفات إكسل العربية', () => {
  it('العربية والفارسية واللاتينية', () => {
    expect(csvNumber('٥٠٠٠٠')).toBe(50000);
    expect(csvNumber('۵۰۰۰۰'), 'الفارسية تصل من الهواتف وواتساب').toBe(50000);
    expect(csvNumber('50000')).toBe(50000);
  });

  it('الفواصل الألفية بالكتابتين', () => {
    expect(csvNumber('50,000')).toBe(50000);
    expect(csvNumber('٥٠،٠٠٠')).toBe(50000);
  });

  it('الفراغ يُرجع null لا صفراً', () => {
    expect(csvNumber('')).toBeNull();
    expect(csvNumber('   ')).toBeNull();
    expect(csvNumber(undefined)).toBeNull();
  });

  it('النص غير الرقمي يُرجع null', () => {
    expect(csvNumber('خمسون ألف')).toBeNull();
  });

  it('الصفر المكتوب صراحةً رقم لا فراغ', () => {
    expect(csvNumber('٠')).toBe(0);
  });
});
