// routes/studentRoutes.js
import express from "express";
import { protect, restrictTo } from "../middleware/authMiddleware.js";
import {
  getMyQR,
  verifyQR,
  getAttendance,
  revokeStudentQR,
} from "../controllers/studentController.js";

const router = express.Router();

/*
  BASE URL: /api/students
*/

// 🎫 Student fetches their own signed QR hall-ticket
router.get("/my-qr", protect, getMyQR);

// ✅ Invigilator / Exam-controller verifies a scanned QR
router.post(
  "/verify",
  protect,
  restrictTo("invigilator", "exam-controller"),
  verifyQR
);

// 📋 Attendance log + dashboard stats
router.get(
  "/attendance",
  protect,
  restrictTo("invigilator", "exam-controller"),
  getAttendance
);

// ♻️ Exam-controller revokes + reissues a student's QR (invalidates any
// printed/screenshotted copy of the old one).
router.post(
  "/:id/revoke-qr",
  protect,
  restrictTo("exam-controller"),
  revokeStudentQR
);

export default router;
