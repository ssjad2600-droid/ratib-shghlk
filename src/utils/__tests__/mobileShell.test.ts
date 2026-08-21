import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isElectron, setupServiceWorker, SWDeps } from '../serviceWorker';

/**
 * حُرّاس أساس الهاتف (المرحلة أ) — تثبيت التطبيق على الشاشة الرئيسية.
 *
 * 🔴 لماذا حُرّاس نصّية إلى جانب اختبارات المنطق؟ لأن نصف هذه المرحلة إعداداتٌ لا
 * شيفرة: وسمٌ في `index.html`، حقلٌ في manifest، حشوةٌ في صنف Tailwind. لا يكسرها
 * `tsc` ولا يلتقطها اختبار وحدة، وسقوطها **صامت**: التطبيق يعمل، لكنه يُثبَّت بلا
 * أيقونة، أو يقع شريطه السفلي تحت شريط إيماءات الآيفون فلا يُضغط.
 */

const root = process.cwd();

/** يقرأ ملفاً بعد **تجريده من التعليقات** — وإلا مرّ الحارس على ذِكرٍ في تعليق. */
const readCode = (rel: string) =>
  readFileSync(join(root, rel), 'utf8')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');

const readRaw = (rel: string) => readFileSync(join(root, rel), 'utf8');

/** حاوية عمّال خدمة مزيّفة — تسجّل ما طُلب منها. */
function fakeContainer(opts: { existing?: number; failRegister?: boolean } = {}) {
  const unregistered: boolean[] = [];
  const regs = Array.from({ length: opts.existing ?? 0 }, () => ({
    unregister: vi.fn(async () => { unregistered.push(true); return true; }),
  }));
  const register = vi.fn(async () => {
    if (opts.failRegister) throw new Error('SecurityError');
    return {} as ServiceWorkerRegistration;
  });
  return {
    container: { register, getRegistrations: vi.fn(async () => regs) } as unknown as ServiceWorkerContainer,
    register,
    regs,
    unregistered,
  };
}

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) رتب شغلك/1.0.0 Chrome/140.0.0.0 Electron/42.4.1 Safari/537.36';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

describe('🔴 عامل الخدمة يُمنع داخل نسخة سطح المكتب', () => {
  it('يميّز Electron من المتصفح والآيفون', () => {
    expect(isElectron(ELECTRON_UA)).toBe(true);
    expect(isElectron(CHROME_UA)).toBe(false);
    expect(isElectron(IOS_UA)).toBe(false);
  });

  it('🔴 لا يُخدع بكلمة Electron داخل اسمٍ آخر', () => {
    expect(
      isElectron('Mozilla/5.0 ElectronicStore/2.1 Safari/537.36'),
      'مطابقةٌ فضفاضة تمنع عامل الخدمة عن متصفحاتٍ سليمة فيسقط العمل أوفلاين',
    ).toBe(false);
  });

  it('يسجّل في المتصفح', async () => {
    const f = fakeContainer();
    expect(await setupServiceWorker({ ua: CHROME_UA, container: f.container })).toBe('registered');
    expect(f.register).toHaveBeenCalledOnce();
  });

  it('🔴 لا يسجّل داخل Electron — وإلا جُمّد سطح المكتب على ملفات إصدارٍ قديم', async () => {
    const f = fakeContainer();
    expect(await setupServiceWorker({ ua: ELECTRON_UA, container: f.container })).toBe('skipped-electron');
    expect(
      f.register,
      'تسجيله على أصل الخادم المحلي الثابت يُقدّم النسخة القديمة بعد كل تحديث',
    ).not.toHaveBeenCalled();
  });

  it('🔴 ويُلغي أي تسجيلٍ سابق داخل Electron', async () => {
    const f = fakeContainer({ existing: 2 });
    await setupServiceWorker({ ua: ELECTRON_UA, container: f.container });
    expect(
      f.unregistered.length,
      'تسجيلٌ قديم بقي من خطأٍ سابق يُجمّد التطبيق ولو مُنع التسجيل الجديد',
    ).toBe(2);
  });

  it('فشل التسجيل لا يرمي — التطبيق يعمل بلا عامل خدمة', async () => {
    const f = fakeContainer({ failRegister: true });
    await expect(setupServiceWorker({ ua: CHROME_UA, container: f.container })).resolves.toBe('failed');
  });

  it('غياب الدعم يُعاد بهدوء', async () => {
    await expect(setupServiceWorker({ ua: CHROME_UA, container: undefined })).resolves.toBe('unsupported');
  });

  it('🔴 لا يُسجَّل في التطوير — لا وجود لـsw.js فيضجّ المتصفح بخطأ MIME', async () => {
    const f = fakeContainer();
    expect(await setupServiceWorker({ ua: CHROME_UA, container: f.container, enabled: false }))
      .toBe('skipped-dev');
    expect(f.register).not.toHaveBeenCalled();
  });

  it('🔴 وحارس Electron يسبق حارس التطوير', async () => {
    const f = fakeContainer({ existing: 1 });
    expect(
      await setupServiceWorker({ ua: ELECTRON_UA, container: f.container, enabled: false }),
      'ترتيبٌ معكوس يُخرج skipped-dev فيتخطّى الإلغاء الاحتياطي',
    ).toBe('skipped-electron');
    expect(
      f.unregistered.length,
      'تسجيلٌ قديم يُجمّد سطح المكتب سواء أكنّا في تطويرٍ أم إنتاج',
    ).toBe(1);
  });
});

describe('🔴 إعداد عامل الخدمة في vite.config', () => {
  const cfg = readCode('vite.config.ts');

  it('المسح يرى الملف', () => {
    expect(cfg).toContain('VitePWA');
  });

  it('🔴 التسجيل يدويٌّ لا تلقائي', () => {
    expect(
      /injectRegister:\s*null/.test(cfg),
      'التسجيل التلقائي يتخطّى حارس Electron في serviceWorker.ts فيعود العطل',
    ).toBe(true);
  });

  it('🔴 ولا يُخزَّن أي طلب شبكة', () => {
    expect(
      /runtimeCaching:\s*\[\s*\]/.test(cfg),
      'تخزين استجابات فايرستور يعرض أرصدةً قديمة على أنها حديثة في برنامج محاسبة',
    ).toBe(true);
  });

  it('وحدّ الحجم يتجاوز حجم الحزمة', () => {
    const m = cfg.match(/maximumFileSizeToCacheInBytes:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
    expect(m, 'الحدّ الافتراضي ٢ م.ب والحزمة تقاربه — فتسقط من المخزَّن بصمت').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(4);
  });
});

describe('🔴 manifest التثبيت', () => {
  const raw = readRaw('public/manifest.webmanifest');
  const m = JSON.parse(raw);

  it('عربيٌّ من اليمين لليسار', () => {
    expect(m.lang).toBe('ar');
    expect(m.dir).toBe('rtl');
  });

  it('🔴 يفتح بملء الشاشة بلا شريط متصفح', () => {
    expect(m.display, 'بدون standalone يبقى شريط سَفاري ظاهراً فلا يبدو تطبيقاً').toBe('standalone');
  });

  it('🔴 المسارات نسبية — الموقع قد يكون في مجلّد فرعي', () => {
    for (const key of ['start_url', 'scope'] as const) {
      expect(m[key], `${key} مطلق يكسر التثبيت إن لم يكن التطبيق في جذر النطاق`).toMatch(/^\.\//);
    }
    for (const icon of m.icons) expect(icon.src).toMatch(/^\.\//);
  });

  it('🔴 فيه أيقونة maskable لأندرويد', () => {
    const maskable = m.icons.filter((i: { purpose: string }) => i.purpose === 'maskable');
    expect(
      maskable.length,
      'بدونها يقصّ أندرويد الأيقونة أو يحيطها بإطارٍ أبيض قبيح',
    ).toBeGreaterThanOrEqual(1);
  });

  it('🔴 وكل أيقونةٍ مذكورة موجودة فعلاً على القرص', () => {
    for (const icon of m.icons) {
      const p = join(root, 'public', icon.src.replace(/^\.\//, ''));
      expect(existsSync(p), `${icon.src} مذكورة في manifest وغير موجودة`).toBe(true);
    }
  });

  it('ومقاسا ١٩٢ و٥١٢ حاضران — شرط قابلية التثبيت', () => {
    const sizes = new Set(m.icons.map((i: { sizes: string }) => i.sizes));
    expect(sizes.has('192x192')).toBe(true);
    expect(sizes.has('512x512')).toBe(true);
  });
});

describe('🔴 وسوم index.html', () => {
  const html = readRaw('index.html');

  it('🔴 مُرساة حاقن الـCSP سليمة', () => {
    expect(
      html.includes('<meta charset="UTF-8" />'),
      'vite.config.ts يستبدل هذا النصّ حرفياً؛ تغييره يُسقط CSP من البناء بصمت',
    ).toBe(true);
  });

  it('🔴 viewport-fit=cover — وإلا بقي شريطٌ أبيض أسفل شاشة الآيفون', () => {
    expect(/viewport-fit=cover/.test(html)).toBe(true);
  });

  it('يشير إلى الـmanifest وأيقونة آبل', () => {
    expect(/rel="manifest"/.test(html)).toBe(true);
    expect(/rel="apple-touch-icon"/.test(html)).toBe(true);
  });

  it('🔴 iOS لا يقرأ الـmanifest — يحتاج وسومه', () => {
    expect(/apple-mobile-web-app-capable/.test(html)).toBe(true);
    expect(/apple-mobile-web-app-title/.test(html)).toBe(true);
  });

  it('🔴 والخط لم يعد من CDN — التطبيق يعمل أوفلاين بالتصميم', () => {
    const tags = html.replace(/<!--[\s\S]*?-->/g, '');
    expect(
      /fonts\.googleapis\.com/.test(tags),
      'جلب الخط من الشبكة يُظهر أول تشغيلٍ بلا إنترنت بخطٍّ احتياطي',
    ).toBe(false);
  });
});

describe('🔴 المناطق الآمنة في القشرتين', () => {
  const shells = {
    'DashboardLayout.tsx': readCode('src/components/DashboardLayout.tsx'),
    'EmployeeShell.tsx': readCode('src/components/EmployeeShell.tsx'),
  };

  for (const [name, code] of Object.entries(shells)) {
    it(`${name} يحترم شريط إيماءات الهاتف`, () => {
      expect(
        /env\(safe-area-inset-bottom\)/.test(code),
        'بدونها يقع آخر صفٍّ — أو نصف الشريط السفلي — تحت شريط الإيماءات',
      ).toBe(true);
    });
  }

  it('🔴 الشريط السفلي نفسه محشوٌّ لا المحتوى وحده', () => {
    const nav = shells['DashboardLayout.tsx']
      .split('\n')
      .find(l => l.includes('fixed bottom-0') && l.includes('md:hidden'));
    expect(nav, 'لم يُعثر على الشريط السفلي').toBeTruthy();
    expect(
      /env\(safe-area-inset-bottom\)/.test(nav!),
      'حشو المحتوى وحده يترك أزرار الشريط تحت شريط الإيماءات فيتعذّر ضغطها',
    ).toBe(true);
  });

  it('ويبقى ملغيّاً على الكمبيوتر', () => {
    expect(/md:pb-8/.test(shells['DashboardLayout.tsx'])).toBe(true);
  });
});

describe('🔴 الخط مُجمَّع داخل الحزمة', () => {
  const fonts = readRaw('src/fonts.css');

  it('index.css يستورده', () => {
    expect(/@import\s+["']\.\/fonts\.css["']/.test(readRaw('src/index.css'))).toBe(true);
  });

  it('أربعة أوزان × مجموعتين = ٨ وجوه', () => {
    expect((fonts.match(/@font-face/g) ?? []).length).toBe(8);
    for (const w of [400, 500, 600, 700]) {
      expect(fonts, `الوزن ${w} مفقود`).toMatch(new RegExp(`font-weight:\\s*${w};`));
    }
  });

  it('🔴 وكل ملف مذكورٍ موجود فعلاً', () => {
    const urls = [...fonts.matchAll(/url\('([^']+)'\)/g)].map(m => m[1]);
    expect(urls.length).toBe(8);
    for (const u of urls) {
      const p = join(root, 'src', u.replace(/^\.\//, ''));
      expect(existsSync(p), `${u} مذكور في fonts.css وغير موجود`).toBe(true);
    }
  });

  it('🔴 ولا يُجلب شيءٌ من الشبكة', () => {
    expect(
      /https?:/.test(fonts),
      'رابطٌ خارجي في fonts.css يُعيد التبعية التي أُزيلت من index.html',
    ).toBe(false);
  });

  it('font-display: swap — النصّ يظهر فوراً بخطٍّ احتياطي ريثما يُحمّل', () => {
    expect((fonts.match(/font-display:\s*swap;/g) ?? []).length).toBe(8);
  });
});
