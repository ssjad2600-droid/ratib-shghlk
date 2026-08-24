import React from 'react';
import { AlertTriangle, RefreshCw, Home, Copy, Check } from 'lucide-react';
import { reportError } from '../utils/errorReporter';
import { SUPPORT_PHONE } from '../config/adminConfig';

interface Props {
  /** اسم الشاشة أو السياق — يظهر في التقرير ليعرف المطوّر أين وقع الخطأ */
  screen: string;
  /** مفتاح يعيد التصفير تلقائياً عند تغيّره (تبديل التبويب مثلاً) */
  resetKey?: string;
  /** نطاق مصغّر: يعرض بطاقة داخل الصفحة بدل شاشة كاملة */
  inline?: boolean;
  onGoHome?: () => void;
  children: React.ReactNode;
}

interface State { error: Error | null; copied: boolean }

/**
 * حاجز الأخطاء — يمنع أخطر سلوك في أي تطبيق React: **بياض الشاشة الكامل**.
 *
 * بدونه، خطأ في مكوّن واحد يُسقط الشجرة كلها فيرى التاجر صفحة بيضاء بلا تفسير
 * ولا مخرج، ويتصل بك يقول «البرنامج خربان» بلا معلومة واحدة مفيدة.
 *
 * نستخدمه بطبقتين مقصودتين:
 *  · حول التطبيق كله — شبكة أخيرة.
 *  · حول محتوى الشاشة وحده — فانهيار شاشة واحدة يُبقي القائمة والرأس يعملان،
 *    ويستطيع التاجر الانتقال لشاشة أخرى ومواصلة عمله بدل توقّف المحل.
 *
 * ملاحظة: حواجز الأخطاء تتطلّب مكوّن صنف (class) — لا يوجد بديل بالخطّافات.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 🔴 الترتيب مقصود: **شجرة المكوّنات أولاً**. أثر التنفيذ الخام يمتلئ بداخليات
    // react-dom عديمة الفائدة، وكان يلتهم حدّ الحجم كله فتُقصّ الشجرة — وهي وحدها
    // ما يدلّ على المكوّن المذنب. ونقتطع كل جزء على حدة كي يصل الاثنان معاً.
    const tree = (info.componentStack ?? '').split('\n').slice(0, 14).join('\n');
    const js = (error.stack ?? '').split('\n').slice(0, 8).join('\n');
    const enriched = new Error(error.message);
    enriched.stack = `--- شجرة المكوّنات ---\n${tree}\n--- أثر التنفيذ ---\n${js}`;
    reportError(enriched, this.props.screen, 'render');
  }

  componentDidUpdate(prev: Props) {
    // تبديل الشاشة يُصفّر الحاجز تلقائياً — وإلا بقيت رسالة الخطأ عالقة بعد المغادرة
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, copied: false });
    }
  }

  private retry = () => this.setState({ error: null, copied: false });

  private copyDetails = () => {
    const { error } = this.state;
    if (!error) return;
    const text = `الشاشة: ${this.props.screen}\nالخطأ: ${error.message}\n${(error.stack ?? '').slice(0, 800)}`;
    navigator.clipboard?.writeText(text).then(
      () => { this.setState({ copied: true }); setTimeout(() => this.setState({ copied: false }), 2500); },
      () => { /* تعذّر النسخ — غير حرج */ },
    );
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { inline, onGoHome } = this.props;

    const card = (
      <div className="bg-white rounded-2xl border-2 border-rose-200 shadow-sm p-6 max-w-lg w-full text-right" dir="rtl">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-11 h-11 rounded-2xl bg-rose-50 border border-rose-200 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5.5 h-5.5 text-rose-700" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-extrabold text-[#0B1F4D] font-cairo">حدث خلل في هذه الشاشة</h2>
            <p className="text-[11px] text-slate-500 font-bold mt-0.5">
              بياناتك سليمة ولم يضِع شيء — الخلل في العرض فقط
            </p>
          </div>
        </div>

        <p className="text-[11px] text-slate-600 font-bold leading-relaxed bg-slate-50 rounded-xl p-3 border border-slate-200">
          أُرسل تقرير تلقائي للمطوّر بتفاصيل الخلل. جرّب «إعادة المحاولة» أولاً،
          فإن تكرّر انتقل لشاشة أخرى وتابع عملك، وتواصل مع الدعم على
          <span className="font-mono font-extrabold text-[#0B1F4D]" dir="ltr"> {SUPPORT_PHONE}</span>.
        </p>

        <details className="mt-3">
          <summary className="text-[10px] font-extrabold text-slate-500 cursor-pointer select-none">
            التفاصيل التقنية (للدعم)
          </summary>
          <pre className="mt-2 p-2.5 bg-slate-900 text-slate-200 rounded-xl text-[11px] leading-relaxed overflow-x-auto max-h-40" dir="ltr">
{`${this.props.screen}: ${error.message}`}
          </pre>
        </details>

        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <button onClick={this.retry}
            className="px-4 py-2.5 bg-[#0B1F4D] hover:bg-[#13295E] text-white font-extrabold rounded-xl text-xs cursor-pointer flex items-center gap-1.5">
            <RefreshCw className="w-4 h-4" /> إعادة المحاولة
          </button>
          {onGoHome && (
            <button onClick={() => { this.retry(); onGoHome(); }}
              className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-extrabold rounded-xl text-xs cursor-pointer flex items-center gap-1.5">
              <Home className="w-4 h-4" /> الشاشة الرئيسية
            </button>
          )}
          <button onClick={this.copyDetails}
            className="px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-extrabold rounded-xl text-xs cursor-pointer flex items-center gap-1.5">
            {this.state.copied ? <Check className="w-4 h-4 text-emerald-700" /> : <Copy className="w-4 h-4" />}
            {this.state.copied ? 'نُسخت' : 'نسخ التفاصيل'}
          </button>
        </div>
      </div>
    );

    if (inline) return <div className="py-6 flex justify-center">{card}</div>;

    return (
      <div className="min-h-screen bg-[#EEF2F8] flex items-center justify-center p-4 font-tajawal">
        {card}
      </div>
    );
  }
}
