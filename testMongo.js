import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const testConnection = async () => {
  try {
    console.log(" Testing MongoDB Connection...");
    console.log(" Connection String:", process.env.MONGO_URI?.replace(/:([^:@]{3})[^:@]*@/, ':$1****@'));

    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(" Connection successful!");
    console.log(" Database:", conn.connection.name);
    
    // Test query
    console.log("\n Testing database query...");
    const collections = await conn.connection.db.listCollections().toArray();
    console.log(" Query successful!");
    console.log(" Collections:", collections.map(c => c.name).join(', '));

    // Test find operation
    console.log("\n Testing find operation...");
    const ExamController = mongoose.model('ExamController', new mongoose.Schema({
      fullName: String,
      regNumber: String,
      password: String,
      role: String,
    }));
    
    const count = await ExamController.countDocuments();
    console.log(` Find successful! Found ${count} exam controllers`);

    await mongoose.connection.close();
    console.log("\n All tests passed!");
    process.exit(0);

  } catch (error) {
    console.error("\n Test failed:", error.message);
    console.error("\n Error details:");
    console.error(error);
    process.exit(1);
  }
};

testConnection();