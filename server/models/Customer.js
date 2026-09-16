const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    whatsapp: { type: String, required: true, index: true }, // normalized 62xxxx
    totalOrders: { type: Number, default: 0 },
    totalSuccessfulOrders: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", CustomerSchema);
