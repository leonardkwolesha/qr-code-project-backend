// routes/examSessionRoutes.js
import express from "express";
import { protect, restrictTo } from "../middleware/authMiddleware.js";
import {
  getMySessions,
  getSessionById,
  listSessions,
  createSession,
  updateSession,
  registerStudents,
} from "../controllers/examSessionController.js";

const router = express.Router();

/*
  BASE URL: /api/exam-sessions
*/

// 📆 Today's assigned sessions for the signed-in invigilator.
// Must stay ABOVE "/:id" so "my-sessions" is not read as an id.
router.get(
  "/my-sessions",
  protect,
  restrictTo("invigilator", "exam-controller"),
  getMySessions
);

// 📚 Every session (exam-controller).
router.get("/", protect, restrictTo("exam-controller"), listSessions);

// ➕ Create a sitting.
router.post("/", protect, restrictTo("exam-controller"), createSession);

// 🔍 One session (assigned invigilators + exam-controller).
router.get(
  "/:id",
  protect,
  restrictTo("invigilator", "exam-controller"),
  getSessionById
);

// ✏️ Edit / assign invigilators / set status.
router.patch("/:id", protect, restrictTo("exam-controller"), updateSession);

// 📝 Register students for a sitting.
router.post(
  "/:id/registrations",
  protect,
  restrictTo("exam-controller"),
  registerStudents
);

export default router;
