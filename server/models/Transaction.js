const mongoose = require("mongoose");

const TransactionSchema = new mongoose.Schema(
  {
    transactionId: { type: String, required: true, unique: true, index: true }, // internal id, == orderCode for KlikQRIS order_id
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    paymentGateway: { type: String, default: "KLIKQRIS" },
    externalPaymentId: { type: String, index: true }, // KlikQRIS order_id (same as transactionId here)
    amount: { type: Number, required: true }, // requested amount
    totalAmount: { type: Number }, // amount + unique code, from KlikQRIS response — shown to buyer
    qrisUrl: { type: String, default: "" },
    directUrl: { type: String, default: "" },
    signature: { type: String, default: "" }, // used to validate webhook authenticity
    status: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED", "EXPIRED", "CANCELLED"],
      default: "PENDING",
      index: true,
    },
    expiredAt: { type: Date },
    paidAt: { type: Date },
    rawCreateResponse: { type: mongoose.Schema.Types.Mixed },
    rawWebhookPayloads: [{ type: mongoose.Schema.Types.Mixed }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Transaction", TransactionSchema);
