import mongoose from "mongoose";

/**
 * =====================================================================
 * ATTENDANCE (AUDIT LOG)
 * ---------------------------------------------------------------------
 * One record per QR scan — both successful verifications and rejections
 * are logged for an auditable trail. Duplicate-scan detection queries
 * this collection for an existing "verified" record within a time window.
 * =====================================================================
 */

const attendanceSchema = new mongoose.Schema(
  {
    // The student who was scanned
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Denormalised login ID (STU001) for quick display/reporting
    studentUserId: {
      type: String,
      required: true,
    },

    // The invigilator/exam-controller who performed the scan
    invigilator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    invigilatorUserId: {
      type: String,
      default: null,
    },

    verifiedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    status: {
      type: String,
      enum: ["verified", "rejected"],
      required: true,
    },

    // Populated for rejections (e.g. "Fees not cleared", "Invalid QR signature")
    reason: {
      type: String,
      default: null,
    },

    hall: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Fast lookups for the duplicate-scan window and audit reporting.
attendanceSchema.index({ student: 1, verifiedAt: -1 });

const Attendance =
  mongoose.models.Attendance || mongoose.model("Attendance", attendanceSchema);

export default Attendance;
