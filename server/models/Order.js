const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
  {
    orderCode: { type: String, required: true, unique: true, index: true },
    customer: {
      name: { type: String, default: "" },
      email: { type: String, required: true },
      whatsapp: { type: String, required: true },
    },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    product: {
      productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
      name: { type: String, required: true },
      price: { type: Number, required: true }, // snapshot at order time, from DB
      image: { type: String, default: "" },
      category: { type: String, default: "" }, // snapshot of Category.name at order time
      slug: { type: String, default: "" }, // snapshot of Product.slug, so old orders can still link back to the product page
    },
    quantity: { type: Number, required: true, min: 1 },
    total: { type: Number, required: true }, // price * quantity, computed server-side
    status: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED", "EXPIRED", "CANCELLED", "COMPLETED"],
      default: "PENDING",
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED", "EXPIRED", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    notificationsSent: {
      orderCreated: { type: Boolean, default: false },
      paymentSuccess: { type: Boolean, default: false },
      paymentFailed: { type: Boolean, default: false },
      paymentExpired: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

OrderSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Order", OrderSchema);
