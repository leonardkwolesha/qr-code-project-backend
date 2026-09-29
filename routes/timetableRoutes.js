// routes/timetableRoutes.js
import express from "express";
import { protect, restrictTo } from "../middleware/authMiddleware.js";
import { uploadDocument } from "../middleware/upload.js";
import {
  getCourseAudiences,
  uploadTimetable,
  getTimetables,
  getPublishedTimetables,
  getTimetableById,
  updateTimetable,
  deleteTimetable,
} from "../controllers/timetableController.js";

const router = express.Router();

/*
  BASE URL: /api/timetables
*/

// 🎓 Student (and anyone signed in) — published timetables for the caller.
// Must stay ABOVE "/:id" so "published" is not read as an id.
router.get("/published", protect, getPublishedTimetables);

// 👥 Exam-controller — distinct student courses for the audience picker.
// Above "/:id" for the same reason as "/published".
router.get("/courses", protect, restrictTo("exam-controller"), getCourseAudiences);

// 📚 Exam-controller — every timetable, drafts included.
router.get("/", protect, restrictTo("exam-controller"), getTimetables);

// 📤 Exam-controller — attach a new PDF timetable.
router.post(
  "/",
  protect,
  restrictTo("exam-controller"),
  uploadDocument("document"),
  uploadTimetable
);

// 🔍 Open one timetable (students are scoped to what is published to them).
router.get("/:id", protect, getTimetableById);

// ✏️ Exam-controller — rename / retarget / publish toggle.
router.patch("/:id", protect, restrictTo("exam-controller"), updateTimetable);

// 🗑️ Exam-controller — remove the timetable and its Cloudinary file.
router.delete("/:id", protect, restrictTo("exam-controller"), deleteTimetable);

export default router;
