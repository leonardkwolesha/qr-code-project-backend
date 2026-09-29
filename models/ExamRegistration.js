import mongoose from "mongoose";

/**
 * =====================================================================
 * 📝 EXAM REGISTRATION — which students may sit which session
 * ---------------------------------------------------------------------
 * Answers the ELIGIBILITY question ("may this student sit this exam?"),
 * which is deliberately separate from the VERIFICATION question ("has
 * this student already entered?"). They produce different result codes.
 *
 * `blocked` lets the exam office bar an individual student from one
 * sitting (misconduct, deferral) without touching fees or the account.
 * =====================================================================
 */
const examRegistrationSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    studentUserId: { type: String, required: true },

    examSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExamSession",
      required: true,
      index: true,
    },

    blocked: { type: Boolean, default: false },
    blockedReason: { type: String, default: null },

    registeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// A student is registered for a session at most once.
examRegistrationSchema.index({ student: 1, examSession: 1 }, { unique: true });

const ExamRegistration =
  mongoose.models.ExamRegistration ||
  mongoose.model("ExamRegistration", examRegistrationSchema);
export default ExamRegistration;
