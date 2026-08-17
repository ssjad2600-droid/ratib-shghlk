import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trialStateOf, trialEndsAtISO, toMillis, TRIAL_DAYS, TrialInputs } from '../trialPeriod';

/**
 * 🔴 التجربة المجانية كانت تُحسب من مُدخَلَين كلاهما بيد المستخدم.
 *
 * وهذه علّة **تجارية** لا تقنية: البرنامج يُباع، وحاجز التجربة هو ما يجعله يُباع.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);           // ١٧ آب ٢٠٢٦
const daysAgo = (n: number) => NOW - n * DAY;

const state = (over: Partial<TrialInputs> = {}) =>
  trialStateOf({ licensed: false, deviceNowMs: NOW, ...over });

describe('الحساب الأساسي', () => {
  it('حسابٌ جديد ⟵ المدة كاملة', () => {
    expect(state({ trialStartedAtMs: NOW }).daysRemaining).toBe(TRIAL_DAYS);
  });

  it('مضى نصف المدة ⟵ النصف الباقي', () => {
    expect(state({ trialStartedAtMs: daysAgo(7) }).daysRemaining).toBe(7);
  });

  it('انتهت المدة ⟵ صفر ومنتهية', () => {
    const s = state({ trialStartedAtMs: daysAgo(14) });
    expect(s.daysRemaining).toBe(0);
    expect(s.expired).toBe(true);
  });

  it('مضى أضعاف المدة ⟵ لا سالب', () => {
    expect(state({ trialStartedAtMs: daysAgo(900) }).daysRemaining).toBe(0);
  });

  it('المرخّص خارج الحساب كلّه — لا عدّاد ولا بوابة', () => {
    const s = trialStateOf({ licensed: true, trialStartedAtMs: daysAgo(900), deviceNowMs: NOW });
    expect(s.daysRemaining).toBeNull();
    expect(s.expired).toBe(false);
    expect(s.needsAnchor).toBe(false);
  });
});

describe('🔴 الالتفافات الثلاثة', () => {
  it('🔴 (١) حذف الحقل لا يُعيد التجربة — يُطلَب ختم مرساة، ولا تُخترع «الآن»', () => {
    const s = state({ trialStartedAtMs: null, legacyCreatedAt: null });
    expect(
      s.needsAnchor,
      'كان useProfile يخترع createdAt جديداً في كل قراءة ⟵ تجربة لا تنتهي أبداً',
    ).toBe(true);
    expect(s.anchorMs).toBeNull();
    // فشلٌ إلى الأمان: لا نحجب من لم تُختم مرساته بعد
    expect(s.expired).toBe(false);
    expect(s.daysRemaining).toBeNull();
  });

  it('🔴 (٢) مرساة في المستقبل لا تمنح أكثر من المدة', () => {
    const s = state({ trialStartedAtMs: NOW + 3650 * DAY });
    expect(
      s.daysRemaining,
      'تقديم التاريخ كان يجعل daysUsed سالباً فيمنح أكثر من ١٤ يوماً',
    ).toBe(TRIAL_DAYS);
  });

  it('🔴 (٣) إرجاع ساعة الجهاز لا يُحيي تجربة منتهية', () => {
    const s = trialStateOf({
      licensed: false,
      trialStartedAtMs: daysAgo(30),
      lastSeenAtMs: NOW,          // الخادم رأى اليوم فعلاً
      deviceNowMs: NOW - 60 * DAY, // والجهاز أُرجع شهرين
    });
    expect(s.expired, 'الحساب بساعة الجهاز وحدها كان يُعيد التجربة بضغطة على ساعة ويندوز').toBe(true);
    expect(s.clockRewound).toBe(true);
    expect(s.daysRemaining).toBe(0);
  });

  it('ساعة سليمة ⟵ لا يُبلَّغ عن إرجاع', () => {
    expect(state({ trialStartedAtMs: daysAgo(3), lastSeenAtMs: daysAgo(1) }).clockRewound).toBe(false);
  });
});

describe('توافق الحسابات القائمة (لا كسر ولا تقصير)', () => {
  it('حسابٌ قديم بـcreatedAt وحده يبقى محسوباً عليه', () => {
    const iso = new Date(daysAgo(5)).toISOString();
    const s = state({ legacyCreatedAt: iso });
    expect(s.daysRemaining).toBe(9);
    expect(s.anchorMs).toBe(daysAgo(5));
  });

  it('ختم الخادم يُقدَّم على createdAt متى وُجد', () => {
    const s = state({ trialStartedAtMs: daysAgo(2), legacyCreatedAt: new Date(daysAgo(90)).toISOString() });
    expect(s.daysRemaining).toBe(12);
  });

  it('🔴 createdAt تالف لا يُنهي تجربة أحد ظلماً', () => {
    const s = state({ legacyCreatedAt: 'ليس تاريخاً' });
    expect(s.needsAnchor).toBe(true);
    expect(s.expired).toBe(false);
  });
});

describe('🔴 قراءة الطوابع من أشكالها في Firestore', () => {
  it('serverTimestamp قبل تأكيد الخادم يُقرأ null ⟵ يُعامَل غياباً لا صفراً', () => {
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
    const s = state({ trialStartedAtMs: null, legacyCreatedAt: new Date(daysAgo(3)).toISOString() });
    expect(
      s.daysRemaining,
      'لو عُومل null صفراً لصار المرساة ١٩٧٠ ⟵ بوابة ترخيص فورية لكل تاجر',
    ).toBe(11);
  });

  it('يقرأ Timestamp و number و ISO', () => {
    expect(toMillis({ toMillis: () => 1500 })).toBe(1500);
    expect(toMillis({ seconds: 2 })).toBe(2000);
    expect(toMillis(1730000000000)).toBe(1730000000000);
    expect(toMillis('2026-08-17T12:00:00.000Z')).toBe(NOW);
  });

  it('القيم الفاسدة تُقرأ غياباً', () => {
    expect(toMillis(0)).toBeNull();
    expect(toMillis(-5)).toBeNull();
    expect(toMillis(NaN)).toBeNull();
    expect(toMillis('')).toBeNull();
    expect(toMillis({})).toBeNull();
  });
});

describe('نهاية التجربة المنشورة للموظف', () => {
  it('تُشتقّ من نفس المرساة', () => {
    expect(trialEndsAtISO(daysAgo(4))).toBe(new Date(daysAgo(4) + TRIAL_DAYS * DAY).toISOString());
  });

  it('بلا مرساة ⟵ نص فارغ (لا تاريخ مخترع)', () => {
    expect(trialEndsAtISO(null)).toBe('');
  });
});

/**
 * 🔴 حارس: المرساة لا تُخترع، والحساب لا يعود إلى الشاشة.
 */
describe('حارس: مرساة التجربة', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const profile = read('src/hooks/useProfile.ts');
  const app = read('src/App.tsx');
  const anchor = read('src/hooks/useTrialAnchor.ts');
  const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

  it('المسح يرى الملفات فعلاً', () => {
    expect(profile).toContain('extractProfile');
    expect(app).toContain('trialDaysRemaining');
    expect(anchor).toContain('serverTimestamp');
  });

  it('🔴 useProfile لا يخترع createdAt عند غيابه', () => {
    expect(
      /createdAt: d\.createdAt \?\? new Date\(\)/.test(profile),
      'اختراع «الآن» عند الغياب يجعل حذف الحقل يُعيد التجربة مع كل فتحة للبرنامج',
    ).toBe(false);
  });

  it('🔴 الشاشة لا تحسب التجربة بنفسها', () => {
    expect(/trialStateOf\(/.test(app)).toBe(true);
    expect(
      /Math\.floor\(diffMs \/ \(1000 \* 60 \* 60 \* 24\)\)/.test(app),
      'عودة الحساب المضمَّن تلتفّ على المنطق المحروس',
    ).toBe(false);
  });

  it('🔴 المرساة تُختم بوقت الخادم لا بساعة الجهاز', () => {
    expect(/trialStartedAt: serverTimestamp\(\)/.test(anchor)).toBe(true);
    expect(
      /trialStartedAt: (Date\.now\(\)|new Date\(\))/.test(anchor),
      'ختمٌ بساعة الجهاز يُمدَّد بضبط ساعة ويندوز قبل أول تشغيل',
    ).toBe(false);
    expect(/lastSeenAt: serverTimestamp\(\)/.test(anchor)).toBe(true);
  });

  /**
   * 🔴 عيبٌ كشفه شريط «لم يُحفظ» بعد دقائق من تركيبه — وهذا بالضبط غرضه.
   * أول لقطة للبروفايل قد تأتي من الكاش بلا المرساة، فيحاول الخطّاف ختمها والقاعدة
   * ترفض. وكانت الكتابتان مدموجتين، فيسقط دفاعُ إرجاع الساعة بسبب محاولةٍ لا لزوم لها.
   */
  it('🔴 الختم والنبضة كتابتان مستقلّتان — رفض أحدهما لا يُسقط الآخر', () => {
    expect(
      (anchor.match(/setDoc\(ref,/g) ?? []).length,
      'دمجُهما في setDoc واحدة يجعل رفضَ ختمٍ لا لزوم له يوقف نبضة الخادم',
    ).toBe(2);
    expect(
      /stampedRef/.test(anchor),
      'بلا حارس لمرة واحدة يتكرّر الرفض كل رندر بلا فائدة',
    ).toBe(true);
  });

  it('🔴 نهاية التجربة المنشورة للموظف من نفس المرساة', () => {
    expect(
      /trialEndsAtISO\(trial\.anchorMs\)/.test(app),
      'حسابان منفصلان يجعلان الموظف يرى نهايةً غير التي تحسب بها بوابة المالك',
    ).toBe(true);
  });

  it('🟠 القواعد تُثبّت المرساة فلا تُعاد كتابتها', () => {
    expect(
      /function trialAnchorPreserved\(\)/.test(rules),
      'بلا تثبيت خادمي يبقى الحقل قابلاً لإعادة الكتابة من أدوات المطوّر',
    ).toBe(true);
    expect(/lastSeenAt/.test(rules)).toBe(true);
  });
});
