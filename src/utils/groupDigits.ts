/**
 * فواصل المراتب في **خانات الإدخال** — «١٥٠٠٠٠٠» تُكتب فتُقرأ «١,٥٠٠,٠٠٠».
 *
 * 🔴 لماذا لم تكن موجودة؟ لأن العرض كان مفصولاً والإدخال لا. `formatCurrency`
 * تُخرج «٥٥٠,٠٠٠ د.ع» في كل الشاشات، لكن التاجر حين **يكتب** السعر يرى
 * «550000» صفاً واحداً بلا مراتب. وعدّ ستّة أصفارٍ بالعين هو بالضبط ما يُنتج
 * خطأ مرتبةٍ كاملة: مليونٌ يُكتب مئة ألف، أو العكس.
 *
 * 🎯 وهذه الدالة **للعرض وحده**. لا تمسّ ما يُحسب:
 *   · القراءة تمرّ بـ`readAmount`/`parseAmount`، وكلتاهما تُزيلان الفواصل أصلاً
 *     (اللاتينية `,` والعربية `،` وفاصلة الآلاف `٬`) — فلا يتغيّر أي حساب.
 *   · و`NumberInput` يُسلّم للمستدعي القيمة **مجرّدةً من الفواصل**، فتبقى
 *     معالِجات الحقول كما هي حرفياً.
 *
 * ⚠️ قاعدة السلامة: ما لا تفهمه الدالة **تُعيده كما هو**. نصٌّ نصفُ مكتوبٍ أو
 * غير رقميّ لا يُشوَّه ولا تُبتلع منه خانة — أسوأ ما يمكن أن يفعله منسّقُ مالٍ
 * هو أن يُغيّر رقماً ظنّاً منه أنه يُجمّله.
 */

/** الفاصل المعروض — نفس ما يُخرجه `toLocaleString('en-US')` في بقية التطبيق. */
export const GROUP_SEP = ',';

/** أرقام لاتينية وعربية-هندية وفارسية — التاجر قد يكتب بأيّها. */
const DIGIT = /[0-9٠-٩۰-۹]/;

/**
 * ما يُزال قبل التجميع: الفاصلة اللاتينية والعربية وفاصلة الآلاف والمسافات.
 * ⚠️ لا تشمل الفاصلة العشرية `.` ولا `٫` — إزالتهما تضرب مئةً في الرقم.
 */
const SEPARATORS = /[,،٬\s]/g;

/**
 * نسخة غير عامّة للفحص حرفاً حرفاً.
 * ⚠️ لا تُستعمل `SEPARATORS` هنا: راية `g` تجعل `lastIndex` يتغيّر بين
 * النداءات فيُرجع `test` نتائج متناوبة على نفس الحرف.
 */
const SEPARATOR_CHAR = /[,،٬\s]/;

/** الفاصلة العشرية بشكليها اللاتيني والعربي. */
const DECIMAL = /[.٫]/;

/**
 * يعدّ الخانات وحدها — مُساعدٌ للتوكيدات في الاختبارات.
 * ⚠️ ليس أساس إعادة المؤشّر: تلك `countSignificant` التي تعدّ النقطة والإشارة أيضاً.
 */
export function countDigits(text: string): number {
  let n = 0;
  for (const ch of text) if (DIGIT.test(ch)) n++;
  return n;
}

/** يُزيل فواصل المراتب ويُبقي كل ما عداها — عكس `groupDigits`. */
export function ungroupDigits(text: string | number | null | undefined): string {
  if (text === null || text === undefined) return '';
  return String(text).replace(SEPARATORS, '');
}

/**
 * يُدرج فاصلاً كل ثلاث خانات في **الجزء الصحيح وحده**.
 *
 * 🔴 «وحده» ليست تفصيلاً: تجميع الكسر أيضاً يُنتج «١٫٢٣٤,٥٦٧» وهو ليس رقماً
 * في أي عُرف. والجزء العشري يبقى كما كُتب حرفاً بحرف.
 */
export function groupDigits(text: string | number | null | undefined): string {
  if (text === null || text === undefined) return '';
  const original = String(text);
  const raw = ungroupDigits(original);
  if (raw === '') return '';

  const neg = raw.startsWith('-');
  const body = neg ? raw.slice(1) : raw;

  // نقطة الفصل عند أول فاصلة عشرية؛ ما بعدها يُنقل كما هو (بما فيه الفاصلة نفسها)
  const dot = body.search(DECIMAL);
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const rest = dot === -1 ? '' : body.slice(dot);

  // ⚠️ السلامة أولاً: أي حرفٍ غير رقميّ في الجزء الصحيح ⇒ لا نلمس النصّ إطلاقاً
  for (const ch of intPart) {
    if (!DIGIT.test(ch)) return original;
  }
  if (intPart === '') return original === raw ? original : raw;

  let out = '';
  for (let i = 0; i < intPart.length; i++) {
    // الفاصل يسبق كل خانةٍ يتبعها مضاعفُ ثلاثةٍ من الخانات
    if (i > 0 && (intPart.length - i) % 3 === 0) out += GROUP_SEP;
    out += intPart[i];
  }
  return (neg ? '-' : '') + out + rest;
}

/**
 * موضع المؤشّر بعد إعادة التجميع.
 *
 * 🔴 المنطق الخطر في `NumberInput` معزولٌ هنا عمداً ليُختبَر: المشروع بلا
 * jsdom (١١٥٤ اختباراً كلّها منطق خالص)، فإخراج الحساب من المكوّن يجعله
 * قابلاً للفحص بدل أن يبقى سلوكاً لا يراه أحد حتى يشتكي التاجر.
 *
 * 🔴 نعدّ **كل حرفٍ ليس فاصل مراتب** — لا الخانات وحدها. كشفت محاكاة الكتابة
 * أن عدّ الخانات يوقف المؤشّر بعد آخر خانة أي **قبل النقطة العشرية**: تكتب
 * «12500.75» فتخرج «1,250,075.» لأن كل خانةٍ بعد النقطة تُكتب قبلها. والنقطة
 * والإشارة السالبة أحرفٌ يكتبها التاجر ويجب أن يتجاوزها المؤشّر مثل الخانات.
 * أمّا الفواصل فنُدرجها نحن ولا يكتبها هو — فلا تُعدّ.
 *
 * @param shown النصّ المعروض بعد التجميع
 * @param digitsBefore عدد الخانات التي كانت على يسار المؤشّر لحظة الكتابة
 * @returns الفهرس الذي يقع مباشرةً بعد الخانة رقم `digitsBefore`
 */
export function caretAfterGrouping(shown: string, significantBefore: number): number {
  let seen = 0;
  let pos = 0;
  while (pos < shown.length && seen < significantBefore) {
    if (!SEPARATOR_CHAR.test(shown[pos])) seen++;
    pos++;
  }
  return pos;
}

/**
 * يعدّ الأحرف التي **يكتبها المستخدم** — كل شيء عدا فواصل المراتب التي نُدرجها نحن.
 * أساسُ إعادة المؤشّر: هذه الأحرف لا يغيّرها التجميع، فهي المرساة الثابتة.
 */
export function countSignificant(text: string): number {
  let n = 0;
  for (const ch of text) if (!SEPARATOR_CHAR.test(ch)) n++;
  return n;
}
