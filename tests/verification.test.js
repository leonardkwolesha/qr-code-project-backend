import test, { before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// A dedicated test database. NEVER point these tests at qrcodeDB — they
// truncate collections between cases.
const TEST_DB = "qrcodeDB_test";
const uri = (process.env.MONGODB_URI || "mongodb://localhost:27017/qrcodeDB").replace(
  /\/[^/?]+(\?|$)/,
  `/${TEST_DB}$1`
);

process.env.QR_SECRET = process.env.QR_SECRET || "test-qr-secret";

const { default: User } = await import("../models/user.js");
const { default: Hall } = await import("../models/Hall.js");
const { default: ExamSession } = await import("../models/ExamSession.js");
const { default: ExamRegistration } = await import("../models/ExamRegistration.js");
const { default: Verification } = await import("../models/Verification.js");
const { default: VerificationAttempt } = await import("../models/VerificationAttempt.js");
const { signPayload } = await import("../utils/qrSecurity.js");
const { verifyStudentForSession, CODES } = await import(
  "../services/verificationService.js"
);

let hall;
let invigilator;
let otherInvigilator;

const HOUR = 3600 * 1000;

/** A session whose entry window is open right now. */
const makeSession = async (overrides = {}) => {
  const now = Date.now();
  return ExamSession.create({
    courseCode: overrides.courseCode ?? "CS101",
    courseTitle: overrides.courseTitle ?? "Mathematics",
    startsAt: overrides.startsAt ?? new Date(now - HOUR),
    endsAt: overrides.endsAt ?? new Date(now + 2 * HOUR),
    hall: overrides.hall ?? hall._id,
    assignedInvigilators:
      overrides.assignedInvigilators ?? [invigilator._id],
    ...overrides,
  });
};

const makeStudent = async (userId, overrides = {}) =>
  User.create({
    fullName: `Student ${userId}`,
    userId,
    role: "student",
    course: "CSE",
    password: "welcome123",
    feesStatus: overrides.feesStatus ?? "Paid",
    qrToken: overrides.qrToken ?? `token-${userId}`,
    ...overrides,
  });

/** Build the signed QR a student's device would present. */
const qrFor = (student, opts = {}) => {
  const payload = {
    userId: student.userId,
    qrToken: student.qrToken,
    iat: Date.now(),
  };
  // `omitVersion` reproduces a hall-ticket printed before qrVersion existed.
  if (!opts.omitVersion) {
    payload.qrVersion = opts.qrVersion ?? student.qrVersion ?? 1;
  }
  return signPayload(payload);
};

const scan = (student, session, opts = {}) =>
  verifyStudentForSession({
    qrPayload: opts.qrPayload ?? qrFor(student, opts),
    examSessionId: opts.examSessionId ?? session._id,
    invigilator: opts.invigilator ?? invigilator,
    now: opts.now,
  });

before(async () => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  assert.equal(
    mongoose.connection.name,
    TEST_DB,
    `refusing to run: connected to "${mongoose.connection.name}", expected "${TEST_DB}"`
  );
  // The unique index is the thing under test — it must exist.
  await Verification.syncIndexes();
  await ExamRegistration.syncIndexes();
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Hall.deleteMany({}),
    ExamSession.deleteMany({}),
    ExamRegistration.deleteMany({}),
    Verification.deleteMany({}),
    VerificationAttempt.deleteMany({}),
  ]);

  hall = await Hall.create({ name: "Hall A", code: "HALL-A", capacity: 100 });
  invigilator = await User.create({
    fullName: "Inv One",
    userId: "INV900",
    role: "invigilator",
    password: "welcome123",
  });
  otherInvigilator = await User.create({
    fullName: "Inv Two",
    userId: "INV901",
    role: "invigilator",
    password: "welcome123",
  });
});

/* ═══════════════════════ THE CORE DEFECT ═══════════════════════ */

describe("session-scoped duplicate detection", () => {
  test("1. same student, same session, twice -> VERIFIED then ALREADY_VERIFIED", async () => {
    const student = await makeStudent("STU900");
    const session = await makeSession();

    const first = await scan(student, session);
    assert.equal(first.code, CODES.VERIFIED);
    assert.equal(first.success, true);

    const second = await scan(student, session);
    assert.equal(second.code, CODES.ALREADY_VERIFIED);
    assert.equal(second.success, false);
    assert.ok(second.data.verifiedAt, "duplicate should report the original time");

    assert.equal(await Verification.countDocuments({}), 1);
  });

  test("2. same student, TWO sessions on the SAME DAY -> VERIFIED both times", async () => {
    const student = await makeStudent("STU901");
    const now = Date.now();

    // 08:00-11:00 Mathematics, Hall A
    const morning = await makeSession({
      courseCode: "MTH101",
      courseTitle: "Mathematics",
      startsAt: new Date(now - 2 * HOUR),
      endsAt: new Date(now - HOUR),
    });
    // 14:00-17:00 Database Systems, same day
    const afternoon = await makeSession({
      courseCode: "DBS201",
      courseTitle: "Database Systems",
      startsAt: new Date(now - 30 * 60000),
      endsAt: new Date(now + 2 * HOUR),
    });

    // Same calendar day — this is what the date-scoped logic got wrong.
    assert.equal(
      morning.examDate.toISOString(),
      afternoon.examDate.toISOString(),
      "both sittings must fall on the same examDate for this test to mean anything"
    );

    const a = await scan(student, morning, { now: new Date(now - 90 * 60000) });
    const b = await scan(student, afternoon);

    assert.equal(a.code, CODES.VERIFIED);
    assert.equal(b.code, CODES.VERIFIED);
    assert.equal(await Verification.countDocuments({}), 2);
  });

  test("3. RACE: two simultaneous scans -> one VERIFIED, one ALREADY_VERIFIED, one row", async () => {
    const student = await makeStudent("STU902");
    const session = await makeSession();

    const [r1, r2] = await Promise.all([
      scan(student, session),
      scan(student, session),
    ]);

    const codes = [r1.code, r2.code].sort();
    assert.deepEqual(
      codes,
      [CODES.ALREADY_VERIFIED, CODES.VERIFIED].sort(),
      `expected exactly one VERIFIED and one ALREADY_VERIFIED, got ${codes}`
    );
    assert.equal(
      await Verification.countDocuments({ student: student._id }),
      1,
      "the unique index must permit exactly one admission row"
    );
  });

  test("3b. RACE x8 -> still exactly one VERIFIED and one row", async () => {
    const student = await makeStudent("STU903");
    const session = await makeSession();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => scan(student, session))
    );

    const verified = results.filter((r) => r.code === CODES.VERIFIED);
    const dupes = results.filter((r) => r.code === CODES.ALREADY_VERIFIED);

    assert.equal(verified.length, 1, "exactly one scan may win");
    assert.equal(dupes.length, 7, "every other scan is a duplicate");
    assert.equal(await Verification.countDocuments({ student: student._id }), 1);
  });
});

/* ═══════════════════ ELIGIBILITY vs VERIFICATION ═══════════════════ */

describe("eligibility is a different question from duplication", () => {
  test("4. unpaid student -> NOT_ELIGIBLE (never confused with ALREADY_VERIFIED)", async () => {
    const student = await makeStudent("STU904", { feesStatus: "Unpaid" });
    const session = await makeSession();

    const r = await scan(student, session);
    assert.equal(r.code, CODES.NOT_ELIGIBLE);
    assert.notEqual(r.code, CODES.ALREADY_VERIFIED);
    assert.equal(await Verification.countDocuments({}), 0, "no admission row");
  });

  test("4b. Partial fees are admitted (legacy semantics preserved)", async () => {
    const student = await makeStudent("STU905", { feesStatus: "Partial" });
    const r = await scan(student, await makeSession());
    assert.equal(r.code, CODES.VERIFIED);
  });

  test("4c. requiresRegistration + no register row -> NOT_REGISTERED", async () => {
    const student = await makeStudent("STU906");
    const session = await makeSession({ requiresRegistration: true });

    const r = await scan(student, session);
    assert.equal(r.code, CODES.NOT_REGISTERED);
  });

  test("4d. requiresRegistration + registered -> VERIFIED", async () => {
    const student = await makeStudent("STU907");
    const session = await makeSession({ requiresRegistration: true });
    await ExamRegistration.create({
      student: student._id,
      studentUserId: student.userId,
      examSession: session._id,
    });

    const r = await scan(student, session);
    assert.equal(r.code, CODES.VERIFIED);
  });

  test("4e. deactivated student -> NOT_ELIGIBLE", async () => {
    const student = await makeStudent("STU908", { isActive: false });
    const r = await scan(student, await makeSession());
    assert.equal(r.code, CODES.NOT_ELIGIBLE);
  });
});

/* ═══════════════════════ QR INTEGRITY ═══════════════════════ */

describe("QR signature and versioning", () => {
  test("5. tampered HMAC -> INVALID_QR", async () => {
    const student = await makeStudent("STU909");
    const session = await makeSession();

    const good = qrFor(student);
    const tampered = good.slice(0, -1) + (good.slice(-1) === "0" ? "1" : "0");
    assert.notEqual(tampered, good);

    const r = await scan(student, session, { qrPayload: tampered });
    assert.equal(r.code, CODES.INVALID_QR);
    assert.equal(await Verification.countDocuments({}), 0);
  });

  test("5b. forged payload with a replayed signature -> INVALID_QR", async () => {
    const student = await makeStudent("STU910");
    const session = await makeSession();

    const [, sig] = qrFor(student).split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ userId: "STU999", qrToken: "x", iat: 1 })
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const r = await scan(student, session, {
      qrPayload: `${forgedPayload}.${sig}`,
    });
    assert.equal(r.code, CODES.INVALID_QR);
  });

  test("6. STALE qrVersion -> QR_REVOKED", async () => {
    const student = await makeStudent("STU911", { qrVersion: 3 });
    const session = await makeSession();

    // A ticket printed while the student was still on generation 2.
    const r = await scan(student, session, { qrVersion: 2 });
    assert.equal(r.code, CODES.QR_REVOKED);
    assert.equal(await Verification.countDocuments({}), 0);
  });

  test("6b. MISSING qrVersion still verifies (pre-existing printed tickets)", async () => {
    const student = await makeStudent("STU912");
    const session = await makeSession();

    const r = await scan(student, session, { omitVersion: true });
    assert.equal(
      r.code,
      CODES.VERIFIED,
      "a QR with no qrVersion must be treated as version 1"
    );
  });

  test("6c. an `iat` far in the past does NOT expire the QR", async () => {
    const student = await makeStudent("STU913");
    const session = await makeSession();

    // Issued a year ago — printed, folded, carried in a pocket.
    const oldTicket = signPayload({
      userId: student.userId,
      qrToken: student.qrToken,
      qrVersion: 1,
      iat: Date.now() - 365 * 24 * HOUR,
    });

    const r = await scan(student, session, { qrPayload: oldTicket });
    assert.equal(r.code, CODES.VERIFIED, "iat is metadata only — there is no TTL");
  });

  test("6d. rotated qrToken -> QR_REVOKED", async () => {
    const student = await makeStudent("STU914");
    const session = await makeSession();
    const oldTicket = qrFor(student);

    student.qrToken = "rotated-token";
    await student.save({ validateBeforeSave: false });

    const r = await scan(student, session, { qrPayload: oldTicket });
    assert.equal(r.code, CODES.QR_REVOKED);
  });

  test("unknown student in a validly signed QR -> STUDENT_NOT_FOUND", async () => {
    const session = await makeSession();
    const ghost = signPayload({ userId: "STU404", qrToken: "t", qrVersion: 1 });
    const r = await verifyStudentForSession({
      qrPayload: ghost,
      examSessionId: session._id,
      invigilator,
    });
    assert.equal(r.code, CODES.STUDENT_NOT_FOUND);
  });
});

/* ═══════════════════ AUTHORIZATION & SESSION STATE ═══════════════════ */

describe("authorization and session state", () => {
  test("7. invigilator not assigned to the session -> UNAUTHORIZED_INVIGILATOR", async () => {
    const student = await makeStudent("STU915");
    const session = await makeSession(); // assigned to `invigilator` only

    const r = await scan(student, session, { invigilator: otherInvigilator });
    assert.equal(r.code, CODES.UNAUTHORIZED_INVIGILATOR);
    assert.equal(await Verification.countDocuments({}), 0);
  });

  test("8. CANCELLED session -> SESSION_NOT_ACTIVE", async () => {
    const student = await makeStudent("STU916");
    const session = await makeSession({ status: "CANCELLED" });

    const r = await scan(student, session);
    assert.equal(r.code, CODES.SESSION_NOT_ACTIVE);
  });

  test("8b. session already ended -> SESSION_NOT_ACTIVE", async () => {
    const student = await makeStudent("STU917");
    const now = Date.now();
    const session = await makeSession({
      startsAt: new Date(now - 5 * HOUR),
      endsAt: new Date(now - 4 * HOUR),
    });

    const r = await scan(student, session);
    assert.equal(r.code, CODES.SESSION_NOT_ACTIVE);
  });

  test("8c. before the entry window opens -> SESSION_NOT_ACTIVE", async () => {
    const student = await makeStudent("STU918");
    const now = Date.now();
    const session = await makeSession({
      startsAt: new Date(now + 5 * HOUR),
      endsAt: new Date(now + 8 * HOUR),
      entryOpensBeforeMinutes: 60,
    });

    const r = await scan(student, session);
    assert.equal(r.code, CODES.SESSION_NOT_ACTIVE);
  });
});

/* ═══════════════════════ AUDIT TRAIL ═══════════════════════ */

describe("audit trail", () => {
  test("every outcome is logged, and duplicates do not collide", async () => {
    const student = await makeStudent("STU919");
    const session = await makeSession();

    await scan(student, session); // VERIFIED
    await scan(student, session); // ALREADY_VERIFIED

    const unpaid = await makeStudent("STU920", { feesStatus: "Unpaid" });
    await scan(unpaid, session); // NOT_ELIGIBLE

    const attempts = await VerificationAttempt.find({ examSession: session._id });
    assert.equal(attempts.length, 3, "all three attempts are logged");

    const codes = attempts.map((a) => a.code).sort();
    assert.deepEqual(
      codes,
      [CODES.ALREADY_VERIFIED, CODES.NOT_ELIGIBLE, CODES.VERIFIED].sort()
    );

    // The integrity boundary holds only the successful admission.
    assert.equal(await Verification.countDocuments({ examSession: session._id }), 1);
  });

  test("no raw Mongo error text ever reaches the caller", async () => {
    const student = await makeStudent("STU921");
    const session = await makeSession();

    await scan(student, session);
    const dup = await scan(student, session);

    assert.equal(dup.code, CODES.ALREADY_VERIFIED);
    assert.ok(
      !/E11000|duplicate key|index:/i.test(dup.message),
      `message leaked a database error: ${dup.message}`
    );
  });
});

/* ═══════════════════ DATABASE-LEVEL GUARANTEE ═══════════════════ */

describe("the database enforces uniqueness, not just application code", () => {
  test("a direct duplicate insert is rejected by the index", async () => {
    const student = await makeStudent("STU922");
    const session = await makeSession();

    const row = {
      student: student._id,
      studentUserId: student.userId,
      examSession: session._id,
      invigilator: invigilator._id,
    };

    await Verification.create(row);
    await assert.rejects(
      () => Verification.create(row),
      (err) => err.code === 11000,
      "the unique index must reject a second admission row"
    );
  });

  test("the same student in a DIFFERENT session inserts fine", async () => {
    const student = await makeStudent("STU923");
    const s1 = await makeSession({ courseCode: "AAA" });
    const s2 = await makeSession({ courseCode: "BBB" });

    await Verification.create({
      student: student._id,
      studentUserId: student.userId,
      examSession: s1._id,
      invigilator: invigilator._id,
    });
    await Verification.create({
      student: student._id,
      studentUserId: student.userId,
      examSession: s2._id,
      invigilator: invigilator._id,
    });

    assert.equal(await Verification.countDocuments({ student: student._id }), 2);
  });
});
