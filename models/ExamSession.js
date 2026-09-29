import mongoose from "mongoose";

/**
 * =====================================================================
 * 📆 EXAM SESSION — a single sitting of one exam, in one hall, at one time
 * ---------------------------------------------------------------------
 * This is the key duplicate detection is scoped to. Two sittings on the
 * same calendar day are two different sessions, so a student legitimately
 * verifies twice that day — which is exactly what date-scoped detection
 * got wrong.
 *
 * WHY THIS IS NOT BUILT ON THE Timetable MODEL
 * --------------------------------------------
 * `models/Timetable.js` is a *document*, not a schedule: it stores an
 * uploaded PDF (fileUrl, filePublicId, pages, isPublished) plus a free-text
 * `examSession` label such as "Semester 1 · 2025/2026". It carries no exam
 * date, no start/end time, no course code and no hall — none of the fields
 * a sitting needs. It could not be referenced as a session without adding
 * every one of those fields to it, which would change an existing model's
 * meaning. So ExamSession is new, and links to a Timetable only as optional
 * provenance ("this sitting came from that published PDF").
 * =====================================================================
 */
const examSessionSchema = new mongoose.Schema(
  {
    // ── WHAT EXAM ──
    courseCode: { type: String, required: true, trim: true, uppercase: true },
    courseTitle: { type: String, required: true, trim: true },

    // Free-text label mirroring Timetable.examSession, e.g. "Semester 1 · 2025/2026".
    examSession: { type: String, default: null, trim: true },

    // Optional provenance — the published PDF this sitting was taken from.
    timetable: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Timetable",
      default: null,
    },

    // ── WHEN (always stored UTC; never trust the device clock) ──
    // Midnight UTC of the exam day — derived, used for "today's sessions".
    examDate: { type: Date, required: true, index: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },

    // How long before startsAt the doors open for verification.
    entryOpensBeforeMinutes: { type: Number, default: 60, min: 0 },

    // ── WHERE ──
    hall: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hall",
      required: true,
      index: true,
    },

    // ── WHO MAY SCAN ──
    assignedInvigilators: [
      { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    ],

    status: {
      type: String,
      enum: ["SCHEDULED", "ACTIVE", "COMPLETED", "CANCELLED"],
      default: "SCHEDULED",
      index: true,
    },

    // When true, a student with no ExamRegistration row for this session is
    // turned away with NOT_REGISTERED.
    //
    // Defaults to FALSE on purpose: no registrations exist yet anywhere in
    // this system, so defaulting to true would make every single scan fail
    // the moment this ships. The exam office opts in per session once it has
    // actually loaded a register.
    requiresRegistration: { type: Boolean, default: false },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// "Today's sessions for this invigilator" is the single hottest query.
examSessionSchema.index({ assignedInvigilators: 1, examDate: 1 });
examSessionSchema.index({ examDate: 1, status: 1 });

/** Midnight-UTC of a given instant — the canonical examDate value. */
export const toExamDate = (instant) => {
  const d = new Date(instant);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

// examDate is always derived from startsAt so the two can never disagree.
examSessionSchema.pre("validate", function (next) {
  if (this.startsAt) this.examDate = toExamDate(this.startsAt);
  if (this.startsAt && this.endsAt && this.endsAt <= this.startsAt) {
    return next(new Error("endsAt must be after startsAt"));
  }
  next();
});

/**
 * SERVER-SIDE authority on whether this session accepts verification.
 * The client never gets a vote, and `now` is always server time.
 *
 * Both SCHEDULED and ACTIVE admit students, provided the clock is inside
 * [startsAt - entryOpensBeforeMinutes, endsAt]. Requiring a manual flip to
 * ACTIVE would leave invigilators unable to admit anyone if nobody
 * remembered to press a button.
 */
examSessionSchema.methods.acceptsVerification = function (now = new Date()) {
  if (this.status === "CANCELLED")
    return { ok: false, reason: "This exam session has been cancelled." };
  if (this.status === "COMPLETED")
    return { ok: false, reason: "This exam session is already closed." };

  const opensAt = new Date(
    this.startsAt.getTime() - (this.entryOpensBeforeMinutes ?? 60) * 60000
  );
  if (now < opensAt)
    return {
      ok: false,
      reason: `Entry opens at ${opensAt.toISOString()} for this session.`,
    };
  if (now > this.endsAt)
    return { ok: false, reason: "This exam session has already ended." };

  return { ok: true };
};

/** Is this user one of the assigned invigilators? */
examSessionSchema.methods.isInvigilator = function (userId) {
  return (this.assignedInvigilators || []).some(
    (id) => String(id?._id ?? id) === String(userId)
  );
};

const ExamSession =
  mongoose.models.ExamSession || mongoose.model("ExamSession", examSessionSchema);
export default ExamSession;
