// routes/authRoutes.js
import express from "express";
import {
  loginController,
  forgotPassword,
  requestOTP,
  verifyOTP,
} from "../controllers/authController.js";

const router = express.Router();

// =============================
// AUTH ROUTES
// =============================

// Login
router.post("/login", loginController);

// Forgot Password (Token Link Version)
router.post("/forgot-password", forgotPassword);

// OTP Reset Flow
router.post("/request-otp", requestOTP);   // ✅ Fixed 404 issue
router.post("/verify-otp", verifyOTP);

export default router;