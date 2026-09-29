import mongoose from "mongoose";

import ExamSession, { toExamDate } from "../models/ExamSession.js";
import ExamRegistration from "../models/ExamRegistration.js";
import Hall from "../models/Hall.js";
import User from "../models/user.js";
import { getSessionStats } from "../services/verificationService.js";

/**
 * =====================================================================
 * EXAM SESSION CONTROLLER  (BASE: /api/exam-sessions)
 * ---------------------------------------------------------------------
 * Sessions are the unit duplicate detection is scoped to, and the context
 * an invigilator selects ONCE before scanning — so nobody types a hall
 * name per scan.
 * =====================================================================
 */

const populateSession = (q) =>
  q
    .populate("hall", "name code location capacity")
    .populate("assignedInvigilators", "fullName userId")
    .populate("timetable", "title examSession");

/**
 * GET /api/exam-sessions/my-sessions   (invigilator / exam-controller)
 * Query: ?date=YYYY-MM-DD (defaults to today, server time)
 *
 * Powers the "Today's assigned sessions" list. An invigilator sees only
 * their own assignments; an exam-controller sees every session that day.
 */
export const getMySessions = async (req, res) => {
  try {
    const day = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(day.getTime())) {
      return res.status(400).json({ message: "Invalid date." });
    }

    const filter = { examDate: toExamDate(day) };
    if (req.userRole !== "exam-controller") {
      filter.assignedInvigilators = req.userId;
    }

    const sessions = await populateSession(
      ExamSession.find(filter).sort({ startsAt: 1 })
    );

    // Roll-call counts alongside each row so the list is useful at a glance.
    const withStats = await Promise.all(
      sessions.map(async (s) => ({
        ...s.toObject(),
        stats: await getSessionStats(s._id),
        acceptsVerification: s.acceptsVerification(new Date()).ok,
      }))
    );

    return res.json({
      success: true,
      date: toExamDate(day),
      count: withStats.length,
      sessions: withStats,
    });
  } catch (error) {
    console.error("getMySessions error:", error);
    return res.status(500).json({ message: "Failed to load your sessions." });
  }
};

/** GET /api/exam-sessions/:id — session detail + live counts. */
export const getSessionById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid exam session id." });
    }

    const session = await populateSession(ExamSession.findById(id));
    if (!session) return res.status(404).json({ message: "Exam session not found." });

    if (req.userRole !== "exam-controller" && !session.isInvigilator(req.userId)) {
      return res
        .status(403)
        .json({ message: "You are not assigned to this exam session." });
    }

    const openness = session.acceptsVerification(new Date());

    return res.json({
      success: true,
      session: {
        ...session.toObject(),
        acceptsVerification: openness.ok,
        notAcceptingReason: openness.ok ? null : openness.reason,
      },
      stats: await getSessionStats(session._id),
    });
  } catch (error) {
    console.error("getSessionById error:", error);
    return res.status(500).json({ message: "Failed to load the exam session." });
  }
};

/** GET /api/exam-sessions — every session (exam-controller). */
export const listSessions = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.date) {
      const d = new Date(req.query.date);
      if (!Number.isNaN(d.getTime())) filter.examDate = toExamDate(d);
    }

    const sessions = await populateSession(
      ExamSession.find(filter).sort({ startsAt: -1 }).limit(200)
    );

    return res.json({ success: true, count: sessions.length, sessions });
  } catch (error) {
    console.error("listSessions error:", error);
    return res.status(500).json({ message: "Failed to load exam sessions." });
  }
};

/** POST /api/exam-sessions — create a sitting (exam-controller). */
export const createSession = async (req, res) => {
  try {
    console.log("📝 createSession called with body:", JSON.stringify(req.body, null, 2));

    const {
      courseCode,
      courseTitle,
      examSession,
      timetable,
      startsAt,
      endsAt,
      hall,
      assignedInvigilators,
      entryOpensBeforeMinutes,
      requiresRegistration,
      status,
    } = req.body ?? {};

    console.log("🔍 Extracted values:", { courseCode, courseTitle, hall });

    if (!courseCode || !courseTitle) {
      return res
        .status(400)
        .json({ message: "Course code and course title are required." });
    }
    if (!startsAt || !endsAt) {
      return res.status(400).json({ message: "startsAt and endsAt are required." });
    }

    console.log("🏢 Hall value received:", hall, "Type:", typeof hall);

    if (!hall || !String(hall).trim()) {
      console.error("❌ Hall validation failed:", { hall, trimmed: String(hall).trim() });
      return res.status(400).json({ message: "Hall name or code is required." });
    }

    const hallInput = String(hall).trim();
    console.log("✏️ Hall input normalized:", hallInput);

    // Try to find hall by code or name, or create it if it doesn't exist
    let hallDoc = await Hall.findOne({
      $or: [
        { code: hallInput.toUpperCase() },
        { name: { $regex: `^${hallInput}$`, $options: "i" } },
      ],
    });

    // If hall doesn't exist, create it automatically
    if (!hallDoc) {
      console.log("🆕 Creating new hall:", hallInput);
      try {
        hallDoc = await Hall.create({
          name: hallInput,
          code: hallInput.toUpperCase(),
          capacity: 0,
        });
        console.log("✅ Hall created:", hallDoc._id);
      } catch (hallErr) {
        console.error("❌ Failed to create hall:", hallErr.message);
        return res.status(400).json({
          message: `Could not create or find hall "${hallInput}". ${hallErr.message}`,
        });
      }
    } else {
      console.log("✅ Hall found:", hallDoc.code);
    }

    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ message: "startsAt/endsAt must be valid dates." });
    }

    // Only real invigilators may be assigned.
    let invigilators = [];
    if (Array.isArray(assignedInvigilators) && assignedInvigilators.length) {
      const found = await User.find({
        _id: { $in: assignedInvigilators.filter((i) => mongoose.Types.ObjectId.isValid(i)) },
        role: { $in: ["invigilator", "exam-controller"] },
      }).select("_id");
      invigilators = found.map((u) => u._id);
    }

    let session;
    try {
      session = await ExamSession.create({
        courseCode,
        courseTitle,
        examSession: examSession ?? null,
        timetable:
          timetable && mongoose.Types.ObjectId.isValid(timetable) ? timetable : null,
        startsAt: start,
        endsAt: end,
        examDate: toExamDate(start),
        hall: hallDoc._id,
        assignedInvigilators: invigilators,
        ...(entryOpensBeforeMinutes !== undefined
          ? { entryOpensBeforeMinutes: Number(entryOpensBeforeMinutes) }
          : {}),
        ...(requiresRegistration !== undefined
          ? { requiresRegistration: !!requiresRegistration }
          : {}),
        ...(status ? { status: String(status).toUpperCase() } : {}),
        createdBy: req.userId,
      });
    } catch (dbErr) {
      console.error("ExamSession.create() error:", dbErr);
      throw dbErr;
    }

    const populatedSession = await populateSession(
      ExamSession.findById(session._id)
    );

    return res.status(201).json({
      success: true,
      message: "Exam session created.",
      session: populatedSession,
    });
  } catch (error) {
    console.error("createSession error:", error);
    return res
      .status(500)
      .json({ message: error.message || "Failed to create the exam session." });
  }
};

/** PATCH /api/exam-sessions/:id — edit / assign invigilators / set status. */
export const updateSession = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid exam session id." });
    }

    const session = await ExamSession.findById(id);
    if (!session) return res.status(404).json({ message: "Exam session not found." });

    const {
      courseCode,
      courseTitle,
      examSession,
      startsAt,
      endsAt,
      hall,
      assignedInvigilators,
      entryOpensBeforeMinutes,
      requiresRegistration,
      status,
    } = req.body ?? {};

    if (courseCode !== undefined) session.courseCode = courseCode;
    if (courseTitle !== undefined) session.courseTitle = courseTitle;
    if (examSession !== undefined) session.examSession = examSession || null;
    if (startsAt !== undefined) session.startsAt = new Date(startsAt);
    if (endsAt !== undefined) session.endsAt = new Date(endsAt);
    if (entryOpensBeforeMinutes !== undefined)
      session.entryOpensBeforeMinutes = Number(entryOpensBeforeMinutes);
    if (requiresRegistration !== undefined)
      session.requiresRegistration = !!requiresRegistration;
    if (status !== undefined) session.status = String(status).toUpperCase();

    if (hall !== undefined) {
      const hallInput = String(hall).trim();

      if (!hallInput) {
        return res.status(400).json({ message: "Hall name or code is required." });
      }

      // Try to find hall by code or name, or create it if it doesn't exist
      let hallDoc = await Hall.findOne({
        $or: [
          { code: hallInput.toUpperCase() },
          { name: { $regex: `^${hallInput}$`, $options: "i" } },
        ],
      });

      // If hall doesn't exist, create it automatically
      if (!hallDoc) {
        console.log("🆕 Creating new hall:", hallInput);
        try {
          hallDoc = await Hall.create({
            name: hallInput,
            code: hallInput.toUpperCase(),
            capacity: 0,
          });
          console.log("✅ Hall created:", hallDoc._id);
        } catch (hallErr) {
          console.error("❌ Failed to create hall:", hallErr.message);
          return res.status(400).json({
            message: `Could not create or find hall "${hallInput}". ${hallErr.message}`,
          });
        }
      }

      session.hall = hallDoc._id;
    }

    if (Array.isArray(assignedInvigilators)) {
      const found = await User.find({
        _id: { $in: assignedInvigilators.filter((i) => mongoose.Types.ObjectId.isValid(i)) },
        role: { $in: ["invigilator", "exam-controller"] },
      }).select("_id");
      session.assignedInvigilators = found.map((u) => u._id);
    }

    await session.save();

    return res.json({
      success: true,
      message: "Exam session updated.",
      session: await populateSession(ExamSession.findById(session._id)),
    });
  } catch (error) {
    console.error("updateSession error:", error);
    return res
      .status(400)
      .json({ message: error.message || "Failed to update the exam session." });
  }
};

/**
 * POST /api/exam-sessions/:id/registrations   (exam-controller)
 * Body: { studentUserIds: ["STU1001", ...] }
 * Idempotent — re-posting the same list changes nothing.
 */
export const registerStudents = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid exam session id." });
    }

    const session = await ExamSession.findById(id);
    if (!session) return res.status(404).json({ message: "Exam session not found." });

    const ids = Array.isArray(req.body?.studentUserIds) ? req.body.studentUserIds : [];
    if (!ids.length) {
      return res.status(400).json({ message: "studentUserIds must be a non-empty array." });
    }

    const students = await User.find({
      userId: { $in: ids.map((s) => String(s).trim().toUpperCase()) },
      role: "student",
    }).select("_id userId");

    const ops = students.map((s) => ({
      updateOne: {
        filter: { student: s._id, examSession: session._id },
        update: {
          $setOnInsert: {
            student: s._id,
            studentUserId: s.userId,
            examSession: session._id,
            registeredBy: req.userId,
          },
        },
        upsert: true,
      },
    }));

    const written = ops.length ? await ExamRegistration.bulkWrite(ops) : { upsertedCount: 0 };
    const foundIds = students.map((s) => s.userId);
    const notFound = ids
      .map((s) => String(s).trim().toUpperCase())
      .filter((s) => !foundIds.includes(s));

    return res.json({
      success: true,
      message: `${written.upsertedCount ?? 0} student(s) registered, ${
        students.length - (written.upsertedCount ?? 0)
      } already registered.`,
      registered: students.length,
      newlyRegistered: written.upsertedCount ?? 0,
      notFound,
    });
  } catch (error) {
    console.error("registerStudents error:", error);
    return res.status(500).json({ message: "Failed to register students." });
  }
};
