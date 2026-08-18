/* =========================================================================
   Vision Guard — account-shared.js

   The pieces of the account page that BOTH halves need: the copy table, the
   signed-in user, and the four presentation helpers that format a button, an
   error line and a status tag.

   It exists because account.js was split (see account-admin.js) and these are
   the only things that genuinely straddle the seam. Everything else belongs
   to one side or the other, and putting it here instead would just rebuild
   the single file that was split.

   `me` is exported as a live binding rather than through a getter: importers
   see reassignment automatically, so the code moved out of account.js reads
   `me` exactly as it always did. Assignment has to go through setMe() — an
   imported binding is read-only to everyone but its own module, which is the
   property that makes one writer and many readers safe here.
   ========================================================================= */
import { $, t, esc, hoursLabel, ApiError } from './site.js?v=66';

/* -------------------------------------------------------------------------
   The signed-in user, or null.
   ------------------------------------------------------------------------- */
export let me = null;
export function setMe(user) { me = user; }

/* -------------------------------------------------------------------------
   Copy owned by JavaScript.

   Kept whole rather than split along the same seam as the code. The admin-only
   entries are perhaps four kilobytes of text that a customer never displays,
   which is real but small; carving the table in two would mean auditing every
   key for which side uses it, and a key filed on the wrong side fails as a
   blank label on screen rather than as anything a check would catch.
   ------------------------------------------------------------------------- */
export const T = {
  hello:        { ar: 'أهلاً', en: 'Hello' },
  noOrders:     { ar: 'لسه مافيش طلبات على الحساب ده.', en: 'No orders on this account yet.' },
  noOrdersHint: { ar: 'أول طلب هيظهر هنا فورًا بعد ما تأكده.', en: 'Your first order shows up here the moment you place it.' },
  items:        { ar: 'منتج', en: 'items' },
  saved:        { ar: 'اتحفظت التغييرات.', en: 'Changes saved.' },
  saving:       { ar: 'جاري الحفظ…', en: 'Saving…' },
  save:         { ar: 'احفظ التغييرات', en: 'Save changes' },
  signingIn:    { ar: 'جاري الدخول…', en: 'Signing in…' },
  signIn:       { ar: 'تسجيل الدخول', en: 'Sign in' },
  creating:     { ar: 'جاري إنشاء الحساب…', en: 'Creating your account…' },
  create:       { ar: 'اعمل الحساب', en: 'Create account' },
  resetSent:    {
    ar: 'لو فيه حساب بالإيميل ده، هيوصلك لينك تغيير كلمة السر. بص في الـ Spam كمان.',
    en: 'If an account exists for that address, a reset link is on its way. Check your spam folder too.'
  },
  verifySent:   {
    ar: 'اتبعتلك رسالة تأكيد على الإيميل. مش لازم تأكد دلوقتي عشان تشتري.',
    en: 'We sent you a confirmation email. You do not need to confirm it before ordering.'
  },
  /* Shown when the Google window closes before the sign-in finishes. Covers
     BOTH a deliberate cancel and a popup handshake that failed — Firebase
     reports them with the same code, so the wording has to be true of
     either, and it has to offer a way forward that is not the popup. See
     googleFlow() in account.js. */
  googleIncomplete: {
    ar: 'قفلت نافذة جوجل قبل ما الدخول يخلص. جرّب تاني، أو ادخل بالإيميل وكلمة السر.',
    en: 'The Google window closed before sign-in finished. Try again, or sign in with your email and password.'
  },

  clockIn:      { ar: 'تسجيل حضور', en: 'Clock in' },
  clockOut:     { ar: 'تسجيل انصراف', en: 'Clock out' },
  working:      { ar: 'مسجّل حضور دلوقتي', en: 'Clocked in' },
  notWorking:   { ar: 'مش مسجّل حضور', en: 'Not clocked in' },
  since:        { ar: 'من', en: 'since' },
  ofTarget:     { ar: 'من الهدف', en: 'of target' },
  targetNote:   {
    ar: 'يوم العمل ٦ ساعات. الدائرة بتملى مع الوقت المسجّل النهارده.',
    en: 'The working day is 6 hours. The dial fills with the time recorded today.'
  },
  attFoot:      {
    ar: 'الأوقات بتتسجل على ساعة السيرفر بتوقيت القاهرة — مش ساعة جهازك. لو نسيت تسجّل انصراف، اليوم بيتقفل تلقائيًا على مدة اليوم المتعاقد عليها وبيتعلّم عليه.',
    en: 'Times come from the server clock on Cairo time, not your device. If you forget to clock out, the shift is auto-closed at the contracted day length and flagged.'
  },
  daysWorked:   { ar: 'أيام حضور', en: 'Days worked' },
  totalHours:   { ar: 'إجمالي الساعات', en: 'Total hours' },
  expected:     { ar: 'المطلوب', en: 'Expected' },
  balance:      { ar: 'الفرق', en: 'Balance' },
  noAtt:        { ar: 'مافيش أيام مسجّلة في الفترة دي.', en: 'Nothing recorded in this period.' },
  stillIn:      { ar: 'مستمر', en: 'open' },

  teamNote:     {
    ar: 'كل حساب على دومين الشركة، ليوم واحد. الترتيب بالأهم: الغياب والناقص الأول.',
    en: 'Every account on the company domain, for one day. Ordered by what needs attention: absent and short first.'
  },
  teamFoot:     {
    ar: 'العرض ده للقراءة بس — مافيش تعديل على سجلات الحضور من هنا. لو حد نسي يسجّل انصراف، الوردية بتتقفل تلقائيًا على ٦ ساعات وبيتعلّم عليها في تبويب الموظف نفسه.',
    en: 'This view is read-only — attendance records cannot be edited from here. A forgotten clock-out is auto-closed at 6 hours and flagged on the employee’s own tab.'
  },
  allComplete:  { ar: 'كل الموظفين كمّلوا يومهم.', en: 'Everyone completed their day.' },
  notComplete:  { ar: 'فيه حالات محتاجة مراجعة.', en: 'Some days need a look.' },
  noStaff:      { ar: 'مافيش حسابات موظفين على الدومين لسه.', en: 'No staff accounts on the domain yet.' },
  employees:    { ar: 'موظفين', en: 'Employees' },
  complete:     { ar: 'مكمّلين', en: 'Complete' },
  shortCount:   { ar: 'ناقصين', en: 'Short' },
  absentCount:  { ar: 'غياب', en: 'Absent' },
  openCount:    { ar: 'لسه شغّالين', en: 'Still in' },
  shortDays:    { ar: 'أيام ناقصة', en: 'Short days' },
  rangeTitle:   { ar: 'إجمالي الفترة', en: 'Totals for the range' },
  you:          { ar: 'إنت', en: 'you' },

  revenue:      { ar: 'الإيرادات', en: 'Revenue' },
  ordersWord:   { ar: 'طلبات', en: 'Orders' },
  avgOrder:     { ar: 'متوسط الطلب', en: 'Average order' },
  customersWord:{ ar: 'عملاء', en: 'Customers' },
  todayWord:    { ar: 'النهارده', en: 'Today' },
  trafficWord:  { ar: 'الزيارات', en: 'Traffic' },
  visitorsWord: { ar: 'الزوار', en: 'Visitors' },
  pageViews:    { ar: 'صفحات', en: 'Page views' },
  searchesWord: { ar: 'بحث', en: 'Searches' },
  addToCartWord:{ ar: 'إضافة للعربة', en: 'Add to cart' },
  checkoutWord: { ar: 'بدء الدفع', en: 'Checkout started' },
  purchasesWord:{ ar: 'مبيعات', en: 'Purchases' },
  marketingWord:{ ar: 'التسويق', en: 'Marketing' },
  pixelStatus:  { ar: 'حالة البيكسل', en: 'Pixel status' },
  noFile:       { ar: 'مافيش صورة متختارة', en: 'No image chosen' },
  productWord:  { ar: 'المنتج', en: 'Product' },
  totalWord:    { ar: 'الإجمالي', en: 'Total' },
  /* Column headings for the events-by-product table. Keyed by the Meta event
     name so renderPerf can look one up directly; an event with no entry here
     falls back to showing its raw name, which is why a new event in track.js
     needs no change on this side to appear. */
  ev_ViewContent:      { ar: 'مشاهدات', en: 'Views' },
  ev_Search:           { ar: 'بحث', en: 'Searches' },
  ev_AddToCart:        { ar: 'للسلة', en: 'Add to cart' },
  ev_InitiateCheckout: { ar: 'بدء الدفع', en: 'Checkout' },
  ev_AddPaymentInfo:   { ar: 'طريقة الدفع', en: 'Payment info' },
  ev_Purchase:         { ar: 'شراء', en: 'Purchases' },
  eventBreakdown:{ ar: 'تفصيل الأحداث', en: 'Event breakdown' },
  eventWord:    { ar: 'حدث', en: 'Event' },
  countWord:    { ar: 'العدد', en: 'Count' },
  directPasswordUpdate:{ ar: 'تم تحديث كلمة السر.', en: 'Password updated.' },
  directPasswordSet:{ ar: 'تحديث كلمة السر', en: 'Update password' },
  vsPrevious:   { ar: 'مقارنة بالفترة اللي قبلها', en: 'vs the period before' },
  noCompare:    { ar: 'مافيش فترة سابقة نقارن بيها لسه.', en: 'No earlier period to compare with yet.' },
  busiest:      { ar: 'أعلى يوم', en: 'Busiest day' },
  noData:       { ar: 'مافيش بيانات في الفترة دي.', en: 'Nothing in this period.' },
  alertsFailed: { ar: 'تنبيهات ماوصلتش', en: 'Alerts that never arrived' },
  allDelivered: { ar: 'كل تنبيهات الطلبات وصلت.', en: 'Every order alert was delivered.' },
  alertsNotDelivered: { ar: 'تنبيهات ماوصلتش', en: 'Alerts not delivered' },
  cancelledWord:{ ar: 'ملغية', en: 'Cancelled' },
  accountsWord: { ar: 'حسابات', en: 'Accounts' },
  mailingList:  { ar: 'القائمة البريدية', en: 'Mailing list' },
  onShiftNow:   { ar: 'على الشيفت دلوقتي', en: 'On shift now' },

  /* The Meta business-verification banner. Administrators only, on the
     dashboard, until the marketing connection actually works. */
  mvTitle:      {
    ar: 'حساب Meta Business محتاج توثيق',
    en: 'Your Meta Business account needs verification'
  },
  mvBody:       {
    ar: 'أرقام التسويق (فيسبوك وإنستجرام والإعلانات) مش هتظهر قبل ما توثّق الشركة في Meta Business. التوثيق هو اللي بيسمح بإصدار توكن System User بصلاحية قراءة الإعلانات — من غيره Meta بترفض الطلبات.',
    en: 'The marketing numbers — Facebook, Instagram and ads — stay empty until the business is verified with Meta. Verification is what allows a System User token carrying ads_read; without it Meta refuses the calls.'
  },
  mvGo:         { ar: 'ابدأ التوثيق', en: 'Start verification' },
  mvLater:      { ar: 'بعدين', en: 'Later' },

  mDelete:      { ar: 'حذف', en: 'Delete' },
  mReset:       { ar: 'إعادة تعيين كلمة السر', en: 'Reset password' },
  mTerminate:   { ar: 'إنهاء الحساب', en: 'Terminate' },
  mNone:        { ar: 'مافيش نتائج.', en: 'Nothing to show.' },
  mSaved:       { ar: 'اتحفظ.', en: 'Saved.' },
  mResetSent:   { ar: 'اتبعتت رسالة تغيير كلمة السر.', en: 'Password reset email sent.' },
  mNotReg:      { ar: 'الحساب ده لسه معملش كلمة سر. لازم يسجل من صفحة الدخول الأول.', en: 'No password set yet — they need to register from the sign-in page first.' },
  mCreated:     { ar: 'اتعمل الحساب واتبعتت رسالة كلمة السر.', en: 'Account created and a password email sent.' },
  mAdminRow:    { ar: 'إدارة', en: 'Admin' },
  mStaffRow:    { ar: 'موظف', en: 'Staff' },
  mCustRow:     { ar: 'عميل', en: 'Customer' },
  mNever:       { ar: 'عمره ما دخل', en: 'never' },
  mConfirmDel:  { ar: 'حذف الطلب ده نهائيًا؟ ده بيشيله من سجلاتك الضريبية ومش هينفع يترجع.', en: 'Delete this order permanently? It leaves your tax records and cannot be undone.' },
  mConfirmTerm: { ar: 'إنهاء حساب {name} نهائيًا؟ الطلبات هتفضل بس من غير بياناته.', en: 'Terminate {name} permanently? Their orders are kept but anonymised.' },
  cNotice:      { ar: 'التعديلات هنا بتتحفظ في قاعدة البيانات، بس المتجر لسه بيقرا الأسعار من الملف — التبديل ده خطوة لوحدها عشان التسعير على السيرفر ميتكسرش.', en: 'Edits here are saved to the database, but the shop still prices from the file — switching that over is its own step, so server-side pricing cannot break silently.' },
  cAdd:         { ar: 'أضف منتج', en: 'Add a product' },
  cEditT:       { ar: 'تعديل منتج', en: 'Edit product' },
  cNewT:        { ar: 'منتج جديد', en: 'New product' },
  cEdit:        { ar: 'تعديل', en: 'Edit' },
  cShown:       { ar: 'ظاهر', en: 'Shown' },
  cHidden:      { ar: 'مخفي', en: 'Hidden' },
  cSaved:       { ar: 'اتحفظ.', en: 'Saved.' },
  cNone:        { ar: 'مافيش منتجات.', en: 'No products.' },
  cDelConfirm:  { ar: 'حذف {name} نهائيًا من الكتالوج؟ الطلبات القديمة مش هتتأثر — كل طلب محتفظ بنسخته من الاسم والسعر.', en: 'Delete {name} from the catalogue permanently? Past orders are unaffected — each one keeps its own snapshot of the name and price.' },

  /* The categories tab. `gInUse` and `gDelConfirm` carry the distinction the
     whole tab rests on: hiding keeps the products on sale, deleting is only
     possible once the group is empty. */
  gNewT:        { ar: 'قسم جديد', en: 'New category' },
  gEditT:       { ar: 'تعديل قسم', en: 'Edit category' },
  gNone:        { ar: 'مافيش أقسام.', en: 'No categories.' },
  gHide:        { ar: 'إخفاء', en: 'Hide' },
  gShow:        { ar: 'إظهار', en: 'Show' },
  gNoCover:     { ar: '— من غير صورة —', en: '— no picture —' },
  gSeeded:      {
    ar: 'اتنسخت {n} أقسام من الملف عشان تقدر تعدّلها من هنا.',
    en: '{n} categories were copied from the built-in list so they can be edited here.'
  },
  gInUse:       {
    ar: 'فيه {n} منتج لسه في «{name}». انقلهم لقسم تاني الأول، أو اخفي القسم — الإخفاء بيسيبهم معروضين للبيع.',
    en: '{n} products are still in “{name}”. Move them to another category first, or hide it instead — hiding keeps them on sale.'
  },
  gDelConfirm:  {
    ar: 'حذف «{name}» نهائيًا؟ القسم فاضي، فمافيش منتجات هتتأثر.',
    en: 'Delete “{name}” permanently? It is empty, so no products are affected.'
  },

  /* The two spreadsheet downloads. */
  xCatalog:     { ar: 'تصدير لميتا (Excel)', en: 'Export for Meta (.xlsx)' },
  xData:        { ar: 'تصدير البيانات (Excel)', en: 'Export data (.xlsx)' },
  xBusy:        { ar: 'جاري التحضير…', en: 'Preparing…' },
  xDone:        { ar: 'اتنزّل الملف — {n} صف.', en: 'Downloaded — {n} rows.' },
  xEmpty:       { ar: 'اتنزّل الملف، بس لسه مافيش بيانات — العناوين بس.', en: 'Downloaded, but there is nothing in it yet — headers only.' },
  xWarn:        { ar: 'ميتا هترفض الصفوف دي: {list}', en: 'Meta will reject these rows: {list}' },
  /* Clocked in and straight back out — a double-tap, not a working day.
     Without its own entry statusTag() falls back to st_short, which is
     exactly the wrong thing to call it: it is not a short day, it is not a
     day. See MISTAP_SECONDS in lib/attendance.js. */
  st_mistap:    { ar: 'ضغطة بالغلط', en: 'Mis-tap' },

  /* Your profile picture. */
  avSaved:      { ar: 'اتحفظت الصورة.', en: 'Your picture has been saved.' },
  avRemoved:    { ar: 'اتشالت الصورة.', en: 'Your picture has been removed.' },
  avUploading:  { ar: 'جاري الرفع…', en: 'Uploading…' },

  /* Changing your own password. */
  pwChange:     { ar: 'غيّر كلمة السر', en: 'Change password' },
  pwChanging:   { ar: 'جاري التغيير…', en: 'Changing…' },
  pwDone:       { ar: 'اتغيرت كلمة السر.', en: 'Your password has been changed.' },
  pwSame:       { ar: 'دي نفس كلمة السر الحالية.', en: 'That is the password you already have.' },
  pwNeedBoth:   { ar: 'اكتب كلمة السر الحالية والجديدة.', en: 'Enter both your current and new password.' },
  st_complete:  { ar: 'مكتمل', en: 'Complete' },
  st_short:     { ar: 'ناقص', en: 'Short' },
  st_overtime:  { ar: 'إضافي', en: 'Overtime' },
  st_open:      { ar: 'شغّال', en: 'Open' },
  st_absent:    { ar: 'غياب', en: 'Absent' },

  o_new:        { ar: 'جديد', en: 'New' },
  o_confirmed:  { ar: 'مؤكد', en: 'Confirmed' },
  o_shipped:    { ar: 'اتشحن', en: 'Shipped' },
  o_done:       { ar: 'تم', en: 'Done' },
  o_cancelled:  { ar: 'ملغي', en: 'Cancelled' },

  /* WHERE THE MONEY IS — the second axis, beside the five above. Keyed
     `pay_<status>` so a lookup is `T['pay_' + o.paymentStatus]` from either
     side of the dashboard and from a customer's own order list. See the note
     in lib/orders.js about why this is not folded into the order status. */
  pay_pending:  { ar: 'لسه ما اتدفعش', en: 'Awaiting payment' },
  pay_paid:     { ar: 'اتدفع', en: 'Paid' },
  pay_failed:   { ar: 'الدفع فشل', en: 'Payment failed' },
  payNow:       { ar: 'كمّل الدفع على واتساب', en: 'Pay on WhatsApp' },
  paySaved:     { ar: 'اتحفظت حالة الدفع.', en: 'Payment status saved.' },

  /* Deleting a lead. Admin only — the API refuses it from an employee, so
     the button is not drawn for one either. The confirmation names what
     goes, because what goes is the history: every note anybody wrote about
     this person, which is the part nobody thinks about until it is gone. */
  ldDelete:     { ar: 'حذف العميل', en: 'Delete lead' },
  ldDelConfirm: {
    ar: 'حذف {name} نهائيًا من العملاء؟ كل الملاحظات والسجل بتاعهم هيتمسحوا. الطلبات مش هتتأثر.',
    en: 'Delete {name} from leads permanently? Every note and their whole history goes with them. Their orders are unaffected.'
  },
  ldDeleted:    { ar: 'اتمسح العميل.', en: 'Lead deleted.' },

  /* The promos tab. A code's STATE is not the same as its switch: a code
     that is switched on but whose window has closed is doing nothing, and
     the table has to be able to say which of those it is — otherwise the
     owner turns a live code off looking for the reason it "does not work". */
  pmCreate:     { ar: 'اعمل الكود', en: 'Create code' },
  pmCreated:    { ar: 'اتعمل كود {code}.', en: '{code} created.' },
  pmNone:       { ar: 'مافيش أكواد لسه.', en: 'No codes yet.' },
  pmAlways:     { ar: 'من غير مدة', en: 'No time limit' },
  pmLive:       { ar: 'شغّال', en: 'Live' },
  pmSoon:       { ar: 'لسه ما بدأش', en: 'Not started' },
  pmEnded:      { ar: 'انتهى', en: 'Ended' },
  pmUsedUp:     { ar: 'خلص', en: 'Used up' },
  pmOff:        { ar: 'متوقف', en: 'Switched off' },
  pmStop:       { ar: 'أوقفه', en: 'Switch off' },
  pmStart:      { ar: 'شغّله', en: 'Switch on' },
  pmNewOnly:    { ar: 'عملاء جدد', en: 'New customers' },
  pmAnyone:     { ar: 'أي حد', en: 'Anyone' },
  pmMinOver:    { ar: 'فوق', en: 'over' },
  pmDelConfirm: {
    ar: 'حذف كود {code}؟ محدش استخدمه لسه، فمافيش طلبات هتتأثر.',
    en: 'Delete {code}? Nobody has used it, so no orders are affected.'
  },
  /* The popup that greets a brand-new account. Two shapes, because the offer
     has two tiers on day one and one tier after that — and a sentence about
     "then 0%" would be nonsense. */
  wpopTiered:   {
    ar: 'خصم {pct}% على أول طلب ليك النهاردة، وبعدها {next}% لباقي الأيام.',
    en: '{pct}% off your first order today, then {next}% for the days after.'
  },
  wpopFlat:     {
    ar: 'خصم {pct}% على أول طلب ليك.',
    en: '{pct}% off your first order.'
  },
  wpopFine:     {
    ar: 'العرض صالح {days} أيام من دلوقتي، وبيتحسب تلقائيًا وإنت بتأكد الطلب.',
    en: 'The offer runs for {days} days from now and is applied automatically at checkout.'
  },

  /* The ad creatives tab. "Shipped" and "uploaded" are not decoration: they
     are the difference between a creative the dashboard can delete and one
     that needs a deploy, and the tag is the only place that is visible. */
  adUpload:     { ar: 'ارفع', en: 'Upload' },
  adUploaded:   { ar: 'مرفوع', en: 'Uploaded' },
  adShipped:    { ar: 'مع الموقع', en: 'In the site' },
  adBest:       { ar: 'مقاس ميتا', en: 'Meta size' },
  adUploaded2:  { ar: 'اترفع {name}.', en: '{name} uploaded.' },
  adNone:       { ar: 'مافيش تصاميم لسه.', en: 'No creatives yet.' },
  adPickFile:   { ar: 'اختار صورة الأول.', en: 'Choose an image first.' },
  adCopy:       { ar: 'انسخ اللينك', en: 'Copy the URL' },
  adCopied:     { ar: 'اتنسخ اللينك.', en: 'URL copied.' },
  adCopyManual: { ar: 'اللينك متحدد — انسخه بنفسك.', en: 'The URL is selected — copy it yourself.' },
  adDelConfirm: {
    ar: 'حذف {name}؟ أي إعلان شغّال بيستخدم اللينك ده هيبقى من غير صورة.',
    en: 'Delete {name}? Any live ad built from that URL will lose its image.'
  },

  pmOrderApply: { ar: 'طبّق على الطلب', en: 'Apply to the order' },
  pmOrderDone:  {
    ar: 'اتخصم {off} — الإجمالي بقى {total}.',
    en: '{off} taken off — the total is now {total}.'
  }
};

/* -------------------------------------------------------------------------
   Presentation helpers
   ------------------------------------------------------------------------- */
export function showFormError(errSel, err) {
  const el = $(errSel);
  el.textContent = err.display || err.message;
  el.hidden = false;
}

export function busy(btn, label) {
  btn.disabled = true;
  btn.innerHTML = `<span>${esc(label)}</span>`;
}
export function unbusy(btn, label) {
  btn.disabled = false;
  btn.innerHTML = `<span>${esc(label)}</span>`;
}

/* Firebase's own rule is six characters and nothing else. The hint under the
   field promises more than that, so the promise is kept here — a rule shown
   to someone and then not enforced is worse than no rule. */
export function checkPassword(password) {
  const p = typeof password === 'string' ? password : '';
  if (p.length < 8 || !/\p{L}/u.test(p) || !/\p{Nd}/u.test(p)) {
    throw new ApiError('weak_password', 'Password must be at least 8 characters, with a letter and a number.');
  }
}

export function statusTag(status) {
  const key = 'st_' + status;
  return `<span class="tag tag--${esc(status)}">${esc(t(T[key] || T.st_short))}</span>`;
}

export function signed(seconds) {
  const s = Math.round(seconds);
  const sign = s >= 0 ? '+' : '−';
  return sign + hoursLabel(Math.abs(s));
}
