const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/chat.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const { chatSessionLimiter, chatMessageLimiter, chatUploadLimiter } = require("../middlewares/rateLimit");
const { chatUpload } = require("../middlewares/chatUpload");

/* ------------------------------------------------------------ Marketplace */
// Tidak ada conversationId di URL mana pun di blok ini: sesi selalu dibaca
// dari header X-Chat-Token yang ditandatangani server (lihat chat.controller
// -> requireChatSession). Itu yang membuat satu pengunjung tidak bisa membuka
// percakapan pengunjung lain hanya dengan menebak ID.
router.post("/session", chatSessionLimiter, ctrl.startSession);
router.get("/session", ctrl.getSession);
router.post("/messages", chatMessageLimiter, ctrl.sendMessage);
router.post("/messages/photo", chatUploadLimiter, chatUpload.single("photo"), ctrl.uploadPhoto);
router.post("/read", chatMessageLimiter, ctrl.markRead);

/* -------------------------------------------------------------- Admin Web */
router.use("/admin", requireAdminAuth);
router.get("/admin/conversations", ctrl.listConversations);
router.get("/admin/unread", ctrl.getUnreadSummary);
router.get("/admin/conversations/:id/messages", ctrl.getConversationMessages);
router.post("/admin/conversations/:id/messages", ctrl.replyMessage);
router.post("/admin/conversations/:id/messages/photo", chatUpload.single("photo"), ctrl.replyPhoto);
router.post("/admin/conversations/:id/read", ctrl.markConversationRead);

module.exports = router;
