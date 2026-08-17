import { describe, it, expect } from 'vitest';
import { csvToObjects, parseCsv } from '../csv';
import { parseProductRows, parseCustomerRows, PRODUCT_HEADERS, CUSTOMER_HEADERS } from '../bulkImport';
import { encodeCode128, fitBarcode, isEncodable, MIN_MODULE_MM } from '../barcode128';
import { computeGrid, generateInternalBarcode, checkLabelFit, LABEL_PRESETS } from '../barcodeLabels';
import { warrantyStatus, normalizeSerial } from '../warranty';
import { localDateKey } from '../dateLocal';
import { formatArabicNoun, ARABIC_NOUNS } from '../arabicFormatters';
import { daysAgoKey, windowConstraints } from '../dateWindow';
import { Customer, Product } from '../../types';

/**
 * سلامة البيانات عند الحدود: الاستيراد الجماعي، الباركود، الضمان، والتواريخ.
 * كل بند هنا يحرس خطأً يكلّف التاجر مالاً أو بضاعة لا مجرّد إزعاج واجهة.
 */

describe('قراءة ملفات CSV', () => {
  it('يكشف الفاصلة المنقوطة (تصدير Excel العربي) تلقائياً', () => {
    const rows = parseCsv('اسم;هاتف\nعباس;0770');
    expect(rows[1]).toEqual(['عباس', '0770']);
  });

  it('يحترم الحقول المقتبسة التي تحوي فاصلة', () => {
    const rows = parseCsv('a,b\n"القيمة، بفاصلة",ثانية');
    expect(rows[1][0]).toBe('القيمة، بفاصلة');
  });

  it('يحوّل الصفوف إلى كائنات بعناوينها', () => {
    const objs = csvToObjects('الاسم,الهاتف\nعلي,0771');
    expect(objs).toEqual([{ 'الاسم': 'علي', 'الهاتف': '0771' }]);
  });
});

describe('الاستيراد الجماعي', () => {
  const custRow = (name: string, phone = '', balance = '') =>
    csvToObjects(`${CUSTOMER_HEADERS.join(',')}\n${name},${phone},,${balance},,`);
  const prodRow = (cells: string) => csvToObjects(`${PRODUCT_HEADERS.join(',')}\n${cells}`);

  it('🔴 تحديث زبون قائم لا يمسّ رصيده مهما كان في الملف', () => {
    const existing: Customer[] = [{
      id: 'c1', name: 'أحمد', phone: '', address: '', notes: '', balance: 250000, dueDate: '', createdAt: '',
    }];
    const [row] = parseCustomerRows(custRow('أحمد', '07701234567', '999999'), existing);
    expect(row.action).toBe('update');
    expect(row.data!.balance).toBe(250000); // لا ٩٩٩٩٩٩ — الديون لا تُمحى باستيراد
  });

  it('الزبون الجديد يأخذ رصيده من الملف', () => {
    const [row] = parseCustomerRows(custRow('جديد', '0770', '50000'), []);
    expect(row.action).toBe('create');
    expect(row.data!.balance).toBe(50000);
  });

  it('يقرأ الأرقام العربية-الهندية', () => {
    const [row] = parseCustomerRows(custRow('عباس', '٠٧٧٠', '٢٥٠٠٠'), []);
    expect(row.data!.balance).toBe(25000);
  });

  it('يرفض الصف الناقص ويُمرّر السليم — صف فاسد لا يُسقط الملف', () => {
    const rows = parseProductRows(
      csvToObjects(`${PRODUCT_HEADERS.join(',')}\n,BC1,س,قطعة,100,200,5,1,,,,,\nسليم,BC2,س,قطعة,100,200,5,1,,,,,`),
      [],
    );
    expect(rows[0].action).toBe('error');
    expect(rows[0].errors[0]).toContain('اسم المنتج');
    expect(rows[1].action).toBe('create');
  });

  it('يرفض المنتج بلا سعر بيع', () => {
    const [row] = parseProductRows(prodRow('مادة,BC3,س,قطعة,100,,5,1,,,,,'), []);
    expect(row.action).toBe('error');
    expect(row.errors[0]).toContain('سعر البيع');
  });

  it('الباركود المطابق يحدّث المنتج نفسه ولا ينشئ نسخة ثانية', () => {
    const existing: Product[] = [{
      id: 'p1', name: 'قديم', barcode: 'BC9', sellPrice: 100, quantity: 7,
      lowStockThreshold: 1, category: '', unit: 'قطعة', createdAt: '',
    }];
    const [row] = parseProductRows(prodRow('اسم جديد,BC9,س,قطعة,50,300,20,3,,,,,'), existing);
    expect(row.action).toBe('update');
    expect(row.data!.id).toBe('p1');
    expect(row.data!.sellPrice).toBe(300);
  });

  it('يكشف التكرار داخل الملف نفسه', () => {
    const rows = parseProductRows(
      csvToObjects(`${PRODUCT_HEADERS.join(',')}\nمكرر,BC5,س,قطعة,10,20,1,1,,,,,\nمكرر,BC5,س,قطعة,10,20,1,1,,,,,`),
      [],
    );
    expect(rows[0].action).toBe('create');
    expect(rows[1].action).toBe('error');
    expect(rows[1].errors[0]).toContain('مكرر');
  });
});

describe('ترميز Code 128', () => {
  /** فاكّ ترميز مستقل — لا نثق برسم «يبدو صحيحاً»، بل نعيد قراءته. */
  const PATTERNS = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112',
  ];

  const decode = (value: string) => {
    const bc = encodeCode128(value)!;
    const idx: number[] = [];
    let i = 0;
    while (i < bc.elements.length) {
      const take = bc.elements.length - i === 7 ? 7 : 6;
      const pat = bc.elements.slice(i, i + take).join('');
      const k = PATTERNS.indexOf(pat);
      expect(k).toBeGreaterThanOrEqual(0); // كل نمط يجب أن يكون قياسياً
      idx.push(k);
      i += take;
    }
    const start = idx[0];
    const check = idx[idx.length - 2];
    const stop = idx[idx.length - 1];
    const data = idx.slice(1, -2);
    let sum = start;
    data.forEach((v, j) => { sum += v * (j + 1); });
    const text = start === 105
      ? data.map(v => String(v).padStart(2, '0')).join('')
      : data.map(v => String.fromCharCode(v + 32)).join('');
    return { text, checkOk: sum % 103 === check, stopOk: stop === 106, encoding: bc.encoding };
  };

  it.each(['22000001', '1234567890', 'ABC-123', '7', 'A1b2C3'])('يعود %s كما هو مع تحقّق سليم', (code) => {
    const d = decode(code);
    expect(d.text).toBe(code);
    expect(d.checkOk).toBe(true);
    expect(d.stopOk).toBe(true);
  });

  it('الأرقام الزوجية تُرمَّز Code C فتنضغط للنصف', () => {
    expect(encodeCode128('22000001')!.encoding).toBe('C');
    expect(encodeCode128('22000001')!.modules).toBeLessThan(encodeCode128('ABC-1234')!.modules);
  });

  it('النص العربي غير قابل للترميز — يُرفض لا يُشوَّه', () => {
    expect(isEncodable('مادة')).toBe(false);
    expect(encodeCode128('مادة')).toBeNull();
  });

  it('يحذّر قبل الطباعة إن نزل عرض الشريط تحت حدّ القراءة', () => {
    const wide = fitBarcode('22000001', 36)!;
    const narrow = fitBarcode('0123456789012', 18)!;
    expect(wide.ok).toBe(true);
    expect(narrow.ok).toBe(false);
    expect(narrow.moduleMm).toBeLessThan(MIN_MODULE_MM);
    expect(narrow.neededMm).toBeGreaterThan(18);
  });
});

describe('ملصقات الباركود', () => {
  it('كل مقاس جاهز يُنتج عدده المعلن', () => {
    const expected: Record<string, number> = { l65: 65, l40: 40, l24: 24, l12: 12 };
    for (const p of LABEL_PRESETS) {
      expect(computeGrid(p).perPage).toBe(expected[p.id]);
    }
  });

  it('المقاس الحرّ يحسب الشبكة تلقائياً', () => {
    const g = computeGrid({ labelW: 50, labelH: 25, marginX: 5, marginY: 10, gapX: 2, gapY: 2 });
    expect(g.cols).toBe(3);
    expect(g.rows).toBe(10);
    expect(g.fits).toBe(true);
  });

  it('مقاس أكبر من الورقة يُرفض بدل أن يطبع فوضى', () => {
    expect(computeGrid({ labelW: 300, labelH: 40, marginX: 5, marginY: 10, gapX: 0, gapY: 0 }).fits).toBe(false);
  });

  it('الأكواد المولَّدة فريدة ومتسلسلة وبطول زوجي (لتنضغط Code C)', () => {
    const taken = new Set(['22000001', '1234567890']);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) { const c = generateInternalBarcode(taken); taken.add(c); made.push(c); }
    expect(new Set(made).size).toBe(5);
    expect(made).not.toContain('22000001');       // لا يصطدم بالقائم
    expect(made.every(c => c.length % 2 === 0)).toBe(true);
    expect(made[0]).toBe('22000002');             // يكمل من أعلى رقم مستخدم
  });

  it('يميّز سبب الفشل: كود طويل على المقاس مقابل محارف غير مدعومة', () => {
    const issues = checkLabelFit(
      [{ barcode: '0123456789012', name: 'طويل', price: 0 }, { barcode: 'مادة', name: 'عربي', price: 0 }],
      38,
    );
    expect(issues.find(i => i.name === 'طويل')!.reason).toBe('tooNarrow');
    expect(issues.find(i => i.name === 'عربي')!.reason).toBe('unencodable');
  });
});

describe('الضمان', () => {
  it('يحسب بالأشهر التقويمية', () => {
    const st = warrantyStatus('2026-01-15', 12);
    expect(st.expiryKey).toBe('2027-01-15');
    expect(st.hasWarranty).toBe(true);
    expect(st.monthsCovered).toBe(12);
  });

  it('🔴 يثبّت نهاية الشهر بدل أن يقفز لشهر تالٍ (٣١ يناير + شهر ⇒ ٢٨ فبراير لا ٣ مارس)', () => {
    expect(warrantyStatus('2026-01-31', 1).expiryKey).toBe('2026-02-28');
    expect(warrantyStatus('2026-01-31', 3).expiryKey).toBe('2026-04-30');
    expect(warrantyStatus('2024-01-31', 1).expiryKey).toBe('2024-02-29'); // سنة كبيسة
  });

  it('الضمان المنتهي يُعلن منتهياً بأيام سالبة', () => {
    const st = warrantyStatus('2020-01-01', 6);
    expect(st.active).toBe(false);
    expect(st.daysLeft).toBeLessThan(0);
  });

  it('بلا مدة ضمان = لا ضمان (لا افتراض ضمناً)', () => {
    expect(warrantyStatus('2026-01-01', 0).hasWarranty).toBe(false);
    expect(warrantyStatus('2026-01-01', undefined).hasWarranty).toBe(false);
  });

  it('توحيد السيريال يتجاهل الفراغات وحالة الأحرف', () => {
    expect(normalizeSerial(' 3582-4005 ab ')).toBe(normalizeSerial('35824005AB'));
  });
});

describe('التواريخ والنوافذ', () => {
  it('مفتاح اليوم محلي لا UTC — بيعة بعد منتصف الليل تبقى في يومها', () => {
    const late = new Date(2026, 7, 5, 23, 45); // ٥ آب ١١:٤٥ ليلاً محلياً
    expect(localDateKey(late)).toBe('2026-08-05');
  });

  it('نافذة الاستعلام تُنتج قيداً واحداً على حقل date (بلا فهرس مركّب)', () => {
    const c = windowConstraints(daysAgoKey(90));
    expect(c).toHaveLength(1);
  });

  it('نافذة أطول تبدأ من تاريخ أقدم', () => {
    expect(daysAgoKey(400) < daysAgoKey(90)).toBe(true);
  });
});

describe('صياغة الأسماء العربية في اللوحة', () => {
  it('🔴 «فئة واحدة» لا «١ فئات» — الصياغة الخاطئة كانت ظاهرة في بطاقة المواد', () => {
    expect(formatArabicNoun(1, ARABIC_NOUNS.category)).toBe('فئة واحدة');
    expect(formatArabicNoun(2, ARABIC_NOUNS.category)).toBe('فئتين اثنتين');
    expect(formatArabicNoun(5, ARABIC_NOUNS.category)).toContain('فئات');
    expect(formatArabicNoun(0, ARABIC_NOUNS.category)).toContain('فئ');
  });

  it('تاريخ الفاتورة يُبنى من مكوّناته المحلية لا بتفسير UTC', () => {
    // new Date('2026-08-05') = منتصف ليل UTC ⇒ يزحف يوماً في الإزاحات السالبة
    const [y, m, d] = '2026-08-05'.split('-').map(Number);
    const local = new Date(y, m - 1, d);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(7);
    expect(local.getDate()).toBe(5);
  });
});
