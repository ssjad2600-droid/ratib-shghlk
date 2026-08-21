/**
 * مكدّس تنقّلٍ صغير — بديلٌ عن Router لأجل زرّ الرجوع.
 *
 * 🔴 العلّة: التنقّل في البرنامج حالةٌ واحدة (`activeTab` في App.tsx) بلا Router
 * وبلا سجلّ متصفّح. فزرّ الرجوع في أندرويد **يُغلق التطبيق من أي شاشة**: يفتح
 * التاجر «الديون»، يضغط رجوع ظانّاً أنه يعود للرئيسية، فيخرج من البرنامج.
 * وهذا أول ما يجرّبه أي مستخدم أندرويد، وأسرع سببٍ لتقييمٍ بنجمة.
 *
 * 🎯 ولماذا لا نُضيف Router؟ لأن ٢٤ ألف سطرٍ من المكوّنات مبنيّةٌ على `setActiveTab`،
 * وإدخال مسارات يعني لمس كل شاشة، وتغيير بنية التطبيق كلّه لأجل زرّ. المكدّس
 * هنا ~٤٠ سطراً، ويُغطّي **أندرويد والمتصفّح معاً**: أندرويد عبر حدث Capacitor،
 * والـPWA عبر `popstate` — وكلاهما يستدعي نفس `back()`.
 *
 * ⚠️ والمنطق هنا **خالص بلا DOM**: يُختبر وحدةً، ولا يعتمد على متصفّح ولا على
 * Capacitor. الوصل بالمنصّة في `hooks/useHardwareBack.ts`.
 */

/**
 * سقفٌ لطول المكدّس. جلسة تاجرٍ تمتدّ يوماً كاملاً وهو يتنقّل بين الشاشات مئات
 * المرّات؛ بلا سقفٍ ينمو المصفوف بلا حدّ. و٣٠ خطوةً أعمق مما يرجع إليه أحد.
 */
export const MAX_DEPTH = 30;

export interface NavHistory {
  /** يسجّل انتقالاً إلى شاشة. الانتقال إلى الشاشة نفسها لا يُسجَّل. */
  push(id: string): void;
  /** يرجع خطوةً ويُعيد الشاشة الجديدة، أو `null` إن كنّا في الجذر. */
  back(): string | null;
  /** الشاشة الحالية. */
  current(): string;
  /** عدد الخطوات المسجَّلة (١ = الجذر). */
  depth(): number;
  /** يُعيد الضبط إلى جذرٍ جديد — عند تبديل المستخدم أو الخروج. */
  reset(id: string): void;
}

export function createNavHistory(initial: string): NavHistory {
  let stack: string[] = [initial];

  return {
    push(id) {
      if (stack[stack.length - 1] === id) return;
      stack.push(id);
      // نقتطع من **البداية**: الأقدم هو الأولى بالنسيان، والجذر يُعاد ضمناً
      // لأن `back()` يتوقّف عند آخر عنصرٍ متبقٍّ مهما كان.
      if (stack.length > MAX_DEPTH) stack = stack.slice(stack.length - MAX_DEPTH);
    },

    back() {
      if (stack.length <= 1) return null;
      stack.pop();
      return stack[stack.length - 1];
    },

    current() {
      return stack[stack.length - 1];
    },

    depth() {
      return stack.length;
    },

    reset(id) {
      stack = [id];
    },
  };
}

/**
 * سجلّ معترضات الرجوع — ما يجب أن يُغلَق **قبل** أن نرجع شاشةً.
 *
 * 🔴 بدونه: يفتح التاجر نافذة «تسديد دين»، يضغط رجوع لإلغائها، فتبقى النافذة
 * مفتوحة وتتبدّل الشاشة تحتها. والأسوأ أن نافذةً بها مبلغٌ نصف مكتوب تظلّ فوق
 * شاشةٍ أخرى — فيضغط «حفظ» ظانّاً أنه في السياق الأول.
 *
 * والترتيب **آخِرُ مسجَّلٍ أوّلُ منفَّذ**: النافذة الأحدث هي الأعلى بصرياً.
 */
type BackInterceptor = () => boolean;

const interceptors: BackInterceptor[] = [];

/** يسجّل معترضاً ويُعيد دالةَ إلغاء التسجيل. */
export function registerBackInterceptor(fn: BackInterceptor): () => void {
  interceptors.push(fn);
  return () => {
    const i = interceptors.indexOf(fn);
    if (i !== -1) interceptors.splice(i, 1);
  };
}

/** ينفّذ أعلى معترضٍ يقبل التعامل. يُعيد true إن استُهلك الرجوع. */
export function runBackInterceptors(): boolean {
  for (let i = interceptors.length - 1; i >= 0; i--) {
    if (interceptors[i]()) return true;
  }
  return false;
}

/** للاختبارات فقط — يُفرغ السجلّ بين الحالات. */
export function _clearBackInterceptors(): void {
  interceptors.length = 0;
}

/**
 * حارس الخروج — ضغطتان لا واحدة.
 *
 * 🔴 الخروج من ضغطةٍ واحدة على الجذر يُخرج التاجر من برنامجه بلمسةٍ عرَضية وهو
 * في منتصف يومه. والضغطة الثانية خلال مهلةٍ قصيرة تُثبت أنه يقصد الخروج فعلاً.
 * (نافذة تأكيدٍ كانت ستكون أثقل: إجابةٌ إجباريةٌ على سؤالٍ لم يُطرح.)
 */
export function createExitGuard(windowMs = 2000) {
  let lastAt = -Infinity;
  return {
    /** `true` ⟵ اخرج الآن. `false` ⟵ اعرض التلميح وانتظر ضغطةً ثانية. */
    press(now: number = Date.now()): boolean {
      if (now - lastAt <= windowMs) {
        lastAt = -Infinity;   // لا تُحتسب ضغطةٌ ثالثة على أنها بداية دورةٍ جديدة
        return true;
      }
      lastAt = now;
      return false;
    },
  };
}

/** ما الذي يجب أن يحدث عند ضغط الرجوع. */
export type BackOutcome = 'closed' | 'navigated' | 'root';

/**
 * القرار الموحَّد: أغلِق نافذةً، وإلا ارجع شاشةً، وإلا فنحن في الجذر.
 * تُستدعى من أندرويد ومن المتصفّح معاً — فالسلوك واحدٌ على المنصّتين.
 */
export function decideBack(
  history: NavHistory,
  onNavigate: (tab: string) => void,
): BackOutcome {
  if (runBackInterceptors()) return 'closed';
  const previous = history.back();
  if (previous === null) return 'root';
  onNavigate(previous);
  return 'navigated';
}
