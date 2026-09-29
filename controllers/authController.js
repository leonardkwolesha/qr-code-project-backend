import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import User from "../models/user.js";

// ==========================
// GENERATE JWT TOKEN
// ==========================
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      userId: user.userId,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

// ==========================
// SEND OTP VIA EMAIL (Gmail example)
// ==========================
const sendOTPEmail = async (email, otp) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });

  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: email,
    subject: "Your Password Reset OTP",
    text: `Your OTP code is: ${otp}. It expires in 15 minutes.`,
  };

  await transporter.sendMail(mailOptions);
};

// ==========================
// LOGIN CONTROLLER
// ==========================
export const loginController = async (req, res) => {
  try {
    const { userId, password } = req.body;

    console.log("🔐 Login attempt for user:", userId);

    if (!userId || !password) {
      console.warn("⚠️ Missing credentials");
      return res.status(400).json({
        message: "User ID and password are required",
        code: "MISSING_CREDENTIALS"
      });
    }

    const formattedUserId = userId.trim().toUpperCase();
    console.log("🔍 Searching for user:", formattedUserId);

    const user = await User.findOne({ userId: formattedUserId }).select("+password");

    // Not-found is reported explicitly (and echoed back with the ID the user
    // typed) so the client can tell "no such account" apart from "wrong
    // password" and from "the server was never reached".
    if (!user) {
      console.warn("❌ User not found:", formattedUserId);
      return res.status(401).json({
        code: "USER_NOT_FOUND",
        message: `No account found for ID "${formattedUserId}". Check the ID and try again.`,
      });
    }

    console.log("✅ User found:", formattedUserId, "- Verifying password");

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      console.warn("❌ Wrong password for user:", formattedUserId);
      return res.status(401).json({
        code: "INVALID_PASSWORD",
        message: "Incorrect password. Please try again.",
      });
    }

    console.log("✅ Password verified for user:", formattedUserId);

    // A deactivated account must not be able to sign in — the schema already
    // carries isActive, but nothing was enforcing it at the login gate.
    if (user.isActive === false) {
      console.warn("⚠️ Account disabled for user:", formattedUserId);
      return res.status(403).json({
        code: "ACCOUNT_DISABLED",
        message: "This account has been deactivated. Contact the exam office.",
      });
    }

    const token = generateToken(user);

    console.log("🎉 Login successful for user:", formattedUserId);

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        fullName: user.fullName,
        userId: user.userId,
        role: user.role,
        regNumber: user.regNumber ?? null,
        course: user.course ?? null,
        feesStatus: user.feesStatus ?? null,
        mustChangePassword: user.mustChangePassword ?? false,
        photo: user.photo ?? null,
      },
    });
  } catch (error) {
    console.error("🔥 Login error:", error.message);
    console.error("Stack:", error.stack);
    res.status(500).json({
      message: "An error occurred during login. Please try again.",
      code: "SERVER_ERROR"
    });
  }
};

// ==========================
// FORGOT PASSWORD (token link version)
// ==========================
export const forgotPassword = async (req, res) => {
  try {
    const { id } = req.body;

    console.log("🔄 Forgot password request for:", id);

    if (!id) {
      console.warn("⚠️ Missing user ID");
      return res.status(400).json({
        message: "User ID is required",
        code: "MISSING_ID"
      });
    }

    const formattedId = String(id).trim().toUpperCase();
    console.log("🔍 Looking up user:", formattedId);

    const user = await User.findOne({ userId: formattedId });
    if (!user) {
      console.warn("❌ User not found for password reset:", formattedId);
      return res.status(404).json({
        message: `No account found for ID "${formattedId}".`,
        code: "USER_NOT_FOUND"
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 15 * 60 * 1000; // 15 mins
    await user.save();

    console.log("✅ Password reset token generated for:", formattedId);

    // In production, send email link instead:
    // const resetLink = `https://yourdomain.com/reset-password/${resetToken}`;

    res.status(200).json({
      success: true,
      message: "Password reset instructions sent. Check your email."
    });
  } catch (error) {
    console.error("🔥 Forgot password error:", error.message);
    res.status(500).json({
      message: "An error occurred. Please try again.",
      code: "SERVER_ERROR"
    });
  }
};

// ==========================
// REQUEST OTP FOR PASSWORD RESET
// ==========================
export const requestOTP = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ message: "User ID is required" });

    const user = await User.findOne({ userId: id });
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.email) return res.status(400).json({ message: "No email found for user" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetOTP = otp;
    user.resetOTPExpires = Date.now() + 15 * 60 * 1000; // 15 mins
    await user.save();

    await sendOTPEmail(user.email, otp);

    res.status(200).json({ message: "OTP sent to your email" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// ==========================
// VERIFY OTP AND RESET PASSWORD
// ==========================
export const verifyOTP = async (req, res) => {
  try {
    const { id, otp, newPassword } = req.body;
    if (!id || !otp || !newPassword)
      return res.status(400).json({ message: "ID, OTP, and new password are required" });

    const user = await User.findOne({ userId: id }).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.resetOTP || user.resetOTPExpires < Date.now())
      return res.status(400).json({ message: "OTP expired or invalid" });

    if (user.resetOTP !== otp)
      return res.status(400).json({ message: "Incorrect OTP" });

    user.password = newPassword; // pre-save hook in User model will hash it
    user.resetOTP = null;
    user.resetOTPExpires = null;
    user.mustChangePassword = false;

    await user.save();

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};