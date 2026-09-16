require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/Admin");

async function run() {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const name = process.env.ADMIN_BOOTSTRAP_NAME || "Super Admin";

  if (!email || !password) {
    console.error("Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD in .env before running this script.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const existing = await Admin.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    console.log(`Admin with email ${email} already exists. Skipping.`);
    process.exit(0);
  }

  const passwordHash = await Admin.hashPassword(password);
  await Admin.create({ name, email: email.toLowerCase().trim(), passwordHash, role: "superadmin" });

  console.log(`Superadmin created: ${email}`);
  console.log("IMPORTANT: log in and change this password from Admin Web immediately.");
  process.exit(0);
}

run().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
