// routes/verificationRoutes.js
import express from "express";
import { protect, restrictTo } from "../middleware/authMiddleware.js";
import {
  scan,
  getSessionVerifications,
  getSessionAttempts,
} from "../controllers/verificationController.js";

const router = express.Router();

/*
  BASE URL: /api/verifications
*/

// ✅ Session-scoped scan. Invigilator identity comes from the JWT; the service
// checks that this invigilator is assigned to the submitted session.
router.post("/scan", protect, restrictTo("invigilator", "exam-controller"), scan);

// 📋 Admitted students + live roll-call for one session.
router.get(
  "/session/:id",
  protect,
  restrictTo("invigilator", "exam-controller"),
  getSessionVerifications
);

// 🧾 Full audit trail (every attempt, including refusals).
router.get(
  "/session/:id/attempts",
  protect,
  restrictTo("exam-controller"),
  getSessionAttempts
);

export default router;
