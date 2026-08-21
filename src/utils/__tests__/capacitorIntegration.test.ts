import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { compareVersions, isNewerVersion, updateFrom, releasePlatform } from '../appUpdate';
import { safeFilename, blobToBase64, saveFile, SaveDeps } from '../saveFile';
import { openExternal, OpenDeps } from '../openExternal';
import { printWindowError, canPrint, PRINT_ON_PHONE_MESSAGE, POPUP_BLOCKED_MESSAGE } from '../printSupport';

/**
 * تكامل Capacitor (المرحلة ج) — ما ينكسر داخل WebView.
 *
 * كل ما هنا يحرس علّةً **حقيقية** في التغليف: تنزيلٌ لا يحدث، رابطٌ يُبتلع،
 * رسالةٌ تطلب من التاجر ما لا يستطيع فعله، وإصدارٌ لا يُقارَن صحيحاً.
 */

const root = process.cwd();

describe('🔴 مقارنة الإصدارات', () => {
  it('🔴 ١٫١٠٫٠ أحدث من ١٫٩٫٠ — والمقارنة النصّية تعكسها', () => {
    expect(
      isNewerVersion('1.10.0', '1.9.0'),
      "'1.10.0' > '1.9.0' نصّياً = false، فيبقى التاجر على القديمة للأبد",
    ).toBe(true);
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
  });

  it('المتساويان لا يُنتجان إشعاراً', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  });

  it('أطوالٌ مختلفة تُقارَن بالأصفار الضمنية', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(isNewerVersion('1.2.1', '1.2')).toBe(true);
  });

  it('اللواحق تُتجاهَل بأمان بدل أن ترمي', () => {
    expect(() => compareVersions('1.0.0-beta.2', '1.0.0')).not.toThrow();
    expect(compareVersions('2.0.0', '1.0.0-beta')).toBe(1);
  });
});

describe('🔴 قرار عرض التحديث — متحفّظ عمداً', () => {
  const CUR = '1.0.0';
  const ok = { version: '1.1.0', url: 'https://ratib.example/app.apk', notes: 'إصلاحات' };

  it('يعرض عند توفّر إصدارٍ أحدث ورابطٍ سليم', () => {
    expect(updateFrom(ok, CUR)).toEqual({ version: '1.1.0', url: ok.url, notes: 'إصلاحات' });
  });

  it('لا يعرض لنفس الإصدار أو أقدم', () => {
    expect(updateFrom({ ...ok, version: '1.0.0' }, CUR)).toBeNull();
    expect(updateFrom({ ...ok, version: '0.9.0' }, CUR)).toBeNull();
  });

  it('🔴 وثيقةٌ ناقصة ⟶ لا إشعار (إشعارٌ برابطٍ فارغ يُربك ولا يُفيد)', () => {
    expect(updateFrom(null, CUR)).toBeNull();
    expect(updateFrom({}, CUR)).toBeNull();
    expect(updateFrom({ version: '2.0.0' }, CUR), 'بلا رابط').toBeNull();
    expect(updateFrom({ url: ok.url }, CUR), 'بلا إصدار').toBeNull();
  });

  it('🔴 روابط غير https تُرفض — الوثيقة عامّة ويقرؤها كل المستخدمين', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://insecure/app.apk', 'file:///c/x']) {
      expect(updateFrom({ ...ok, url }, CUR), url).toBeNull();
    }
  });

  it('أنواعٌ غير نصّية لا تُمرَّر', () => {
    expect(updateFrom({ version: 2, url: ok.url }, CUR)).toBeNull();
    expect(updateFrom({ ...ok, notes: 123 }, CUR)?.notes).toBe('');
  });
});

describe('منصّة الإصدار', () => {
  it('أندرويد وiOS وويندوز تُعرف', () => {
    expect(releasePlatform(true, 'android', false)).toBe('android');
    expect(releasePlatform(true, 'ios', false)).toBe('ios');
    expect(releasePlatform(false, 'web', true)).toBe('windows');
  });

  it('🔴 المتصفّح لا يُفحص — يُحدَّث بذاته وإشعارٌ فيه مُربك', () => {
    expect(releasePlatform(false, 'web', false)).toBeNull();
  });
});

describe('🔴 حفظ الملفات — التنزيل لا يعمل في WebView', () => {
  const deps = (isNative: boolean) => {
    const calls = { web: [] as string[], write: [] as string[], share: [] as string[] };
    const d: SaveDeps = {
      isNative: () => isNative,
      webSave: (_b, n) => { calls.web.push(n); },
      nativeWrite: async o => { calls.write.push(o.path); return { uri: `file:///cache/${o.path}` }; },
      nativeShare: async o => { calls.share.push(o.files[0]); },
    };
    return { d, calls };
  };

  it('على الكمبيوتر: تنزيلٌ كما كان تماماً', async () => {
    const { d, calls } = deps(false);
    expect(await saveFile(new Blob(['x']), 'تقرير.csv', d)).toBe('downloaded');
    expect(calls.web).toEqual(['تقرير.csv']);
    expect(calls.share, 'ورقة مشاركة على الكمبيوتر تغييرٌ غير مطلوب').toEqual([]);
  });

  it('🔴 على الهاتف: يُكتب ثم يُشارَك', async () => {
    const { d, calls } = deps(true);
    expect(await saveFile(new Blob(['x']), 'نسخة.json', d)).toBe('shared');
    expect(calls.write).toEqual(['نسخة.json']);
    expect(calls.share).toEqual(['file:///cache/نسخة.json']);
    expect(calls.web, '`<a download>` لا يعمل في WebView').toEqual([]);
  });

  it('🔴 فشل الكتابة يرمي — ولا يُدَّعى نجاحٌ كاذب', async () => {
    const { d } = deps(true);
    d.nativeWrite = async () => { throw new Error('no space'); };
    await expect(
      saveFile(new Blob(['x']), 'a.json', d),
      'ابتلاعُ الفشل يجعل التاجر يظنّ نسخته الاحتياطية محفوظة',
    ).rejects.toThrow();
  });
});

describe('أسماء الملفات', () => {
  it('🔴 العربية تبقى — هي ما يُعرّف التاجر بملفه', () => {
    expect(safeFilename('نسخة_رتب_شغلك_٢٠٢٦.json')).toContain('نسخة');
  });

  it('المحارف التي يرفضها نظام الملفات تُستبدل', () => {
    const out = safeFilename('تقرير/الديون:٢٠٢٦*?.csv');
    for (const c of ['/', ':', '*', '?']) expect(out, c).not.toContain(c);
  });

  it('المسافات تصير شرطات سفلية ولا يبقى الاسم فارغاً', () => {
    expect(safeFilename('تقرير الديون.csv')).toBe('تقرير_الديون.csv');
    expect(safeFilename('///').length).toBeGreaterThan(0);
  });

  it('الطول محدود — أندرويد يقصّ ما تجاوز حدّه', () => {
    expect(safeFilename('ا'.repeat(500)).length).toBeLessThanOrEqual(100);
  });

  it('🔴 محارف التحكّم وبايت NUL تُزال', () => {
    const out = safeFilename('تقرير\u0000سرّي\u001Fمخفي.csv');
    expect(out, 'بايت NUL في اسمٍ قد يقصّ الاسم صامتاً في طبقاتٍ أدنى')
      .not.toMatch(/[\u0000-\u001F]/);
    expect(out, 'وبقيّة الاسم تبقى مفهومة').toContain('تقرير');
  });
});

/**
 * 🔴 حارسٌ على المصدر نفسه: لا بايتات تحكّم في أي ملفٍ نصّي.
 *
 * وُلد من عطلٍ وقع فعلاً في هذا الملف بالذات: كُتب `ILLEGAL` بمحارف تحكّمٍ
 * **حرفية** (NUL و0x1F) بدل ترميز `\u`. فصار `saveFile.ts` ملفاً «ثنائياً» عند
 * git وgrep: لا يُعرض في diff، ولا يُبحث فيه، ولا تُطابقه أدوات التحرير — أي أن
 * أي مراجعةٍ لاحقة تمرّ فوقه عمياء. والسلوك كان سليماً بالمصادفة، وهذا أسوأ:
 * عطلٌ لا يُنتج عرَضاً هو عطلٌ يبقى.
 */
describe('🔴 نظافة المصدر', () => {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-app', 'android', 'build', '.gradle', 'coverage']);
  const TEXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.html', '.rules']);

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (TEXT.has(extname(name))) out.push(p);
    }
    return out;
  };

  const files = walk(root);

  it('المسح يرى الملفات فعلاً (حماية من فحصٍ فارغ يمرّ كذباً)', () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it('🔴 ولا بايت تحكّمٍ في أيٍّ منها', () => {
    const bad: string[] = [];
    for (const f of files) {
      const buf = readFileSync(f);
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        // مسموح: TAB وLF وCR فقط
        if (b < 0x20 && b !== 9 && b !== 10 && b !== 13) {
          bad.push(`${f.replace(root, '').replace(/\\/g, '/')} @${i} = 0x${b.toString(16)}`);
          break;
        }
      }
    }
    expect(
      bad,
      'ملفٌ فيه بايت تحكّم يُعامَل ثنائياً: لا diff ولا بحث ولا مراجعة',
    ).toEqual([]);
  });
});

describe('تحويل base64', () => {
  it('يحوّل بلا تلف', async () => {
    const b64 = await blobToBase64(new Blob([new Uint8Array([0, 1, 2, 253, 254, 255])]));
    expect(atob(b64).split('').map(c => c.charCodeAt(0))).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it('🔴 وملفٌ كبير لا يتجاوز حدّ معاملات الدالة', async () => {
    const big = new Uint8Array(200_000).fill(65);
    await expect(
      blobToBase64(new Blob([big])),
      'String.fromCharCode(...arr) على مصفوفٍ كبير يرمي RangeError',
    ).resolves.toBeTypeOf('string');
  });
});

describe('🔴 الروابط الخارجية — واتساب', () => {
  const deps = (isNative: boolean, launchFails = false) => {
    const calls = { launch: [] as string[], web: [] as string[] };
    const d: OpenDeps = {
      isNative: () => isNative,
      launch: async u => { calls.launch.push(u); if (launchFails) throw new Error('no app'); },
      webOpen: u => { calls.web.push(u); },
    };
    return { d, calls };
  };
  const URL = 'https://wa.me/9647701234567?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7';

  it('على الكمبيوتر: تبويبٌ جديد كما كان', async () => {
    const { d, calls } = deps(false);
    expect(await openExternal(URL, d)).toBe(true);
    expect(calls.web).toEqual([URL]);
    expect(calls.launch).toEqual([]);
  });

  it('🔴 على الهاتف: يُسلَّم للنظام ليفتح تطبيق واتساب نفسه', async () => {
    const { d, calls } = deps(true);
    expect(await openExternal(URL, d)).toBe(true);
    expect(
      calls.launch,
      'متصفّحٌ داخلي يعرض واتساب-ويب ويطلب مسح QR — أسوأ من لا شيء',
    ).toEqual([URL]);
  });

  it('🔴 وتعذُّر التسليم يسقط إلى المتصفّح ولا يرمي', async () => {
    const { d, calls } = deps(true, true);
    expect(
      await openExternal(URL, d),
      'رمْيٌ هنا يُسقط الشاشة التي يعمل فيها التاجر لأجل رسالة واتساب',
    ).toBe(true);
    expect(calls.web).toEqual([URL]);
  });
});

describe('🔴 رسالة الطباعة تختلف بالمنصّة', () => {
  it('على الهاتف: تقول الحقيقة وتعطي بديلاً', () => {
    expect(printWindowError(true)).toBe(PRINT_ON_PHONE_MESSAGE);
    expect(printWindowError(true)).toMatch(/الكمبيوتر/);
    expect(
      printWindowError(true),
      '«اسمح بالنوافذ المنبثقة» نصيحةٌ لا يستطيع تنفيذها داخل التطبيق',
    ).not.toMatch(/المنبثقة/);
  });

  it('على المتصفّح: الرسالة الأصلية كما كانت', () => {
    expect(printWindowError(false)).toBe(POPUP_BLOCKED_MESSAGE);
  });

  it('و`canPrint` تُخفي الأزرار حيث لا طباعة', () => {
    expect(canPrint(false)).toBe(true);
    expect(canPrint(true)).toBe(false);
  });

  it('🔴 ولا نصّ طباعةٍ مكرّر باقٍ في مولّدات الطباعة', () => {
    const files = ['printReceipt', 'printInvoices', 'printPurchaseList', 'barcodeLabels', 'exportDoc'];
    for (const f of files) {
      const src = readFileSync(join(root, 'src', 'utils', `${f}.ts`), 'utf8')
        .replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
      expect(src, `${f}: نصٌّ مكرّر ينحرف عن المصدر الموحّد`).not.toMatch(/النوافذ المنبثقة/);
      expect(src, `${f}: لا يستعمل المصدر الموحّد`).toMatch(/printWindowError\(\)/);
    }
  });
});

describe('🔴 إعداد Capacitor', () => {
  const cfg = readFileSync(join(root, 'capacitor.config.ts'), 'utf8')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');

  it('🔴 androidScheme: https — سياقٌ آمن، وبدونه ينكسر توليد الأكواد وكلمات المرور', () => {
    expect(
      /androidScheme:\s*'https'/.test(cfg),
      "بـhttp يختفي crypto.getRandomValues فينكسر secureRandom — مسارٌ يمسّ المال",
    ).toBe(true);
  });

  it('تنقيح WebView مُطفأ — لا يُفتح دفتر التاجر عبر USB', () => {
    expect(/webContentsDebuggingEnabled:\s*false/.test(cfg)).toBe(true);
  });

  it('🔴 الهوية نفسها المستعملة في مثبّت ويندوز', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const m = cfg.match(/appId:\s*'([^']+)'/);
    expect(m, 'لا appId').not.toBeNull();
    expect(m![1], 'هويتان مختلفتان للمنتج نفسه تُربكان التوقيع والتحديث').toBe(pkg.build.appId);
  });

  it('مشروع أندرويد مُولَّد وموجود', () => {
    expect(existsSync(join(root, 'android', 'app', 'build.gradle'))).toBe(true);
  });
});

describe('🔴 CSP يسمح بأصل Capacitor', () => {
  const vite = readFileSync(join(root, 'vite.config.ts'), 'utf8')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');

  it('الأصلان مُعرَّفان', () => {
    expect(/capacitor:\/\/localhost/.test(vite)).toBe(true);
    expect(/https:\/\/localhost/.test(vite)).toBe(true);
  });

  it('🔴 ولم يُنقص شيءٌ كان مسموحاً على الكمبيوتر', () => {
    for (const kept of [
      'https://apis.google.com', 'https://www.gstatic.com', 'https://www.googletagmanager.com',
      'https://fonts.googleapis.com', 'https://fonts.gstatic.com',
      'https://*.googleapis.com', 'https://accounts.google.com',
      "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    ]) {
      expect(vite, `أُزيل «${kept}» — انحدارٌ في الكمبيوتر`).toContain(kept);
    }
  });
});
