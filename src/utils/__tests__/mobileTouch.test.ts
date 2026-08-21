import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  MOBILE_PRIMARY, MOBILE_MORE, MOBILE_SCREENS, isMobileScreen, isBehindMore, shortLabel,
} from '../mobileNav';

/**
 * حُرّاس اللمس والعرض (المرحلة ب).
 *
 * كلّها تحرس علّاتٍ **قِيست فعلاً** على عرض ٣٧٥px، لا علّاتٍ مُتخيَّلة. وأخطرها
 * صنفان: زرٌّ لا يظهر إلا بمرور الفأرة (فهو معدومٌ على اللمس)، وفيضٌ أفقي يجعل
 * التطبيق كلّه يُسحب جانبياً كاشفاً فراغاً.
 */

const root = process.cwd();
const COMP = join(root, 'src', 'components');

/**
 * يقرأ ملفاً بعد تجريده من التعليقات — وإلا حسب الحارسُ شرحَ العلّة مخالفةً.
 *
 * 🔴 النمط **مُرسىً على بداية السطر** لا مطلقاً: النسخة المطلقة تبتلع من أول
 * فاتحةِ تعليقٍ داخل أي سلسلة نصّية (مسارٌ أو نمطُ CSS) حتى أول خاتمةٍ بعدها،
 * فتحذف شيفرةً حقيقية ويمرّ الحارس على فراغ. علّةٌ وقعت في هذا المستودع من قبل.
 */
const readCode = (rel: string) =>
  readFileSync(join(root, rel), 'utf8')
    // 🔴 تعليقات JSX أولاً: `{/* … */}` لا يبدأ سطره بفاتحة تعليق (يسبقها `{`)
    // فينجو من التجريد أدناه. وقد **مرّ حارسٌ كاذباً** بسببه: نصّ التعليق كان يشرح
    // `inputMode="tel"` فطابقه الحارس بعد نزع السمة من الشيفرة نفسها.
    // والحدّان `{/*` و`*/}` أضيق من فاتحةٍ مطلقة، فلا يبتلعان سلاسل نصّية.
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');

const components = readdirSync(COMP).filter(n => n.endsWith('.tsx'));

describe('نطاق شاشات الهاتف', () => {
  it('🔴 خمسٌ في الشريط لا أكثر — وإلا ضاق الزرّ عن حدّ اللمس', () => {
    expect(
      MOBILE_PRIMARY.length,
      'ستّة أزرار + «المزيد» على ٣٧٥px تعطي ٥٣px للزرّ، وتسميةً غير مقروءة',
    ).toBe(5);
  });

  it('المجموعتان لا تتداخلان ولا تتكرّران', () => {
    const all = [...MOBILE_PRIMARY, ...MOBILE_MORE];
    expect(new Set(all).size).toBe(all.length);
    expect(MOBILE_SCREENS).toEqual(all);
  });

  it('الشاشات المدعومة تُعرف، وغير المدعومة لا', () => {
    expect(isMobileScreen('invoices')).toBe(true);
    expect(isMobileScreen('cashclosing')).toBe(true);
    for (const off of ['purchase-invoices', 'stock-transfers', 'installments', 'audit-log', 'backup']) {
      expect(isMobileScreen(off), `${off} ليست في نطاق الهاتف`).toBe(false);
    }
  });

  it('🔴 «المزيد» يُبرَز حين تكون الشاشة النشطة خلفه', () => {
    for (const id of MOBILE_MORE) expect(isBehindMore(id), id).toBe(true);
    expect(isBehindMore('admin'), 'لوحة المالك خلف «المزيد» أيضاً').toBe(true);
    for (const id of MOBILE_PRIMARY) expect(isBehindMore(id), id).toBe(false);
  });
});

describe('التسميات القصيرة', () => {
  it('🔴 مفهرسة بالمعرّف لا بالنصّ — فلا تنكسر عند تعديل تسمية القائمة', () => {
    expect(shortLabel('invoices', 'الوصولات والفواتير')).toBe('الفواتير');
    expect(
      shortLabel('invoices', 'اسمٌ آخر تماماً'),
      'لو كانت الفهرسة بالنصّ لسقطت هنا إلى الاسم الطويل',
    ).toBe('الفواتير');
  });

  it('كلّ شاشات الهاتف لها تسمية قصيرة تتّسع للزرّ', () => {
    for (const id of [...MOBILE_SCREENS, 'admin']) {
      const s = shortLabel(id, 'احتياطي طويل جداً');
      expect(s, id).not.toBe('احتياطي طويل جداً');
      expect(s.length, `«${s}» أطول من أن تُقرأ في زرّ ٦٢px`).toBeLessThanOrEqual(9);
    }
  });

  it('المجهول يسقط إلى الاسم الطويل منزوعَ الرموز', () => {
    expect(shortLabel('unknown', 'نقل بضاعة 🔄')).toBe('نقل بضاعة');
  });
});

describe('🔴 أفعالٌ لا تظهر إلا بمرور الفأرة = معدومةٌ على اللمس', () => {
  it('لا `opacity-0 group-hover` بلا بادئة md', () => {
    const bad: string[] = [];
    for (const f of components) {
      const src = readCode(`src/components/${f}`);
      // الخطر: كشفٌ معلّقٌ على hover دون أن يكون مقيّداً بـmd (سطح المكتب)
      if (/(?<!md:)opacity-0 group-hover/.test(src)) bad.push(f);
      if (/"hidden group-hover:/.test(src) || /\bhidden group-hover:/.test(src)) bad.push(f);
    }
    expect(
      bad,
      'زرّ تعديل أو حذف مخفيٌّ خلف hover لا يمكن بلوغه بإصبع — لا وجود لـhover على اللمس',
    ).toEqual([]);
  });

  it('والنمط الصحيح مستعمل فعلاً (حماية من فحصٍ يمرّ لأن لا شيء موجود)', () => {
    // أزرار الصفوف: تظهر دائماً على الهاتف، وتبقى مخفيةً حتى المرور على الكمبيوتر
    const rows = components.filter(f => /opacity-100 md:opacity-0 md:group-hover/.test(readCode(`src/components/${f}`)));
    expect(
      rows,
      'لم يُعثر على أزرار الصفوف المُصلَحة — هل عاد الإخفاء المطلق؟',
    ).toEqual(expect.arrayContaining(['ExpensesView.tsx', 'InvoicesView.tsx']));

    // التلميحات: `md:group-hover` بعد قالبٍ نصّي يقرّر الظهور باللمس (openBar)
    const tips = components.filter(f => /md:group-hover:flex/.test(readCode(`src/components/${f}`)));
    expect(tips).toEqual(expect.arrayContaining(['GeneralDashboard.tsx', 'ReportsView.tsx']));
  });

  it('🔴 وتلميحات الرسوم البيانية تُفتح باللمس — أرقامها بيانات لا زينة', () => {
    for (const f of ['GeneralDashboard.tsx', 'ReportsView.tsx']) {
      const src = readCode(`src/components/${f}`);
      // 🔴 الفحص على **مُعالِج الضغط** لا على الحالة: وجود `openBar === idx` في
      // صنف الـclassName وحده يمرّ حتى لو حُذف الـonClick — فيبقى التلميح معلّقاً
      // على hover ولا يُفتح بإصبع أبداً. (طفرةٌ مرّت فعلاً على الصيغة الأولى.)
      expect(
        /onClick=\{\(\) => setOpenBar\(openBar === idx \? null : idx\)\}/.test(src),
        `${f}: لا مُعالِج ضغط — قيم الأعمدة غير قابلة للوصول على الهاتف`,
      ).toBe(true);
      expect(
        /\$\{openBar === idx \? 'flex' : 'hidden'\}/.test(src),
        `${f}: الحالة غير موصولة بالعرض`,
      ).toBe(true);
    }
  });
});

describe('🔴 الفيض الأفقي', () => {
  it('إطار مصادقة فايربيس مثبَّت — كان يمدّ الصفحة إلى ٥١٩px', () => {
    const css = readFileSync(join(root, 'src', 'index.css'), 'utf8');
    expect(
      /iframe\[src\*=["']\/__\/auth\/iframe["']\]/.test(css),
      'بدونه يُسحب التطبيق جانبياً ١٤٤px على كل هاتف',
    ).toBe(true);
  });

  it('🔴 ولم يُعالَج بإخفاء الفيض على body — فذلك غطاءٌ يُخفي العلل القادمة', () => {
    const css = readFileSync(join(root, 'src', 'index.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/body\s*\{[^}]*overflow-x:\s*hidden/.test(css)).toBe(false);
  });

  it('مجموعة أزرار الترويسة تنكمش (min-w-0)', () => {
    const src = readCode('src/components/DashboardLayout.tsx');
    expect(
      /className="flex items-center gap-1\.5 md:gap-3 min-w-0"/.test(src),
      'عناصر flex لا تنكمش دون min-content تلقائياً — فتدفع الصفحة إلى ٥٠٣px',
    ).toBe(true);
  });

  it('🔴 ومبدّل الفروع أضيق على الهاتف فقط', () => {
    const src = readCode('src/components/DashboardLayout.tsx');
    expect(
      /max-w-\[92px\] md:max-w-\[140px\]/.test(src),
      'تضييقه بلا بادئة md يقصّ أسماء الفروع على الكمبيوتر أيضاً',
    ).toBe(true);
  });
});

describe('🔴 جداول تُمرَّر لا تُقصّ', () => {
  it('جدول سجلّ الزبون داخل غلاف تمرير', () => {
    const src = readCode('src/components/CustomerHistoryModal.tsx');
    expect(/overflow-x-auto[\s\S]{0,120}<table/.test(src)).toBe(true);
  });

  it('🔴 وجدول ورقة الطباعة يُستثنى عند الطباعة — وإلا قُصّت الفاتورة المطبوعة', () => {
    const src = readCode('src/components/InvoicesView.tsx');
    expect(
      /overflow-x-auto print:overflow-visible/.test(src),
      'غلاف تمرير بلا print:overflow-visible يقصّ أعمدة الفاتورة على الورق',
    ).toBe(true);
  });
});

describe('🔴 تحديد النصّ ولوحة المفاتيح', () => {
  it('الجذر لم يعد يمنع التحديد — التاجر ينسخ رقم الفاتورة والهاتف', () => {
    const src = readCode('src/App.tsx');
    const rootDiv = src.split('\n').find(l => l.includes('min-h-screen') && l.includes('dir="rtl"'));
    expect(rootDiv, 'لم يُعثر على العنصر الجذر').toBeTruthy();
    expect(
      /select-none/.test(rootDiv!),
      'select-none على الجذر يمنع النسخ في كل البرنامج',
    ).toBe(false);
  });

  it('والقشرة تبقى غير قابلة للتحديد (لم يُنزع select-none من التسميات)', () => {
    const n = components.reduce((s, f) => s + (readCode(`src/components/${f}`).match(/select-none/g)?.length ?? 0), 0);
    expect(n, 'نُزعت select-none من التسميات أيضاً — تحديدٌ عشوائي عند كل ضغطة').toBeGreaterThan(30);
  });

  it('🔴 حقول الهاتف تفتح لوحة أرقام', () => {
    const phoneFields: Array<[string, string]> = [
      ['BranchesView.tsx', '07XXXXXXXXX'],
      ['CustomersView.tsx', 'مثال: ٠٧٧١٢٣٤٥٦٧٨'],
      ['SettingsView.tsx', 'مثال: 0770XXXXXXX'],
    ];
    for (const [file, placeholder] of phoneFields) {
      const src = readCode(`src/components/${file}`);
      const i = src.indexOf(placeholder);
      expect(i, `${file}: لم يُعثر على الحقل`).toBeGreaterThan(-1);
      // الوسم يبدأ قبل الـplaceholder — نفحص النافذة المحيطة
      const window = src.slice(Math.max(0, i - 400), i + 200);
      expect(
        /inputMode="tel"|type="tel"/.test(window),
        `${file}: حقل هاتف بلا inputMode ⟶ لوحة حروف على الهاتف`,
      ).toBe(true);
    }
  });
});
