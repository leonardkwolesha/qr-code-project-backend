import express from "express";
import upload from "../middleware/upload.js";
import { protect, restrictTo } from "../middleware/authMiddleware.js";

import {
  createUser,
  getStudents,
  getInvigilators,
  searchUsers,
  getUserById,
  updateUser,
  deleteUser,
  updateProfile,
} from "../controllers/userController.js";

const router = express.Router();

// ─── PROTECTED ROUTES ─────────────────────────────
// These are the exam-office administration endpoints. They were previously
// guarded by `protect` alone, which only proves *someone* is signed in — any
// student's own token was enough to call them. That let a student PUT their
// own record and set feesStatus to "Paid", which is exactly the check
// /students/verify relies on to deny entry. `restrictTo("exam-controller")`
// closes that hole; every screen that calls these routes already lives under
// app/(exam-controller), so no existing flow changes.

// Create user (admin only)
router.post("/", protect, restrictTo("exam-controller"), createUser);

// Get students
router.get("/students", protect, restrictTo("exam-controller"), getStudents);

// Get invigilators
router.get("/invigilators", protect, restrictTo("exam-controller"), getInvigilators);

// Search users
router.get("/search", protect, restrictTo("exam-controller"), searchUsers);

// Get single user by id (must stay AFTER the literal GET routes above)
router.get("/:id", protect, restrictTo("exam-controller"), getUserById);

// Update user (admin)
router.put("/:id", protect, restrictTo("exam-controller"), updateUser);

// Delete user (admin)
router.delete("/:id", protect, restrictTo("exam-controller"), deleteUser);

// 🔐 UPDATE PROFILE (photo + password)
router.patch("/update-profile", protect, upload.single("photo"), updateProfile);

export default router;