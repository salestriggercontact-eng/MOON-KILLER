// Run with: node seed.js <username> <password>
require("dotenv").config();
const bcrypt = require("bcryptjs");
const connectDB = require("./config/db");
const Admin = require("./models/Admin");

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error("Usage: node seed.js <username> <password>");
    process.exit(1);
  }

  await connectDB();

  const hash = await bcrypt.hash(password, 10);
  await Admin.findOneAndUpdate(
    { username },
    { username, password: hash },
    { upsert: true }
  );

  console.log(`Admin "${username}" created/updated.`);
  process.exit(0);
}

main();
