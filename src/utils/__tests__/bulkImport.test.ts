import { describe, it, expect } from 'vitest';
import {
  parseCustomerRows, parseProductRows, PRODUCT_HEADERS, PRODUCT_SAMPLE_ROW,
  CUSTOMER_HEADERS, CUSTOMER_SAMPLE_ROW, BARCODE_MANGLED_ERROR, PRODUCT_GRID, CUSTOMER_GRID,
} from '../bulkImport';
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

/**
 * 🔴 فخّان في القالب — قِيسا فعلاً على الشيفرة الحيّة قبل إصلاحهما.
 *
 * ١) الصفّ النموذجي المرفق بالقالب كان يُصنَّف «جديد»، فمن يملأ صفوفه تحته ولا
 *    ينتبه لحذفه يجد في مخزنه «حليب نيدو ٩٠٠غ» بكمية ٥٠ وسعر ١٢٬٥٠٠.
 *
 * ٢) Excel يحوّل الباركود الطويل إلى `6.29101E+12`، وكان يُخزَّن **كما هو بصمت**
 *    فيخرج منتجٌ لا يجده مسدس الباركود أبداً.
 */
describe('🔴 قالب الاستيراد: الصفّ النموذجي وباركود Excel', () => {
  const H = PRODUCT_HEADERS;
  const asRow = (values: string[]): Record<string, string> =>
    Object.fromEntries(H.map((h, i) => [h, values[i] ?? '']));
  const product = (name: string, barcode: string, sell = '1000') =>
    asRow([name, barcode, '', '', '500', sell, '5']);

  it('الصفّ النموذجي لا يُستورَد — لا منتجاً ولا خطأً', () => {
    const out = parseProductRows([asRow([...PRODUCT_SAMPLE_ROW])], []);
    expect(out).toEqual([]);
  });

  it('🔴 وإسقاطه لا يُزحزح أرقام الأسطر — وإلا أشارت الأخطاء إلى السطر الخطأ', () => {
    const out = parseProductRows(
      [asRow([...PRODUCT_SAMPLE_ROW]), product('شاي', '111'), asRow(['بلا سعر', '', '', '', '500', ''])],
      [],
    );
    expect(out.map(r => r.line)).toEqual([3, 4]);
    expect(out[1].errors).toContain('سعر البيع مطلوب');
  });

  it('🔴 والمطابقة على حقلين: منتجٌ باسم النموذج وباركودٍ حقيقي يُستورَد', () => {
    const out = parseProductRows([product(PRODUCT_SAMPLE_ROW[0], '6291009999')], []);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('create');
  });

  it('🔴 باركود شوّهه Excel يُرفض برسالة تشرح العلاج', () => {
    const out = parseProductRows([product('مشوَّه', '6.29101E+12')], []);
    expect(out[0].action).toBe('error');
    expect(out[0].errors).toContain(BARCODE_MANGLED_ERROR);
    expect(BARCODE_MANGLED_ERROR).toContain('نص');
  });

  it('والكسر العشري في الباركود يُرفض كذلك', () => {
    expect(parseProductRows([product('كسر', '6291001234567.0')], [])[0].action).toBe('error');
  });

  it('⚠️ لكن كوداً داخلياً بحروف يمرّ — الرفض للتشويه لا لكل غير رقمي', () => {
    for (const code of ['A-125', 'MK-001', '6291001234567']) {
      const out = parseProductRows([product('كود ' + code, code)], []);
      expect(out[0].action, code).toBe('create');
      expect(out[0].data?.barcode).toBe(code);
    }
  });

  it('ونموذجُ الزبائن يُتخطّى مثله', () => {
    expect(parseCustomerRows([Object.fromEntries(
      CUSTOMER_HEADERS.map((h, i) => [h, CUSTOMER_SAMPLE_ROW[i] ?? '']),
    )], [])).toEqual([]);
  });
});

/**
 * 🔴 حارسٌ على الشرط الذي أُضيف بعد اصطدامٍ حقيقي.
 *
 * قيم نموذج الزبائن واقعية («محمد الأمير» و«٠٧٧٠١٢٣٤٥٦٧»)، فلولا حصرُ الفحص
 * في الصفّ الأول لابتُلع زبونٌ حقيقي بهذا الاسم والهاتف بصمت. وهذا ليس فرضاً
 * نظرياً: اختبارٌ قائم في هذا الملف نفسه استعمل القيمتين وسقط.
 */
describe('🔴 تخطّي النموذج محصورٌ في الصفّ الأول', () => {
  const custRow = (name: string, phone: string) =>
    Object.fromEntries(CUSTOMER_HEADERS.map((h, i) =>
      [h, i === 0 ? name : i === 1 ? phone : '']));

  it('زبونٌ حقيقي بنفس اسم النموذج وهاتفه يُستورَد لو لم يكن أول صفّ', () => {
    const out = parseCustomerRows([
      custRow('علي حسن', '07801112233'),
      custRow(CUSTOMER_SAMPLE_ROW[0], CUSTOMER_SAMPLE_ROW[1]),
    ], []);
    expect(out).toHaveLength(2);
    expect(out[1].label).toBe(CUSTOMER_SAMPLE_ROW[0]);
    expect(out[1].action).toBe('create');
  });

  it('وفي الصفّ الأول يُتخطّى', () => {
    const out = parseCustomerRows([
      custRow(CUSTOMER_SAMPLE_ROW[0], CUSTOMER_SAMPLE_ROW[1]),
      custRow('علي حسن', '07801112233'),
    ], []);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(3);
  });
});

/**
 * 🔴 الرابط الصامت بين الجدول والمحلّل.
 *
 * `ImportGrid` يبني كائناً مفاتيحه `col.header`، و`parseProductRows` تقرأ بـ`pick`
 * على أسماء الأعمدة. فلو كُتب في الجدول «سعر بيع» والمحلّل يقرأ «سعر البيع»،
 * لخرج الحقل **فارغاً** — لا خطأ ولا تحذير، فقط منتجاتٌ بلا أسعار. ولذلك
 * `header` مأخوذ حرفياً من ترويسة القالب، وهذا الحارس يُبقيه كذلك.
 */
describe('🔴 أعمدة الجدول الداخلي تطابق ما يقرأه المحلّل', () => {
  it('كل header في جدول المنتجات موجود في ترويسة القالب', () => {
    for (const col of PRODUCT_GRID) {
      expect(PRODUCT_HEADERS, `«${col.header}» ليس عموداً في القالب`).toContain(col.header);
    }
  });

  it('وكذلك جدول الزبائن', () => {
    for (const col of CUSTOMER_GRID) {
      expect(CUSTOMER_HEADERS, `«${col.header}» ليس عموداً في القالب`).toContain(col.header);
    }
  });

  it('🔴 والحقول المطلوبة في الجدول هي نفسها التي يشترطها المحلّل', () => {
    const required = PRODUCT_GRID.filter(c => c.required).map(c => c.header);
    expect(required).toEqual(['اسم المنتج', 'سعر البيع']);

    // نُثبتها سلوكياً لا بالادّعاء: صفٌّ بهذين وحدهما يمرّ
    const row = Object.fromEntries(PRODUCT_GRID.map(c => [c.header, '']));
    row['اسم المنتج'] = 'منتج بالحدّ الأدنى';
    row['سعر البيع'] = '5000';
    const out = parseProductRows([row], []);
    expect(out[0].action).toBe('create');
    expect(out[0].data?.sellPrice).toBe(5000);
  });

  it('وصفٌّ يُملأ عبر الجدول يُقرأ بكل حقوله', () => {
    const row = Object.fromEntries(PRODUCT_GRID.map(c => [c.header, '']));
    Object.assign(row, {
      'اسم المنتج': 'رز عنبر', 'سعر الشراء': '1250000', 'سعر البيع': '1400000',
      'الكمية': '10', 'الوحدة': 'كيس', 'التصنيف': 'مواد غذائية',
    });
    const out = parseProductRows([row], []);
    expect(out[0].cost).toBe(1250000);
    expect(out[0].data?.sellPrice).toBe(1400000);
    expect(out[0].data?.quantity).toBe(10);
    expect(out[0].data?.unit).toBe('كيس');
  });
});
