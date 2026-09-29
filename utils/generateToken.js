import jwt from "jsonwebtoken";

const generateToken = (id, role, userId) => {
  return jwt.sign(
    { id, role, userId },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );
};

export default generateToken;