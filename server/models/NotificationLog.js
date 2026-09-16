const mongoose = require("mongoose");

// Idempotency ledger for notifications so retried webhooks never double-send
// WhatsApp/Email (see spec sections 23 & 24).
const NotificationLogSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    channel: { type: String, enum: ["whatsapp", "email"], required: true },
    event: {
      type: String,
      enum: ["orderCreated", "paymentPending", "paymentSuccess", "paymentFailed", "paymentExpired", "orderCompleted"],
      required: true,
    },
    status: { type: String, enum: ["sent", "failed"], required: true },
    providerResponse: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

NotificationLogSchema.index({ orderId: 1, channel: 1, event: 1 }, { unique: true, partialFilterExpression: { status: "sent" } });

module.exports = mongoose.model("NotificationLog", NotificationLogSchema);
