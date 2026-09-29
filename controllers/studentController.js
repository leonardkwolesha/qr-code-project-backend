import User from "../models/user.js";
import Attendance from "../models/Attendance.js";
import {
  signPayload,
  verifyPayload,
  generateQrToken,
} from "../utils/qrSecurity.js";

/**
 * =====================================================================
 * STUDENT QR HALL-TICKET CONTROLLER
 * =====================================================================
 */

// Public display fields shared by both endpoints.
const publicStudent = (user) => ({
  id: user._id,
  fullName: user.fullName,
  userId: user.userId,
  course: user.course ?? null,
  feesStatus: user.feesStatus ?? null,
  photo: user.photo ?? null,
});

/**
 * GET /api/students/my-qr   (student, protected)
 * Returns a freshly signed QR payload for the logged-in student.
 * Mints a qrToken on first use.
 */
export const getMyQR = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.role !== "student") {
      return res
        .status(403)
        .json({ message: "Only students have a QR hall-ticket" });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        message:
          "Your account is deactivated, so no hall-ticket can be issued. Contact the exam office.",
      });
    }

    // Mint an opaque token if this student doesn't have one yet.
    if (!user.qrToken) {
      user.qrToken = generateQrToken();
      user.qrIssuedAt = new Date();
      await user.save({ validateBeforeSave: false });
    }

    // qrVersion is additive: the envelope format (base64url(payload).hmac) is
    // unchanged, and the legacy verifier ignores fields it does not know.
    // `iat` stays pure issuance metadata — this QR has NO expiry, because
    // hall-tickets are printed and carried on paper for a whole exam period.
    const token = signPayload({
      userId: user.userId,
      qrToken: user.qrToken,
      qrVersion: user.qrVersion ?? 1,
      iat: Date.now(),
    });

    res.json({
      qr: token,
      student: publicStudent(user),
    });
  } catch (error) {
    console.error("getMyQR error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/students/verify   (invigilator / exam-controller, protected)
 * Body: { token, hall? }
 *
 * Flow: verify signature -> load student -> match qrToken (revocation)
 *   -> role check -> fees eligibility -> duplicate-scan window
 *   -> record attendance (verified or rejected, always logged).
 */
export const verifyQR = async (req, res) => {
  const { token, hall } = req.body;

  // Helper: log a rejection and respond.
  const reject = async (reason, student = null, httpStatus = 200) => {
    try {
      if (student) {
        await Attendance.create({
          student: student._id,
          studentUserId: student.userId,
          invigilator: req.userId,
          invigilatorUserId: req.user?.userId ?? null,
          status: "rejected",
          reason,
          hall: hall ?? null,
        });
      }
    } catch (e) {
      console.error("Failed to log rejection:", e.message);
    }
    return res.status(httpStatus).json({
      valid: false,
      status: "rejected",
      reason,
      student: student ? publicStudent(student) : null,
    });
  };

  try {
    if (!token) {
      return res.status(400).json({ message: "QR token is required" });
    }

    // 1. Verify signature + decode payload.
    let payload;
    try {
      payload = verifyPayload(token);
    } catch {
      return reject("Invalid or tampered QR code");
    }

    // 2. Load the student.
    const student = await User.findOne({ userId: payload.userId });
    if (!student) return reject("Student not found");

    // 3. Ensure the QR hasn't been revoked (token must still match).
    if (!student.qrToken || student.qrToken !== payload.qrToken) {
      return reject("QR code has been revoked. Ask the student to regenerate it.", student);
    }

    // 4. Role must be student.
    if (student.role !== "student") {
      return reject("This QR does not belong to a student", student);
    }

    // 4b. A deactivated record (withdrawn / suspended / barred) must not pass,
    // even while holding a validly signed QR. The schema already carries
    // isActive; nothing was enforcing it on the entry path.
    if (student.isActive === false) {
      return reject("Student account is deactivated — entry denied", student);
    }

    // 5. Eligibility — fully or partially cleared fees may enter; Unpaid is denied.
    const eligibleFees = ["Paid", "Partial"];
    if (!eligibleFees.includes(student.feesStatus)) {
      return reject("Fees not cleared — entry denied", student);
    }

    // 6. Duplicate-scan detection (same student, already verified today).
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const existing = await Attendance.findOne({
      student: student._id,
      status: "verified",
      verifiedAt: { $gte: startOfDay },
    }).sort({ verifiedAt: -1 });

    if (existing) {
      return res.json({
        valid: true,
        status: "verified",
        alreadyVerified: true,
        reason: "Student already verified today",
        student: publicStudent(student),
        verifiedAt: existing.verifiedAt,
      });
    }

    // 7. Record a fresh verified attendance.
    const record = await Attendance.create({
      student: student._id,
      studentUserId: student.userId,
      invigilator: req.userId,
      invigilatorUserId: req.user?.userId ?? null,
      status: "verified",
      hall: hall ?? null,
    });

    res.json({
      valid: true,
      status: "verified",
      alreadyVerified: false,
      student: publicStudent(student),
      verifiedAt: record.verifiedAt,
    });
  } catch (error) {
    console.error("verifyQR error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * GET /api/students/attendance   (invigilator / exam-controller, protected)
 * Recent scans + today's counts for dashboards.
 */
export const getAttendance = async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [records, verifiedToday, totalStudents] = await Promise.all([
      Attendance.find({})
        .sort({ verifiedAt: -1 })
        .limit(50)
        .populate("student", "fullName userId course photo")
        .lean(),
      Attendance.countDocuments({
        status: "verified",
        verifiedAt: { $gte: startOfDay },
      }),
      User.countDocuments({ role: "student" }),
    ]);

    res.json({
      records,
      stats: {
        verifiedToday,
        totalStudents,
        pending: Math.max(totalStudents - verifiedToday, 0),
      },
    });
  } catch (error) {
    console.error("getAttendance error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/students/:id/revoke-qr   (exam-controller, protected)
 *
 * Rotates a student's opaque qrToken. Every QR previously issued for that
 * student — including screenshots and printed hall-tickets — stops verifying
 * immediately, because verifyQR compares the scanned payload's qrToken against
 * the stored one (step 3). The student's next visit to their QR screen fetches
 * a freshly signed code automatically, so this revokes without locking anyone
 * out permanently.
 *
 * This completes the revocation mechanism the model and verifyQR were already
 * written against: until now nothing ever changed qrToken after it was first
 * minted, so the "QR code has been revoked" branch could never be reached and
 * a leaked hall-ticket image stayed valid forever.
 */
export const revokeStudentQR = async (req, res) => {
  try {
    const student = await User.findById(req.params.id);
    if (!student) return res.status(404).json({ message: "Student not found" });

    if (student.role !== "student") {
      return res
        .status(400)
        .json({ message: "Only student accounts carry a QR hall-ticket" });
    }

    student.qrToken = generateQrToken();
    student.qrIssuedAt = new Date();
    await student.save({ validateBeforeSave: false });

    res.json({
      message: `QR hall-ticket revoked and reissued for ${student.fullName}. Any previously printed or saved code no longer works.`,
      student: publicStudent(student),
      qrIssuedAt: student.qrIssuedAt,
    });
  } catch (error) {
    console.error("revokeStudentQR error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};
