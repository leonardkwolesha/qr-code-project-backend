import mongoose from "mongoose";

/**
 * =====================================================================
 * 🏛 EXAM HALL
 * ---------------------------------------------------------------------
 * Halls are database entities, never hardcoded strings. The legacy
 * Attendance model stored `hall` as free text ("Hall A"); that stays as
 * it is, but every new session-scoped verification references a real
 * Hall document so capacity and location are knowable server-side.
 * =====================================================================
 */
const hallSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // Short unique identifier, e.g. "HALL-A".
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    capacity: { type: Number, default: 0, min: 0 },
    location: { type: String, default: null, trim: true },

    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
      index: true,
    },
  },
  { timestamps: true }
);

const Hall = mongoose.models.Hall || mongoose.model("Hall", hallSchema);
export default Hall;
