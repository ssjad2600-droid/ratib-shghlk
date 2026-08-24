import React, { useState } from 'react';
import { Building2, Plus, Save, X, MapPin, Phone, Star, Power, Trash2, Info, Store, Warehouse } from 'lucide-react';
import { useBranches, kindOf, isWarehouse } from '../hooks/useBranches';
import { useCollection } from '../hooks/useCollection';
import { useActor } from '../hooks/useActor';
import { useConfirm } from '../hooks/useConfirm';
import { logAudit } from '../utils/auditLog';
import { Branch, BranchKind, Product, MAIN_BRANCH_ID } from '../types';
import { toArabicDigits } from '../utils/arabicFormatters';
import { todayISO } from '../utils/dateLocal';
import { genId } from '../utils/genId';
import { collection, query, where, getCountFromServer, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useSession } from '../context/SessionContext';
import { reportFirestoreError } from '../utils/writeGuard';
import {
  strandedStock, impactVerdict, findDuplicateBranch,
  LinkedCounts, EMPTY_COUNTS, ActionKind,
} from '../utils/branchImpact';

interface Props { storeName?: string }

export default function BranchesView({ storeName }: Props) {
  const { branches, isMultiBranch, saveBranch, removeBranch, activeBranchId, setActiveBranchId } = useBranches(storeName);
  const { items: products } = useCollection<Product>('products'); // لمنع حذف موقع فيه بضاعة
  const actor = useActor();
  const { requestConfirm, confirmDialog } = useConfirm();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [kind, setKind] = useState<BranchKind>('shop');
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<{ text: string; bad?: boolean } | null>(null);
  const notify = (text: string, bad = false) => { setAlert({ text, bad }); setTimeout(() => setAlert(null), 6000); };
  const { ownerUid } = useSession();

  /**
   * 🔴 عدّ السجلات المرتبطة بالفرع — قبل أي فعلٍ لا رجعة فيه.
   *
   * نستعمل `getCountFromServer` (تجميع على الخادم): يُرجع العدد **بلا تنزيل الوثائق**،
   * فلا نُحمّل سنةً من الفواتير لعرض رقم. ويجري عند الضغط فقط، لا مع كل رسم.
   * وتعذّر الاتصال يُقال صراحةً بدل ادّعاء الخلوّ — فالصفر الكاذب هو ما نحرسه هنا.
   */
  const countLinked = async (branchId: string): Promise<{ counts: LinkedCounts; checked: boolean }> => {
    if (!ownerUid) return { counts: EMPTY_COUNTS, checked: false };
    const countIn = async (name: string) => {
      const q = query(collection(db, 'users', ownerUid, name), where('branchId', '==', branchId));
      return (await getCountFromServer(q)).data().count;
    };
    try {
      const [invoices, transactions, closings, employees, transfersFrom, transfersTo] = await Promise.all([
        countIn('invoices'), countIn('financial_transactions'), countIn('cash_closings'), countIn('employees'),
        (async () => (await getCountFromServer(query(
          collection(db, 'users', ownerUid, 'stock_transfers'), where('fromBranchId', '==', branchId),
        ))).data().count)(),
        (async () => (await getCountFromServer(query(
          collection(db, 'users', ownerUid, 'stock_transfers'), where('toBranchId', '==', branchId),
        ))).data().count)(),
      ]);
      return {
        counts: { invoices, transactions, closings, employees, transfers: transfersFrom + transfersTo },
        checked: true,
      };
    } catch (err) {
      console.error('[Branches] count linked:', err);
      return { counts: EMPTY_COUNTS, checked: false };
    }
  };

  /** يجمع الأثر ويعرضه ثم يطلب التأكيد — مسارٌ واحد للأفعال الثلاثة. */
  const confirmWithImpact = async (action: ActionKind, b: Branch): Promise<boolean> => {
    const stranded = strandedStock(products, b.id);
    const { counts, checked } = await countLinked(b.id);
    const verdict = impactVerdict({ action, branchName: b.name, stranded, counts, countsChecked: checked });
    if (verdict.blocked) { notify(verdict.message, true); return false; }
    return requestConfirm(verdict.message);
  };

  const openCreate = () => {
    setEditing(null); setName(''); setAddress(''); setPhone(''); setNotes(''); setKind('shop'); setShowForm(true);
  };
  const openEdit = (b: Branch) => {
    setEditing(b); setName(b.name); setAddress(b.address); setPhone(b.phone); setNotes(b.notes); setKind(kindOf(b)); setShowForm(true);
  };

  const handleSave = async () => {
    if (saving) return;
    if (!name.trim()) { notify('الاسم مطلوب', true); return; }

    // 🟠 اسم مكرَّر ⟵ خياران متطابقان في مبدّل الفروع وصفّان لا يُميَّزان في التقارير
    const dup = findDuplicateBranch(branches, name, editing?.id);
    if (dup) { notify(`يوجد موقع بنفس الاسم: «${dup.name}». اختر اسماً مميّزاً ليسهل التمييز بينهما.`, true); return; }

    /**
     * 🔴 تحويل محلٍّ عاملٍ إلى مخزن فعلٌ له آثار في ثلاث شاشات، وكان يتمّ بضغطة على
     * قائمة منسدلة بلا أي تنبيه. نُعلن الأثر ونطلب التأكيد — والعكس (مخزن ⟵ محل) لا ضرر فيه.
     */
    if (editing && !editing.isMain && kindOf(editing) === 'shop' && kind === 'warehouse') {
      if (!(await confirmWithImpact('toWarehouse', editing))) return;
    }

    setSaving(true);
    try {
      const isFirstRealBranch = branches.length === 1 && branches[0].id === MAIN_BRANCH_ID && !editing;
      // أول إضافة: نُثبّت الفرع الرئيسي في قاعدة البيانات أولاً حتى تبقى بياناتك القديمة منسوبة إليه
      if (isFirstRealBranch) {
        await saveBranch({
          ...branches[0],
          id: MAIN_BRANCH_ID,
          createdAt: todayISO(),
        });
      }
      const doc: Branch = editing
        ? { ...editing, name: name.trim(), address: address.trim(), phone: phone.trim(), notes: notes.trim(), kind: editing.isMain ? 'shop' : kind }
        : {
            id: `branch_${genId()}`,
            name: name.trim(), address: address.trim(), phone: phone.trim(), notes: notes.trim(),
            isMain: false, active: true, createdAt: todayISO(), kind,
          };
      await saveBranch(doc);
      void logAudit({
        action: editing ? 'update' : 'create', entity: 'branch', entityId: doc.id,
        summary: `${editing ? 'تعديل' : 'إضافة'} ${isWarehouse(doc) ? 'مخزن' : 'فرع'}: ${doc.name}`,
        after: doc as unknown as Record<string, unknown>,
        actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
      });
      notify(editing ? 'تم تحديث الفرع ✅' : 'تمت إضافة الفرع ✅');
      setShowForm(false);
    } finally { setSaving(false); }
  };

  const toggleActive = async (b: Branch) => {
    if (b.isMain) { notify('لا يمكن تعطيل الفرع الرئيسي', true); return; }
    const disabling = b.active !== false;
    // التفعيل لا أثر له يُعلَن؛ التعطيل يُخفي الفرع من المبدّل وإسناد الموظفين فيُعلَن
    if (disabling && !(await confirmWithImpact('disable', b))) return;
    /**
     * 🟠 تحديث الحقل المتغيّر وحده لا استبدال الوثيقة من لقطة محلية.
     * كان `saveBranch({ ...b, active })` يعيد كتابة كل الحقول: جهازٌ يعطّل وآخر يعيد
     * التسمية في اللحظة نفسها ⟵ التسمية تُمحى.
     */
    if (ownerUid) {
      await updateDoc(doc(db, 'users', ownerUid, 'branches', b.id), { active: !disabling })
        .catch(err => reportFirestoreError('branches', 'update', err, '[Branches] toggle'));
    }
    notify(disabling ? 'تم تعطيل الفرع (يبقى في السجلات التاريخية)' : 'تم تفعيل الفرع');
  };

  const handleDelete = async (b: Branch) => {
    if (b.isMain) { notify('لا يمكن حذف الفرع الرئيسي', true); return; }
    // الحارس والتحذير معاً من `impactVerdict`: البضاعة المعلّقة تمنع، وبقيّة الأثر يُعلَن
    if (!(await confirmWithImpact('delete', b))) return;
    await removeBranch(b.id);
    void logAudit({
      action: 'delete', entity: 'branch', entityId: b.id,
      summary: `حذف ${isWarehouse(b) ? 'مخزن' : 'فرع'}: ${b.name}`,
      before: b as unknown as Record<string, unknown>,
      actorUid: actor.uid, ownerUid: actor.ownerUid, actorName: actor.name,
    });
    notify('تم الحذف', true);
  };

  return (
    <div className="space-y-6 font-tajawal" dir="rtl">
      {confirmDialog}

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-[#0B1F4D] text-white p-6 rounded-2xl border-b-4 border-amber-400">
        <div>
          <div className="flex items-center gap-2 text-slate-300 text-xs font-bold font-cairo">
            <Building2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>مواقع البضاعة</span>
          </div>
          <h2 className="text-xl md:text-2xl font-extrabold font-cairo mt-1.5 flex items-center gap-2">
            <Building2 className="w-6 h-6 text-amber-400" />
            <span>الفروع والمخازن 🏢</span>
          </h2>
          <p className="text-xs text-slate-300 mt-1 leading-relaxed">
            كل موقع له رصيد مستقل من كل مادة. <b>المحل</b> يبيع وله صندوق وموظفون،
            و<b>المخزن</b> يخزّن فقط (مخزن الطابق الثاني مثلاً) — أو أبقِ موقعاً واحداً ولن يتغيّر شيء
          </p>
        </div>
        <button onClick={openCreate}
          className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-extrabold rounded-xl text-xs shadow flex items-center gap-1.5 cursor-pointer active:scale-95 self-start">
          <Plus className="w-4 h-4" /> <span>إضافة موقع</span>
        </button>
      </div>

      {alert && (
        <div className={`px-4 py-3 rounded-xl text-xs font-bold border ${alert.bad ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
          {alert.text}
        </div>
      )}

      {!isMultiBranch && (
        <div className="p-4 rounded-2xl border border-blue-200 bg-blue-50/70 flex items-start gap-2.5">
          <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-blue-900 font-bold leading-relaxed">
            لديك فرع واحد حالياً، والبرنامج يعمل كما هو تماماً دون أي تغيير.
            بمجرد إضافة فرع ثانٍ سيظهر <b>مبدّل الفروع</b> في أعلى الشاشة، وتُنسب العمليات الجديدة للفرع المختار.
            كل بياناتك السابقة تبقى منسوبة للفرع الرئيسي تلقائياً — <b>بلا أي ترحيل</b>.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {branches.map(b => {
          const isActive = b.id === activeBranchId;
          const disabled = b.active === false;
          return (
            <div key={b.id} className={`bg-white rounded-2xl border shadow-sm p-4 relative overflow-hidden ${
              isActive ? 'border-amber-300 ring-2 ring-amber-100' : 'border-[#E4EAF3]'
            } ${disabled ? 'opacity-60' : ''}`}>
              <div className={`absolute right-0 top-0 h-full w-1.5 ${b.isMain ? 'bg-amber-500' : disabled ? 'bg-slate-300' : 'bg-emerald-500'}`} />
              <div className="pr-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-extrabold text-sm text-[#0B1F4D]">{b.name}</span>
                      {b.isMain && (
                        <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
                          <Star className="w-2.5 h-2.5" /> رئيسي
                        </span>
                      )}
                      {isWarehouse(b) ? (
                        <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 flex items-center gap-1">
                          <Warehouse className="w-2.5 h-2.5" /> مخزن
                        </span>
                      ) : (
                        <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200 flex items-center gap-1">
                          <Store className="w-2.5 h-2.5" /> محل
                        </span>
                      )}
                      {disabled && (
                        <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">معطّل</span>
                      )}
                      {isActive && (
                        <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">الفرع النشط</span>
                      )}
                    </div>
                    <div className="mt-1.5 space-y-0.5">
                      {b.address && (
                        <span className="text-[11px] text-slate-500 font-bold flex items-center gap-1">
                          <MapPin className="w-3 h-3 flex-shrink-0" /> {b.address}
                        </span>
                      )}
                      {b.phone && (
                        <span className="text-[11px] text-slate-500 font-bold flex items-center gap-1" dir="ltr">
                          <Phone className="w-3 h-3 flex-shrink-0" /> {toArabicDigits(b.phone)}
                        </span>
                      )}
                      {b.notes && <span className="text-[10px] text-slate-600 font-bold block">{b.notes}</span>}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                  {!isActive && !disabled && (
                    <button onClick={() => setActiveBranchId(b.id)}
                      className="px-3 py-1.5 bg-[#0B1F4D] hover:bg-[#13295E] text-white text-[11px] font-extrabold rounded-lg cursor-pointer">
                      التبديل إليه
                    </button>
                  )}
                  <button onClick={() => openEdit(b)}
                    className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-extrabold rounded-lg cursor-pointer">
                    تعديل
                  </button>
                  {!b.isMain && (
                    <>
                      <button onClick={() => toggleActive(b)}
                        className="px-2.5 py-1.5 bg-slate-100 hover:bg-amber-100 text-slate-600 hover:text-amber-700 text-[11px] font-extrabold rounded-lg cursor-pointer flex items-center gap-1">
                        <Power className="w-3 h-3" /> {disabled ? 'تفعيل' : 'تعطيل'}
                      </button>
                      <button onClick={() => handleDelete(b)}
                        className="px-2.5 py-1.5 bg-slate-100 hover:bg-rose-100 text-slate-600 hover:text-rose-700 text-[11px] font-extrabold rounded-lg cursor-pointer">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* نموذج الفرع */}
      {showForm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-5 bg-[#0B1F4D] text-white flex justify-between items-center">
              <h3 className="font-extrabold text-sm font-cairo flex items-center gap-1.5">
                <Building2 className="w-5 h-5" /> {editing ? 'تعديل الموقع' : 'إضافة موقع جديد'}
              </h3>
              <button onClick={() => setShowForm(false)} className="p-1.5 hover:bg-white/10 rounded-lg cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              {/* نوع الموقع — الرئيسي محل دائماً (منه بدأ محلك، وفيه صندوقك) */}
              {!editing?.isMain && (
                <div>
                  <label className="text-xs font-bold text-[#0B1F4D] block mb-1.5">نوع الموقع *</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setKind('shop')}
                      className={`p-3 rounded-xl border-2 text-right transition cursor-pointer ${kind === 'shop' ? 'border-sky-500 bg-sky-50' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`}>
                      <span className="flex items-center gap-1.5 font-extrabold text-xs text-[#0B1F4D]">
                        <Store className="w-4 h-4 text-sky-600" /> محل
                      </span>
                      <span className="text-[10px] text-slate-600 font-bold block mt-1 leading-relaxed">يبيع — له صندوق وفواتير وموظفون</span>
                    </button>
                    <button type="button" onClick={() => setKind('warehouse')}
                      className={`p-3 rounded-xl border-2 text-right transition cursor-pointer ${kind === 'warehouse' ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`}>
                      <span className="flex items-center gap-1.5 font-extrabold text-xs text-[#0B1F4D]">
                        <Warehouse className="w-4 h-4 text-indigo-600" /> مخزن
                      </span>
                      <span className="text-[10px] text-slate-600 font-bold block mt-1 leading-relaxed">بضاعة فقط — لا بيع ولا صندوق</span>
                    </button>
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs font-bold text-[#0B1F4D] block mb-1.5">
                  {kind === 'warehouse' ? 'اسم المخزن *' : 'اسم الفرع *'}
                </label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus
                  placeholder={kind === 'warehouse' ? 'مثال: مخزن الطابق الثاني' : 'مثال: فرع البصرة'}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-right outline-none focus:bg-white" />
              </div>
              <div>
                <label className="text-xs font-bold text-[#0B1F4D] block mb-1.5">العنوان</label>
                <input type="text" value={address} onChange={e => setAddress(e.target.value)}
                  placeholder="مثال: البصرة — شارع الجزائر"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right outline-none focus:bg-white" />
              </div>
              <div>
                <label className="text-xs font-bold text-[#0B1F4D] block mb-1.5">الهاتف</label>
                {/* inputMode="tel": لوحة أرقام على الهاتف. يبقى type="text" كي
                    تُقبل الأرقام العربية كبقية حقول البرنامج. بلا أثر على الكمبيوتر. */}
                <input type="text" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} dir="ltr"
                  placeholder="07XXXXXXXXX"
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold font-mono text-center outline-none focus:bg-white" />
              </div>
              <div>
                <label className="text-xs font-bold text-[#0B1F4D] block mb-1.5">ملاحظات</label>
                <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-right outline-none focus:bg-white" />
              </div>
              <button onClick={handleSave} disabled={saving}
                className="w-full py-3 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-sm shadow transition cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50">
                <Save className="w-4 h-4" /> <span>{saving ? 'جارٍ الحفظ...' : 'حفظ الموقع'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
