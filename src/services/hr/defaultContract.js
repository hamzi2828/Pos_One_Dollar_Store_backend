// Built-in employment contract (used when no template is saved in the database).
// Format: see models/contractTemplate.js. Placeholders: contractService.PLACEHOLDERS.
// Shop owners should have a lawyer review the wording for their province / AJK.

const DEFAULT_CONTRACT_NAME = 'Standard employment contract';

const DEFAULT_CONTRACT_BODY = `# EMPLOYMENT CONTRACT

This Employment Contract (the "Contract") is made on **{{today}}** between:

**{{shop.name}}**, {{shop.address}} (the "Employer"); and

**{{employee.fullName}}**, {{employee.parentage}}, CNIC No. **{{employee.cnic}}**, residing at {{employee.address}} (the "Employee"), employee code {{employee.code}}.

## 1. Position and duties
The Employer appoints the Employee as **{{employee.designation}}** on a {{employee.employmentType}} basis. The Employee will do the work of this position honestly, carefully and to the best of their ability, including:
- serving customers politely and helping them find what they need;
- operating the sale counter (POS), giving a printed receipt for every sale and handling cash and card payments correctly;
- receiving, checking, pricing, shelving and arranging stock, and keeping racks full, tidy and correctly labelled;
- keeping the shop floor, shelves, counters and store room clean;
- any other reasonable work given by the manager that suits the Employee's position.

## 2. Place of work
The Employee will work at the Employer's shop **{{branch.name}}** ({{branch.address}}).

## 3. Start date and term
Employment starts on **{{contract.startDate}}**. Term: {{contract.term}}.

## 4. Working hours and weekly off
Working hours are **{{employee.shift}}**, with breaks for meals and prayers as arranged by the manager. The Employee's weekly off is **{{employee.weeklyOff}}**. In busy seasons (for example Ramadan, Eid and school opening) the Employee may be asked to work extra hours or on the weekly off; this time will be paid as overtime or given back as time off, as agreed with the manager and as required by law.

## 5. Salary and payment
The Employee's gross monthly salary is **{{employee.salary}}** ({{employee.salaryInWords}}), made up of basic salary of {{employee.basicSalary}} and allowances: {{employee.allowances}}.

Salary for each month is paid on or before the **{{employee.salaryPayDay}}** of the following month {{employee.salaryPaymentMethod}}, against the Employee's signature or bank record. Income tax and other deductions required by law, and agreed instalments of any advance or loan, will be deducted from the salary. Salary is reviewed once a year based on performance.

## 6. Probation
The first **{{probationMonths}} months** of employment (until {{employee.probationEndDate}}) are a probation period. During probation the Employer will review the Employee's work, punctuality and honesty, and either party may end this Contract by giving **7 days'** written notice. The Employer may extend probation once, by up to 3 months, by telling the Employee in writing before it ends.

## 7. Leave
- Casual leave: 10 days a year with full pay, to be asked for in advance whenever possible.
- Sick leave: as allowed by law, with a medical certificate for an absence of more than 2 days.
- Annual leave: 14 days with full pay after each 12 months of continuous service, at a time agreed with the manager (normally not during Eid or other peak sale days).
- Public holidays: as notified by the Employer. If the shop opens on a public holiday the Employee may be asked to work and will get another day off instead.
Absence without approval is unpaid and may lead to disciplinary action.

## 8. Cash handling and till shortages
The Employee is responsible for the cash, card slips and vouchers in their till. Cash is counted together with the manager at the start and end of every shift and both sign the closing record. If the till is short, the Employee will first be given the chance to explain in writing. A shortage caused by the Employee's negligence or fault may then be recovered from the Employee's salary, within the limits allowed by law. Deliberate theft or fraud is gross misconduct (clause 12).

## 9. Care of stock and shop property
The Employee will handle stock, racks, POS equipment and all other shop property with care, follow the receiving and stock-count procedures, and report any damage, breakage, expiry or loss to the manager at once. No stock may be taken, used, given as a gift or sold at a discount without the manager's approval and a proper entry in the system. Loss or damage caused deliberately or through gross negligence may be recovered from the Employee after an inquiry, within the limits allowed by law.

## 10. Confidentiality
During and after employment the Employee will not share the Employer's confidential information with anyone outside the business, including purchase prices and costs, supplier details, sales figures, customer details, passwords and security arrangements. All records, files and data remain the Employer's property.

## 11. Conduct
The Employee will be on time, wear the shop uniform and ID card, treat customers and colleagues with respect, and follow the shop rules and the manager's reasonable instructions. Smoking inside the shop, drugs, harassment, fighting and personal mobile phone use at the counter are not allowed. While employed, the Employee will not work for or run a business that competes with the Employer.

## 12. Termination and notice
After probation, either party may end this Contract by giving **one month's** written notice, or one month's gross salary instead of notice. The Employer may end this Contract without notice for gross misconduct — such as theft, fraud, dishonesty, violence, serious damage to property or repeated absence without leave — after giving the Employee a fair hearing. On leaving, the Employee will return all shop property (keys, uniform, ID card, equipment) and hand over their work. Final dues are paid after clearance, less any amount the Employee owes the Employer.

## 13. General
This Contract is governed by the laws of Pakistan that apply where the branch is located. Any change to it must be in writing and signed by both parties. The Employee confirms that they have read and understood this Contract (or had it explained to them in Urdu) and sign it of their own free will. Each party keeps one signed copy.

{{signatures}}
`;

module.exports = { DEFAULT_CONTRACT_NAME, DEFAULT_CONTRACT_BODY };
