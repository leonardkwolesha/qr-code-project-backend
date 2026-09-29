import mongoose from "mongoose";
import User from "../models/user.js";
import dotenv from "dotenv";
dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);

const users = await User.find({}).select("+password");

for (const user of users) {
  user.password = "welcome123"; // plain — pre-save hook hashes it correctly
  user.mustChangePassword = true;
  await user.save();
  console.log(`✅ Reset: ${user.userId}`);
}

console.log("✅ All done. All users reset to password: welcome123");
await mongoose.disconnect();