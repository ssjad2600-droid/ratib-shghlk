/**
 * تسجيل عامل الخدمة (Service Worker) — بحارسٍ يمنعه داخل Electron.
 *
 * 🔴 لماذا الحارس؟ عامل الخدمة يخزّن ملفات التطبيق ليعمل بلا إنترنت. هذا مطلوبٌ
 * في المتصفح وعلى الهاتف، لكنه **خطرٌ صريح داخل نسخة سطح المكتب**:
 *
 * نسخة Electron تُقدَّم من خادمٍ محلي على `http://localhost:38473` — وهو أصلٌ
 * ثابتٌ لا يتغيّر بين الإصدارات. فلو سُجّل عامل خدمة هناك، بقي مخزَّنه بعد تثبيت
 * تحديثٍ جديد، وظلّ يُقدّم **ملفات النسخة القديمة** من القرص. النتيجة عند التاجر:
 * «حدّثتُ البرنامج ولم يتغيّر شيء» — وهو عطلٌ يستحيل تشخيصه عن بُعد لأن الملفات
 * على القرص صحيحة فعلاً.
 *
 * والكشف بـuserAgent: Electron يضع `Electron/<version>` في وكيل المستخدم. ولا
 * يوجد جسر `window.electron` في هذا المشروع (contextIsolation بلا preload)،
 * فهذا أوثق ما هو متاح.
 *
 * ⚠️ ولا يُخزَّن أي طلبٍ خارجي: لفايرستور مخزنه الخاص في IndexedDB، وتخزين
 * استجاباته مرةً أخرى يعني بياناتٍ قديمةً تُعرض على أنها حديثة — وهذا في برنامج
 * محاسبةٍ أسوأ من عدم العرض أصلاً.
 */

/** هل نعمل داخل نسخة سطح المكتب؟ */
export function isElectron(ua: string = navigator.userAgent): boolean {
  return / Electron\//i.test(ua) || /^Electron\//i.test(ua);
}

export interface SWDeps {
  ua: string;
  container?: ServiceWorkerContainer;
  /**
   * يُعطَّل في التطوير: `sw.js` لا يُولَّد إلا في البناء، فيردّ خادم Vite صفحة
   * `index.html` مكانه ويرفض المتصفح التسجيل بخطأ MIME في الطرفية عند كل تحميل.
   */
  enabled?: boolean;
}

export type SWOutcome =
  | 'registered' | 'skipped-electron' | 'skipped-dev' | 'unsupported' | 'failed';

/**
 * يسجّل عامل الخدمة في المتصفح والهاتف، ويُلغيه إن وُجد داخل Electron.
 *
 * القيمة المعادة تصف ما جرى — تُستعمل في الاختبارات وفي التشخيص.
 */
export async function setupServiceWorker(
  deps: SWDeps = {
    ua: navigator.userAgent,
    container: navigator.serviceWorker,
    enabled: import.meta.env.PROD,
  },
): Promise<SWOutcome> {
  const { ua, container, enabled = true } = deps;
  if (!container) return 'unsupported';

  // 🔴 حارس Electron **قبل** حارس التطوير عمداً: الإلغاء الاحتياطي أدناه يجب أن
  // يعمل في كل حالة، فتسجيلٌ قديم بقي من خطأٍ سابق يُجمّد سطح المكتب على إصدارٍ
  // قديم سواء أكنّا في تطويرٍ أم إنتاج.
  if (isElectron(ua)) {
    // إلغاء أي تسجيلٍ سابق: لو سُجّل يوماً بخطأ، بقاؤه يُجمّد التطبيق على نسخةٍ قديمة
    try {
      const regs = await container.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    } catch { /* الإلغاء محاولةٌ احتياطية — فشلها لا يمنع الإقلاع */ }
    return 'skipped-electron';
  }

  if (!enabled) return 'skipped-dev';

  try {
    await container.register('./sw.js', { scope: './' });
    return 'registered';
  } catch {
    // فشل التسجيل لا يُعطّل شيئاً: التطبيق يعمل بلا عامل خدمة، وفايرستور
    // يتكفّل بالعمل أوفلاين. لا نُزعج التاجر برسالةٍ لا يملك حيالها فعلاً.
    return 'failed';
  }
}
