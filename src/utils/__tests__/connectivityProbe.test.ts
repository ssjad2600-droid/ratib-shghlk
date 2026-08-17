import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeReachability, reachabilityMessage, ProbeDeps } from '../connectivityProbe';

/**
 * 🔴 «إضافةٌ تحجب الاتصال» — علّةٌ رُصدت في طرفية تاجر حقيقي:
 *
 *     firestore.googleapis.com/…&zx=…    net::ERR_BLOCKED_BY_CLIENT
 *
 * ومانع الإعلانات يحجب رابط فايرستور لأنه يحمل معاملاً اسمه `zx` فيبدو كأنه تتبّع.
 * وأثرها على منتجٍ **يُباع**: التاجر يرى بياناته لا تُحفظ، ويتّصل يقول «البرنامج خربان»،
 * ولا يجد المزوّد شيئاً في حسابه — لأن العطل في جهاز التاجر لا في النظام.
 */

/** يبني بيئة فحصٍ: أي عنوان ينجح وأيّه يُمنع. */
const deps = (opts: { online?: boolean; selfOk?: boolean; firestoreOk?: boolean }): ProbeDeps => ({
  online: () => opts.online ?? true,
  origin: 'http://localhost:3000',
  fetch: vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const ok = /firestore\.googleapis/.test(u) ? (opts.firestoreOk ?? true) : (opts.selfOk ?? true);
    if (!ok) throw new TypeError('Failed to fetch');   // ما يرميه المتصفح عند الحجب
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch,
});

describe('🔴 تمييز الحجب عن انقطاع الشبكة', () => {
  it('كلاهما يستجيب ⟵ سليم', async () => {
    expect(await probeReachability(deps({}))).toBe('ok');
  });

  it('🔴 الأصل يستجيب وفايرستور وحده لا ⟵ حجبٌ انتقائي (إضافة)', async () => {
    expect(
      await probeReachability(deps({ selfOk: true, firestoreOk: false })),
      'هذا توقيع مانع الإعلانات: يمنع نطاقاً بعينه ويترك الباقي',
    ).toBe('blocked');
  });

  it('🔴 كلاهما لا يستجيب ⟵ الشبكة، لا الإضافة', async () => {
    expect(
      await probeReachability(deps({ selfOk: false, firestoreOk: false })),
      'اتّهام إضافةٍ بريئة حين يكون الإنترنت مقطوعاً يُضلّل التاجر',
    ).toBe('network');
  });

  it('المتصفح يقول «بلا اتصال» ⟵ offline بلا أي طلب', async () => {
    const d = deps({ online: false });
    expect(await probeReachability(d)).toBe('offline');
    expect(d.fetch, 'لا داعي لطلبٍ نعرف أنه سيفشل').not.toHaveBeenCalled();
  });

  it('🔴 الفحصان متوازيان — لا يتضاعف الانتظار على شبكة بطيئة', async () => {
    let concurrent = 0, peak = 0;
    const d: ProbeDeps = {
      online: () => true, origin: 'http://x',
      fetch: (async () => {
        peak = Math.max(peak, ++concurrent);
        await new Promise(r => setTimeout(r, 20));
        concurrent--;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    };
    await probeReachability(d);
    expect(peak, 'التسلسل يُضاعف زمن انتظار التاجر بلا فائدة').toBe(2);
  });

  it('المهلة تُنهي الفحص بدل أن يعلّق', async () => {
    const d: ProbeDeps = {
      online: () => true, origin: 'http://x',
      fetch: ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch,
    };
    expect(await probeReachability(d, 30)).toBe('network');
  });
});

describe('🔴 الرسالة تقول ماذا يفعل التاجر', () => {
  it('الحجب ⟵ تُسمّي السبب وتعطي مخرجين', () => {
    const m = reachabilityMessage('blocked')!;
    expect(m).toMatch(/إضافة/);
    expect(m, 'ذكرُ السبب بلا حلٍّ يترك التاجر عالقاً').toMatch(/عطّلها/);
    expect(m, 'نسخة سطح المكتب بلا إضافات — مخرجٌ ثانٍ').toMatch(/سطح المكتب/);
  });

  it('الشبكة ⟵ تطمئنه أن عمله محفوظ', () => {
    const m = reachabilityMessage('network')!;
    expect(m).toMatch(/محفوظ على الجهاز/);
    expect(m).toMatch(/يُزامَن/);
  });

  it('🔴 وبلا اتصال ⟵ **لا رسالة** — البرنامج يعمل أوفلاين بالتصميم', () => {
    expect(
      reachabilityMessage('offline'),
      'إنذارٌ على حالةٍ طبيعية يُدرّب التاجر على تجاهل الشريط',
    ).toBeNull();
  });

  it('والسليم بلا رسالة', () => {
    expect(reachabilityMessage('ok')).toBeNull();
  });
});

/**
 * 🔴 حارس: التشخيص موصول ولا يُغرق الشبكة.
 */
describe('حارس: التشخيص', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), 'src', ...p.split('/')), 'utf8')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const guard = read('utils/writeGuard.ts');
  const banner = read('components/WriteFailureBanner.tsx');

  it('المسح يرى الملفات', () => {
    expect(guard).toContain('reportWriteFailure');
    expect(banner).toContain('WriteFailureBanner');
  });

  it('🔴 الفشل يُطلق تشخيصاً', () => {
    expect(/void diagnoseOnce\(\)/.test(guard)).toBe(true);
  });

  it('🔴 ومهلة تهدئة تمنع إغراق شبكةٍ متعثّرة أصلاً', () => {
    expect(
      /Date\.now\(\) - lastProbeAt < PROBE_COOLDOWN_MS/.test(guard),
      'انهيار الاتصال يُنتج عشرات الأخطاء في ثانية — وفحصٌ لكلٍّ منها يزيد الطين بلّة',
    ).toBe(true);
    expect(/if \(probing/.test(guard), 'فحصان متوازيان بلا داعٍ').toBe(true);
  });

  it('🔴 والشريط يعرض السبب المُشخَّص', () => {
    expect(/reachabilityMessage\(currentDiagnosis\(\)/.test(banner)).toBe(true);
    expect(/\{cause \?/.test(banner)).toBe(true);
  });

  it('🔧 ويعرض مصدر كل عملية', () => {
    expect(
      /\{f\.source &&/.test(banner),
      'رسالةٌ لا تدلّ على مصدرها نصفُ رسالة — ترحيل؟ بيع؟ استيراد؟',
    ).toBe(true);
    expect(/source\?: string/.test(guard)).toBe(true);
  });

  it('🔴 وإخفاء الشريط يمسح التشخيص أيضاً', () => {
    expect(
      /diagnosis = null;/.test(guard),
      'بقاء تشخيصٍ قديم يُظهر سبباً زال',
    ).toBe(true);
  });
});
