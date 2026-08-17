/**
 * تاريخ اليوم بصيغة 'yyyy-mm-dd' وفق التوقيت **المحلي** للجهاز (لا UTC).
 *
 * 🔴 لماذا هذا مهم: `new Date().toISOString().split('T')[0]` يعطي تاريخ UTC. في العراق (UTC+3)
 * أي عملية بين منتصف الليل و٣ فجراً تأخذ تاريخ الأمس، فتسقط من تقفيل صندوق يومها وتظهر في يوم
 * أُقفل أصلاً. هذه الدالة تبني التاريخ من مكوّنات اليوم المحلية فيطابق ما يراه المستخدم فعلاً،
 * ويتوافق مع toDayKey/todayKey في شاشة تقفيل الصندوق (كلاهما محلي).
 */
/** مفتاح يوم محلي 'yyyy-mm-dd' لأي تاريخ (من مكوّناته المحلية — لا انزياح UTC). */
export const localDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const todayISO = (): string => localDateKey(new Date());
