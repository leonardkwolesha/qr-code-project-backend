import mongoose from "mongoose";

/**
 * =====================================================================
 * ✅ VERIFICATION — THE INTEGRITY BOUNDARY
 * ---------------------------------------------------------------------
 * One row = one student admitted to one exam session. SUCCESSFUL ENTRIES
 * ONLY. Every attempt (including failures and duplicates) is logged
 * separately in VerificationAttempt.
 *
 * These two must never be merged: the unique index below would reject the
 * second attempt's insert, so an audit row for a duplicate scan could not
 * physically live in this collection.
 *
 * The unique index is what actually makes concurrent scans safe — the
 * database enforces it, not application code. This deployment is a
 * STANDALONE mongod, so multi-document transactions are unavailable;
 * atomicity comes from a single-document upsert against this index.
 * =====================================================================
 */
const verificationSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Denormalised for reporting without a join.
    studentUserId: { type: String, required: true },
    studentName: { type: String, default: null },

    examSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExamSession",
      required: true,
      index: true,
    },

    hall: { type: mongoose.Schema.Types.ObjectId, ref: "Hall", default: null },
    hallName: { type: String, default: null },

    invigilator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    invigilatorUserId: { type: String, default: null },

    verifiedAt: { type: Date, default: Date.now, index: true },

    // Which QR generation admitted this student — useful when tracing a
    // revocation dispute after the fact.
    qrVersion: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// 🔒 THE core rule: one admission per student per session.
// Scoped to the SESSION, never to the date — a student sitting two exams on
// the same day must verify successfully for both.
verificationSchema.index({ student: 1, examSession: 1 }, { unique: true });

// Roll-call / reporting for one session.
verificationSchema.index({ examSession: 1, verifiedAt: -1 });

const Verification =
  mongoose.models.Verification ||
  mongoose.model("Verification", verificationSchema);
export default Verification;
