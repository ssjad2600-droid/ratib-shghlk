import { useMemo, useEffect, useCallback, useSyncExternalStore } from 'react';
import { useCollection } from './useCollection';
import { useSession } from '../context/SessionContext';
import { Branch, BranchKind, MAIN_BRANCH_ID } from '../types';
import { createSharedValue } from '../utils/sharedValue';

/**
 * إدارة الفروع والفرع النشط (المرحلة ١: الأساس).
 *
 * 🔴 مبدأ عدم الكسر: المستخدم الحالي بلا فروع مُعرَّفة يرى **فرعاً رئيسياً افتراضياً** دون أن
 * يُنشأ في قاعدة البيانات، وكل بياناته القائمة (بلا branchId) تُنسب إليه تلقائياً.
 * فلا ترحيل، ولا تغيّر في أي رقم، ولا يظهر مبدّل الفروع أصلاً حتى يضيف فرعاً ثانياً.
 */

/** الفرع الرئيسي الافتراضي — يُستخدم قبل أن ينشئ المالك أي فرع فعلي. */
const defaultMainBranch = (storeName?: string): Branch => ({
  id: MAIN_BRANCH_ID,
  name: storeName?.trim() ? `${storeName.trim()} — الرئيسي` : 'الفرع الرئيسي',
  address: '',
  phone: '',
  isMain: true,
  active: true,
  kind: 'shop',
  createdAt: '',
  notes: '',
});

/** نوع الموقع — غيابه = محل (توافق رجعي مع كل الفروع المُنشأة قبل التمييز). */
export const kindOf = (b?: { kind?: BranchKind } | null): BranchKind => b?.kind === 'warehouse' ? 'warehouse' : 'shop';
export const isWarehouse = (b?: { kind?: BranchKind } | null): boolean => kindOf(b) === 'warehouse';

/** نسب أي سجل قديم (بلا فرع) للفرع الرئيسي — قاعدة موحّدة تُستخدم في كل الشاشات. */
export const branchOf = (record: { branchId?: string } | null | undefined): string =>
  record?.branchId?.trim() || MAIN_BRANCH_ID;

const activeKey = (uid: string) => `ratib_active_branch_${uid}`;

/**
 * 🔴 مخزن مشترك للفرع النشط — إصلاح علّة صامتة خطيرة.
 *
 * العلّة: كان الفرع النشط في `useState` **داخل كل مكوّن على حدة**. والرأس (مبدّل الفروع)
 * والشاشة كلٌّ منهما ينادي الخطّاف فيحصل على نسخة مستقلة. فحين يبدّل التاجر الفرع من
 * الرأس، **لا تعلم الشاشة المفتوحة** وتبقى تعرض أرقام الفرع القديم — بلا أي مؤشّر.
 *
 * والأخطر أنها تصيب كل شاشة واعية بالفرع (الفواتير، المنتجات، الصلاحية، الصندوق،
 * التقارير، أداء الفروع، نقل البضاعة)، ولا تظهر إلا لمن يبدّل الفرع ويبقى في مكانه —
 * فمن ينتقل بين الشاشات بعد التبديل لا يراها أبداً، وهي تخفي نفسها بذلك.
 *
 * الحل: قيمة واحدة خارج React يشترك فيها الجميع، و`useSyncExternalStore` يُعلم كل
 * مشترك لحظة التغيير. واجهة الخطّاف لم تتغيّر بحرف، فلا تعديل على أي شاشة.
 */
const activeBranchStore = createSharedValue<string>(MAIN_BRANCH_ID);

export function useBranches(storeName?: string) {
  const { ownerUid, role } = useSession();
  const { items, loading, save, remove } = useCollection<Branch>('branches');

  // القائمة الفعلية: ما في قاعدة البيانات، أو الفرع الرئيسي الافتراضي إن لم يُنشأ شيء بعد
  const branches = useMemo<Branch[]>(() => {
    if (items.length === 0) return [defaultMainBranch(storeName)];
    // ضمان وجود رئيسي دائماً (لو حُذف بالخطأ من الكونسول)
    return items.some(b => b.id === MAIN_BRANCH_ID || b.isMain)
      ? [...items].sort((a, b) => (a.isMain === b.isMain ? a.name.localeCompare(b.name, 'ar') : a.isMain ? -1 : 1))
      : [defaultMainBranch(storeName), ...items];
  }, [items, storeName]);

  const activeBranches = useMemo(() => branches.filter(b => b.active !== false), [branches]);
  /** مواقع البيع فقط — المخزن لا يُسند له موظف بيع ولا يُقفل له صندوق. */
  const sellingBranches = useMemo(() => activeBranches.filter(b => !isWarehouse(b)), [activeBranches]);
  /** هل تعدد الفروع مفعّل فعلاً؟ (فرع واحد ⇒ نُخفي كل واجهة الفروع تماماً) */
  const isMultiBranch = activeBranches.length > 1;

  // ---- الفرع النشط ----
  // '' = «كل الفروع» (عرض مجمّع للمالك). الموظف لاحقاً يُقفل على فرعه في المرحلة ٣.
  // قيمة واحدة يشترك فيها كل مَن ينادي هذا الخطّاف — تبديل الفرع يظهر فوراً في كل الشاشات
  const activeBranchId = useSyncExternalStore(
    activeBranchStore.subscribe, activeBranchStore.get, activeBranchStore.get,
  );

  // استرجاع آخر فرع مختار عند بداية الجلسة (أو تبديل الحساب)
  useEffect(() => {
    if (!ownerUid) return;
    try {
      const saved = localStorage.getItem(activeKey(ownerUid));
      if (saved !== null) { activeBranchStore.set(saved); return; }
    } catch { /* تعذّر التخزين — غير حرج */ }
    activeBranchStore.set(MAIN_BRANCH_ID);
  }, [ownerUid]);

  const setActiveBranchId = useCallback((id: string) => {
    activeBranchStore.set(id);
    if (!ownerUid) return;
    try { localStorage.setItem(activeKey(ownerUid), id); } catch { /* تجاهل */ }
  }, [ownerUid]);

  // لو اختفى الفرع المختار (حُذف)، نرجع للرئيسي بأمان
  useEffect(() => {
    if (!activeBranchId) return; // '' = كل الفروع، صالح دائماً
    if (loading) return;
    if (!branches.some(b => b.id === activeBranchId)) setActiveBranchId(MAIN_BRANCH_ID);
  }, [branches, activeBranchId, loading, setActiveBranchId]);

  const activeBranch = branches.find(b => b.id === activeBranchId) ?? branches[0];
  /** الفرع الذي تُوسم به السجلات الجديدة — في وضع «كل الفروع» نستخدم الرئيسي. */
  const stampBranchId = activeBranchId || MAIN_BRANCH_ID;

  /** هل يظهر هذا السجل في العرض الحالي؟ ('' = كل الفروع ⇒ يظهر كل شيء) */
  const matchesActiveBranch = useCallback(
    (record: { branchId?: string } | null | undefined): boolean =>
      !activeBranchId || branchOf(record) === activeBranchId,
    [activeBranchId],
  );

  const branchName = useCallback(
    (id?: string) => branches.find(b => b.id === branchOf({ branchId: id }))?.name ?? 'الفرع الرئيسي',
    [branches],
  );

  return {
    branches, activeBranches, sellingBranches, isMultiBranch, loading,
    activeBranchId, setActiveBranchId, activeBranch, stampBranchId,
    matchesActiveBranch, branchName,
    /** هل الموقع النشط مخزن؟ (لا صندوق ولا بيع مباشر منه) */
    activeIsWarehouse: isWarehouse(branches.find(b => b.id === activeBranchId)),
    saveBranch: save, removeBranch: remove,
    isOwner: role === 'owner',
  };
}
