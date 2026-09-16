const IntegrationSettings = require("../models/IntegrationSettings");
const NotificationLog = require("../models/NotificationLog");
const WebsiteSettings = require("../models/WebsiteSettings");
const fonnte = require("./fonnte.service");
const resend = require("./resend.service");
const { renderTemplate, formatIDR } = require("./template.service");
const logger = require("../utils/logger");

const WHATSAPP_TEMPLATE_KEY = {
  orderCreated: "orderCreated",
  paymentSuccess: "paymentSuccess",
  paymentFailed: "paymentFailed",
  paymentExpired: "paymentExpired",
};

async function alreadySent(orderId, channel, event) {
  const existing = await NotificationLog.findOne({ orderId, channel, event, status: "sent" });
  return Boolean(existing);
}

async function markSent(orderId, channel, event, providerResponse) {
  try {
    await NotificationLog.create({ orderId, channel, event, status: "sent", providerResponse });
  } catch (err) {
    // Unique index race — another process already marked it sent; safe to ignore.
    logger.warn("NotificationLog duplicate write ignored", { orderId: String(orderId), channel, event });
  }
}

// order: full Order mongoose document (already saved with final status)
async function notifyOrderEvent(order, eventKey) {
  const [integrationSettings, websiteSettings] = await Promise.all([
    IntegrationSettings.getSingleton(),
    WebsiteSettings.getSingleton(),
  ]);

  const eventEnabled = integrationSettings.notifications.events[eventKey];
  if (!eventEnabled) return;

  const placeholderData = {
    customer_name: order.customer.name || "Pelanggan",
    order_code: order.orderCode,
    product_name: order.product.name,
    quantity: order.quantity,
    total: formatIDR(order.total),
    payment_status: order.paymentStatus,
    store_name: websiteSettings.general.storeName,
  };

  // WhatsApp
  if (
    integrationSettings.notifications.whatsappEnabled &&
    WHATSAPP_TEMPLATE_KEY[eventKey] &&
    !(await alreadySent(order._id, "whatsapp", eventKey))
  ) {
    const template = integrationSettings.templates.whatsapp[WHATSAPP_TEMPLATE_KEY[eventKey]];
    const message = renderTemplate(template, placeholderData);
    const result = await fonnte.sendWhatsApp(order.customer.whatsapp, message);
    if (result.success) await markSent(order._id, "whatsapp", eventKey, result.response);
  }

  // Email
  const emailTemplate = integrationSettings.templates.email[eventKey];
  if (integrationSettings.notifications.emailEnabled && emailTemplate && !(await alreadySent(order._id, "email", eventKey))) {
    const subject = renderTemplate(emailTemplate.subject, placeholderData);
    const html = renderTemplate(emailTemplate.html, placeholderData);
    const result = await resend.sendEmail({ to: order.customer.email, subject, html });
    if (result.success) await markSent(order._id, "email", eventKey, result.response);
  }
}

module.exports = { notifyOrderEvent };
