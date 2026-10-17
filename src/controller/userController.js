// src/controller/userController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/user');
const CarMake = require('../models/carMake');
const CarModel = require('../models/carModel');
const CarVariant = require('../models/carVariant');
const { getUserFromToken } = require('../helper/helper');
const { clearAccessCache } = require('../middleware/access');
// Lazy: keeps require order simple (staffController only needs models).
const staffHelpers = () => require('./staffController');

// ----- Login helpers (branches / staff access) --------------------------------

/** Staff = anyone who can open the admin panel or has a staff role. */
const isStaffAccount = (user) =>
    !!user && (user.role === 'admin' || user.role === 'moderator' || !!user.isSuperAdmin || !!user.staffRole);

/** JWT payload. `branch` / `isSuperAdmin` are informational: loadAccess re-reads the DB. */
const buildTokenPayload = (user) => ({
    id: user._id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    branch: user.branch ? String(user.branch._id || user.branch) : null,
    isSuperAdmin: staffHelpers().isEffectiveSuperAdmin(user),
});

/** access block for login responses: { isSuperAdmin, roleName, branch, permissions } */
const buildLoginAccess = async (user) => {
    if (!isStaffAccount(user)) {
        return { isSuperAdmin: false, roleName: null, branch: null, permissions: {} };
    }
    return staffHelpers().buildAccessSummary(user);
};

const DISABLED_MESSAGE = 'Your account is disabled. Please contact the administrator.';

// Fields a user may never change on their own profile (PUT /update/user).
const PROTECTED_PROFILE_FIELDS = [
    'password', 'role', 'isSuperAdmin', 'staffRole', 'branch', 'isActive',
    'provider', 'googleId', 'lastLogin', 'isDeleted', 'deletedAt', 'deletedBy',
    '_id', 'id', 'createdAt', 'updatedAt', '__v',
];

/**
 * Guard for the legacy admin user endpoints (/update/status/:id, /update/role/:id,
 * /delete/:id): staff accounts can only be changed by the super admin (normally
 * via /admin/staff), nobody disables/deletes themselves, and the last active
 * super admin can't be disabled/deleted/demoted.
 * Returns an error { status, message } or null.
 */
const guardStaffTarget = async (req, target, { disabling = false } = {}) => {
    if (!target || !isStaffAccount(target)) return null;
    if (!req.access?.isSuperAdmin) {
        return { status: 403, message: 'Staff accounts can only be changed by the super admin' };
    }
    const callerId = req.access?.userId || req.user?.id || req.user?._id;
    if (disabling && String(target._id) === String(callerId)) {
        return { status: 400, message: 'You cannot disable or delete your own account' };
    }
    if (disabling && staffHelpers().isEffectiveSuperAdmin(target) && target.isActive !== false) {
        const n = await staffHelpers().countActiveSuperAdmins();
        if (n <= 1) return { status: 400, message: 'This is the last active super admin' };
    }
    return null;
};

const userController = {


    // POST /user - Create a new user
    createUser: async (req, res) => {
        try {
            const { firstName, lastName, email, password, confirmPassword } = req.body;
            console.log("userData", req.body);

            // Basic validation
            if (!firstName || !lastName || !email || !password) {
                return res.status(400).json({ message: 'Missing required fields' });
            }

            // Optional: enforce password confirmation if provided
            if (typeof confirmPassword !== 'undefined' && password !== confirmPassword) {
                return res.status(400).json({ message: 'Passwords do not match' });
            }

            // Check if user already exists
            const existing = await User.findOne({ email: email.toLowerCase().trim() });
            if (existing) {
                return res.status(409).json({ message: 'Email already in use' });
            }

            // Hash password
            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(password, salt);

            // Create user
            const user = await User.create({
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: email.toLowerCase().trim(),
                password: hashed,
            });

            // Sanitize output
            const { password: _pw, ...safe } = user.toObject();
            return res.status(201).json({ message: 'User created successfully', data: safe });
        } catch (error) {
            // Handle duplicate key error from unique index
            if (error && error.code === 11000) {
                return res.status(409).json({ message: 'Email already in use' });
            }
            res.status(400).json({ message: 'Error creating user', error: error.message });
        }
    },

    // GET /auth/google - Start OAuth 2.0 Authorization Code flow (redirect)
    startGoogleOAuth: async (req, res) => {
        try {
            const clientId = process.env.GOOGLE_CLIENT_ID;
            const redirectUri = process.env.GOOGLE_REDIRECT_URI;
            if (!clientId || !redirectUri) {
                return res.status(500).send('Server misconfiguration: missing GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI');
            }

            const scope = encodeURIComponent('openid email profile');
            const returnUrl = req.query.returnUrl || '/';
            const platformType = req.query.platformType || '';
            const stateData = JSON.stringify({ returnUrl, platformType });
            const state = encodeURIComponent(stateData);
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&include_granted_scopes=true&prompt=consent&state=${state}`;

            return res.redirect(authUrl);
        } catch (error) {
            console.error('startGoogleOAuth error:', error);
            return res.status(400).send('Failed to start Google OAuth');
        }
    },

    // GET /auth/google/callback - Handle OAuth callback, exchange code, verify ID token, login
    googleOAuthCallback: async (req, res) => {
        try {
            const { code, state, error } = req.query;
            if (error) {
                return res.status(400).send(`Google OAuth error: ${error}`);
            }
            if (!code) {
                return res.status(400).send('Missing authorization code');
            }

            const clientId = process.env.GOOGLE_CLIENT_ID;
            const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
            const redirectUri = process.env.GOOGLE_REDIRECT_URI;
            if (!clientId || !clientSecret || !redirectUri) {
                return res.status(500).send('Server misconfiguration: missing Google OAuth envs');
            }

            // Parse state to get returnUrl and platformType
            let returnUrl = '/';
            try {
                const stateData = JSON.parse(decodeURIComponent(state || '{}'));
                returnUrl = stateData.returnUrl || '/';
            } catch (parseError) {
                // Fallback to treating state as just the returnUrl for backward compatibility
                returnUrl = decodeURIComponent(state || '/');
            }

            const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';

            const oauthClient = new OAuth2Client(clientId, clientSecret, redirectUri);
            const { tokens } = await oauthClient.getToken({ code, redirect_uri: redirectUri });
            const idToken = tokens.id_token;
            if (!idToken) {
                return res.status(401).send('No ID token returned by Google');
            }

            const ticket = await oauthClient.verifyIdToken({ idToken, audience: clientId });
            const payload = ticket.getPayload();
            if (!payload) {
                return res.status(401).send('Invalid Google ID token');
            }

            const {
                sub: googleId,
                email,
                given_name: givenName,
                family_name: familyName,
                picture,
                email_verified: emailVerified,
            } = payload;

            if (!email || !emailVerified) {
                return res.status(401).send('Unverified Google account');
            }

            const normalizedEmail = String(email).toLowerCase().trim();

            // Upsert user by email
            let user = await User.findOne({ email: normalizedEmail });
            if (!user) {
                user = await User.create({
                    firstName: givenName || 'Google',
                    lastName: familyName || 'User',
                    email: normalizedEmail,
                    password: null,
                    provider: 'google',
                    googleId: googleId || null,
                    avatarUrl: picture || null,
                });
            } else {
                const updates = {};
                if (!user.googleId && googleId) updates.googleId = googleId;
                if (user.provider !== 'google') updates.provider = 'google';
                if (picture && user.avatarUrl !== picture) updates.avatarUrl = picture;
                if (Object.keys(updates).length > 0) {
                    await User.updateOne({ _id: user._id }, { $set: updates });
                    user = await User.findById(user._id);
                }
            }

            if (user.isActive === false) {
                return res.status(403).send(DISABLED_MESSAGE);
            }

            const secret = process.env.JWT_SECRET;
            if (!secret) {
                return res.status(500).send('Server misconfiguration: missing JWT secret');
            }
            const token = jwt.sign(buildTokenPayload(user), secret, { expiresIn: '7d' });

            user.lastLogin = new Date();
            await user.save();

            const redirectTo = `${frontendOrigin}${returnUrl.startsWith('/') ? returnUrl : '/'}?token=${encodeURIComponent(token)}`;
            return res.redirect(redirectTo);
        } catch (error) {
            console.error('googleOAuthCallback error:', error);
            return res.status(400).send('Failed to complete Google OAuth');
        }
    },

    // POST /user/login - Authenticate user and return JWT
    loginUser: async (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                return res.status(400).json({ message: 'Email and password are required' });
            }

            const user = await User.findOne({ email: String(email).toLowerCase().trim() });
            if (!user) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }

            // Prevent password login for accounts created via Google
            if (!user.password) {
                return res.status(401).json({ message: 'This account uses Google login. Please sign in with Google.' });
            }

            const match = await bcrypt.compare(password, user.password);
            if (!match) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }

            // Disabled accounts (staff switched off by the super admin, or a
            // customer disabled from the users page) cannot log in.
            if (user.isActive === false) {
                return res.status(403).json({ message: DISABLED_MESSAGE });
            }

            const payload = buildTokenPayload(user);

            const secret = process.env.JWT_SECRET;
            if (!secret) {
                return res.status(500).json({ message: 'Server misconfiguration: missing JWT secret' });
            }

            const token = jwt.sign(payload, secret, { expiresIn: '7d' });

            // Update lastLogin timestamp
            user.lastLogin = new Date();
            await user.save();

            const access = await buildLoginAccess(user);
            const { password: _pw, ...safe } = user.toObject();
            return res.status(200).json({ message: 'Login successful', token, data: safe, access });
        } catch (error) {
            res.status(500).json({ message: 'Error during login', error: error.message });
        }
    },

    // POST /user/google-login - Verify Google ID token and login or create user
    googleLoginUser: async (req, res) => {
        try {
            const { idToken } = req.body || {};
            if (!idToken) {
                return res.status(400).json({ message: 'idToken is required' });
            }

            const clientId = process.env.GOOGLE_CLIENT_ID;
            if (!clientId) {
                return res.status(500).json({ message: 'Server misconfiguration: missing GOOGLE_CLIENT_ID' });
            }

            const client = new OAuth2Client(clientId);
            const ticket = await client.verifyIdToken({ idToken, audience: clientId });
            const payload = ticket.getPayload();
            if (!payload) {
                return res.status(401).json({ message: 'Invalid Google token' });
            }

            const {
                sub: googleId,
                email,
                given_name: givenName,
                family_name: familyName,
                picture,
                email_verified: emailVerified,
            } = payload;

            if (!email || !emailVerified) {
                return res.status(401).json({ message: 'Unverified Google account' });
            }

            const normalizedEmail = String(email).toLowerCase().trim();

            // Upsert user by email
            let user = await User.findOne({ email: normalizedEmail });
            if (!user) {
                user = await User.create({
                    firstName: givenName || 'Google',
                    lastName: familyName || 'User',
                    email: normalizedEmail,
                    password: null,
                    provider: 'google',
                    googleId: googleId || null,
                    avatarUrl: picture || null,
                });
            } else {
                // Update linkage if necessary
                const updates = {};
                if (!user.googleId && googleId) updates.googleId = googleId;
                if (user.provider !== 'google') updates.provider = 'google';
                if (picture && user.avatarUrl !== picture) updates.avatarUrl = picture;
                if (Object.keys(updates).length > 0) {
                    await User.updateOne({ _id: user._id }, { $set: updates });
                    user = await User.findById(user._id);
                }
            }

            if (user.isActive === false) {
                return res.status(403).json({ message: DISABLED_MESSAGE });
            }

            // Issue JWT
            const payloadJwt = buildTokenPayload(user);
            const secret = process.env.JWT_SECRET;
            if (!secret) {
                return res.status(500).json({ message: 'Server misconfiguration: missing JWT secret' });
            }
            const token = jwt.sign(payloadJwt, secret, { expiresIn: '7d' });

            user.lastLogin = new Date();
            await user.save();

            const access = await buildLoginAccess(user);
            const { password: _pw, ...safe } = user.toObject();
            return res.status(200).json({ message: 'Login successful', token, data: safe, access });
        } catch (error) {
            console.error('Google login error:', error);
            return res.status(400).json({ message: 'Error during Google login', error: error.message });
        }
    },

    // PUT /user - Update an existing user
    updateUser: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }
            
            const userData = req.body;
            
            // Prevent updating sensitive fields (password, role, staff access...)
            const safeUpdates = { ...(userData || {}) };
            for (const f of PROTECTED_PROFILE_FIELDS) delete safeUpdates[f];
            
            const updatedUser = await User.findByIdAndUpdate(
                currentUser.id,
                { $set: safeUpdates },
                { new: true, runValidators: true }
            );
            
            if (!updatedUser) {
                return res.status(404).json({ message: 'User not found' });
            }
            
            // Remove sensitive data from response
            const { password: _, ...userWithoutPassword } = updatedUser.toObject();
            
            res.status(200).json({ 
                message: 'User updated successfully', 
                data: userWithoutPassword 
            });
        } catch (error) {
            console.error('Update user error:', error);
            res.status(400).json({ 
                message: 'Error updating user', 
                error: error.message 
            });
        }
    },

    // DELETE /user - Delete a user
    deleteUser: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }
            
            await User.softDeleteById(currentUser.id, req.user?._id || null);
            res.status(200).json({ message: 'User deleted successfully', id: currentUser.id });
        } catch (error) {
            res.status(400).json({ message: 'Error deleting user', error: error.message });
        }
    },
    getUserDetailForProfile: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }
            
            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            
            // Remove sensitive data from response
            const { password: _, ...userWithoutPassword } = user.toObject();
            
            res.status(200).json({ 
                message: 'User details retrieved successfully', 
                data: userWithoutPassword 
            });
        } catch (error) {
            console.error('Get user details error:', error);
            res.status(400).json({ 
                message: 'Error getting user details', 
                error: error.message 
            });
        }
    },
    getAllUsers: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            // Opt-in server-side pagination: when any of page/limit/search/status/role/sortBy are present,
            // return a paginated response. Otherwise keep legacy all-at-once behavior (the current admin
            // users page paginates client-side).
            const paginated = ['page','limit','search','status','role','sortBy','sortOrder']
                .some((k) => Object.prototype.hasOwnProperty.call(req.query, k));

            const filter = {};
            if (req.query.status === 'active')   filter.isActive = true;
            if (req.query.status === 'inactive') filter.isActive = false;
            if (req.query.role && ['user','admin','moderator'].includes(req.query.role)) filter.role = req.query.role;

            if (req.query.search) {
                const s = String(req.query.search).trim();
                if (s.length >= 3) {
                    filter.$text = { $search: s };
                } else if (s) {
                    const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }];
                }
            }

            // Keep password excluded at the DB layer — no need to map/clone per row.
            const projection = { password: 0 };

            if (!paginated) {
                const users = await User.find(filter, projection).lean();
                return res.status(200).json({
                    message: 'Users details retrieved successfully',
                    data: users,
                });
            }

            const pageNum  = Math.max(1, parseInt(req.query.page) || 1);
            const limitNum = Math.min(200, Math.max(1, parseInt(req.query.limit) || 25));
            const skip     = (pageNum - 1) * limitNum;

            const validSortKeys = new Set(['createdAt','lastLogin','firstName','lastName','email','isActive']);
            const sortKey = validSortKeys.has(req.query.sortBy) ? req.query.sortBy : 'createdAt';
            const sortDir = req.query.sortOrder === 'asc' ? 1 : -1;

            const [users, total] = await Promise.all([
                User.find(filter, projection)
                    .sort({ [sortKey]: sortDir })
                    .skip(skip)
                    .limit(limitNum)
                    .lean(),
                User.countDocuments(filter),
            ]);

            return res.status(200).json({
                message: 'Users details retrieved successfully',
                data: users,
                pagination: {
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.max(1, Math.ceil(total / limitNum)),
                    hasNextPage: pageNum * limitNum < total,
                    hasPreviousPage: pageNum > 1,
                },
            });
        } catch (error) {
            console.error('Get user details error:', error);
            res.status(400).json({
                message: 'Error getting user details',
                error: error.message
            });
        }
    },

    // PUT /update/status/:id - Update a user's active status by ID
    updateUserStatusById: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { id } = req.params;
            const { isActive } = req.body;
            if (typeof isActive !== 'boolean') {
                return res.status(400).json({ message: 'isActive must be a boolean' });
            }

            const target = await User.findById(id).select('role isSuperAdmin staffRole branch isActive').lean();
            if (!target) {
                return res.status(404).json({ message: 'User not found' });
            }
            const blocked = await guardStaffTarget(req, target, { disabling: isActive === false });
            if (blocked) return res.status(blocked.status).json({ message: blocked.message });

            const updated = await User.findByIdAndUpdate(
                id,
                { $set: { isActive } },
                { new: true }
            );

            if (!updated) {
                return res.status(404).json({ message: 'User not found' });
            }

            clearAccessCache(id);
            const { password: _pw, ...safe } = updated.toObject();
            return res.status(200).json({ message: 'Status updated successfully', data: safe });
        } catch (error) {
            console.error('Update user status error:', error);
            return res.status(400).json({ message: 'Error updating user status', error: error.message });
        }
    },

    // PUT /update/role/:id - Update a user's role by ID
    updateUserRoleById: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { id } = req.params;
            const { role } = req.body;
            const allowed = ['user', 'admin', 'moderator'];
            if (!allowed.includes(role)) {
                return res.status(400).json({ message: `role must be one of: ${allowed.join(', ')}` });
            }

            // Taking 'admin' away from the last super admin would lock everyone out.
            const target = await User.findById(id).select('role isSuperAdmin staffRole branch isActive').lean();
            if (!target) {
                return res.status(404).json({ message: 'User not found' });
            }
            if (role !== 'admin' && target.role === 'admin') {
                const blocked = await guardStaffTarget(req, target, { disabling: true });
                if (blocked) return res.status(blocked.status).json({ message: blocked.message });
            }

            const updated = await User.findByIdAndUpdate(
                id,
                { $set: { role } },
                { new: true, runValidators: true }
            );

            if (!updated) {
                return res.status(404).json({ message: 'User not found' });
            }

            clearAccessCache(id);
            const { password: _pw, ...safe } = updated.toObject();
            return res.status(200).json({ message: 'Role updated successfully', data: safe });
        } catch (error) {
            console.error('Update user role error:', error);
            return res.status(400).json({ message: 'Error updating user role', error: error.message });
        }
    },

    // DELETE /delete/:id - Delete a user by ID
    deleteUserById: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { id } = req.params;
            const target = await User.findById(id).select('role isSuperAdmin staffRole branch isActive').lean();
            if (!target) {
                return res.status(404).json({ message: 'User not found' });
            }
            const blocked = await guardStaffTarget(req, target, { disabling: true });
            if (blocked) return res.status(blocked.status).json({ message: blocked.message });

            const deleted = await User.softDeleteById(id, req.user?._id || req.user?.id || null);
            clearAccessCache(id);
            if (!deleted) {
                return res.status(404).json({ message: 'User not found' });
            }

            return res.status(200).json({ message: 'User deleted successfully', id });
        } catch (error) {
            console.error('Delete user error:', error);
            return res.status(400).json({ message: 'Error deleting user', error: error.message });
        }
    },

    // GET /user/addresses - Get all user addresses
    getUserAddresses: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const user = await User.findById(currentUser.id).select('addresses');
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            return res.status(200).json({
                success: true,
                message: 'Addresses retrieved successfully',
                data: user.addresses || []
            });
        } catch (error) {
            console.error('Get addresses error:', error);
            return res.status(400).json({ message: 'Error getting addresses', error: error.message });
        }
    },

    // POST /user/addresses - Add a new address
    addUserAddress: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const addressData = req.body;
            const user = await User.findById(currentUser.id);

            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            // Check if we already have 2 addresses
            if (user.addresses && user.addresses.length >= 2) {
                return res.status(400).json({ message: 'Maximum 2 addresses allowed. Please update existing addresses.' });
            }

            // Set label based on existing addresses
            if (!user.addresses || user.addresses.length === 0) {
                addressData.label = 'primary';
                addressData.isDefault = true;
            } else {
                addressData.label = 'secondary';
                addressData.isDefault = false;
            }

            user.addresses.push(addressData);
            await user.save();

            return res.status(201).json({
                success: true,
                message: 'Address added successfully',
                data: user.addresses
            });
        } catch (error) {
            console.error('Add address error:', error);
            return res.status(400).json({ message: 'Error adding address', error: error.message });
        }
    },

    // PUT /user/addresses/:addressId - Update an address
    updateUserAddress: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { addressId } = req.params;
            const addressData = req.body;

            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);
            if (addressIndex === -1) {
                return res.status(404).json({ message: 'Address not found' });
            }

            // Preserve label and update other fields
            const currentLabel = user.addresses[addressIndex].label;
            user.addresses[addressIndex] = { ...user.addresses[addressIndex].toObject(), ...addressData, label: currentLabel };
            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Address updated successfully',
                data: user.addresses
            });
        } catch (error) {
            console.error('Update address error:', error);
            return res.status(400).json({ message: 'Error updating address', error: error.message });
        }
    },

    // DELETE /user/addresses/:addressId - Delete an address
    deleteUserAddress: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { addressId } = req.params;

            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);
            if (addressIndex === -1) {
                return res.status(404).json({ message: 'Address not found' });
            }

            user.addresses.splice(addressIndex, 1);

            // If we deleted primary and still have addresses, make the first one primary
            if (user.addresses.length > 0 && !user.addresses.some(a => a.label === 'primary')) {
                user.addresses[0].label = 'primary';
                user.addresses[0].isDefault = true;
            }

            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Address deleted successfully',
                data: user.addresses
            });
        } catch (error) {
            console.error('Delete address error:', error);
            return res.status(400).json({ message: 'Error deleting address', error: error.message });
        }
    },

    // PUT /user/addresses/:addressId/default - Set an address as default
    setDefaultAddress: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { addressId } = req.params;

            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);
            if (addressIndex === -1) {
                return res.status(404).json({ message: 'Address not found' });
            }

            // Reset all addresses to non-default and secondary
            user.addresses.forEach((addr, idx) => {
                addr.isDefault = idx === addressIndex;
                addr.label = idx === addressIndex ? 'primary' : 'secondary';
            });

            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Default address updated successfully',
                data: user.addresses
            });
        } catch (error) {
            console.error('Set default address error:', error);
            return res.status(400).json({ message: 'Error setting default address', error: error.message });
        }
    },

    // PUT /user/change-password - Change user password (user is already authenticated)
    changePassword: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { newPassword } = req.body;

            if (!newPassword) {
                return res.status(400).json({ message: 'New password is required' });
            }

            if (newPassword.length < 6) {
                return res.status(400).json({ message: 'New password must be at least 6 characters' });
            }

            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            // Google-only accounts have no password
            if (user.provider === 'google' && !user.password) {
                return res.status(400).json({ message: 'Cannot change password for Google sign-in accounts. Please use Google to log in.' });
            }

            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(newPassword, salt);
            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Password changed successfully'
            });
        } catch (error) {
            console.error('Change password error:', error);
            return res.status(400).json({ message: 'Error changing password', error: error.message });
        }
    },

    // Shared helper — resolves make/model/variant IDs against the catalog and
    // returns a snapshot object ready to push onto user.cars.
    _resolveCarSnapshot: async (body) => {
        const { makeId, modelId, variantId = null } = body || {};
        if (!makeId || !modelId) {
            const err = new Error('makeId and modelId are required');
            err.status = 400;
            throw err;
        }
        const [make, model, variant] = await Promise.all([
            CarMake.findById(makeId),
            CarModel.findById(modelId),
            variantId ? CarVariant.findById(variantId) : Promise.resolve(null)
        ]);
        if (!make) {
            const err = new Error('Invalid makeId');
            err.status = 400;
            throw err;
        }
        if (!model) {
            const err = new Error('Invalid modelId');
            err.status = 400;
            throw err;
        }
        if (String(model.makeId) !== String(makeId)) {
            const err = new Error('Model does not belong to the given make');
            err.status = 400;
            throw err;
        }
        if (variantId && !variant) {
            const err = new Error('Invalid variantId');
            err.status = 400;
            throw err;
        }
        if (variant && String(variant.modelId) !== String(modelId)) {
            const err = new Error('Variant does not belong to the given model');
            err.status = 400;
            throw err;
        }
        return {
            makeId: make._id,
            modelId: model._id,
            variantId: variant ? variant._id : null,
            makeName: make.name,
            makeLogoUrl: make.logoUrl || '',
            modelName: model.name,
            variantName: variant ? (variant.name || '') : ''
        };
    },

    // GET /user/cars - list all cars saved by the user
    listUserCars: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const user = await User.findById(currentUser.id).select('cars');
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            return res.status(200).json({
                success: true,
                message: 'Cars retrieved successfully',
                data: user.cars || []
            });
        } catch (error) {
            console.error('List user cars error:', error);
            return res.status(400).json({ message: 'Error getting cars', error: error.message });
        }
    },

    // POST /user/cars - add a new car to the user's garage
    addUserCar: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const snapshot = await userController._resolveCarSnapshot(req.body);

            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            user.cars.push(snapshot);
            await user.save();

            return res.status(201).json({
                success: true,
                message: 'Car added successfully',
                data: user.cars
            });
        } catch (error) {
            console.error('Add user car error:', error);
            const status = error.status || 400;
            return res.status(status).json({ message: error.message || 'Error adding car' });
        }
    },

    // PUT /user/cars/:carId - replace a specific car in the user's garage
    updateUserCar: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { carId } = req.params;
            const snapshot = await userController._resolveCarSnapshot(req.body);

            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            const carDoc = user.cars.id(carId);
            if (!carDoc) {
                return res.status(404).json({ message: 'Car not found' });
            }

            carDoc.set(snapshot);
            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Car updated successfully',
                data: user.cars
            });
        } catch (error) {
            console.error('Update user car error:', error);
            const status = error.status || 400;
            return res.status(status).json({ message: error.message || 'Error updating car' });
        }
    },

    // DELETE /user/cars/:carId - remove a specific car from the user's garage
    removeUserCar: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { carId } = req.params;
            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            const carDoc = user.cars.id(carId);
            if (!carDoc) {
                return res.status(404).json({ message: 'Car not found' });
            }

            carDoc.deleteOne();
            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Car removed successfully',
                data: user.cars
            });
        } catch (error) {
            console.error('Remove user car error:', error);
            return res.status(400).json({ message: 'Error removing car', error: error.message });
        }
    },

    // POST /user/stack-sync - Upsert user from Stack Auth and return JWT
    stackAuthSync: async (req, res) => {
        try {
            const { firstName, lastName, email, provider } = req.body;
            console.log('🔄 Stack Auth Sync:', { firstName, lastName, email, provider });

            if (!email) {
                return res.status(400).json({ message: 'Email is required' });
            }

            const normalizedEmail = String(email).toLowerCase().trim();

            // Find or create user
            let user = await User.findOne({ email: normalizedEmail });

            // This endpoint trusts the email it is given (no password / token
            // check), so it must never hand out a token for a staff account.
            if (user && isStaffAccount(user)) {
                return res.status(403).json({ message: 'Staff accounts must sign in with email and password' });
            }
            if (user && user.isActive === false) {
                return res.status(403).json({ message: DISABLED_MESSAGE });
            }

            if (!user) {
                user = await User.create({
                    firstName: (firstName || 'User').trim(),
                    lastName: (lastName || '').trim(),
                    email: normalizedEmail,
                    password: null,
                    provider: provider || 'local',
                });
            }

            // Update lastLogin
            user.lastLogin = new Date();
            await user.save();

            // Issue JWT
            const secret = process.env.JWT_SECRET;
            if (!secret) {
                return res.status(500).json({ message: 'Server misconfiguration: missing JWT secret' });
            }

            const payload = buildTokenPayload(user);

            const token = jwt.sign(payload, secret, { expiresIn: '7d' });

            const { password: _pw, ...safe } = user.toObject();
            return res.status(200).json({ message: 'Sync successful', token, data: safe, access: await buildLoginAccess(user) });
        } catch (error) {
            console.error('Stack auth sync error:', error);
            return res.status(400).json({ message: 'Error syncing user', error: error.message });
        }
    },
};

module.exports = userController;
