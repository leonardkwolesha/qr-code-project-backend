import mongoose from "mongoose";

const connectDB = async () => {
  try {
    // Check if MONGO_URI exists
    if (!process.env.MONGODB_URI) {
      throw new Error("❌ MONGO_URI is not defined in .env file");
    }

    console.log("🔄 Attempting to connect to MongoDB...");

    // Connect to MongoDB with timeout settings
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s
      socketTimeoutMS: 45000,
    });

    console.log(` MongoDB Connected: ${conn.connection.host}`);
    console.log(` Database: ${conn.connection.name}`);
    
  } catch (error) {
    console.error(` MongoDB Connection Error: ${error.message}`);

    // Handle specific error types
    if (error.message.includes("Authentication failed") || error.message.includes("auth")) {
      console.error(" Authentication Error Solutions:");
      console.error("   1. Verify username in connection string");
      console.error("   2. Verify password in connection string");
      console.error("   3. Check Database User exists in Atlas");
      console.error("   4. URL-encode special characters in password");
    } 
    else if (error.message.includes("ECONNREFUSED") || error.message.includes("querySrv")) {
      // Atlas advice ("whitelist your IP", "cluster paused") is misleading when
      // the URI points at a local mongod, so the hints follow the URI in use.
      const uri = process.env.MONGODB_URI || "";
      const isLocal = /@?(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(uri);

      if (isLocal) {
        console.error("  Local MongoDB is not reachable:");
        console.error("   1. Is mongod running?  Get-Service MongoDB");
        console.error("   2. Start it (as Administrator):  Start-Service MongoDB");
        console.error("   3. Check the log tail for why it stopped:");
        console.error('      Get-Content "C:/Program Files/MongoDB/Server/8.0/log/mongod.log" -Tail 20');
        console.error("   4. Check free disk space — mongod exits if it cannot write");
        console.error(`   5. Confirm the port in ${uri.replace(/\/\/.*@/, "//***@")}`);
      } else {
        console.error("  Connection Error Solutions:");
        console.error("   1. Check your internet connection");
        console.error("   2. Verify connection string in .env");
        console.error("   3. Whitelist IP address in Atlas Network Access");
        console.error("   4. Check if cluster is paused/deleted in Atlas");
        console.error("   5. Wait 2-3 minutes after whitelisting IP");
      }
    }
    else {
      console.error(" General Solutions:");
      console.error("   1. Check .env file exists in root directory");
      console.error("   2. Restart the server after changing .env");
      console.error("   3. Verify MONGO_URI format is correct");
    }

    process.exit(1);
  }
};

export default connectDB;