import mongoose from "mongoose";

import User from "../models/user.js";
import ExamSession from "../models/ExamSession.js";
import ExamRegistration from "../models/ExamRegistration.js";
import Verification from "../models/Verification.js";
import VerificationAttempt from "../models/VerificationAttempt.js";
import { verifyPayload } from "../utils/qrSecurity.js";

/**
 * =====================================================================
 * SESSION-SCOPED VERIFICATION SERVICE
 * ---------------------------------------------------------------------
 * All business logic for admitting a student to one exam session lives
 * here. Routes stay thin; React components never decide anything.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * The legacy path (controllers/studentController.js -> verifyQR) scopes
 * duplicate detection to `student + startOfDay`. A student sitting two
 * exams on one day is wrongly told "already verified" for the second.
 * Here the key is `student + examSession`, so:
 *
 *   STU1001  08:00-11:00 Mathematics      Hall A -> VERIFIED
 *   STU1001  14:00-17:00 Database Systems Hall B -> VERIFIED
 *   STU1001  scanned twice in ONE session        -> ALREADY_VERIFIED
 *
 * CONCURRENCY
 * -----------
 * MONGODB_URI points at a STANDALONE mongod, so multi-document
 * transactions are unavailable (session.startTransaction() throws).
 * Atomicity comes from a single-document upsert against the unique index
 * on Verification(student, examSession), with a duplicate-key catch as a
 * second line of defence. No transaction is used anywhere.
 * =====================================================================
 */

export const CODES = {
  VERIFIED: "VERIFIED",
  ALREADY_VERIFIED: "ALREADY_VERIFIED",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  NOT_REGISTERED: "NOT_REGISTERED",
  INVALID_QR: "INVALID_QR",
  QR_REVOKED: "QR_REVOKED",
  STUDENT_NOT_FOUND: "STUDENT_NOT_FOUND",
  SESSION_NOT_ACTIVE: "SESSION_NOT_ACTIVE",
  UNAUTHORIZED_INVIGILATOR: "UNAUTHORIZED_INVIGILATOR",
};

// Mirrors the legacy verifyQR eligibility rule exactly — fees semantics and
// the "Paid"/"Partial" string values are frozen and must not be renormalised.
const ELIGIBLE_FEES = ["Paid", "Partial"];

/** Student fields safe to show the invigilator at the door. */
const publicStudent = (u) =>
  u
    ? {
        id: u._id,
        fullName: u.fullName,
        userId: u.userId,
        // The schema declares no regNumber; userId ("STU1001") IS the
        // registration number this system displays. Exposed under both names
        // so the client can render "reg number" without inventing data.
        regNumber: u.regNumber ?? u.userId ?? null,
        course: u.course ?? null,
        feesStatus: u.feesStatus ?? null,
        photo: u.photo ?? null,
      }
    : null;

/**
 * Append to the audit trail. NEVER throws: a logging failure must not turn a
 * successful admission into an error for the invigilator at the door.
 */
const logAttempt = async (fields) => {
  try {
    await VerificationAttempt.create(fields);
  } catch (err) {
    console.error("VerificationAttempt log failed:", err.message);
  }
};

const result = (code, message, data = {}, success = false) => ({
  success,
  code,
  message,
  data,
});

/**
 * Verify one scanned QR against one exam session.
 *
 * Trust model — every fact comes from a source the scanner cannot forge:
 *   student identity     <- the HMAC-verified QR payload (never the body)
 *   invigilator identity <- the authenticated JWT        (never the body)
 *   exam / hall context  <- looked up from examSessionId (never loose fields)
 *
 * @param {object}  args
 * @param {string}  args.qrPayload      signed QR string from the camera
 * @param {string}  args.examSessionId  session the invigilator is working
 * @param {object}  args.invigilator    req.user (authenticated)
 * @param {Date}    [args.now]          server time; injectable for tests
 */
export const verifyStudentForSession = async ({
  qrPayload,
  examSessionId,
  invigilator,
  now = new Date(),
}) => {
  const invigilatorId = invigilator?._id;
  const invigilatorUserId = invigilator?.userId ?? null;

  const baseAttempt = { invigilator: invigilatorId, invigilatorUserId };

  // ── 0. Shape checks (not business outcomes) ──────────────────────────
  if (!qrPayload || typeof qrPayload !== "string") {
    return result(CODES.INVALID_QR, "No QR code data was received.");
  }
  if (!mongoose.Types.ObjectId.isValid(String(examSessionId || ""))) {
    return result(
      CODES.SESSION_NOT_ACTIVE,
      "No valid exam session was selected for this scan."
    );
  }

  // Load context up front; the checks below still run in the documented order.
  const session = await ExamSession.findById(examSessionId).populate(
    "hall",
    "name code location capacity"
  );

  if (!session) {
    await logAttempt({
      ...baseAttempt,
      code: CODES.SESSION_NOT_ACTIVE,
      message: "Exam session not found.",
    });
    return result(CODES.SESSION_NOT_ACTIVE, "That exam session no longer exists.");
  }

  const sessionCtx = {
    examSessionId: String(session._id),
    courseCode: session.courseCode,
    courseTitle: session.courseTitle,
    hallName: session.hall?.name ?? null,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
  };
  const attemptCtx = {
    ...baseAttempt,
    examSession: session._id,
    hall: session.hall?._id ?? null,
  };

  // ── 1. QR signature (tamper detection, timing-safe inside verifyPayload) ──
  let payload;
  try {
    payload = verifyPayload(qrPayload.trim());
  } catch {
    await logAttempt({
      ...attemptCtx,
      code: CODES.INVALID_QR,
      message: "Invalid or tampered QR code.",
    });
    return result(
      CODES.INVALID_QR,
      "This QR code is invalid or has been tampered with.",
      sessionCtx
    );
  }

  // ── 2. Resolve the student from the SIGNED payload only ──────────────
  const student = await User.findOne({ userId: payload.userId });
  if (!student || student.role !== "student") {
    await logAttempt({
      ...attemptCtx,
      studentUserId: payload.userId ?? null,
      code: CODES.STUDENT_NOT_FOUND,
      message: "No student matches this QR code.",
    });
    return result(
      CODES.STUDENT_NOT_FOUND,
      "No student record matches this QR code.",
      sessionCtx
    );
  }

  const studentCtx = {
    ...sessionCtx,
    student: publicStudent(student),
    studentName: student.fullName,
    studentUserId: student.userId,
  };
  const withStudent = {
    ...attemptCtx,
    student: student._id,
    studentUserId: student.userId,
    studentName: student.fullName,
  };

  // ── 3. Revocation: opaque token match + QR generation ────────────────
  // A payload with NO qrVersion is version 1 — every ticket printed before
  // this field existed must keep working. Only a STALE version is rejected.
  const payloadVersion = Number(payload.qrVersion ?? 1);
  const currentVersion = Number(student.qrVersion ?? 1);

  if (!student.qrToken || student.qrToken !== payload.qrToken) {
    await logAttempt({
      ...withStudent,
      code: CODES.QR_REVOKED,
      message: "QR token no longer matches the student record.",
    });
    return result(
      CODES.QR_REVOKED,
      "This QR code has been revoked. Ask the student to regenerate it.",
      studentCtx
    );
  }

  if (payloadVersion < currentVersion) {
    await logAttempt({
      ...withStudent,
      code: CODES.QR_REVOKED,
      message: `Stale QR generation (payload v${payloadVersion} < current v${currentVersion}).`,
    });
    return result(
      CODES.QR_REVOKED,
      "This hall-ticket has been reissued. Ask the student for their current QR code.",
      studentCtx
    );
  }

  // ── 4. Is the session open? Server time and server status only ───────
  const openness = session.acceptsVerification(now);
  if (!openness.ok) {
    await logAttempt({
      ...withStudent,
      code: CODES.SESSION_NOT_ACTIVE,
      message: openness.reason,
    });
    return result(CODES.SESSION_NOT_ACTIVE, openness.reason, studentCtx);
  }

  // ── 5. Is THIS invigilator assigned to THIS session? ─────────────────
  // Identity comes from the JWT, so an invigilator cannot act as another one.
  const isExamController = invigilator?.role === "exam-controller";
  if (!isExamController && !session.isInvigilator(invigilatorId)) {
    await logAttempt({
      ...withStudent,
      code: CODES.UNAUTHORIZED_INVIGILATOR,
      message: "Invigilator is not assigned to this session.",
    });
    return result(
      CODES.UNAUTHORIZED_INVIGILATOR,
      "You are not assigned to this exam session.",
      studentCtx
    );
  }

  // ── 6. ELIGIBILITY — a different question from "already entered" ─────
  if (student.isActive === false) {
    await logAttempt({
      ...withStudent,
      code: CODES.NOT_ELIGIBLE,
      message: "Student account is deactivated.",
    });
    return result(
      CODES.NOT_ELIGIBLE,
      "This student's account is deactivated — entry denied.",
      studentCtx
    );
  }

  const registration = await ExamRegistration.findOne({
    student: student._id,
    examSession: session._id,
  });

  if (session.requiresRegistration && !registration) {
    await logAttempt({
      ...withStudent,
      code: CODES.NOT_REGISTERED,
      message: "No registration for this session.",
    });
    return result(
      CODES.NOT_REGISTERED,
      "This student is not registered for this exam.",
      studentCtx
    );
  }

  if (registration?.blocked) {
    await logAttempt({
      ...withStudent,
      code: CODES.NOT_ELIGIBLE,
      message: registration.blockedReason || "Blocked from this session.",
    });
    return result(
      CODES.NOT_ELIGIBLE,
      registration.blockedReason || "This student has been barred from this exam.",
      studentCtx
    );
  }

  if (!ELIGIBLE_FEES.includes(student.feesStatus)) {
    await logAttempt({
      ...withStudent,
      code: CODES.NOT_ELIGIBLE,
      message: `Fees not cleared (${student.feesStatus ?? "unknown"}).`,
    });
    return result(CODES.NOT_ELIGIBLE, "Fees not cleared — entry denied.", studentCtx);
  }

  // ── 7. ATOMIC ADMISSION ──────────────────────────────────────────────
  // One indivisible upsert keyed on (student, examSession). Two scanners
  // firing simultaneously cannot both insert: exactly one gets `upserted`,
  // the other reads back the row that already won.
  //
  // NOTE: `rawResult: true` is silently IGNORED by Mongoose 8 (it returns a
  // plain document with no lastErrorObject), which would make every first
  // scan look like a duplicate. `includeResultMetadata: true` is the option
  // that actually reports `upserted` on this version — verified against
  // mongoose 8.12 before this was written.
  const doc = {
    student: student._id,
    studentUserId: student.userId,
    studentName: student.fullName,
    examSession: session._id,
    hall: session.hall?._id ?? null,
    hallName: session.hall?.name ?? null,
    invigilator: invigilatorId,
    invigilatorUserId,
    verifiedAt: now,
    qrVersion: payloadVersion,
  };

  let raw;
  try {
    raw = await Verification.findOneAndUpdate(
      { student: student._id, examSession: session._id },
      { $setOnInsert: doc },
      { upsert: true, new: false, includeResultMetadata: true }
    );
  } catch (err) {
    // Belt and braces: a racing upsert can still surface E11000. That is a
    // duplicate, never a 500 — and the raw Mongo text never reaches the app.
    if (err?.code === 11000) {
      const existing = await Verification.findOne({
        student: student._id,
        examSession: session._id,
      });
      await logAttempt({
        ...withStudent,
        code: CODES.ALREADY_VERIFIED,
        message: "Duplicate scan (unique index).",
      });
      return result(
        CODES.ALREADY_VERIFIED,
        "This student has already been verified for this exam session.",
        { ...studentCtx, verifiedAt: existing?.verifiedAt ?? null }
      );
    }
    console.error("Verification upsert failed:", err.message);
    throw err;
  }

  const wasNewlyCreated = raw?.lastErrorObject?.upserted != null;

  if (!wasNewlyCreated) {
    const existing = raw?.value;
    await logAttempt({
      ...withStudent,
      code: CODES.ALREADY_VERIFIED,
      message: "Duplicate scan for this session.",
    });
    return result(
      CODES.ALREADY_VERIFIED,
      "This student has already been verified for this exam session.",
      {
        ...studentCtx,
        verifiedAt: existing?.verifiedAt ?? null,
        verifiedBy: existing?.invigilatorUserId ?? null,
      }
    );
  }

  await logAttempt({
    ...withStudent,
    code: CODES.VERIFIED,
    message: "Admitted.",
    success: true,
  });

  return result(
    CODES.VERIFIED,
    "Student verified — entry allowed.",
    { ...studentCtx, verifiedAt: doc.verifiedAt },
    true
  );
};

/** Live roll-call numbers for one session's detail screen. */
export const getSessionStats = async (examSessionId) => {
  const [verified, registered] = await Promise.all([
    Verification.countDocuments({ examSession: examSessionId }),
    ExamRegistration.countDocuments({ examSession: examSessionId }),
  ]);
  return {
    verified,
    registered,
    remaining: Math.max(registered - verified, 0),
  };
};
