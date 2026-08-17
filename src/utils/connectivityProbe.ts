/**
 * تمييز «إضافةٌ تحجب الاتصال» عن «لا إنترنت» عن «الخادم رفض».
 *
 * 🔴 العلّة التي وُلد منها هذا الملف — رُصدت في طرفية تاجر حقيقي:
 *
 * ```
 * firestore.googleapis.com/…&zx=ub1cn6btb8oh    net::ERR_BLOCKED_BY_CLIENT
 * ```
 *
 * `ERR_BLOCKED_BY_CLIENT` تعني أن الطلب **لم يخرج من الجهاز أصلاً**: منعته إضافةٌ في
 * المتصفح — مانع إعلانات أو درع خصوصية أو مضادّ فيروسات. ورابط فايرستور يحمل معاملاً
 * اسمه `zx` فيبدو لتلك الإضافات كأنه تتبّع، فتحجبه بالخطأ. علّةٌ معروفة مع uBlock
 * وBrave وKaspersky.
 *
 * 💥 وأثرها على منتجٍ **يُباع** أخطر مما تبدو: التاجر يرى بياناته لا تُحفظ وشاشاتٍ
 * فارغة، ويتّصل يقول «البرنامج خربان» — ولا يجد المزوّد شيئاً في حسابه، لأن العطل في
 * **جهاز التاجر لا في النظام**. ومكالمةٌ كهذه تُستهلك ساعةً ولا تنتهي بشيء.
 *
 * 🎯 والتمييز ممكن بيقين معقول:
 *   · `navigator.onLine === false`            ⟵ لا إنترنت (والبرنامج يعمل أوفلاين أصلاً)
 *   · الأصل يستجيب وفايرستور لا يستجيب        ⟵ **حجبٌ انتقائي** = إضافة
 *   · كلاهما لا يستجيب                        ⟵ الشبكة نفسها
 *
 * فالفحص المزدوج هو ما يمنع اتّهام إضافةٍ بريئة حين يكون الإنترنت هو المقطوع.
 */

export type Reachability = 'ok' | 'blocked' | 'offline' | 'network';

/** يُحقن في الاختبارات — لا لتخفيف شيء بل ليُختبر المنطق بلا شبكة. */
export interface ProbeDeps {
  fetch: typeof fetch;
  online: () => boolean;
  origin: string;
}

/**
 * عنوان فايرستور المستهدف. نطلبه بـ`no-cors` فلا نحتاج صلاحية قراءة ولا مصادقة —
 * يكفينا أن نعرف: هل خرج الطلب أم مُنع؟
 */
const FIRESTORE_PROBE = 'https://firestore.googleapis.com/generate_204';

const timeoutFetch = async (f: typeof fetch, url: string, ms: number): Promise<boolean> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    await f(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return true;   // وصل — ولو كانت الاستجابة معتمة (opaque)
  } catch {
    return false;  // مُنع، أو انقطعت الشبكة، أو انتهت المهلة
  } finally {
    clearTimeout(timer);
  }
};

/**
 * يفحص الوصول. الفحصان **متوازيان** كي لا يتضاعف الانتظار على تاجرٍ شبكته بطيئة.
 */
export async function probeReachability(
  deps: ProbeDeps,
  timeoutMs = 6000,
): Promise<Reachability> {
  if (!deps.online()) return 'offline';

  const [selfOk, firestoreOk] = await Promise.all([
    timeoutFetch(deps.fetch, `${deps.origin}/?probe=${Date.now()}`, timeoutMs),
    timeoutFetch(deps.fetch, FIRESTORE_PROBE, timeoutMs),
  ]);

  if (firestoreOk) return 'ok';
  // الأصل يستجيب وفايرستور وحده لا ⟵ حجبٌ انتقائي، وهذا توقيع الإضافات
  if (selfOk) return 'blocked';
  return 'network';
}

/** رسالة يفهمها صاحب المحل — تقول ما الخطب **وماذا يفعل**، لا ما حدث تقنياً فقط. */
export function reachabilityMessage(r: Reachability): string | null {
  switch (r) {
    case 'blocked':
      return 'يبدو أن إضافةً في متصفّحك (مانع إعلانات أو درع خصوصية) تحجب الاتصال بالخادم. '
        + 'عطّلها لهذا الموقع من أيقونة الإضافة، أو استعمل نسخة سطح المكتب — فهي بلا إضافات.';
    case 'network':
      return 'تعذّر الوصول إلى الإنترنت. عملك محفوظ على الجهاز وسيُزامَن تلقائياً عند عودة الاتصال.';
    case 'offline':
      return null;  // البرنامج يعمل أوفلاين بالتصميم — لا داعي لإنذار
    default:
      return null;
  }
}
