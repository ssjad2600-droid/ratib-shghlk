import { describe, it, expect } from 'vitest';
import { stableId } from '../stableId';
import { parseCustomerRows, parseProductRows } from '../bulkImport';
import { buildStatementText, toWhatsappNumber, buildDebtReminderUrl } from '../whatsapp';
import { Customer, Product } from '../../types';

/**
 * 🔴 المعرّف الثابت — الحارس بين «تصحيح» و«تكرار».
 *
 * كان الاستيراد يولّد `cust_${Date.now()}_${idx}`. فلو تعثّرت العملية وأعاد التاجر
 * المحاولة بالملف نفسه، دخل كل زبون مرتين: ٥٠٠ يصيرون ألفاً، ولا شيء يشير إلى الخطأ
 * إلا قائمة صارت ضِعف طولها.
 */

describe('stableId — نفس المحتوى يعطي نفس المعرّف', () => {
  it('ثابت عبر النداءات', () => {
    expect(stableId('cust', '07701234567')).toBe(stableId('cust', '07701234567'));
  });

  it('لا يعتمد على الوقت إطلاقاً', () => {
    const a = stableId('cust', 'علي محمد');
    const b = stableId('cust', 'علي محمد');
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{13}/); // لا طابع زمني بداخله
  });

  it('يبدأ بالبادئة المطلوبة', () => {
    expect(stableId('prod', 'x')).toMatch(/^prod_/);
    expect(stableId('cust', 'x')).toMatch(/^cust_/);
  });

  it('محتويان مختلفان ⇒ معرّفان مختلفان', () => {
    expect(stableId('cust', '07701234567')).not.toBe(stableId('cust', '07701234568'));
    expect(stableId('cust', 'علي')).not.toBe(stableId('cust', 'علي محمد'));
  });

  it('يتجاهل المسافات الزائدة وحالة الأحرف', () => {
    expect(stableId('cust', ' علي  محمد ')).toBe(stableId('cust', 'علي محمد'));
    expect(stableId('prod', 'ABC123')).toBe(stableId('prod', 'abc123'));
  });

  it('البادئتان تفصلان بين الأنواع لنفس المفتاح', () => {
    expect(stableId('cust', 'x')).not.toBe(stableId('prod', 'x'));
  });

  it('لا تصادم على مجموعة واقعية من الهواتف والأسماء', () => {
    const keys: string[] = [];
    for (let i = 0; i < 2000; i++) keys.push(`0770${String(1000000 + i)}`);
    for (let i = 0; i < 500; i++) keys.push(`زبون رقم ${i}`);
    const ids = new Set(keys.map(k => stableId('cust', k)));
    expect(ids.size, 'وقع تصادم بين معرّفات').toBe(keys.length);
  });

  it('العربية والمحارف الخاصة لا تكسره', () => {
    for (const k of ['محمد الأمير', 'أبو علي — الكرادة', '٠٧٧٠١٢٣٤٥٦٧', 'a/b\\c']) {
      expect(stableId('cust', k)).toMatch(/^cust_[0-9a-z]+$/);
    }
  });
});

describe('🔴 إعادة الاستيراد تصحّح ولا تُكرّر', () => {
  const row = (n: string, p = '') => ({
    'اسم الزبون': n, 'الهاتف': p, 'العنوان': '', 'الرصيد (دين عليه)': '',
    'تاريخ الاستحقاق': '', 'ملاحظات': '',
  });

  it('نفس الملف مرتين على قاعدة فارغة ⇒ نفس المعرّفات', () => {
    const file = [row('زبون أ', '٠٧٧٠١١١١١١١'), row('زبون ب', '٠٧٧٠٢٢٢٢٢٢٢')];
    const first = parseCustomerRows(file, []);
    const second = parseCustomerRows(file, []);
    expect(first.map(r => r.data?.id)).toEqual(second.map(r => r.data?.id));
  });

  it('🔴 الجولة الثانية بعد نجاح الأولى ⇒ «تحديث» لا «جديد»', () => {
    const file = [row('زبون أ', '٠٧٧٠١١١١١١١')];
    const first = parseCustomerRows(file, []);
    const saved = [first[0].data!] as Customer[];
    const second = parseCustomerRows(file, saved);
    expect(second[0].action).toBe('update');
    expect(second[0].existingId).toBe(first[0].data!.id);
  });

  it('الكتابتان العربية واللاتينية للهاتف تعطيان المعرّف نفسه', () => {
    const a = parseCustomerRows([row('س', '٠٧٧٠١١١١١١١')], [])[0].data!.id;
    const b = parseCustomerRows([row('س', '07701111111')], [])[0].data!.id;
    expect(a).toBe(b);
  });

  it('المنتجات كذلك — المعرّف من الباركود', () => {
    const prow = (n: string, bc: string) => ({
      'اسم المنتج': n, 'الباركود': bc, 'التصنيف': '', 'الوحدة': '',
      'سعر الشراء': '100', 'سعر البيع': '150', 'الكمية': '1', 'حد النفاد': '1',
      'اسم وحدة الجملة': '', 'عدد القطع بالوحدة': '', 'سعر بيع الجملة': '',
      'سعر شراء الجملة': '', 'ضمان بالأشهر': '',
    });
    const file = [prow('حليب', '1122334455')];
    const first = parseProductRows(file, []);
    const second = parseProductRows(file, []);
    expect(first[0].data!.id).toBe(second[0].data!.id);
    const saved = [first[0].data!] as Product[];
    expect(parseProductRows(file, saved)[0].action).toBe('update');
  });
});

/**
 * توحيد نصوص الواتساب — الزبون يقرؤها، فهي واجهة المحل لا واجهة البرنامج.
 */
describe('نصوص الواتساب — مصدر واحد ونبرة واحدة', () => {
  const base = { customerName: 'علي محمد', currency: 'IQD' as const, exchangeRate: 1500, storeName: 'اسواق النور' };

  it('الدَّين يظهر بمبلغه واسم المحل', () => {
    const t = buildStatementText({ ...base, balance: 50000 });
    expect(t).toContain('اسواق النور');
    expect(t).toContain('المستحق عليكم');
    expect(t).not.toContain('رتب شغلك'); // لا يُنسب لاسم البرنامج
  });

  it('الأمانة له تُصاغ لصالحه لا ضدّه', () => {
    const t = buildStatementText({ ...base, balance: -15000 });
    expect(t).toContain('لكم عندنا أمانة');
    expect(t).not.toContain('المستحق عليكم');
  });

  it('🔴 الحساب المصفّى لا يُرسل كمطالبة', () => {
    const t = buildStatementText({ ...base, balance: 0 });
    expect(t).toContain('مصفّى');
    expect(t).not.toMatch(/مستحق عليكم|أمانة/);
  });

  it('موعد السداد لا يُطبع فارغاً', () => {
    expect(buildStatementText({ ...base, balance: 50000 })).not.toContain('موعد السداد');
    expect(buildStatementText({ ...base, balance: 50000, dueDate: 'نهاية الشهر' })).toContain('موعد السداد');
  });

  it('بلا اسم محل يقول «محلّنا» لا فراغاً', () => {
    expect(buildStatementText({ ...base, storeName: undefined, balance: 0 })).toContain('محلّنا');
  });

  it('الكشف والتذكير يشتركان في التحية والختام — نبرة واحدة', () => {
    const statement = buildStatementText({ ...base, balance: 50000 });
    const reminder = buildDebtReminderUrl({
      customerName: 'علي محمد', phone: '07701234567', balance: 50000,
      storeName: 'اسواق النور', currency: 'IQD', exchangeRate: 1500,
    });
    expect(statement).toContain('السلام عليكم');
    expect(decodeURIComponent(reminder)).toContain('السلام عليكم');
    expect(statement).toContain('شكراً لثقتكم');
    expect(decodeURIComponent(reminder)).toContain('شكراً لثقتكم');
  });
});

describe('toWhatsappNumber — بعد التوحيد على toLatinDigits', () => {
  it('العربية والفارسية واللاتينية', () => {
    expect(toWhatsappNumber('٠٧٧٠١٢٣٤٥٦٧')).toBe('9647701234567');
    expect(toWhatsappNumber('۰۷۷۰۱۲۳۴۵۶۷'), 'الفارسية').toBe('9647701234567');
    expect(toWhatsappNumber('07701234567')).toBe('9647701234567');
  });

  it('الصيغ الدولية', () => {
    expect(toWhatsappNumber('+9647701234567')).toBe('9647701234567');
    expect(toWhatsappNumber('009647701234567')).toBe('9647701234567');
  });

  it('الرقم الفاسد يُرجع فراغاً — لا نفتح محادثة مع غريب', () => {
    for (const bad of ['', '123', 'لا رقم', '07']) expect(toWhatsappNumber(bad)).toBe('');
  });
});
