const asyncHandler = require("../utils/asyncHandler");
const redeemCodeService = require("../services/redeemCode.service");

// ADMIN — POST /api/products/admin/:id/redeem-codes  (restock)
const restock = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { codes } = req.body;
  const result = await redeemCodeService.restock(id, codes);
  res.status(201).json({
    status: true,
    message:
      result.inserted +
      " kode berhasil ditambahkan." +
      (result.skipped ? " " + result.skipped + " kode dilewati karena kosong/duplikat." : ""),
    data: result,
  });
});

// ADMIN — GET /api/products/admin/:id/redeem-codes/stats
const stats = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const data = await redeemCodeService.getStats(id);
  res.json({ status: true, data });
});

// ADMIN — GET /api/products/admin/redeem-codes/sold
const listSold = asyncHandler(async (req, res) => {
  const { productId, q, page = 1, limit = 25 } = req.query;
  const result = await redeemCodeService.listSold({ productId, q, page, limit });
  res.json({ status: true, data: result.rows, pagination: result.pagination });
});

module.exports = { restock, stats, listSold };
