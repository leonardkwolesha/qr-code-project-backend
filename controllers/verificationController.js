import mongoose from "mongoose";

import Verification from "../models/Verification.js";
import VerificationAttempt from "../models/VerificationAttempt.js";
import ExamSession from "../models/ExamSession.js";
import {
  verifyStudentForSession,
  getSessionStats,
  CODES,
} from "../services/verificationService.js";

/**
 * =====================================================================
 * VERIFICATION CONTROLLER  (BASE: /api/verifications)
 * ---------------------------------------------------------------------
 * Thin: shape the request, delegate to the service, shape the response.
 *
 * HTTP STATUS POLICY
 * ------------------
 * Every *decided* outcome returns 200 with a machine-readable `code`, even
 * the refusals. The scan was processed and produced a verdict; that is not
 * an HTTP error. This matches the existing /api/students/verify, which also
 * returns 200 for rejections, and keeps the scanner's axios path simple —
 * the client switches on `code`, never on prose or status.
 *
 * 4xx is reserved for malformed requests and auth failures from middleware.
 * A raw Mongo error is never returned; it is logged and mapped.
 * =====================================================================
 */

/**
 * POST /api/verifications/scan   (invigilator / exam-controller)
 * Body: { examSessionId, qrPayload }
 *
 * Student identity comes from the signed QR, invigilator identity from the
 * JWT, and exam/hall context from examSessionId. Nothing identifying is
 * taken from the request body.
 */
export const scan = async (req, res) => {
  try {
    const { examSessionId, qrPayload } = req.body ?? {};

    if (!examSessionId) {
      return res.status(400).json({
        success: false,
        code: CODES.SESSION_NOT_ACTIVE,
        message: "No exam session was selected. Pick a session before scanning.",
        data: {},
      });
    }

    const outcome = await verifyStudentForSession({
      qrPayload,
      examSessionId,
      invigilator: req.user,
      now: new Date(), // server time only — never the device clock
    });

    return res.status(200).json(outcome);
  } catch (error) {
    console.error("verification scan error:", error);
    return res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "The verification server hit an error. Try the scan again.",
      data: {},
    });
  }
};

/**
 * GET /api/verifications/session/:id   (invigilator / exam-controller)
 * Admitted students for one session + live roll-call counts.
 */
export const getSessionVerifications = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid exam session id." });
    }

    const session = await ExamSession.findById(id).populate("hall", "name code");
    if (!session) {
      return res.status(404).json({ message: "Exam session not found." });
    }

    // An invigilator only sees sessions they actually work.
    if (
      req.userRole !== "exam-controller" &&
      !session.isInvigilator(req.userId)
    ) {
      return res
        .status(403)
        .json({ message: "You are not assigned to this exam session." });
    }

    const [records, stats] = await Promise.all([
      Verification.find({ examSession: id })
        .sort({ verifiedAt: -1 })
        .populate("student", "fullName userId course photo")
        .lean(),
      getSessionStats(id),
    ]);

    return res.json({ success: true, session, stats, records });
  } catch (error) {
    console.error("getSessionVerifications error:", error);
    return res.status(500).json({ message: "Failed to load verifications." });
  }
};

/**
 * GET /api/verifications/session/:id/attempts   (exam-controller)
 * The full audit trail for a session — successes AND every refusal.
 */
export const getSessionAttempts = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid exam session id." });
    }

    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const attempts = await VerificationAttempt.find({ examSession: id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("student", "fullName userId")
      .lean();

    return res.json({ success: true, count: attempts.length, attempts });
  } catch (error) {
    console.error("getSessionAttempts error:", error);
    return res.status(500).json({ message: "Failed to load the audit trail." });
  }
};
