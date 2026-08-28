import React, { useState, useEffect, useCallback } from 'react';
import { setDoc } from '../utils/firestoreWrite';
import { collection, getDocs, doc, getDoc, query, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { Key, Copy, Check, Plus, Loader2, Shield, RefreshCw, Search, X } from 'lucide-react';
import { toArabicDigits } from '../utils/arabicFormatters';
import { ADMIN_UID } from '../config/adminConfig';
import { generateActivationCode, isActivationCode, normalizeCodeQuery } from '../utils/activationCode';
import { logAudit } from '../utils/auditLog';
import { useActor } from '../hooks/useActor';
import ErrorReportsPanel from './ErrorReportsPanel';

interface ActivationCode {
  id: string;
  used: boolean;
  usedBy: string | null;
  usedAt: string | null;
  createdAt: string;
}

interface AdminPanelProps {
  uid: string;
}

const CODES_FETCH_LIMIT = 500;

export default function AdminPanel({ uid }: AdminPanelProps) {
  const [codes, setCodes] = useState<ActivationCode[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [lastGenerated, setLastGenerated] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [lookup, setLookup] = useState<{ code: string; found: ActivationCode | null } | null>(null);
  const [looking, setLooking] = useState(false);
  const actor = useActor();

  const fetchCodes = useCallback(async () => {
    if (uid !== ADMIN_UID) return;
    setLoading(true);
    setFetchError(null);
    try {
      // سقف يحمي الذاكرة مع تراكم الأكواد عبر الزمن (بلا orderBy تفادياً لاستثناء الوثائق بلا createdAt)
      const snap = await getDocs(query(collection(db, 'activationCodes'), limit(CODES_FETCH_LIMIT)));
      const list: ActivationCode[] = snap.docs.map(d => ({
        id: d.id,
        used: d.data().used ?? false,
        usedBy: d.data().usedBy ?? null,
        usedAt: d.data().usedAt ?? null,
        createdAt: d.data().createdAt ?? '',
      }));
      list.sort((a, b) => {
        if (a.used !== b.used) return a.used ? 1 : -1;
        return b.createdAt.localeCompare(a.createdAt);
      });
      setCodes(list);
    } catch {
      setFetchError('تعذّر تحميل الأكواد — تحقق من قواعد Firestore (list permission)');
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useEffect(() => {
    if (uid === ADMIN_UID) fetchCodes();
  }, [uid, fetchCodes]);

  // Double-check: render nothing for non-admin users
  if (uid !== ADMIN_UID) return null;

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    try {
      /**
       * 🟠 فحص التصادم كان على الأكواد المحمَّلة فقط (٥٠٠ من الخادم بلا ترتيب) — أي على
       * عيّنةٍ لا على الكل. نفحص الوجود على الخادم مباشرة: `allow get` مفتوحة أصلاً.
       * والاحتمال ضئيل (١ في ١٫١ تريليون) لكن أثره جسيم: كودٌ بيع مرّتين.
       */
      let newCode = generateActivationCode();
      for (let tries = 0; tries < 5; tries++) {
        const existing = await getDoc(doc(db, 'activationCodes', newCode));
        if (!existing.exists()) break;
        newCode = generateActivationCode();
      }

      const createdAt = new Date().toISOString();
      await setDoc(doc(db, 'activationCodes', newCode), {
        used: false,
        usedBy: null,
        usedAt: null,
        createdAt,
      });

      /**
       * 🔴 المفتاح الذي يُباع صار له أثر.
       *
       * كان توليد الكود **العملية الوحيدة في البرنامج بلا سجل** — بينما يُسجَّل تعديل سعر
       * منتج. فإن ظهر كودٌ مفعَّل لم تبعه، لا سبيل لمعرفة أوُلِّد من لوحتك أصلاً أم لا.
       * التسجيل fire-and-forget: لا يُفشِل التوليد إن تعذّر، والكود صار في يدك بالفعل.
       */
      logAudit({
        action: 'create',
        entity: 'activation_code',
        entityId: newCode,
        summary: `توليد كود تفعيل ${newCode}`,
        after: { code: newCode, createdAt },
        actorUid: actor.uid,
        actorName: actor.name,
        ownerUid: actor.ownerUid,
      }).catch(() => {});

      setLastGenerated(newCode);
      await fetchCodes();
    } catch {
      setGenError('تعذّر توليد الكود — تحقق من قواعد Firestore (create permission للمالك)');
    } finally {
      setGenerating(false);
    }
  };

  /**
   * 🟠 البحث عن كود بعينه — سؤال الدعم الأول: «الزبون يقول إن كوده لا يعمل».
   *
   * لا يبحث في المحمَّل فقط: يقرأ الوثيقة من الخادم بمعرّفها، فيصل إلى كل كود ولّدته
   * ولو كان خارج الـ٥٠٠ المعروضة. ونتحقّق من الصيغة قبل الاستعلام كي لا نُرسل نداءً
   * عن معرّفٍ لا يمكن أن يوجد.
   */
  const handleSearch = async () => {
    const code = normalizeCodeQuery(search);
    if (!code) { setLookup(null); return; }
    if (!isActivationCode(code)) {
      setLookup({ code, found: null });
      return;
    }
    setLooking(true);
    try {
      const snap = await getDoc(doc(db, 'activationCodes', code));
      setLookup({
        code,
        found: snap.exists()
          ? {
              id: snap.id,
              used: snap.data().used ?? false,
              usedBy: snap.data().usedBy ?? null,
              usedAt: snap.data().usedAt ?? null,
              createdAt: snap.data().createdAt ?? '',
            }
          : null,
      });
    } catch {
      setFetchError('تعذّر البحث — تحقق من الاتصال');
    } finally {
      setLooking(false);
    }
  };

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopiedId(code);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const available = codes.filter(c => !c.used);
  const used = codes.filter(c => c.used);

  /**
   * 🟠 صدق العدّاد.
   *
   * الجلب `limit(500)` **بلا orderBy** ⟵ فايرستور يُعيد ٥٠٠ بترتيب المعرّف، أي **عيّنة
   * اعتباطية** لا الأحدث ولا الأقدم. وكان العدّاد يعرض `٥٠٠` رقماً صريحاً يُقرأ كأنه كل
   * ما لديك — فتظنّ أن عندك ٤٠ كوداً متاحاً وعندك ٤٠٠، أو العكس.
   *
   * ولا نُصلحها بـ`orderBy('createdAt')`: الوثائق القديمة بلا الحقل تسقط من النتيجة صامتةً
   * (فايرستور يستثني ما ينقصه حقل الترتيب) — فنُبدل نقصاً معلوماً بنقصٍ مخفيّ. الأصدق:
   * نقول إنه سقف، ونضع «+» على كل رقم مشتقّ منه.
   */
  const capped = codes.length >= CODES_FETCH_LIMIT;
  const countText = (n: number) => toArabicDigits(n) + (capped ? '+' : '');

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#0B1F4D] flex items-center justify-center shadow">
            <Shield className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-lg font-extrabold text-[#0B1F4D] font-cairo">لوحة تحكم المالك</h2>
            <p className="text-[11px] text-slate-500">إدارة أكواد التفعيل — محمية بـ uid المالك فقط</p>
          </div>
        </div>
        <button
          onClick={fetchCodes}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-xs font-bold text-slate-600 transition cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>تحديث</span>
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 text-center">
          <div className="text-4xl font-extrabold text-emerald-700 font-mono">
            {countText(available.length)}
          </div>
          <div className="text-xs font-bold text-emerald-700 mt-1.5">كود متاح (غير مستخدم)</div>
        </div>
        <div className="bg-slate-100 border border-slate-200 rounded-2xl p-5 text-center">
          <div className="text-4xl font-extrabold text-slate-500 font-mono">
            {countText(used.length)}
          </div>
          <div className="text-xs font-bold text-slate-500 mt-1.5">كود مستخدم</div>
        </div>
      </div>

      {capped && (
        <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-[11px] font-bold text-amber-800 leading-relaxed">
          الأرقام أعلاه <span className="font-extrabold">عيّنة</span> من {toArabicDigits(CODES_FETCH_LIMIT)} كود فقط (سقف
          الحماية)، وليست حصراً لكل أكوادك — لذلك وُضعت «+». للبحث عن كودٍ بعينه استخدم خانة البحث أدناه؛
          فهي تصل إلى كل كود ولو كان خارج المعروض.
        </div>
      )}

      {/* 🟠 البحث عن كود — سؤال الدعم الأول */}
      <div className="bg-white rounded-2xl border border-[#E4EAF3] p-4 space-y-3 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
              placeholder="ابحث عن كود: RS-XXXX-XXXX"
              className="w-full pr-9 pl-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono font-bold tracking-widest focus:outline-none focus:ring-2 focus:ring-[#0B1F4D]/20 focus:border-[#0B1F4D]"
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={looking || !search.trim()}
            className="px-4 py-2.5 bg-[#0B1F4D] hover:bg-[#152e6d] text-white rounded-xl text-xs font-bold transition disabled:opacity-40 cursor-pointer flex items-center gap-1.5 flex-shrink-0"
          >
            {looking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            <span>بحث</span>
          </button>
          {lookup && (
            <button
              onClick={() => { setLookup(null); setSearch(''); }}
              className="p-2.5 bg-slate-100 hover:bg-slate-200 rounded-xl text-slate-500 transition cursor-pointer flex-shrink-0"
              title="مسح نتيجة البحث"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {lookup && !lookup.found && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs font-bold text-rose-700 leading-relaxed">
            {isActivationCode(lookup.code)
              ? <>الكود <span className="font-mono">{lookup.code}</span> غير موجود إطلاقاً — لم يُولَّد من هذه اللوحة. من يقدّمه لك لم يشترِه منك.</>
              : <>الصيغة غير صحيحة. الكود يكون <span className="font-mono">RS-XXXX-XXXX</span> بحروف وأرقام بلا I أو O أو صفر أو واحد.</>
            }
          </div>
        )}

        {lookup?.found && (
          <div className={`p-3.5 rounded-xl border ${lookup.found.used ? 'bg-slate-50 border-slate-200' : 'bg-emerald-50 border-emerald-200'}`}>
            <div className="font-mono font-extrabold tracking-widest text-sm text-[#0B1F4D]">{lookup.found.id}</div>
            <div className="text-[11px] font-bold mt-1.5 leading-relaxed">
              {lookup.found.used ? (
                <span className="text-slate-600">
                  مُستخدَم ✔ — بواسطة{' '}
                  <span className="font-mono text-slate-800">{lookup.found.usedBy || '—'}</span>
                  {lookup.found.usedAt && <> بتاريخ {new Date(lookup.found.usedAt).toLocaleDateString('ar-IQ')}</>}
                </span>
              ) : (
                <span className="text-emerald-700">متاح ولم يُفعَّل بعد — يصلح للتسليم لزبون.</span>
              )}
              {lookup.found.createdAt && (
                <span className="block text-slate-500 mt-0.5">
                  أُنشئ: {new Date(lookup.found.createdAt).toLocaleDateString('ar-IQ')}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Generate Section */}
      <div className="bg-white rounded-2xl border border-[#E4EAF3] p-5 space-y-4 shadow-sm">
        <h3 className="text-sm font-extrabold text-[#0B1F4D] flex items-center gap-2">
          <Key className="w-4 h-4 text-amber-700" />
          توليد كود تفعيل جديد
        </h3>

        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full py-3 bg-[#0B1F4D] hover:bg-[#152e6d] active:scale-95 text-white font-extrabold rounded-xl text-sm flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer"
        >
          {generating
            ? <><Loader2 className="w-4 h-4 animate-spin" /><span>جاري التوليد...</span></>
            : <><Plus className="w-4 h-4" /><span>توليد كود جديد (RS-XXXX-XXXX)</span></>
          }
        </button>

        {genError && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs font-bold text-rose-700">
            {genError}
          </div>
        )}

        {lastGenerated && (
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] text-emerald-700 font-bold mb-1">آخر كود تم توليده:</div>
              <div className="font-mono font-extrabold text-emerald-800 tracking-widest text-base">
                {lastGenerated}
              </div>
            </div>
            <button
              onClick={() => handleCopy(lastGenerated)}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-bold transition cursor-pointer flex-shrink-0"
            >
              {copiedId === lastGenerated
                ? <><Check className="w-3.5 h-3.5" /><span>تم النسخ</span></>
                : <><Copy className="w-3.5 h-3.5" /><span>نسخ</span></>
              }
            </button>
          </div>
        )}
      </div>

      {/* Codes List */}
      <div className="bg-white rounded-2xl border border-[#E4EAF3] overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-extrabold text-[#0B1F4D]">
            جميع الأكواد ({countText(codes.length)})
          </h3>
        </div>

        {fetchError && (
          <div className="p-4 text-xs font-bold text-rose-700 bg-rose-50 border-b border-rose-200">
            {fetchError}
          </div>
        )}

        {capped && (
          <div className="p-3 text-[11px] font-bold text-amber-800 bg-amber-50 border-b border-amber-200">
            معروض {toArabicDigits(CODES_FETCH_LIMIT)} كود فقط (سقف الحماية)، وهي <span className="font-extrabold">عيّنة
            اعتباطية</span> لا الأحدث — استخدم البحث أعلاه للوصول إلى كودٍ بعينه.
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-[#0B1F4D]" />
          </div>
        ) : codes.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-500 font-bold">
            لا توجد أكواد بعد. اضغط "توليد كود جديد" أعلاه.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">

            {/* Available codes */}
            {available.length > 0 && (
              <>
                <div className="px-5 py-2 bg-emerald-50 text-[10px] font-extrabold text-emerald-700 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                  الأكواد المتاحة ({toArabicDigits(available.length)})
                </div>
                {available.map(code => (
                  <div key={code.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition">
                    <div>
                      <span className="font-mono font-extrabold text-sm text-[#0B1F4D] tracking-widest">
                        {code.id}
                      </span>
                      <span className="text-[10px] text-slate-600 block mt-0.5">
                        أُنشئ: {code.createdAt ? new Date(code.createdAt).toLocaleDateString('ar-IQ') : '—'}
                      </span>
                    </div>
                    <button
                      onClick={() => handleCopy(code.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-[11px] font-bold text-slate-600 transition cursor-pointer flex-shrink-0"
                    >
                      {copiedId === code.id
                        ? <><Check className="w-3 h-3 text-emerald-700" /><span className="text-emerald-700">تم</span></>
                        : <><Copy className="w-3 h-3" /><span>نسخ</span></>
                      }
                    </button>
                  </div>
                ))}
              </>
            )}

            {/* Used codes */}
            {used.length > 0 && (
              <>
                <div className="px-5 py-2 bg-slate-100 text-[10px] font-extrabold text-slate-500 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" />
                  الأكواد المستخدمة ({toArabicDigits(used.length)})
                </div>
                {used.map(code => (
                  <div key={code.id} className="flex items-center justify-between px-5 py-3.5 opacity-55">
                    <div>
                      <span className="font-mono font-extrabold text-sm text-slate-500 tracking-widest line-through">
                        {code.id}
                      </span>
                      <span className="text-[10px] text-slate-600 block mt-0.5">
                        استُخدم بواسطة:{' '}
                        <span className="font-mono text-slate-500">
                          {code.usedBy ? `${code.usedBy.slice(0, 10)}...` : '—'}
                        </span>
                        {code.usedAt && (
                          <> — {new Date(code.usedAt).toLocaleDateString('ar-IQ')}</>
                        )}
                      </span>
                    </div>
                    <button
                      onClick={() => handleCopy(code.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-[11px] font-bold text-slate-500 transition cursor-pointer flex-shrink-0"
                    >
                      {copiedId === code.id
                        ? <><Check className="w-3 h-3" /><span>تم</span></>
                        : <><Copy className="w-3 h-3" /><span>نسخ</span></>
                      }
                    </button>
                  </div>
                ))}
              </>
            )}

          </div>
        )}
      </div>

      {/* تقارير أخطاء الزبائن — العين على البرنامج بعد بيعه */}
      <div className="pt-4 border-t-2 border-slate-100">
        <ErrorReportsPanel />
      </div>
    </div>
  );
}
