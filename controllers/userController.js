import User from "../models/user.js";
import bcrypt from "bcryptjs";
import generateToken from "../utils/generateToken.js";
import cloudinary from "cloudinary";
import Counter from "../models/Counter.js";

/**
 * GENERATE USER ID
 */
const generateUserId = async (role) => {
  const prefix = role === "student" ? "STU" :
                 role === "invigilator" ? "INV" :
                 "EXC";

  // Atomic increment for the role
  const counter = await Counter.findOneAndUpdate(
    { role },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  return `${prefix}${String(counter.seq).padStart(3, "0")}`;
};

/**
 * CREATE USER
 */
export const createUser = async (req, res) => {
  try {
    const { fullName, role, course, feesStatus } = req.body;

    // Basic validation
    if (!fullName || !role)
      return res.status(400).json({ message: "Full name and role are required" });

    if (role === "student" && !course)
      return res.status(400).json({ message: "Course is required for students" });

    // Generate unique userId
    const userId = await generateUserId(role);

    // Default password (pre-save hook will hash it)
    const defaultPassword = "welcome123";

    // Build user data
    const newUserData = {
      fullName,
      role,
      userId,
      password: defaultPassword, // <- pass plain password
    };

    if (role === "student") {
      newUserData.course = course;
      newUserData.feesStatus = feesStatus || "Unpaid";
    }

    // Create user in DB
    const user = await User.create(newUserData);

    // Send response
    res.status(201).json({
      message: `${role} created successfully`,
      user: {
        _id: user._id,
        fullName: user.fullName,
        userId: user.userId,
        role: user.role,
        course: user.course || null,
        feesStatus: user.feesStatus || null,
      },
      defaultPassword,
    });
  } catch (error) {
    console.error("Create user error:", error);
    res.status(500).json({ message: error.message || "Server error" });
  }
};

/**
 * GET STUDENTS
 */
export const getStudents = async (req, res) => {
  try {
    const students = await User.find({ role: "student" })
      .select("-password")
      .sort({ createdAt: -1 });
    res.json(students);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET INVIGILATORS
 */
export const getInvigilators = async (req, res) => {
  try {
    const invigilators = await User.find({ role: "invigilator" })
      .select("-password")
      .sort({ createdAt: -1 });
    res.json(invigilators);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * SEARCH USERS
 */
export const searchUsers = async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return res.json([]);

    const users = await User.find({
      $or: [
        { fullName: { $regex: query, $options: "i" } },
        { userId: { $regex: query, $options: "i" } },
      ],
    })
      .select("-password")
      .sort({ createdAt: -1 })
      .limit(20);

    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET SINGLE USER BY ID
 */
export const getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * UPDATE USER
 */
export const updateUser = async (req, res) => {
  try {
    const { fullName, course, feesStatus } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.fullName = fullName ?? user.fullName;
    user.course = course ?? user.course;
    user.feesStatus = feesStatus ?? user.feesStatus;

    const updatedUser = await user.save();

    res.json({
      message: "User updated successfully",
      user: {
        _id: updatedUser._id,
        fullName: updatedUser.fullName,
        userId: updatedUser.userId,
        role: updatedUser.role,
        course: updatedUser.course,
        feesStatus: updatedUser.feesStatus,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * DELETE USER
 */
export const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    await user.deleteOne();
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * UPDATE PROFILE (photo + password)
 */
export const updateProfile = async (req, res) => {
  try {
    const { password, currentPassword, fullName, deletePhoto } = req.body;
    const user = await User.findById(req.userId).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    let newToken = null;

    // ✅ FULL NAME UPDATE (invigilators / exam-controllers editing their own display name)
    if (fullName && fullName.trim()) {
      user.fullName = fullName.trim();
    }

    // ✅ PHOTO DELETE (checked before the upload branch — a request never does both)
    if (deletePhoto === true || deletePhoto === "true") {
      if (user.photoPublicId) {
        await cloudinary.v2.uploader.destroy(user.photoPublicId);
      }
      user.photo = null;
      user.photoPublicId = null;
    }

    // ✅ PASSWORD UPDATE
    if (password && currentPassword) {
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch)
        return res.status(400).json({ message: "Incorrect current password" });

      user.password = password; // <- pass plain password, pre-save hook hashes it
      user.mustChangePassword = false;

      // generateToken signature is (id, role, userId)
      newToken = generateToken(user._id, user.role, user.userId);
    }

    // ✅ PHOTO UPDATE
    if (req.file) {
      if (user.photoPublicId) {
        await cloudinary.v2.uploader.destroy(user.photoPublicId);
      }

      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.v2.uploader.upload_stream(
          {
            folder: "profile_photos",
            transformation: [
              { width: 500, height: 500, crop: "fill" },
              { quality: "auto" },
              { fetch_format: "auto" },
            ],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(req.file.buffer);
      });

      user.photo = result.secure_url;
      user.photoPublicId = result.public_id;
    }

    await user.save({ validateBeforeSave: false });

    res.json({
      success: true,
      user: {
        _id: user._id,
        fullName: user.fullName,
        userId: user.userId,
        role: user.role,
        course: user.course,
        feesStatus: user.feesStatus,
        photo: user.photo,
      },
      token: newToken,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
};