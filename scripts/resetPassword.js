// scripts/resetPassword.js
import dotenv from "dotenv";
dotenv.config(); // load .env first

import mongoose from "mongoose";
import User from "../models/user.js"; // correct relative path and case

const resetPassword = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected successfully!");

    const user = await User.findOne({ userId: "EXC1001" });
    if (!user) {
      console.log("User not found");
      return;
    }

    user.password = "123456"; // plaintext, will be hashed by pre("save") hook
    await user.save();

    console.log("Password reset and hashed successfully!");
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
};

resetPassword();