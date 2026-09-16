const { Server } = require("socket.io");
const logger = require("../utils/logger");

let io = null;

function initSocket(httpServer, allowedOrigins) {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    logger.info("Socket connected", { socketId: socket.id });

    socket.on("disconnect", (reason) => {
      logger.info("Socket disconnected", { socketId: socket.id, reason });
    });
  });

  return io;
}

// Emit only AFTER the DB write that backs this event has already succeeded.
// If the DB write failed, callers must NOT call this (spec section 17/18).
function emitEvent(eventName, payload) {
  if (!io) {
    logger.warn("Socket.IO not initialized, skipping emit", { eventName });
    return;
  }
  io.emit(eventName, payload);
}

function getIO() {
  return io;
}

module.exports = { initSocket, emitEvent, getIO };
