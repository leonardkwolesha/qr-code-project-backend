import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    // =============================
    // BASIC INFO
    // =============================
    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    // UNIQUE LOGIN ID (STU001, INV001, EXC001)
    userId: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
    },

    phone: {
      type: String,
      trim: true,
    },

    // =============================
    // ROLE
    // =============================
    role: {
      type: String,
      required: true,
      enum: ["student", "invigilator", "exam-controller"],
      lowercase: true,
      trim: true,
    },

    // =============================
    // PASSWORD
    // =============================
    password: {
      type: String,
      required: true,
      select: false,
      minlength: 6,
    },

    mustChangePassword: {
      type: Boolean,
      default: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // =============================
    // STUDENT-SPECIFIC
    // =============================
    course: {
      type: String,
      default: null,
      trim: true,
      validate: {
        validator: function (value) {
          if (this.role === "student") return !!value;
          return true;
        },
        message: "Course is required for students",
      },
    },

    feesStatus: {
      type: String,
      enum: ["Paid", "Unpaid", "Partial"],
      default: null,
    },

    // =============================
    // 🎫 QR HALL-TICKET (STUDENT)
    // =============================
    // Opaque token embedded in the signed QR payload. Regenerating it
    // revokes any previously issued/printed QR code.
    qrToken: {
      type: String,
      default: null,
      index: true,
    },

    qrIssuedAt: {
      type: Date,
      default: null,
    },

    // Generation counter for hall-ticket revocation. Bumping it invalidates
    // every QR issued before the bump.
    //
    // Optional with a default, so every existing user document stays valid
    // with no migration. A QR payload that carries NO qrVersion is treated as
    // version 1 at verification time — printed tickets already in students'
    // pockets predate this field and must keep working.
    qrVersion: {
      type: Number,
      default: 1,
      min: 1,
    },

    // =============================
    // PROFILE PHOTO
    // =============================
    photo: {
      type: String,
      default: null,
      trim: true,
    },

    photoPublicId: {
      type: String,
    },

    // =============================
    // 🔐 TOKEN RESET SYSTEM
    // =============================
    resetPasswordToken: String,
    resetPasswordExpires: Date,

    // =============================
    // 🔢 OTP RESET SYSTEM
    // =============================
    resetOTP: String,
    resetOTPExpires: Date,
  },
  { timestamps: true }
);

// =======================================
// 🔐 AUTO HASH PASSWORD BEFORE SAVE
// =======================================
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);

  next();
});

// =======================================
// 🔑 PASSWORD COMPARISON METHOD
// =======================================
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// =======================================
// REMOVE SENSITIVE FIELDS FROM RESPONSES
// =======================================
userSchema.methods.toJSON = function () {
  const user = this.toObject();

  delete user.password;
  delete user.resetPasswordToken;
  delete user.resetPasswordExpires;
  delete user.resetOTP;
  delete user.resetOTPExpires;

  return user;
};

// =======================================
// ✅ PREVENT OverwriteModelError
// =======================================
const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;