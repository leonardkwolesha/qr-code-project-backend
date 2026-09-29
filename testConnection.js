import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

dotenv.config();

// Simple User Schema (inline for testing)
const userSchema = new mongoose.Schema({
  fullName: String,
  id: String,
  password: String,
  role: String,
  regNumber: String,
  feesStatus: String,
});

const User = mongoose.model("User", userSchema);

const testConnectionAndSeed = async () => {
  try {
    console.log("🔄 Testing MongoDB Connection...");
    console.log("📍 Using connection string:", process.env.MONGODB_URI?.substring(0, 50) + "...");

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    
    console.log("✅ MongoDB Connected Successfully!");
    console.log("📦 Database:", mongoose.connection.name);
    console.log("🌍 Host:", mongoose.connection.host);

    // Seed users
    console.log("\n🌱 Seeding users...");
    
    const hashedPassword = await bcrypt.hash("123456", 10);

    const users = [
      {
        fullName: "Leonard Sengoma",
        id: "STU1001",
        password: hashedPassword,
        role: "student",
        regNumber: "STU1001",
        feesStatus: "Paid",
      },
      {
        fullName: "John Michael",
        id: "INV1001",
        password: hashedPassword,
        role: "invigilator",
      },
      {
        fullName: "Dr Sarah",
        id: "EXC1001",
        password: hashedPassword,
        role: "exam-controller",
      },
    ];

    // Clear existing users
    await User.deleteMany({});
    console.log("🗑️  Cleared existing users");

    // Insert new users
    await User.insertMany(users);
    console.log("✅ Users seeded successfully!");
    
    // List all users
    const allUsers = await User.find({});
    console.log("\n👥 Total users in database:", allUsers.length);
    allUsers.forEach((user) => {
      console.log(`   - ${user.fullName} (${user.role}) - ID: ${user.id}`);
    });

    console.log("\n🎉 Test completed successfully!");
    
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error("\n📋 Full error:", error);
  } finally {
    await mongoose.connection.close();
    console.log("\n🔌 Connection closed");
    process.exit(0);
  }
};

testConnectionAndSeed();