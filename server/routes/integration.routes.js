const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/integration.controller");
const { requireAdminAuth, requireRole } = require("../middlewares/auth");

router.use(requireAdminAuth);

router.get("/status", ctrl.getStatus);

router.put("/klikqris", requireRole("superadmin", "admin"), ctrl.updateKlikQris);
router.post("/klikqris/test", ctrl.testKlikQris);

router.put("/fonnte", requireRole("superadmin", "admin"), ctrl.updateFonnte);
router.post("/fonnte/test", ctrl.testFonnte);

router.put("/resend", requireRole("superadmin", "admin"), ctrl.updateResend);
router.post("/resend/test", ctrl.testResend);
router.get("/resend/domain-status", ctrl.getResendDomainStatus);

router.post("/r2/test", ctrl.testR2);

router.put("/notifications", ctrl.updateNotifications);
router.get("/notifications/logs", ctrl.listNotificationLogs);
router.get("/notifications/preview", ctrl.previewNotificationTemplates);
router.post("/notifications/logs/:id/retry", requireRole("superadmin", "admin"), ctrl.retryNotification);
router.get("/templates", ctrl.getTemplates);
router.put("/templates", ctrl.updateTemplates);

module.exports = router;
