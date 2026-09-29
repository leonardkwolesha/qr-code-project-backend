import mongoose from "mongoose";
import Hall from "../models/Hall.js";

/**
 * =====================================================================
 * HALL CONTROLLER  (BASE: /api/halls)
 * Halls are database entities so a session can reference a real place —
 * never a hardcoded "Hall A" string.
 * =====================================================================
 */

/** GET /api/halls — any signed-in user (the session picker needs names). */
export const listHalls = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();

    const halls = await Hall.find(filter).sort({ code: 1 });
    return res.json({ success: true, count: halls.length, halls });
  } catch (error) {
    console.error("listHalls error:", error);
    return res.status(500).json({ message: "Failed to load halls." });
  }
};

/** POST /api/halls — exam-controller. */
export const createHall = async (req, res) => {
  try {
    const { name, code, capacity, location, status } = req.body ?? {};
    if (!name || !code) {
      return res.status(400).json({ message: "Hall name and code are required." });
    }

    const hall = await Hall.create({
      name,
      code,
      capacity: Number(capacity) || 0,
      location: location ?? null,
      ...(status ? { status: String(status).toUpperCase() } : {}),
    });

    return res.status(201).json({ success: true, message: "Hall created.", hall });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "A hall with that code already exists." });
    }
    console.error("createHall error:", error);
    return res.status(400).json({ message: error.message || "Failed to create the hall." });
  }
};

/** PATCH /api/halls/:id — exam-controller. */
export const updateHall = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid hall id." });
    }

    const hall = await Hall.findById(id);
    if (!hall) return res.status(404).json({ message: "Hall not found." });

    const { name, code, capacity, location, status } = req.body ?? {};
    if (name !== undefined) hall.name = name;
    if (code !== undefined) hall.code = code;
    if (capacity !== undefined) hall.capacity = Number(capacity) || 0;
    if (location !== undefined) hall.location = location || null;
    if (status !== undefined) hall.status = String(status).toUpperCase();

    await hall.save();
    return res.json({ success: true, message: "Hall updated.", hall });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "A hall with that code already exists." });
    }
    console.error("updateHall error:", error);
    return res.status(400).json({ message: error.message || "Failed to update the hall." });
  }
};
