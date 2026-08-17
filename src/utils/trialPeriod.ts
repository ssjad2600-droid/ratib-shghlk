/**
 * حساب التجربة المجانية — مرساةٌ لا يملكها المستخدم، و«الآن» لا تحدّده ساعته.
 *
 * 🔴 العلّة: كان الحساب كلّه في `App.tsx` على مُدخَلين **كلاهما بيد المستخدم**:
 *
 * ```ts
 * const created  = new Date(user.createdAt);            // حقلٌ يملك صلاحية كتابته
 * const daysUsed = Math.floor((Date.now() - created.getTime()) / 86400000);  // ساعة جهازه
 * ```
 *
 * وثلاثة طرقٍ للالتفاف، ترتيبها بالسهولة:
 *
 *  ١. **حذف الحقل** — وهذه أسهلها وأخطرها. كان `useProfile` يقرأ
 *     `createdAt: d.createdAt ?? new Date().toISOString()`، أي **يخترع «الآن» في كل قراءة**
 *     حين يغيب الحقل. فالتجربة لا تبدأ أصلاً، وتبقى ١٤ يوماً إلى الأبد.
 *     ⚠️ وليست نظرية: قِسْتُ حساباً حقيقياً في قاعدة البيانات بلا `createdAt` إطلاقاً.
 *  ٢. **إعادة كتابته** بتاريخ اليوم — قاعدة `/users/{uid}` تمنح المالك كتابةً بلا قيد حقول.
 *  ٣. **إرجاع ساعة ويندوز** — `Date.now()` يصغر فيصغر `daysUsed`.
 *
 * 🛡️ والعلاج هنا ثلاث طبقات، كلها **تفشل إلى الأمان** (تمنح المهلة ولا تمنعها عند الشك):
 *
 *  · مرساة بداية `trialStartedAt` **يختمها الخادم** (`serverTimestamp`)، لا ساعة الجهاز.
 *  · «الآن» = **أكبر** من ساعة الجهاز وآخر لحظة خادمٍ رآها الحساب (`lastSeenAt`) —
 *    فإرجاع الساعة لا ينفع: الخادم رأى وقتاً لاحقاً وسُجِّل.
 *  · سقفٌ على المتبقّي: مرساةٌ في المستقبل لا تمنح أكثر من TRIAL_DAYS.
 *
 * ⚖️ وحدُّ ما يفعله هذا الملف بصراحة: يغلق الالتفافات الثلاثة أعلاه (وهي ما يفعله تاجر
 * بأدوات المطوّر أو بساعة النظام). ولا يغلق **تعديل حزمة التطبيق نفسها** — ذاك لا يُغلق
 * إلا بقاعدة خادمية تمنع الكتابة، وهي مرتبةٌ أخرى من التغيير.
 */

export const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialInputs {
  /** مرخّص بكودٍ مؤكَّد خادمياً ⟵ لا تجربة ولا بوابة إطلاقاً. */
  licensed: boolean;
  /** ختم الخادم لبداية التجربة (ms). المرساة الموثوقة. */
  trialStartedAtMs?: number | null;
  /** `createdAt` القديم (ISO) — مرساة الحسابات المنشأة قبل الختم الخادمي. */
  legacyCreatedAt?: string | null;
  /** آخر لحظة خادمٍ رآها هذا الحساب (ms) — تمنع إرجاع ساعة الجهاز. */
  lastSeenAtMs?: number | null;
  /** ساعة الجهاز. */
  deviceNowMs: number;
}

export interface TrialState {
  /** الأيام المتبقية، أو null للمرخّص أو لِمَن لم تُختم مرساته بعد (لا بوابة عندها). */
  daysRemaining: number | null;
  expired: boolean;
  /** المرساة المستعملة فعلاً (ms) — للتشخيص. */
  anchorMs: number | null;
  /** لا مرساة ⟵ على الطبقة الأعلى أن تختمها. */
  needsAnchor: boolean;
  /** ساعة الجهاز خلف ما رآه الخادم ⟵ استُعمل ختم الخادم بدلها. */
  clockRewound: boolean;
}

/**
 * قراءة طابع زمني من أشكاله الممكنة في Firestore.
 *
 * ⚠️ `null` حالةٌ حقيقية لا خطأ: حقل `serverTimestamp()` يُقرأ **null محلياً** حتى يؤكّده
 * الخادم. تُعامَل كغياب فيسقط الحساب على المرساة القديمة — لا كصفرٍ يُنهي التجربة فوراً.
 */
export function toMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }
  // Firestore Timestamp
  const ts = value as { toMillis?: () => number; seconds?: number };
  if (typeof ts.toMillis === 'function') {
    const t = ts.toMillis();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return null;
}

export function trialStateOf(i: TrialInputs): TrialState {
  const base: TrialState = {
    daysRemaining: null, expired: false, anchorMs: null,
    needsAnchor: false, clockRewound: false,
  };

  // المرخّص خارج الحساب كلّه — لا بوابة ولا عدّاد.
  if (i.licensed) return base;

  const anchor = toMillis(i.trialStartedAtMs) ?? toMillis(i.legacyCreatedAt);

  /**
   * لا مرساة بعد ⟵ **لا نُنهي التجربة**، ونطلب ختمها.
   *
   * هذا فشلٌ إلى الأمان مقصود: الحساب الجديد بين إنشائه ووصول ختم الخادم يمرّ بلحظات
   * بلا مرساة. لو حسبناها انتهاءً لرأى تاجرٌ جديد بوابة الترخيص في أول ثانية.
   */
  if (anchor === null) return { ...base, needsAnchor: true };

  const seen = toMillis(i.lastSeenAtMs) ?? 0;
  const clockRewound = seen > i.deviceNowMs;
  const effectiveNow = Math.max(i.deviceNowMs, seen);

  const daysUsed = Math.floor((effectiveNow - anchor) / DAY_MS);
  // السقف يمنع مرساةً في المستقبل من منح أكثر من المدة، والأرضية تمنع الأيام السالبة.
  const daysRemaining = Math.max(0, Math.min(TRIAL_DAYS, TRIAL_DAYS - daysUsed));

  return {
    daysRemaining,
    expired: daysRemaining <= 0,
    anchorMs: anchor,
    needsAnchor: false,
    clockRewound,
  };
}

/** نهاية التجربة بصيغة ISO — تُنشر في `public/info` ليحسبها الموظف محلياً. */
export function trialEndsAtISO(anchorMs: number | null): string {
  if (anchorMs === null) return '';
  return new Date(anchorMs + TRIAL_DAYS * DAY_MS).toISOString();
}
