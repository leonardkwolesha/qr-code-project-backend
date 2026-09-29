import dotenv from "dotenv";
import mongoose from "mongoose";

import connectDB from "../config/db.js";
import Attendance from "../models/Attendance.js";
import Verification from "../models/Verification.js";
import VerificationAttempt from "../models/VerificationAttempt.js";
import ExamSession from "../models/ExamSession.js";
import ExamRegistration from "../models/ExamRegistration.js";
import Hall from "../models/Hall.js";
import User from "../models/user.js";

dotenv.config();

/**
 * =====================================================================
 * MIGRATION — session-scoped verification
 * ---------------------------------------------------------------------
 * Run:  npm run migrate:verification
 *
 * IDEMPOTENT and SAFE TO RE-RUN. It never deletes anything.
 *
 * What it does:
 *   1. Reports the legacy Attendance collection (left untouched).
 *   2. Refuses to build the unique index if duplicates already exist,
 *      reporting them instead of deleting rows to force it through.
 *   3. Builds indexes for the new collections.
 *   4. Reports how many users still lack an explicit qrVersion.
 *
 * WHY LEGACY ATTENDANCE ROWS ARE NOT CONVERTED
 * --------------------------------------------
 * Attendance rows predate exam sessions, so they carry no examSessionId
 * and none can be inferred — the information does not exist. Inventing a
 * session for them would fabricate audit data. They are preserved exactly
 * as they are, and remain readable through the existing
 * GET /api/students/attendance endpoint.
 * =====================================================================
 */

const line = (s = "") => console.log(s);

const run = async () => {
  await connectDB();
  line("");
  line("═══ SESSION-SCOPED VERIFICATION MIGRATION ═══");
  line("");

  // ── 1. Legacy attendance (read-only report) ──────────────────────────
  const attendanceTotal = await Attendance.countDocuments();
  const attendanceVerified = await Attendance.countDocuments({ status: "verified" });
  line("1. LEGACY ATTENDANCE (preserved, not modified)");
  line(`   rows: ${attendanceTotal}  (verified: ${attendanceVerified})`);
  line("   These have no examSessionId and cannot be back-filled — the");
  line("   information does not exist. Left exactly as they are.");
  line("");

  // ── 2. Duplicate check BEFORE building the unique index ──────────────
  line("2. UNIQUE INDEX PRE-FLIGHT  Verification(student, examSession)");
  const dupes = await Verification.aggregate([
    {
      $group: {
        _id: { student: "$student", examSession: "$examSession" },
        count: { $sum: 1 },
        ids: { $push: "$_id" },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (dupes.length) {
    line(`   ✖ ABORTED — ${dupes.length} duplicate (student, examSession) pair(s) exist.`);
    line("   The unique index cannot be created while these are present.");
    line("   Nothing has been deleted. Review and resolve them manually:");
    for (const d of dupes.slice(0, 20)) {
      line(
        `     student=${d._id.student} session=${d._id.examSession} ` +
          `count=${d.count} ids=[${d.ids.join(", ")}]`
      );
    }
    if (dupes.length > 20) line(`     ... and ${dupes.length - 20} more`);
    line("");
    await mongoose.connection.close();
    process.exit(1);
  }
  line("   ✓ no duplicates — safe to build the unique index");
  line("");

  // ── 3. Build indexes ─────────────────────────────────────────────────
  line("3. BUILDING INDEXES");
  for (const [name, Model] of [
    ["Hall", Hall],
    ["ExamSession", ExamSession],
    ["ExamRegistration", ExamRegistration],
    ["Verification", Verification],
    ["VerificationAttempt", VerificationAttempt],
  ]) {
    await Model.syncIndexes();
    const idx = await Model.collection.indexes();
    line(`   ${name}: ${idx.map((i) => i.name).join(", ")}`);
  }
  line("");

  // Prove the important one is actually unique.
  const vIdx = await Verification.collection.indexes();
  const unique = vIdx.find((i) => i.key?.student === 1 && i.key?.examSession === 1);
  line(
    unique?.unique
      ? "   ✓ Verification(student, examSession) is UNIQUE — enforced by the database"
      : "   ✖ WARNING: the uniqueness constraint is NOT present"
  );
  line("");

  // ── 4. qrVersion reporting (no writes needed) ────────────────────────
  const missingVersion = await User.countDocuments({
    role: "student",
    qrVersion: { $exists: false },
  });
  line("4. QR VERSIONING");
  line(`   students without an explicit qrVersion: ${missingVersion}`);
  line("   No back-fill required: the schema defaults to 1, and verification");
  line("   treats a missing payload qrVersion as 1, so printed hall-tickets");
  line("   issued before this field existed keep working.");
  line("");

  line("═══ MIGRATION COMPLETE — no data was deleted ═══");
  line("");

  await mongoose.connection.close();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
