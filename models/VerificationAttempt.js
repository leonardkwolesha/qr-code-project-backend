import mongoose from "mongoose";

/**
 * =====================================================================
 * 🧾 VERIFICATION ATTEMPT — THE AUDIT TRAIL
 * ---------------------------------------------------------------------
 * EVERY scan lands here: successes, duplicates, ineligible students,
 * tampered QRs, unauthorised invigilators. Deliberately NOT unique — this
 * is the log, while Verification is the integrity boundary.
 *
 * Writing an attempt row must never fail the request. A logging problem
 * cannot be allowed to turn a successful admission into an error for the
 * invigilator standing at the door.
 * =====================================================================
 */
const verificationAttemptSchema = new mongoose.Schema(
  {
    // Null when the QR was unreadable or the student could not be resolved.
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    studentUserId: { type: String, default: null },
    studentName: { type: String, default: null },

    examSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExamSession",
      default: null,
      index: true,
    },

    invigilator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    invigilatorUserId: { type: String, default: null },

    hall: { type: mongoose.Schema.Types.ObjectId, ref: "Hall", default: null },

    // The machine-readable outcome returned to the client.
    code: {
      type: String,
      required: true,
      enum: [
        "VERIFIED",
        "ALREADY_VERIFIED",
        "NOT_ELIGIBLE",
        "NOT_REGISTERED",
        "INVALID_QR",
        "QR_REVOKED",
        "STUDENT_NOT_FOUND",
        "SESSION_NOT_ACTIVE",
        "UNAUTHORIZED_INVIGILATOR",
      ],
      index: true,
    },

    message: { type: String, default: null },
    success: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Audit queries are "everything for this session, newest first".
verificationAttemptSchema.index({ examSession: 1, createdAt: -1 });
verificationAttemptSchema.index({ createdAt: -1 });

const VerificationAttempt =
  mongoose.models.VerificationAttempt ||
  mongoose.model("VerificationAttempt", verificationAttemptSchema);
export default VerificationAttempt;
