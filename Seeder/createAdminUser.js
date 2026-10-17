require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/user');

const MONGO_URI = process.env.MONGO_URI;

// Admin user data
const adminUser = {
    firstName: 'Hamza',
    lastName: 'Admin',
    email: 'admin@hamzamobile.com',
    password: 'Admin@123',
    role: 'admin',
    provider: 'local',
    isActive: true
};

async function createAdminUser() {
    try {
        if (!MONGO_URI) {
            throw new Error('MONGO_URI is not set. Check backend .env file.');
        }

        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        // Check if admin already exists
        const existingAdmin = await User.findOne({ email: adminUser.email });
        if (existingAdmin) {
            // Update password & ensure admin role
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(adminUser.password, salt);

            existingAdmin.password = hashedPassword;
            existingAdmin.role = 'admin';
            existingAdmin.isActive = true;
            existingAdmin.provider = 'local';
            await existingAdmin.save();

            console.log('Admin user already existed — password & role refreshed:');
            console.log('--------------------------------');
            console.log(`  Email:    ${existingAdmin.email}`);
            console.log(`  Password: ${adminUser.password}`);
            console.log(`  Role:     ${existingAdmin.role}`);
            console.log('--------------------------------');
            await mongoose.disconnect();
            return;
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(adminUser.password, salt);

        // Create admin user
        const newAdmin = await User.create({
            ...adminUser,
            password: hashedPassword
        });

        console.log('Admin user created successfully!');
        console.log('--------------------------------');
        console.log(`  Email:    ${newAdmin.email}`);
        console.log(`  Password: ${adminUser.password}`);
        console.log(`  Role:     ${newAdmin.role}`);
        console.log('--------------------------------');

        await mongoose.disconnect();
        console.log('Disconnected from MongoDB');
    } catch (error) {
        console.error('Error creating admin user:', error.message);
        try { await mongoose.disconnect(); } catch (_) {}
        process.exit(1);
    }
}

createAdminUser();
