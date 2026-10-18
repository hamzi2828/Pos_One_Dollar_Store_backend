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
            { key: 'orders', label: 'Online Orders', actions: ['view', 'create', 'edit', 'delete', 'export'] },
            { key: 'pos_orders', label: 'POS Orders', actions: ['view', 'create', 'edit', 'delete', 'export'] },
            { key: 'preorders', label: 'Pre-Orders', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'returns', label: 'Returns', actions: ['view', 'create', 'edit', 'delete'] },
        ],
    },
    {
        key: 'reports',
        label: 'Reports',
        iconKey: 'reports',
        groups: [
            { key: 'report_sales', label: 'Sales Reports', actions: ['view', 'export'] },
            { key: 'report_purchases', label: 'Purchase Reports', actions: ['view', 'export'] },
            { key: 'report_cost_analysis', label: 'Cost Analysis', actions: ['view', 'export'] },
            { key: 'report_labour_revenue', label: 'Labour Revenue', actions: ['view', 'export'] },
            { key: 'report_stock', label: 'Stock', actions: ['view', 'export'] },
            { key: 'report_expenses', label: 'Expenses', actions: ['view', 'export'] },
            { key: 'report_vendor_payments', label: 'Vendor Payments', actions: ['view', 'export'] },
            { key: 'report_salary', label: 'Salary', actions: ['view', 'export'] },
            { key: 'report_receivables', label: 'Receivables', actions: ['view', 'export'] },
            { key: 'report_cash_in_hand', label: 'Cash in Hand', actions: ['view', 'export'] },
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
            // Receive stock into the user's branch (POST /products/:id/stock/receive).
            { key: 'stock_receive', label: 'Receive Stock', actions: ['view', 'create'] },
            // Move stock between branches (/admin/stock-transfers). Branch staff can
            // only send FROM their own branch; the super admin can move between any.
            { key: 'stock_transfers', label: 'Stock Transfers', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'reviews', label: 'Reviews', actions: ['view', 'edit', 'delete'] },
            { key: 'discounts', label: 'Discounts', actions: ['view', 'create', 'edit', 'delete'] },
        ],
    },
    {
        key: 'customer_management',
        label: 'Customer Management',
        iconKey: 'customers',
        groups: [
            { key: 'customers', label: 'Customers', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'subscribers', label: 'Subscribers', actions: ['view', 'edit', 'delete', 'export'] },
            { key: 'queries', label: 'Contact Queries', actions: ['view', 'edit', 'delete'] },
        ],
    },
    {
        key: 'content_management',
        label: 'Content Management',
        iconKey: 'content',
        groups: [
            { key: 'hero_slides', label: 'Hero Slides', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'blogs', label: 'All Blogs', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'blog_categories', label: 'Categories', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'blog_authors', label: 'Authors', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'blog_settings', label: 'Blog Settings', actions: ['view', 'edit'] },
        ],
    },
    {
        key: 'finance',
        label: 'Finance',
        iconKey: 'finance',
        groups: [
            { key: 'banks', label: 'Banks', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'expenses', label: 'Expenses', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'procurement', label: 'Procurement', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'assets', label: 'Assets', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'networks', label: 'Easyload Networks', actions: ['view', 'create', 'edit', 'delete'] },
        ],
    },
    {
        key: 'hr',
        label: 'HR & Payroll',
        iconKey: 'hr',
        groups: [
            { key: 'employees', label: 'Employees', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'attendance', label: 'Attendance', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'salary', label: 'Salary', actions: ['view', 'create', 'edit', 'delete', 'export'] },
        ],
    },
    {
        key: 'system_settings',
        label: 'System Settings',
        iconKey: 'system',
        groups: [
            { key: 'roles', label: 'Roles & Permissions', actions: ['view', 'create', 'edit', 'delete'] },
            // Staff logins (/admin/staff). Non-super-admin users with this permission
            // manage staff of THEIR OWN branch only and can't hand out roles that
            // carry `staff`/`branches`/`roles` or anything they don't have themselves.
            { key: 'staff', label: 'Staff Users', actions: ['view', 'create', 'edit', 'delete'] },
            // Branches: everyone sees their own branch; `view` here lets a non-super-admin
            // see ALL branches (e.g. to pick a transfer destination). Creating/editing
            // branches is always super admin only.
            { key: 'branches', label: 'Branches', actions: ['view'] },
            { key: 'activity_log', label: 'Activity Log', actions: ['view', 'export'] },
            { key: 'services', label: 'Services', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'shipping', label: 'Shipping', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'pages', label: 'Dynamic Pages', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'guidelines', label: 'Guidelines', actions: ['view', 'create', 'edit', 'delete'] },
            { key: 'settings', label: 'Settings', actions: ['view', 'edit'] },
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

module.exports = {
    PERMISSION_ACTIONS,
    PERMISSION_SECTIONS,
    PERMISSION_GROUPS,
    buildAllPermissions,
    sanitizePermissions,
    ADMIN_ROLE_NAME,
};
