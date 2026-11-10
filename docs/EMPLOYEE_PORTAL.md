# Employee Portal (read only) — Nov 2026

A staff login (User linked to an HR Employee by `Employee.user`) signs in with the
normal login and sees ONLY its own HR data. Nothing can be changed here.

- Backend: `src/routes/modules/employeePortalRoutes.js` (routes), `src/services/hr/portalService.js` (logic).
- Auth: any valid login (`...staff` = auth + loadAccess). No role permission is needed.
- The employee is always found from the login: `Employee.findOne({ user: req.access.userId, isDeleted: { $ne: true } })`.
  The browser never sends an employee id (query/body ids are ignored).
- No linked employee → `404 { success: false, message: 'No employee record is linked to this login. Ask the shop admin.', code: 'NO_EMPLOYEE' }`.
- Every success is `{ success: true, data }`, sent with `Cache-Control: no-store`.
- Never returned: CNIC, documents, guarantor, notes, history. Bank account number and IBAN show only the last 4 digits (`**********1234`).
- Payslips / bonuses come only from payroll runs with status `approved` or `paid` (drafts are hidden).
  Queries use `$elemMatch` so other employees' lines are never loaded.

## Endpoints (all GET, under `/api`)

| Endpoint | `data` |
|---|---|
| `/me/portal/profile` | `{ employee: { _id, name, firstName, lastName, code, designation, department, photo, phone, email, joiningDate, employmentType, payType, salary, dailyRate, salaryBreakdown { basic, allowances[{name, amount}] }, salaryPayDay, salaryPaymentMethod, bank { accountTitle, bankName, accountNumber (masked), iban (masked) }, status, shiftName, weeklyOff[], leave { month, paidPerMonth, paidUsed, paidLeft, sickPerMonth, sickUsed, sickLeft, unpaid } }, today: { date, status, checkIn, checkOut, planned { type, shiftName, start, end } } \| null, thisMonth, lastPayslip: { runId, lineId, month, monthLabel, net, status, paidAt } \| null, openAdvanceBalance, tipsThisMonth }` |
| `/me/portal/attendance?month=YYYY-MM` (default: this PKT month) | `{ month, summary, days: [{ date, status, planned { type, shiftName, start, end, leaveType, holidayName }, checkIn, checkOut, workedMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, overtimeApproved, lateExcused }] }` — `status` is the attendance status, or `upcoming` (future day) / `not_employed` (before joining / after leaving). Bad month → 400. |
| `/me/portal/payslips` | `{ payslips: [{ runId, runNo, month, monthLabel, runStatus, lineId, payslipNo, gross, totalDeductions, net, bonus, status (line: pending \| paid), paidAt }] }` newest first |
| `/me/portal/payslips/:runId` | `{ runId, runNo, month, monthLabel, runStatus, line: { lineId, payslipNo, payType, salary, dailyRate, dayRate, earnings[], deductions[], gross, totalDeductions, net, shortfall, bonus, bonusNote, adjustments[{label, amount, note}], advanceRecovery, attendance, employedDays, joinedOn, leftOn, notes[], status, paidAt }, employee { name, code, designation, department, joiningDate, paymentMethod, bank (masked) }, payment { date, method, methodLabel, reference } \| null, letterhead { shopName, shopAddress, shopPhone, logoUrl }, netInWords }` — 404 when the run is a draft, not theirs, or the id is bad. Built with `payrollService.payslip`. |
| `/me/portal/money` | `{ advances: [{ advanceNo, date, amount, installments, recovered, balance, status, note }], deductions: [{ type, amount, date, status, note, appliedMonth }], tips: [{ tipNo, day, amount, method, note }], bonuses: [{ month, monthLabel, runNo, amount, note }] }` — cancelled advances, waived deductions and deleted tips are left out. |

`thisMonth` / `summary` = `{ month, present, absent, late, halfDay, leave, off, upcoming, workedMinutes, lateMinutes, overtimeMinutes (approved), overtimePendingMinutes }`
from `attendanceCore.monthSummary` (present includes worked off days; off includes holidays).

Test: `harness/portal.test.js` (in-memory Mongo).
