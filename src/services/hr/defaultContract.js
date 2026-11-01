// Built-in employment contract (used when no template is saved in the database).
// Format: see models/contractTemplate.js. Placeholders: contractService.PLACEHOLDERS.
// Shop owners should have a lawyer review the wording for their province / AJK.

const DEFAULT_CONTRACT_NAME = 'Standard employment contract';

const DEFAULT_CONTRACT_BODY = `# EMPLOYMENT CONTRACT

This contract is made on **{{today}}** between **{{shop.name}}**, {{shop.address}} (the "Employer") and **{{employee.fullName}}**, {{employee.parentage}}, CNIC **{{employee.cnic}}**, {{employee.address}} (the "Employee").

## 1. Job
Position: **{{employee.designation}}** ({{employee.employmentType}}) at {{branch.name}}. Start date: **{{contract.startDate}}**. Term: {{contract.term}}.

## 2. Hours
Working hours: **{{employee.shift}}**. Weekly off: **{{employee.weeklyOff}}**. Extra hours, when needed, are paid as overtime or given back as time off.

## 3. Salary
**{{employee.salary}}** per month ({{employee.salaryInWords}}), paid by the **{{employee.salaryPayDay}}** of the next month {{employee.salaryPaymentMethod}}. Tax and agreed advance instalments are deducted.

## 4. Probation
The first **{{probationMonths}} months** (until {{employee.probationEndDate}}). During probation either side may end this contract with 7 days' notice.

## 5. Leave
10 days casual leave a year, and 14 days annual leave after each full year, with full pay. Sick leave as per law. Absence without approval is unpaid.

## 6. Cash, stock and conduct
The Employee is responsible for their till cash and for shop stock. Shortages or losses caused by the Employee's fault may be deducted from salary. The Employee will be on time, honest and polite, and will keep shop information private.

## 7. Ending the contract
After probation, either side gives one month's notice (or one month's salary instead). Theft, fraud or serious misconduct means dismissal without notice. Shop property must be returned before final dues are paid.

{{signatures}}
`;

module.exports = { DEFAULT_CONTRACT_NAME, DEFAULT_CONTRACT_BODY };
