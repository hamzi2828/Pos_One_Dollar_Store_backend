// src/constants/rolePermissions.js
// Canonical permission catalogue — mirrors the admin sidebar structure.
// Each SECTION maps to one sidebar section; each GROUP maps to one tab inside it.
// The frontend fetches this list so both sides stay in sync.

const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

const PERMISSION_SECTIONS = [
    {
        key: 'main',
        label: 'Main',
        iconKey: 'main',
        groups: [
            { key: 'dashboard', label: 'Dashboard', actions: ['view', 'export'] },
            { key: 'pos', label: 'POS', actions: ['view', 'create', 'edit', 'delete', 'export'] },
            { key: 'pos_orders', label: 'POS Orders', actions: ['view', 'create', 'edit', 'delete', 'export'] },
            // Give a free gift item at the POS (its cost goes to cost of sales).
            { key: 'pos_gifts', label: 'POS Gifts', actions: ['view', 'create'] },
            // Own till: open with a float, blind cash closing (cannot see expected cash / sales).
            { key: 'till', label: 'Till & Cash Closing', actions: ['view', 'create', 'edit'] },
            // Admin side of cash closing: see expected vs counted, approve / reject.
            { key: 'till_verify', label: 'Verify Cash Closing', actions: ['view', 'edit', 'export'] },
            // Sale counters (registers) and their open/close cut-off times.
            { key: 'sale_counters', label: 'Sale Counters', actions: ['view', 'create', 'edit', 'delete'] },
        ],
    },
    {
        key: 'purchasing',
        label: 'Purchasing & Vendors',
        iconKey: 'purchasing',
        groups: [
            { key: 'purchase_orders', label: 'Purchase Orders', actions: ['view', 'create', 'edit', 'delete', 'export'] },
            // Verify what actually arrived (the receiver can be a different person than the buyer).
            { key: 'goods_receiving', label: 'Goods Receiving', actions: ['view', 'create', 'edit'] },
            { key: 'vendors', label: 'Vendors & Ledger', actions: ['view', 'create', 'edit', 'delete', 'export'] },
            { key: 'vendor_payments', label: 'Vendor Payments', actions: ['view', 'create', 'edit', 'delete'] },
            // Sale-or-return stock placed by vendors; settled on their next visit.
            { key: 'consignment', label: 'Consignment', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'vendor_returns', label: 'Vendor Returns', actions: ['view', 'create', 'edit', 'delete'] },
        ],
    },
    {
        key: 'inventory',
        label: 'Inventory & Warehouse',
        iconKey: 'inventory',
        groups: [
            { key: 'racks', label: 'Racks & Shelves', actions: ['view', 'create', 'edit', 'delete'] },
            // Move stock warehouse -> shelf, shelf -> shelf, shelf -> warehouse.
            { key: 'stock_putaway', label: 'Put-away / Move', actions: ['view', 'create'] },
            { key: 'stock_movements', label: 'Stock Movements', actions: ['view', 'export'] },
            // edit = approve a damage report (stock is taken out on approval).
            { key: 'damages', label: 'Damaged Stock', actions: ['view', 'create', 'edit', 'delete', 'export'] },
            // Items taken from the shop's own stock for shop use (posted as an expense).
            { key: 'shop_use', label: 'Shop Use', actions: ['view', 'create', 'delete'] },
            { key: 'stock_adjustments', label: 'Stock Adjustments', actions: ['view', 'create'] },
        ],
    },
    {
        key: 'reports',
        label: 'Reports',
        iconKey: 'reports',
        groups: [
            { key: 'report_sales', label: 'Sales Reports', actions: ['view', 'export'] },
            { key: 'report_cost_analysis', label: 'Cost Analysis', actions: ['view', 'export'] },
            { key: 'report_stock', label: 'Stock', actions: ['view', 'export'] },
            { key: 'report_expenses', label: 'Expenses', actions: ['view', 'export'] },
            { key: 'report_receivables', label: 'Receivables', actions: ['view', 'export'] },
            { key: 'report_cash_in_hand', label: 'Cash in Hand', actions: ['view', 'export'] },
            { key: 'report_demand', label: 'Demand List', actions: ['view', 'edit', 'export'] }, // edit = threshold % / par levels
            { key: 'report_trends', label: 'Sales Trends', actions: ['view', 'export'] },
            { key: 'report_slow_moving', label: 'Slow Moving', actions: ['view', 'edit', 'export'] }, // edit = days / sold % rule
            { key: 'report_footfall', label: 'Footfall', actions: ['view', 'create', 'edit', 'delete', 'export'] }, // create/edit/delete = daily visitor counts
            { key: 'report_category_performance', label: 'Category Performance', actions: ['view', 'export'] },
            { key: 'report_cash_closing', label: 'Cash Closing', actions: ['view', 'export'] },
            { key: 'report_stock_movement', label: 'Stock Timeline', actions: ['view', 'export'] },
        ],
    },
    {
        key: 'product_management',
        label: 'Product Management',
        iconKey: 'products',
        groups: [
            { key: 'products', label: 'Products', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'product_categories', label: 'Categories', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'product_attributes', label: 'Attributes', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'product_stock', label: 'Stock', actions: ['view', 'create', 'edit', 'delete'] },
            // Receive stock into the shop (POST /products/:id/stock/receive).
            { key: 'stock_receive', label: 'Receive Stock', actions: ['view', 'create'] },
            // Bill discount rules (overall % / fixed, spend-over cut-off).
            { key: 'discounts', label: 'Discounts', actions: ['view', 'create', 'edit', 'delete'] },
            // Fixed sale price points (e.g. Rs 280 / Rs 499) shared by many products.
            { key: 'price_tiers', label: 'Price Tiers', actions: ['view', 'create', 'edit', 'delete'] },
        ],
    },
    {
        key: 'customer_management',
        label: 'Customers',
        iconKey: 'customers',
        groups: [
            { key: 'customers', label: 'Customers', actions: ['view', 'create', 'edit', 'delete'] },
        ],
    },
    {
        key: 'finance',
        label: 'Finance',
        iconKey: 'finance',
        groups: [
            { key: 'banks', label: 'Banks', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'expenses', label: 'Expenses', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'assets', label: 'Assets', actions: ['view', 'create', 'edit', 'delete', 'export'] },
            // Money put into the shop (setup / growth bills) and the total invested.
            { key: 'investments', label: 'Investment', actions: ['view', 'create', 'edit', 'delete', 'export'] },
        ],
    },
    {
        key: 'hr',
        label: 'HR',
        iconKey: 'hr',
        groups: [
            { key: 'employees', label: 'Employees', actions: ['view', 'create', 'edit', 'delete'] },
            // Shift types, holidays and the weekly roster (who works when).
            { key: 'shifts', label: 'Shifts & Roster', actions: ['view', 'create', 'edit', 'delete'] },
            // Attendance & pay rules (grace, late cuts, overtime, leave quotas...).
            { key: 'hr_policies', label: 'HR Policies', actions: ['view', 'create', 'edit', 'delete'] },
            // create = manual punch, edit = correct times / approve overtime.
            { key: 'attendance', label: 'Attendance', actions: ['view', 'create', 'edit', 'export'] },
            // Sign in the DOLLAR & Co Attendance desktop app (fingerprint clock-in on the counter PC).
            { key: 'attendance_kiosk', label: 'Attendance desktop app', actions: ['view', 'create'] },
            // Payroll, advances and deductions; edit = approve / pay.
            { key: 'payroll', label: 'Payroll & Advances', actions: ['view', 'create', 'edit', 'delete', 'export'] },
            // Which employees look after which product category (drives Category Performance).
            { key: 'category_assignments', label: 'Category Staff', actions: ['view', 'edit'] },
        ],
    },
    {
        key: 'system_settings',
        label: 'System Settings',
        iconKey: 'system',
        groups: [
            { key: 'roles', label: 'Roles & Permissions', actions: ['view', 'create', 'edit', 'delete'] },
            // Staff logins (/admin/staff, employee logins). Non-super-admin users with
            // this permission can't hand out roles that carry `staff`/`roles` or
            // anything they don't have themselves.
            { key: 'staff', label: 'Staff Users', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'activity_log', label: 'Activity Log', actions: ['view', 'export'] },
            { key: 'settings', label: 'Settings', actions: ['view', 'edit'] },
            { key: 'notifications', label: 'Notifications', actions: ['view', 'edit'] },
            // WhatsApp group receipt slips (provider, group id, test message, send log).
            { key: 'whatsapp', label: 'WhatsApp', actions: ['view', 'edit'] },
        ],
    },
    {
        key: 'website',
        label: 'Website',
        iconKey: 'website',
        groups: [
            // Public marketing website content (/admin/website). Owner only by default.
            { key: 'website', label: 'Website', actions: ['view', 'edit'] },
        ],
    },
];

/** Flat list of every permission group across every section. */
const PERMISSION_GROUPS = PERMISSION_SECTIONS.flatMap((s) => s.groups);

/** Build the full permission map (every action for every group). Used for the Admin role. */
function buildAllPermissions() {
    return PERMISSION_GROUPS.reduce((acc, g) => {
        acc[g.key] = [...g.actions];
        return acc;
    }, {});
}

/**
 * Sanitize an incoming permissions object:
 * - drops unknown group keys
 * - drops unknown/invalid actions
 * - drops actions that aren't allowed for that group
 */
function sanitizePermissions(input) {
    if (!input || typeof input !== 'object') return {};
    const result = {};
    for (const group of PERMISSION_GROUPS) {
        const raw = input[group.key];
        if (!Array.isArray(raw)) continue;
        const allowed = new Set(group.actions);
        const cleaned = [...new Set(raw.filter((a) => typeof a === 'string' && allowed.has(a)))];
        if (cleaned.length) result[group.key] = cleaned;
    }
    return result;
}

const ADMIN_ROLE_NAME = 'Admin';

// Ready-made roles for the shop (created by the dollar-store seeder and by
// "Add default roles" on the Roles page; existing roles are never touched).
// The shop can edit them or add more on the Roles page.
const V = ['view'];
const VC = ['view', 'create'];
const VCE = ['view', 'create', 'edit'];
const VE = ['view', 'edit'];
const VX = ['view', 'export'];
const DEFAULT_ROLES = [
    {
        name: 'Manager',
        description: 'Runs the shop: sales, cash verification, buying, stock, reports and staff.',
        permissions: {
            dashboard: VX, pos: ['view', 'create', 'edit', 'delete', 'export'], pos_orders: ['view', 'create', 'edit', 'delete', 'export'],
            pos_gifts: VC, till: VCE, till_verify: ['view', 'edit', 'export'], sale_counters: ['view', 'create', 'edit'],
            purchase_orders: ['view', 'create', 'edit', 'delete', 'export'], goods_receiving: VCE, vendors: ['view', 'create', 'edit', 'export'],
            vendor_payments: VC, consignment: ['view', 'create', 'edit', 'delete'], vendor_returns: ['view', 'create', 'edit', 'delete'],
            racks: ['view', 'create', 'edit'], stock_putaway: VC, stock_movements: VX, damages: ['view', 'create', 'edit', 'delete', 'export'],
            shop_use: ['view', 'create', 'delete'], stock_adjustments: VC,
            report_sales: VX, report_cost_analysis: VX, report_stock: VX, report_expenses: VX, report_receivables: VX, report_cash_in_hand: VX,
            report_demand: ['view', 'edit', 'export'], report_trends: VX, report_slow_moving: ['view', 'edit', 'export'],
            report_footfall: ['view', 'create', 'edit', 'export'], report_category_performance: VX, report_cash_closing: VX, report_stock_movement: VX,
            products: VCE, product_categories: VCE, product_attributes: VCE, product_stock: VCE, stock_receive: VC, discounts: ['view', 'create', 'edit', 'delete'],
            price_tiers: VCE, customers: VCE, banks: V, expenses: VCE, assets: VCE, employees: VCE, category_assignments: VE,
            staff: VCE, roles: V, activity_log: V, notifications: V,
            shifts: ['view', 'create', 'edit', 'delete'], hr_policies: V, attendance: ['view', 'create', 'edit', 'export'],
            attendance_kiosk: VC, payroll: ['view', 'create', 'export'],
        },
    },
    {
        name: 'Cashier',
        description: 'Sells at the counter and closes their own till (blind count). Cannot see sales totals.',
        permissions: { pos: VC, till: VCE, customers: VC },
    },
    {
        name: 'Warehouse Assistant',
        description: 'Receives goods, sends stock from the warehouse to the shop shelves, reports damage and counts stock.',
        permissions: {
            purchase_orders: V, goods_receiving: VCE, racks: V, stock_putaway: VC, stock_movements: V, damages: VC,
            shop_use: VC, stock_adjustments: VC, products: V, product_stock: V, stock_receive: VC,
        },
    },
    {
        name: 'Purchaser',
        description: 'Buys stock: purchase orders, vendors, vendor returns and consignment; sees demand and slow-moving lists.',
        permissions: {
            purchase_orders: ['view', 'create', 'edit', 'delete', 'export'], goods_receiving: V, vendors: VCE, vendor_payments: V,
            consignment: VCE, vendor_returns: VCE, products: VCE, product_categories: V, price_tiers: V,
            report_demand: VX, report_slow_moving: VX, report_trends: VX, stock_movements: V,
        },
    },
];

module.exports = {
    PERMISSION_ACTIONS,
    PERMISSION_SECTIONS,
    PERMISSION_GROUPS,
    buildAllPermissions,
    sanitizePermissions,
    ADMIN_ROLE_NAME,
    DEFAULT_ROLES,
};
