import React, { useState } from 'react';
import { initializeApp, getApps, deleteApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { doc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db, firebaseConfig } from '../firebase';
import { useCollection } from '../hooks/useCollection';
import { useSession } from '../context/SessionContext';
import { useConfirm } from '../hooks/useConfirm';
import {
  Users, UserPlus, Copy, Check, X, Power, Trash2, AlertTriangle,
  ShieldCheck, Loader2, KeyRound, Info, Building2,
} from 'lucide-react';
import { toArabicDigits } from '../utils/arabicFormatters';
import { logAudit } from '../utils/auditLog';
import { useBranches } from '../hooks/useBranches';
import { MAIN_BRANCH_ID } from '../types';

interface EmployeeDoc {
  id: string;        // = uid الموظف
  name: string;
  email: string;
  addedAt: string;   // ISO
  disabled?: boolean;
  /** فرع الموظف — غيابه = الفرع الرئيسي (توافق رجعي مع كل الموظفين الحاليين) */
  branchId?: string;
}

const SECONDARY_APP_NAME = 'secondary-employee-creation';

// كلمة سر مؤقتة عشوائية سهلة القراءة (حروف + أرقام، ≥ 8)
function genPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function firebaseAuthErrorMsg(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'auth/email-already-in-use': return 'هذا البريد الإلكتروني مسجّل مسبقاً — استخدم بريداً آخر';
      case 'auth/weak-password': return 'كلمة المرور ضعيفة جداً (٦ أحرف على الأقل)';
      case 'auth/invalid-email': return 'صيغة البريد الإلكتروني غير صحيحة';
      case 'auth/network-request-failed': return 'تعذّر الاتصال بالإنترنت — إنشاء حساب الموظف يتطلب اتصالاً';
      case 'auth/too-many-requests': return 'محاولات كثيرة، انتظر قليلاً ثم حاول مجدداً';
      default: return `تعذّر إنشاء الحساب (${err.code})`;
    }
  }
  return 'حدث خطأ غير متوقع أثناء إنشاء حساب الموظف';
}

export default function EmployeeManagement() {
  const { role, ownerUid } = useSession();
  const { items: employees } = useCollection<EmployeeDoc>('employees');
  const { requestConfirm, confirmDialog } = useConfirm();
  // مواقع البيع فقط — المخزن لا يُسند له موظف بيع (لا صندوق فيه ولا فواتير)
  const { sellingBranches, isMultiBranch, branchName } = useBranches();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(genPassword());
  const [branchId, setBranchId] = useState<string>(MAIN_BRANCH_ID);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ملخص نجاح الإنشاء — يُعرض مرة واحدة (كلمة السر لن تظهر لاحقاً)
  const [createdSummary, setCreatedSummary] = useState<{ name: string; email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // تأكيد إضافي: القسم للمالك فقط (لن يصل الموظف لـ SettingsView أصلاً)
  if (role !== 'owner' || !ownerUid) return null;

  const resetForm = () => {
    setName(''); setEmail(''); setPassword(genPassword()); setBranchId(MAIN_BRANCH_ID); setError(null);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCreating) return;
    setError(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) { setError('يرجى إدخال اسم الموظف'); return; }
    if (!trimmedEmail) { setError('يرجى إدخال البريد الإلكتروني'); return; }
    if (password.length < 6) { setError('كلمة المرور يجب أن تكون ٦ أحرف على الأقل'); return; }
    if (!navigator.onLine) { setError('لا يوجد اتصال بالإنترنت — إنشاء حساب الموظف يتطلب اتصالاً (لا يعمل أوفلاين)'); return; }

    setIsCreating(true);
    let secondaryApp: ReturnType<typeof initializeApp> | null = null;
    try {
      // نسخة Firebase ثانوية معزولة — إنشاء المستخدم عليها لا يمسّ جلسة المالك (auth الرئيسي)
      const existing = getApps().find(a => a.name === SECONDARY_APP_NAME);
      if (existing) await deleteApp(existing);
      secondaryApp = initializeApp(firebaseConfig, SECONDARY_APP_NAME);
      const secondaryAuth = getAuth(secondaryApp);

      const cred = await createUserWithEmailAndPassword(secondaryAuth, trimmedEmail, password);
      const newUid = cred.user.uid;

      // بجلسة المالك السليمة (db الرئيسي): سجل الموظف + الفهرس العلوي. fire-and-forget.
      const addedAt = new Date().toISOString();
      setDoc(doc(db, 'users', ownerUid, 'employees', newUid), {
        id: newUid, name: trimmedName, email: trimmedEmail, addedAt, disabled: false, branchId,
      }).catch(err => console.error('[Firestore] employees create:', err));
      setDoc(doc(db, 'employeeIndex', newUid), {
        ownerUid, disabled: false, name: trimmedName, branchId, branchName: branchName(branchId),
      }).catch(err => console.error('[Firestore] employeeIndex create:', err));

      // تنظيف النسخة الثانوية فوراً
      await signOut(secondaryAuth);

      setCreatedSummary({ name: trimmedName, email: trimmedEmail, password });
      void logAudit({ action: 'create', entity: 'employee', entityId: newUid, summary: `إضافة موظف جديد: ${trimmedName}`, after: { name: trimmedName, email: trimmedEmail, disabled: false, branchId }, actorUid: ownerUid, actorName: 'المالك' });
      setShowForm(false);
      resetForm();
    } catch (err) {
      setError(firebaseAuthErrorMsg(err));
    } finally {
      if (secondaryApp) { try { await deleteApp(secondaryApp); } catch { /* تجاهل */ } }
      setIsCreating(false);
    }
  };

  const toggleDisabled = async (emp: EmployeeDoc) => {
    const next = !(emp.disabled === true);
    // نحدّث الوثيقتين — القاعدة تمنع وصول الموظف فوراً عبر employees.disabled
    updateDoc(doc(db, 'users', ownerUid, 'employees', emp.id), { disabled: next })
      .catch(err => console.error('[Firestore] employee toggle:', err));
    updateDoc(doc(db, 'employeeIndex', emp.id), { disabled: next })
      .catch(err => console.error('[Firestore] employeeIndex toggle:', err));
    void logAudit({ action: 'update', entity: 'employee', entityId: emp.id, summary: `${next ? 'تعطيل' : 'تفعيل'} حساب الموظف: ${emp.name}`, before: { disabled: !next }, after: { disabled: next }, actorUid: ownerUid, actorName: 'المالك' });
  };

  /**
   * نقل موظف إلى فرع آخر. تُكتب الوثيقتان معاً:
   *   · employees/{uid}      → مرجع المالك وقواعد Firestore (تتحقق منه خادمياً)
   *   · employeeIndex/{uid}  → الوثيقة الوحيدة التي يقرأها الموظف عن نفسه (تحدّد فرع بيعه)
   * الفواتير القديمة لا تتغيّر — تبقى منسوبة للفرع الذي بِيعت فيه فعلاً.
   */
  const changeBranch = (emp: EmployeeDoc, nextBranch: string) => {
    const prevBranch = emp.branchId?.trim() || MAIN_BRANCH_ID;
    if (nextBranch === prevBranch) return;
    updateDoc(doc(db, 'users', ownerUid, 'employees', emp.id), { branchId: nextBranch })
      .catch(err => console.error('[Firestore] employee branch:', err));
    updateDoc(doc(db, 'employeeIndex', emp.id), { branchId: nextBranch, branchName: branchName(nextBranch) })
      .catch(err => console.error('[Firestore] employeeIndex branch:', err));
    void logAudit({
      action: 'update', entity: 'employee', entityId: emp.id,
      summary: `نقل الموظف ${emp.name} من «${branchName(prevBranch)}» إلى «${branchName(nextBranch)}»`,
      before: { branchId: prevBranch }, after: { branchId: nextBranch },
      actorUid: ownerUid, actorName: 'المالك',
    });
  };

  const handleDelete = async (emp: EmployeeDoc) => {
    const ok = await requestConfirm(
      `حذف الموظف "${emp.name}"؟\n\nسيُقطع وصوله للنظام فوراً. ملاحظة: حساب الدخول (Firebase Auth) نفسه يبقى موجوداً — لحذفه نهائياً تحتاج إزالته يدوياً من Firebase Console.`
    );
    if (!ok) return;
    deleteDoc(doc(db, 'users', ownerUid, 'employees', emp.id))
      .catch(err => console.error('[Firestore] employee delete:', err));
    deleteDoc(doc(db, 'employeeIndex', emp.id))
      .catch(err => console.error('[Firestore] employeeIndex delete:', err));
    void logAudit({ action: 'delete', entity: 'employee', entityId: emp.id, summary: `حذف موظف: ${emp.name}`, before: { name: emp.name, email: emp.email, disabled: emp.disabled === true }, actorUid: ownerUid, actorName: 'المالك' });
  };

  const copySummary = () => {
    if (!createdSummary) return;
    const text = `بيانات دخول الموظف — ${createdSummary.name}\nالبريد: ${createdSummary.email}\nكلمة السر: ${createdSummary.password}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ar-IQ');
  };

  return (
    <div className="bg-white rounded-2xl p-6 border border-[#E4EAF3] shadow-sm space-y-4">
      {confirmDialog}

      <h3 className="font-extrabold text-base font-cairo text-[#0B1F4D] flex items-center gap-2 pb-3 border-b border-slate-100">
        <Users className="w-5.5 h-5.5 text-indigo-600" />
        <div>
          <span>إدارة الموظفين 👥</span>
          <p className="text-[10px] text-slate-400 font-normal mt-0.5">أنشئ حسابات دخول للموظفين بصلاحيات محدودة (الفواتير فقط)</p>
        </div>
      </h3>

      {/* Success summary — password shown once */}
      {createdSummary && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl space-y-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-extrabold text-emerald-800">تم إنشاء حساب الموظف «{createdSummary.name}» بنجاح ✅</p>
              <p className="text-[10px] text-amber-700 font-bold mt-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                احفظ هذه المعلومات الآن — كلمة السر لن تظهر مرة أخرى
              </p>
            </div>
            <button onClick={() => setCreatedSummary(null)} className="p-1 hover:bg-emerald-100 rounded-lg text-emerald-700">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="bg-white rounded-xl border border-emerald-150 p-3 space-y-1.5 font-mono text-xs">
            <div className="flex justify-between gap-2"><span className="text-slate-500">البريد:</span><span className="font-bold text-[#0B1F4D] truncate" dir="ltr">{createdSummary.email}</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-500">كلمة السر:</span><span className="font-bold text-[#0B1F4D]" dir="ltr">{createdSummary.password}</span></div>
          </div>
          <button onClick={copySummary} className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer">
            {copied ? <><Check className="w-3.5 h-3.5" /><span>تم النسخ</span></> : <><Copy className="w-3.5 h-3.5" /><span>نسخ بيانات الدخول</span></>}
          </button>
        </div>
      )}

      {/* Add employee button / form */}
      {!showForm ? (
        <button
          onClick={() => { setShowForm(true); resetForm(); }}
          className="w-full py-2.5 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
        >
          <UserPlus className="w-4 h-4 text-emerald-400" />
          <span>إضافة موظف جديد</span>
        </button>
      ) : (
        <form onSubmit={handleCreate} className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
          {error && (
            <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-[11px] font-bold flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div>
            <label className="block text-[11px] font-bold text-[#0B1F4D] mb-1">اسم الموظف</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="مثال: أحمد علي" className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-right font-bold outline-none focus:ring-1 focus:ring-[#0B1F4D]" />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-[#0B1F4D] mb-1">البريد الإلكتروني للدخول</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr"
              placeholder="employee@email.com" autoComplete="off" className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-left font-mono outline-none focus:ring-1 focus:ring-[#0B1F4D]" />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-[#0B1F4D] mb-1">كلمة سر مؤقتة</label>
            <div className="flex gap-1.5">
              <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr"
                className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-left font-mono font-bold outline-none focus:ring-1 focus:ring-[#0B1F4D]" />
              <button type="button" onClick={() => setPassword(genPassword())} title="توليد كلمة سر عشوائية"
                className="px-2.5 bg-white border border-slate-200 rounded-xl text-slate-500 hover:bg-slate-100 transition cursor-pointer">
                <KeyRound className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[9px] text-slate-400 mt-1">٦ أحرف على الأقل — يسلّمها المالك للموظف</p>
          </div>
          {/* الفرع — يظهر فقط عند وجود أكثر من فرع (محل بفرع واحد: الواجهة كما كانت) */}
          {isMultiBranch && (
            <div>
              <label className="block text-[11px] font-bold text-[#0B1F4D] mb-1 flex items-center gap-1">
                <Building2 className="w-3.5 h-3.5 text-indigo-600" />
                <span>فرع الموظف</span>
              </label>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-right font-bold outline-none focus:ring-1 focus:ring-[#0B1F4D] cursor-pointer">
                {sellingBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <p className="text-[9px] text-slate-400 mt-1">بيعه يُخصم من مخزون هذا الفرع، وفواتيره تُنسب له</p>
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={isCreating}
              className="flex-1 py-2.5 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-xs flex items-center justify-center gap-1.5 transition cursor-pointer disabled:opacity-50 disabled:cursor-wait">
              {isCreating ? <><Loader2 className="w-4 h-4 animate-spin" /><span>جارٍ الإنشاء...</span></> : <><UserPlus className="w-4 h-4" /><span>إنشاء الحساب</span></>}
            </button>
            <button type="button" onClick={() => { setShowForm(false); resetForm(); }} disabled={isCreating}
              className="px-4 py-2.5 border border-slate-200 rounded-xl text-xs font-bold text-slate-500 hover:bg-slate-100 transition cursor-pointer disabled:opacity-50">
              إلغاء
            </button>
          </div>
        </form>
      )}

      {/* Employees list */}
      <div className="space-y-2">
        {employees.length === 0 ? (
          <div className="text-center py-6 text-slate-400 font-bold text-[11px] flex flex-col items-center gap-1.5">
            <Info className="w-5 h-5 text-slate-300" />
            <span>لا يوجد موظفون بعد — أضف أول موظف بالزر أعلاه</span>
          </div>
        ) : (
          [...employees].sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '')).map(emp => {
            const isDisabled = emp.disabled === true;
            return (
              <div key={emp.id} className={`flex items-center justify-between gap-2 p-3 rounded-xl border ${isDisabled ? 'bg-slate-50 border-slate-200 opacity-75' : 'bg-white border-slate-150'}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-extrabold text-[#0B1F4D] truncate">{emp.name}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-extrabold border ${isDisabled ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                      {isDisabled ? 'معطّل' : 'فعّال'}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono block truncate mt-0.5" dir="ltr">{emp.email}</span>
                  <span className="text-[9px] text-slate-400 block">أُضيف: {toArabicDigits(formatDate(emp.addedAt))}</span>
                  {isMultiBranch && (
                    <label className="flex items-center gap-1 mt-1.5">
                      <Building2 className="w-3 h-3 text-indigo-500 flex-shrink-0" />
                      <select
                        value={emp.branchId?.trim() || MAIN_BRANCH_ID}
                        onChange={(e) => changeBranch(emp, e.target.value)}
                        title="فرع الموظف"
                        className="text-[10px] font-extrabold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer max-w-[150px]"
                      >
                        {sellingBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => toggleDisabled(emp)} title={isDisabled ? 'تفعيل' : 'تعطيل'}
                    className={`p-2 rounded-lg transition cursor-pointer ${isDisabled ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
                    <Power className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(emp)} title="حذف"
                    className="p-2 rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-100 transition cursor-pointer">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="text-[9px] text-slate-400 leading-relaxed flex items-start gap-1 pt-1 border-t border-slate-100">
        <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
        <span>الحذف يقطع وصول الموظف فوراً عبر قواعد الأمان. حساب الدخول نفسه يبقى في Firebase — لإزالته نهائياً احذفه من Firebase Console.</span>
      </p>
    </div>
  );
}
